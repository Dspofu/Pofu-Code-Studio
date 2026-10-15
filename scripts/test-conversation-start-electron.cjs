// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.

const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const profile = mkdtempSync(join(tmpdir(), 'pofu-conversation-start-'));
const workspace = join(profile, 'project'); mkdirSync(workspace);
const captures = process.env.POFU_QA_OUTPUT || join(profile, 'captures'); mkdirSync(captures, { recursive: true });
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(Response.json({}, { status: 404 })) : originalFetch(url, ...args);
let metadataReady = false, llamaMetadata = false, blockedProps = 0, mode = 'reply', blockedSave = false, releaseSave, saveEntered;
const metadataWaiters = new Set(), pendingResponses = [], requests = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, channel === 'save-store' ? async (...args) => {
  if (blockedSave) { blockedSave = false; saveEntered?.(); await new Promise(resolve => { releaseSave = resolve; }); }
  return handler(...args);
} : handler);
const modelData = () => JSON.stringify({ data: [
  { id: 'fixture', ...(llamaMetadata ? { owned_by: 'llamacpp' } : {}), meta: { n_ctx: 32768 } },
  { id: 'other', owned_by: 'llamacpp' }
] });
function respond(res, content) {
  if (res.destroyed) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205 } }) + '\n\ndata: [DONE]\n\n');
}
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.end();
  if (llamaMetadata && req.url.endsWith('/props')) { blockedProps++; return; }
  if (req.url.endsWith('/models')) {
    if (metadataReady) return res.end(modelData());
    metadataWaiters.add(res);
    res.on('close', () => metadataWaiters.delete(res));
    return;
  }
  if (!req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push({ body, time: Date.now() });
  const content = 'RESPOSTA ' + body.messages.at(-1).content;
  if (mode === 'reply') return respond(res, content);
  pendingResponses.push({ res, content });
  if (mode === 'progress') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: ' + JSON.stringify({ choices: [], prompt_progress: { total: 500, cache: 100, processed: 230 } }) + '\n\n');
  } else if (mode === 'stream') {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(': connected\n\n');
  }
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({
    settings: { providers: [{ id: 'p', name: 'API de teste', apiUrl: origin + '/v1', apiKey: '', model: 'fixture', thinkLevel: 'padrao' }],
      activeProviderId: 'p', maxTokens: 1024, webSearch: false },
    activeChatId: 'chat', chats: { chat: { id: 'chat', name: 'Início da conversa', path: workspace, messages: [] } }
  }));
  await import(pathToFileURL(resolve('out/main.js'))); await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
  const js = code => win.webContents.executeJavaScript(code);
  async function until(code, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Tempo excedido: ' + code + '\n' + await js("document.getElementById('chat-box').textContent.slice(-2500)"));
  }
  async function ready() {
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await until("import('./out/renderer.js').then(m=>m.activeChat()?.id==='chat' && m.studioRemoteSnapshot().providers.some(p=>p.model==='fixture'))");
  }
  const send = content => js("(() => { const input=document.getElementById('user-input');input.value=" + JSON.stringify(content)
    + ";input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()");
  const idle = () => until("!document.body.classList.contains('agent-running')");
  let passed = 0;
  const check = async (name, action) => { await action(); passed++; console.log('PASS ' + name); };
  async function capture(name, compact = false) {
    win.setContentSize(compact ? 820 : 1380, compact ? 680 : 820); win.showInactive();
    await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
    await js("document.getElementById('chat-box').scrollTop=document.getElementById('chat-box').scrollHeight");
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(captures, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.hide();
  }
  await ready();
  await check('primeiro envio mostra consulta imediatamente e metadados presos não bloqueiam a API', async () => {
    const start = Date.now(); await send('PRIMEIRO');
    await until("document.querySelector('.typing-etapa')?.textContent==='Consultando o modelo'", 500);
    assert.ok(Date.now() - start < 500);
    assert.equal(await js("document.querySelectorAll('#typing-indicator').length"), 1);
    assert.equal(await js("document.querySelector('.typing-relogio').textContent"), '0:00 de espera');
    await capture('consulta-modelo');
    await until("document.getElementById('chat-box').textContent.includes('RESPOSTA PRIMEIRO')"); await idle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.return_progress, true, 'return_progress vai por padrão: mantém o túnel vivo no prefill mesmo sem detecção do llama.cpp');
    assert.ok(requests[0].time - start >= 4800, 'a consulta deve aguardar o prazo real de cinco segundos');
    assert.ok(requests[0].time - start < 7000, 'metadados presos não podem impedir o envio');
    assert.equal(await js("document.querySelector('#typing-indicator')===null"), true);
    assert.equal(await js("document.getElementById('chat-box').textContent.includes('usar uma estimativa')"), true);
    assert.equal(await js("document.getElementById('info-model-status').textContent.includes('passou de 5s')"), true);
  });
  await check('Parar durante a descoberta cancela a espera sem enviar o prompt', async () => {
    win.reload(); await ready();
    const before = requests.length; await send('CANCELAR CONSULTA');
    await until("document.querySelector('.typing-etapa')?.textContent==='Consultando o modelo'");
    const start = Date.now(); await js("document.getElementById('btn-send').click()"); await idle();
    assert.ok(Date.now() - start < 1500);
    assert.equal(requests.length, before);
    assert.equal(await js("document.querySelector('#typing-indicator')===null"), true);
    metadataReady = true;
    for (const res of metadataWaiters) if (!res.destroyed) res.end(modelData());
    await until("document.getElementById('info-model-name').textContent.includes('fixture')");
  });
  await check('salvamento inicial mostra preparação e não duplica o indicador', async () => {
    blockedSave = true; const entered = new Promise(resolve => { saveEntered = resolve; });
    await send('PREPARAÇÃO'); await entered;
    await until("document.querySelector('.typing-etapa')?.textContent==='Preparando conversa'");
    assert.equal(await js("document.querySelectorAll('#typing-indicator').length"), 1);
    await capture('preparando-conversa'); releaseSave();
    await until("document.getElementById('chat-box').textContent.includes('RESPOSTA PREPARAÇÃO')"); await idle();
  });
  await check('espera sem headers mostra relógio e aviso após dez segundos sem repetir o POST', async () => {
    mode = 'headers'; const before = requests.length; await send('ESPERA');
    await until("document.querySelector('.typing-etapa')?.textContent==='Aguardando o modelo'");
    await until("document.querySelector('.typing-relogio')?.textContent.startsWith('0:01')");
    await until("document.querySelector('.typing-indicator')?.classList.contains('typing-slow')");
    assert.ok(Date.now() - requests.at(-1).time >= 9800);
    assert.equal(requests.length, before + 1);
    assert.equal(await js("document.querySelector('.typing-detalhe').textContent.includes('Use Parar')"), true);
    assert.equal(await js("document.querySelector('.typing-detalhe').textContent.includes('não informou o estado')"), true);
    assert.equal(await js("document.querySelector('.typing-indicator').getAttribute('role')"), 'status');
    await capture('aguardando-modelo');
    await capture('aguardando-modelo-compacto', true);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("(() => { const indicator=document.getElementById('typing-indicator').getBoundingClientRect();const chat=document.getElementById('chat-box').getBoundingClientRect();return indicator.top>=chat.top && indicator.bottom<=chat.bottom; })()"), true);
    const pending = pendingResponses.pop(); respond(pending.res, pending.content);
    await until("document.getElementById('chat-box').textContent.includes('RESPOSTA ESPERA')"); await idle();
    const stats = await js("import('./out/renderer.js').then(m=>m.activeChat().messages.findLast(x=>x.role==='assistant').stats)");
    assert.ok(stats.ttftSec >= 9.8, 'tempo até o primeiro token precisa incluir a espera pelos headers');
    assert.equal(await js("document.querySelector('#typing-indicator')===null"), true);
  });
  await check('Parar cancela também o stream conectado sem texto', async () => {
    mode = 'stream'; const before = requests.length; await send('SEM TEXTO');
    await until("document.querySelector('.typing-etapa')?.textContent==='Conexão aberta'");
    assert.equal(await js("document.querySelector('.typing-detalhe').textContent.includes('não informou o estado')"), true);
    await until("document.querySelector('.typing-relogio')?.textContent.startsWith('0:01')");
    const start = Date.now(); await js("document.getElementById('btn-send').click()"); await idle();
    assert.ok(Date.now() - start < 1500); assert.equal(requests.length, before + 1);
    assert.equal(await js("document.querySelector('#typing-indicator')===null"), true);
  });
  await check('prompt pequeno também mostra progresso real do servidor', async () => {
    mode = 'progress'; await send('PROGRESSO');
    await until("document.querySelector('.typing-progresso')?.textContent.includes('230 de 500')");
    assert.equal(await js("document.querySelector('.typing-etapa').textContent"), 'Lendo o contexto');
    assert.equal(await js("document.querySelector('.typing-detalhe').textContent"), 'Progresso informado pela API.');
    assert.equal(await js("document.querySelector('.typing-progresso').textContent"), '46% · 230 de 500 tokens · 100 em cache');
    assert.equal(await js("document.querySelector('.typing-bar').value/document.querySelector('.typing-bar').max"), 0.46);
    await capture('progresso-contexto');
    await capture('progresso-contexto-compacto', true);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    pendingResponses.at(-1).res.write('data: ' + JSON.stringify({ choices: [], prompt_progress: { total: 500, cache: 100, processed: -2 } }) + '\n\n');
    pendingResponses.at(-1).res.write('data: ' + JSON.stringify({ choices: [], prompt_progress: { total: 500, cache: 100, processed: 700 } }) + '\n\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js("document.querySelector('.typing-bar').value"), 230, 'progresso inválido não altera o último estado confirmado');
  });
  await check('progresso antigo avisa falta de atualização e conclusão do contexto aguarda os tokens', async () => {
    await until("document.querySelector('.typing-indicator')?.classList.contains('typing-slow')");
    assert.equal(await js("document.querySelector('.typing-detalhe').textContent.includes('Sem novas atualizações')"), true);
    assert.equal(await js("document.querySelector('.typing-relogio').textContent.includes('atualização há')"), true);
    assert.equal(await js("document.querySelector('.typing-bar').value"), 230);
    const pending = pendingResponses.pop();
    pending.res.write('data: ' + JSON.stringify({ choices: [], prompt_progress: { total: 500, cache: 100, processed: 500 } }) + '\n\n');
    await until("document.querySelector('.typing-etapa')?.textContent==='Contexto processado'");
    assert.equal(await js("document.querySelector('.typing-bar').value"), 500);
    assert.equal(await js("document.querySelector('.typing-indicator').classList.contains('typing-slow')"), false);
    assert.equal(await js("document.querySelector('.typing-detalhe').textContent"), 'Esperando os primeiros tokens da resposta.');
    assert.equal(await js("document.querySelector('.typing-relogio').textContent.endsWith('atualização há 0s')"), true);
    await capture('contexto-processado');
    pending.res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: pending.content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    await until("document.getElementById('chat-box').textContent.includes('RESPOSTA PROGRESSO')"); await idle();
  });
  await check('primeiro pedido usa progresso anunciado pelo modelo mesmo com props pendente', async () => {
    llamaMetadata = true; win.reload(); await ready();
    await until("document.getElementById('info-model-ctx').textContent.includes('32.768')");
    const start = Date.now(); await send('PRIMEIRO PROGRESSO');
    await until("document.querySelector('.typing-progresso')?.textContent.includes('230 de 500')");
    assert.equal(requests.at(-1).body.return_progress, true);
    assert.ok(requests.at(-1).time - start < 2000, 'não deve esperar o props para pedir progresso');
    assert.ok(blockedProps > 0);
    await capture('primeiro-progresso');
    const pending = pendingResponses.pop();
    pending.res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: pending.content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    await until("document.getElementById('chat-box').textContent.includes('RESPOSTA PRIMEIRO PROGRESSO')"); await idle();
  });
  console.log('RESULT ' + passed + ' verificações do início da conversa passaram. Capturas: ' + captures);
}
main().then(() => { server.closeAllConnections(); server.close(); app.exit(0); }, error => {
  console.error(error); releaseSave?.(); server.closeAllConnections(); server.close(); app.exit(1);
});
setTimeout(() => { console.error('Tempo máximo do ensaio excedido.'); app.exit(1); }, 60000);
