// Adaptado do saas/src/lib/exaSearch.ts; atualizar com scripts/sync-research.mjs.
import { exaPages, exaResults, type ResearchHit } from './searchResults.js';
import { navigable } from './webpage.js';
import { researchGate, textResearchLinks } from './researchReader.js';

/** Descoberta pública por MCP, sem instalar outro agente ou depender de seu servidor. */
export class ExaSearch {
  private cache = new Map<string, { expires: number; hits: ResearchHit[] }>();
  private apiKey: string;
  constructor(apiKey = '') { this.apiKey = apiKey; }

  private async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const response = await fetch('https://mcp.exa.ai/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.any([signal, AbortSignal.timeout(18000)]),
    });
    if (!response.ok) throw new Error(`Search provider: HTTP ${response.status}`);
    return response.text();
  }

  async search(query: string, signal: AbortSignal, objective = query): Promise<ResearchHit[]> {
    signal.throwIfAborted();
    const key = (query + '\n' + objective).toLowerCase().replace(/\s+/g, ' ').trim();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.hits.map(h => ({ ...h }));
    const hits = exaResults(await this.call('web_search_exa', { query, objective: objective.slice(0, 3500), numResults: 6 }, signal));
    if (hits.length) {
      this.cache.set(key, { expires: Date.now() + 60000, hits });
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    return hits.map(h => ({ ...h }));
  }

  async read(url: string, signal: AbortSignal, limit = 6000): Promise<{ title: string; url: string; text: string; links: ResearchHit[] } | null> {
    if (!navigable(url)) return null;
    const pages = exaPages(await this.call('web_fetch_exa', { urls: [url], maxCharacters: limit }, signal));
    const page = pages.find(page => navigable(page.url) && !researchGate(page.url, page.title, page.text));
    return page ? { ...page, text: page.text.slice(0, limit), links: textResearchLinks(page.text) } : null;
  }
}
