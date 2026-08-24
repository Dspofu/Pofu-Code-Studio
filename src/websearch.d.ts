// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofuserver Coder Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofuserver-Code

// Tipos de src/websearch.js, que é ARQUIVO GERADO (saída do tsc sobre o módulo portátil
// mantido noutro repositório) e por isso não vira .ts aqui. Só o que o main.ts realmente
// usa está declarado: a classe inteira é grande e replicá-la daria uma segunda cópia para
// sair de sincronia sem ninguém perceber.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  text: string;
}

export interface SearchOutcome {
  query: string;
  /** Presente quando a consulta foi simplificada antes de repetir a busca. */
  originalQuery?: string;
  simplified?: boolean;
  /** Nome do provedor que acabou respondendo (na prática, ddg-navegador). */
  provider: string;
  results: SearchResult[];
  pages: FetchedPage[];
}

/** Provedor extra na cascata — é por aqui que entram os que dependem do Electron. */
export interface SearchProvider {
  name: string;
  run(query: string): Promise<SearchResult[]>;
}

export interface WebSearchOptions {
  userAgent?: string;
  language?: string;
  resultLimit?: number;
  pagesToFetch?: number;
  pageCharLimit?: number;
  minUsefulPageChars?: number;
  searchTimeoutMs?: number;
  pageTimeoutMs?: number;
  cooldownMs?: number;
  softCooldownMs?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  stopwords?: string[];
  platformWords?: string[];
  logger?: (nivel: string, msg: string) => void;
  /** Renderiza a página numa BrowserWindow oculta quando o fetch não basta. */
  renderHtml?: (url: string, timeoutMs?: number) => Promise<string | null>;
  searxngUrl?: string;
  braveApiKey?: string;
  serperApiKey?: string;
  tavilyApiKey?: string;
  useScrapers?: boolean;
  extraProviders?: SearchProvider[];
}

export declare class WebSearch {
  constructor(opts?: WebSearchOptions);
  /** Busca estruturada. `null` = nenhum provedor devolveu resultado útil. */
  search(query: string): Promise<SearchOutcome | null>;
  searchText(query: string, format?: (o: SearchOutcome) => string): Promise<string>;
  fetchPageText(url: string, terms?: string[]): Promise<string>;
}

export declare function defaultFormat(o: SearchOutcome): string;
export declare function webSearch(query: string, opts?: WebSearchOptions): Promise<SearchOutcome | null>;
