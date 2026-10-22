// Quando repetir uma requisição ao modelo, e depois de quanto tempo. A classificação (o que
// é passageiro) fica no renderer, junto das mensagens da tela; aqui mora só a contagem, para
// o agente principal e os subagentes seguirem a mesma regra.

import { MAX_REQUEST_RETRIES, RETRY_AFTER_MAX_MS, RETRY_DELAYS_MS } from './constants.js';

// Espera antes da tentativa que segue a falha número `falha` (1 = primeira). O Retry-After do
// servidor só AUMENTA a espera: um "tente em 1 s" depois de três quedas não encurta a escala.
export function esperaDaTentativa(falha: number, retryAfterMs = 0): number {
  const escala = RETRY_DELAYS_MS[Math.min(Math.max(falha, 1), RETRY_DELAYS_MS.length) - 1];
  return Math.max(escala, Math.min(retryAfterMs > 0 ? retryAfterMs : 0, RETRY_AFTER_MAX_MS));
}

// Retry-After em segundos ou como data HTTP. No navegador o cabeçalho de outra origem só é
// legível com Access-Control-Expose-Headers, que os servidores locais não mandam — por isso
// também os formatos que as APIs escrevem no corpo ("try again in 20s", "retry_after": 3).
export function retryAfterMs(cabecalho: string | null | undefined, corpo = '', agora = Date.now()): number {
  const valor = String(cabecalho ?? '').trim();
  if (valor) {
    const segundos = Number(valor);
    if (Number.isFinite(segundos)) return segundos > 0 ? Math.round(segundos * 1000) : 0;
    const quando = Date.parse(valor);
    if (!Number.isNaN(quando)) return Math.max(0, quando - agora);
  }
  const m = /retry[_ -]?after["'\s:=]*([\d.]+)\s*(ms|s\b|sec|seconds?)?/i.exec(corpo) ||
    /try again in\s*([\d.]+)\s*(ms|s\b|sec|seconds?)/i.exec(corpo);
  const n = m ? Number(m[1]) : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(m[2]?.toLowerCase() === 'ms' ? n : n * 1000);
}

export class RetryPolicy {
  private falhas = 0;
  private ultima = '';
  private iguais = 0;
  constructor(private maxTentativas = MAX_REQUEST_RETRIES) {}

  get falhasAteAgora() { return this.falhas; }

  // Registra uma falha PASSAGEIRA e devolve a espera até a próxima tentativa, ou null para
  // desistir. `maxTentativas` aperta o teto para um tipo de falha — o servidor travado já
  // custou três minutos e ganha só uma repetição.
  proxima(mensagem: string, { retryAfter = 0, maxTentativas = this.maxTentativas } = {}): number | null {
    this.falhas++;
    this.iguais = mensagem === this.ultima ? this.iguais + 1 : 1;
    this.ultima = mensagem;
    if (this.falhas >= maxTentativas) return null;
    // O mesmo 500 com o mesmo corpo três vezes é determinístico (erro de template no
    // servidor): repetir até o fim da escala só adiaria o diagnóstico. Só o 500: o 503
    // "Loading model" do llama.cpp volta idêntico durante todo o carregamento (20 a 60 s), e
    // o 502 do túnel também, enquanto o servidor reinicia — são justamente os casos que a
    // escala existe para esperar. Conexão caída tem sempre a mesma mensagem e fica fora.
    if (/^HTTP 500\b/.test(mensagem) && this.iguais >= 3) return null;
    return esperaDaTentativa(this.falhas, retryAfter);
  }
}
