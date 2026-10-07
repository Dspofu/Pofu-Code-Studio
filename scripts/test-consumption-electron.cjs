// Painel real, IPC e armazenamento protegidos, com perfil e servidor descartáveis.
const { app, BrowserWindow, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const profile = mkdtempSync(join(tmpdir(), 'pofu-consumption-ui-'));
app.setPath('userData', profile);
Notification.prototype.show = () => {};
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(Response.json({}, { status: 404 })) : originalFetch(url, ...args);
app.on('browser-window-created', (_, win) => win.hide());
const requests = [];
let lateResolve;
const server = createServer((req, res) => {
  requests.push({ url: req.url, authorization: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  if (req.url === '/v1/usage') return res.end(JSON.stringify({ schema: 'ai-usage/v1', provider: { id: 'pofu', name: 'Pofu Server' }, scope: 'account',
    balances: [{ unit: 'credits', remaining: 2500, used: 500 }], cycle: { used: 500, limit: 3000, renewsAt: Date.now() + 86400000 }, plan: { name: 'Studio' } }));
  if (req.url === '/slow/v1/usage') { lateResolve = () => res.end(JSON.stringify({ schema: 'ai-usage/v1', provider: { id: 'pofu', name: 'Resposta antiga' }, scope: 'account', balances: [{ unit: 'credits', remaining: 999999, used: 1 }] })); return; }
  res.statusCode = 404; res.end('{}');
});
async function main() {
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const providers = [
    { id: 'pofu', name: 'Pofu de teste', apiUrl: base + '/v1', apiKey: 'fixture-pofu', model: 'fixture-model', thinkLevel: 'padrao' },
    { id: 'other', name: 'API sem relatório', apiUrl: base + '/other/v1', apiKey: 'fixture-other', model: 'fixture-model', thinkLevel: 'padrao' },
    { id: 'slow', name: 'API lenta', apiUrl: base + '/slow/v1', apiKey: 'fixture-slow', model: 'fixture-model', thinkLevel: 'padrao' },
    { id: 'openai', name: 'OpenAI sem admin', apiUrl: 'https://api.openai.com/v1', apiKey: '', model: '', thinkLevel: 'padrao' }
  ];
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { providers, activeProviderId: 'pofu' } }));
  await import(pathToFileURL(resolve('out/main.js'))); await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(ok => win.webContents.once('did-finish-load', ok));
  const js = code => win.webContents.executeJavaScript(code);
  async function until(expression) {
    for (let i = 0; i < 200; i++) { if (await js(expression)) return; await new Promise(ok => setTimeout(ok, 30)); }
    throw new Error('O painel não concluiu a atualização esperada.');
  }
  let passed = 0;
  async function check(name, run) { await run(); passed++; console.log('PASS ' + name); }
  await check('IPC grava consumo e não mistura credenciais de perfis', async () => {
    assert.equal((await js(`window.electronAPI.recordUsage(${JSON.stringify(providers[0])}, {prompt_tokens:1200,completion_tokens:300})`)).success, true);
    await js(`window.electronAPI.recordUsage(${JSON.stringify(providers[1])}, {prompt_tokens:10,completion_tokens:2})`);
    const data = await js(`window.electronAPI.providerConsumption(${JSON.stringify(providers[0])}, 'month')`);
    assert.equal(data.remote.provider, 'pofu'); assert.equal(data.local.tokens.input, 1200); assert.equal(data.local.tokens.requests, 1);
    assert.ok(!readFileSync(join(profile, 'consumo.json'), 'utf8').includes('fixture-pofu'));
  });
  await check('painel mostra saldo, ciclo, plano e registro local', async () => {
    await js(`document.getElementById('btn-consumption').click(); document.getElementById('consumption-details').open = true`);
    await until(`document.getElementById('consumption-status').textContent.includes('consulta concluída')`);
    assert.equal(await js(`document.querySelector('[data-tab="tab-consumo"]') === null`), true);
    assert.equal(await js(`document.getElementById('settings-modal').classList.contains('active')`), false);
    const text = await js(`document.getElementById('consumption-body').innerText`);
    assert.match(text, /Pofu Server/); assert.match(text, /2\.500/); assert.match(text, /1\.200/); assert.match(text, /Studio/); assert.match(text, /Conta inteira/);
    assert.equal(await js(`document.getElementById('consumption-cycle-fill').style.width`), '17%');
  });
  await check('API sem relatório preserva consumo local sem fabricar saldo', async () => {
    await js(`document.getElementById('consumption-provider').value='other'; document.getElementById('consumption-provider').dispatchEvent(new Event('change'))`);
    await until(`document.getElementById('consumption-status').textContent.includes('registro local disponível')`);
    assert.equal(await js(`document.getElementById('consumption-local-input').textContent`), '10');
    assert.equal(await js(`document.getElementById('consumption-cycle').hidden`), true);
    assert.equal(await js(`document.getElementById('consumption-provider-report').hidden`), true);
    assert.ok(!await js(`document.getElementById('consumption-remote').textContent.includes('2.500')`));
  });
  await check('OpenAI sem chave administrativa orienta e não bloqueia painel', async () => {
    await js(`document.getElementById('consumption-provider').value='openai'; document.getElementById('consumption-provider').dispatchEvent(new Event('change'))`);
    await until(`document.getElementById('consumption-status').textContent.includes('chave administrativa necessária')`);
    assert.match(await js(`document.getElementById('consumption-remote-note').textContent`), /chave administrativa/);
  });
  await check('resposta antiga não sobrescreve provedor escolhido depois', async () => {
    await js(`document.getElementById('consumption-provider').value='slow'; document.getElementById('consumption-provider').dispatchEvent(new Event('change'))`);
    while (!lateResolve) await new Promise(ok => setTimeout(ok, 10));
    await js(`document.getElementById('consumption-provider').value='pofu'; document.getElementById('consumption-provider').dispatchEvent(new Event('change'))`);
    await until(`document.getElementById('consumption-status').textContent.includes('consulta concluída')`);
    lateResolve(); await new Promise(ok => setTimeout(ok, 100));
    assert.ok(!await js(`document.getElementById('consumption-body').innerText.includes('Resposta antiga')`));
  });
  await check('registro local permanece depois de recarregar o app', async () => {
    win.reload(); await new Promise(ok => win.webContents.once('did-finish-load', ok));
    await js(`document.getElementById('btn-consumption').click(); document.getElementById('consumption-details').open = true`);
    await until(`document.getElementById('consumption-status').textContent.includes('consulta concluída')`);
    assert.equal(await js(`document.getElementById('consumption-local-input').textContent`), '1.200');
  });
  await check('chave administrativa salva protegida, recuperada e separada do chat', async () => {
    const store = await js(`window.electronAPI.loadStore()`);
    store.settings.providers[0].usageAdminKey = 'fixture-admin-private';
    const saved = await js(`window.electronAPI.saveStore(${JSON.stringify(store)})`);
    assert.equal(saved.success, true); assert.ok(!readFileSync(join(profile, 'app-store.json'), 'utf8').includes('fixture-admin-private'));
    assert.equal((await js(`window.electronAPI.loadStore()`)).settings.providers[0].usageAdminKey, 'fixture-admin-private');
    assert.ok(requests.filter(r => r.url === '/v1/usage').every(r => r.authorization === 'Bearer fixture-pofu'));
  });
  await check('/usage e /cost abrem o resumo sem enviar mensagens ao modelo', async () => {
    const before = requests.filter(r => r.url.includes('/chat/completions')).length;
    for (const alias of ['/usage', '/cost']) {
      await js(`(() => { document.getElementById('btn-close-consumption').click(); const input = document.getElementById('user-input'); input.value = ${JSON.stringify(alias)}; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); })()`);
      await until(`document.getElementById('consumption-modal').classList.contains('active')`);
      await until(`document.getElementById('consumption-status').textContent.includes('consulta concluída')`);
      assert.equal(await js(`document.getElementById('consumption-provider').value`), 'pofu');
      assert.equal(await js(`document.getElementById('consumption-details').open`), false);
    }
    assert.equal(requests.filter(r => r.url.includes('/chat/completions')).length, before);
  });
  const dir = process.env.POFU_CONSUMPTION_CAPTURE || 'node_modules/.cache/consumption-ui';
  mkdirSync(dir, { recursive: true });
  await check('layout real em janela normal e compacta', async () => {
    for (const [name, size] of [['normal', [1380, 860]], ['compacto', [800, 600]]]) {
      win.setSize(...size); win.showInactive();
      await js(`document.getElementById('consumption-details').open = false`);
      await js(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
      assert.equal(await js(`document.getElementById('consumption-body').scrollWidth <= document.getElementById('consumption-body').clientWidth + 1`), true);
      writeFileSync(join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.getElementById('btn-close-consumption').click()`);
      await js(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
      assert.equal(await js(`document.activeElement.id`), 'btn-consumption');
      writeFileSync(join(dir, 'chat-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.getElementById('btn-consumption').click()`);
      await until(`document.getElementById('consumption-status').textContent.includes('consulta concluída')`);
      win.hide();
    }
  });
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ passed, profile: 'isolated', credentials: 'synthetic', remote: 'local fixture' }, null, 2));
  console.log(`RESULT ${passed} consumption integration checks passed`);
}
main().then(() => { server.close(); app.exit(0); }, err => { console.error(err); server.close(); app.exit(1); });
setTimeout(() => { console.error('Tempo máximo do ensaio excedido.'); app.exit(1); }, 60000);
