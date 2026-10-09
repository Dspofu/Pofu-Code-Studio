// Controle do computador com modelo REAL e input NATIVO: o mouse e o teclado do Windows se
// mexem de verdade. A tarefa fica restrita a uma janela-alvo que o teste abre por cima de
// tudo, e o resultado é conferido pelo estado da própria página, não pela resposta do
// modelo. Mesmas variáveis do test:agent; o perfil temporário (que leva a chave) é apagado.
const { app, BrowserWindow, Notification, screen } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const endpoint = process.env.POFU_TEST_API_URL, key = process.env.POFU_TEST_API_KEY;
if (!endpoint || !key) { console.error('Set POFU_TEST_API_URL and POFU_TEST_API_KEY. This test makes real API requests.'); process.exit(2); }
if (process.platform !== 'win32') { console.error('Input nativo só está implementado no Windows.'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'pofu-computador-real-'));
const workspace = join(profile, 'projeto'); mkdirSync(workspace);
app.setPath('userData', profile);
Notification.prototype.show = () => {};
let alvo = null;
app.on('browser-window-created', (_, win) => { if (win !== alvo) win.hide(); });
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);
const limpa = () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} };

const PAGINA = `<!doctype html><html><head><meta charset="utf-8"><title>Pofu Alvo de Teste</title><style>
body{font:18px system-ui;background:#f4f6f2;color:#1d2a16;margin:0;padding:24px}h1{font-size:24px;margin:0 0 18px}
.linha{display:flex;gap:14px;align-items:center;margin:16px 0}button{font:inherit;padding:10px 22px;border-radius:8px;border:0;cursor:pointer}
#confirmar{background:#2f8f2f;color:#fff}#fim{background:#2456b8;color:#fff}input[type=text]{font:inherit;padding:8px 10px;width:260px}
#status{margin-top:12px;color:#555}.espaco{height:1400px;border-left:4px dashed #c9d2c0;margin:20px 0}</style></head><body>
<h1>Pofu Alvo de Teste</h1>
<div class="linha"><button id="confirmar">Confirmar</button><span>Cliques: <b id="cliques">0</b></span></div>
<form id="form" class="linha"><input id="nome" type="text" placeholder="Nome" autocomplete="off"><span id="enviado"></span></form>
<label class="linha"><input id="termos" type="checkbox"> Aceito os termos</label>
<div id="status">Role até o fim da página para encontrar o último botão.</div>
<div class="espaco"></div>
<div class="linha"><button id="fim">Fim da página</button></div>
<script>
window.estado = { cliques: 0, enviado: null, termos: false, fim: false };
confirmar.onclick = () => { estado.cliques++; cliques.textContent = estado.cliques; };
form.onsubmit = e => { e.preventDefault(); estado.enviado = nome.value; enviado.textContent = 'Enviado: ' + nome.value; };
termos.onchange = () => { estado.termos = termos.checked; };
fim.onclick = () => { estado.fim = true; fim.textContent = 'Clicado!'; };
</script></body></html>`;

const tarefas = [
  { nome: 'clicar num botão', prompt: 'Na janela "Pofu Alvo de Teste" aberta na tela, clique uma vez no botão verde "Confirmar". Confira na captura se o contador de cliques mudou.', confere: e => e.cliques >= 1 },
  { nome: 'digitar e enviar', prompt: 'Na mesma janela "Pofu Alvo de Teste", clique no campo "Nome", digite exatamente Pofu 2026 e pressione Enter. Confira na captura se apareceu "Enviado: Pofu 2026".', confere: e => e.enviado === 'Pofu 2026' },
  { nome: 'marcar caixa', prompt: 'Na janela "Pofu Alvo de Teste", marque a caixa "Aceito os termos" e confira na captura que ela ficou marcada.', confere: e => e.termos === true },
  { nome: 'rolar e clicar', prompt: 'Na janela "Pofu Alvo de Teste" existe um botão azul "Fim da página" lá embaixo, fora da área visível. Role a página dessa janela até encontrá-lo e clique nele. Confira na captura que ele passou a mostrar "Clicado!".', confere: e => e.fim === true },
];

async function main() {
  const models = await (await fetch(endpoint.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } })).json();
  const model = process.env.POFU_TEST_MODEL || models.data?.[0]?.id;
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { apiUrl: endpoint, apiKey: key, model, execMode: 'auto', thinkLevel: process.env.POFU_TEST_THINK || 'muito_alto', maxTokens: 32768, temperature: 0.7, topP: 0.9, visionFeedback: true, computerUse: true },
    chats: { real: { id: 'real', name: 'Computador', path: workspace, messages: [] } }, activeChatId: 'real' }));
  await import(pathToFileURL(resolve('out/main.js')));
  await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  win.hide();
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`new Promise(ok => { const poll = () => document.getElementById('studio-model')?.textContent && !document.getElementById('user-input').disabled ? ok(true) : setTimeout(poll, 100); poll(); })`);
  // A visão só é conhecida depois que o app consulta o /models, que corre em paralelo à abertura.
  const ferramentas = await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => import('./out/renderer.js').then(m => { const n = m.activeTools().map(t => t.function.name); n.includes('computer_action') || Date.now() - t0 > 60000 ? ok(n) : setTimeout(poll, 200); }); poll(); })`);
  if (!ferramentas.includes('computer_action')) throw new Error('computer_action não está ativo: ' + ferramentas.join(', '));

  const area = screen.getPrimaryDisplay().workArea;
  alvo = new BrowserWindow({ width: 760, height: 560, x: area.x + Math.round((area.width - 760) / 2), y: area.y + Math.round((area.height - 560) / 2), alwaysOnTop: true, title: 'Pofu Alvo de Teste', backgroundColor: '#f4f6f2' });
  await alvo.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGINA));
  alvo.show(); alvo.focus();
  const estado = () => alvo.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.estado))');

  const relatorio = [];
  for (const t of tarefas) {
    await js(`import('./out/renderer.js').then(m => { const chat = m.activeChat(); chat.messages = []; chat.podaManualAte = 0; chat.podaAutoAte = 0; })`);
    alvo.show(); alvo.focus();
    const inicio = Date.now();
    await js(`(() => { const i = document.getElementById('user-input'); i.value = ${JSON.stringify(t.prompt)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => document.body.classList.contains('agent-running') || Date.now() - t0 > 5000 ? ok(true) : setTimeout(poll, 50); poll(); })`);
    const terminou = await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => !document.body.classList.contains('agent-running') ? ok(true) : Date.now() - t0 > 600000 ? ok(false) : setTimeout(poll, 300); poll(); })`);
    // Seguir com o agente ainda rodando jogaria a próxima tarefa na fila dele e zeraria o
    // histórico no meio do turno: estourou o tempo, para (o Enviar vazio vira Parar) e espera.
    if (!terminou) await js(`new Promise(ok => { document.getElementById('user-input').value = ''; document.getElementById('btn-send').click(); const t0 = Date.now(); const poll = () => !document.body.classList.contains('agent-running') || Date.now() - t0 > 30000 ? ok(true) : setTimeout(poll, 200); poll(); })`);
    const msgs = await js(`import('./out/renderer.js').then(m => JSON.parse(JSON.stringify(m.activeChat().messages.map(x => ({ role: x.role, content: typeof x.content === 'string' ? x.content : '', tool_calls: x.tool_calls })))))`);
    const chamadas = msgs.flatMap(m => (m.tool_calls || []).map(tc => { let a = {}; try { a = JSON.parse(tc.function.arguments || '{}'); } catch {} return tc.function.name === 'computer_action' ? 'computer_action:' + a.action : tc.function.name; }));
    const falhas = msgs.filter(m => m.role === 'tool' && /"success":\s*false/.test(m.content || '')).map(m => (m.content.match(/"error":\s*"([^"]{0,140})/) || [])[1]).filter(Boolean);
    const e = await estado();
    const final = msgs.filter(m => m.role === 'assistant' && (m.content || '').trim()).pop();
    const r = { tarefa: t.nome, passou: t.confere(e), tempoEsgotado: !terminou, segundos: Math.round((Date.now() - inicio) / 1000), requisicoes: msgs.filter(m => m.role === 'assistant').length, chamadas, falhas, estado: e, resposta: String(final?.content || '').trim().slice(0, 300) };
    relatorio.push(r);
    console.log(`${r.passou ? 'PASS' : 'FAIL'} ${t.nome}${r.tempoEsgotado ? ' (tempo esgotado, agente parado)' : ''} · ${r.segundos}s · ${r.requisicoes} requisições · ${chamadas.join(' → ')}`);
    if (falhas.length) console.log('     falhas de ferramenta: ' + falhas.join(' | '));
    console.log('     estado da página: ' + JSON.stringify(e));
    console.log('     resposta: ' + r.resposta.replace(/\n/g, ' '));
  }
  console.log(`RESULT ${relatorio.filter(r => r.passou).length}/${relatorio.length} tarefas no computador concluídas`);
  if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify({ model, relatorio }, null, 2));
  return relatorio.every(r => r.passou);
}
main().then(ok => { alvo?.destroy(); limpa(); app.exit(ok ? 0 : 1); }).catch(err => { console.error(err); alvo?.destroy(); limpa(); app.exit(1); });
