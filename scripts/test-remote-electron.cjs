// Site e API reais em estado descartável; somente a inferência é uma fixture SSE.
const { app, BrowserWindow, Notification } = require('electron');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fixture = JSON.parse(readFileSync(process.env.POFU_REMOTE_FIXTURE, 'utf8'));
const profile = mkdtempSync(join(tmpdir(), 'pofu-remote-e2e-')), workspace = join(profile, 'project');
mkdirSync(workspace); app.setPath('userData', profile); Notification.prototype.show = () => {};
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(Response.json({}, { status: 404 })) : originalFetch(url, ...args);
app.on('browser-window-created', (_, win) => win.hide());
let held = null, requests = 0;
const model = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model', meta: { n_ctx_train: 32768 } }] })); return; }
  if (req.url === '/v1/usage') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ schema: 'ai-usage/v1', provider: { id: 'pofu', name: 'Pofu Server' }, balances: [{ unit: 'credits', remaining: 2500, used: 500 }], cycle: { used: 500, limit: 3000 }, plan: { name: 'Studio' } })); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const data = JSON.parse(raw); requests++;
  const user = [...data.messages].reverse().find(m => m.role === 'user')?.content || '';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = v => res.write('data: ' + JSON.stringify(v) + '\n\n');
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  if (user === 'INTERROMPER') { event({ choices: [{ index: 0, delta: { content: 'Em andamento…' } }] }); held = res; res.on('close', () => { held = null; }); return; }
  if (data.messages.at(-1).role !== 'tool' && ['APROVAR', 'RECUSAR', 'PERGUNTAR'].includes(user)) {
    const name = user === 'PERGUNTAR' ? 'ask_user' : 'execute_command';
    const args = user === 'PERGUNTAR' ? { question: 'Qual opção usar?', options: ['Opção A', 'Opção B'] } : { command: fixture.nodeBinary, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(workspace, user + '.txt'))}, 'ok')`] };
    event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tool-' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage });
  } else {
    event({ choices: [{ index: 0, delta: { content: user === 'PERGUNTAR' ? 'Resposta recebida: ' + data.messages.at(-1).content : 'Resposta remota concluída.' }, finish_reason: 'stop' }], usage });
  }
  res.end('data: [DONE]\n\n');
});
async function main() {
  await new Promise(ok => model.listen(0, '127.0.0.1', ok));
  const apiUrl = `http://127.0.0.1:${model.address().port}/v1`;
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { providers: [{ id: 'pofu', name: 'Pofu de teste', apiUrl, apiKey: 'synthetic-key-not-for-site', model: 'fixture-model', thinkLevel: 'padrao' }], activeProviderId: 'pofu', execMode: 'manual', mcpConfig: '{}' }, chats: { test: { id: 'test', name: 'Projeto remoto', path: workspace, messages: [] } }, activeChatId: 'test' }));
  await import(pathToFileURL(resolve('out/main.js'))); await app.whenReady();
  const desktop = BrowserWindow.getAllWindows()[0]; desktop.webContents.setBackgroundThrottling(false);
  if (desktop.webContents.isLoading()) await new Promise(ok => desktop.webContents.once('did-finish-load', ok));
  const web = new BrowserWindow({ show: false, width: 1380, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  web.webContents.setBackgroundThrottling(false);
  await web.loadURL(fixture.webOrigin + '/');
  const js = s => desktop.webContents.executeJavaScript(s), site = s => web.webContents.executeJavaScript(s);
  const errors = [];
  for (const win of [desktop, web]) win.webContents.on('console-message', event => { if (/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message); });
  async function until(fn, label) { const deadline = Date.now() + 18000; do { if (await fn()) return; await new Promise(ok => setTimeout(ok, 60)); } while (Date.now() < deadline); throw new Error('Timeout: ' + label); }
  let passed = 0; async function check(name, fn) { await fn(); console.log('PASS ' + name); passed++; }
  await check('rota Code exige login e abre pelo proxy real depois de autenticar', async () => {
    await web.loadURL(fixture.webOrigin + '/dashboard/code'); assert.ok(!web.webContents.getURL().endsWith('/dashboard/code'));
    const status = await site(`fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ email: fixture.email, password: fixture.password })})}).then(r=>r.status)`); assert.equal(status, 200);
    await web.loadURL(fixture.webOrigin + '/dashboard/code'); await until(() => site(`!!document.getElementById('pair-open')`), 'tela Code');
    await site(`Object.defineProperty(document,'hidden',{get:()=>false});document.dispatchEvent(new Event('visibilitychange'))`);
  });
  await check('pareamento pelos controles reais e credencial protegida no desktop', async () => {
    const opening = resolve('node_modules/.cache/remote-ui'); mkdirSync(opening, { recursive: true });
    await until(() => site(`document.body.dataset.view==='empty' && !document.getElementById('empty-pair').disabled`), 'abertura simplificada');
    for (const width of [1380, 390, 320]) { web.setSize(width, width === 1380 ? 900 : 844); web.showInactive(); await site(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`); assert.equal(await site(`document.documentElement.scrollWidth<=innerWidth+1`), true); writeFileSync(join(opening, width === 1380 ? 'web-empty.png' : 'web-empty-' + width + '.png'), (await web.webContents.capturePage()).toPNG()); web.hide(); }
    web.setSize(1380, 900);
    await site(`document.getElementById('empty-pair').click()`);
    assert.equal(await site(`document.getElementById('pair-modal').hidden`), false);
    assert.equal(await site(`getComputedStyle(document.getElementById('pair-modal')).display`), 'grid');
    await until(() => site(`/^[A-F0-9]{10}$/.test(document.getElementById('pair-code').textContent)`), 'código');
    assert.equal(await site(`document.getElementById('pair-copy').disabled`), false);
    web.showInactive(); await site(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`); writeFileSync(join(opening, 'web-pair.png'), (await web.webContents.capturePage()).toPNG()); web.hide();
    const code = await site(`document.getElementById('pair-code').textContent`);
    await js(`document.getElementById('btn-open-settings').click();document.querySelector('[data-tab="tab-remoto"]').click();document.getElementById('remote-server').value=${JSON.stringify(fixture.webOrigin)};document.getElementById('remote-code').value=${JSON.stringify(code)};document.getElementById('btn-remote-pair').click()`);
    await site(`document.getElementById('pair-close').click()`);
    await until(() => site(`document.getElementById('connection-status').textContent.includes('Conectado')`), 'Studio online');
    const saved = JSON.parse(readFileSync(join(profile, 'remote-control.json'), 'utf8')); assert.ok(saved.encryptedToken); assert.ok(!saved.token);
    assert.equal(await site(`document.getElementById('chat-title').textContent`), 'Projeto remoto');
    assert.ok(!JSON.stringify(await js(`import('./out/renderer.js').then(m=>m.studioRemoteSnapshot())`)).includes('synthetic-key-not-for-site'));
  });
  await check('consumo no Code e atualização a partir do Studio', async () => {
    assert.equal(await site(`document.getElementById('consumption-modal').hidden`), true);
    await site(`document.getElementById('consumption-open').click()`);
    assert.equal(await site(`document.getElementById('consumption-modal').hidden`), false);
    await until(() => site(`document.getElementById('consumption-text').textContent.includes('2.500')`), 'saldo remoto');
    assert.match(await site(`document.getElementById('consumption-text').textContent`), /Conta inteira/);
    await site(`document.getElementById('consumption-period').value='7d';document.getElementById('consumption-refresh').click()`);
    await until(() => js(`import('./out/renderer.js').then(m=>m.studioRemoteSnapshot().consumption?.period==='7d')`), 'atualização do período');
    await site(`document.getElementById('consumption-close').click()`);
  });
  async function send(text) {
    await until(() => site(`!document.getElementById('send').disabled && document.getElementById('task-status').textContent==='Pronto para conversar'`), 'envio habilitado');
    await site(`document.getElementById('message').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`);
    await until(() => js(`import('./out/renderer.js').then(m=>m.activeChat().messages.some(x=>x.role==='user'&&x.content===${JSON.stringify(text)}))`), 'mensagem recebida no desktop');
  }
  await check('mensagem pelo site percorre IPC e loop real, devolvendo resposta', async () => {
    await send('OLÁ'); await until(() => site(`document.getElementById('chat-text').textContent.includes('Resposta remota concluída.')`), 'resposta da fixture');
    assert.equal(await js(`import('./out/renderer.js').then(m=>m.activeChat().messages.filter(x=>x.role==='user'&&x.content==='OLÁ').length)`), 1);
  });
  await check('aprovação manual pelo site executa ferramenta no workspace isolado', async () => {
    await send('APROVAR'); await until(() => site(`!document.getElementById('approval').hidden && document.getElementById('approval-description').textContent.includes('APROVAR.txt')`), 'aprovação');
    assert.equal(existsSync(join(workspace, 'APROVAR.txt')), false);
    await site(`document.getElementById('approve').click()`); await until(() => existsSync(join(workspace, 'APROVAR.txt')), 'arquivo da ferramenta');
    await until(() => js(`import('./out/renderer.js').then(m=>!m.studioRemoteSnapshot().running)`), 'conclusão');
  });
  await check('recusa pelo site preserva a proteção manual', async () => {
    await send('RECUSAR'); await until(() => site(`!document.getElementById('approval').hidden && document.getElementById('approval-description').textContent.includes('RECUSAR.txt')`), 'segunda aprovação');
    await site(`document.getElementById('reject').click()`); await until(() => js(`import('./out/renderer.js').then(m=>!m.studioRemoteSnapshot().running)`), 'recusa');
    assert.equal(existsSync(join(workspace, 'RECUSAR.txt')), false);
  });
  await check('pergunta do agente respondida no site chega ao mesmo chat desktop', async () => {
    await send('PERGUNTAR'); await until(() => site(`!document.getElementById('question').hidden`), 'pergunta');
    await site(`document.querySelector('#question-options input[value="Opção B"]').checked=true;document.getElementById('question-notes').value='Complemento remoto';document.getElementById('answer').click()`);
    await until(() => js(`import('./out/renderer.js').then(m=>m.activeChat().messages.some(x=>x.role==='tool'&&x.content.includes('Complemento remoto')))`), 'resposta registrada');
    await until(() => js(`import('./out/renderer.js').then(m=>!m.studioRemoteSnapshot().running)`), 'resposta final');
  });
  await check('interrupção pelo site aborta streaming no Studio', async () => {
    await send('INTERROMPER'); await until(() => held && site(`!document.getElementById('stop').disabled`), 'streaming');
    await site(`document.getElementById('stop').click()`); await until(() => !held, 'stream abortado');
    await until(() => js(`import('./out/renderer.js').then(m=>!m.studioRemoteSnapshot().running)`), 'agente parado');
  });
  await check('criar e selecionar conversa remota, sem trocar tarefa em execução', async () => {
    await until(() => site(`!document.getElementById('new-chat').disabled`), 'novo chat');
    await site(`document.getElementById('new-chat').click()`); await until(() => site(`document.querySelectorAll('#chat-list button').length===2`), 'nova conversa');
    await site(`[...document.querySelectorAll('#chat-list button')].find(b=>b.textContent==='Projeto remoto').click()`);
    await until(() => site(`document.getElementById('chat-title').textContent==='Projeto remoto'`), 'seleção da conversa');
  });
  const capture = resolve('node_modules/.cache/remote-ui'); mkdirSync(capture, { recursive: true });
  await check('layout Code em desktop e celular e painel remoto do Studio', async () => {
    for (const [name, width, height] of [['web-normal',1380,900],['web-mobile',390,844],['web-small',320,844]]) {
      web.setContentSize(width,height); web.showInactive(); await site(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
      assert.equal(await site(`document.documentElement.scrollWidth<=innerWidth+1`), true);
      assert.equal(await site(`getComputedStyle(document.getElementById('devices')).display !== 'none' && document.getElementById('devices').getBoundingClientRect().width > 0`), true);
      await site(`document.getElementById('quick-thinking').click()`);
      assert.equal(await site(`document.getElementById('controls-modal').hidden`), false);
      assert.equal(await site(`document.activeElement.id`), 'thinking');
      await site(`document.getElementById('controls-close').click()`);
      if (width === 390) assert.ok(await site(`document.getElementById('send').getBoundingClientRect().bottom<=innerHeight+1`), 'Compositor precisa aparecer na primeira tela do celular');
      writeFileSync(join(capture, name + '.png'), (await web.webContents.capturePage()).toPNG()); web.hide();
      await site(`document.getElementById('controls-open').click()`);
      assert.equal(await site(`document.getElementById('controls-modal').hidden`), false);
      assert.equal(await site(`document.activeElement.id`), 'controls-title');
      assert.equal(await site(`document.getElementById('controls-modal').querySelectorAll('svg').length >= 6`), true);
      assert.equal(await site(`[...document.getElementById('thinking').options].every(o=>!o.textContent.includes('_'))`), true);
      assert.equal(await site(`document.getElementById('provider').selectedOptions[0].textContent.includes(' · ')`), false);
      assert.equal(await site(`document.getElementById('controls-modal').querySelector('.dialog').scrollWidth<=innerWidth`), true);
      web.showInactive(); await site(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`); writeFileSync(join(capture, 'controls-' + name + '.png'), (await web.webContents.capturePage()).toPNG()); web.hide();
      await site(`document.getElementById('controls-title').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      assert.equal(await site(`document.getElementById('controls-modal').hidden`), true);
    }
    desktop.showInactive(); writeFileSync(join(capture,'desktop.png'), (await desktop.webContents.capturePage()).toPNG()); desktop.hide();
  });
  await check('desligar no desktop suspende a ponte, e reativar recupera a sessão', async () => {
    await js(`document.getElementById('btn-remote-toggle').click()`); await until(() => js(`window.electronAPI.remoteStatus().then(s=>!s.enabled)`), 'desligado');
    await js(`document.getElementById('btn-remote-toggle').click()`); await until(() => js(`window.electronAPI.remoteStatus().then(s=>s.state==='online')`), 'reativado');
  });
  await check('recarregar renderer retoma a ponte somente depois de restaurar o chat', async () => {
    desktop.reload(); await new Promise(ok => desktop.webContents.once('did-finish-load', ok));
    await until(() => js(`window.electronAPI.remoteStatus().then(s=>s.enabled&&s.state==='online')`), 'reconexão após reload');
    await until(() => site(`document.getElementById('task-status').textContent==='Pronto para conversar'`), 'sessão após reload');
    await send('RECARREGADO');
    await until(() => js(`import('./out/renderer.js').then(m=>m.activeChat().messages.some(x=>x.role==='user'&&x.content==='RECARREGADO'))`), 'mensagem depois de reload');
  });
  assert.deepEqual(errors, []);
  console.log(`RESULT ${passed} verificações de remote control passaram (inferência sintética, perfil isolado).`);
  model.closeAllConnections(); model.close(); app.exit(0);
}
main().catch(err => { console.error(err); model.closeAllConnections(); model.close(); app.exit(1); });
setTimeout(() => { console.error('Timeout global do ensaio remoto.'); app.exit(1); }, 150000);
