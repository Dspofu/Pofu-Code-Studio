// Casamento do edit_file. A ordem vai do exato ao tolerante, e a tolerância para em
// ESPAÇO EM BRANCO (indentação, espaço no fim da linha, sequências de espaço/tab),
// aspas/traços tipográficos e \n literal vindo de argumento mal serializado: diferenças
// em que o conteúdo é o mesmo. Casamento por SEMELHANÇA (o block_anchor/context_aware do
// Hermes) fica fora de propósito — ele escreve num trecho que só "parece" o pedido, e
// para isso existe o editDiagnostics, que mostra o candidato sem gravar nada.
// O que custa caro sem isto é o ciclo "trecho não encontrado → reler o arquivo inteiro →
// tentar de novo": uma leitura completa em tokens de entrada por um espaço de diferença.

type Span = { start: number; end: number };
export type EditOutcome =
  | { ok: true; content: string; count: number; firstIndex: number; strategy: string }
  | { ok: false; kind: 'empty' | 'identical' | 'not_found' | 'ambiguous' | 'ambiguous_fuzzy';
      count?: number; lines?: number[]; strategy?: string };

const UNICODE: Record<string, string> = {
  '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'",
  '\u2014': '--', '\u2013': '-', '\u2026': '...', '\u00a0': ' ', '\u2212': '-',
  '\u2002': ' ', '\u2003': ' ', '\u2009': ' ', '\u202f': ' ', '\u3000': ' '
};
const semTipografia = (s: string) => s.replace(/[\u201c\u201d\u2018\u2019\u2014\u2013\u2026\u00a0\u2212\u2002\u2003\u2009\u202f\u3000]/g, c => UNICODE[c]);

// Cada linha comparada sem o \r do CRLF: a quebra do arquivo não é assunto do casamento.
const LINE_STRATEGIES: Array<[string, (l: string) => string]> = [
  ['trimmed', l => l.trim()],
  ['whitespace', l => l.trim().replace(/[ \t]+/g, ' ')],
  ['unicode', l => semTipografia(l).trim().replace(/[ \t]+/g, ' ')]
];

function exatos(text: string, needle: string): Span[] {
  const out: Span[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length))
    out.push({ start: at, end: at + needle.length });
  return out;
}

// Casa linhas INTEIRAS: o trecho começa no início da primeira linha e termina no fim do
// conteúdo da última (antes do \r\n), ou depois da quebra quando o old_text terminava em uma.
function porLinhas(text: string, pattern: string, norm: (l: string) => string): Span[] {
  const pat = pattern.replace(/\r\n/g, '\n');
  const incluiQuebra = pat.endsWith('\n');
  const alvo = (incluiQuebra ? pat.slice(0, -1) : pat).split('\n').map(norm);
  if (!alvo.some(Boolean)) return [];
  const linhas = text.split('\n');
  const inicio: number[] = [];
  for (let i = 0, p = 0; i < linhas.length; p += linhas[i].length + 1, i++) inicio.push(p);
  const corpo = (i: number) => linhas[i].endsWith('\r') ? linhas[i].slice(0, -1) : linhas[i];
  const out: Span[] = [];
  for (let i = 0; i + alvo.length <= linhas.length; i++) {
    let igual = true;
    for (let j = 0; j < alvo.length && igual; j++) igual = norm(corpo(i + j)) === alvo[j];
    if (!igual) continue;
    const ult = i + alvo.length - 1;
    let end = inicio[ult] + corpo(ult).length;
    if (incluiQuebra && ult + 1 < linhas.length) end = inicio[ult + 1];
    out.push({ start: inicio[i], end });
    i = ult; // sem sobreposição, como no exato
  }
  return out;
}

const indentacao = (l: string) => l.slice(0, l.length - l.trimStart().length);
const primeiraUtil = (t: string) => t.split('\n').find(l => l.trim());

// Depois de um casamento que ignorou indentação, o new_text herda a indentação REAL do
// arquivo: troca o prefixo que o modelo usou pelo do arquivo e preserva o aninhamento
// relativo. Sem isso, um bloco Python/YAML entraria com o recuo errado.
export function reindent(regiao: string, oldText: string, newText: string) {
  const velho = primeiraUtil(oldText.replace(/\r/g, '')), noArquivo = primeiraUtil(regiao.replace(/\r/g, ''));
  if (!newText || velho === undefined || noArquivo === undefined) return newText;
  const de = indentacao(velho), para = indentacao(noArquivo);
  if (de === para) return newText;
  return newText.split('\n').map(l => !l.trim() ? l
    : indentacao(l).startsWith(de) ? para + l.slice(de.length) : para + l.trimStart()).join('\n');
}

function linhaDe(text: string, index: number) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// Mesmo tratamento de quebra que o main já fazia: o texto que ENTRA segue a do arquivo,
// senão um LF no meio de um CRLF quebra a edição seguinte naquela região.
const naQuebraDo = (arquivo: string, t: string) =>
  arquivo.includes('\r\n') && /(^|[^\r])\n/.test(t) ? t.replace(/\r?\n/g, '\r\n') : t;

export function applyEdit(original: string, oldText: string, newText: string, replaceAll = false): EditOutcome {
  if (typeof oldText !== 'string' || !oldText.trim()) return { ok: false, kind: 'empty' };
  newText = String(newText ?? '');
  if (oldText === newText) return { ok: false, kind: 'identical' };

  const tentativas: Array<[string, () => Span[], string?]> = [['exact', () => exatos(original, oldText)]];
  if (original.includes('\r\n') && !oldText.includes('\r'))
    tentativas.push(['crlf', () => exatos(original, oldText.replace(/\n/g, '\r\n'))]);
  // Argumento serializado duas vezes: o modelo manda "\\n" onde o arquivo tem quebra real.
  // Só vale quando old_text não tem quebra de verdade nenhuma — senão é um literal legítimo.
  if (!oldText.includes('\n') && /\\[nt]/.test(oldText)) {
    const solto = oldText.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    tentativas.push(['escaped', () => {
      const r = exatos(original, solto);
      if (!r.length && original.includes('\r\n')) return exatos(original, solto.replace(/\n/g, '\r\n'));
      return r;
    }, newText.includes('\n') ? newText : newText.replace(/\\n/g, '\n').replace(/\\t/g, '\t')]);
  }
  for (const [nome, norm] of LINE_STRATEGIES) tentativas.push([nome, () => porLinhas(original, oldText, norm)]);

  for (const [strategy, busca, trocaEspecial] of tentativas) {
    const spans = busca();
    if (!spans.length) continue;
    const exato = strategy === 'exact' || strategy === 'crlf';
    if (spans.length > 1 && !replaceAll)
      return { ok: false, kind: 'ambiguous', count: spans.length, strategy, lines: spans.slice(0, 8).map(s => linhaDe(original, s.start)) };
    // Tolerância a espaço serve para achar UM lugar; em massa, só o texto exato.
    if (spans.length > 1 && !exato)
      return { ok: false, kind: 'ambiguous_fuzzy', count: spans.length, strategy, lines: spans.slice(0, 8).map(s => linhaDe(original, s.start)) };
    const base = trocaEspecial ?? newText;
    let content = original;
    // Do fim para o começo, para os índices anteriores continuarem válidos. Montagem por
    // fatia, nunca String.replace: ele expandiria $&, $1 e $$ dentro do new_text.
    for (const s of [...spans].reverse()) {
      const regiao = original.slice(s.start, s.end);
      const troca = naQuebraDo(original, exato || strategy === 'escaped' ? base : reindent(regiao, oldText, base));
      content = content.slice(0, s.start) + troca + content.slice(s.end);
    }
    return { ok: true, content, count: spans.length, firstIndex: spans[0].start, strategy };
  }
  return { ok: false, kind: 'not_found' };
}

export type EditRequest = { old_text: string; new_text?: string; replace_all?: boolean };

// Várias trocas no MESMO arquivo, em ordem e atômicas: cada uma enxerga o resultado da
// anterior, e se qualquer uma falha nada é gravado. É uma chamada no lugar de N — e cada
// chamada a menos é um reenvio a menos do contexto inteiro ao servidor.
export function applyEdits(original: string, edits: EditRequest[]) {
  let content = original;
  const applied: Array<{ count: number; line: number; strategy: string }> = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || ({} as EditRequest);
    const r = applyEdit(content, e.old_text, e.new_text ?? '', !!e.replace_all);
    if (r.ok === false) return { ok: false as const, index: i, failure: r, content };
    applied.push({ count: r.count, line: linhaDe(r.content, r.firstIndex), strategy: r.strategy });
    content = r.content;
  }
  return { ok: true as const, content, applied };
}
