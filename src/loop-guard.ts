// Trava de looping ("doom loop"). O opencode pausa quando as 3 últimas chamadas são
// idênticas, e o próprio projeto documenta onde isso falha: A, B, A, B alternados, e a
// mesma chamada repetida em turnos diferentes. Aqui o critério é o RESULTADO: uma chamada
// que já voltou igual duas vezes, sem nada com efeito colateral entre elas, voltaria igual
// na terceira. Comparar o resultado evita o falso positivo que a regra por argumentos teria
// — esperar o servidor subir repete o mesmo capture_page, mas a resposta muda quando ele
// sobe. Visto num chat real: `cat package.json` e `ls -la` falhando no cmd.exe, a mesma
// dupla repetida depois de read_file, sem o modelo mudar de abordagem.

type Registro = { chave: string; assinatura: string; efeito: boolean; emAndamento: boolean } | null;

// Acompanhar uma operação remota repete a MESMA consulta e recebe o MESMO "running" até ela
// terminar: o tempo muda a resposta, não os argumentos. Visto com o render do Higgsfield (3D
// Jutsu): três get_operation com waitSeconds:30 voltaram "running", a trava bloqueou a quarta,
// e o modelo passou a dormir com `python -c "time.sleep(75)"` no terminal para esperar. Esse
// resultado ganha um teto maior em vez de nenhum: operação que nunca sai de "running" ainda
// é looping.
export const LIMITE_EM_ANDAMENTO = 12;
const ESTADOS_EM_ANDAMENTO = /^(running|pending|queued|starting|in[_ -]?progress|processing|checkpointing|waiting|submitted|scheduled|active)$/i;

export function resultadoEmAndamento(resultado: string) {
  const texto = String(resultado ?? '');
  const procura = (v: any, nivel: number): boolean => {
    if (!v || typeof v !== 'object' || nivel > 3) return false;
    for (const [k, x] of Object.entries(v)) {
      if (/^(status|state)$/i.test(k) && typeof x === 'string' && ESTADOS_EM_ANDAMENTO.test(x.trim())) return true;
      if (x && typeof x === 'object' && procura(x, nivel + 1)) return true;
    }
    return false;
  };
  try { return procura(JSON.parse(texto), 0); } catch { /* texto */ }
  // Em texto, só um status curto no fim ("Job 187d… — in_progress"): "running" no meio de um
  // log de teste não é operação em andamento.
  return texto.length <= 300 && /(^|[\s—:-])(running|pending|queued|in[_ ]progress|processing)\s*\.?\s*$/im.test(texto);
}

// Campos que mudam a cada execução sem que o resultado mude de verdade: sem tirá-los, dois
// `cat` que falham igual teriam PIDs diferentes e nunca contariam como repetição.
const VOLATEIS = new Set(['pid', 'uptimeSec', 'ms', 'result_id', 'snapshotId', 'mtimeMs', 'startedAt', 'elapsedMs']);

function ordenado(v: any, ignoraVolateis = false): any {
  if (Array.isArray(v)) return v.map(item => ordenado(item, ignoraVolateis));
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) if (!ignoraVolateis || !VOLATEIS.has(k)) out[k] = ordenado(v[k], ignoraVolateis);
    return out;
  }
  return v;
}

export function chaveDaChamada(nome: string, args: any) {
  return nome + ' ' + JSON.stringify(ordenado(args ?? {}));
}

// FNV-1a: saída de comando pode ter megabytes, e guardar o texto inteiro no histórico da
// trava só para comparar seria desperdício de memória.
function fnv(texto: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + texto.length;
}

export function assinaturaDoResultado(resultado: string) {
  let texto = String(resultado ?? '');
  try { texto = JSON.stringify(ordenado(JSON.parse(texto), true)); } catch { /* resultado em texto */ }
  return fnv(texto.replace(/result-[\w-]+/g, 'result-*'));
}

export class LoopGuard {
  private hist: Registro[] = [];
  constructor(private limite = 2, private memoria = 60) {}

  // Instrução nova do usuário muda o que o agente deve fazer: repetir depois dela é legítimo.
  novaInstrucao() { this.guarda(null); }

  // Quantas vezes seguidas esta chamada já voltou com o MESMO resultado, andando para trás
  // até a última instrução do usuário ou a última chamada ALHEIA com efeito colateral
  // (depois de um npm install, rodar o mesmo teste de novo é legítimo). Chamadas sem efeito
  // no meio (leituras, buscas) não zeram a contagem — é isso que pega o A, B, A, B.
  repeticoes(chave: string) {
    return this.contagem(chave).vezes;
  }

  private contagem(chave: string) {
    let vezes = 0, assinatura: string | null = null, emAndamento = true;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      const r = this.hist[i];
      if (r === null) break;
      if (r.chave !== chave) { if (r.efeito) break; continue; }
      if (assinatura === null) assinatura = r.assinatura;
      else if (r.assinatura !== assinatura) break;
      vezes++;
      emAndamento = emAndamento && r.emAndamento;
    }
    return { vezes, emAndamento: vezes > 0 && emAndamento };
  }

  bloqueia(chave: string) {
    const { vezes, emAndamento } = this.contagem(chave);
    return vezes >= (emAndamento ? Math.max(this.limite, LIMITE_EM_ANDAMENTO) : this.limite) ? vezes : 0;
  }

  registra(chave: string, resultado: string, efeito: boolean) {
    this.guarda({ chave, assinatura: assinaturaDoResultado(resultado), efeito, emAndamento: resultadoEmAndamento(resultado) });
  }

  private guarda(r: Registro) {
    this.hist.push(r);
    if (this.hist.length > this.memoria) this.hist.splice(0, this.hist.length - this.memoria);
  }
}

// Efeito colateral é o que pode mudar o resultado de OUTRA chamada.
export function temEfeito(nome: string, args: any) {
  if (['execute_command', 'write_file', 'edit_file', 'delete_file', 'create_directory', 'stop_process', 'computer_action'].includes(nome)) return true;
  if (nome === 'http_request') return !/^(GET|HEAD|OPTIONS)$/i.test(String(args?.method || 'GET'));
  if (nome === 'capture_page') return !!args?.script;
  return false;
}
