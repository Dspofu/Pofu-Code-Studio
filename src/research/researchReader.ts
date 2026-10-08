// Adaptado do saas/src/lib/researchReader.ts; atualizar com scripts/sync-research.mjs.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { extractUrls, navigable } from './webpage.js';
import { researchExcerpt } from './research.js';
import { uniqueHits, type ResearchHit } from './searchResults.js';

const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
markdown.remove(['script', 'style', 'nav', 'aside', 'form', 'noscript']);
markdown.addRule('imageAlt', { filter: 'img', replacement: (_, node) => (node as unknown as { getAttribute: (name: string) => string | null }).getAttribute('alt') || '' });
markdown.addRule('researchTables', { filter: 'table', replacement: (_, node) => {
  type Cell = { nodeName: string; childNodes: ArrayLike<Cell>; textContent: string | null };
  const rowNodes: Cell[] = [];
  const visit = (parent: Cell): void => { for (const child of Array.from(parent.childNodes)) { if (rowNodes.length >= 250) return; if (child.nodeName === 'TR') rowNodes.push(child); else if (child.childNodes.length) visit(child); } };
  visit(node as unknown as Cell);
  const rows = rowNodes.map(row => Array.from(row.childNodes).filter(cell => /^(TD|TH)$/.test(cell.nodeName)).slice(0, 50).map(cell => (cell.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(row => row.length));
  const lines = rows.map(row => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |');
  lines.splice(1, 0, '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |');
  return '\n\n' + lines.join('\n') + '\n\n';
} });

export function researchGate(url: string, title: string, text: string): boolean {
  return /\/gz\/account-verification|\/captcha(?:\/|\?|$)|\/cdn-cgi\/challenge/.test(url) || /checking your browser|verify you are human|enable javascript and cookies|just a moment|access denied|attention required.*cloudflare|sorry, you have been blocked|you are unable to access|captcha|verifique (?:que|se) voc[eê] [eé] humano|confirme que voc[eê] n[aã]o [eé] um rob[oô]/i.test(title + '\n' + text.slice(0, 350));
}

export function textResearchLinks(text: string): ResearchHit[] {
  return uniqueHits(extractUrls(text).filter(navigable).map(url => ({ title: url, url, snippet: '' })), 24);
}

export function articleText(html: string, url: string, question: string, limit: number): { title: string; text: string; links: ResearchHit[] } | null {
  const { document } = parseHTML(html);
  const title = document.title || url;
  const links = uniqueHits([...document.querySelectorAll('a[href]')].flatMap(anchor => {
    try {
      const href = new URL(anchor.getAttribute('href')!, url); href.hash = '';
      const label = (anchor.textContent || anchor.querySelector('img')?.getAttribute('alt') || href.hostname).replace(/\s+/g, ' ').trim().slice(0, 160);
      return navigable(href.href) && !/\.(?:png|jpg|jpeg|webp|svg|css|js|woff2?)(?:\?|$)/i.test(href.href) ? [{ title: label, url: href.href, snippet: '' }] : [];
    } catch { return []; }
  }), 60).sort((a, b) => Number(/sobre|about|contato|contact|legal|privacidade|privacy|termos|terms|cnpj|reclame/i.test(b.title + b.url)) - Number(/sobre|about|contato|contact|legal|privacidade|privacy|termos|terms|cnpj|reclame/i.test(a.title + a.url))).slice(0, 24);
  const article = new Readability(document.cloneNode(true) as any, { charThreshold: 150 }).parse();
  for (const el of document.querySelectorAll('script,style,nav,aside,form,noscript')) el.remove();
  const raw = markdown.turndown(document.body?.innerHTML || document.documentElement.innerHTML).trim();
  const clean = article?.content ? markdown.turndown(article.content).trim() : '';
  const base = clean.length >= 200 && clean.length >= raw.length * 0.35 ? clean : raw;
  const footer = [...document.querySelectorAll('footer')].map(el => markdown.turndown(el.outerHTML)).join('\n');
  const tables = [...document.querySelectorAll('table')].map(table => markdown.turndown(table.outerHTML)).filter(table => table.length > 80 && /memory|mem[oó]ria|power|pot[eê]ncia|consumo|price|pre[cç]o|r\$|specifications/i.test(table));
  const text = tables.filter(table => !base.includes(table)).join('\n\n') + '\n\n' + base + (footer && !base.includes(footer) ? '\n\n' + footer : '');
  if (text.length < 80 || researchGate(url, title, text)) return null;
  return { title: article?.title || title, text: researchExcerpt(text, question, limit), links };
}

export async function readResearchPage(url: string, question: string, signal: AbortSignal, limit = 6000): Promise<{ url: string; title: string; text: string; links?: ResearchHit[] } | null> {
  let current = url;
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!navigable(current)) return null;
    const response = await fetch(current, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get('location'); if (!target) return null;
      current = new URL(target, current).href; await response.body?.cancel(); continue;
    }
    if (!response.ok) { await response.body?.cancel(); return null; }
    const type = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml|text\/plain|text\/markdown/.test(type)) { await response.body?.cancel(); return null; }
    if (Number(response.headers.get('content-length')) > 2000000) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader(); if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2000000) return null; chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const body = Buffer.concat(chunks).toString('utf8');
    const parsed = /text\/plain|text\/markdown/.test(type) ? { title: current, text: researchExcerpt(body, question, limit), links: textResearchLinks(body) } : articleText(body, current, question, limit);
    return parsed && parsed.text.length >= 80 && !researchGate(current, parsed.title, parsed.text) ? { url: current, ...parsed } : null;
  }
  return null;
}
