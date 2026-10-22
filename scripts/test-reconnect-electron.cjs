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
const PARCIAL = 'O projeto se divide em três partes: o processo **main**, que cuida das janelas e do acesso a arquivos; o **preload**, que expõe essas capacidades à interface; e o';
// Chat salvo com o app fechado no meio de uma ferramenta: a chamada ficou sem resposta.
const ORFAO = { id: 'orfao', name: 'Chat com chamada sem resposta', path: workspace, messages: [{ role: 'user', content: 'Capture a página' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_orfa', type: 'function', function: { name: 'capture_page', arguments: '{"url":"http://127.0.0.1:9/"}' } }] }] };
let mode = 'retry', falhaUnica = false, quedas = 0, chatTimes = [], bodies = [], syncTimes = [], blockedSave = false, releaseSave, saveEntered;
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
  if (req.url.endsWith('/props')) return res.end(JSON.stringify({ default_generation_settings: {}, chat_template: '' }));
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture', meta: { n_ctx: 32768 } }] }));
  if (req.url.endsWith('/usage')) return res.end(JSON.stringify({ schema: 'ai-usage/v1', provider: { id: 'pofu', name: 'Fixture' }, cycle: { used: 750, limit: 3000 }, balances: [{ unit: 'credits', remaining: 2250, used: 750 }] }));
  if (req.url.endsWith('/claim')) return res.end(JSON.stringify({ deviceId: 'test-device', token: 'a'.repeat(64) }));
  if (req.url.endsWith('/sync')) { syncTimes.push(Date.now()); res.statusCode = syncTimes.length === 1 ? 503 : 200; return res.end(JSON.stringify({ commands: [], needsSnapshot: false })); }
  if (!req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); bodies.push(body); chatTimes.push(Date.now());
  const unica = falhaUnica; falhaUnica = false;
  // Gateway estrito: recusa o return_progress e, sem ele, recusa a requisição por outro motivo.
  if (mode === 'progress-refuse') { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: body.return_progress ? 'unknown field: return_progress' : 'invalid argument: messages[1]' } })); }
  // O Chromium reenvia sozinho o que caiu num socket keep-alive reaproveitado: derrubar duas
  // seguidas garante que a queda chegue ao app, com ou sem esse reenvio.
  if (quedas > 0) { quedas--; return req.socket.destroy(); }
  if (mode === 'auth' || mode === 'cancel' || mode === 'retry' && chatTimes.length === 1 || mode === 'fail-once' && unica) { res.statusCode = mode === 'auth' ? 401 : 503; return res.end(JSON.stringify({ error: { message: 'Synthetic failure' } })); }
  res.setHeader('Content-Type', 'text/event-stream');
  if (mode === 'stall' || mode === 'stall-once' && unica) { res.write('data: ' + JSON.stringify({ choices: [], prompt_progress: { total: 5000, cache: 0, processed: 2403, time_ms: 10 } }) + '\n\n'); return; }
  if (mode === 'cut' && unica) return res.end();
  // Conexão que fecha no meio: sem finish_reason, sem usage e sem [DONE].
  if (mode === 'cut-text' && unica) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: PARCIAL } }] }) + '\n\n'); return res.end(); }
  if (mode === 'cut-tool' && unica) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { name: 'read_file', arguments: '{"filename": "pac' } }] } }] }) + '\n\n'); return res.end(); }
  const vazio = mode === 'empty' || mode === 'reasoning' || mode === 'empty-once' && unica;
  const delta = mode === 'reasoning' ? { reasoning_content: 'Vou pensar e parar.' } : { content: vazio ? '' : 'RESPOSTA ' + bodies.at(-1).messages.at(-1).content };
  res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }], usage: { prompt_tokens: 8192, completion_tokens: 20, total_tokens: 8212 } }) + '\n\ndata: [DONE]\n\n');
});
async function main() {
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { providers: [{ id: 'p', name: 'Teste', apiUrl: origin + '/v1', apiKey: '', model: 'fixture', thinkLevel: 'padrao' }], activeProviderId: 'p' }, activeChatId: 'chat', chats: { chat: { id: 'chat', name: 'Projeto de teste', path: workspace, messages: [] }, orfao: ORFAO } }));
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
  await check('falha transitória espera o primeiro degrau (2s) e mostra contagem regressiva', async () => {
    await send('RECONEXÃO'); await until(`document.querySelector('.retry-countdown')?.textContent.includes('2s')`);
    assert.ok(await js(`document.querySelector('.retry-countdown').textContent.includes('tentativa 2 de 6')`));
    await capture('reconexao'); await until(`document.querySelector('.retry-countdown')?.textContent.includes('1s')`);
    assert.equal(chatTimes.length, 1); await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA RECONEXÃO')`); await idle();
    assert.ok(chatTimes[1] - chatTimes[0] >= 1900); assert.equal(chatTimes.length, 2);
    assert.equal(await js(`document.querySelector('.retry-card')===null`), true);
    assert.equal(await js(`document.getElementById('continuar-barra')===null`), true, 'resposta completa não oferece continuar');
  });
  await check('Tentar agora pula a espera', async () => {
    mode = 'fail-once'; falhaUnica = true; const before = chatTimes.length; await send('AGORA');
    await until(`!!document.querySelector('.retry-card .retry-agora')`); await js(`document.querySelector('.retry-card .retry-agora').click()`);
    await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA AGORA')`); await idle();
    assert.equal(chatTimes.length, before + 2); assert.ok(chatTimes.at(-1) - chatTimes.at(-2) < 1500, 'não deve esperar a contagem');
  });
  await check('queda de conexão com um servidor que já respondia é repetida', async () => {
    mode = 'success'; quedas = 2; const before = bodies.length; await send('QUEDA');
    await until(`document.querySelector('.retry-card')?.textContent.includes('A conexão com o servidor do modelo caiu')`);
    await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA QUEDA')`, 20000); await idle();
    assert.equal(bodies.length, before + 3);
  });
  await check('cancelar a espera encerra imediatamente sem reenviar', async () => {
    mode = 'cancel'; const before = chatTimes.length; await send('CANCELAR'); await until(`!!document.querySelector('.retry-card .retry-cancelar')`);
    const start = Date.now(); await js(`document.querySelector('.retry-card .retry-cancelar').click()`); await idle(); assert.ok(Date.now() - start < 1500); assert.equal(chatTimes.length, before + 1);
  });
  await check('erro de autenticação é claro e não entra em reconexão', async () => {
    mode = 'auth'; const before = chatTimes.length; await send('AUTH'); await idle();
    await until(`document.querySelector('.error-card-title:last-of-type') || document.getElementById('chat-box').textContent.includes('autenticação')`);
    assert.equal(chatTimes.length, before + 1); assert.equal(await js(`document.querySelector('.retry-card')===null`), true);
    assert.ok(await js(`document.getElementById('chat-box').textContent.includes('autenticação')`)); await capture('erro');
  });
  await check('depois do erro, Continuar de onde parou roda o agente sem mensagem nova', async () => {
    await until(`!!document.querySelector('#continuar-barra .continuar-btn')`);
    mode = 'success'; const before = bodies.length;
    await js(`document.querySelector('#continuar-barra .continuar-btn').click()`);
    await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA AUTH')`); await idle();
    assert.equal(bodies.length, before + 1); assert.equal(bodies.at(-1).messages.at(-1).content, 'AUTH', 'pedido sem resposta não precisa de mensagem nova');
    assert.equal(await js(`document.getElementById('continuar-barra')===null`), true);
  });
  await check('resposta cortada pela conexão avisa, e o Continuar pede ao modelo que siga', async () => {
    // Chat novo só para a captura do README sair sem os cenários anteriores.
    await js(`document.querySelector('.btn-new-chat').click()`);
    mode = 'cut-text'; falhaUnica = true; await send('Explique a estrutura deste projeto'); await idle();
    await until(`document.getElementById('chat-box').textContent.includes('A conexão fechou antes do fim da resposta')`);
    assert.ok(await js(`document.getElementById('chat-box').textContent.includes('o processo main, que cuida das janelas')`));
    await until(`!!document.querySelector('#continuar-barra .continuar-btn')`); await capture('continuar');
    mode = 'success'; const before = bodies.length;
    await js(`document.querySelector('#continuar-barra .continuar-btn').click()`);
    await until(`!!document.querySelector('.continuacao-marcador')`); await idle();
    assert.equal(bodies.length, before + 1);
    const msgs = bodies.at(-1).messages;
    assert.match(msgs.at(-1).content, /^\[System: Your previous response was interrupted/);
    assert.deepEqual({ role: msgs.at(-2).role, content: msgs.at(-2).content }, { role: 'assistant', content: PARCIAL });
    assert.equal(await js(`[...document.querySelectorAll('.message.user')].some(m => m.textContent.includes('[System:'))`), false, 'o pedido em inglês não vira bolha do usuário');
    assert.equal(await js(`document.getElementById('continuar-barra')===null`), true);
  });
  await check('chamada de ferramenta cortada pela conexão é repetida em vez de executada', async () => {
    mode = 'cut-tool'; falhaUnica = true; const before = bodies.length; await send('CORTE_TOOL');
    await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA CORTE_TOOL')`, 20000); await idle();
    assert.equal(bodies.length, before + 2);
    assert.equal(bodies.at(-1).messages.some(m => m.tool_calls || m.role === 'tool'), false);
  });
  await check('continue no encerramento é entregue uma vez sem segundo envio', async () => {
    mode = 'success'; blockedSave = true; const entered = new Promise(ok => { saveEntered = ok; }); const before = bodies.length;
    await send('PRIMEIRA'); await entered; await send('continue'); releaseSave();
    await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA continue')`); await idle();
    assert.equal(bodies.length, before + 2); assert.equal(bodies.at(-1).messages.at(-1).content, 'continue');
    assert.equal(bodies.at(-1).messages.filter(m => m.role === 'user' && m.content === 'continue').length, 1);
  });
  const cartoesVazios = () => js(`[...document.querySelectorAll('.error-card')].filter(c=>c.textContent.includes('O modelo não enviou uma resposta')).length`);
  await check('resposta vazia uma vez é repetida sozinha, sem cartão de erro', async () => {
    mode = 'empty-once'; falhaUnica = true; const before = bodies.length;
    await send('VAZIO1'); await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA VAZIO1')`); await idle();
    assert.equal(bodies.length, before + 2); assert.equal(await cartoesVazios(), 0);
  });
  await check('stream cortado sem resposta conta como queda e tenta de novo', async () => {
    mode = 'cut'; falhaUnica = true; const before = bodies.length;
    await send('CORTE'); await until(`document.querySelector('.retry-card')?.textContent.includes('A conexão caiu antes da resposta')`);
    await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA CORTE')`, 20000); await idle();
    assert.equal(bodies.length, before + 2); assert.equal(await cartoesVazios(), 0);
  });
  await check('servidor que trava lendo o prompt é detectado e tentado uma vez só', async () => {
    await js(`window.POFU_SERVIDOR_PARADO_MS = 2500`);
    mode = 'stall'; const before = bodies.length;
    await send('TRAVA'); await until(`document.querySelector('.typing-progresso')?.textContent.includes('2.403 de 5.000')`);
    assert.equal(await js(`getComputedStyle(document.querySelector('.typing-progresso')).width !== '7px'`), true, 'progresso não pode virar pontinho');
    await capture('progresso');
    assert.equal(bodies.at(-1).return_progress, true);
    await until(`document.querySelector('.retry-card')?.textContent.includes('parou de responder')`, 10000);
    await until(`!document.body.classList.contains('agent-running')`, 40000); await until(`[...document.querySelectorAll('.error-card')].some(c => c.textContent.includes('O servidor do modelo parou de responder') && !c.classList.contains('retry-card'))`);
    assert.equal(bodies.length, before + 2);
  });
  await check('travamento passageiro se resolve na nova tentativa', async () => {
    mode = 'stall-once'; falhaUnica = true; const before = bodies.length;
    await send('TRAVA1'); await until(`document.getElementById('chat-box').textContent.includes('RESPOSTA TRAVA1')`, 30000); await idle();
    assert.equal(bodies.length, before + 2);
    await js(`delete window.POFU_SERVIDOR_PARADO_MS`);
  });
  await check('resposta vazia mostra orientação depois de esgotar as tentativas', async () => {
    mode = 'empty'; const before = bodies.length; await send('VAZIO'); await idle(); await until(`document.getElementById('chat-box').textContent.includes('O modelo não enviou uma resposta')`);
    assert.equal(bodies.length, before + 3);
  });
  await check('modelo que só raciocina recebe orientação específica', async () => {
    mode = 'reasoning'; await send('PENSA'); await idle(); await until(`document.getElementById('chat-box').textContent.includes('só raciocinou e parou')`);
    mode = 'success';
  });
  // Por último entre os de chat: o return_progress recusado fica guardado para o endpoint.
  await check('return_progress recusado seguido de outro 4xx não entra em looping', async () => {
    mode = 'progress-refuse'; const before = bodies.length; await send('RECUSA'); await idle();
    await until(`document.getElementById('chat-box').textContent.includes('O servidor recusou a requisição (HTTP 400)')`);
    assert.equal(bodies.length, before + 2);
    assert.equal(bodies.at(-2).return_progress, true); assert.equal(bodies.at(-1).return_progress, undefined);
    mode = 'success';
  });
  await check('chat salvo com chamada sem resposta (app fechado no meio) abre reparado e continua', async () => {
    await js(`document.querySelector('[data-chat-id="orfao"]').click()`);
    await until(`document.getElementById('chat-box').textContent.includes('Sem resultado: o app fechou')`);
    await until(`!!document.querySelector('#continuar-barra .continuar-btn')`);
    mode = 'success'; const before = bodies.length;
    await js(`document.querySelector('#continuar-barra .continuar-btn').click()`);
    await until(`document.getElementById('continuar-barra')===null && !document.body.classList.contains('agent-running')`);
    assert.equal(bodies.length, before + 1);
    const msgs = bodies.at(-1).messages;
    assert.equal(msgs.at(-2).tool_calls[0].id, 'call_orfa');
    assert.deepEqual([msgs.at(-1).role, msgs.at(-1).tool_call_id], ['tool', 'call_orfa']);
    assert.match(msgs.at(-1).content, /No result: the app closed/);
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
setTimeout(() => { console.error('Tempo máximo do ensaio excedido.'); app.exit(1); }, 150000);
