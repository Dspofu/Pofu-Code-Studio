// Verifica visão com pixels sintéticos, sem capturar nem controlar o desktop.
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, Notification, nativeImage } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const endpoint = process.env.POFU_TEST_API_URL, key = process.env.POFU_TEST_API_KEY;
if (!endpoint || !key) {
  console.error('Set POFU_TEST_API_URL and POFU_TEST_API_KEY. This test makes real API requests.');
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), 'pofu-visao-real-'));
const workspace = join(profile, 'projeto');
mkdirSync(workspace);
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);

async function main() {
  const response = await fetch(endpoint.replace(/\/$/, '') + '/models', {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000)
  });
  assert.equal(response.status, 200, 'A API precisa responder à descoberta de modelos.');
  const models = await response.json();
  const model = process.env.POFU_TEST_MODEL || models.data?.[0]?.id;
  assert.ok(model);
  await app.whenReady();
  const bitmap = Buffer.alloc(512 * 512 * 4, 255);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    if ((x - 256) ** 2 + (y - 256) ** 2 <= 150 ** 2) {
      const offset = (y * 512 + x) * 4;
      bitmap[offset + 1] = 0; bitmap[offset + 2] = 0;
    }
  }
  const captured = nativeImage.createFromBitmap(bitmap, { width: 512, height: 512 });
  assert.equal(captured.isEmpty(), false);
  const pixels = captured.toBitmap(), dimensions = captured.getSize();
  const center = (Math.floor(dimensions.height / 2) * dimensions.width + Math.floor(dimensions.width / 2)) * 4;
  assert.equal(pixels[center], 255);
  assert.equal(pixels[center + 1], 0);
  assert.equal(pixels[center + 2], 0);
  writeFileSync(join(workspace, 'figura.png'), captured.toPNG());
  console.log('PASS imagem sintética gerada e pixels conferidos');

  let memoryStore = {
    settings: { apiUrl: endpoint, apiKey: key, model, execMode: 'auto', thinkLevel: 'padrao',
      temperature: 0, maxTokens: 4096, visionFeedback: true, computerUse: false },
    chats: { vision: { id: 'vision', name: 'Teste de visão', path: workspace, messages: [] } }, activeChatId: 'vision'
  };
  // Inclui os salvamentos periódicos do renderer para a chave nunca chegar ao disco.
  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => registerHandler(channel,
    channel === 'load-store' ? async () => memoryStore :
    channel === 'save-store' ? async (_, data) => { memoryStore = data; return { success: true }; } : handler);
  await import(pathToFileURL(resolve('out/main.js')));
  ipcMain.handle = registerHandler;
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = code => win.webContents.executeJavaScript(code);
  await js(`new Promise((ok, fail) => { const start = Date.now(); const poll = () => import('./out/renderer.js').then(m => {
    if (m.activeTools().some(t => t.function.name === 'view_image')) ok(true);
    else if (Date.now() - start > 30000) fail(new Error('Modelo não habilitou view_image.'));
    else setTimeout(poll, 100);
  }); poll(); })`);
  await js(`(() => {
    window.__visionRequests = [];
    const original = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]).includes('/chat/completions') && args[1]?.body) {
        const body = JSON.parse(args[1].body);
        const images = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'image_url');
        window.__visionRequests.push({ images: images.length, pngBytes: images.map(c => c.image_url.url.startsWith('data:image/png;base64,') ? c.image_url.url.length : 0) });
      }
      return original(...args);
    };
    const input = document.getElementById('user-input');
    input.value = 'Observe a imagem figura.png usando view_image e diga somente qual é a forma geométrica colorida e qual é sua cor.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  const started = Date.now();
  const result = await js(`new Promise((ok, fail) => { const start = Date.now(); const poll = () => import('./out/renderer.js').then(m => {
    const messages = m.activeChat().messages, last = messages[messages.length - 1];
    if (messages.length > 1 && !document.body.classList.contains('agent-running'))
      ok({ answer: last.role === 'assistant' && !last.tool_calls ? String(last.content || '') : '', calls: messages.flatMap(x => (x.tool_calls || []).map(t => t.function.name)), requests: window.__visionRequests, stats: last.stats || null,
        diagnostics: Array.from(document.querySelectorAll('.system-log,.error-card')).map(n=>n.textContent).slice(-3) });
    else if (Date.now() - start > 180000) fail(new Error('Tempo esgotado no teste de visão.'));
    else setTimeout(poll, 250);
  }); poll(); })`);
  assert.deepEqual(result.calls, ['view_image'], 'A imagem deve ser inspecionada sem terminal ou controle de desktop.');
  assert.ok(result.requests.some(r => r.images > 0 && r.pngBytes.every(n => n > 1000)), 'Os pixels PNG precisam constar da requisição enviada.');
  assert.match(result.answer, /c[ií]rculo|circle|circular/i);
  assert.match(result.answer, /azul|blue/i);
  const report = { passed: true, model, seconds: Math.round((Date.now() - started) / 100) / 10, ...result };
  if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().then(() => app.exit(0)).catch(err => { console.error(err); app.exit(1); });
