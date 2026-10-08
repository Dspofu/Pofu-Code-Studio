// Consultas públicas pelo preload/IPC reais; sem conta, inferência ou perfil do usuário.
const { app, BrowserWindow, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'pofu-web-real-')));
Notification.prototype.show = () => {};
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);
app.on('browser-window-created', (_, win) => { win.hide(); });
const queries = ['Node.js LTS versão atual site oficial', 'RTX 5060 Ti 16GB RTX 5070 Ti memória consumo especificações NVIDIA', 'quem é o dono da WebCoruja'];
async function main() {
  await import(pathToFileURL(resolve('out/main.js')));
  await app.whenReady();
  let win;
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) break;
    await new Promise(ok => setTimeout(ok, 100));
  }
  if (!win) throw new Error('Janela principal não abriu.');
  const report = [];
  for (const query of queries) {
    const started = Date.now();
    const result = await win.webContents.executeJavaScript(`window.electronAPI.webSearch(${JSON.stringify(query)}, 6)`);
    report.push({ query, ms: Date.now() - started, ...result });
    console.log(JSON.stringify({ query, ms: Date.now() - started, success: result.success, source: result.source, results: result.results?.map(r => r.url), pages: result.paginas?.map(p => ({ url: p.url, chars: p.text.length })), error: result.error }));
  }
  mkdirSync('node_modules/.cache', { recursive: true });
  writeFileSync(process.env.POFU_WEB_REPORT || 'node_modules/.cache/web-real.json', JSON.stringify(report, null, 2));
  if (process.env.POFU_WEB_ASSERT === '1' && report.some(r => !r.success || !r.paginas?.length)) throw new Error('A pesquisa precisa encontrar resultados e ler fontes em todos os casos.');
}
main().then(() => app.exit(0), err => { console.error(err.message); app.exit(1); });
setTimeout(() => { console.error('Tempo máximo do ensaio excedido.'); app.exit(1); }, 240000);
