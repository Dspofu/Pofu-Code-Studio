const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const profile = mkdtempSync(join(tmpdir(), 'pofu-reconnect-'));
const workspace = join(profile, 'project'); mkdirSync(workspace); app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(Response.json({}, { status: 404 })) : originalFetch(url, ...args);
let mode = 'retry', chatTimes = [], bodies = [], syncTimes = [], blockedSave = false, releaseSave, saveEntered;
// Retém o último salvamento para reproduzir um envio na janela de encerramento do turno.
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, channel === 'save-store' ? async (...args) => {
  if (blockedSave && bodies.at(-1)?.messages.at(-1)?.content === 'PRIMEIRA') { blockedSave = false; saveEntered?.(); await new Promise(ok => { releaseSave = ok; }); }
  return handler(...args);
} : handler);
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.end();
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture', meta: { n_ctx: 32768 } }] }));
  if (req.url.endsWith('/usage')) return res.end(JSON.stringify({ schema: 'ai-usage/v1', provider: { id: 'pofu', name: 'Fixture' }, cycle: { used: 750, limit: 3000 }, balances: [{ unit: 'credits', remaining: 2250, used: 750 }] }));
  if (req.url.endsWith('/claim')) return res.end(JSON.stringify({ deviceId: 'test-device', token: 'a'.repeat(64) }));
  if (req.url.endsWith('/sync')) { syncTimes.push(Date.now()); res.statusCode = syncTimes.length === 1 ? 503 : 200; return res.end(JSON.stringify({ commands: [], needsSnapshot: false })); }
  if (!req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  bodies.push(JSON.parse(raw)); chatTimes.push(Date.now());
  if (mode === 'auth' || mode === 'cancel' || mode === 'retry' && chatTimes.length === 1) { res.statusCode = mode === 'auth' ? 401 : 503; return res.end(JSON.stringify({ error: { message: 'Synthetic failure' } })); }
  res.setHeader('Content-Type', 'text/event-stream');
  const text = mode === 'empty' ? '' : 'RESPOSTA ' + bodies.at(-1).messages.at(-1).content;
  res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 8192, completion_tokens: 20, total_tokens: 8212 } }) + '\n\ndata: [DONE]\n\n');
});
async function main() {
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { providers: [{ id: 'p', name: 'Teste', apiUrl: origin + '/v1', apiKey: '', model: 'fixture', thinkLevel: 'padrao' }], activeProviderId: 'p' }, activeChatId: 'chat', chats: { chat: { id: 'chat', name: 'Projeto de teste', path: workspace, messages: [] } } }));
  await import(pathToFileURL(resolve('out/main.js'))); await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(ok => win.webContents.once('did-finish-load', ok));
  const js = code => win.webContents.executeJavaScript(code);
  async function until(code, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await js(code)) return; await new Promise(ok => setTimeout(ok, 30)); } throw new Error('Tempo excedido: ' + code); }
  const send = text => js(`(() => { const input=document.getElementById('user-input'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  const idle = () => until(`!document.body.classList.contains('agent-running')`);
  let passed = 0; const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  const output = 'node_modules/.cache/reconnect-ui'; mkdirSync(output, { recursive: true });
  async function capture(name) { win.setSize(1380, 860); win.showInactive(); await js(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`); writeFileSync(join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.hide(); }
  await until(`document.getElementById('info-model-name').textContent.includes('fixture')`);
  await check('falha transitória espera 10s e mostra contagem regressiva', async () => {
    await send('RECONEXÃO'); await until(`document.querySelector('.retry-countdown')?.textContent.includes('10s')`);
    await capture('reconexao'); await until(`document.querySelector('.retry-countdown')?.textContent.includes('9s')`);
    assert.equal(chatTimes.length, 1); await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA RECONEXÃO')`); await idle();
    assert.ok(chatTimes[1] - chatTimes[0] >= 9900); assert.equal(chatTimes.length, 2);
    assert.equal(await js(`document.querySelector('.retry-card')===null`), true);
  });
  await check('cancelar a espera encerra imediatamente sem reenviar', async () => {
    mode = 'cancel'; const before = chatTimes.length; await send('CANCELAR'); await until(`!!document.querySelector('.retry-card button')`);
    const start = Date.now(); await js(`document.querySelector('.retry-card button').click()`); await idle(); assert.ok(Date.now() - start < 1500); assert.equal(chatTimes.length, before + 1);
  });
  await check('erro de autenticação é claro e não entra em reconexão', async () => {
    mode = 'auth'; const before = chatTimes.length; await send('AUTH'); await idle();
    await until(`document.querySelector('.error-card-title:last-of-type') || document.getElementById('chat-box').textContent.includes('autenticação')`);
    assert.equal(chatTimes.length, before + 1); assert.equal(await js(`document.querySelector('.retry-card')===null`), true);
    assert.ok(await js(`document.getElementById('chat-box').textContent.includes('autenticação')`)); await capture('erro');
  });
  await check('continue no encerramento é entregue uma vez sem segundo envio', async () => {
    mode = 'success'; blockedSave = true; const entered = new Promise(ok => { saveEntered = ok; }); const before = bodies.length;
    await send('PRIMEIRA'); await entered; await send('continue'); releaseSave();
    await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA continue')`); await idle();
    assert.equal(bodies.length, before + 2); assert.equal(bodies.at(-1).messages.at(-1).content, 'continue');
    assert.equal(bodies.at(-1).messages.filter(m => m.role === 'user' && m.content === 'continue').length, 1);
  });
  await check('resposta vazia mostra orientação em vez de sumir', async () => {
    mode = 'empty'; await send('VAZIO'); await idle(); await until(`document.getElementById('chat-box').textContent.includes('O modelo não enviou uma resposta')`);
  });
  await check('medidores mostram contexto real e atalhos abrem a aba remota', async () => {
    assert.equal(await js(`document.querySelectorAll('.sidebar-remote button').length`), 1);
    await until(`document.getElementById('hdr-quota-percent').textContent==='25%'`);
    assert.equal(await js(`document.getElementById('hdr-ctx-percent').textContent`), '25%');
    await js(`document.getElementById('btn-sidebar-remote-toggle').click()`);
    assert.equal(await js(`document.getElementById('tab-remoto').classList.contains('active')`), true);
    assert.equal(await js(`document.activeElement.id`), 'remote-code'); await js(`document.getElementById('btn-close-modal').click()`);
  });
  await check('ponte espera 10s após falha e indica conexão ativa na lateral', async () => {
    await js(`window.electronAPI.remotePair(${JSON.stringify(origin)},'A123456789','PC de teste')`);
    await until(`document.getElementById('sidebar-remote-status').textContent.includes('10s')`);
    const deadline = await js(`window.electronAPI.remoteStatus().then(s=>s.retryAt)`); assert.ok(deadline - Date.now() > 9000);
    await until(`document.getElementById('sidebar-remote-status').textContent.includes('9s')`); assert.equal(syncTimes.length, 1);
    await until(`document.getElementById('remote-dot').classList.contains('online')`);
    assert.ok(syncTimes[1] - syncTimes[0] >= 9900); assert.equal(await js(`document.getElementById('sidebar-remote-status').textContent`), 'Conectado');
    await js(`document.getElementById('btn-open-settings').click();document.querySelector('[data-tab="tab-remoto"]').click();document.getElementById('remote-code').value='INVALIDO';document.getElementById('btn-remote-pair').click()`);
    await until(`document.getElementById('remote-status').textContent.includes('10 caracteres')`);
    await new Promise(ok => setTimeout(ok, 350));
    assert.ok(await js(`document.getElementById('remote-status').textContent.includes('10 caracteres')`));
    assert.equal(await js(`document.getElementById('remote-dot').classList.contains('online')`), true);
    await js(`document.getElementById('btn-close-modal').click()`);
    await capture('conectado'); await js(`document.getElementById('btn-sidebar-remote-toggle').click()`);
    await until(`window.electronAPI.remoteStatus().then(s=>!s.enabled&&s.retryAt===null)`);
    assert.equal(await js(`document.getElementById('sidebar-remote-action').textContent`), 'Ligar');
    assert.equal(await js(`document.getElementById('sidebar-remote-status').textContent`), 'Sem conexão');
    await js(`document.getElementById('btn-sidebar-remote-toggle').click()`);
    await until(`document.getElementById('remote-dot').classList.contains('online')`);
    assert.equal(await js(`document.getElementById('btn-sidebar-remote-toggle').getAttribute('aria-pressed')`), 'true');
    await js(`document.getElementById('btn-sidebar-remote-toggle').click()`);
  });
  console.log('RESULT ' + passed + ' verificações de reconexão, fila e interface passaram.');
}
main().then(() => { server.closeAllConnections(); server.close(); app.exit(0); }, err => { console.error(err); server.closeAllConnections(); server.close(); app.exit(1); });
setTimeout(() => { console.error('Tempo máximo do ensaio excedido.'); app.exit(1); }, 90000);
