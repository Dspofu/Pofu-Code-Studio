// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

// ============================================================================
// ARQUIVO GERADO — não edite aqui.
//
// Saída de `tsc` sobre o módulo portátil websearch.ts, mantido fora deste projeto
// (…/chat/src/lib/websearch.ts). Para mudar qualquer coisa, altere lá e recompile:
//
//   npx tsc caminho/para/websearch.ts --target es2022 --module esnext \
//       --moduleResolution bundler --skipLibCheck --removeComments false --outDir src/
//
// Os erros TS2307 dos três imports são esperados (o .ts vive fora deste node_modules)
// e não impedem a emissão — o JS sai correto.
//
// Neste projeto ele é instanciado em main.js, que injeta o navegador do Electron nos
// pontos de extensão `extraProviders` (busca) e `renderHtml` (páginas em JS).
// ============================================================================
// websearch.ts — busca web + extração de conteúdo, PORTÁTIL
//
// Módulo autocontido, pensado para ser copiado entre projetos. Ele NÃO conhece
// Discord, llama.cpp, .env nem console: tudo que é do ambiente entra por opções.
//
// O que faz:
//   1. Consulta uma CASCATA de provedores (SearXNG, Brave/Serper/Tavily com
//      chave, e scrapers sem chave: Bing/Startpage/DuckDuckGo). Vence o primeiro
//      cujos resultados CASAM com a consulta.
//   2. Visita as primeiras páginas e devolve o TEXTO real (artigo limpo em
//      markdown via Readability), não só os snippets.
//   3. Se a consulta traz operadores estilo Google (site:, OR, aspas) e dá zero,
//      refaz sozinho com palavras simples.
//   4. Cache por consulta e cooldown por provedor (curto p/ "não serviu", longo
//      p/ "quebrado").
//
// Dependências (npm): @mozilla/readability, linkedom, turndown.
//
// Navegador é OPCIONAL e injetável (opção `renderHtml`): sem ele, páginas que
// montam o conteúdo em JS rendem menos texto, mas tudo continua funcionando.
//
// Uso rápido:
//   import { WebSearch } from './websearch.ts';
//   const ws = new WebSearch({ braveApiKey: process.env.BRAVE_API_KEY });
//   const r = await ws.search('quem é fulano');   // objeto estruturado
//   // ou, string pronta para um prompt de LLM:
//   const txt = await ws.searchText('quem é fulano');
// ============================================================================
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
// ---------------------------------------------------------------------------
// Padrões
// ---------------------------------------------------------------------------
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_STOPWORDS = [
  'de', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
  'e', 'ou', 'em', 'no', 'na', 'nos', 'nas', 'para', 'pra', 'por', 'com', 'sem',
  'que', 'qual', 'quais', 'quem', 'quando', 'onde', 'como', 'foi', 'ser', 'tem',
  'sao', 'esta', 'estao', 'sobre', 'mais', 'hoje', 'agora', 'atual',
  'the', 'of', 'and', 'in', 'on', 'for', 'to', 'is', 'was', 'are', 'what', 'who',
  'when', 'where', 'how', 'an', 'at', 'by', 'with'
];
// Nome de plataforma é CONTEXTO, nunca o assunto: buscar "fulano instagram" e
// receber a home do Instagram não achou fulano nenhum — mas "instagram" casa.
const DEFAULT_PLATFORMS = [
  'twitter', 'x', 'instagram', 'insta', 'tiktok', 'youtube', 'yt', 'facebook',
  'fb', 'twitch', 'reddit', 'linkedin', 'threads', 'kwai', 'discord', 'telegram',
  'whatsapp', 'pinterest', 'tumblr', 'snapchat', 'perfil', 'canal', 'rede',
  'redes', 'sociais', 'social', 'site', 'pagina', 'usuario', 'user', 'username'
];
// ---------------------------------------------------------------------------
// Implementação
// ---------------------------------------------------------------------------
export class WebSearch {
  ua;
  lang;
  resultLimit;
  pagesToFetch;
  pageCharLimit;
  minUsefulPageChars;
  searchTimeoutMs;
  pageTimeoutMs;
  cooldownMs;
  softCooldownMs;
  cacheTtlMs;
  cacheMaxEntries;
  stopwords;
  platforms;
  log;
  renderHtml;
  providers;
  turndown;
  // hard = provedor QUEBRADO (vale p/ qualquer consulta); soft = só não serviu
  // para AQUELA consulta (não barra uma diferente).
  cooldown = new Map();
  cache = new Map();
  constructor(opts = {}) {
    this.ua = opts.userAgent ?? DEFAULT_UA;
    this.lang = opts.language ?? 'pt-BR';
    this.resultLimit = opts.resultLimit ?? 5;
    this.pagesToFetch = opts.pagesToFetch ?? 2;
    this.pageCharLimit = opts.pageCharLimit ?? 4_000;
    this.minUsefulPageChars = opts.minUsefulPageChars ?? 300;
    this.searchTimeoutMs = opts.searchTimeoutMs ?? 15_000;
    this.pageTimeoutMs = opts.pageTimeoutMs ?? 10_000;
    this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
    this.softCooldownMs = opts.softCooldownMs ?? 60_000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;
    this.cacheMaxEntries = opts.cacheMaxEntries ?? 40;
    this.stopwords = new Set(opts.stopwords ?? DEFAULT_STOPWORDS);
    this.platforms = new Set(opts.platformWords ?? DEFAULT_PLATFORMS);
    this.log = opts.logger ?? (() => { });
    this.renderHtml = opts.renderHtml;
    this.turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    this.turndown.remove(['script', 'style', 'nav', 'footer', 'aside', 'form', 'noscript']);
    // O modelo lê TEXTO: "![](https://.../img-70x70.png)" é só URL comendo
    // contexto. O alt, quando existe, já vem no texto.
    this.turndown.addRule('semImagem', { filter: 'img', replacement: () => '' });
    // Cascata. A ordem importa: metabusca > chave > scraper.
    const langHeader = `${this.lang},${this.lang.split('-')[0]};q=0.9,en;q=0.8`;
    this.acceptLanguage = langHeader;
    const builtin = [];
    if (opts.searxngUrl) {
      const base = opts.searxngUrl.trim().replace(/\/+$/, '');
      builtin.push({ name: 'searxng', run: q => this.searchSearxng(base, q) });
    }
    if (opts.braveApiKey)
      builtin.push({ name: 'brave', run: q => this.searchBrave(opts.braveApiKey, q) });
    if (opts.serperApiKey)
      builtin.push({ name: 'serper', run: q => this.searchSerper(opts.serperApiKey, q) });
    if (opts.tavilyApiKey)
      builtin.push({ name: 'tavily', run: q => this.searchTavily(opts.tavilyApiKey, q) });
    if (opts.useScrapers ?? true) {
      // Bing antes de Startpage/DDG: medido em 24/07/2026, é o único scraper por
      // fetch que ainda responde sem captcha para a maioria das consultas.
      builtin.push({ name: 'bing', run: q => this.searchBing(q) });
      builtin.push({ name: 'startpage', run: q => this.searchStartpage(q) });
      builtin.push({ name: 'duckduckgo', run: q => this.searchDuckDuckGo(q, false) });
      builtin.push({ name: 'duckduckgo-lite', run: q => this.searchDuckDuckGo(q, true) });
    }
    this.providers = [...builtin, ...(opts.extraProviders ?? [])];
  }
  acceptLanguage;
  // -- API pública -----------------------------------------------------------
  /** Busca estruturada. Null = nada encontrado. */
  async search(query) {
    const cacheKey = this.norm(query).replace(/\s+/g, ' ').trim();
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() < cached.expires) {
        this.log('info', `💾 cache: reaproveitando a busca de "${query}".`);
        return cached.outcome;
      }
    }
    let usada = query;
    let terms = this.significantTerms(usada);
    let achado = await this.runCascade(usada, terms);
    // Segunda chance SEM operadores estilo Google: '"fulano" site:x.com OR ...'
    // dá zero em todo provedor, enquanto o simples "fulano" acha o perfil.
    let simplified = false;
    if (!achado) {
      const simples = this.simplifyQuery(query);
      if (simples) {
        this.log('info', `🔁 Zero resultados com operadores. Refazendo simples: "${simples}"`);
        usada = simples;
        terms = this.significantTerms(usada);
        simplified = true;
        achado = await this.runCascade(usada, terms, true);
      }
    }
    if (!achado) {
      this.log('info', `❌ Nenhum provedor retornou resultados úteis para "${query}".`);
      return null;
    }
    const pageResults = await Promise.allSettled(achado.results.slice(0, this.pagesToFetch).map(r => this.fetchPageText(r.url, terms)));
    const pages = [];
    pageResults.forEach((p, i) => {
      if (p.status === 'fulfilled' && p.value) {
        pages.push({ url: achado.results[i].url, text: p.value });
      }
    });
    const outcome = {
      originalQuery: query,
      query: usada,
      simplified,
      provider: achado.provider,
      results: achado.results,
      pages
    };
    this.log('info', `✅ ${achado.provider}: ${achado.results.length} resultados relevantes para "${usada}".`);
    if (this.cacheTtlMs > 0) {
      this.cache.set(cacheKey, { outcome, expires: Date.now() + this.cacheTtlMs });
      if (this.cache.size > this.cacheMaxEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined)
          this.cache.delete(oldest);
      }
    }
    return outcome;
  }
  /**
   * Conveniência: a busca já formatada como texto para um prompt de LLM.
   * Passe seu próprio `format` para trocar os rótulos/idioma.
   */
  async searchText(query, format = defaultFormat) {
    const outcome = await this.search(query);
    return outcome ? format(outcome) : null;
  }
  // -- Cascata ----------------------------------------------------------------
  async runCascade(query, terms, ignoreSoft = false) {
    for (const provider of this.providers) {
      if (provider.enabled && !provider.enabled())
        continue;
      const cd = this.cooldown.get(provider.name);
      if (cd && Date.now() < cd.until && (cd.hard || !ignoreSoft)) {
        this.log('info', `⏳ ${provider.name} em cooldown${cd.hard ? '' : ' curto'}, pulando.`);
        continue;
      }
      try {
        const found = await provider.run(query);
        if (found.length === 0) {
          this.log('info', `⚠️ ${provider.name}: 0 resultados. Tentando próximo...`);
          this.cooldown.set(provider.name, { until: Date.now() + this.softCooldownMs, hard: false });
          continue;
        }
        // Ordena por nº de termos batidos; um acerto parcial (a página diz
        // "cotação" onde a busca dizia "preço") continua valendo.
        const ranked = found
          .map(r => ({ r, score: this.relevanceScore(r, terms) }))
          .sort((a, b) => b.score - a.score);
        const casaram = ranked.filter(s => s.score >= 1).map(s => s.r);
        if (casaram.length > 0)
          return { results: casaram, provider: provider.name };
        // NENHUM resultado casou com NENHUM termo: anti-bot devolvendo página
        // padrão (o Bing responde "large language model" com a home da
        // Microsoft). Descarta o provedor com cooldown CURTO e segue.
        this.log('warn', `🚫 ${provider.name}: ${found.length} resultados sem relação com "${query}" (anti-bot?).`);
        this.cooldown.set(provider.name, { until: Date.now() + this.softCooldownMs, hard: false });
      }
      catch (err) {
        // Exceção = falha REAL (HTTP de erro, captcha, timeout): cooldown longo.
        this.log('error', `❌ ${provider.name} falhou: ${err?.message || err}`);
        this.cooldown.set(provider.name, { until: Date.now() + this.cooldownMs, hard: true });
      }
    }
    return null;
  }
  // Tira a sintaxe estilo Google e, se sobrar assunto, os nomes de plataforma.
  simplifyQuery(query) {
    const semOperador = query
      .replace(/\b(?:site|inurl|intitle|intext|filetype|ext|related|cache|allintitle|allinurl):\S*/gi, ' ')
      .replace(/\b(?:OR|AND)\b/g, ' ')
      .replace(/[«»"“”]/g, ' ')
      .replace(/(^|\s)-\S+/g, ' ') // exclusão "-tiktok"; hífen no meio é preservado
      .replace(/\s+/g, ' ')
      .trim();
    const palavras = semOperador.split(/\s+/).filter(Boolean);
    const semPlataforma = palavras.filter(p => !this.platforms.has(this.norm(p)));
    const simples = (semPlataforma.length > 0 ? semPlataforma : palavras).join(' ').trim();
    if (!simples || this.norm(simples) === this.norm(query.trim()))
      return null;
    return simples;
  }
  // -- Relevância -------------------------------------------------------------
  norm(text) {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  significantTerms(query) {
    return [...new Set(this.norm(query)
      .split(/[^a-z0-9]+/)
      .filter(t => (t.length >= 3 || /^\d{4}$/.test(t)) && !this.stopwords.has(t)))];
  }
  relevanceScore(r, terms) {
    if (terms.length === 0)
      return 1;
    const hay = this.norm(`${r.title} ${r.snippet} ${r.url}`);
    const batidos = terms.filter(t => hay.includes(t));
    if (batidos.length === 0)
      return 0;
    // O termo que IDENTIFICA o assunto tem que estar lá: senão "fulano
    // instagram tiktok" era aprovado pela home dessas redes. Se a consulta é SÓ
    // plataforma, não há termo específico a exigir e a regra sai de cena.
    const especificos = terms.filter(t => !this.platforms.has(t));
    if (especificos.length > 0 && !especificos.some(t => hay.includes(t)))
      return 0;
    return batidos.length;
  }
  // -- Provedores com chave ---------------------------------------------------
  async searchSearxng(base, query) {
    const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=${encodeURIComponent(this.lang)}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': this.ua },
      signal: AbortSignal.timeout(this.searchTimeoutMs)
    });
    if (!res.ok)
      throw new Error(`SearXNG respondeu ${res.status}`);
    const json = await res.json();
    return (json.results || [])
      .map((r) => ({ title: String(r.title || ''), url: String(r.url || ''), snippet: String(r.content || '').slice(0, 300) }))
      .filter((r) => r.title && r.url.startsWith('http'))
      .slice(0, this.resultLimit);
  }
  async searchBrave(key, query) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${this.resultLimit}`, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(this.searchTimeoutMs)
    });
    if (!res.ok)
      throw new Error(`Brave respondeu ${res.status}`);
    const json = await res.json();
    return (json.web?.results || []).slice(0, this.resultLimit).map((r) => ({
      title: this.stripHtml(r.title || ''), url: r.url, snippet: this.stripHtml(r.description || '')
    }));
  }
  async searchSerper(key, query) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: this.resultLimit }),
      signal: AbortSignal.timeout(this.searchTimeoutMs)
    });
    if (!res.ok)
      throw new Error(`Serper respondeu ${res.status}`);
    const json = await res.json();
    return (json.organic || []).slice(0, this.resultLimit).map((r) => ({
      title: r.title || '', url: r.link, snippet: r.snippet || ''
    }));
  }
  async searchTavily(key, query) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: this.resultLimit }),
      signal: AbortSignal.timeout(this.searchTimeoutMs)
    });
    if (!res.ok)
      throw new Error(`Tavily respondeu ${res.status}`);
    const json = await res.json();
    return (json.results || []).slice(0, this.resultLimit).map((r) => ({
      title: r.title || '', url: r.url, snippet: r.content || ''
    }));
  }
  // -- Provedores sem chave (scraping) ---------------------------------------
  async searchStartpage(query) {
    const res = await fetch(`https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': this.ua, 'Accept-Language': this.acceptLanguage },
      signal: AbortSignal.timeout(this.searchTimeoutMs)
    });
    if (!res.ok)
      throw new Error(`Startpage respondeu ${res.status}`);
    const html = await res.text();
    if (/captcha|are you human|unusual traffic/i.test(html))
      throw new Error('Startpage bloqueou (captcha)');
    const results = [];
    const blocks = html.split(/<div class="result css/).slice(1);
    for (const block of blocks) {
      if (results.length >= this.resultLimit)
        break;
      const link = block.match(/<a[^>]+class="[^"]*result-title[^"]*"[^>]+href="(https?[^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
        block.match(/<a[^>]+href="(https?[^"]+)"[^>]+class="[^"]*result-title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      if (!link)
        continue;
      const url = this.decodeEntities(link[1] || '');
      const title = this.stripHtml(link[2] || '');
      if (!url || !title || url.includes('startpage.com'))
        continue;
      const desc = block.match(/data-testid="result-description"[^>]*>([\s\S]*?)<\/(p|div|span)>/) ||
        block.match(/class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/(p|div|span)>/);
      results.push({ url, title, snippet: this.stripHtml(desc?.[1] || '').slice(0, 300) });
    }
    return results;
  }
  async searchDuckDuckGo(query, lite) {
    const url = lite ? 'https://lite.duckduckgo.com/lite/' : 'https://html.duckduckgo.com/html/';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': this.ua, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Language': this.acceptLanguage },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(this.searchTimeoutMs)
    });
    if (!res.ok)
      throw new Error(`DuckDuckGo respondeu ${res.status}`);
    const html = await res.text();
    if (/anomaly-modal|unusual traffic|captcha/i.test(html))
      throw new Error('DuckDuckGo bloqueou (rate limit)');
    const titles = [];
    const linkRegex = lite
      ? /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
      : /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = linkRegex.exec(html)) !== null && titles.length < this.resultLimit) {
      const target = this.decodeDDGLink(match[1] || '');
      const title = this.stripHtml(match[2] || '');
      if (target && title && !this.isAd(target))
        titles.push({ url: target, title });
    }
    const snippets = [];
    const snippetRegex = lite
      ? /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
      : /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < this.resultLimit) {
      snippets.push(this.stripHtml(match[1] || ''));
    }
    return titles.map((t, i) => ({ ...t, snippet: snippets[i] || '' }));
  }
  async searchBing(query) {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=${encodeURIComponent(this.lang)}`, {
      headers: { 'User-Agent': this.ua, 'Accept-Language': this.acceptLanguage },
      signal: AbortSignal.timeout(this.searchTimeoutMs)
    });
    if (!res.ok)
      throw new Error(`Bing respondeu ${res.status}`);
    const html = await res.text();
    const results = [];
    const regex = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < this.resultLimit) {
      const url = this.decodeBingLink(match[1] || '');
      const title = this.stripHtml(match[2] || '');
      if (url && title && !this.isAd(url))
        results.push({ url, title, snippet: '' });
    }
    const snippets = [];
    const snippetRegex = /class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < this.resultLimit) {
      snippets.push(this.stripHtml(match[1] || ''));
    }
    results.forEach((r, i) => { r.snippet = snippets[i] || ''; });
    return results;
  }
  // -- Extração de página -----------------------------------------------------
  extractArticle(html) {
    try {
      const { document } = parseHTML(html);
      const article = new Readability(document, { charThreshold: 200 }).parse();
      if (!article?.content)
        return null;
      const md = this.turndown.turndown(article.content)
        // Nota de rodapé da Wikipédia ("[\[1\]](#cite_note-x)"): puro token.
        .replace(/\[\\\[[^\]\n]*\\\]\]\(#cite[^)]*\)/g, '')
        .replace(/\[[^\[\]\n]*\]\(#cite[^)]*\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return md || null;
    }
    catch {
      return null;
    }
  }
  // Artigo limpo quando dá substância; texto cru quando não dá (perfil/SPA, onde
  // o Readability devolve um toco e o innerText tem o conteúdo real).
  textFromHtml(html, terms) {
    const artigo = this.extractArticle(html);
    const cru = this.stripHtml(html);
    let escolhido = artigo;
    if (!escolhido || (escolhido.length < this.minUsefulPageChars && cru.length > escolhido.length)) {
      escolhido = cru;
    }
    return escolhido ? this.relevantWindow(escolhido, terms) : null;
  }
  async fetchViaHttp(url, terms) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.ua, 'Accept-Language': this.acceptLanguage },
        signal: AbortSignal.timeout(this.pageTimeoutMs),
        redirect: 'follow'
      });
      if (!res.ok)
        return null;
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html') && !type.includes('text/plain'))
        return null;
      return this.textFromHtml(await res.text(), terms);
    }
    catch {
      return null;
    }
  }
  async fetchPageText(url, terms = []) {
    const direto = await this.fetchViaHttp(url, terms);
    if (direto && direto.length >= this.minUsefulPageChars)
      return direto;
    // Casca vazia = site que monta o conteúdo em JS. Se houver renderizador
    // injetado, usa; senão fica com o que o fetch trouxe.
    if (!this.renderHtml)
      return direto;
    let html = null;
    try {
      html = await this.renderHtml(url);
    }
    catch {
      html = null;
    }
    if (!html)
      return direto;
    const renderizado = this.textFromHtml(html, terms);
    if (!renderizado)
      return direto;
    if (!direto || renderizado.length > direto.length) {
      this.log('info', `🖥️ ${safeHost(url)}: fetch=${direto?.length || 0} chars, render=${renderizado.length}.`);
      return renderizado;
    }
    return direto;
  }
  // Recorta em volta do primeiro termo: os primeiros N chars costumam ser menu.
  relevantWindow(text, terms) {
    if (text.length <= this.pageCharLimit || terms.length === 0)
      return text.slice(0, this.pageCharLimit);
    const hay = this.norm(text);
    let first = -1;
    for (const t of terms) {
      const i = hay.indexOf(t);
      if (i >= 0 && (first === -1 || i < first))
        first = i;
    }
    if (first === -1)
      return text.slice(0, this.pageCharLimit);
    const start = Math.max(0, first - 300);
    return (start > 0 ? '…' : '') + text.slice(start, start + this.pageCharLimit);
  }
  // -- Utilitários ------------------------------------------------------------
  isAd(url) {
    return /duckduckgo\.com\/y\.js|bing\.com\/aclk|\/ck\/a\?/i.test(url);
  }
  decodeDDGLink(href) {
    const decoded = this.decodeEntities(href);
    if (decoded.includes('duckduckgo.com/l/')) {
      try {
        const full = decoded.startsWith('//') ? `https:${decoded}` : decoded;
        const uddg = new URL(full).searchParams.get('uddg');
        return uddg ? decodeURIComponent(uddg) : '';
      }
      catch {
        return '';
      }
    }
    return decoded.startsWith('http') ? decoded : '';
  }
  decodeBingLink(href) {
    const decoded = this.decodeEntities(href);
    if (!decoded.includes('bing.com/ck/a'))
      return decoded.startsWith('http') ? decoded : '';
    try {
      const u = new URL(decoded).searchParams.get('u');
      if (!u || !u.startsWith('a1'))
        return '';
      const b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const real = Buffer.from(b64, 'base64').toString('utf8');
      return real.startsWith('http') ? real : '';
    }
    catch {
      return '';
    }
  }
  stripHtml(html) {
    return this.decodeEntities(html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
  decodeEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;|&#0?160;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
  }
}
// ---------------------------------------------------------------------------
// Ajudantes de nível de módulo
// ---------------------------------------------------------------------------
function safeHost(url) {
  try {
    return new URL(url).hostname;
  }
  catch {
    return url.slice(0, 40);
  }
}
/** Formatação padrão de um SearchOutcome como texto para prompt de LLM. */
export function defaultFormat(o) {
  const head = o.simplified
    ? `[RESULTADOS DA BUSCA WEB para "${o.query}" (via ${o.provider})]:\n(A consulta original "${o.originalQuery}" não devolveu nada — operadores como site:, OR e aspas não funcionam aqui. Refeita com palavras simples.)`
    : `[RESULTADOS DA BUSCA WEB para "${o.query}" (via ${o.provider})]:`;
  const lines = [head];
  o.results.forEach((r, i) => lines.push(`${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`));
  if (o.pages.length > 0) {
    lines.push('\n[CONTEÚDO DAS PÁGINAS VISITADAS]:');
    for (const p of o.pages)
      lines.push(`--- Conteúdo de ${p.url} ---\n${p.text}`);
  }
  return lines.join('\n');
}
/** Atalho de um tiro: cria a instância, busca e devolve o objeto. */
export function webSearch(query, opts) {
  return new WebSearch(opts).search(query);
}