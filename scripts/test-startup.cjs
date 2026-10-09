const { app, BrowserWindow, Notification, shell } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const scenario = process.argv[2];
const current = require('../package.json').version;
const scenarios = {
  newer: { tag_name: 'v99.0.0' }, equal: { tag_name: 'v' + current },
  older: { tag_name: 'v0.1.0' }, invalid: { tag_name: 'invalid' },
  prerelease: { tag_name: 'v99.0.0-beta.1', prerelease: true },
  draft: { tag_name: 'v99.0.0', draft: true }
};
app.setPath('userData', mkdtempSync(join(tmpdir(), 'pofu-startup-')));
let requests = 0;
const notifications = [], opened = [];
Notification.isSupported = () => true;
Notification.prototype.show = function() { notifications.push(this); };
shell.openExternal = async url => { opened.push(url); };
global.fetch = async url => {
  assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/Dspofu\/Pofu-Code-Studio\/releases\/latest$/);
  requests++;
  if (scenario === 'offline') throw new Error('Offline');
  if (scenario === 'missing') return new Response('{}', { status: 404 });
  if (scenario === 'limited') return new Response('{}', { status: 429 });
  return new Response(JSON.stringify(scenarios[scenario]));
};
app.on('browser-window-created', (_, win) => win.hide());
const deadline = setTimeout(() => { console.error('Timeout:', scenario); app.exit(1); }, 20000);
(async () => {
  await import(pathToFileURL(resolve('out/main.js')));
  await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const result = await win.webContents.executeJavaScript('window.electronAPI.checkUpdate()');
  assert.equal(requests, 1, 'A abertura e o renderer devem compartilhar a consulta');
  assert.equal(notifications.length, scenario === 'newer' ? 1 : 0);
  if (scenario === 'newer') {
    assert.equal(result.maior, true);
    assert.match(notifications[0].body, /99\.0\.0/);
    // O clique leva ao modal de atualização do próprio app, não ao navegador.
    notifications[0].emit('click');
    await win.webContents.executeJavaScript(`new Promise((ok, falha) => { const t0 = Date.now(); const poll = () => document.getElementById('update-modal').classList.contains('active') ? ok(true) : Date.now() - t0 > 5000 ? falha(new Error('modal de atualização não abriu')) : setTimeout(poll, 50); poll(); })`);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('update-to').textContent`), /v99\.0\.0/);
    assert.deepEqual(opened, []);
  }
  await win.webContents.executeJavaScript('window.electronAPI.checkUpdate()');
  assert.equal(requests, 1);
  assert.equal(notifications.length, scenario === 'newer' ? 1 : 0, 'Consulta manual não repete o aviso');
  console.log('PASS abertura:', scenario);
  clearTimeout(deadline);
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
