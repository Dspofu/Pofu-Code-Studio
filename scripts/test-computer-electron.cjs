// O app, o preload e os IPCs são reais; os pixels são sintéticos e nenhum input nativo é permitido.
const { app, BrowserWindow, Notification, desktopCapturer, nativeImage, screen, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');
const assert = require('node:assert/strict');

const profile = mkdtempSync(join(tmpdir(), 'pofu-computer-test-'));
const workspace = join(profile, 'projeto');
mkdirSync(workspace);
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);

let nativeAttempts = 0, captures = 0;
const simulatedInputs = [];
for (const method of ['spawn', 'execFile']) {
  const original = childProcess[method];
  childProcess[method] = function (command, ...args) {
    if (/powershell|pwsh|xdotool|osascript/i.test(String(command))) {
      if (method !== 'spawn') { nativeAttempts++; throw new Error('O teste bloqueou uma tentativa de input nativo.'); }
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let raw = '';
      child.stdin = new Writable({ write(chunk, _, done) { raw += chunk.toString('utf8'); done(); } });
      child.stdin.on('finish', () => {
        const request = JSON.parse(raw);
        if (request.action !== 'observe') simulatedInputs.push(request);
        setImmediate(() => { child.stdout.write(JSON.stringify(request.action === 'observe' ? { success: true, handle: '123', pid: 99 } : { success: true })); child.emit('close', 0); });
      });
      child.kill = () => { child.emit('close', 1); return true; };
      return child;
    }
    return original.call(this, command, ...args);
  };
}
syncBuiltinESMExports();
const fixtureImage = nativeImage.createFromBitmap(Buffer.from(Array.from({ length: 96 * 64 }, (_, i) => [40, i % 255, 86, 255]).flat()), { width: 96, height: 64 });
writeFileSync(join(workspace, 'imagem.png'), fixtureImage.toPNG());
writeFileSync(join(profile, 'fora.png'), fixtureImage.toPNG());
mkdirSync(join(profile, 'externo'));
writeFileSync(join(profile, 'externo', 'fora.png'), fixtureImage.toPNG());
symlinkSync(join(profile, 'externo'), join(workspace, 'atalho'), process.platform === 'win32' ? 'junction' : 'dir');
writeFileSync(join(workspace, 'texto.png'), 'Este arquivo não contém pixels.');
desktopCapturer.getSources = async () => {
  captures++;
  return screen.getAllDisplays().map(display => ({ id: `screen:${display.id}:0`, display_id: String(display.id), name: 'Monitor sintético', thumbnail: fixtureImage }));
};

const ipcCalls = [];
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel, async (event, ...args) => {
  if (['view-image', 'capture-screen', 'computer-action'].includes(channel)) ipcCalls.push(channel);
  return handler(event, ...args);
});

let roteiro = null;
const corpos = [];
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [
    { id: 'pofu-visao', meta: { n_ctx: 131072 }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'pofu-texto', meta: { n_ctx: 131072 }, architecture: { input_modalities: ['text'] } }
  ] }));
  if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    corpos.push(JSON.parse(raw));
    const passo = roteiro?.shift() || { content: 'FIM_SEM_ROTEIRO' };
    const delta = passo.tool ? { tool_calls: [{ index: 0, id: passo.id, type: 'function', function: { name: passo.tool, arguments: JSON.stringify(passo.args || {}) } }] }
      : { content: passo.content };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: passo.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: Math.round(raw.length / 4), completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
  });
});

let passed = 0;
const custo = {};
const pause = ms => new Promise(r => setTimeout(r, ms));
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: {
    apiUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'pofu-visao', webSearch: false, execMode: 'manual'
  }, chats: { qa: { id: 'qa', name: 'Teste de visão', path: workspace, messages: [] } }, activeChatId: 'qa' }));
  await import(pathToFileURL(resolve('out/main.js')));
  await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async (expression, name) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await pause(40);
    }
    throw new Error(`Tempo esgotado: ${name}`);
  };
  const active = () => js(`import('./out/renderer.js').then(m => m.activeTools().map(t => t.function.name))`);
  const tool = (name, args) => js(`import('./out/renderer.js').then(m => m.runTool(${JSON.stringify(name)}, ${JSON.stringify(args)}, ${JSON.stringify(workspace)}))`);
  const data = raw => JSON.parse(typeof raw === 'string' ? raw : raw.text);
  const ipc = (method, ...args) => js(`window.electronAPI[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const openSettings = () => js(`document.getElementById('btn-open-settings').click(); document.querySelector('.nav-tab-btn[data-tab="tab-personalizacao"]').click()`);
  const saveSettings = async ({ computer, vision, model }) => {
    await openSettings();
    if (model) await waitFor(`Array.from(document.getElementById('model-name').options).some(o=>o.value===${JSON.stringify(model)})`, 'modelo disponível no formulário');
    await js(`(() => {
      ${computer === undefined ? '' : `document.getElementById('check-computer').checked=${computer}; document.getElementById('check-computer').dispatchEvent(new Event('change'));`}
      ${vision === undefined ? '' : `document.getElementById('check-vision').checked=${vision}; document.getElementById('check-vision').dispatchEvent(new Event('change'));`}
      ${model === undefined ? '' : `document.getElementById('model-name').value=${JSON.stringify(model)}; document.getElementById('model-name').dispatchEvent(new Event('change'));`}
      document.getElementById('btn-save-settings').click();
    })()`);
    await waitFor(`!document.getElementById('settings-modal').classList.contains('active')`, 'salvar configurações');
    await pause(80);
  };
  const cost = () => js(`Promise.all([import('./out/renderer.js'),import('./out/constants.js')]).then(([m,c])=>({
    baseTools: JSON.stringify(m.tools).length, activeTools: JSON.stringify(m.activeTools()).length,
    baseSystem: c.system_prompt(m.activeChat().path,false,false,false).length,
    visionSystem: c.system_prompt(m.activeChat().path,false,true,false).length,
    computerSystem: c.system_prompt(m.activeChat().path,false,true,true).length,
    toolCount: m.activeTools().length }))`);
  const start = async (steps, label) => {
    roteiro = steps;
    await js(`(() => { const input=document.getElementById('user-input'); input.value=${JSON.stringify(label)}; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
  };
  const finish = async marker => {
    await waitFor(`import('./out/renderer.js').then(m=>m.activeChat().messages.some(x=>x.role==='assistant'&&x.content===${JSON.stringify(marker)}))`, marker);
    await waitFor(`!document.body.classList.contains('agent-running')`, 'fim do turno');
    await pause(80);
  };

  await waitFor(`import('./out/renderer.js').then(m=>m.activeTools().some(t=>t.function.name==='view_image'))`, 'modelo com visão');
  await check('controle nasce desligado, inclusive no IPC, e imagem local continua disponível', async () => {
    await openSettings();
    assert.equal(await js(`document.getElementById('check-computer').checked`), false);
    await js(`document.getElementById('btn-close-modal').click()`);
    const names = await active();
    assert.ok(names.includes('view_image'));
    assert.ok(!names.includes('capture_screen') && !names.includes('computer_action'));
    assert.equal((await ipc('captureScreen', {})).success, false);
    assert.equal((await ipc('computerAction', { action: 'invalid_action', screenshot_id: 'x' })).success, false);
    assert.equal(captures, 0);
    custo.desligado = await cost();
  });

  await check('view_image valida imagem e limita leitura ao workspace', async () => {
    const valid = await tool('view_image', { filename: 'imagem.png' });
    assert.equal(data(valid).success, true);
    assert.deepEqual([valid.image.width, valid.image.height], [96, 64]);
    assert.match(valid.image.dataUrl, /^data:image\/png;base64,/);
    assert.equal(data(await tool('view_image', { filename: '../fora.png' })).success, false);
    assert.equal(data(await tool('view_image', { filename: 'texto.png' })).success, false);
    assert.equal((await ipc('viewImage', join(profile, 'fora.png'), { workspace })).success, false);
    assert.equal((await ipc('viewImage', join(workspace, 'atalho', 'fora.png'), { workspace })).success, false);
  });

  await check('janela externa não pode habilitar desktop, ler store ou usar os novos IPCs', async () => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload: resolve('out/preload.cjs'), contextIsolation: true, nodeIntegration: false } });
    await other.loadURL('data:text/html,<h1>Janela de teste</h1>');
    try {
      const result = await other.webContents.executeJavaScript(`Promise.all([window.electronAPI.captureScreen({}), window.electronAPI.computerAction({action:'key',screenshot_id:'x',keys:['ENTER']}), window.electronAPI.saveStore({settings:{computerUse:true}}), window.electronAPI.loadStore()])`);
      assert.ok(result.slice(0, 3).every(r => r.success === false));
      assert.equal(result[3], null);
      assert.equal(captures, 0);
    } finally { other.destroy(); }
  });

  await check('permissão salva habilita ferramentas; desligar envio de imagens e modelo só texto as retiram', async () => {
    await saveSettings({ computer: true, vision: true });
    assert.ok((await active()).includes('computer_action'));
    custo.ligado = await cost();
    await saveSettings({ vision: false });
    assert.ok(!(await active()).includes('view_image'));
    assert.ok(!(await active()).includes('capture_screen'));
    assert.equal(data(await tool('capture_screen', {})).success, false);
    await saveSettings({ vision: true, model: 'pofu-texto' });
    assert.ok(!(await active()).includes('view_image'));
    assert.ok(!(await active()).includes('capture_screen'));
    await saveSettings({ model: 'pofu-visao' });
    await waitFor(`import('./out/renderer.js').then(m=>m.activeTools().some(t=>t.function.name==='capture_screen'))`, 'visão reativada');
  });

  let screenshot;
  await check('captura sintética passa pelo IPC real e ação inválida não executa input', async () => {
    screenshot = await tool('capture_screen', {});
    assert.equal(data(screenshot).success, true);
    assert.ok(data(screenshot).screenshot_id);
    assert.ok(existsSync(screenshot.image.path));
    assert.equal(data(await tool('computer_action', { action: 'invalid_action', screenshot_id: data(screenshot).screenshot_id })).success, false);
    assert.equal(nativeAttempts, 0);
    assert.ok(captures > 0);
  });

  await check('loop envia pixels de view_image e capture_screen; histórico guarda só caminhos', async () => {
    const index = corpos.length;
    await start([
      { tool: 'view_image', id: 'imagem-local', args: { filename: 'imagem.png' } },
      { tool: 'capture_screen', id: 'tela-sintetica', args: {} },
      { content: 'FIM_IMAGENS' }
    ], 'Inspecione as imagens do teste.');
    await finish('FIM_IMAGENS');
    const sent = corpos[index + 2].messages.filter(m => m.role === 'tool');
    for (const id of ['imagem-local', 'tela-sintetica']) {
      const message = sent.find(m => m.tool_call_id === id);
      assert.ok(message.content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,')), id);
      assert.ok(!message.content.some(c => c.type === 'text' && c.text.includes('data:image')));
    }
    const history = await js(`import('./out/renderer.js').then(m=>m.activeChat().messages)`);
    assert.equal(JSON.stringify(history).includes('data:image'), false);
    assert.ok(history.filter(m => m.role === 'tool').every(m => m.image?.path));
    assert.equal(readFileSync(join(profile, 'app-store.json'), 'utf8').includes('data:image'), false);
  });

  await check('modo Manual pede confirmação e recusa não chega ao IPC de ação', async () => {
    const before = ipcCalls.filter(c => c === 'computer-action').length;
    await start([{ tool: 'computer_action', id: 'acao-recusada', args: { action: 'click', screenshot_id: data(screenshot).screenshot_id, x: 10, y: 10 } }, { content: 'FIM_RECUSA' }], 'Teste de confirmação sem executar.');
    await waitFor(`document.getElementById('confirm-modal').classList.contains('active')`, 'aprovação manual');
    assert.match(await js(`document.getElementById('confirm-label').textContent`), /computador/i);
    await js(`document.getElementById('confirm-reject').click()`);
    await finish('FIM_RECUSA');
    assert.equal(ipcCalls.filter(c => c === 'computer-action').length, before);
    assert.equal(nativeAttempts, 0);
  });

  await check('ação aprovada envia input simulado e devolve outra imagem com ID novo', async () => {
    const seen = data(await tool('capture_screen', {}));
    const before = simulatedInputs.length;
    await start([{ tool: 'computer_action', id: 'acao-aprovada', args: { action: 'key', screenshot_id: seen.screenshot_id, keys: ['CTRL', 'L'] } }, { content: 'FIM_APROVACAO' }], 'Teste com adaptador de input simulado.');
    await waitFor(`document.getElementById('confirm-modal').classList.contains('active')`, 'aprovação manual');
    await js(`document.getElementById('confirm-approve').click()`);
    await finish('FIM_APROVACAO');
    assert.equal(simulatedInputs.length, before + 1);
    assert.deepEqual(simulatedInputs.at(-1).codes, [17, 76]);
    const history = await js(`import('./out/renderer.js').then(m=>m.activeChat().messages)`);
    const result = history.find(m => m.tool_call_id === 'acao-aprovada');
    assert.equal(JSON.parse(result.content).operation_status, 'completed');
    assert.notEqual(JSON.parse(result.content).screenshot_id, seen.screenshot_id);
    assert.ok(result.image?.path);
    assert.equal(nativeAttempts, 0);
  });

  await check('recarregar reidrata as imagens antes do próximo payload', async () => {
    win.reload();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await waitFor(`import('./out/renderer.js').then(m=>m.activeTools().some(t=>t.function.name==='view_image'))`, 'recarga com visão');
    const index = corpos.length;
    await start([{ content: 'FIM_RECARGA' }], 'Continue depois de recarregar.');
    await finish('FIM_RECARGA');
    for (const id of ['tela-sintetica', 'acao-aprovada']) {
      const message = corpos[index].messages.find(m => m.tool_call_id === id);
      assert.ok(message.content.some(c => c.type === 'image_url'), id);
    }
  });

  await check('revogar permissão fecha acesso direto ao IPC e remove ferramentas', async () => {
    await saveSettings({ computer: false });
    const before = captures;
    assert.equal((await ipc('captureScreen', {})).success, false);
    assert.equal((await ipc('computerAction', { action: 'invalid_action', screenshot_id: data(screenshot).screenshot_id })).success, false);
    assert.ok(!(await active()).includes('computer_action'));
    assert.equal(captures, before);
    assert.equal(nativeAttempts, 0);
  });

  if (process.env.POFU_QA_OUTPUT) {
    mkdirSync(process.env.POFU_QA_OUTPUT, { recursive: true });
    win.setContentSize(1380, 900);
    await openSettings();
    await js(`document.getElementById('check-computer').closest('.cfg-section').scrollIntoView({block:'center'})`);
    win.showInactive();
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
    await pause(300);
    writeFileSync(join(process.env.POFU_QA_OUTPUT, 'studio-computer-tools.png'), (await win.webContents.capturePage()).toPNG());
    win.hide();
    writeFileSync(join(process.env.POFU_QA_OUTPUT, 'computer-report.json'), JSON.stringify({ passed, captures, nativeAttempts, custo }, null, 2));
  }
  console.log('CUSTO ' + JSON.stringify(custo));
  console.log(`RESULT ${passed} verificações de computador passaram; ${captures} capturas sintéticas; ${nativeAttempts} inputs nativos`);
}

main().then(() => { server.close(); app.exit(0); }).catch(error => { console.error(error); server.close(); app.exit(1); });
