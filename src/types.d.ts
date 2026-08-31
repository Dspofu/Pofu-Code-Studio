// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

// Declarações GLOBAIS (o arquivo não tem import/export de propósito): main e renderer
// enxergam estes tipos sem precisar importar nada, e nenhum .js a mais é emitido para o
// runtime carregar. Um módulo de tipos exigiria `import type … from './types.js'` em cada
// arquivo, e um caminho .js que não existe em disco é exatamente o tipo de armadilha que
// só aparece quando o Electron tenta resolvê-lo.

/** Nível de raciocínio escolhido no rodapé do compositor. */
type ThinkLevel = 'padrao' | 'desligado' | 'baixo' | 'medio' | 'alto' | 'maximo';

/** Modo de execução de comandos: 'manual' abre o modal de confirmação. */
type ExecMode = 'manual' | 'auto';

/** O que fazer com as instruções que o usuário escreveu nas configurações. */
type PromptMode = 'append' | 'replace';

/**
 * Instruções importadas de um arquivo (o SKILL.md do Claude Code e afins). O conteúdo
 * das skills ATIVAS entra no prompt de sistema a cada requisição — por isso `chars`
 * fica visível na lista: é orçamento de contexto gasto em toda mensagem.
 */
interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  arquivo: string;
  ativa: boolean;
}

/** Uma opção do card de pergunta (ask_user). */
interface OpcaoPergunta {
  label: string;
  description?: string;
}

interface ThinkLevelDef {
  rotulo: string;
  dica: string;
  /** Campos acrescentados ao corpo da requisição; `null` não acrescenta nada. */
  payload: Record<string, unknown> | null;
  /** Se verdadeiro, o prompt de sistema ainda ganha o sufixo /no_think. */
  semRaciocinio: boolean;
  /**
   * Recurso que o SERVIDOR precisa aceitar para este nível existir no menu.
   * `null` = não manda nada e funciona em qualquer endpoint (ver SuporteRaciocinio).
   */
  requer: 'enable_thinking' | 'reasoning_effort' | null;
}

/** O que o endpoint ANUNCIOU sobre raciocínio (preenchido por detectThink*). */
interface SuporteRaciocinio {
  /** O endpoint disse alguma coisa a respeito; falso = nada detectado. */
  detectado: boolean;
  /** Aceita `chat_template_kwargs.enable_thinking`. */
  enableThinking: boolean;
  /** Aceita `reasoning_effort`. */
  reasoningEffort: boolean;
  /** Níveis de reasoning_effort enumerados pelo template (null = não enumerou). */
  valores: Set<string> | null;
  /** De onde veio a informação — mostrado no rodapé do menu. */
  origem: string;
  /**
   * O servidor devolveu o chat template. Template lido SEM marca de raciocínio é
   * resposta conclusiva ("este modelo não tem modo de pensar"), diferente do
   * silêncio de um endpoint que nem expõe /props.
   */
  templateLido: boolean;
}

interface Settings {
  apiUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  /** Teto do histórico por requisição, em tokens. 0 = sem teto (usa só o n_ctx do modelo). */
  historyCap: number;
  /** Legado: só sobrevive para migrar store antigo — quem manda é `thinkLevel`. */
  noThink: boolean;
  thinkLevel: ThinkLevel;
  cmdTimeout: number;
  webSearch: boolean;
  execMode: ExecMode;
  safetyInteractions: boolean;
  visionFeedback: boolean;
  /** Esconde a janela de console que o Windows abriria a cada execute_command. */
  hideCommandConsole: boolean;
  /** Instruções escritas pelo usuário, somadas ao prompt de sistema (ou no lugar dele). */
  customPrompt: string;
  /** 'append' soma ao prompt padrão; 'replace' usa só o texto do usuário. */
  promptMode: PromptMode;
  /** Skills importadas. As ativas entram no prompt de sistema. */
  skills: Skill[];
}

/** Anexo de arquivo preso à mensagem do usuário. */
interface Attachment {
  name: string;
  content: string;
  size?: number;
  /** true quando o conteúdo não vira texto na mensagem (imagem, PDF, executável). */
  binary?: boolean;
  /** true quando o conteúdo foi truncado no anexo. */
  truncated?: boolean;
  /** true para menção (@arquivo) e skills (@skill). */
  mention?: boolean;
  /** Caminho relativo do arquivo mencionado (só menção) — ver `imagemPath` para imagem. */
  path?: string;
  /** Data URL da miniatura (imagens): exibida no chip e na bolha da mensagem. */
  thumb?: string;
  /** Caminho da imagem salva em userData — é por ele que os pixels voltam ao modelo.
   *  NÃO reaproveite o `path` para isso: ele já é o caminho relativo da menção
   *  (@arquivo), e confundir os dois manda um .md rotulado como PNG ao servidor. */
  imagemPath?: string;
}

interface ToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

/** Print devolvido pelo capture_page: no histórico fica só o caminho do PNG. */
interface ShotRef {
  path: string;
  width?: number;
  height?: number;
}

/**
 * Instantâneo de escrita/edição/remoção, usado pelo card de diff e pelo desfazer. No
 * histórico persistido fica só isto: o antes/depois mora no instantâneo em disco e é o
 * `get-diff` que o remonta ao recarregar o chat.
 */
interface Alteracao {
  snapshotId: string;
  arquivo: string;
  adicionadas: number;
  removidas: number;
  apagado: boolean;
}

/** Linhas do diff calculado no main. */
interface DiffData {
  adicionadas?: number;
  removidas?: number;
  linhas?: Array<{ tipo: string; texto: string; linha?: number }>;
  [k: string]: any;
}

/**
 * O que acompanha o resultado de uma ferramenta na TELA e não vai para o modelo — print
 * e diff custariam contexto em dobro se voltassem no histórico da requisição.
 */
interface ToolExtras {
  image?: ShotRef;
  alteracao?: Alteracao;
  diff?: DiffData | null;
}

/** Retorno de runTool: `text` é o que o modelo vê; o resto é da UI. */
interface ToolOutput extends ToolExtras {
  text: string;
}

/** Números da geração mostrados abaixo da resposta (tokens/s, tempo até o 1º token). */
interface MessageStats {
  /** Tokens por segundo da geração. */
  tps: number;
  completion: number;
  prompt: number;
  total: number;
  totalSec: number;
  /** Tempo até o primeiro token (TTFT). */
  ttftSec: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Opcional: resposta interrompida guarda só os tool_calls, sem conteúdo nenhum. */
  content?: any;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  attachments?: Attachment[];
  image?: ShotRef;
  alteracao?: Alteracao;
  stats?: MessageStats;
}

interface Chat {
  id: string;
  name: string;
  /** Pasta segura: o agente só enxerga daqui para dentro. */
  path: string;
  messages: ChatMessage[];
  /** Índice até onde o usuário já compactou à mão pelo botão do compositor. */
  podaManualAte?: number;
  /** Índice até onde a poda automática já encurtou. Memória: o que foi podado continua
   *  podado, para o prefixo da requisição não mudar a cada turno (ver compactToolResults). */
  podaAutoAte?: number;
}

interface UsageStats {
  prompt: number;
  completion: number;
  requests: number;
  history: unknown[];
  lastTotal: number;
}

interface AppState {
  chats: Record<string, Chat>;
  activeChatId: string | null;
  settings: Settings;
  recentPaths: string[];
  usage: UsageStats;
  /** n_ctx do modelo em uso; 0 enquanto o /v1/models não respondeu. */
  modelCtx: number;
}

/**
 * Registro de um comando em segundo plano no main. `exitCode` só aparece depois do
 * 'close', e é dele que o wait_for_process tira o "deu certo ou não".
 */
interface ProcEntry {
  command: string;
  child: import('child_process').ChildProcess;
  stdout: string;
  stderr: string;
  startedAt: number;
  ready: boolean;
  status: 'running' | 'exited' | 'error';
  exitCode?: number | null;
}

/** O que vai para o disco em userData/app-store.json. */
interface PersistedStore {
  chats?: Record<string, Chat>;
  activeChatId?: string | null;
  settings?: Partial<Settings>;
  recentPaths?: string[];
}

/**
 * Ponte exposta pelo preload. Os retornos ficam em `any` porque cada handler do main
 * devolve um formato próprio (arquivo, diff, saída de processo, resultado de busca) e
 * fixá-los aqui duplicaria as formas do main sem ninguém garantir que as duas cópias
 * andem juntas — o handler continua sendo a fonte da verdade.
 */
interface ElectronAPI {
  selectFolder(): Promise<string | null>;
  listFiles(dirPath: string): Promise<any>;
  listTree(rootPath: string): Promise<any>;
  readFile(filePath: string, opts?: any): Promise<any>;
  writeFile(filePath: string, content: string, opts?: any): Promise<any>;
  editFile(filePath: string, oldText: string, newText: string, replaceAll?: boolean): Promise<any>;
  searchFiles(rootPath: string, opts?: any): Promise<any>;
  createDirectory(dirPath: string): Promise<any>;
  deleteFile(filePath: string, opts?: any): Promise<any>;
  undoChange(snapshotId: string): Promise<any>;
  getDiff(snapshotId: string): Promise<any>;
  httpRequest(url: string, opts?: any): Promise<any>;
  capturePage(url: string, opts?: any): Promise<any>;
  readImage(filePath: string): Promise<any>;
  saveAttachmentImage(dataUrl: string, nome: string): Promise<any>;
  executeCommand(command: string, cwd: string, opts?: any): Promise<any>;
  readProcessOutput(pid: number): Promise<any>;
  waitForProcess(pid: number, timeoutMs?: number): Promise<any>;
  listProcesses(): Promise<any>;
  stopProcess(pid: number): Promise<any>;
  clearFinishedProcesses(): Promise<any>;
  getAppInfo(): Promise<{ githubUrl: string; version: string; name: string; author: string; license: string }>;
  checkUpdate(): Promise<any>;
  webSearch(query: string, maxResults?: number): Promise<any>;
  fetchUrl(url: string, maxChars?: number): Promise<any>;
  loadStore(): Promise<PersistedStore>;
  saveStore(data: PersistedStore): Promise<any>;
  setTitle(title: string): void;
}

// As libs do renderer são vendorizadas em vendor/ e entram por <script> global, não por
// import — por isso vivem no Window e não num módulo.
interface Window {
  electronAPI: ElectronAPI;
  marked: any;
  DOMPurify: any;
  hljs: any;
  /** Definida inline no index.html; chamada pelo onclick do olho da API key. */
  toggleApiKeyVisibility(): void;
}
