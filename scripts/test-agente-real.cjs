// Teste de ponta a ponta com um modelo REAL, dentro do app: o loop do agente, a poda, a
// trava de looping, as métricas e o MCP rodam como para o usuário. Opcional como o
// test:api — só roda com POFU_TEST_API_URL e POFU_TEST_API_KEY no ambiente, e nunca grava
// a chave em lugar nenhum. Perfil e workspace são temporários.
// Uso: npm run build && npx electron scripts/test-agente-real.cjs  (POFU_TEST_MODEL opcional)
const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const endpoint = process.env.POFU_TEST_API_URL, key = process.env.POFU_TEST_API_KEY;
if (!endpoint || !key) { console.error('Set POFU_TEST_API_URL and POFU_TEST_API_KEY. This test makes real API requests.'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'pofu-agente-real-'));
const workspace = join(profile, 'projeto');
mkdirSync(join(workspace, 'src'), { recursive: true });
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);

// Arquivo grande o bastante para ler inteiro ser o caminho caro: 150 funções parecidas e
// uma só com a fórmula que o cenário pergunta.
const funcoes = [];
for (let i = 0; i < 150; i++) {
  const corpo = i === 97
    ? '  const base = pedido.pesoKg * 3.7;\n  return base + 12;'
    : `  const v = pedido.itens.length * ${i + 1};\n  if (v > ${i * 10}) log('limite ${i}');\n  return v;`;
  const nome = i === 97 ? 'calculaFrete' : `regra${i}`;
  funcoes.push(`// Regra de negócio número ${i}: mantém o cálculo isolado para os testes.\nexport function ${nome}(pedido: Pedido): number {\n${corpo}\n}\n`);
}
writeFileSync(join(workspace, 'src', 'regras.ts'), 'type Pedido = { pesoKg: number; itens: string[] };\ndeclare function log(m: string): void;\n\n' + funcoes.join('\n'));
// O mesmo, dez vezes maior (~230 mil caracteres): aqui ler inteiro custa dezenas de milhares
// de tokens, e é onde list_definitions/search_files deveriam valer a pena.
const muitas = [];
for (let i = 0; i < 1500; i++) {
  const corpo = i === 1234 ? '  return pedido.pesoKg * 0.19 + 4.5;' : `  const v = pedido.itens.length * ${i + 1};\n  if (v > ${i * 10}) log('limite ${i}');\n  return v;`;
  muitas.push(`// Regra fiscal número ${i}: mantém o cálculo isolado para os testes.\nexport function ${i === 1234 ? 'calculaImposto' : `fiscal${i}`}(pedido: Pedido): number {\n${corpo}\n}\n`);
}
writeFileSync(join(workspace, 'src', 'fiscal.ts'), 'type Pedido = { pesoKg: number; itens: string[] };\ndeclare function log(m: string): void;\n\n' + muitas.join('\n'));
writeFileSync(join(workspace, 'src', 'config.ts'), "export const config = {\n  host: 'localhost',\n  port: 3000,\n  debug: false\n};\n");

const cenarios = [
  { nome: 'fórmula numa função de arquivo grande',
    prompt: 'Em src/regras.ts, qual é a fórmula usada pela função calculaFrete? Responda só com a fórmula.',
    confere: (r) => /3[.,]7/.test(r.resposta) && /12/.test(r.resposta) },
  { nome: 'fórmula em arquivo muito grande (~230 mil caracteres)',
    prompt: 'Em src/fiscal.ts, qual é a fórmula usada pela função calculaImposto? Responda só com a fórmula.',
    confere: (r) => /0[.,]19/.test(r.resposta) && /4[.,]5/.test(r.resposta) },
  { nome: 'ferramenta de servidor MCP',
    prompt: 'Use a ferramenta de soma do servidor MCP (não calcule de cabeça) para somar 17 e 25. Responda apenas com o resultado.',
    confere: (r) => r.chamadas.some(c => c.nome === 'mcp__fake__somar') && /42/.test(r.resposta) },
  { nome: 'duas trocas no mesmo arquivo',
    prompt: "Em src/config.ts, troque a porta 3000 por 8080 e o host 'localhost' por '0.0.0.0'. Não mude mais nada.",
    confere: () => readFileSync(join(workspace, 'src', 'config.ts'), 'utf8') === "export const config = {\n  host: '0.0.0.0',\n  port: 8080,\n  debug: false\n};\n" }
];

async function main() {
  const models = await (await fetch(endpoint.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } })).json();
  const model = process.env.POFU_TEST_MODEL || models.data?.[0]?.id;
  let memoryStore = {
    settings: { apiUrl: endpoint, apiKey: key, model, execMode: 'auto', thinkLevel: 'padrao', maxTokens: 8192,
      mcpConfig: JSON.stringify({ mcpServers: { fake: { command: 'node', args: [resolve('scripts/fixtures/mcp-fake.mjs')] } } }) },
    chats: { real: { id: 'real', name: 'Teste real', path: workspace, messages: [] } }, activeChatId: 'real'
  };
  // O renderer persiste a cada turno; mantenha também esses salvamentos só na memória.
  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => registerHandler(channel,
    channel === 'load-store' ? async () => memoryStore :
    channel === 'save-store' ? async (_, data) => { memoryStore = data; return { success: true }; } : handler);
  await import(pathToFileURL(resolve('out/main.js')));
  ipcMain.handle = registerHandler;
  await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  win.hide();
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`new Promise((ok, falha) => { let n = 0; const poll = () => import('./out/renderer.js').then(m => m.activeTools().some(t => t.function.name.startsWith('mcp__')) ? ok(true) : ++n > 600 ? falha(new Error('MCP não conectou')) : setTimeout(poll, 100)); poll(); })`);

  const custoFixo = await js(`Promise.all([import('./out/renderer.js'), import('./out/constants.js')]).then(([m, c]) => ({ferramentas: m.activeTools().length, ferramentasChars: JSON.stringify(m.activeTools()).length, promptChars: c.system_prompt(m.activeChat().path, false, false).length}))`);
  console.log('Custo fixo: ' + JSON.stringify(custoFixo));
  const relatorio = [];
  for (const c of cenarios) {
    await js(`import('./out/renderer.js').then(m => { const chat = m.activeChat(); chat.messages = []; chat.podaManualAte = 0; chat.podaAutoAte = 0; })`);
    const inicio = Date.now();
    await js(`(() => { const i = document.getElementById('user-input'); i.value = ${JSON.stringify(c.prompt)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    // Terminou quando a última mensagem é do assistente, sem chamadas, e o input destravou.
    const msgs = await js(`new Promise((ok, falha) => { const t0 = Date.now(); const poll = () => import('./out/renderer.js').then(m => {
      const ms = m.activeChat().messages, u = ms[ms.length - 1];
      if (ms.length > 1 && u.role === 'assistant' && !u.tool_calls && !document.body.classList.contains('agent-running')) ok(JSON.parse(JSON.stringify(ms)));
      else if (Date.now() - t0 > 600000) falha(new Error('timeout')); else setTimeout(poll, 250); }); poll(); })`);
    const chamadas = msgs.flatMap(m => (m.tool_calls || []).map(tc => ({ nome: tc.function.name, args: tc.function.arguments })));
    const final = msgs[msgs.length - 1];
    const r = { cenario: c.nome, segundos: Math.round((Date.now() - inicio) / 100) / 10,
      requisicoes: msgs.filter(m => m.role === 'assistant').length, chamadas,
      terminal: chamadas.filter(x => x.nome === 'execute_command').map(x => x.args),
      loopsBloqueados: msgs.filter(m => m.role === 'tool' && /Loop detected/.test(m.content || '')).length,
      resposta: String(final.content || '').trim().slice(0, 300), stats: final.stats || null };
    r.passou = c.confere(r);
    relatorio.push(r);
    console.log(`${r.passou ? 'PASS' : 'FAIL'} ${c.nome} · ${r.segundos}s · ${r.requisicoes} requisições · ${chamadas.map(x => x.nome).join(' → ') || '(sem ferramenta)'}` +
      (r.terminal.length ? ` · TERMINAL: ${r.terminal.join(' | ')}` : '') +
      (r.stats ? ` · prompt ${r.stats.prompt} tok${r.stats.cachePct != null ? `, cache ${r.stats.cachePct}%` : ''}${r.stats.tps ? `, ${r.stats.tps} tok/s` : ''}` : ''));
    console.log(`     resposta: ${r.resposta.replace(/\n/g, ' ')}`);
  }
  if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify({ model, custoFixo, relatorio }, null, 2));
  return relatorio.every(r => r.passou);
}
main().then(ok => app.exit(ok ? 0 : 1)).catch(err => { console.error(err); app.exit(1); });
