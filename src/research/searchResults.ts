// Adaptado do saas/src/functions/searchResults.ts; atualizar com scripts/sync-research.mjs.
import { researchUrlKey } from './research.js';

export interface ResearchHit { title: string; url: string; snippet: string }

export function mcpTexts(body: string): string[] {
  const payloads = body.trimStart().startsWith('{') ? [body] : body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  const texts: string[] = [];
  for (const payload of payloads) {
    let decoded: any;
    try { decoded = JSON.parse(payload); } catch { continue; }
    if (decoded.error || decoded.result?.isError) throw new Error('Search provider unavailable');
    for (const item of decoded.result?.content ?? []) if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text.replace(/\r\n/g, '\n'));
  }
  return texts;
}

/** Extração solicitada ao crawler é leitura; Highlights de busca continuam apenas pistas. */
export function exaPages(body: string): { title: string; url: string; text: string }[] {
  return mcpTexts(body).flatMap(text => text.split(/(?=^# [^\n]+\nURL: https?:\/\/)/m).map(block => {
    const head = block.match(/^# ([^\n]+)\nURL: (https?:\/\/\S+)\n/);
    return head ? { title: head[1]!, url: head[2]!, text: block.slice(head[0].length).trim() } : null;
  }).filter((page): page is { title: string; url: string; text: string } => page !== null && page.text.length >= 80));
}

/** O MCP pode responder JSON ou eventos SSE; ambos têm o mesmo envelope. */
export function exaResults(body: string): ResearchHit[] {
  const results: ResearchHit[] = [];
  for (const text of mcpTexts(body)) {
    for (const block of text.split(/(?=^Title: )/m)) {
      const title = block.match(/^Title: (.+)$/m)?.[1]?.trim(), url = block.match(/^URL: (https?:\/\/\S+)$/m)?.[1];
      if (!title || !url) continue;
      const snippet = block.replace(/^Title: .*\r?\nURL: .*\r?\n/, '').replace(/^Author: .*\r?\n/m, '').trim().slice(0, 6000);
      results.push({ title, url, snippet });
    }
  }
  return uniqueHits(results);
}

export function uniqueHits(hits: ResearchHit[], limit = 12): ResearchHit[] {
  const seen = new Set<string>();
  return hits.filter(hit => {
    const key = researchUrlKey(hit.url);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, limit);
}

export function researchQueries(queries: string[], previous: string[] = []): string[] {
  const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const seen = new Set(previous.map(normalize));
  return queries.map(q => q.replace(/\s+/g, ' ').trim().slice(0, 200)).filter(q => {
    const key = normalize(q);
    if (q.length < 2 || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 3);
}
