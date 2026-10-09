// Maratona com modelo REAL dentro do app: uma conversa longa, no mesmo chat, com muitas
// chamadas de ferramenta e processos em segundo plano. Mede se alguma resposta some: o que o
// servidor mandou em cada requisição (texto, raciocínio, ferramentas, finish_reason, [DONE]),
// as novas tentativas automáticas, turnos que morrem sem resposta final e respostas salvas
// que não aparecem na tela. Mesmas variáveis do test:agent; nunca grava a chave.
// POFU_TEST_THINK (padrão muito_alto), POFU_TEST_MAX_TOKENS, POFU_TEST_REPORT opcionais.
const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const endpoint = process.env.POFU_TEST_API_URL, key = process.env.POFU_TEST_API_KEY;
if (!endpoint || !key) { console.error('Set POFU_TEST_API_URL and POFU_TEST_API_KEY. This test makes real API requests.'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'pofu-maratona-'));
const workspace = join(profile, 'projeto');
mkdirSync(join(workspace, 'src'), { recursive: true });
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);
writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'maratona', version: '1.0.0', type: 'commonjs' }, null, 2));
const porta = 39000 + Math.floor(Math.random() * 900);

const turnos = [
  'Crie três arquivos em src/: soma.js, media.js e maior.js. Cada um exporta uma função (soma de um array, média de um array, maior valor de um array). Depois teste cada um separadamente com node -e, um comando por arquivo, e me diga os resultados.',
  `Crie src/servidor.js: um servidor HTTP com o módulo http do Node, na porta ${porta}, que responde "ok". Inicie-o em segundo plano, confirme com http_request que ele responde, e deixe-o rodando.`,
  'Agora rode, em segundo plano, dois comandos node -e que imprimam os números de 1 a 6, um por segundo (setInterval). Espere os dois terminarem com wait_for_process e me mostre a saída de cada um.',
  'Leia os arquivos de src/ e adicione um comentário JSDoc em cada função exportada usando edit_file. Não mude a lógica.',
  'Crie src/teste.js que importa soma, media e maior, verifica cada uma com assert em dois casos, e imprime "todos passaram". Rode com node e corrija o que falhar.',
  `Liste os processos em execução, leia a saída do servidor da porta ${porta}, pare o servidor e confirme que ele parou.`,
  'Rode em segundo plano cinco comandos node -e, cada um imprimindo 200 linhas "linha N do processo K" a cada 20 ms. Enquanto rodam, leia a saída parcial de cada um com read_process_output. Depois espere todos terminarem e diga quantas linhas cada um imprimiu.',
  'Com um script node, gere src/dados.json com 2000 registros {id, nome, valor} (valor aleatório de 1 a 100). Leia o arquivo inteiro com read_file e depois calcule a soma dos valores com um comando node. Diga a soma.',
  'Rode um comando node -e que imprima 3000 linhas numeradas e outro que liste recursivamente os arquivos do projeto. Diga quantas linhas teve cada saída.',
  'Resuma em uma lista curta tudo o que foi feito nesta conversa, com os arquivos criados.',
];

async function main() {
  const models = await (await fetch(endpoint.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } })).json();
  const model = process.env.POFU_TEST_MODEL || models.data?.[0]?.id;
  let memoryStore = {
    settings: { apiUrl: endpoint, apiKey: key, model, execMode: 'auto', thinkLevel: process.env.POFU_TEST_THINK || 'muito_alto', maxTokens: Number(process.env.POFU_TEST_MAX_TOKENS) || 32768, temperature: 0.7, topP: 0.9, cmdTimeout: 20, hideCommandConsole: true },
    chats: { real: { id: 'real', name: 'Maratona', path: workspace, messages: [] } }, activeChatId: 'real'
  };
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
  await js(`new Promise(ok => { const poll = () => document.getElementById('studio-model')?.textContent && !document.getElementById('user-input').disabled ? ok(true) : setTimeout(poll, 100); poll(); })`);
  // Espia o stream sem mexer nele: uma cópia (clone) é lida em paralelo e resumida.
  await js(`(() => { window.__sse = []; const original = window.fetch; window.fetch = async (u, o) => {
    const r = await original(u, o);
    if (String(u).endsWith('/chat/completions')) {
      const reg = { inicio: Date.now(), status: r.status, done: false, finish: null, content: 0, reasoning: 0, tools: 0, erro: null, fim: 0 };
      window.__sse.push(reg);
      if (r.ok) r.clone().text().then(t => { for (const l of t.split('\\n')) { const d = l.trim(); if (!d.startsWith('data:')) continue; const x = d.slice(5).trim(); if (x === '[DONE]') { reg.done = true; continue; }
        try { const j = JSON.parse(x); if (j.error) reg.erro = j.error.message || 'erro'; const c = j.choices && j.choices[0]; if (!c) continue; const dl = c.delta || {};
          reg.content += (dl.content || '').length; reg.reasoning += (dl.reasoning_content || '').length; if (dl.tool_calls) reg.tools = Math.max(reg.tools, ...dl.tool_calls.map(tc => (tc.index ?? 0) + 1)); if (c.finish_reason) reg.finish = c.finish_reason; } catch {} } reg.fim = Date.now(); },
        e => { reg.erro = 'leitura: ' + e.message; reg.fim = Date.now(); });
    }
    return r; }; })()`);

  const relatorio = [];
  // Voltas repetem a lista no MESMO chat: o histórico cresce, que é onde as respostas sumiam.
  const voltas = Number(process.env.POFU_TEST_VOLTAS) || 1;
  const sequencia = Array.from({ length: voltas }, (_, v) => turnos.map(t => v ? `(Volta ${v + 1}) ${t.replace(/src\//g, `src/v${v + 1}/`)}` : t)).flat();
  for (const [n, prompt] of sequencia.entries()) {
    const antes = await js(`(async () => ({ sse: window.__sse.length, msgs: (await import('./out/renderer.js')).activeChat().messages.length, agentes: document.querySelectorAll('#chat-box .message.agent').length, logs: document.querySelectorAll('#chat-box .system-log').length, erros: document.querySelectorAll('#chat-box .error-card, #chat-box .error-msg').length }))()`);
    const inicio = Date.now();
    await js(`(() => { const i = document.getElementById('user-input'); i.value = ${JSON.stringify(prompt)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => document.body.classList.contains('agent-running') || Date.now() - t0 > 5000 ? ok(true) : setTimeout(poll, 50); poll(); })`);
    const fimOk = await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => !document.body.classList.contains('agent-running') ? ok(true) : Date.now() - t0 > 1200000 ? ok(false) : setTimeout(poll, 300); poll(); })`);
    await new Promise(r => setTimeout(r, 1500));
    const d = await js(`(async () => {
      const ms = (await import('./out/renderer.js')).activeChat().messages.slice(${antes.msgs});
      const novos = sel => [...document.querySelectorAll(sel)];
      const logs = novos('#chat-box .system-log').slice(${antes.logs}).map(e => e.innerText);
      const erros = novos('#chat-box .error-card, #chat-box .error-msg').slice(${antes.erros}).map(e => e.innerText.split('\\n').slice(0, 2).join(' | '));
      const ultima = ms[ms.length - 1];
      return { sse: window.__sse.slice(${antes.sse}), logs, erros, retry: novos('#chat-box .retry-card').length,
        chamadas: ms.flatMap(m => (m.tool_calls || []).map(tc => tc.function.name)),
        respostasSalvas: ms.filter(m => m.role === 'assistant' && (m.content || '').trim()).length,
        respostasNaTela: novos('#chat-box .message.agent').length - ${antes.agentes},
        terminouComResposta: !!ultima && ultima.role === 'assistant' && !ultima.tool_calls && !!(ultima.content || '').trim(),
        resposta: String(ultima?.content || '').trim().slice(0, 160) };
    })()`);
    const r = { turno: n + 1, segundos: Math.round((Date.now() - inicio) / 1000), terminou: fimOk, ...d };
    r.vazias = r.sse.filter(s => s.status === 200 && !s.content && !s.tools && !s.erro);
    r.semFim = r.sse.filter(s => s.status === 200 && !s.done && !s.finish);
    r.problema = !fimOk ? 'turno passou de 20 min' : !r.terminouComResposta ? 'turno terminou sem resposta final' : r.respostasNaTela < r.respostasSalvas ? 'resposta salva não apareceu na tela' : null;
    relatorio.push(r);
    console.log(`${r.problema ? 'FAIL' : 'PASS'} turno ${r.turno} · ${r.segundos}s · ${r.sse.length} requisições · ${r.chamadas.length} chamadas (${[...new Set(r.chamadas)].join(', ')})` +
      ` · vazias ${r.vazias.length}${r.vazias.length ? ' [' + r.vazias.map(s => `finish=${s.finish} raciocínio=${s.reasoning}c done=${s.done}`).join('; ') + ']' : ''}` +
      ` · sem fim ${r.semFim.length} · telas ${r.respostasNaTela}/${r.respostasSalvas}${r.problema ? ' · ' + r.problema : ''}`);
    for (const l of r.logs.filter(l => /Tentando de novo|interrompid|cortada|Contexto excedido/i.test(l))) console.log('     log: ' + l);
    for (const e of r.erros) console.log('     erro: ' + e);
    console.log('     resposta: ' + r.resposta.replace(/\n/g, ' '));
  }
  if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify({ model, relatorio }, null, 2));
  const total = relatorio.reduce((a, r) => ({ req: a.req + r.sse.length, vaz: a.vaz + r.vazias.length, cham: a.cham + r.chamadas.length }), { req: 0, vaz: 0, cham: 0 });
  console.log(`RESULT ${relatorio.filter(r => !r.problema).length}/${relatorio.length} turnos sem problema · ${total.req} requisições · ${total.cham} chamadas de ferramenta · ${total.vaz} respostas vazias do servidor`);
  return relatorio.every(r => !r.problema);
}
main().then(ok => app.exit(ok ? 0 : 1)).catch(err => { console.error(err); app.exit(1); });
