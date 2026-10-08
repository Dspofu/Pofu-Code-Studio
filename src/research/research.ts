// Adaptado do saas/src/functions/research.ts; atualizar com scripts/sync-research.mjs.
// Evidências da pesquisa: parsing e seleção de trechos, sem rede nem estado.
export function browserFailed(text: string): boolean {
  return /^\[NAVEGADOR\]\s*(?:ERRO\b|O navegador não|nenhuma página)/i.test(text.trimStart());
}

export function browserEvidence(snapshot: string): { url: string; title: string; text: string } | null {
  if (browserFailed(snapshot)) return null;
  const head = snapshot.match(/^\[NAVEGADOR\] Página: ([^\n]*)\r?\nURL: (https?:\/\/[^\s]+)/);
  if (!head) return null;
  const start = snapshot.indexOf('CONTEÚDO (');
  if (start < 0) return null;
  const end = snapshot.indexOf('\nELEMENTOS INTERATIVOS', start);
  const text = snapshot.slice(start, end < 0 ? undefined : end).trim();
  return { url: head[2]!, title: head[1]!.trim(), text };
}

// Host não distingue caixa; caminho e query distinguem (inclusive em lojas).
export function researchUrlKey(raw: string): string {
  try { const url = new URL(raw); url.hash = ''; return url.href.replace(/\/$/, ''); }
  catch { return raw; }
}

// Data em tabela de série: 02.10.2026, 2/10/26, 2026-10-02, Oct 02, 2026.
const DATA = /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})\b/g;

/** Quantas datas o texto traz — tabela de histórico tem dezenas. */
export function datasNoTexto(text: string): number {
  return text.match(DATA)?.length ?? 0;
}

/** Trechos literais com contexto. Uma resposta no fim da página não pode sumir. */
export function researchExcerpt(text: string, question: string, limit: number): string {
  if (text.length <= limit) return text;
  const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const terms = [...new Set(normalize(question).match(/[\p{L}\p{N}]{3,}/gu) || [])];
  const normalizedQuestion = normalize(question);
  if (/memoria|memory/.test(normalizedQuestion)) terms.push('memory', 'memoria', 'gddr');
  if (/consumo|energia|potencia|power/.test(normalizedQuestion)) terms.push('power', 'consumption', 'tgp', 'watts', 'potencia');
  if (/preco|custa|price|cost/.test(normalizedQuestion)) terms.push('price', 'preco', 'r$', 'brl');
  if (/\b(?:dono|dona|proprietari[oa]|owner|fundador|responsavel)\b/.test(normalizedQuestion)) terms.push('cnpj', 'razao social', 'responsavel', 'legal', 'owner', 'founder', 'fundador');
  // Tabelas são relações entre colunas; cortar no meio perde qual valor pertence a qual modelo.
  const tables = [...text.matchAll(/^\|[^\n]*(?:\n\|[^\n]*)+/gm)].map(match => ({ text: match[0], start: match.index!, score: terms.reduce((n, term) => n + (normalize(match[0]).includes(term) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  const best = tables.find(table => table.score >= 2);
  if (best && limit >= 900) {
    let table = best.text;
    if (table.length > limit - 250) {
      const lines = table.split('\n');
      const relevant = lines.map((line, index) => ({ line, index, score: terms.reduce((n, term) => n + (normalize(line).includes(term) ? 1 : 0), 0) })).filter(row => row.index < 2 || row.score > 0);
      table = relevant.map(row => row.line).join('\n');
    }
    if (table.length <= limit - 250) {
      const rest = text.slice(0, best.start) + '\n' + text.slice(best.start + best.text.length);
      const notice = '\n[… trecho omitido …]\n';
      return table + notice + researchExcerpt(rest, question, limit - table.length - notice.length);
    }
  }
  const size = Math.min(900, Math.max(200, Math.floor(limit / 3)));
  const chunks: { index: number; text: string; score: number }[] = [];
  for (let index = 0; index < text.length; index += size) {
    const part = text.slice(index, index + size);
    const normalized = normalize(part);
    // Linha de tabela de cotação ("02.10.2026 190,10 …") não repete as palavras
    // da pergunta e perdia para o menu do site: pedaço com datas conta como relevante.
    const datas = datasNoTexto(part) >= 3 ? 2 : 0;
    chunks.push({ index, text: part, score: terms.reduce((n, term) => n + (normalized.includes(term) ? 1 : 0), 0) + datas });
  }
  const selected = [chunks[0]!];
  let used = selected[0]!.text.length;
  for (const chunk of chunks.slice(1).sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (used + chunk.text.length + 24 > limit) continue;
    selected.push(chunk); used += chunk.text.length + 24;
  }
  return selected.sort((a, b) => a.index - b.index).map((c) => c.text).join('\n[… trecho omitido …]\n');
}
