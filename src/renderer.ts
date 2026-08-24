// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofuserver Coder Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofuserver-Code

import { APP_NAME, ASSUMED_CTX_WHEN_UNKNOWN, CHARS_PER_TOKEN, CLIP_MIN_CHARS, DEFAULT_SETTINGS, CONTEXT_MARGIN_TOKENS, HISTORY_MIN_FRACTION, KEEP_RECENT_TOOL_RESULTS, MAX_LOOP_ITERATIONS, MAX_REQUEST_RETRIES, MAX_SEARCH_RESULT_CHARS, MAX_RECENT_PATHS, MAX_REASONING_DOM_CHARS, MAX_TOOL_RESULT_CHARS, MAX_VISION_IMAGES, READ_FILE_MAX_LINES, readCharBudget, REQUEST_RETRY_DELAY_MS, system_prompt, THINK_LEVELS } from "./constants.js";

// A UI é DOM imperativo puro: quase tudo é buscado por id e usado logo em seguida como
// campo (.value, .checked, .disabled). Tipar cada busca no ponto de uso daria uma centena
// de casts idênticos espalhados pelo arquivo, então o tipo devolvido é um HTMLElement com
// as propriedades de campo OPCIONAIS: `.value` num <div> continua sendo erro de quem
// escreveu, mas a conversão não começa com 90 erros iguais para apagar à mão.
type CampoUI = HTMLElement & Partial<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>;

/** getElementById com o tipo que o resto do arquivo espera. */
function el<T extends HTMLElement = CampoUI>(id: string): T {
  return document.getElementById(id) as T;
}

/** querySelector com o mesmo tratamento; `raiz` permite buscar dentro de um card. */
function q<T extends HTMLElement = CampoUI>(seletor: string, raiz: ParentNode = document): T {
  return raiz.querySelector(seletor) as T;
}

let state: AppState = {
  chats: {},          // { id: { id, name, path, messages: [] } }
  activeChatId: null,
  settings: { ...DEFAULT_SETTINGS },
  recentPaths: [], // pastas seguras usadas antes, para a troca rápida no cabeçalho
  usage: { prompt: 0, completion: 0, requests: 0, history: [], lastTotal: 0 },
  modelCtx: 0
};

let isRunning = false;
let stopRequested = false;   // usuário pediu para parar a geração
let abortController = null;   // aborta o fetch em streaming em andamento

function stopAgent() {
  stopRequested = true;
  if (pendingConfirm) resolveConfirm('reject'); // fecha o modal de confirmação, se aberto
  if (abortController) { try { abortController.abort(); } catch (e) { } }
}

// ---- Confirmação de execução (modo manual) ----
let pendingConfirm = null;
// O valor pode ser `true` (sempre confirma) ou um teste sobre os argumentos, para não
// pedir confirmação onde a chamada é inofensiva.
const CONFIRM_TOOLS = {
  execute_command: true,
  delete_file: true,
  // Sem isto, um DELETE/POST via http_request escaparia do modal que o mesmo comando
  // passando por `curl` no execute_command teria enfrentado. Leitura (GET) segue direto,
  // que é o caso comum ao validar uma API.
  http_request: (args) => !['GET', 'HEAD', 'OPTIONS'].includes(String(args.method || 'GET').toUpperCase())
};

function precisaConfirmar(name, args) {
  const regra = CONFIRM_TOOLS[name];
  return typeof regra === 'function' ? regra(args || {}) : !!regra;
}

// Retorna 'approve' | 'reject' (e pode alternar para 'auto' via "sempre permitir")
async function maybeConfirmTool(name, args) {
  if (stopRequested) return 'reject'; // usuário já pediu para parar
  if (!precisaConfirmar(name, args) || state.settings.execMode !== 'manual') return 'approve';
  const decision = await askExecConfirm(name, args);
  if (decision === 'always') {
    state.settings.execMode = 'auto';
    updateExecModeUI();
    persist();
    return 'approve';
  }
  return decision; // 'approve' | 'reject'
}

function askExecConfirm(name, args) {
  return new Promise((resolve) => {
    pendingConfirm = { resolve };
    showConfirmModal(name, args);
  });
}

function resolveConfirm(decision) {
  hideConfirmModal();
  if (pendingConfirm) {
    const done = pendingConfirm.resolve;
    pendingConfirm = null;
    done(decision);
  }
}

function showConfirmModal(name, args) {
  const modal = el('confirm-modal');
  const label = el('confirm-label');
  const cmd = el('confirm-command');
  if (name === 'execute_command') {
    label.innerText = 'Executar comando no terminal?';
    cmd.innerText = '$ ' + (args.command || '');
  } else if (name === 'delete_file') {
    label.innerText = 'Apagar arquivo?';
    cmd.innerText = '🗑 ' + (args.filename || '');
  } else if (name === 'http_request') {
    label.innerText = 'Enviar requisição que altera dados?';
    cmd.innerText = `${String(args.method || 'GET').toUpperCase()} ${args.url || ''}` +
      (args.body ? `\n\n${truncate(String(args.body), 400)}` : '');
  } else {
    label.innerText = 'Confirmar ação?';
    cmd.innerText = JSON.stringify(args);
  }
  modal.classList.add('active');
  const ok = el('confirm-approve');
  if (ok) ok.focus();
}

function hideConfirmModal() {
  const modal = el('confirm-modal');
  if (modal) modal.classList.remove('active');
}

function updateExecModeUI() {
  document.querySelectorAll<HTMLElement>('#exec-mode .exec-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.settings.execMode);
  });
}

// ---- Nível de raciocínio (no rodapé do compositor) ----
function nivelThinkAtual(): ThinkLevel {
  return THINK_LEVELS[state.settings.thinkLevel] ? state.settings.thinkLevel : 'padrao';
}

function updateThinkUI() {
  const chave = nivelThinkAtual();
  const btn = el('btn-think');
  if (!btn) return;
  const rotulo = q('#think-label', btn);
  if (rotulo) rotulo.innerText = THINK_LEVELS[chave].rotulo;
  btn.classList.toggle('custom', chave !== 'padrao');
  document.querySelectorAll<HTMLElement>('#think-menu .think-item').forEach(item => {
    item.classList.toggle('active', item.dataset.level === chave);
  });
}

// O menu sai do próprio THINK_LEVELS: uma lista fixa no HTML sairia de sincronia com as
// constantes assim que um nível novo entrasse (foi o que aconteceu com o <select> antigo).
function buildThinkMenu() {
  const menu = el('think-menu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const chave of Object.keys(THINK_LEVELS) as ThinkLevel[]) {
    const nivel = THINK_LEVELS[chave];
    const item = document.createElement('div');
    item.className = 'think-item';
    item.dataset.level = chave;
    const titulo = document.createElement('span');
    titulo.innerText = nivel.rotulo;
    item.appendChild(titulo);
    if (nivel.dica) {
      const dica = document.createElement('span');
      dica.className = 'think-item-hint';
      dica.innerText = nivel.dica;
      item.appendChild(dica);
    }
    item.addEventListener('click', () => {
      state.settings.thinkLevel = chave;
      // O legado `noThink` continua sendo lido no runAgent; deixá-lo true com nível
      // 'alto' escolhido mandaria /no_think junto e anularia a escolha.
      state.settings.noThink = chave === 'desligado';
      updateThinkUI();
      fechaThinkMenu();
      persist();
    });
    menu.appendChild(item);
  }
}

function fechaThinkMenu() {
  const menu = el('think-menu');
  if (menu) menu.hidden = true;
}

// ---- Painel de processos ativos (etapa 4) ----
let processList = [];
const procOutputTimers = {}; // pid -> intervalId dos "Ver saída" abertos

async function refreshProcesses() {
  try { processList = await window.electronAPI.listProcesses(); }
  catch (e) { processList = []; }
  const running = processList.filter(p => p.status === 'running').length;
  const badge = el('proc-badge');
  const btn = el('btn-processes');
  if (badge) { badge.innerText = String(running); badge.style.display = running > 0 ? 'flex' : 'none'; }
  if (btn) btn.classList.toggle('has-active', running > 0);
  const modal = el('processes-modal');
  if (modal && modal.classList.contains('active')) renderProcessList();
}

// Guarda as linhas já criadas por PID para reaproveitá-las (NÃO recriar a cada refresh,
// senão o <pre> de saída aberto é destruído e o polling perde o alvo — bug do "some").
const procRows = {}; // pid -> { row, dot, meta, out, viewBtn, stopBtn }

function buildProcRow(p) {
  const row = document.createElement('div');
  row.className = 'proc-row';

  const head = document.createElement('div');
  head.className = 'proc-head';
  const dot = document.createElement('span');
  const cmd = document.createElement('span');
  cmd.className = 'proc-cmd'; cmd.innerText = p.command; cmd.title = p.command;
  head.append(dot, cmd);

  const meta = document.createElement('div');
  meta.className = 'proc-meta';

  const out = document.createElement('pre');
  out.className = 'proc-output'; out.style.display = 'none';

  const actions = document.createElement('div');
  actions.className = 'proc-actions';
  const viewBtn = document.createElement('button');
  viewBtn.className = 'proc-btn'; viewBtn.innerText = 'Ver saída';
  viewBtn.addEventListener('click', () => toggleProcOutput(p.pid, out, viewBtn));
  const stopBtn = document.createElement('button');
  stopBtn.className = 'proc-btn danger'; stopBtn.innerText = 'Parar';
  stopBtn.addEventListener('click', () => stopProc(p.pid));
  actions.append(viewBtn, stopBtn);

  row.append(head, meta, actions, out);
  return { row, dot, meta, out, viewBtn, stopBtn };
}

function renderProcessList() {
  const container = el('proc-list');
  if (!container) return;

  if (!processList.length) {
    container.innerHTML = '';
    for (const k in procRows) delete procRows[k];
    const empty = document.createElement('div');
    empty.className = 'proc-empty';
    empty.innerText = 'Nenhum processo foi iniciado nesta sessão.';
    container.appendChild(empty);
    return;
  }
  const placeholder = container.querySelector('.proc-empty');
  if (placeholder) placeholder.remove();

  const seen = new Set();
  const sorted = [...processList].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1));
  for (const p of sorted) {
    seen.add(String(p.pid));
    let r = procRows[p.pid];
    if (!r) { r = buildProcRow(p); procRows[p.pid] = r; }
    // atualiza no lugar (sem destruir o <pre> de saída que possa estar aberto)
    r.dot.className = 'proc-status ' + (p.status === 'running' ? 'running' : p.status === 'stopped' ? 'stopped' : 'exited');
    r.meta.innerText = `PID ${p.pid} · ${p.status} · ${p.uptimeSec}s`;
    r.stopBtn.disabled = p.status !== 'running';
    container.appendChild(r.row); // (re)posiciona mantendo running primeiro
  }
  // remove as linhas cujos processos sumiram do registro
  for (const pid in procRows) {
    if (!seen.has(pid)) {
      if (procOutputTimers[pid]) { clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid]; }
      procRows[pid].row.remove();
      delete procRows[pid];
    }
  }
}

async function toggleProcOutput(pid, outEl, btn) {
  if (procOutputTimers[pid]) { // já aberto → fecha
    clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid];
    outEl.style.display = 'none'; btn.innerText = 'Ver saída';
    return;
  }
  outEl.style.display = 'block'; btn.innerText = 'Ocultar saída';
  const poll = async () => {
    const res = await window.electronAPI.readProcessOutput(pid);
    if (res && res.success) {
      const txt = [(res.stdout || ''), (res.stderr || '')].filter(x => x.trim()).join('\n');
      const atBottom = outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 30;
      outEl.innerText = txt || '(sem saída ainda)';
      if (atBottom) outEl.scrollTop = outEl.scrollHeight;
    } else {
      outEl.innerText = (res && res.error) || 'processo não encontrado';
    }
  };
  await poll();
  procOutputTimers[pid] = setInterval(poll, 1000); // acompanha a saída em tempo real
}

async function stopProc(pid) {
  if (procOutputTimers[pid]) { clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid]; }
  await window.electronAPI.stopProcess(pid);
  await refreshProcesses();
}

function openProcessesModal() {
  el('processes-modal').classList.add('active');
  refreshProcesses();
}

function closeProcessesModal() {
  el('processes-modal').classList.remove('active');
  for (const pid in procOutputTimers) { clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid]; }
}

// "Grudar no fim": só acompanha o final se o usuário já estiver perto do fim.
// Se ele rolar para cima (para ler), paramos de puxar — mesmo durante o streaming.
let stickToBottom = true;
function scrollChat() {
  if (!stickToBottom) return;
  const cb = el('chat-box');
  cb.scrollTop = cb.scrollHeight;
}
// Força ir ao fim e reativa o acompanhamento (ex.: ao enviar mensagem ou trocar de chat)
function forceScrollBottom() {
  stickToBottom = true;
  const cb = el('chat-box');
  if (cb) cb.scrollTop = cb.scrollHeight;
}

// Imagem entra no DOM com altura ZERO e só empurra o conteúdo quando termina de carregar
// — depois do scrollChat() que rodou ao inseri-la. Sem reagir ao load, o acompanhamento
// do fim fica preso na imagem e não segue mais a conversa.
function seguirAposCarregarImagens(raiz) {
  if (!raiz) return;
  for (const img of raiz.querySelectorAll('img')) {
    if (img.dataset.rolagemLigada) continue;
    img.dataset.rolagemLigada = '1';
    if (img.complete) continue; // já carregada: o layout não vai mais mudar
    img.addEventListener('load', scrollChat, { once: true });
    img.addEventListener('error', scrollChat, { once: true });
  }
}

// Atualiza o título da janela: "Pofuserver Coder Studio — <status>" (ou só o nome quando ocioso)
let ultimoTitulo = '';
function setAppTitle(status) {
  const title = status ? `${APP_NAME} — ${status}` : APP_NAME;
  // O streaming chama isto a CADA token. Sem esta guarda, cada token virava um send de
  // IPC e uma chamada nativa win.setTitle no processo main — dezenas de milhares delas
  // num raciocínio longo, enfileiradas mais rápido do que o main conseguia drenar.
  if (title === ultimoTitulo) return;
  ultimoTitulo = title;
  document.title = title;
  if (window.electronAPI && window.electronAPI.setTitle) window.electronAPI.setTitle(title);
}

// --------------------------------------------------------------------------
//  Persistência (via IPC para o diretório de dados do usuário)
// --------------------------------------------------------------------------
async function persist() {
  await window.electronAPI.saveStore({
    chats: state.chats,
    activeChatId: state.activeChatId,
    settings: state.settings,
    recentPaths: state.recentPaths
  });
}

// O controle de raciocínio era um liga/desliga (noThink) e virou um nível. Quem já tinha
// desligado precisa continuar desligado depois de atualizar, senão o modelo volta a
// pensar sozinho e o usuário não faz ideia do porquê.
function migraSettings(salvas) {
  const s = { ...DEFAULT_SETTINGS, ...(salvas || {}) };
  if (salvas && salvas.thinkLevel === undefined && salvas.noThink) s.thinkLevel = 'desligado';
  return s;
}

async function loadPersisted() {
  const data = await window.electronAPI.loadStore();
  state.recentPaths = Array.isArray(data && data.recentPaths) ? data.recentPaths : [];
  if (data && data.chats && Object.keys(data.chats).length > 0) {
    state.chats = data.chats;
    state.activeChatId = data.activeChatId && data.chats[data.activeChatId]
      ? data.activeChatId
      : Object.keys(data.chats)[0];
    state.settings = migraSettings(data.settings);
    // Store antigo não tem recentPaths: semeia com as pastas que os chats já usam, senão
    // o menu de troca rápida nasceria vazio para quem já tem projetos abertos.
    if (!state.recentPaths.length) {
      for (const chat of Object.values(state.chats)) {
        if (chat.path && !state.recentPaths.includes(chat.path)) state.recentPaths.push(chat.path);
      }
      state.recentPaths = state.recentPaths.slice(0, MAX_RECENT_PATHS);
    }
  } else {
    state.settings = migraSettings(data && data.settings);
    createChat('Chat Inicial');
  }
}

// --------------------------------------------------------------------------
//  Gerenciamento de Chats
// --------------------------------------------------------------------------
function createChat(name) {
  const id = 'chat_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  state.chats[id] = { id, name: name || 'Novo Chat', path: '', messages: [] };
  state.activeChatId = id;
  return id;
}

function activeChat() {
  return state.chats[state.activeChatId];
}

function renderChatList() {
  const container = el('chat-list-container');
  container.innerHTML = '';

  Object.keys(state.chats).forEach(id => {
    const chat = state.chats[id];
    const item = document.createElement('div');
    item.className = `chat-item ${id === state.activeChatId ? 'active' : ''}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.innerText = chat.name;
    nameSpan.title = 'Duplo clique para renomear';
    nameSpan.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRenameChat(id, nameSpan); });
    item.appendChild(nameSpan);

    const actions = document.createElement('div');
    actions.className = 'chat-item-actions';

    const rename = document.createElement('button');
    rename.className = 'chat-action';
    rename.title = 'Renomear chat';
    rename.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    rename.addEventListener('click', (e) => { e.stopPropagation(); beginRenameChat(id, nameSpan); });
    actions.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'chat-action chat-delete';
    del.title = 'Apagar chat';
    del.innerText = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(id);
    });
    actions.appendChild(del);
    item.appendChild(actions);

    item.addEventListener('click', () => switchChat(id));
    container.appendChild(item);
  });
}

// Renomeia um chat com edição inline no próprio item da lista
function beginRenameChat(id, nameSpan) {
  const chat = state.chats[id];
  if (!chat) return;
  const input = document.createElement('input');
  input.className = 'chat-rename-input';
  input.value = chat.name;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) { chat.name = v; persist(); }
    }
    renderChatList();
    if (id === state.activeChatId) el('active-chat-title').innerText = state.chats[id].name;
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Renomeia o chat ativo pelo título do cabeçalho (duplo clique)
function renameActiveChat() {
  const titleEl = el('active-chat-title');
  const chat = activeChat();
  if (!chat || titleEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'chat-rename-input header-rename';
  input.value = chat.name;
  titleEl.innerHTML = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) { const v = input.value.trim(); if (v) { chat.name = v; persist(); } }
    titleEl.innerText = chat.name;
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

function switchChat(id) {
  if (!state.chats[id]) return;
  state.activeChatId = id;
  arquivosLidos = new Set(); // o que foi lido vale por conversa
  ultimaPoda = 0;
  avisouPoda = false;
  renderChatList();
  renderActiveChat();
  persist();
}

function deleteChat(id) {
  delete state.chats[id];
  if (state.activeChatId === id) {
    const remaining = Object.keys(state.chats);
    if (remaining.length === 0) createChat('Chat Inicial');
    else state.activeChatId = remaining[0];
  }
  renderChatList();
  renderActiveChat();
  persist();
}

// Reconstrói a visualização do chat ativo a partir do histórico real de mensagens
function renderActiveChat() {
  const chat = activeChat();
  el('active-chat-title').innerText = chat.name;
  mostraCaminhoAtivo(chat.path);

  const chatBox = el('chat-box');
  chatBox.innerHTML = '';
  stickToBottom = true; // ao (re)carregar/trocar de chat, começa acompanhando o fim

  // Indexa os resultados de ferramenta por tool_call_id para parear com suas chamadas
  const toolResults = {};
  for (const m of chat.messages) {
    if (m.role === 'tool' && m.tool_call_id) toolResults[m.tool_call_id] = m;
  }

  for (let i = 0; i < chat.messages.length; i++) {
    const msg = chat.messages[i];
    if (msg.role === 'user') {
      renderUserMessage(msg.content, msg.attachments, i);
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        const div = appendMessage(msg.content, 'agent', i);
        if (msg.stats) renderMsgStats(div, msg.stats);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = (tc.function && tc.function.name) || 'ferramenta';
          let args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { args = {}; }
          const tr = tc.id != null ? toolResults[tc.id] : undefined;
          renderToolInvocation(name, args, tr ? tr.content : null,
            tr ? { image: tr.image, alteracao: tr.alteracao } : undefined);
        }
      }
    }
    // mensagens 'tool' são renderizadas junto com sua chamada (acima) — nada a fazer aqui
  }

  updateInputState();
  atualizarBotaoCompactar();
}

const SEND_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function updateInputState() {
  const hasPath = !!(activeChat() && activeChat().path);
  const input = el('user-input');
  const btn = el('btn-send');
  const attach = el('btn-attach');
  input.disabled = !hasPath || isRunning;
  if (attach) attach.disabled = !hasPath || isRunning;
  document.body.classList.toggle('agent-running', isRunning);

  // Enquanto roda, o botão de enviar vira botão de PARAR (sempre clicável)
  if (isRunning) {
    btn.disabled = false;
    btn.classList.add('is-stop');
    btn.title = 'Parar geração';
    btn.innerHTML = STOP_SVG;
  } else {
    btn.disabled = !hasPath;
    btn.classList.remove('is-stop');
    btn.title = 'Enviar mensagem';
    btn.innerHTML = SEND_SVG;
  }

  input.placeholder = hasPath
    ? 'Peça algo, anexe arquivos (📎 ou arraste) ou peça para rodar um comando…'
    : 'Selecione uma pasta de trabalho para este chat (ícone acima) →';
}

// --------------------------------------------------------------------------
//  Renderização de mensagens
// --------------------------------------------------------------------------
// Configura o marked uma vez (se disponível)
if (window.marked && window.marked.setOptions) {
  window.marked.setOptions({ gfm: true, breaks: true });
}

// Renderiza markdown com sanitização e realce de código dentro de um container
function renderMarkdownInto(container, text) {
  const hasLibs = window.marked && window.DOMPurify;
  if (!hasLibs) {
    container.innerText = text; // fallback seguro
    return;
  }
  const rawHtml = window.marked.parse(text);
  container.innerHTML = window.DOMPurify.sanitize(rawHtml);

  // Todo link do Markdown deve abrir no navegador padrão do sistema, nunca dentro do app.
  // target="_blank" faz o clique passar pelo setWindowOpenHandler do main.js (que abre
  // externamente e nega a navegação interna).
  container.querySelectorAll('a[href]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });

  seguirAposCarregarImagens(container); // imagem no Markdown da resposta também empurra o conteúdo

  // Realça e decora cada bloco de código
  container.querySelectorAll('pre > code').forEach(codeEl => {
    if (window.hljs) {
      try { window.hljs.highlightElement(codeEl); } catch (e) { /* ignora */ }
    }
    const pre = codeEl.parentElement;
    const lang = (codeEl.className.match(/language-(\w+)/) || [])[1]
      || (codeEl.className.match(/\blang-(\w+)/) || [])[1]
      || (window.hljs && codeEl.result && codeEl.result.language)
      || 'código';

    // Envolve em .code-block com cabeçalho e botão de copiar
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    const langSpan = document.createElement('span');
    langSpan.innerText = lang;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.innerText = 'Copiar';
    copyBtn.addEventListener('click', () => {
      const done = () => {
        copyBtn.innerText = 'Copiado!';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.innerText = 'Copiar'; copyBtn.classList.remove('copied'); }, 1500);
      };
      const text = codeEl.innerText;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    });
    header.appendChild(langSpan);
    header.appendChild(copyBtn);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
}

function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); onDone && onDone(); } catch (e) { /* ignora */ }
  document.body.removeChild(ta);
}

function appendMessage(text, sender, index) {
  const chatBox = el('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${sender}`;
  if (sender === 'agent') {
    const body = document.createElement('div');
    body.className = 'md-body';
    renderMarkdownInto(body, text);
    msgDiv.appendChild(body);
    attachMsgAction(msgDiv, 'regenerate', index);
  } else {
    msgDiv.innerText = text; // mensagens do usuário sempre como texto puro
  }
  chatBox.appendChild(msgDiv);
  scrollChat();
  return msgDiv;
}

// Bolha do usuário, com chips de anexos (usada ao vivo e no reload do histórico)
function renderUserMessage(text, attachments, index) {
  const chatBox = el('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message user';
  if (attachments && attachments.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-attachments';
    attachments.forEach(a => {
      const chip = document.createElement('span');
      chip.className = 'msg-attach-chip';
      chip.innerText = `${a.mention ? '@' : (a.binary ? '🗎' : '📄')} ${a.name}`;
      chip.title = a.name;
      wrap.appendChild(chip);
    });
    msgDiv.appendChild(wrap);
  }
  if (text) {
    const t = document.createElement('div');
    t.innerText = text;
    msgDiv.appendChild(t);
  }
  attachMsgAction(msgDiv, 'edit', index);
  chatBox.appendChild(msgDiv);
  scrollChat();
}

// Barra de ações da mensagem (aparece no hover): editar (usuário) / regenerar (agente)
function attachMsgAction(msgDiv, kind, index) {
  if (index == null) return;
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const btn = document.createElement('button');
  btn.className = 'msg-action-btn';
  if (kind === 'edit') {
    btn.title = 'Editar e reenviar (descarta as respostas seguintes)';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Editar</span>';
    btn.addEventListener('click', () => editUserMessage(index));
  } else {
    btn.title = 'Regenerar resposta';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>Regenerar</span>';
    btn.addEventListener('click', () => regenerateFromAssistant(index));
  }
  bar.appendChild(btn);
  msgDiv.appendChild(bar);
}

// Reenvia a partir de uma mensagem do usuário: coloca no composer e trunca o histórico
function editUserMessage(index) {
  if (isRunning) return;
  const chat = activeChat();
  const msg = chat.messages[index];
  if (!msg || msg.role !== 'user') return;
  const input = el('user-input');
  input.value = msg.content || '';
  pendingAttachments = (msg.attachments || []).map(a => ({ ...a }));
  renderAttachments();
  chat.messages = chat.messages.slice(0, index); // remove esta solicitação e tudo depois
  renderActiveChat();
  persist();
  input.focus();
  input.dispatchEvent(new Event('input')); // recalcula a altura do textarea
}

// Regenera a resposta: descarta do 'assistant' clicado em diante e roda de novo
function regenerateFromAssistant(index) {
  if (isRunning) return;
  const chat = activeChat();
  let userIdx = -1;
  for (let i = Math.min(index, chat.messages.length) - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') { userIdx = i; break; }
  }
  if (userIdx === -1) return;
  chat.messages = chat.messages.slice(0, userIdx + 1); // mantém até a solicitação do usuário
  renderActiveChat();
  runAgent();
}

function appendInfo(text) {
  const chatBox = el('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = "info";
  msgDiv.innerText = text;
  chatBox.appendChild(msgDiv);
  scrollChat();
}

function logSystem(text) {
  const chatBox = el('chat-box');
  const logDiv = document.createElement('div');
  logDiv.className = 'system-log';
  logDiv.innerText = `[SISTEMA]: ${text}`;
  chatBox.appendChild(logDiv);
  scrollChat();
}

function appendToolLog(text) {
  const chatBox = el('chat-box');
  const div = document.createElement('div');
  div.className = 'tool-log';
  div.innerText = text;
  chatBox.appendChild(div);
  scrollChat();
}

// ---- Cards de ferramenta (exibição amigável, sem JSON cru) ----
const TOOL_META = {
  list_files: { icon: '📁', label: 'Listar arquivos' },
  read_file: { icon: '📄', label: 'Ler arquivo' },
  write_file: { icon: '✏️', label: 'Escrever arquivo' },
  edit_file: { icon: '🖊️', label: 'Editar arquivo' },
  search_files: { icon: '🔍', label: 'Buscar no projeto' },
  create_directory: { icon: '📂', label: 'Criar pasta' },
  delete_file: { icon: '🗑️', label: 'Apagar arquivo' },
  http_request: { icon: '🔌', label: 'Requisição HTTP' },
  capture_page: { icon: '📸', label: 'Print da página' },
  execute_command: { icon: '⌘', label: 'Terminal' },
  read_process_output: { icon: '📜', label: 'Saída do processo' },
  wait_for_process: { icon: '⏳', label: 'Aguardar processo' },
  list_processes: { icon: '📋', label: 'Processos' },
  stop_process: { icon: '⛔', label: 'Parar processo' },
  web_search: { icon: '🔎', label: 'Buscar na web' },
  fetch_url: { icon: '🌐', label: 'Ler página' }
};

// Resumo legível dos argumentos da chamada
function summarizeToolCall(name, args) {
  args = args || {};
  switch (name) {
    case 'execute_command': return '$ ' + (args.command || '');
    case 'read_file':
      return (args.filename || '') + (args.offset > 1 ? ` (a partir da linha ${args.offset})` : '');
    case 'write_file':
    case 'delete_file': return args.filename || '';
    case 'edit_file': {
      // Mostra o trecho trocado, não o arquivo inteiro — é o que o usuário precisa
      // conferir para saber se a edição foi a esperada.
      const corte = (s) => {
        const t = String(s ?? '');
        const linhas = t.split('\n');
        return linhas.length > 6 ? linhas.slice(0, 6).join('\n') + '\n…' : t;
      };
      const alvo = (args.filename || '') + (args.replace_all ? '  (todas as ocorrências)' : '');
      if (!args.old_text) return alvo;
      return `${alvo}\n\n− ${corte(args.old_text).replace(/\n/g, '\n− ')}\n+ ${corte(args.new_text).replace(/\n/g, '\n+ ')}`;
    }
    case 'search_files':
      return (args.query || '') + (args.file_pattern ? `   em ${args.file_pattern}` : '');
    case 'http_request': return `${(args.method || 'GET').toUpperCase()} ${args.url || ''}`;
    case 'capture_page': return (args.url || '') +
      (args.crop_selector ? `   recorte: ${args.crop_selector}` : '') +
      (args.full_page ? '   (página inteira)' : '') +
      (args.selector ? `   aguardando ${args.selector}` : '');
    case 'create_directory': return (args.dirname || '') + '/';
    case 'list_files': return args.subpath ? args.subpath + '/' : './';
    case 'read_process_output':
    case 'wait_for_process':
    case 'stop_process': return 'PID ' + (args.pid ?? '?');
    case 'list_processes': return '';
    case 'web_search': return '🔎 ' + (args.query || '');
    case 'fetch_url': return args.url || '';
    default: {
      const keys = Object.keys(args);
      return keys.map(k => `${k}: ${String(args[k]).slice(0, 60)}`).join('  ');
    }
  }
}

// Resumo legível do resultado (a maioria vem como JSON string)
function summarizeToolResult(name, resultStr) {
  if (resultStr == null) return '';
  if (name === 'read_file') {
    // Falha de leitura vem como JSON; sem isto ela seria contada como "1 linha lida"
    if (resultStr.startsWith('{')) {
      try {
        const erro = JSON.parse(resultStr);
        if (erro && erro.error) return `⚠ ${erro.error}`;
      } catch (e) { /* não era JSON: segue como conteúdo do arquivo */ }
    }
    const m = resultStr.match(/^\[Arquivo ".*?" — linhas (\d+)–(\d+) de (\d+)\]/);
    if (m) {
      const restam = Number(m[3]) - Number(m[2]);
      return restam > 0
        ? `✓ linhas ${m[1]}–${m[2]} de ${m[3]} (restam ${restam})`
        : `✓ linhas ${m[1]}–${m[2]} de ${m[3]}`;
    }
    const lines = resultStr.split('\n').length;
    return `✓ ${lines} linha(s) lidas`;
  }
  let data;
  try { data = JSON.parse(resultStr); } catch { return resultStr; }
  // A dica ("hint") diz o que fazer a seguir (releia o arquivo, suba o servidor…) —
  // é a parte mais útil do erro e não pode ficar de fora do card.
  if (data && data.error) return `⚠ ${data.error}${data.hint ? '\n' + data.hint : ''}`;

  switch (name) {
    case 'execute_command': {
      if (data.backgrounded) {
        const head = `▸ rodando em segundo plano · PID ${data.pid} (${data.reason || 'contínuo'})`;
        const out = (data.stdout || '').trim();
        return out ? `${head}\n${out}` : head;
      }
      const parts = [];
      if (data.stdout && data.stdout.trim()) parts.push(data.stdout.trim());
      if (data.stderr && data.stderr.trim()) parts.push(data.stderr.trim());
      let body = parts.join('\n').trim() || '(sem saída)';
      if (data.exitCode) body += `\n[código de saída: ${data.exitCode}]`;
      return body;
    }
    case 'list_files':
      return Array.isArray(data)
        ? (data.map(f => (f.isDirectory ? '📁 ' : '📄 ') + f.name + (f.size != null ? `  (${fmtSize(f.size)})` : '')).join('\n') || '(pasta vazia)')
        : resultStr;
    case 'write_file': {
      if (!data.success) return data.error || resultStr;
      const cabec = data.created ? `✓ Arquivo criado · ${data.lines} linha(s)` : `✓ Arquivo salvo · ${data.lines} linha(s)`;
      return data.aviso ? `${cabec}\n⚠ ${data.aviso}` : cabec;
    }
    case 'edit_file': {
      if (!data.success) return `⚠ ${data.error}${data.hint ? '\n' + data.hint : ''}`;
      const onde = data.replacements > 1 ? `${data.replacements} ocorrências` : `linha ${data.line}`;
      // Só mostra o saldo quando os dois contadores vieram: sem a guarda, um campo
      // ausente vira "(NaN linha)" na tela.
      const temContagem = Number.isFinite(data.linesAfter) && Number.isFinite(data.linesBefore);
      const delta = temContagem ? data.linesAfter - data.linesBefore : 0;
      const saldo = delta === 0 ? '' : `  (${delta > 0 ? '+' : ''}${delta} linha${Math.abs(delta) > 1 ? 's' : ''})`;
      return `✓ Editado · ${onde}${saldo}`;
    }
    case 'search_files': {
      if (!data.success) return `⚠ ${data.error}`;
      if (!data.count) return '(nenhuma ocorrência)';
      const linhas = data.matches.map(m => `${m.file}:${m.line}  ${m.text.trim()}`);
      return linhas.join('\n') + (data.truncated ? `\n… (limite de ${data.count} resultados atingido)` : `\n\n${data.count} ocorrência(s)`);
    }
    case 'http_request': {
      if (!data.success) return `⚠ ${data.error}${data.hint ? '\n' + data.hint : ''}`;
      const ct = (data.headers && data.headers['content-type']) || '';
      return `${data.status} ${data.statusText || ''} · ${data.ms}ms${ct ? ' · ' + ct.split(';')[0] : ''}\n\n${data.body || '(corpo vazio)'}`;
    }
    case 'capture_page': {
      if (data.error) return `⚠ ${data.error}${data.hint ? '\n' + data.hint : ''}`;
      const partes = [`${data.titulo || '(sem título)'} · HTTP ${data.status ?? '?'} · ${data.tamanho || ''}`];
      if (data.seletor_encontrado === false) partes.push('⚠ seletor não apareceu');
      if (data.erro_no_script) partes.push(`⚠ erro no script: ${data.erro_no_script}`);
      if (data.resultado_do_script !== undefined) partes.push(`script → ${data.resultado_do_script}`);
      if (data.erros_de_console && data.erros_de_console.length) {
        partes.push('Erros de console:\n' + data.erros_de_console.map(e => '  ' + e).join('\n'));
      }
      if (data.falhas_de_rede && data.falhas_de_rede.length) {
        partes.push('Falhas de rede:\n' + data.falhas_de_rede.map(e => `  ${e.error} — ${e.url}`).join('\n'));
      }
      return partes.join('\n');
    }
    case 'create_directory': return data.success ? '✓ Pasta criada' : (data.error || resultStr);
    case 'delete_file': return data.success ? '✓ Arquivo apagado' : (data.error || resultStr);
    case 'stop_process': return data.success ? `✓ Processo ${data.pid} encerrado` : (data.error || resultStr);
    case 'web_search': {
      if (!data.success) return `⚠ ${data.error || 'falha na busca'}`;
      if (!data.results || !data.results.length) return '(nenhum resultado)';
      const paginas = data.paginas || [];
      const cabec = `via ${data.source} · ${data.count} resultado(s)` +
        (paginas.length ? ` · ${paginas.length} página(s) lida(s)` : '') +
        (data.reformulada ? `\nconsulta refeita: "${data.reformulada}" → "${data.query}"` : '');
      const lista = data.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
      // O texto extraído das páginas é longo; na tela vai só o começo, mas o modelo
      // recebe tudo (o corte aqui é apresentação, não conteúdo).
      const trechos = paginas.map(p => `📄 ${p.url}\n${(p.text || '').slice(0, 400)}…`).join('\n\n');
      return [cabec, lista, trechos].filter(Boolean).join('\n\n');
    }
    case 'fetch_url':
      if (!data.success) return `⚠ ${data.error || 'falha ao baixar'}`;
      return `[${data.status}] ${data.url}\n\n${(data.content || '').slice(0, 1000)}${(data.content || '').length > 1000 ? '…' : ''}`;
    case 'list_processes':
      return Array.isArray(data)
        ? (data.length ? data.map(p => `PID ${p.pid} · ${p.status} · ${p.uptimeSec}s · ${p.command}`).join('\n') : '(nenhum processo em segundo plano)')
        : resultStr;
    case 'read_process_output': {
      if (!data.success) return data.error || resultStr;
      const head = `PID ${data.pid} · ${data.status} · ${data.uptimeSec}s`;
      const out = [data.stdout, data.stderr].filter(x => x && x.trim()).join('\n').trim();
      return out ? `${head}\n${out}` : head;
    }
    case 'wait_for_process': {
      if (!data.success) return data.error || resultStr;
      const head = data.finished
        ? `✓ terminou em ~${data.waitedSec}s${data.exitCode != null ? ` · código ${data.exitCode}` : ''}`
        : `▸ ainda rodando após ${data.waitedSec}s`;
      const out = [data.stdout, data.stderr].filter(x => x && x.trim()).join('\n').trim();
      return out ? `${head}\n${out}` : head;
    }
    default: return resultStr;
  }
}

// Cria o card da chamada (cabeçalho + argumento). Retorna o elemento para preencher o resultado depois.
function appendToolCall(name, args) {
  const meta = TOOL_META[name] || { icon: '🔧', label: name };
  const chatBox = el('chat-box');
  const card = document.createElement('div');
  card.className = 'tool-card';

  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = `<span class="tool-icon"></span><span class="tool-title"></span>`;
  q('.tool-icon', head).innerText = meta.icon;
  q('.tool-title', head).innerText = meta.label;
  card.appendChild(head);

  const argText = summarizeToolCall(name, args);
  if (argText) {
    const arg = document.createElement('pre');
    arg.className = 'tool-arg';
    arg.innerText = argText;
    card.appendChild(arg);
  }

  chatBox.appendChild(card);
  scrollChat();
  return card;
}

// Preenche (ou atualiza) o resultado dentro do card da chamada
function fillToolResult(card, name, resultStr, extras: ToolExtras = {}) {
  if (!card) return;
  let res = q<HTMLElement>('.tool-result', card);
  if (!res) {
    res = document.createElement('pre');
    res.className = 'tool-result';
    card.appendChild(res);
  }
  const text = summarizeToolResult(name, resultStr);
  res.innerText = truncate(text, 1200);
  res.classList.toggle('is-error', /^⚠/.test(text));
  if (extras.image && extras.image.path) attachToolShot(card, extras.image);
  if (extras.alteracao) attachDiff(card, extras.alteracao, extras.diff);
  scrollChat();
}

// --------------------------------------------------------------------------
//  Diff visível + desfazer
// --------------------------------------------------------------------------
// Mostra o que mudou e dá o botão de reverter. O diff carrega sob demanda: num chat
// recarregado só existe o snapshotId, e o antes/depois vem do instantâneo em disco.
function attachDiff(card, alteracao, diffPronto) {
  if (card.querySelector('.diff-box')) return;

  const box = document.createElement('div');
  box.className = 'diff-box';

  const barra = document.createElement('div');
  barra.className = 'diff-bar';

  const rotulo = document.createElement('span');
  rotulo.className = 'diff-file';
  rotulo.innerText = alteracao.apagado ? `🗑 ${alteracao.arquivo}` : alteracao.arquivo;

  const contagem = document.createElement('span');
  contagem.className = 'diff-counts';
  if (alteracao.apagado) {
    contagem.innerHTML = `<span class="diff-del-count">arquivo apagado (${alteracao.removidas} linhas)</span>`;
  } else {
    contagem.innerHTML =
      `<span class="diff-add-count">+${alteracao.adicionadas}</span>` +
      `<span class="diff-del-count">−${alteracao.removidas}</span>`;
  }

  const acoes = document.createElement('div');
  acoes.className = 'diff-actions';

  const btnVer = document.createElement('button');
  btnVer.className = 'diff-btn';
  btnVer.innerText = alteracao.apagado ? 'Ver conteúdo apagado' : 'Ver diferenças';

  const btnDesfazer = document.createElement('button');
  btnDesfazer.className = 'diff-btn diff-btn-undo';
  btnDesfazer.innerText = 'Desfazer';

  acoes.append(btnVer, btnDesfazer);
  barra.append(rotulo, contagem, acoes);
  box.appendChild(barra);

  const corpo = document.createElement('div');
  corpo.className = 'diff-body';
  corpo.hidden = true;
  box.appendChild(corpo);

  let carregado = false;
  btnVer.addEventListener('click', async () => {
    if (!corpo.hidden) { corpo.hidden = true; btnVer.innerText = alteracao.apagado ? 'Ver conteúdo apagado' : 'Ver diferenças'; return; }
    if (!carregado) {
      const diff = diffPronto || await window.electronAPI.getDiff(alteracao.snapshotId);
      renderDiffLines(corpo, diff);
      carregado = true;
    }
    corpo.hidden = false;
    btnVer.innerText = 'Ocultar';
    scrollChat();
  });

  btnDesfazer.addEventListener('click', async () => {
    btnDesfazer.disabled = true;
    btnDesfazer.innerText = 'Desfazendo…';
    const r = await window.electronAPI.undoChange(alteracao.snapshotId);
    if (!r || !r.success) {
      btnDesfazer.disabled = false;
      btnDesfazer.innerText = 'Desfazer';
      marcaDiff(box, `⚠ ${(r && r.error) || 'não foi possível desfazer'}`, 'erro');
      return;
    }
    box.classList.add('desfeito');
    marcaDiff(box, alteracao.apagado ? '✓ arquivo restaurado' : '✓ alteração desfeita', 'ok');
    logSystem(`Alteração desfeita em ${alteracao.arquivo}. O agente não sabe disso — se ele continuar trabalhando, avise no chat.`);
    // O desfazer também vira um ponto de restauração, então dá para voltar atrás.
    btnDesfazer.disabled = false;
    btnDesfazer.innerText = 'Refazer';
    alteracao = { ...alteracao, snapshotId: r.refazerId };
  });

  card.appendChild(box);
}

function marcaDiff(box, texto, tipo) {
  let m = box.querySelector('.diff-status');
  if (!m) {
    m = document.createElement('div');
    m.className = 'diff-status';
    box.querySelector('.diff-bar').after(m);
  }
  m.innerText = texto;
  m.classList.toggle('is-error', tipo === 'erro');
}

// Desenha as linhas do diff com numeração das duas versões, como num revisor de código.
function renderDiffLines(corpo, diff) {
  corpo.innerHTML = '';
  if (!diff || !diff.linhas || !diff.linhas.length) {
    corpo.innerText = diff && diff.semMudanca ? '(conteúdo idêntico)' : '(não foi possível montar o diff)';
    return;
  }
  const tabela = document.createElement('div');
  tabela.className = 'diff-table';

  for (const l of diff.linhas) {
    const linha = document.createElement('div');
    if (l.tipo === 'pulo') {
      linha.className = 'diff-line diff-skip';
      linha.innerText = `⋯ ${l.quantas} linha(s) sem alteração`;
      tabela.appendChild(linha);
      continue;
    }
    linha.className = 'diff-line diff-' + l.tipo;
    const na = document.createElement('span');
    na.className = 'diff-num';
    na.innerText = l.a != null ? l.a : '';
    const nb = document.createElement('span');
    nb.className = 'diff-num';
    nb.innerText = l.b != null ? l.b : '';
    const sinal = document.createElement('span');
    sinal.className = 'diff-sign';
    sinal.innerText = l.tipo === 'add' ? '+' : l.tipo === 'del' ? '−' : ' ';
    const txt = document.createElement('span');
    txt.className = 'diff-text';
    txt.innerText = l.texto;
    linha.append(na, nb, sinal, txt);
    tabela.appendChild(linha);
  }
  corpo.appendChild(tabela);

  if (diff.cortado) {
    const aviso = document.createElement('div');
    aviso.className = 'diff-skip';
    aviso.innerText = `⋯ diff muito grande: mostrando as primeiras linhas de ${diff.totalLinhasDiff}`;
    corpo.appendChild(aviso);
  }
}

// Mostra o print dentro do card. Carrega por file:// (e não pelo base64 em memória)
// para que a imagem reapareça igual ao recarregar um chat antigo.
function attachToolShot(card, image) {
  if (card.querySelector('.tool-shot')) return;
  const wrap = document.createElement('div');
  wrap.className = 'tool-shot';
  const img = document.createElement('img');
  img.src = 'file://' + image.path;
  img.alt = 'Print da página capturada pelo agente';
  img.title = 'Clique para abrir em tamanho real';
  img.loading = 'lazy';
  img.addEventListener('click', () => openImageViewer(img.src));
  img.addEventListener('error', () => { wrap.innerHTML = ''; wrap.className = 'tool-shot-faltando'; wrap.innerText = '(print não está mais disponível)'; });
  wrap.appendChild(img);
  card.appendChild(wrap);
  seguirAposCarregarImagens(wrap); // o print só ganha altura ao carregar
}

// Visualizador em tela cheia do print (fecha no clique ou no Esc)
function openImageViewer(src) {
  const overlay = document.createElement('div');
  overlay.className = 'shot-viewer';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  const fechar = () => { overlay.remove(); document.removeEventListener('keydown', aoTeclar); };
  const aoTeclar = (e) => { if (e.key === 'Escape') fechar(); };
  overlay.addEventListener('click', fechar);
  document.addEventListener('keydown', aoTeclar);
  document.body.appendChild(overlay);
}

// Card completo (chamada + resultado) — usado ao recarregar o histórico
function renderToolInvocation(name, args, resultStr, extras) {
  const card = appendToolCall(name, args);
  if (resultStr != null) fillToolResult(card, name, resultStr, extras);
  return card;
}

function appendReasoning(text) {
  const chatBox = el('chat-box');
  const details = document.createElement('details');
  details.className = 'reasoning';
  const summary = document.createElement('summary');
  summary.innerText = 'Raciocínio do modelo';
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  body.innerText = text;
  details.appendChild(summary);
  details.appendChild(body);
  chatBox.appendChild(details);
  scrollChat();
}

function appendError(text) {
  const chatBox = el('chat-box');
  const div = document.createElement('div');
  div.className = 'error-msg';
  div.innerText = `⚠ ${text}`;
  chatBox.appendChild(div);
  scrollChat();
}

// Erro com causa provável e passos para resolver, em vez de uma linha de exceção crua.
function appendErrorCard({ titulo, detalhe, passos }) {
  const chatBox = el('chat-box');
  const card = document.createElement('div');
  card.className = 'error-card';

  const h = document.createElement('div');
  h.className = 'error-card-title';
  h.innerText = `⚠ ${titulo}`;
  card.appendChild(h);

  if (detalhe) {
    const d = document.createElement('div');
    d.className = 'error-card-detail';
    d.innerText = detalhe;
    card.appendChild(d);
  }
  if (passos && passos.length) {
    const ul = document.createElement('ul');
    ul.className = 'error-card-steps';
    for (const p of passos) {
      const li = document.createElement('li');
      li.innerText = p;
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }
  chatBox.appendChild(card);
  scrollChat();
}

function showTyping() {
  const chatBox = el('chat-box');
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  chatBox.appendChild(div);
  scrollChat();
}

function hideTyping() {
  const indicador = el('typing-indicator');
  if (indicador) indicador.remove();
}

function truncate(str, max) {
  if (typeof str !== 'string') str = String(str);
  return str.length > max ? str.slice(0, max) + `\n… (truncado, ${str.length} caracteres)` : str;
}

// Formata para o modelo a janela de linhas que o processo main já recortou. O recorte
// acontece lá (só as linhas pedidas cruzam o IPC); aqui fica apenas a apresentação:
// cabeçalho com a faixa lida e rodapé dizendo como pedir a continuação.
function formatFileWindow(filename, res, budget) {
  if (!res || !res.success) return JSON.stringify({ error: (res && res.error) || 'falha ao ler o arquivo' });
  if (res.empty) return `Arquivo "${filename}" está vazio.`;

  let charNote = '';
  if (res.charClipped) {
    charNote = `\n\n[… conteúdo desta janela cortado em ${budget} caracteres (linhas muito longas)]`;
  }

  // Arquivo cabe inteiro na janela: volta direto, sem cabeçalho (o caso comum).
  if (res.start === 1 && res.end === res.total && !charNote) return res.content;

  const header = `[Arquivo "${filename}" — linhas ${res.start}–${res.end} de ${res.total}]`;
  let footer = charNote;
  if (res.end < res.total) {
    footer += `\n\n[… restam ${res.total - res.end} linha(s). Para continuar, chame read_file com offset=${res.end + 1}]`;
  }
  return `${header}\n${res.content}${footer}`;
}

// Recorta pelo MEIO preservando início e fim (o erro costuma estar no fim da saída)
function clipMiddle(str, max) {
  str = String(str || '');
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.35), tail = max - head;
  return str.slice(0, head) + `\n…[${str.length - max} caracteres omitidos]…\n` + str.slice(-tail);
}

// --------------------------------------------------------------------------
//  Definição das Ferramentas expostas ao modelo
// --------------------------------------------------------------------------
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista arquivos e pastas do diretório de trabalho (ou de uma subpasta).',
      parameters: {
        type: 'object',
        properties: {
          subpath: { type: 'string', description: 'Subpasta relativa opcional (padrão: raiz do workspace)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lê o conteúdo de um arquivo do workspace. A maioria dos arquivos volta INTEIRA; ' +
        'só os muito grandes são divididos em JANELAS de linhas. Se o resultado avisar que restam ' +
        'linhas, chame read_file de novo com "offset" na linha indicada para ler o restante — o ' +
        'arquivo NÃO é cortado silenciosamente. Antes de reescrever um arquivo grande, leia todas as partes.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Nome ou caminho relativo do arquivo' },
          offset: { type: 'number', description: 'Linha inicial da leitura (base 1). Padrão: 1.' },
          limit: { type: 'number', description: `Máximo de linhas a retornar nesta leitura (teto: ${READ_FILE_MAX_LINES}).` }
        },
        required: ['filename']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Cria um arquivo novo ou SOBRESCREVE por completo um existente. Para alterar ' +
        'parte de um arquivo que já existe use edit_file — reescrever tudo gasta muito mais tokens ' +
        'e a resposta pode ser cortada no meio, truncando o arquivo.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Nome do arquivo a ser salvo' },
          content: { type: 'string', description: 'Conteúdo completo a ser escrito no arquivo' }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Forma PADRÃO de alterar um arquivo existente: troca o trecho exato old_text por ' +
        'new_text, preservando o resto do arquivo. Leia o arquivo antes e copie old_text exatamente ' +
        'como está (mesma indentação), incluindo linhas de contexto suficientes para o trecho ser ' +
        'único. Falha sem alterar nada se o trecho não existir ou aparecer mais de uma vez.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Caminho relativo do arquivo a editar' },
          old_text: { type: 'string', description: 'Trecho exato que será substituído (copiado do arquivo)' },
          new_text: { type: 'string', description: 'Texto que entra no lugar (use string vazia para remover)' },
          replace_all: { type: 'boolean', description: 'Substituir todas as ocorrências em vez de exigir trecho único (padrão: false)' }
        },
        required: ['filename', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Procura um texto ou padrão dentro dos arquivos do workspace e devolve arquivo, ' +
        'linha e o conteúdo da linha. Use para localizar onde algo é definido ou usado — é muito mais ' +
        'barato que ler arquivos inteiros à procura. Ignora node_modules, dist, .git e binários.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto a procurar (ou expressão regular, se regex=true)' },
          regex: { type: 'boolean', description: 'Interpretar query como expressão regular (padrão: false)' },
          case_sensitive: { type: 'boolean', description: 'Diferenciar maiúsculas de minúsculas (padrão: false)' },
          file_pattern: { type: 'string', description: 'Filtro de arquivos no estilo glob (ex: *.js, src/**/*.test.js)' },
          max_results: { type: 'number', description: 'Máximo de linhas de resultado (padrão 60, teto 200)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Cria uma pasta (e as pastas pai necessárias) no workspace.',
      parameters: {
        type: 'object',
        properties: {
          dirname: { type: 'string', description: 'Caminho relativo da pasta a criar (ex: src/components)' }
        },
        required: ['dirname']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Apaga um arquivo do workspace. Use APENAS quando o usuário pediu a remoção, ou para ' +
        'um arquivo temporário que você mesmo criou. Nunca apague um arquivo existente para "recomeçar" ' +
        'uma edição que não deu certo — para corrigir conteúdo, use edit_file ou write_file.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Nome ou caminho relativo do arquivo a apagar' }
        },
        required: ['filename']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Executa um comando shell no workspace. Comandos que terminam retornam stdout/stderr. ' +
        'Servidores/APIs/watchers são detectados automaticamente: assim que ficam prontos (banner de log ' +
        'ou ociosidade) retornam um PID e seguem rodando em SEGUNDO PLANO, sem travar o chat — você pode ' +
        'continuar executando outros comandos (curl, testes, etc.) enquanto o servidor roda. Evite sudo.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando shell para rodar (ex: npm run dev, node app.js, curl localhost:3000)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_process_output',
      description: 'Lê os logs (stdout/stderr) acumulados de um processo em segundo plano pelo seu PID. ' +
        'Útil para verificar se um servidor subiu bem ou depurar erros.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'PID retornado por execute_command' }
        },
        required: ['pid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_process',
      description: 'ESPERA um processo de segundo plano TERMINAR e devolve o exit code com toda a saída. ' +
        'Use sempre que precisar do resultado de algo demorado (npm install, build, suíte de testes) em vez ' +
        'de chamar read_process_output várias vezes perguntando se já acabou — isso desperdiça chamadas e ' +
        'não acelera nada. Para servidores, que não terminam, NÃO espere: siga trabalhando.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'PID retornado por execute_command' },
          timeout_ms: { type: 'number', description: 'Tempo máximo de espera em ms (padrão 120000, teto 600000)' }
        },
        required: ['pid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_processes',
      description: 'Lista os processos em segundo plano (PID, comando, status, tempo de execução).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop_process',
      description: 'Encerra um processo em segundo plano (e seu grupo) pelo PID retornado por execute_command.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'PID do processo a encerrar' }
        },
        required: ['pid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Faz uma requisição HTTP e devolve status, cabeçalhos e corpo separados. Use para ' +
        'validar APIs (inclusive as que você mesmo subiu com execute_command): confira o status E o ' +
        'corpo, e teste também entradas inválidas para ver se o erro retornado é o esperado.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL completa (ex: http://localhost:3000/api/itens)' },
          method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE… (padrão: GET)' },
          headers: { type: 'object', description: 'Cabeçalhos extras, ex: { "Authorization": "Bearer x" }' },
          body: { type: 'string', description: 'Corpo da requisição (JSON como string). Content-Type: application/json é assumido se parecer JSON.' },
          timeout_ms: { type: 'number', description: 'Tempo limite em milissegundos (padrão 15000)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'capture_page',
      description: 'Abre uma URL num navegador oculto, tira um PRINT da tela e devolve o que aconteceu: ' +
        'erros de console, requisições que falharam, título e texto visível da página. Use para validar ' +
        'visualmente páginas e interfaces que você criou ou alterou, e para depurar erros de JavaScript ' +
        'que não aparecem no terminal. O servidor precisa estar no ar.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL a abrir (ex: http://localhost:5173)' },
          width: { type: 'number', description: 'Largura da janela em px (padrão 1280)' },
          height: { type: 'number', description: 'Altura da janela em px (padrão 800)' },
          wait_ms: { type: 'number', description: 'Espera após o carregamento, para a página montar (padrão 700)' },
          full_page: { type: 'boolean', description: 'Captura a PÁGINA INTEIRA, não só a primeira dobra. Use ao validar um layout — sem isso você não vê o rodapé nem o que depende de rolagem.' },
          crop_selector: { type: 'string', description: 'Recorta a captura neste elemento CSS e a envia em tamanho CHEIO. Use sempre que a tarefa for de DETALHE (alinhamento, espaçamento, sobreposição, texto torto): no print da página inteira a imagem é reduzida e esse tipo de defeito desaparece. Ex: ".roleta", "#cabecalho".' },
          selector: { type: 'string', description: 'Espera este seletor CSS aparecer antes do print (ex: #app .lista)' },
          script: { type: 'string', description: 'JavaScript executado na página ANTES do print, para interagir ou medir. Use "return" para devolver um valor. Ex: document.querySelector("#salvar").click(); return document.body.innerText;' }
        },
        required: ['url']
      }
    }
  }
];

// Ferramentas de web — incluídas só quando a busca na web está ativada nas configurações
const webTools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Pesquisa na web e retorna os resultados (título, URL e resumo) E o TEXTO já extraído ' +
        'das primeiras páginas, em "paginas". Na maioria das vezes a resposta está aí e não é preciso ' +
        'chamar fetch_url depois. Tenta vários buscadores em cascata até um responder. ' +
        'Use termos simples e específicos — evite aspas e operadores como site:, que costumam zerar a busca.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termos de busca' },
          max_results: { type: 'number', description: 'Quantidade de resultados (1-10, padrão 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Baixa uma página da web e retorna seu conteúdo em texto legível. ' +
        'Use para ler o conteúdo de um resultado retornado por web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL completa da página a ler' }
        },
        required: ['url']
      }
    }
  }
];

// Monta a lista de ferramentas disponíveis conforme as configurações
function activeTools() {
  return state.settings.webSearch ? [...tools, ...webTools] : tools;
}

// --------------------------------------------------------------------------
//  Visão: devolver o print do capture_page para o modelo
// --------------------------------------------------------------------------
// Mandar image_url para um modelo que só entende texto faz o servidor recusar a
// requisição inteira, então o reenvio depende do endpoint ANUNCIAR um modelo
// multimodal (campo "capabilities" do /v1/models). Sem isso, o print continua
// sendo salvo e mostrado ao usuário — só não volta para o modelo.
let modelSupportsVision = false;
const shotCache = new Map(); // caminho do png -> data URL, para não reler o disco a cada requisição
let ultimaPoda = 0;          // quantos resultados o último payload encurtou
let avisouPoda = false;      // o aviso de compactação é dado uma vez por conversa, não por turno
let ultimoSystemChars = 0;   // tamanho do prompt de sistema atual, descontado do orçamento do histórico

function visionEnabled() {
  return !!(state.settings.visionFeedback && modelSupportsVision);
}

function detectVision(json, modelId) {
  const all = [...(json.models || []), ...(json.data || [])];
  const daMesmaId = all.filter(m => [m.id, m.name, m.model].filter(Boolean).includes(modelId));
  const pool = daMesmaId.length ? daMesmaId : all;
  modelSupportsVision = pool.some(m =>
    (m.capabilities || []).some(c => /multimodal|vision|image/i.test(String(c))));
}

// Índices das mensagens cujo print ainda deve acompanhar o histórico. Prints antigos
// saem porque cada imagem custa milhares de tokens de visão — em poucas capturas o
// contexto acabaria, e o que interessa ao modelo é sempre a tela mais recente.
function recentShotIndexes(messages) {
  const idx = [];
  for (let i = messages.length - 1; i >= 0 && idx.length < MAX_VISION_IMAGES; i--) {
    if (messages[i].role === 'tool' && messages[i].image && messages[i].image.path) idx.push(i);
  }
  return new Set(idx);
}

// Relê do disco os prints que voltarão ao modelo (ao reabrir um chat o cache está vazio).
async function hydrateShots(messages) {
  if (!visionEnabled()) return;
  for (const i of recentShotIndexes(messages)) {
    const p = messages[i].image.path;
    if (shotCache.has(p)) continue;
    try {
      const res = await window.electronAPI.readImage(p);
      if (res && res.success) shotCache.set(p, res.dataUrl);
    } catch (e) { /* print perdido (arquivo apagado): segue só com o texto */ }
  }
}

// Arquivos que o agente já leu (ou escreveu) nesta sessão. Serve para barrar um
// write_file que sobrescreveria conteúdo que ele nunca viu. Zera ao trocar de chat,
// porque quem manda é o que está no histórico da conversa atual.
let arquivosLidos = new Set();

// Separa o que vai para o MODELO do que vai para a TELA. O diff é do usuário: mandá-lo
// ao modelo repetiria o conteúdo que ele acabou de escrever, dobrando o custo em contexto.
function comAlteracao(res, arquivo, extras: Partial<Alteracao> = {}): ToolOutput {
  const { diff, snapshotId, ...paraModelo } = res;
  const saida: ToolOutput = { text: JSON.stringify(paraModelo) };
  if (snapshotId) {
    saida.alteracao = {
      snapshotId, arquivo,
      adicionadas: (diff && diff.adicionadas) || extras.adicionadas || 0,
      removidas: (diff && diff.removidas) || extras.removidas || 0,
      apagado: !!extras.apagado
    };
    saida.diff = diff || null; // no delete não há diff: o card mostra "arquivo apagado"
  }
  return saida;
}

async function runTool(name, args, workspace) {
  try {
    if (name === 'list_files') {
      const dir = args.subpath ? `${workspace}/${args.subpath}` : workspace;
      const files = await window.electronAPI.listFiles(dir);
      return JSON.stringify(files);
    }
    if (name === 'read_file') {
      // O orçamento acompanha o n_ctx do modelo em uso, então trocar de modelo muda
      // automaticamente quanto cabe numa leitura.
      const budget = readCharBudget(state.modelCtx);
      const alvo = `${workspace}/${args.filename}`;
      const res = await window.electronAPI.readFile(alvo, {
        offset: args.offset, limit: args.limit,
        maxLines: READ_FILE_MAX_LINES, maxChars: budget
      });
      if (res && res.success) arquivosLidos.add(alvo);
      return formatFileWindow(args.filename, res, budget);
    }
    if (name === 'write_file') {
      const alvo = `${workspace}/${args.filename}`;
      const res = await window.electronAPI.writeFile(alvo, args.content ?? '', {
        requireRead: !arquivosLidos.has(alvo)
      });
      // Depois de escrever, o agente conhece o conteúdo: as próximas escritas passam direto.
      if (res.success) arquivosLidos.add(alvo);
      // Um arquivo que já existia e encolheu muito quase sempre veio de uma reescrita
      // feita a partir de leitura parcial. Avisar aqui é o último ponto em que dá
      // para o modelo perceber e restaurar o conteúdo.
      if (res.success && !res.created && res.previousLines > 20 && res.lines < res.previousLines * 0.5) {
        res.aviso = `ATENÇÃO: o arquivo tinha ${res.previousLines} linhas e agora tem ${res.lines}. ` +
          `Se não era para remover esse tanto, releia o arquivo por completo (read_file com offset) e restaure o que faltou.`;
      }
      return comAlteracao(res, args.filename);
    }
    if (name === 'edit_file') {
      const res = await window.electronAPI.editFile(
        `${workspace}/${args.filename}`, args.old_text, args.new_text ?? '', !!args.replace_all
      );
      return comAlteracao(res, args.filename);
    }
    if (name === 'search_files') {
      const res = await window.electronAPI.searchFiles(workspace, {
        query: args.query, regex: !!args.regex, caseSensitive: !!args.case_sensitive,
        filePattern: args.file_pattern, maxResults: args.max_results
      });
      return truncate(JSON.stringify(res), MAX_TOOL_RESULT_CHARS);
    }
    if (name === 'create_directory') {
      const res = await window.electronAPI.createDirectory(`${workspace}/${args.dirname}`);
      return JSON.stringify(res);
    }
    if (name === 'delete_file') {
      const alvo = `${workspace}/${args.filename}`;
      const res = await window.electronAPI.deleteFile(alvo, { requireRead: !arquivosLidos.has(alvo) });
      return comAlteracao(res, args.filename, { apagado: true, removidas: res.linhasApagadas || 0 });
    }
    if (name === 'execute_command') {
      const timeoutMs = (state.settings.cmdTimeout || 25) * 1000;
      const res = await window.electronAPI.executeCommand(args.command, workspace, {
        timeoutMs,
        hideConsole: state.settings.hideCommandConsole !== false
      });
      // Monta um resultado LIMITADO priorizando erro/exit/stderr (senão um stdout
      // gigante empurraria o motivo da falha para fora do limite e o modelo não o veria).
      const bounded = {
        command: res.command,
        finished: res.finished,
        backgrounded: res.backgrounded || undefined,
        pid: res.pid,
        reason: res.reason,
        exitCode: res.exitCode,
        error: res.error || undefined,
        note: res.note,
        stderr: clipMiddle(res.stderr || '', 2500) || undefined,
        stdout: clipMiddle(res.stdout || '', 3000) || undefined
      };
      return JSON.stringify(bounded);
    }
    if (name === 'read_process_output') {
      const res = await window.electronAPI.readProcessOutput(args.pid);
      if (res && res.success) {
        res.stderr = clipMiddle(res.stderr || '', 2500) || undefined;
        res.stdout = clipMiddle(res.stdout || '', 3000) || undefined;
      }
      return JSON.stringify(res);
    }
    if (name === 'wait_for_process') {
      const res = await window.electronAPI.waitForProcess(args.pid, args.timeout_ms);
      if (res && res.success) {
        res.stderr = clipMiddle(res.stderr || '', 2500) || undefined;
        res.stdout = clipMiddle(res.stdout || '', 3000) || undefined;
      }
      return JSON.stringify(res);
    }
    if (name === 'list_processes') {
      const res = await window.electronAPI.listProcesses();
      return JSON.stringify(res);
    }
    if (name === 'stop_process') {
      const res = await window.electronAPI.stopProcess(args.pid);
      return JSON.stringify(res);
    }
    if (name === 'http_request') {
      const res = await window.electronAPI.httpRequest(args.url, {
        method: args.method, headers: args.headers, body: args.body, timeoutMs: args.timeout_ms
      });
      if (res.success) {
        // Só os cabeçalhos que costumam importar numa validação; o resto é ruído
        // que ocupa contexto (cache-control, x-powered-by, cookies de sessão…).
        const keep = ['content-type', 'location', 'content-length'];
        const h = {};
        for (const k of keep) if (res.headers && res.headers[k]) h[k] = res.headers[k];
        res.headers = h;
      }
      return truncate(JSON.stringify(res), MAX_TOOL_RESULT_CHARS);
    }
    if (name === 'capture_page') {
      const res = await window.electronAPI.capturePage(args.url, {
        width: args.width, height: args.height, waitMs: args.wait_ms,
        selector: args.selector, script: args.script, fullPage: !!args.full_page,
        cropSelector: args.crop_selector
      });
      if (!res.success) return JSON.stringify({ error: res.error, hint: res.hint });

      // O dataUrl NÃO entra no texto do resultado: ele vai como imagem, à parte, e
      // colado aqui (centenas de KB de base64) estouraria o contexto sozinho.
      // Record<string, any> porque o resumo é montado por partes: os campos abaixo só
      // entram quando a captura realmente teve seletor, recorte ou script.
      const resumo: Record<string, any> = {
        ok: true, url: res.url, titulo: res.title, status: res.httpStatus,
        tamanho: `${res.width}x${res.height}`,
        erros_de_console: (res.console || []).filter(c => c.level === 'error').map(c => c.text).slice(0, 15),
        avisos_de_console: (res.console || []).filter(c => c.level === 'warning').map(c => c.text).slice(0, 5),
        falhas_de_rede: (res.netErrors || []).slice(0, 10),
        texto_visivel: res.text
      };
      if (args.selector) resumo.seletor_encontrado = res.selectorFound;
      if (res.recorte) resumo.recortado_em = res.recorte;
      if (res.recorteFalhou) resumo.aviso_do_recorte = res.recorteFalhou;
      if (res.scriptResult !== undefined) resumo.resultado_do_script = res.scriptResult;
      if (res.scriptError) resumo.erro_no_script = res.scriptError;
      resumo.print = visionEnabled()
        ? 'A imagem do print acompanha este resultado — analise-a.'
        : 'Print salvo e exibido ao usuário (o modelo atual não recebe imagens; use o texto e os erros acima).';

      return {
        text: truncate(JSON.stringify(resumo), MAX_TOOL_RESULT_CHARS),
        image: { path: res.path, dataUrl: res.dataUrl, width: res.width, height: res.height }
      };
    }
    if (name === 'web_search') {
      const res = await window.electronAPI.webSearch(args.query, args.max_results || 5);
      return truncate(JSON.stringify(res), MAX_SEARCH_RESULT_CHARS);
    }
    if (name === 'fetch_url') {
      const res = await window.electronAPI.fetchUrl(args.url, 8000);
      return truncate(JSON.stringify(res), MAX_TOOL_RESULT_CHARS);
    }
    return `Ferramenta desconhecida: ${name}`;
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// --------------------------------------------------------------------------
//  Loop do Agente
// --------------------------------------------------------------------------
async function submitUserMessage(userPrompt, attachments) {
  const chat = activeChat();
  if (!state.settings.model) {
    appendError('Nenhum modelo selecionado. Abra as Configurações → Personalização e escolha um modelo.');
    return;
  }

  // Adiciona a mensagem do usuário (com anexos) ao histórico persistente do chat
  const userMsg: ChatMessage = { role: 'user', content: userPrompt };
  if (attachments && attachments.length) userMsg.attachments = attachments;
  chat.messages.push(userMsg);
  forceScrollBottom(); // ao enviar, volta ao fim e reativa o acompanhamento
  renderUserMessage(userPrompt, attachments, chat.messages.length - 1);

  await runAgent();
}

// Roda o loop do agente sobre o histórico atual (usado por envio novo e por regeneração)
async function runAgent() {
  const chat = activeChat();
  if (!state.settings.model) {
    appendError('Nenhum modelo selecionado. Abra as Configurações → Personalização e escolha um modelo.');
    return;
  }

  isRunning = true;
  stopRequested = false;
  updateInputState();
  // O n_ctx precisa ser conhecido ANTES de montar o primeiro payload: é ele que dimensiona
  // a poda do histórico. Sem isso, justamente a primeira requisição de uma conversa longa
  // (a mais perigosa) iria inteira e estouraria o contexto. Só a primeira vez espera;
  // depois a atualização volta a rodar em paralelo, sem somar latência ao envio.
  if (!state.modelCtx) await refreshModelContext();
  else refreshModelContext();

  try {
    await agentTurns(chat);
  } catch (err) {
    hideTyping();
    appendError(`Erro inesperado no agente: ${err.message}`);
    console.error(err);
  } finally {
    // Garante que o input SEMPRE destrave, mesmo se algo estourar no meio do loop
    isRunning = false;
    updateInputState();
    atualizarBotaoCompactar();
    setAppTitle(''); // volta o título ao nome do app
    await persist();
    // Se o agente terminou deixando processos rodando, avisa (o usuário pode precisar encerrá-los)
    await refreshProcesses();
    const running = processList.filter(p => p.status === 'running').length;
    if (running > 0) {
      logSystem(`${running} processo(s) ainda em execução em segundo plano — veja/encerre no painel de processos (ícone no topo).`);
    }
  }
}

// --------------------------------------------------------------------------
//  Compactar a pedido do usuário
// --------------------------------------------------------------------------
// Marca até onde os resultados de ferramenta devem ir encurtados ao modelo. Não apaga
// nada: o histórico e a tela continuam completos, só o payload encolhe.
function compactarAgora() {
  const chat = activeChat();
  if (!chat) return;

  const jaMarcado = chat.podaManualAte || 0;
  let candidatos = 0, bytes = 0;
  for (let i = jaMarcado; i < chat.messages.length; i++) {
    const m = chat.messages[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.length <= PODA_AVISO.length) continue;
    candidatos++;
    bytes += m.content.length - PODA_AVISO.length;
  }

  if (!candidatos) {
    logSystem('Nada a compactar: não há resultado de ferramenta antigo o bastante nesta conversa.');
    return;
  }

  chat.podaManualAte = chat.messages.length;
  persist();
  atualizarBotaoCompactar();
  logSystem(`Contexto liberado: ${candidatos} resultado(s) de ferramenta passam a ir encurtados ao modelo (~${fmtSize(bytes)}). O conteúdo continua aqui na tela; se o agente precisar, é só chamar a ferramenta de novo.`);
}

// Mostra quanto dá para liberar e destaca o botão quando vale a pena.
function atualizarBotaoCompactar() {
  const btn = el('btn-compactar');
  const rotulo = el('compact-label');
  if (!btn || !rotulo) return;
  const chat = activeChat();
  if (!chat) { btn.disabled = true; return; }

  let bytes = 0;
  for (let i = (chat.podaManualAte || 0); i < chat.messages.length; i++) {
    const m = chat.messages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > PODA_AVISO.length) {
      bytes += m.content.length - PODA_AVISO.length;
    }
  }
  btn.disabled = bytes === 0;
  // O botão vive ao lado do clipe, sem espaço para rótulo fixo: o texto é só o tamanho a
  // liberar (some quando não há nada) e a explicação inteira fica no title.
  rotulo.innerText = bytes > 0 ? fmtSize(bytes) : '';
  btn.title = bytes > 0
    ? `Compactar contexto — libera ~${fmtSize(bytes)} encurtando os resultados antigos de ferramenta no envio ao modelo. Nada é apagado da tela.`
    : 'Compactar contexto — nada a liberar nesta conversa por enquanto.';
  // Destaca a partir de ~40 KB, quando a economia começa a fazer diferença real
  btn.classList.toggle('vale-a-pena', bytes > 40 * 1024);
}

async function clearFinishedProcesses() {
  await window.electronAPI.clearFinishedProcesses();
  await refreshProcesses();
}

// Traduz a falha em causa provável + o que fazer: "Failed to fetch" não diz se é
// servidor fora do ar, porta errada ou modelo inexistente — consertos bem diferentes.
// `transitorio` também decide se vale repetir (só 5xx vale).
function classificaErroDeRequisicao(err, apiUrl, model) {
  const msg = String((err && err.message) || err || '');
  const status = Number((msg.match(/^HTTP (\d{3})/) || [])[1]) || 0;
  const nomeCurto = model ? model.split(/[\\/]/).pop() : '(nenhum)';

  if (/failed to fetch|fetch failed|networkerror|ERR_CONNECTION|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
    return {
      transitorio: false,
      titulo: 'Não consegui falar com o servidor do modelo',
      detalhe: `Nenhuma resposta de ${apiUrl}.`,
      passos: [
        'Confirme que o servidor do modelo (llama.cpp, Ollama, vLLM…) está de pé.',
        'Confira a URL e principalmente a PORTA em Configurações → Conexão.',
        `Teste no navegador: ${apiUrl}/models deve devolver JSON.`
      ]
    };
  }
  if (status === 401 || status === 403) {
    return {
      transitorio: false,
      titulo: 'O servidor recusou a autenticação',
      detalhe: `HTTP ${status} em ${apiUrl}.`,
      passos: [
        'Preencha ou corrija a API Key em Configurações → Conexão.',
        'Servidores locais em geral não pedem chave — se for o caso, deixe o campo vazio.'
      ]
    };
  }
  if (status === 404) {
    return {
      transitorio: false,
      titulo: 'Endereço ou modelo não encontrado',
      detalhe: `HTTP 404 em ${apiUrl}/chat/completions (modelo: ${nomeCurto}).`,
      passos: [
        'A URL precisa terminar no prefixo da API, normalmente /v1.',
        'Reabra Configurações e clique em "Recarregar" para escolher um modelo que exista no servidor.'
      ]
    };
  }
  if (status === 400 && /model|not found|does not exist/i.test(msg)) {
    return {
      transitorio: false,
      titulo: 'O servidor não reconheceu o modelo pedido',
      detalhe: `Modelo enviado: ${nomeCurto}.`,
      passos: ['Configurações → "Recarregar" e selecione um modelo da lista do servidor.']
    };
  }
  if (status === 413 || /context|too long|exceeds/i.test(msg)) {
    return {
      transitorio: false,
      titulo: 'A conversa passou do que o modelo aguenta',
      detalhe: msg.slice(0, 200),
      passos: [
        'Comece um chat novo, ou reduza "Máximo de tokens por resposta" nas configurações.',
        'Se o servidor foi iniciado com contexto pequeno, suba o valor de -c / --ctx-size nele.'
      ]
    };
  }
  if (status >= 500) {
    return {
      transitorio: true, // geração estocástica: repetir costuma resolver
      titulo: 'O servidor do modelo devolveu erro interno',
      detalhe: msg.slice(0, 250),
      passos: [
        'Costuma ser uma geração malformada e passa ao repetir.',
        'Se insistir, veja o terminal onde o servidor está rodando — o erro real aparece lá.'
      ]
    };
  }
  return {
    transitorio: true,
    titulo: 'Falha na requisição ao modelo',
    detalhe: msg.slice(0, 250),
    passos: ['Confira se o servidor do modelo continua rodando.']
  };
}

// Chamada em STREAMING (SSE): dispara os callbacks conforme o texto chega e
// retorna a mensagem final montada (content, reasoning_content, tool_calls) + usage.
async function streamChatCompletion({ apiUrl, apiKey, payload, signal, onContent, onReasoning }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST', headers, signal,
    body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${truncate(body, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '', reasoning = '';
  const toolAcc = [];
  let usage = null, finishReason = null, aborted = false, apiError = null;
  const startedAt = performance.now();
  let firstTokenAt = 0; // tempo até o primeiro token (TTFT)

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // guarda a última linha (possivelmente incompleta)
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch (e) { continue; }
        if (json.error) { apiError = json.error.message || JSON.stringify(json.error); continue; }
        if (json.usage) usage = json.usage;
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if ((delta.reasoning_content || delta.content) && !firstTokenAt) firstTokenAt = performance.now();
        // Os callbacks recebem o DELTA, não o texto acumulado: mandar o acumulado obrigava
        // a tela a reescrever o bloco inteiro a cada token (custo O(n²) — ver criaEscritorStream).
        if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning && onReasoning(delta.reasoning_content); }
        if (delta.content) { content += delta.content; onContent && onContent(delta.content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolAcc[i]) toolAcc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolAcc[i].id = tc.id;
            if (tc.function && tc.function.name) toolAcc[i].function.name = tc.function.name;
            if (tc.function && tc.function.arguments) toolAcc[i].function.arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') aborted = true;
    else throw err;
  }

  const tool_calls = toolAcc.filter(Boolean);
  const endedAt = performance.now();
  const timing = {
    totalMs: endedAt - startedAt,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : 0,
    genMs: firstTokenAt ? endedAt - firstTokenAt : 0 // tempo de geração (após o 1º token)
  };
  return {
    message: { role: 'assistant', content, reasoning_content: reasoning, tool_calls: tool_calls.length ? tool_calls : undefined },
    usage, finishReason, aborted, apiError, timing
  };
}

// Calcula as métricas exibidas abaixo da resposta (velocidade, tokens, tempo)
function buildResponseStats(usage, timing) {
  if (!timing) return null;
  const completion = usage ? (usage.completion_tokens || 0) : 0;
  const genSec = timing.genMs > 0 ? timing.genMs / 1000 : 0;
  const tps = (completion > 0 && genSec > 0) ? completion / genSec : 0;
  return {
    tps: Math.round(tps * 10) / 10,
    completion,
    prompt: usage ? (usage.prompt_tokens || 0) : 0,
    total: usage ? (usage.total_tokens || 0) : 0,
    totalSec: Math.round((timing.totalMs / 1000) * 10) / 10,
    ttftSec: Math.round((timing.ttftMs / 1000) * 10) / 10
  };
}

// Renderiza a linha de métricas abaixo de uma bolha do agente
function renderMsgStats(msgDiv, stats) {
  if (!msgDiv || !stats) return;
  const parts = [];
  if (stats.tps > 0) parts.push(`${stats.tps} tok/s`);
  if (stats.completion > 0) parts.push(`+${stats.completion} contexto`);
  if (stats.totalSec > 0) parts.push(`${stats.totalSec}s até a finalização`);
  if (stats.ttftSec > 0) parts.push(`${stats.ttftSec}s até 1º token`);
  if (!parts.length) return;
  const bar = document.createElement('div');
  bar.className = 'msg-stats';
  bar.innerText = parts.join('  ·  ');
  msgDiv.appendChild(bar);
}

// Bolha de agente vazia para receber texto em streaming; retorna o .md-body
function createLiveAgentBody() {
  const chatBox = el('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message agent streaming';
  const body = document.createElement('div');
  body.className = 'md-body';
  msgDiv.appendChild(body);
  chatBox.appendChild(msgDiv);
  scrollChat();
  return body;
}

// Escritor de texto em streaming — a correção do consumo de memória durante o raciocínio.
// Antes, cada token reescrevia o bloco inteiro (`el.innerText = tudoQueChegouAteAgora`).
// innerText descarta e recria o nó de texto E força reflow síncrono, então um raciocínio de
// N caracteres custava O(N²) de trabalho e de lixo: num "pensa muito" longo o processo
// passava de 9 GB e só voltava ao normal quando o GC alcançava, já com o stream encerrado.
// Aqui chega só o delta, que é acumulado num buffer e ANEXADO ao mesmo nó de texto uma vez
// por quadro — appendData não recria nada e o custo deixa de crescer com o tamanho do texto.
function criaEscritorStream(el) {
  const no = document.createTextNode('');
  el.appendChild(no);
  let pendente = '';
  let quadro = 0;

  const aplicar = () => {
    quadro = 0;
    if (!pendente) return;
    no.appendData(pendente);
    pendente = '';
    // Poda o começo ao passar do teto: o nó segue único e o custo de layout para de subir.
    const excesso = no.length - MAX_REASONING_DOM_CHARS;
    if (excesso > 0) no.deleteData(0, excesso);
    scrollChat();
  };

  return {
    escreve(delta) {
      if (!delta) return;
      pendente += delta;
      if (!quadro) quadro = requestAnimationFrame(aplicar);
    },
    // Fim do stream: descarrega o que sobrou no buffer.
    encerra() {
      if (quadro) { cancelAnimationFrame(quadro); quadro = 0; }
      aplicar();
    },
    // O elemento vai ser removido ou reescrito como markdown — o quadro pendente escreveria
    // num nó que já não está mais na árvore.
    descarta() {
      if (quadro) { cancelAnimationFrame(quadro); quadro = 0; }
      pendente = '';
    }
  };
}

// Bloco de raciocínio aberto para streaming; retorna { details, body }
function createLiveReasoning() {
  const chatBox = el('chat-box');
  const details = document.createElement('details');
  details.className = 'reasoning';
  details.open = true;
  const summary = document.createElement('summary');
  summary.innerText = 'Raciocínio do modelo (pensando…)';
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  details.appendChild(summary);
  details.appendChild(body);
  chatBox.appendChild(details);
  scrollChat();
  return { details, summary, body };
}

// Executa o ciclo de raciocínio/ferramentas até o modelo parar de chamar ferramentas
async function agentTurns(chat) {
  const { apiUrl, model, apiKey, temperature, topP, maxTokens, noThink } = state.settings;
  const nivelThink = THINK_LEVELS[state.settings.thinkLevel] || THINK_LEVELS.padrao;
  // noThink continua sendo respeitado: migraSettings converte a chave antiga, mas um store
  // escrito por uma versão mais nova em outra máquina pode trazer as duas.
  const semRaciocinio = nivelThink.semRaciocinio || noThink;

  // Montado a cada iteração porque a detecção de multimodal (refreshModelContext) roda
  // em paralelo e pode chegar depois do primeiro turno — o prompt precisa acompanhar,
  // senão o modelo é informado de que "vê" prints quando ainda não recebe imagem.
  const buildSystem = () => {
    let s = system_prompt(chat.path, state.settings.webSearch, visionEnabled());
    if (semRaciocinio) s += ' /no_think';
    ultimoSystemChars = s.length; // entra na conta do orçamento do histórico
    return s;
  };

  const toolset = activeTools();

  await persist();

  let iterations = 0;

  while (iterations < MAX_LOOP_ITERATIONS || !state.settings.safetyInteractions) {
    if (stopRequested) break;
    iterations++;
    showTyping();
    setAppTitle('pensando…');

    // Elementos de streaming (criados sob demanda quando o primeiro token chega)
    let liveBody = null, liveReason = null;
    let escritorBody = null, escritorReason = null;
    const onReasoning = (delta) => {
      hideTyping();
      setAppTitle('pensando…');
      if (!liveReason) {
        liveReason = createLiveReasoning();
        escritorReason = criaEscritorStream(liveReason.body);
      }
      escritorReason.escreve(delta);
    };
    const onContent = (delta) => {
      hideTyping();
      setAppTitle('gerando resposta…');
      if (!liveBody) {
        liveBody = createLiveAgentBody();
        escritorBody = criaEscritorStream(liveBody); // texto puro enquanto digita; markdown ao finalizar
      }
      escritorBody.escreve(delta);
    };

    await hydrateShots(chat.messages); // recarrega do disco os prints que voltam ao modelo

    // Uma resposta ruim (ex.: tool_call malformado → 500 do llama.cpp) é transitória:
    // tenta de novo em vez de encerrar a run inteira. Abort do usuário não lança —
    // volta em result.aborted — então tudo que cai no catch é falha real.
    let result = null, lastErr = null;
    for (let attempt = 1; attempt <= MAX_REQUEST_RETRIES; attempt++) {
      abortController = new AbortController();
      try {
        result = await streamChatCompletion({
          apiUrl, apiKey,
          payload: {
            model,
            messages: [{ role: 'system', content: buildSystem() }, ...toApiMessages(chat.messages)],
            tools: toolset, tool_choice: 'auto', temperature, top_p: topP, max_tokens: maxTokens,
            // Vazio no nível 'padrao' — ver THINK_LEVELS: campo desconhecido derruba servidor antigo.
            ...(nivelThink.payload || {})
          },
          signal: abortController.signal,
          onContent, onReasoning
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      } finally {
        abortController = null;
      }
      if (stopRequested) break;
      // Repetir só faz sentido para falha transitória; servidor fora do ar ou modelo
      // inexistente falham igual nas três tentativas e atrasam o diagnóstico.
      const diag = classificaErroDeRequisicao(lastErr, apiUrl, model);
      if (!diag.transitorio) break;
      if (attempt < MAX_REQUEST_RETRIES) {
        logSystem(`${diag.titulo} (tentativa ${attempt}/${MAX_REQUEST_RETRIES}). Tentando de novo…`);
        // descarta o parcial da tentativa perdida (e o quadro pendente do escritor)
        if (liveReason) { escritorReason.descarta(); liveReason.details.remove(); liveReason = null; escritorReason = null; }
        if (liveBody) { escritorBody.descarta(); liveBody.parentElement.remove(); liveBody = null; escritorBody = null; }
        await new Promise(r => setTimeout(r, REQUEST_RETRY_DELAY_MS * attempt));
        showTyping();
      }
    }

    // O stream acabou (ou foi abortado): joga na tela o que ficou no buffer do último
    // quadro, senão o fim do texto some justamente quando ele para de ser atualizado.
    if (escritorReason) escritorReason.encerra();
    if (escritorBody) escritorBody.encerra();

    if (!result) {
      hideTyping();
      if (lastErr) appendErrorCard(classificaErroDeRequisicao(lastErr, apiUrl, model));
      else appendError('Requisição interrompida.');
      break;
    }

    hideTyping();

    if (result.apiError) {
      appendError(`Erro da API: ${result.apiError}`);
      break;
    }

    trackUsage(result.usage);
    const message = result.message;
    const aborted = result.aborted || stopRequested;

    // A API responde 200 mesmo quando corta no limite de tokens; sem este aviso o corte
    // passa silencioso (e um tool_call cortado chega como JSON inválido logo abaixo).
    if (result.finishReason === 'length' && !aborted) {
      logSystem(`Resposta cortada no limite de ${maxTokens} tokens. Aumente "Máximo de tokens por resposta" nas configurações se isso se repetir.`);
    }

    // Recolhe o bloco de raciocínio ao terminar
    if (liveReason) { liveReason.summary.innerText = 'Raciocínio do modelo'; setTimeout(() => liveReason.details.open = false, 500) }

    // Se foi interrompido, NÃO guarda tool_calls (ficariam órfãos, sem resposta → erro no próximo turno)
    const hasContent = !!(message.content && message.content.trim());
    const stats = buildResponseStats(result.usage, result.timing);
    const stored: ChatMessage = { role: 'assistant', content: message.content || '' };
    if (!aborted && message.tool_calls && message.tool_calls.length > 0) stored.tool_calls = message.tool_calls;

    if (hasContent || stored.tool_calls) {
      if (hasContent && stats) stored.stats = stats; // guarda métricas para reexibir no reload
      chat.messages.push(stored);
      const assistantIndex = chat.messages.length - 1;
      if (hasContent) {
        // Finaliza a bolha: re-renderiza como markdown, adiciona botão de regenerar e as métricas
        const bubble = liveBody ? liveBody.parentElement : null;
        if (liveBody) {
          if (escritorBody) escritorBody.descarta(); // innerHTML abaixo troca o nó de texto
          renderMarkdownInto(liveBody, message.content);
          bubble.classList.remove('streaming');
          attachMsgAction(bubble, 'regenerate', assistantIndex);
          renderMsgStats(bubble, stats);
        } else {
          const div = appendMessage(message.content, 'agent', assistantIndex);
          renderMsgStats(div, stats);
        }
        maybeRenameChat(chat);
      } else if (liveBody) {
        liveBody.parentElement.remove();
      }
    } else if (liveBody) {
      liveBody.parentElement.remove(); // nada de útil: descarta a bolha
    }

    // Parada solicitada durante o stream
    if (aborted) {
      logSystem('Geração interrompida pelo usuário.');
      break;
    }

    // Sem chamadas de ferramenta → o agente terminou
    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    // Executa cada ferramenta solicitada
    for (const toolCall of message.tool_calls) {
      const fn = toolCall && toolCall.function;
      const name = (fn && fn.name) || '';
      let result;
      let image = null;      // print do capture_page, quando houver
      let alteracao = null;  // {snapshotId, arquivo, +/-} das ferramentas que mexem em arquivo
      let diffVivo = null;   // diff já calculado desta execução (evita recalcular agora)

      if (!name) {
        // Modelos quantizados às vezes emitem tool_calls malformados
        result = JSON.stringify({ error: 'tool_call malformado (sem nome de função)' });
        appendToolLog(`⚠ tool_call ignorado (malformado)`);
      } else {
        let args = null;
        try {
          args = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch (e) {
          args = null;
        }

        if (!args) {
          // Argumentos cortados ou corrompidos. Executar assim mesmo chamaria a ferramenta
          // com os campos undefined (write_file criaria um arquivo chamado "undefined"),
          // então devolve o erro ao modelo para ele refazer a chamada.
          result = JSON.stringify({ error: `Os argumentos de ${name} não são JSON válido — a chamada provavelmente foi cortada. Refaça a chamada com JSON completo; se o conteúdo for muito grande, divida em partes menores.` });
          appendToolLog(`⚠ ${name}: argumentos inválidos, chamada não executada`);
        } else {
          const card = appendToolCall(name, args);
          // Modo manual: pede confirmação para ações que executam/apagam
          const decision = await maybeConfirmTool(name, args);
          if (decision === 'reject') {
            result = JSON.stringify({ rejected: true, error: 'O usuário rejeitou esta ação. Não a repita; aguarde novas instruções ou proponha uma alternativa.' });
            fillToolResult(card, name, result);
            logSystem(`Ação rejeitada pelo usuário: ${(TOOL_META[name] && TOOL_META[name].label) || name}`);
          } else {
            setAppTitle(`executando: ${(TOOL_META[name] && TOOL_META[name].label) || name}`);
            const saida = await runTool(name, args, chat.path);
            // Ferramentas que produzem algo além de texto (print, diff) devolvem objeto;
            // as demais devolvem a string que vai direto para o modelo.
            if (saida && typeof saida === 'object') {
              result = saida.text;
              if (saida.image) {
                shotCache.set(saida.image.path, saida.image.dataUrl);
                image = { path: saida.image.path, width: saida.image.width, height: saida.image.height };
              }
              if (saida.alteracao) {
                alteracao = saida.alteracao;
                diffVivo = saida.diff; // já calculado; na recarga o card busca de novo pelo snapshotId
              }
            } else {
              result = saida;
            }
            fillToolResult(card, name, result, { image, alteracao, diff: diffVivo });
            refreshProcesses(); // atualiza o painel de processos (pode ter subido/encerrado algo)
          }
        }
      }

      const toolMsg: ChatMessage = {
        role: 'tool',
        tool_call_id: toolCall && toolCall.id,
        name: name || 'unknown',
        content: result
      };
      // Guarda só o CAMINHO do print: o base64 fica no cache em memória, porque gravá-lo
      // no histórico incharia o app-store.json em centenas de KB por captura.
      if (image) toolMsg.image = image;
      // Mesma lógica para o diff: no histórico fica só a referência do instantâneo
      // (que já tem o antes e o depois em disco) e os contadores do cabeçalho.
      if (alteracao) toolMsg.alteracao = alteracao;
      chat.messages.push(toolMsg);
    }

    await persist();
  }

  if (iterations >= MAX_LOOP_ITERATIONS && state.settings.safetyInteractions) appendError(`Trava de segurança: ${MAX_LOOP_ITERATIONS} iterações seguidas. Se ainda precisava continuar, envie "continue".`);
}

// O servidor reparseia os arguments de TODO tool_call do histórico a cada requisição.
// Um único arguments inválido (ex.: chamada cortada no limite de tokens) faz toda
// requisição seguinte falhar com HTTP 500 — o chat trava de vez, e repetir não adianta
// porque o erro vem do histórico, não da geração. Só sai daqui JSON parseável.
function sanitizeToolCalls(toolCalls) {
  return toolCalls.map(tc => {
    const fn = (tc && tc.function) || {};
    try {
      JSON.parse(fn.arguments || '{}');
      return tc;
    } catch (e) {
      return { ...tc, function: { ...fn, arguments: '{}' } };
    }
  });
}

// --------------------------------------------------------------------------
//  Compactação de contexto
// --------------------------------------------------------------------------
const PODA_AVISO = '[resultado antigo removido para liberar contexto — chame a ferramenta de novo se precisar deste conteúdo]';

// Decide o que substituir nos resultados de ferramenta para o payload caber no contexto.
// Devolve índice -> novo conteúdo. A mensagem NUNCA é removida: um tool_call sem o 'tool'
// correspondente faz o servidor recusar a requisição inteira. E vale só para o que é
// ENVIADO — o histórico salvo continua completo, na tela e ao reabrir o chat.
function compactToolResults(messages) {
  const ctx = state.modelCtx || ASSUMED_CTX_WHEN_UNKNOWN;
  // Reserva o que não é histórico: o prompt de sistema (que vai junto em toda requisição)
  // e o espaço da resposta. O piso evita orçamento negativo se maxTokens for quase a janela.
  const reserva = (state.settings.maxTokens || 4096)
    + Math.ceil(ultimoSystemChars / CHARS_PER_TOKEN)
    + CONTEXT_MARGIN_TOKENS;
  const tokensHistorico = Math.max(ctx - reserva, Math.floor(ctx * HISTORY_MIN_FRACTION));
  const orcamento = Math.floor(tokensHistorico * CHARS_PER_TOKEN);

  // Estimativa do peso REAL da mensagem no corpo da requisição: contar só o content
  // subestima bastante, porque os argumentos do tool_call e as chaves do JSON também
  // ocupam contexto — e aí a poda para cedo demais e o payload passa do orçamento.
  const tamanho = (m) => {
    let n = 80; // role, tool_call_id, name e a estrutura do objeto JSON
    if (typeof m.content === 'string') n += m.content.length;
    for (const a of (m.attachments || [])) n += (a.content || '').length + 60;
    for (const tc of (m.tool_calls || [])) {
      const f = tc.function || {};
      n += 70 + (f.arguments || '').length + (f.name || '').length;
    }
    return n;
  };

  let total = 0;
  for (const m of messages) total += tamanho(m);
  const subs = new Map();

  // Corte pedido pelo usuário no botão "Compactar": tudo anterior a esta marca vai
  // encurtado, caiba ou não no orçamento. Some do ENVIO, não do histórico.
  const chat = activeChat();
  const marca = (chat && chat.podaManualAte) || 0;
  for (let i = 0; i < Math.min(marca, messages.length); i++) {
    if (messages[i].role !== 'tool') continue;
    if (tamanho(messages[i]) - PODA_AVISO.length <= 0) continue;
    total -= tamanho(messages[i]) - PODA_AVISO.length;
    subs.set(i, PODA_AVISO);
  }

  if (total <= orcamento) return subs;

  // 1ª etapa: do mais novo para o mais antigo — o que acabou de acontecer é o que o
  // modelo precisa, então os antigos é que viram aviso curto.
  const recentes = [];
  let vistos = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'tool') continue;
    if (subs.has(i)) continue;                        // já encurtado pelo corte manual
    if (++vistos <= KEEP_RECENT_TOOL_RESULTS) { recentes.push(i); continue; }
    if (total <= orcamento) continue;                 // já coube: o resto fica intacto
    const ganho = tamanho(messages[i]) - PODA_AVISO.length;
    if (ganho <= 0) continue;                          // resultado curto: podar não compensa
    total -= ganho;
    subs.set(i, PODA_AVISO);
  }
  if (total <= orcamento) return subs;

  // 2ª etapa: nem os recentes cabem (contexto pequeno + saídas enormes). Apagá-los faria
  // o agente perder o que acabou de fazer e repetir as chamadas em looping, então eles são
  // cortados pelo MEIO — o começo tem o cabeçalho e o fim tem o erro, que é o que importa.
  const somaRecentes = recentes.reduce((s, i) => s + tamanho(messages[i]), 0);
  const sobra = orcamento - (total - somaRecentes);
  const cota = Math.max(Math.floor(sobra / Math.max(recentes.length, 1)), CLIP_MIN_CHARS);
  for (const i of recentes) {
    const c = messages[i].content;
    if (typeof c === 'string' && c.length > cota) subs.set(i, clipMiddle(c, cota));
  }
  return subs;
}

// Monta o payload para o servidor: remove reasoning_content e expande anexos no conteúdo do usuário
function toApiMessages(messages) {
  const comPrint = visionEnabled() ? recentShotIndexes(messages) : new Set();
  const compactados = compactToolResults(messages);
  // A contagem sobe a cada turno, então comparar com a anterior avisava de novo toda
  // vez. O usuário só precisa saber UMA vez que a compactação entrou; o estado contínuo
  // fica no indicador de contexto do cabeçalho, que não polui a conversa.
  if (compactados.size > 0 && !avisouPoda) {
    avisouPoda = true;
    logSystem('Contexto quase cheio: resultados antigos de ferramenta passaram a ser enviados encurtados ao modelo (continuam completos aqui). Use o botão de compactar, ao lado do clipe de anexo, para liberar espaço de vez.');
  }
  ultimaPoda = compactados.size;
  return messages.map((m, i) => {
    if (compactados.has(i)) return { role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: compactados.get(i) };
    const copy: ChatMessage = { role: m.role };
    if (m.role === 'user' && m.attachments && m.attachments.length) {
      copy.content = buildAttachmentBlock(m.attachments) + (m.content || '');
    } else if (comPrint.has(i) && shotCache.has(m.image.path)) {
      // O print entra como parte de conteúdo da própria mensagem de ferramenta: é onde
      // ele pertence, e evita inventar uma mensagem de usuário que o modelo não enviou.
      copy.content = [
        { type: 'text', text: m.content },
        { type: 'image_url', image_url: { url: shotCache.get(m.image.path) } }
      ];
    } else if (m.content !== undefined) {
      copy.content = m.content;
    }
    if (m.tool_calls) copy.tool_calls = sanitizeToolCalls(m.tool_calls);
    if (m.tool_call_id) copy.tool_call_id = m.tool_call_id;
    if (m.name) copy.name = m.name;
    return copy;
  });
}

function buildAttachmentBlock(attachments) {
  return attachments.map(a => {
    if (a.binary) return `[Arquivo anexado: ${a.name} — binário (${fmtSize(a.size)}), conteúdo não incluído]`;
    const suffix = a.truncated ? ` (truncado em ${fmtSize(a.content.length)})` : '';
    return `[Arquivo anexado: ${a.name}${suffix}]\n\`\`\`\n${a.content}\n\`\`\``;
  }).join('\n\n') + '\n\n';
}

// ---- Importação de arquivos para o chat ----
let pendingAttachments = [];
const ATTACH_MAX = 120 * 1024; // ~120 KB de texto por arquivo

// --------------------------------------------------------------------------
//  Menção de arquivo (@arquivo): autocomplete no composer + anexo automático
// --------------------------------------------------------------------------
let mentionFiles = [];       // cache da árvore de arquivos do workspace atual
let mentionFilesFor = null;  // caminho do workspace a que o cache pertence
let mentionState = null;     // { start, end, items, index } enquanto o menu está aberto

// (Re)carrega a lista recursiva de arquivos do workspace, se ainda não estiver em cache.
async function ensureMentionFiles() {
  const chat = activeChat();
  if (!chat || !chat.path) { mentionFiles = []; mentionFilesFor = null; return; }
  if (mentionFilesFor === chat.path) return; // já em cache para este workspace
  try {
    const res = await window.electronAPI.listTree(chat.path);
    mentionFiles = (res && res.files) || [];
    mentionFilesFor = chat.path;
  } catch (e) {
    mentionFiles = []; mentionFilesFor = null;
  }
}

// Descobre se o cursor está dentro de um trecho "@algo" (sem espaços após o @).
function mentionCtx() {
  const campo = el('user-input');
  if (!campo || campo.disabled) return null;
  const pos = campo.selectionStart;
  if (pos !== campo.selectionEnd) return null; // há seleção ativa: ignora
  const before = campo.value.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null; // @ precisa iniciar palavra
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null; // já digitou espaço depois do @ → não é mais menção
  return { start: at, end: pos, query };
}

// Ordena priorizando correspondência no nome do arquivo (não só no caminho).
function mentionScore(f, q) {
  const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
  const inBase = base.indexOf(q);
  if (inBase === 0) return 0;
  if (inBase > 0) return 1;
  return 2 + f.toLowerCase().indexOf(q) / 100000;
}

async function updateMentionMenu() {
  if (!mentionCtx()) return closeMention();
  await ensureMentionFiles();
  const ctx = mentionCtx(); // recomputa: o usuário pode ter digitado durante o await
  if (!ctx) return closeMention();
  const q = ctx.query.toLowerCase();
  let items;
  if (!q) {
    items = mentionFiles.slice(0, 50);
  } else {
    items = mentionFiles
      .filter(f => f.toLowerCase().includes(q))
      .sort((a, b) => mentionScore(a, q) - mentionScore(b, q))
      .slice(0, 50);
  }
  mentionState = { start: ctx.start, end: ctx.end, items, index: 0 };
  renderMentionMenu();
}

function renderMentionMenu() {
  const menu = el('mention-menu');
  if (!menu || !mentionState) return;
  menu.innerHTML = '';
  if (!mentionState.items.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.innerText = mentionFilesFor ? 'Nenhum arquivo corresponde' : 'Selecione uma pasta de trabalho';
    menu.appendChild(empty);
    menu.hidden = false;
    return;
  }
  mentionState.items.forEach((f, i) => {
    const slash = f.lastIndexOf('/');
    const row = document.createElement('div');
    row.className = 'mention-item' + (i === mentionState.index ? ' active' : '');
    const nameEl = document.createElement('span');
    nameEl.className = 'mention-name';
    nameEl.innerText = slash === -1 ? f : f.slice(slash + 1);
    const dirEl = document.createElement('span');
    dirEl.className = 'mention-dir';
    dirEl.innerText = slash === -1 ? '' : f.slice(0, slash);
    row.append(nameEl, dirEl);
    // mousedown (não click) + preventDefault mantém o foco no textarea
    row.addEventListener('mousedown', (e) => { e.preventDefault(); acceptMention(f); });
    menu.appendChild(row);
  });
  menu.hidden = false;
  const active = menu.querySelector('.mention-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function closeMention() {
  mentionState = null;
  const menu = el('mention-menu');
  if (menu) { menu.hidden = true; menu.innerHTML = ''; }
}

// Teclado do menu: retorna true quando "consome" a tecla (impede enviar/nova linha).
function handleMentionKeydown(e) {
  if (!mentionState) return false;
  const n = mentionState.items.length;
  if (e.key === 'ArrowDown') {
    if (n) { mentionState.index = (mentionState.index + 1) % n; renderMentionMenu(); }
    e.preventDefault(); return true;
  }
  if (e.key === 'ArrowUp') {
    if (n) { mentionState.index = (mentionState.index - 1 + n) % n; renderMentionMenu(); }
    e.preventDefault(); return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    if (n) acceptMention(mentionState.items[mentionState.index]);
    else closeMention();
    return true;
  }
  if (e.key === 'Escape') { closeMention(); e.preventDefault(); return true; }
  return false;
}

// Substitui o "@query" pelo caminho escolhido e anexa o conteúdo do arquivo.
async function acceptMention(relPath) {
  const campo = el('user-input');
  if (!campo || !mentionState) return closeMention();
  const insert = '@' + relPath + ' ';
  campo.value = campo.value.slice(0, mentionState.start) + insert + campo.value.slice(mentionState.end);
  const caret = mentionState.start + insert.length;
  campo.setSelectionRange(caret, caret);
  campo.focus();
  closeMention();
  campo.dispatchEvent(new Event('input')); // reajusta a altura e fecha o menu residual
  await addMentionAttachment(relPath);
}

// Lê o arquivo mencionado e o adiciona como anexo (dedupe por caminho).
async function addMentionAttachment(relPath) {
  const chat = activeChat();
  if (!chat || !chat.path) return;
  if (pendingAttachments.some(a => a.mention && a.path === relPath)) return;
  // O anexo quer o arquivo inteiro (até ATTACH_MAX), não a janela de leitura do agente:
  // o teto de linhas é neutralizado e quem corta é o de caracteres.
  let res;
  try {
    res = await window.electronAPI.readFile(`${chat.path}/${relPath}`, {
      maxLines: Number.MAX_SAFE_INTEGER, maxChars: ATTACH_MAX
    });
  } catch (e) {
    res = null;
  }
  if (!res || !res.success) {
    logSystem(`Não consegui ler o arquivo mencionado: ${relPath}${res && res.error ? ` — ${res.error}` : ''}`);
    return;
  }
  const content = res.content || '';
  const truncated = !!res.charClipped || (res.total > 0 && res.end < res.total);
  pendingAttachments.push({ name: relPath, path: relPath, mention: true, content, size: res.size || content.length, truncated });
  renderAttachments();
}
const TEXT_EXT = /\.(txt|md|markdown|js|mjs|cjs|ts|jsx|tsx|json|jsonc|html?|css|scss|sass|less|py|rb|go|rs|java|kt|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|zig|yml|yaml|toml|ini|cfg|conf|env|xml|sql|csv|tsv|log|vue|svelte|swift|dart|lua|r|pl|pm|ex|exs|erl|hs|clj|gradle|properties)$/i;
const TEXT_NAME = /^(dockerfile|makefile|\.gitignore|\.env|readme|license|procfile)$/i;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readFileAsText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}

async function handleFiles(fileList: FileList | File[]) {
  const files = Array.from<File>(fileList || []);
  for (const file of files) {
    const looksText = TEXT_EXT.test(file.name) || TEXT_NAME.test(file.name) ||
      (file.type && (file.type.startsWith('text/') || file.type === 'application/json' || file.type.includes('xml')));
    if (!looksText) {
      pendingAttachments.push({ name: file.name, size: file.size, binary: true, content: '' });
      continue;
    }
    let content = await readFileAsText(file) as string;
    if (content == null) {
      pendingAttachments.push({ name: file.name, size: file.size, binary: true, content: '' });
      continue;
    }
    let truncated = false;
    if (content.length > ATTACH_MAX) { content = content.slice(0, ATTACH_MAX); truncated = true; }
    pendingAttachments.push({ name: file.name, size: file.size, content, truncated });
  }
  renderAttachments();
}

function renderAttachments() {
  const caixa = el('attachments');
  if (!caixa) return;
  caixa.innerHTML = '';
  caixa.style.display = pendingAttachments.length ? 'flex' : 'none';
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (a.binary ? ' binary' : '');
    const icon = document.createElement('span');
    icon.className = 'attach-icon';
    icon.innerText = a.mention ? '@' : (a.binary ? '🗎' : '📄');
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.innerText = a.name;
    name.title = a.name;
    const size = document.createElement('span');
    size.className = 'attach-size';
    size.innerText = fmtSize(a.size) + (a.truncated ? ' • truncado' : '') + (a.binary ? ' • binário' : '');
    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.innerText = '×';
    rm.title = 'Remover';
    rm.addEventListener('click', () => { pendingAttachments.splice(i, 1); renderAttachments(); });
    chip.append(icon, name, size, rm);
    caixa.appendChild(chip);
  });
}

function maybeRenameChat(chat) {
  if (chat.name === 'Novo Chat' || chat.name === 'Chat Inicial') {
    const firstUser = chat.messages.find(m => m.role === 'user');
    if (firstUser) {
      let base = (firstUser.content || '').trim();
      if (!base && firstUser.attachments && firstUser.attachments.length) {
        base = '📎 ' + firstUser.attachments[0].name;
      }
      if (!base) return;
      chat.name = base.slice(0, 30) + (base.length > 30 ? '…' : '');
      renderChatList();
    }
  }
}

// --------------------------------------------------------------------------
//  Rastreamento real de uso de tokens
// --------------------------------------------------------------------------
function trackUsage(usage) {
  if (!usage) return;
  state.usage.prompt += usage.prompt_tokens || 0;
  state.usage.completion += usage.completion_tokens || 0;
  state.usage.requests += 1;
  state.usage.lastTotal = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
  state.usage.history.push(usage.completion_tokens || 0);
  if (state.usage.history.length > 12) state.usage.history.shift();
  renderUsage();
}

function renderUsage() {
  const u = state.usage;
  el('usage-prompt').innerText = u.prompt.toLocaleString('pt-BR');
  el('usage-completion').innerText = u.completion.toLocaleString('pt-BR');
  el('usage-total').innerText = (u.prompt + u.completion).toLocaleString('pt-BR');
  el('usage-requests').innerText = String(u.requests);

  // Barra de contexto usado na última requisição
  const ctx = state.modelCtx || 0;
  const pct = ctx > 0 ? Math.min(100, Math.round((u.lastTotal / ctx) * 100)) : 0;
  el('ctx-label').innerText = `${u.lastTotal} / ${ctx || '?'} tkn`;
  el('ctx-percent').innerText = `${pct}%`;
  el('ctx-fill').style.width = `${pct}%`;

  // Medidor de contexto sempre visível no cabeçalho
  const ctxText = `${u.lastTotal.toLocaleString('pt-BR')} / ${ctx ? ctx.toLocaleString('pt-BR') : '?'} tkn`;
  el('hdr-ctx-text').innerText = ctxText;
  el('hdr-ctx-fill').style.width = `${pct}%`;
  const pill = el('ctx-pill');
  pill.classList.toggle('warn', pct >= 70 && pct < 90);
  pill.classList.toggle('danger', pct >= 90);
}

// --------------------------------------------------------------------------
//  Busca de modelos e informações reais do endpoint
// --------------------------------------------------------------------------
async function fetchModels() {
  const status = el('info-model-status');
  const select = el('model-name');
  const apiUrl = el('api-url').value.trim() || state.settings.apiUrl;

  status.innerText = 'Consultando endpoint...';
  try {
    const headers = {};
    if (state.settings.apiKey) headers['Authorization'] = `Bearer ${state.settings.apiKey}`;
    const res = await fetch(`${apiUrl}/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = json.data || [];

    if (models.length === 0) throw new Error('Nenhum modelo retornado.');

    select.innerHTML = '';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.innerText = shortModelName(m.id);
      select.appendChild(opt);
    });

    // Mantém a seleção salva se ainda existir; senão pega o primeiro
    if (state.settings.model && models.some(m => m.id === state.settings.model)) {
      select.value = state.settings.model;
    } else {
      select.value = models[0].id;
      state.settings.model = models[0].id;
    }

    updateModelInfo(models.find(m => m.id === select.value) || models[0]);
    detectVision(json, select.value);
    updateVisionStatus();
    status.innerText = `${models.length} modelo(s) disponível(is)` +
      (modelSupportsVision ? ' — multimodal: o agente vê os prints do capture_page.' : '.');
  } catch (err) {
    status.innerText = `Não foi possível carregar modelos de ${apiUrl}/models — ${err.message}`;
    select.innerHTML = '<option value="">(indisponível)</option>';
  }
}

function shortModelName(id) {
  // Caminhos completos de gguf ficam enormes; mostra só o nome do arquivo
  const parts = id.split(/[\\/]/);
  return parts[parts.length - 1] || id;
}

function updateModelInfo(model) {
  const meta = (model && model.meta) || {};
  el('info-model-name').innerText = shortModelName(model.id);
  el('info-model-quant').innerText = meta.ftype || '—';
  el('info-model-ctx').innerText = meta.n_ctx
    ? `${meta.n_ctx.toLocaleString('pt-BR')} tkn` : '—';
  el('info-model-size').innerText = meta.size
    ? `${(meta.size / 1e9).toFixed(2)} GB` : '—';
  el('info-model-params').innerText = meta.n_params
    ? `${(meta.n_params / 1e9).toFixed(2)} B` : '—';
  el('info-model-owner').innerText = model.owned_by || '—';
  state.modelCtx = meta.n_ctx || 0;
  renderUsage();
}

// Atualiza silenciosamente os dados do modelo (n_ctx etc.) direto do endpoint,
// sem mexer no dropdown — chamado a cada nova requisição para manter o contexto fresco.
async function refreshModelContext() {
  const { apiUrl, apiKey, model } = state.settings;
  if (!model) return;
  try {
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${apiUrl}/models`, { headers });
    if (!res.ok) return;
    const json = await res.json();
    const models = json.data || [];
    const m = models.find(x => x.id === model) || models[0];
    if (m) updateModelInfo(m);
    detectVision(json, model);
  } catch (e) { /* silencioso: não atrapalha o envio */ }
}

// --------------------------------------------------------------------------
//  Configurações (formulário do modal)
// --------------------------------------------------------------------------
function applySettingsToForm() {
  const s = state.settings;
  el('api-url').value = s.apiUrl;
  el('api-key').value = s.apiKey;
  el('range-temp').value = String(s.temperature);
  q<HTMLElement>('.range-value', el('range-temp').parentElement).innerText = String(s.temperature);
  el('range-topp').value = String(s.topP);
  q<HTMLElement>('.range-value', el('range-topp').parentElement).innerText = String(s.topP);
  el('input-maxtokens').value = String(s.maxTokens);
  el('input-cmdtimeout').value = String(s.cmdTimeout);
  el('check-safety-interactions').checked = s.safetyInteractions;
  el('check-websearch').checked = s.webSearch;
  el('check-vision').checked = s.visionFeedback;
  el('check-hide-console').checked = s.hideCommandConsole !== false;
  updateVisionStatus();
}

// Diz se o modelo escolhido aceita imagem — sem isso o usuário liga a opção e não
// entende por que os prints continuam voltando só como texto.
function updateVisionStatus() {
  const aviso = el('vision-status');
  if (!aviso) return;
  aviso.innerText = modelSupportsVision
    ? 'o modelo atual é multimodal.'
    : 'o modelo atual não anuncia suporte a imagem.';
}

function readSettingsFromForm() {
  state.settings.apiUrl = el('api-url').value.trim() || DEFAULT_SETTINGS.apiUrl;
  state.settings.apiKey = el('api-key').value.trim();
  state.settings.model = el('model-name').value;
  state.settings.temperature = parseFloat(el('range-temp').value);
  state.settings.topP = parseFloat(el('range-topp').value);
  state.settings.maxTokens = parseInt(el('input-maxtokens').value, 10) || DEFAULT_SETTINGS.maxTokens;
  state.settings.cmdTimeout = parseInt(el('input-cmdtimeout').value, 10) || DEFAULT_SETTINGS.cmdTimeout;
  // thinkLevel NÃO é lido daqui: ele mora no rodapé do compositor e já se grava sozinho ao
  // ser escolhido. Reler um campo que não existe mais no modal zeraria a escolha ao salvar.
  state.settings.safetyInteractions = el('check-safety-interactions').checked;
  state.settings.webSearch = el('check-websearch').checked;
  state.settings.visionFeedback = el('check-vision').checked;
  state.settings.hideCommandConsole = el('check-hide-console').checked;
}

// --------------------------------------------------------------------------
//  Pasta segura (workspace) — o agente só enxerga daqui para dentro
// --------------------------------------------------------------------------

// O caminho inteiro não cabe no cabeçalho e o começo (/home/fulano/...) é a parte que
// menos identifica a pasta — então o corte tira do começo, não do fim.
function encurtaCaminho(caminho, max = 44) {
  if (!caminho || caminho.length <= max) return caminho || 'Selecionar ambiente';
  return '…' + caminho.slice(-(max - 1));
}

function mostraCaminhoAtivo(caminho) {
  const alvo = el('selected-path');
  alvo.innerText = encurtaCaminho(caminho);
  alvo.title = caminho
    ? `Pasta segura deste chat: ${caminho}`
    : 'Nenhuma pasta segura definida — escolha uma para liberar o agente';
}

function registraPastaRecente(caminho) {
  state.recentPaths = [caminho, ...state.recentPaths.filter(p => p !== caminho)].slice(0, MAX_RECENT_PATHS);
}

// Ponto único de troca de workspace: o cache do autocomplete de @ é por pasta e ficaria
// apontando para a árvore antiga se a troca acontecesse em outro lugar.
function defineWorkspace(caminho) {
  if (!caminho) return;
  const chat = activeChat();
  if (chat.path === caminho) return;
  chat.path = caminho;
  mentionFiles = []; mentionFilesFor = null;
  registraPastaRecente(caminho);
  mostraCaminhoAtivo(caminho);
  logSystem(`Pasta segura definida para: ${caminho}`);
  updateInputState();
  persist();
}

function abreMenuPastas() {
  const menu = el('folder-menu');
  const atual = activeChat().path;
  menu.innerHTML = '';

  const recentes = state.recentPaths.filter(p => p !== atual);
  if (atual) {
    const titulo = document.createElement('div');
    titulo.className = 'folder-menu-title';
    titulo.innerText = 'Pasta atual';
    menu.appendChild(titulo);
    const item = document.createElement('div');
    item.className = 'folder-item atual';
    item.innerText = atual;
    item.title = atual;
    menu.appendChild(item);
  }

  if (recentes.length) {
    const titulo = document.createElement('div');
    titulo.className = 'folder-menu-title';
    titulo.innerText = 'Recentes';
    menu.appendChild(titulo);
    for (const caminho of recentes) {
      const item = document.createElement('div');
      item.className = 'folder-item';
      item.innerText = caminho;
      item.title = caminho;
      item.addEventListener('click', () => {
        menu.hidden = true;
        defineWorkspace(caminho);
      });
      menu.appendChild(item);
    }
  }

  const escolher = document.createElement('div');
  escolher.className = 'folder-item acao';
  escolher.innerText = '📂  Escolher outra pasta…';
  escolher.addEventListener('click', async () => {
    menu.hidden = true;
    defineWorkspace(await window.electronAPI.selectFolder());
  });
  menu.appendChild(escolher);

  menu.hidden = false;
}

// --------------------------------------------------------------------------
//  Ligação de eventos da interface
// --------------------------------------------------------------------------
function wireEvents() {
  // Detecta se o usuário está perto do fim: se rolar para cima, paramos de acompanhar
  const chatBox = el('chat-box');
  chatBox.addEventListener('scroll', () => {
    stickToBottom = (chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight) < 80;
  });

  el('btn-compactar').addEventListener('click', compactarAgora);

  // Trocar a pasta segura: o botão abre o menu de recentes; o diálogo nativo fica a um
  // clique dentro dele. Sem os recentes, alternar entre dois projetos exigia navegar a
  // árvore inteira no diálogo do sistema toda vez.
  const btnPasta = el('btn-select-folder');
  const menuPasta = el('folder-menu');

  btnPasta.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuPasta.hidden) abreMenuPastas(); else menuPasta.hidden = true;
  });

  document.addEventListener('click', (e) => {
    if (!menuPasta.hidden && !menuPasta.contains(e.target as Node)) menuPasta.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menuPasta.hidden) menuPasta.hidden = true;
  });

  // Enviar mensagem (com anexos, se houver)
  const inputEl = el('user-input');
  const autoGrow = () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  };
  const sendMessage = () => {
    if (isRunning) return;
    const prompt = inputEl.value.trim();
    if (!prompt && pendingAttachments.length === 0) return;
    const attachments = pendingAttachments.slice();
    inputEl.value = '';
    autoGrow();
    pendingAttachments = [];
    renderAttachments();
    submitUserMessage(prompt, attachments);
  };
  // Botão único: envia quando ocioso, para a geração quando o agente está rodando
  el('btn-send').addEventListener('click', () => {
    if (isRunning) stopAgent();
    else sendMessage();
  });
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (handleMentionKeydown(e)) return; // o menu de menção captura setas/Enter/Tab/Esc
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Autocomplete de menção de arquivo (@): abre/atualiza conforme o texto e o cursor
  inputEl.addEventListener('input', () => updateMentionMenu());
  inputEl.addEventListener('click', () => updateMentionMenu());
  inputEl.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionMenu();
  });
  inputEl.addEventListener('blur', () => setTimeout(closeMention, 120));

  // Anexar arquivos: botão + seletor nativo
  const fileInput = el('file-input');
  el('btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

  // Anexar arquivos: arrastar-e-soltar sobre a área principal
  const dropZone = document.querySelector('.main-content');
  const overlay = el('drop-overlay');
  let dragDepth = 0;
  dropZone.addEventListener('dragenter', (e: DragEvent) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault(); dragDepth++; overlay.classList.add('active');
  });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
  dropZone.addEventListener('dragleave', (e) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.remove('active');
  });
  dropZone.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault(); dragDepth = 0; overlay.classList.remove('active');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // Novo chat
  document.querySelector('.btn-new-chat').addEventListener('click', () => {
    createChat('Novo Chat');
    renderChatList();
    renderActiveChat();
    persist();
  });

  // Abas do modal
  const tabButtons = document.querySelectorAll('.nav-tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabPanels.forEach(panel => panel.classList.remove('active'));
      button.classList.add('active');
      el(button.getAttribute('data-tab')).classList.add('active');
    });
  });

  // Abrir/fechar modal
  const modal = el('settings-modal');
  el('btn-open-settings').addEventListener('click', () => {
    applySettingsToForm();
    modal.classList.add('active');
    fetchModels();
  });
  const closeModal = () => modal.classList.remove('active');
  el('btn-close-modal').addEventListener('click', closeModal);
  el('btn-save-settings').addEventListener('click', () => {
    readSettingsFromForm();
    persist();
    closeModal();
    logSystem('Configurações salvas.');
  });

  // Recarregar modelos manualmente
  el('btn-refresh-models').addEventListener('click', fetchModels);

  // Atualiza a info do modelo ao trocar a seleção
  el('model-name').addEventListener('change', (e) => {
    state.settings.model = (e.target as HTMLSelectElement).value;
  });

  // Toggle Auto/Manual de execução de comandos
  el('exec-mode').addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('.exec-opt');
    if (!opt) return;
    state.settings.execMode = opt.dataset.mode as ExecMode;
    updateExecModeUI();
    persist();
  });

  // Menu de nível de raciocínio
  el('btn-think').addEventListener('click', (e) => {
    e.stopPropagation(); // senão o clique fecha o menu que ele acabou de abrir
    const menu = el('think-menu');
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.think-picker')) fechaThinkMenu();
  });

  // Modal de confirmação de execução
  el('confirm-approve').addEventListener('click', () => resolveConfirm('approve'));
  el('confirm-always').addEventListener('click', () => resolveConfirm('always'));
  el('confirm-reject').addEventListener('click', () => resolveConfirm('reject'));
  el('confirm-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); resolveConfirm('approve'); }
    if (e.key === 'Escape') { e.preventDefault(); resolveConfirm('reject'); }
  });

  // Painel de processos
  el('btn-processes').addEventListener('click', openProcessesModal);
  el('btn-close-processes').addEventListener('click', closeProcessesModal);
  el('btn-clear-finished').addEventListener('click', clearFinishedProcesses);

  // Renomear o chat ativo pelo título do cabeçalho (duplo clique)
  el('active-chat-title').addEventListener('dblclick', renameActiveChat);

  // Botão do GitHub (abre a URL do package.json no navegador externo via window.open,
  // que passa pelo setWindowOpenHandler do main.js)
  el('btn-github').addEventListener('click', () => {
    if (appInfo.githubUrl) window.open(appInfo.githubUrl, '_blank');
  });

  // Atualiza o contador de processos periodicamente (badge no cabeçalho)
  setInterval(refreshProcesses, 3000);
}

// Informações do app (URL do GitHub etc.) lidas do package.json via IPC
let appInfo = { githubUrl: '', version: '', name: '' };
async function loadAppInfo() {
  try { appInfo = await window.electronAPI.getAppInfo(); } catch (e) { /* ignora */ }
  const gh = el('btn-github');
  if (gh) gh.style.display = appInfo.githubUrl ? '' : 'none'; // esconde se não houver URL configurada
}

// --------------------------------------------------------------------------
//  Inicialização
// --------------------------------------------------------------------------
async function init() {
  await loadPersisted();
  wireEvents();
  renderChatList();
  renderActiveChat();
  renderAttachments();
  renderUsage();
  updateExecModeUI();   // reflete o modo salvo (auto/manual)
  buildThinkMenu();     // monta o menu a partir de THINK_LEVELS
  updateThinkUI();      // reflete o nível de raciocínio salvo
  refreshProcesses();   // popula o badge de processos
  loadAppInfo();        // carrega URL do GitHub etc. do package.json
  // Tenta descobrir os modelos do endpoint padrão já na abertura
  fetchModels();
}

init();
