// App real com o release do GitHub simulado; a instalação é trocada por um roteiro para não rodar instalador.
const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const profile = mkdtempSync(join(tmpdir(), 'pofu-update-'));
const workspace = join(profile, 'project'); mkdirSync(workspace); app.setPath('userData', profile);
let notificacoes = 0;
Notification.prototype.show = () => { notificacoes++; };
app.on('browser-window-created', (_, win) => win.hide());
const release = { tag_name: 'v9.9.9', name: 'v9.9.9', draft: false, prerelease: false, body: '## Novidades\n\n- **Atualização** de dentro do app', assets: [{ name: 'pofu-code-studio_9.9.9_amd64.deb', browser_download_url: 'https://example.invalid/x.deb', size: 10, digest: 'sha256:' + 'a'.repeat(64) }] };
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(Response.json(release)) : originalFetch(url, ...args);
let metodo = null, liberaInstalacao, instalacoes = 0, cancelamentos = 0;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, channel === 'check-update' ? async (...a) => ({ ...(await handler(...a)), metodo })
  : channel === 'cancel-update' ? async () => { cancelamentos++; liberaInstalacao?.({ success: false, cancelado: true, error: 'Download cancelado.' }); return { success: true }; }
  : channel === 'install-update' ? async (event) => {
    instalacoes++;
    event.sender.send('update-progress', { fase: 'baixando', recebidos: 40 * 1048576, total: 100 * 1048576 });
    return new Promise(ok => { liberaInstalacao = ok; });
  } : handler);
async function main() {
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { providers: [{ id: 'p', name: 'Teste', apiUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'fixture', thinkLevel: 'padrao' }], activeProviderId: 'p' }, activeChatId: 'chat', chats: { chat: { id: 'chat', name: 'Projeto de teste', path: workspace, messages: [] } } }));
  await import(pathToFileURL(resolve('out/main.js'))); await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(ok => win.webContents.once('did-finish-load', ok));
  const js = code => win.webContents.executeJavaScript(code);
  async function until(code, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await js(code)) return; await new Promise(ok => setTimeout(ok, 30)); } throw new Error('Tempo excedido: ' + code); }
  let passed = 0; const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  const output = process.env.POFU_QA_OUTPUT || 'node_modules/.cache/update-ui'; mkdirSync(output, { recursive: true });
  async function capture(name) { win.setSize(1380, 860); win.showInactive(); await js(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`); writeFileSync(join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.hide(); }
  await check('versão nova aparece na lateral, nas configurações e na notificação do sistema', async () => {
    await until(`!document.getElementById('sidebar-update-wrap').hidden`);
    assert.match(await js(`document.getElementById('sidebar-update-version').textContent`), /→ v9\.9\.9$/);
    assert.equal(await js(`document.getElementById('btn-settings-update').hidden`), false);
    assert.equal(notificacoes, 1);
    await capture('lateral');
  });
  await check('sem instalação automática o modal manda para o release', async () => {
    await js(`document.getElementById('btn-sidebar-update').click()`);
    assert.equal(await js(`document.getElementById('update-modal').classList.contains('active')`), true);
    assert.equal(await js(`document.querySelector('#update-notes h2')?.textContent`), 'Novidades');
    assert.equal(await js(`document.getElementById('btn-update-now').textContent`), 'Abrir página do release');
    assert.match(await js(`document.getElementById('update-hint').textContent`), /não se atualiza sozinha/);
    await js(`document.getElementById('btn-update-later').click()`);
    assert.equal(await js(`document.getElementById('update-modal').classList.contains('active')`), false);
  });
  await check('clique na notificação abre o modal; download mostra progresso e cancela', async () => {
    metodo = 'deb'; await js(`document.getElementById('btn-check-update').click()`); await new Promise(ok => setTimeout(ok, 300));
    win.webContents.send('update-open');
    await until(`document.getElementById('update-modal').classList.contains('active') && document.getElementById('btn-update-now').textContent==='Atualizar agora'`);
    assert.match(await js(`document.getElementById('update-hint').textContent`), /senha de administrador.*\.deb/);
    await capture('modal');
    await js(`document.getElementById('btn-update-now').click()`);
    await until(`document.getElementById('update-progress-pct').textContent==='40%'`);
    assert.equal(await js(`document.getElementById('btn-update-now').disabled`), true);
    assert.equal(await js(`document.getElementById('btn-update-later').textContent`), 'Cancelar');
    await capture('progresso');
    await js(`document.getElementById('btn-close-update').click()`);
    assert.equal(await js(`document.getElementById('update-modal').classList.contains('active')`), true, 'fechar não pode esconder um download em andamento');
    await js(`document.getElementById('btn-update-later').click()`);
    await until(`document.getElementById('btn-update-now').textContent==='Tentar de novo'`);
    assert.equal(await js(`document.getElementById('update-error').hidden`), true);
    assert.equal(cancelamentos, 1);
  });
  await check('falha da instalação aparece no modal e permite tentar de novo', async () => {
    await js(`document.getElementById('btn-update-now').click()`);
    await until(`document.getElementById('btn-update-now').disabled`);
    liberaInstalacao({ success: false, error: 'Autorização cancelada.' });
    await until(`!document.getElementById('update-error').hidden`);
    assert.equal(await js(`document.getElementById('update-error').textContent`), 'Autorização cancelada.');
    assert.equal(await js(`document.getElementById('update-progress').hidden`), true);
    assert.equal(instalacoes, 2);
    await capture('erro');
  });
  console.log('RESULT ' + passed + ' verificações de atualização passaram.');
}
main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
setTimeout(() => { console.error('Tempo máximo do ensaio excedido.'); app.exit(1); }, 60000);
