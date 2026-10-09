// Controle do computador com modelo REAL e input NATIVO: o mouse e o teclado do Windows se
// mexem de verdade. A tarefa fica restrita a uma janela-alvo que o teste abre por cima de
// tudo, e o resultado é conferido pelo estado da própria página, não pela resposta do
// modelo. Mesmas variáveis do test:agent; a chave fica apenas na memória.
const { app, BrowserWindow, ipcMain, Notification, screen } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const endpoint = process.env.POFU_TEST_API_URL, key = process.env.POFU_TEST_API_KEY;
const prazoTarefa = Number(process.env.POFU_TEST_TIMEOUT_MS || 600000);
if (!endpoint || !key) { console.error('Set POFU_TEST_API_URL and POFU_TEST_API_KEY. This test makes real API requests.'); process.exit(2); }
if (process.platform !== 'win32') { console.error('Input nativo só está implementado no Windows.'); process.exit(2); }
if (!Number.isFinite(prazoTarefa) || prazoTarefa < 30000 || prazoTarefa > 600000) { console.error('POFU_TEST_TIMEOUT_MS deve ficar entre 30000 e 600000.'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'pofu-computador-real-'));
const workspace = join(profile, 'projeto'); mkdirSync(workspace);
app.setPath('userData', profile);
Notification.prototype.show = () => {};
let alvo = null, notas = null;
app.on('browser-window-created', (_, win) => { if (win !== alvo && win !== notas) win.hide(); });
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);
const limpa = () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} };

const PAGINA = `<!doctype html><html><head><meta charset="utf-8"><title>Pofu Alvo de Teste</title><style>
body{font:18px system-ui;background:#f4f6f2;color:#1d2a16;margin:0;padding:24px}h1{font-size:24px;margin:0 0 18px}
.linha{display:flex;gap:14px;align-items:center;margin:16px 0}button{font:inherit;padding:10px 22px;border-radius:8px;border:0;cursor:pointer}
#confirmar{background:#2f8f2f;color:#fff}#fim{background:#2456b8;color:#fff}input[type=text]{font:inherit;padding:8px 10px;width:260px}
#status{margin-top:12px;color:#555}.espaco{height:1400px;border-left:4px dashed #c9d2c0;margin:20px 0}</style></head><body>
<h1>Pofu Alvo de Teste</h1>
<button id="abrir">Abrir Notas Pofu</button>
<div class="linha"><button id="confirmar">Confirmar</button><span>Cliques: <b id="cliques">0</b></span></div>
<form id="form" class="linha"><input id="nome" type="text" placeholder="Nome" autocomplete="off"><span id="enviado"></span></form>
<label class="linha"><input id="termos" type="checkbox"> Aceito os termos</label>
<div id="status">Role até o fim da página para encontrar o último botão.</div>
<div class="espaco"></div>
<div class="linha"><button id="fim">Fim da página</button></div>
<script>
window.estado = { cliques: 0, enviado: null, termos: false, fim: false };
abrir.onclick = () => window.teste.abrirNotas();
confirmar.onclick = () => { estado.cliques++; cliques.textContent = estado.cliques; };
form.onsubmit = e => { e.preventDefault(); estado.enviado = nome.value; enviado.textContent = 'Enviado: ' + nome.value; };
termos.onchange = () => { estado.termos = termos.checked; };
fim.onclick = () => { estado.fim = true; fim.textContent = 'Clicado!'; };
</script></body></html>`;

const NOTAS = `<!doctype html><html><head><meta charset="utf-8"><title>Notas Pofu — Teste</title><style>
body{font:20px system-ui;background:#f4f6f2;color:#1d2a16;padding:24px}textarea{display:block;width:90%;height:260px;font:22px system-ui;margin:14px 0}
button{font:inherit;background:#2f8f2f;color:white;padding:12px 28px;border:0;border-radius:8px}</style></head><body>
<h1>Notas Pofu — Teste</h1><label for="texto">Sua nota</label><textarea id="texto" placeholder="Escreva aqui"></textarea>
<button id="salvar">Salvar nota</button><p>Atalho: Ctrl+S</p><p id="status">Nenhuma nota salva.</p>
<script>
window.estado = { texto: '', salvo: '', salvamentos: 0 };
texto.oninput = () => { estado.texto = texto.value; document.getElementById('status').textContent = 'Alterações pendentes.'; };
async function salva() { const valor = texto.value; await window.teste.salvarNota(valor); estado.salvo = valor; estado.salvamentos++; document.getElementById('status').textContent = 'Nota salva.'; }
salvar.onclick = salva;
document.addEventListener('keydown', e => { if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); salva(); } });
</script></body></html>`;
const primeiraNota = 'Teste de controle\nAção concluída com acentuação: café, coração e João.';
const segundaNota = 'Revisão concluída: amanhã às 10h. 🐾';
const arquivoNota = join(workspace, 'nota-controle.txt');
const nativeCalls = [], capturas = [];
let memoryStore;
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel,
  channel === 'load-store' ? async event => { await handler(event); return memoryStore; } :
  channel === 'save-store' ? async (event, data) => {
    // O handler real atualiza a permissão no main. Só o sinalizador chega ao disco.
    const saved = await handler(event, { settings: { computerUse: data?.settings?.computerUse === true } });
    if (saved.success) memoryStore = data;
    return saved;
  } :
  async (...args) => {
    const result = await handler(...args);
    if (channel === 'computer-action') nativeCalls.push({ argumentos: args[1], success: result.success, error: result.error });
    if (channel === 'capture-screen') capturas.push({ success: result.success, pixels: Boolean(result.dataUrl), error: result.error });
    return result;
  });

const tarefas = [
  { nome: 'clicar num botão', prompt: 'Na janela "Pofu Alvo de Teste" aberta na tela, clique uma vez no botão verde "Confirmar". Confira na captura se o contador de cliques mudou.', confere: e => e.cliques === 1 },
  { nome: 'digitar e enviar', prompt: 'Na mesma janela "Pofu Alvo de Teste", clique no campo "Nome", digite exatamente Pofu 2026 e pressione Enter. Confira na captura se apareceu "Enviado: Pofu 2026".', confere: e => e.enviado === 'Pofu 2026' },
  { nome: 'marcar caixa', prompt: 'Na janela "Pofu Alvo de Teste", marque a caixa "Aceito os termos" e confira na captura que ela ficou marcada.', confere: e => e.termos === true },
  { nome: 'rolar e clicar', prompt: 'Na janela "Pofu Alvo de Teste" existe um botão azul "Fim da página" lá embaixo, fora da área visível. Role a página dessa janela até encontrá-lo e clique nele. Confira na captura que ele passou a mostrar "Clicado!".', confere: e => e.fim === true },
  { nome: 'abrir editor, escrever e salvar', prompt: `Na janela "Pofu Alvo de Teste", volte ao início e clique em "Abrir Notas Pofu". Na nova janela "Notas Pofu — Teste", escreva exatamente estas duas linhas no campo "Sua nota":\n${primeiraNota}\nClique em "Salvar nota" e confira se aparece "Nota salva.". Use somente capture_screen e computer_action para interagir, sem terminal ou ferramentas de arquivo.`, confere: e => e.nota?.salvo === primeiraNota && e.arquivo === primeiraNota && e.nota.salvamentos === 1 },
  { nome: 'substituir texto e salvar por atalho', prompt: `Na janela "Notas Pofu — Teste", clique no campo "Sua nota", selecione todo o texto com Ctrl+A e substitua por exatamente: ${segundaNota}\nSalve com Ctrl+S e confira "Nota salva.". Use somente capture_screen e computer_action para interagir, sem terminal ou ferramentas de arquivo.`, confere: e => e.nota?.salvo === segundaNota && e.arquivo === segundaNota && e.nota.salvamentos === 2 },
];

async function main() {
  const models = await (await fetch(endpoint.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } })).json();
  const model = process.env.POFU_TEST_MODEL || models.data?.[0]?.id;
  const thinkLevel = process.env.POFU_TEST_THINK || 'muito_alto';
  memoryStore = { settings: { apiUrl: endpoint, apiKey: key, model, execMode: 'auto', thinkLevel, maxTokens: 32768, temperature: 0.7, topP: 0.9, visionFeedback: true, computerUse: true },
    chats: { real: { id: 'real', name: 'Computador', path: workspace, messages: [] } }, activeChatId: 'real' };
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { computerUse: true } }));
  await import(pathToFileURL(resolve('out/main.js')));
  ipcMain.handle = registerHandler;
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
  await js(`(() => { const original = window.fetch; window.__testeImagens = 0; window.__testeRequests = []; window.fetch = (url, options) => {
    if (String(url).includes('/chat/completions') && options?.body) { const payload = JSON.parse(options.body);
      const imagem = payload.messages?.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
      if (imagem) window.__testeImagens++;
      const request = { imagem: Boolean(imagem), inicio: new Date().toISOString(), status: null }; window.__testeRequests.push(request);
      return original(url, options).then(response => { request.status = response.status; return response; }, error => { request.erro = error.name; throw error; }); }
    return original(url, options); }; })()`);

  const area = screen.getPrimaryDisplay().workArea;
  const preload = join(profile, 'preload-teste.cjs');
  writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('teste',{abrirNotas:()=>ipcRenderer.invoke('teste-abrir-notas'),salvarNota:texto=>ipcRenderer.invoke('teste-salvar-nota',texto)});");
  const options = { width: 760, height: 560, x: area.x, y: area.y, alwaysOnTop: true, backgroundColor: '#f4f6f2', webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } };
  registerHandler('teste-abrir-notas', async event => {
    if (event.sender !== alvo.webContents) throw new Error('Janela de teste inválida.');
    if (!notas) { notas = new BrowserWindow({ ...options, title: 'Notas Pofu — Teste' }); await notas.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(NOTAS)); }
    notas.maximize(); notas.show(); notas.focus();
  });
  registerHandler('teste-salvar-nota', async (event, texto) => {
    if (event.sender !== notas?.webContents || typeof texto !== 'string' || texto.length > 2000) throw new Error('Nota de teste inválida.');
    writeFileSync(arquivoNota, texto, 'utf8');
  });
  alvo = new BrowserWindow({ ...options, title: 'Pofu Alvo de Teste' });
  await alvo.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGINA));
  alvo.maximize(); alvo.show(); alvo.focus();
  const estado = async () => ({ ...await alvo.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.estado))'),
    nota: notas ? await notas.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.estado))') : null,
    arquivo: existsSync(arquivoNota) ? readFileSync(arquivoNota, 'utf8') : null });
  console.log('Modelo: ' + model);

  if (process.env.POFU_TEST_NATIVE_ONLY === '1') {
    const tool = async (name, args) => {
      const result = await js(`import('./out/renderer.js').then(m => m.runTool(${JSON.stringify(name)}, ${JSON.stringify(args)}, ${JSON.stringify(workspace)}))`);
      const data = JSON.parse(typeof result === 'string' ? result : result.text);
      if (!data.success) throw new Error(data.error || data.observation_error || 'Falha no controle nativo.');
      return data;
    };
    let shot = await tool('capture_screen', { display_id: 'primary' });
    const action = async args => { shot = await tool('computer_action', { ...args, screenshot_id: shot.screenshot_id }); };
    const click = async (window, id) => {
      const point = await window.webContents.executeJavaScript(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      const bounds = window.getContentBounds(), monitor = screen.getPrimaryDisplay().bounds;
      await action({ action: 'click', x: Math.floor((bounds.x - monitor.x + point.x) * shot.width / monitor.width), y: Math.floor((bounds.y - monitor.y + point.y) * shot.height / monitor.height) });
    };
    const resultados = [];
    const verifica = async index => {
      const e = await estado(), passou = tarefas[index].confere(e);
      resultados.push({ tarefa: tarefas[index].nome, passou, estado: e });
      console.log(`${passou ? 'PASS' : 'FAIL'} nativo sem modelo: ${tarefas[index].nome}`);
      if (!passou) throw new Error('Estado divergente: ' + JSON.stringify(e));
    };
    console.log('Diagnóstico nativo sem geração do modelo. Coordenadas vêm da janela de teste.');
    await click(alvo, 'confirmar'); await verifica(0);
    await click(alvo, 'nome'); await action({ action: 'type', text: 'Pofu 2026' }); await action({ action: 'key', keys: ['ENTER'] }); await verifica(1);
    await click(alvo, 'termos'); await verifica(2);
    for (let i = 0; i < 6; i++) {
      const visivel = await alvo.webContents.executeJavaScript('fim.getBoundingClientRect().bottom <= innerHeight');
      if (visivel) break;
      await action({ action: 'scroll', x: Math.floor(shot.width / 2), y: Math.floor(shot.height / 2), direction: 'down', amount: 10 });
    }
    await click(alvo, 'fim'); await verifica(3);
    await action({ action: 'key', keys: ['CTRL', 'HOME'] }); await click(alvo, 'abrir');
    await notas.webContents.executeJavaScript('new Promise(ok => { const poll = () => document.getElementById("texto") ? ok(true) : setTimeout(poll,50); poll(); })');
    shot = await tool('capture_screen', {});
    await click(notas, 'texto'); await action({ action: 'type', text: primeiraNota }); await click(notas, 'salvar'); await verifica(4);
    await click(notas, 'texto'); await action({ action: 'key', keys: ['CTRL', 'A'] }); await action({ action: 'type', text: segundaNota }); await action({ action: 'key', keys: ['CTRL', 'S'] }); await verifica(5);
    if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify({ modo: 'nativo sem modelo', data: new Date().toISOString(), resultados, inputs: nativeCalls, capturas }, null, 2));
    if (process.env.POFU_QA_OUTPUT) { mkdirSync(process.env.POFU_QA_OUTPUT, { recursive: true }); writeFileSync(join(process.env.POFU_QA_OUTPUT, 'notas-nativo-sem-modelo.png'), (await notas.webContents.capturePage()).toPNG()); }
    return resultados.every(r => r.passou);
  }

  const relatorio = [];
  const salvaRelatorio = () => {
    if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify({ model, thinkLevel, prazoTarefa, data: new Date().toISOString(), relatorio }, null, 2));
  };
  const selecionadas = process.env.POFU_TEST_TASK ? tarefas.filter(t => t.nome === process.env.POFU_TEST_TASK) : tarefas;
  if (!selecionadas.length) throw new Error('POFU_TEST_TASK não corresponde a uma tarefa.');
  for (const t of selecionadas) {
    await js(`import('./out/renderer.js').then(m => { const chat = m.activeChat(); chat.messages = []; chat.podaManualAte = 0; chat.podaAutoAte = 0; })`);
    const janela = t.nome === 'substituir texto e salvar por atalho' ? notas : alvo;
    if (!janela) {
      relatorio.push({ tarefa: t.nome, prompt: t.prompt, passou: false, naoExecutada: true, motivo: 'O modelo não abriu o editor na tarefa anterior.' });
      salvaRelatorio();
      console.log('SKIP ' + t.nome + ': o editor não foi aberto.');
      continue;
    }
    janela.show(); janela.focus();
    const inicio = Date.now();
    const inicioInputs = nativeCalls.length, inicioCapturas = capturas.length;
    const inicioImagens = await js('window.__testeImagens');
    const inicioRequests = await js('window.__testeRequests.length');
    console.log('START ' + t.nome);
    await js(`(() => { const i = document.getElementById('user-input'); i.value = ${JSON.stringify(t.prompt)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => document.body.classList.contains('agent-running') || Date.now() - t0 > 5000 ? ok(true) : setTimeout(poll, 50); poll(); })`);
    const progress = setInterval(() => console.log('     em execução: ' + t.nome + ' · ' + Math.round((Date.now() - inicio) / 1000) + 's · inputs nativos: ' + (nativeCalls.length - inicioInputs)), 30000);
    let terminou;
    try { terminou = await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => !document.body.classList.contains('agent-running') ? ok(true) : Date.now() - t0 > ${prazoTarefa} ? ok(false) : setTimeout(poll, 300); poll(); })`); }
    finally { clearInterval(progress); }
    // Seguir com o agente ainda rodando jogaria a próxima tarefa na fila dele e zeraria o
    // histórico no meio do turno: estourou o tempo, para (o Enviar vazio vira Parar) e espera.
    if (!terminou) {
      const parado = await js(`new Promise(ok => { document.getElementById('user-input').value = ''; document.getElementById('btn-send').click(); const t0 = Date.now(); const poll = () => !document.body.classList.contains('agent-running') ? ok(true) : Date.now() - t0 > 30000 ? ok(false) : setTimeout(poll, 200); poll(); })`);
      if (!parado) throw new Error('O agente não parou. As próximas tarefas não serão executadas.');
    }
    const msgs = await js(`import('./out/renderer.js').then(m => JSON.parse(JSON.stringify(m.activeChat().messages.map(x => ({ role: x.role, content: typeof x.content === 'string' ? x.content : '', tool_calls: x.tool_calls })))))`);
    const chamadas = msgs.flatMap(m => (m.tool_calls || []).map(tc => { let a = {}; try { a = JSON.parse(tc.function.arguments || '{}'); } catch {} return tc.function.name === 'computer_action' ? 'computer_action:' + a.action : tc.function.name; }));
    const falhas = msgs.filter(m => m.role === 'tool' && /"success":\s*false/.test(m.content || '')).map(m => (m.content.match(/"error":\s*"([^"]{0,140})/) || [])[1]).filter(Boolean);
    const e = await estado();
    const final = msgs.filter(m => m.role === 'assistant' && (m.content || '').trim()).pop();
    const inputs = nativeCalls.slice(inicioInputs), imagens = capturas.slice(inicioCapturas);
    const requisicoesComImagem = await js('window.__testeImagens') - inicioImagens;
    const requests = await js(`JSON.parse(JSON.stringify(window.__testeRequests.slice(${inicioRequests})))`);
    const r = { tarefa: t.nome, prompt: t.prompt, passou: terminou && t.confere(e) && inputs.some(c => c.success) && imagens.some(c => c.success && c.pixels) && requisicoesComImagem > 0, tempoEsgotado: !terminou, segundos: Math.round((Date.now() - inicio) / 1000), requisicoes: requests.length, respostas: msgs.filter(m => m.role === 'assistant').length, requests, requisicoesComImagem, chamadas, inputs, capturas: imagens, falhas, estado: e, resposta: String(final?.content || '').trim().slice(0, 500) };
    relatorio.push(r);
    salvaRelatorio();
    if (process.env.POFU_QA_OUTPUT) {
      mkdirSync(process.env.POFU_QA_OUTPUT, { recursive: true });
      const shot = await (notas || alvo).webContents.capturePage();
      writeFileSync(join(process.env.POFU_QA_OUTPUT, `computador-real-${relatorio.length}.png`), shot.toPNG());
    }
    console.log(`${r.passou ? 'PASS' : 'FAIL'} ${t.nome}${r.tempoEsgotado ? ' (tempo esgotado, agente parado)' : ''} · ${r.segundos}s · ${r.requisicoes} requisições · ${chamadas.join(' → ')}`);
    if (falhas.length) console.log('     falhas de ferramenta: ' + falhas.join(' | '));
    console.log('     estado da página: ' + JSON.stringify(e));
    console.log('     resposta: ' + r.resposta.replace(/\n/g, ' '));
  }
  console.log(`RESULT ${relatorio.filter(r => r.passou).length}/${relatorio.length} tarefas no computador concluídas`);
  salvaRelatorio();
  return relatorio.every(r => r.passou);
}
main().then(ok => { notas?.destroy(); alvo?.destroy(); limpa(); app.exit(ok ? 0 : 1); }).catch(err => { console.error(err); notas?.destroy(); alvo?.destroy(); limpa(); app.exit(1); });
