// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep, basename } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const endpoint = (process.env.POFU_TEST_API_URL || process.env.POFU_TEST_API || 'http://localhost:5001/v1').replace(/\/+$/, '');
const key = process.env.POFU_TEST_API_KEY || process.env.POFU_TEST_KEY;
const timeout = Number(process.env.POFU_TEST_TIMEOUT_MS || 180000);
if (!key) { console.error('Defina POFU_TEST_API_KEY. Este ensaio usa uma API real.'); process.exit(2); }
if (!Number.isFinite(timeout) || timeout < 30000 || timeout > 600000) { console.error('POFU_TEST_TIMEOUT_MS deve ficar entre 30000 e 600000.'); process.exit(2); }
const profile = mkdtempSync(join(tmpdir(), 'pofu-subagents-real-'));
const workspace = join(profile, 'project'); mkdirSync(workspace);
const captures = process.env.POFU_QA_OUTPUT || mkdtempSync(join(tmpdir(), 'pofu-subagents-real-qa-'));
mkdirSync(captures, { recursive: true });
const fixtures = {
  'auth.js': `export function canReadAccount(user, accountId) {\n  if (!user) return true;\n  return user.accountId === accountId;\n}\n`,
  'billing.js': `export function invoiceTotal(items) {\n  return items.reduce((total, item) => total + item.price, 0);\n}\n`
};
for (const [name, content] of Object.entries(fixtures)) writeFileSync(join(workspace, name), content);
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(Response.json({}, { status: 404 })) : originalFetch(url, ...args);
let memoryStore, window, progress;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel,
  channel === 'load-store' ? async event => { await handler(event); return memoryStore; } :
  channel === 'save-store' ? async (event, data) => {
    const saved = await handler(event, { settings: { computerUse: false } });
    if (saved.success) memoryStore = data;
    return saved;
  } : channel === 'record-usage' ? async () => ({ success: true }) :
  ['write-file', 'edit-file', 'delete-file', 'create-directory', 'execute-command', 'computer-action'].includes(channel)
    ? async () => ({ success: false, error: 'This test only permits read-only inspection.' }) : handler);

const prompt = `Faça uma revisão somente de leitura deste projeto e use obrigatoriamente a ferramenta delegate_tasks uma vez, com exatamente dois subagentes em paralelo.
Primeiro subagente: leia auth.js e revise a autorização de canReadAccount. Informe o comportamento para um usuário ausente, a falha encontrada e uma recomendação, citando arquivo e linha.
Segundo subagente: leia billing.js e revise invoiceTotal. Cada item pode conter price e quantity. Informe se o cálculo está correto para quantity maior que 1, explique a falha e recomende uma correção, citando arquivo e linha.
Cada subagente deve consultar o arquivo com read_file ou search_files e devolver sua própria conclusão. Passe tarefas completas e independentes. Depois reúna as duas conclusões em uma resposta curta em português. Não altere arquivos, não execute comandos e não use o controle do computador.`;

async function main() {
  const response = await fetch(endpoint + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('A descoberta de modelos falhou com HTTP ' + response.status);
  const discovered = await response.json();
  const model = process.env.POFU_TEST_MODEL || discovered.data?.[0]?.id;
  if (!model) throw new Error('A API não retornou um modelo. Defina POFU_TEST_MODEL.');
  const thinkLevel = process.env.POFU_TEST_THINK || 'baixo';
  const maxTokens = Number(process.env.POFU_TEST_MAX_TOKENS || 8192);
  memoryStore = { settings: { apiUrl: endpoint, apiKey: key, model, thinkLevel, maxTokens,
    execMode: 'manual', temperature: 0.1, topP: 0.9, webSearch: false, computerUse: false },
    chats: { real: { id: 'real', name: 'Revisão com subagentes', path: workspace, messages: [] } }, activeChatId: 'real' };
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { computerUse: false } }));
  await import(pathToFileURL(resolve('out/main.js'))); ipcMain.handle = originalHandle;
  await app.whenReady(); window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false);
  if (window.webContents.isLoading()) await new Promise(ok => window.webContents.once('did-finish-load', ok));
  const js = code => window.webContents.executeJavaScript(code);
  async function until(code, deadline = Date.now() + 15000) {
    while (Date.now() < deadline) { if (await js(code)) return; await new Promise(ok => setTimeout(ok, 100)); }
    throw new Error('Tempo excedido: ' + code);
  }
  await until(`import('./out/renderer.js').then(m=>m.studioRemoteSnapshot().providers.some(provider=>provider.model===${JSON.stringify(model)}) && m.activeTools().some(tool=>tool.function.name==='delegate_tasks'))`);
  await js(`(() => {
    const original = window.fetch;
    window.__subagentRequests = [];
    window.__subagentResponseReads = [];
    window.fetch = (url, options) => {
      const tracked = String(url).includes('/chat/completions') && typeof options?.body==='string';
      let entry;
      if (tracked) { entry={body:JSON.parse(options.body),started:Date.now()}; window.__subagentRequests.push(entry); }
      return original(url, options).then(response => {
        if (entry) {
          entry.status=response.status;
          window.__subagentResponseReads.push(response.clone().text().then(raw => {
            entry.ended=Date.now();
            for(const line of raw.split('\\n')) {
              if(!line.startsWith('data:') || line.includes('[DONE]')) continue;
              try { const event=JSON.parse(line.slice(5).trim()); if(event.usage) entry.usage=event.usage; } catch {}
            }
          }).catch(()=>{}));
        }
        return response;
      },error=>{ if(entry) {entry.failed=true;entry.ended=Date.now();} throw error; });
    };
  })()`);
  const started = Date.now();
  console.log('START subagentes reais · modelo ' + model + ' · raciocínio ' + thinkLevel);
  await js(`(() => { const input=document.getElementById('user-input');input.value=${JSON.stringify(prompt)};input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
  await until(`document.body.classList.contains('agent-running')`, started + 10000);
  progress = setInterval(() => console.log('PROGRESS subagentes reais · ' + Math.round((Date.now() - started) / 1000) + 's'), 30000);
  try { await until(`!document.body.classList.contains('agent-running')`, started + timeout); }
  catch (error) {
    await js(`document.getElementById('user-input').value='';document.getElementById('user-input').dispatchEvent(new Event('input'));document.getElementById('btn-send').click()`);
    await until(`!document.body.classList.contains('agent-running')`, Date.now() + 10000);
    throw error;
  } finally { clearInterval(progress); }
  await js(`Promise.race([Promise.allSettled(window.__subagentResponseReads),new Promise(ok=>setTimeout(ok,5000))])`);
  const requests = await js(`window.__subagentRequests`);
  const messages = await js(`import('./out/renderer.js').then(m=>m.activeChat().messages)`);
  const delegated = messages.filter(message => message.role === 'tool' && message.name === 'delegate_tasks');
  const result = delegated[0] && JSON.parse(delegated[0].content);
  const workers = result?.agents || [];
  const summaries = workers.map(worker => worker.result || '');
  const parentCalls = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
  const childRequests = requests.filter(request => !request.body.tools?.some(tool => tool.function.name === 'delegate_tasks'));
  const groups = new Map();
  for (const request of childRequests) {
    const assignment = request.body.messages.find(message => message.role === 'user')?.content;
    if (!groups.has(assignment)) groups.set(assignment, []);
    groups.get(assignment).push(request);
  }
  const findings = {
    auth: summaries.some(summary => /auth\.js/i.test(summary) && /!user|true|verdadeir|ausente|nulo|sem\s+usu[aá]rio|sem\s+autentic|n[aã]o\s+autentic|an[oô]nim|unauthenticated|null/i.test(summary)),
    billing: summaries.some(summary => /billing\.js/i.test(summary) && /quantity|quantidade/i.test(summary))
  };
  const final = messages.filter(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()).at(-1)?.content || '';
  const report = { model, thinkLevel, seconds: Math.round((Date.now() - started) / 1000), requests: requests.length,
    childRequests: childRequests.length, agents: workers.map(worker => ({ name: worker.name, status: worker.status, turns: worker.turns, tool_calls: worker.tool_calls })),
    promptTokens: requests.reduce((total, request) => total + (request.usage?.prompt_tokens || 0), 0),
    completionTokens: requests.reduce((total, request) => total + (request.usage?.completion_tokens || 0), 0), findings, final };
  writeFileSync(join(captures, 'subagentes-real.json'), JSON.stringify(report, null, 2));
  window.setContentSize(1380, 820); window.showInactive();
  await js(`document.querySelectorAll('.subagent-row details').forEach(details=>details.open=false);const chat=document.getElementById('chat-box');chat.scrollTop=chat.scrollHeight;new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
  writeFileSync(join(captures, 'subagentes-real.png'), (await window.webContents.capturePage()).toPNG()); window.hide();
  window.showInactive();
  await js(`document.querySelector('.subagents-panel')?.parentElement.scrollIntoView({block:'start'});new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
  writeFileSync(join(captures, 'subagentes-real-painel.png'), (await window.webContents.capturePage()).toPNG());
  await js(`const first=document.querySelector('.subagent-row details');if(first) first.open=true;document.querySelector('.subagents-panel')?.parentElement.scrollIntoView({block:'start'});new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
  writeFileSync(join(captures, 'subagentes-real-resultado.png'), (await window.webContents.capturePage()).toPNG()); window.hide();
  console.log('RESULT ' + JSON.stringify(report));
  console.log('CAPTURES ' + captures);
  assert.equal(delegated.length, 1, 'o pai deve delegar uma vez');
  assert.equal(workers.length, 2, 'a delegação deve criar duas crianças');
  assert.ok(workers.every(worker => worker.status === 'completed'), 'as duas crianças devem concluir');
  assert.equal(await js(`document.querySelectorAll('.subagent-row[data-status="completed"]').length`), 2, 'o painel deve mostrar as duas conclusões');
  assert.equal(groups.size, 2, 'as crianças devem ter tarefas e históricos distintos');
  for (const group of groups.values()) {
    const calls = group.flatMap(request => request.body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []));
    assert.ok(calls.some(call => ['read_file','search_files'].includes(call.function.name)), 'cada criança deve inspecionar arquivos');
    assert.ok(group.every(request => request.body.messages.filter(message => message.role === 'user').length === 1));
  }
  const workerHistories = [...groups.values()].map(group => new Set(group.flatMap(request => request.body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))));
  assert.ok(![...workerHistories[0]].some(id => workerHistories[1].has(id)), 'resultados de ferramentas não podem atravessar históricos');
  assert.ok(findings.auth && findings.billing, 'conclusões devem identificar as duas falhas');
  assert.match(final, /auth\.js/i); assert.match(final, /billing\.js/i);
  assert.ok(parentCalls.every(call => ['delegate_tasks','read_file','search_files','list_files','list_definitions','read_tool_result'].includes(call.function.name)), 'o pai deve manter a revisão somente de leitura');
  for (const [name, content] of Object.entries(fixtures)) assert.equal(readFileSync(join(workspace, name), 'utf8'), content);
  const onDisk = readFileSync(join(profile, 'app-store.json'), 'utf8'); assert.ok(!onDisk.includes(key), 'a chave não pode ser persistida');
  console.log('PASS revisão real com duas crianças independentes e arquivos preservados');
}

function cleanup() {
  clearInterval(progress); window?.destroy(); memoryStore = null;
  const target = resolve(profile), temporary = resolve(tmpdir());
  if (target.startsWith(temporary + sep) && basename(target).startsWith('pofu-subagents-real-')) {
    try { rmSync(target, { recursive: true, force: true }); } catch {}
  }
}
main().then(() => { cleanup(); app.exit(0); }, error => { console.error(error); cleanup(); app.exit(1); });
setTimeout(() => { console.error('Tempo máximo do ensaio real excedido.'); cleanup(); app.exit(1); }, timeout + 45000);
