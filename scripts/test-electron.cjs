// Exercita o app real com preload, IPC e renderer; perfil e arquivos são isolados.
const { app, BrowserWindow, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const profile = mkdtempSync(join(tmpdir(), 'pofu-studio-test-'));
const workspace = join(profile, 'fixture');
mkdirSync(workspace);
writeFileSync(join(workspace, 'arquivo com espaços.md'), 'Conteúdo da menção de teste.');
app.setPath('userData', profile);
Notification.prototype.show = () => {};
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);
app.on('browser-window-created', (_, win) => { if (win.webContents.getLastWebPreferences().preload) win.hide(); });
const captures = process.env.POFU_QA_OUTPUT;
const bigBody = 'a'.repeat(500000) + 'POFU_HTTP_MIDDLE' + 'z'.repeat(230000);
let posts = 0, completions = 0;
const providerRequests = [];
let validateThinking = false;
const thinkingBodies = [];
const server = createServer((req, res) => {
  providerRequests.push({ url: req.url, authorization: req.headers.authorization });
  if (req.url === '/v1/chat/completions') completions++;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/chat/completions' && validateThinking) {
    let raw = ''; req.on('data', chunk=>raw+=chunk); req.on('end', ()=>{
      const body = JSON.parse(raw); thinkingBodies.push(body);
      if (body.reasoning_effort === 'xhigh') { res.statusCode=400; res.end(JSON.stringify({error:{message:'Unsupported reasoning_effort xhigh. Supported values: high, medium, low.'}})); return; }
      res.setHeader('Content-Type','text/event-stream');
      res.end('data: ' + JSON.stringify({choices:[{delta:{content:'THINKING_OK'},finish_reason:'stop'}]}) + '\n\ndata: [DONE]\n\n');
    }); return;
  }
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'pofu-local-test', meta: { n_ctx: 131072 } }] }));
  if (req.url === '/second/v1/models') return res.end(JSON.stringify({ data: [{ id: 'pofu-second-test', meta: { n_ctx: 131072 } }] }));
  if (req.url === '/large') { if (req.method === 'POST') posts++; return res.end(JSON.stringify({ body: bigBody })); }
  if (req.url === '/page') { res.setHeader('Content-Type', 'text/html'); return res.end('<html><title>Pofu fixture</title><body style="background:#172011;color:white"><main><h1>Pofu funcionando</h1><p>' + 'Texto de teste. '.repeat(2000) + '</p></main></body></html>'); }
  res.statusCode = 404; res.end('{}');
});
let passed = 0;
const largeReads = [];
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: { apiUrl: url + '/v1', model: 'pofu-local-test' }, chats: {
    qa: { id: 'qa', name: 'Meu projeto', path: workspace, messages: [] }
  }, activeChatId: 'qa' }));
  await import(pathToFileURL(resolve('out/main.js')));
  await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = code => win.webContents.executeJavaScript(code);
  const capture = async name => {
    // Uma superfície visível evita capturas vazias em desktops Windows ociosos.
    win.showInactive();
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
    await new Promise(r => setTimeout(r, 300));
    writeFileSync(join(captures, name), (await win.webContents.capturePage()).toPNG());
    win.hide();
  };
  const tool = (name, args, id = '') => js(`import('./out/renderer.js').then(m => m.runTool(${JSON.stringify(name)}, ${JSON.stringify(args)}, ${JSON.stringify(workspace)}, ${JSON.stringify(id)}))`);
  const data = raw => JSON.parse(typeof raw === 'string' ? raw : raw.text);
  await js(`new Promise((resolve,reject) => { let n=0; const poll=()=> { if(document.getElementById('studio-welcome') && document.getElementById('studio-model').textContent.includes('pofu-local')) resolve(true); else if(++n>100) reject(new Error('App did not initialize')); else setTimeout(poll,50); }; poll(); })`);
  await check('brilho do thinking e movimento reduzido', async () => {
    await js(`document.getElementById('think-menu').hidden=false`);
    win.showInactive();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name: 'prefers-reduced-motion', value: 'no-preference'}] });
    await new Promise(r => setTimeout(r, 700));
    const shimmer = () => js(`getComputedStyle(document.getElementById('think-slider')).getPropertyValue('--thinking-shimmer')`);
    await js("document.getElementById('think-menu').hidden=false" );
    await new Promise(r => setTimeout(r, 550));
    const first = await shimmer();
    await new Promise(r => setTimeout(r, 160));
    assert.notEqual(await shimmer(), first, await js(`JSON.stringify({disabled:document.getElementById('think-slider').disabled,animation:getComputedStyle(document.getElementById('think-slider')).animation,hidden:document.getElementById('think-menu').hidden})`));

    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name: 'prefers-reduced-motion', value: 'reduce'}] });
    assert.equal(await js(`getComputedStyle(document.getElementById('think-slider')).animationName`), 'none');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();
    win.hide();
    await js(`document.getElementById('think-menu').hidden=true`);
  });
  await check('layout inicial e atalhos', async () => {
    assert.equal(await js(`document.querySelectorAll('.welcome-action').length`), 3);
    await js(`document.querySelector('.welcome-action').click()`);
    assert.match(await js(`document.getElementById('user-input').value`), /Explore este projeto/);
    await js(`document.getElementById('user-input').value=''; document.getElementById('user-input').dispatchEvent(new Event('input'))`);
    assert.equal(await js(`document.documentElement.scrollWidth <= innerWidth`), true);
  });
  if (captures) {
    mkdirSync(captures, { recursive: true });
    await capture('studio-desktop.png');
  }
  await check('layout em janela compacta', async () => {
    win.setContentSize(820, 680);
    await new Promise(r => setTimeout(r, 150));
    if (captures) await capture('studio-compact.png');
    const bounds = await js(`({width:innerWidth,scroll:document.documentElement.scrollWidth,send:document.getElementById('btn-send').getBoundingClientRect().right})`);
    assert.ok(bounds.scroll <= bounds.width && bounds.send <= bounds.width, JSON.stringify(bounds));
    win.setContentSize(1380, 820);
  });
  await check('configurações abrem pelo atalho', async () => {
    await js(`document.getElementById('welcome-settings').click()`);
    assert.equal(await js(`document.getElementById('api-url').getBoundingClientRect().width > 0 || document.getElementById('info-model-name').getBoundingClientRect().width > 0`), true);
    if (captures) await capture('studio-settings.png');
    await js(`document.getElementById('btn-close-modal').click()`);
  });
  const typeSlash = text => js(`(() => { const input=document.getElementById('user-input'); input.focus(); input.value=${JSON.stringify(text)}; input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const pressSlash = key => js(`document.getElementById('user-input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true})); new Promise(r=>setTimeout(r,30))`);
  await check('comandos /: menu, filtro, setas, Tab e Escape', async () => {
    await typeSlash('/');
    assert.equal(await js(`document.querySelectorAll('.slash-option').length`), 12);
    if (captures) await capture('studio-slash.png');
    await typeSlash('/pro');
    await pressSlash('ArrowDown'); await pressSlash('Tab');
    assert.equal(await js(`document.getElementById('user-input').value`), '/processos ');
    await typeSlash('/'); await pressSlash('Escape');
    assert.equal(await js(`document.getElementById('slash-menu').hidden`), true);
  });
  await check('comandos /: aliases abrem configurações e seletor de modelos', async () => {
    await typeSlash('/settings'); await pressSlash('Enter');
    assert.equal(await js(`document.getElementById('settings-modal').classList.contains('active')`), true);
    await js(`document.getElementById('btn-close-modal').click()`);
    await typeSlash('/modelo'); await pressSlash('Enter');
    assert.equal(await js(`document.getElementById('tab-personalizacao').classList.contains('active')`), true);
    await js(`document.getElementById('btn-close-modal').click()`);
  });
  await check('comandos /: pedido com argumentos fica para revisão antes do envio', async () => {
    await typeSlash('/revisar src/main.ts'); await pressSlash('Enter');
    assert.match(await js(`document.getElementById('user-input').value`), /Revise o código.*src\/main.ts/);
    assert.equal(completions, 0);
    await typeSlash('/testar');
    await js(`document.querySelector('.slash-option').click(); new Promise(r=>setTimeout(r,30))`);
    assert.match(await js(`document.getElementById('user-input').value`), /Identifique e execute os testes/);
  });
  await check('comandos /: desconhecidos e argumentos inválidos não são enviados à IA', async () => {
    await typeSlash('/naoexiste'); await pressSlash('Enter');
    assert.equal(await js(`document.getElementById('user-input').value`), '/naoexiste');
    await typeSlash('/novo texto importante'); await pressSlash('Enter');
    assert.equal(await js(`document.getElementById('user-input').value`), '/novo texto importante');
    assert.equal(completions, 0);
  });
  await check('comandos /: acesso sem projeto e nova conversa preservando a pasta', async () => {
    await js(`document.querySelector('.btn-new-chat').click()`);
    assert.equal(await js(`document.getElementById('user-input').disabled`), false);
    await typeSlash('/config'); await pressSlash('Enter');
    assert.equal(await js(`document.getElementById('settings-modal').classList.contains('active')`), true);
    await js(`document.getElementById('btn-close-modal').click(); document.querySelector('.chat-item').click()`);
    await typeSlash('/novo'); await pressSlash('Enter');
    assert.equal(await js(`document.getElementById('selected-path').textContent`), 'fixture');
    await js(`document.querySelector('.chat-item').click()`);
    await typeSlash('');
  });
  await check('comandos /: menções e botão de comandos preservam o rascunho', async () => {
    await typeSlash('@');
    await js(`new Promise(r=>setTimeout(r,80))`);
    assert.equal(await js(`document.getElementById('slash-menu').hidden`), true);
    assert.equal(await js(`document.getElementById('mention-menu').hidden`), false);
    await typeSlash('Meu rascunho');
    await js(`document.getElementById('btn-slash').click()`);
    assert.equal(await js(`document.getElementById('user-input').value`), 'Meu rascunho');
    await typeSlash('');
    await js(`document.getElementById('btn-slash').click()`);
    assert.equal(await js(`document.getElementById('slash-menu').hidden`), false);
    await typeSlash('');
    assert.equal(completions, 0);
  });
  await check('provedores: adicionar, salvar, alternar e preservar chave/modelo/thinking', async () => {
    const initial = await js(`document.getElementById('active-provider').value`);
    await typeSlash('/modelo'); await pressSlash('Enter');
    await js(`document.getElementById('btn-add-provider').click(); document.getElementById('provider-name').value='Segundo provedor'; document.getElementById('api-url').value=${JSON.stringify(url + '/second/v1')}; document.getElementById('api-key').value='fixture-two'; document.getElementById('btn-refresh-models').click()`);
    await js(`new Promise((resolve,reject)=>{let n=0; const poll=()=>document.getElementById('model-name').value==='pofu-second-test'?resolve(true):++n>100?reject(new Error('Discovery failed')):setTimeout(poll,20);poll();})`);
    if (captures) await capture('studio-providers.png');
    await js(`document.getElementById('btn-save-settings').click(); new Promise(r=>setTimeout(r,120))`);
    const second = await js(`document.getElementById('active-provider').value`);
    assert.notEqual(initial, second);
    await js(`document.getElementById('btn-think').click(); const slider=document.getElementById('think-slider');slider.value='5';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));new Promise(r=>setTimeout(r,100))`);
    assert.equal(await js(`document.getElementById('think-current').textContent`), 'Muito alto');
    if (captures) await capture('studio-thinking.png');
    const change = id => js(`document.getElementById('active-provider').value=${JSON.stringify(id)};document.getElementById('active-provider').dispatchEvent(new Event('change'));new Promise(r=>setTimeout(r,150))`);
    await change(initial); assert.equal(await js(`document.getElementById('think-label').textContent`), 'Padrão do modelo');
    await change(second); assert.equal(await js(`document.getElementById('think-label').textContent`), 'Muito alto');
    const saved = await js(`window.electronAPI.loadStore().then(s=>s.settings)`);
    assert.equal(saved.providers.length, 2); assert.equal(saved.apiKey, 'fixture-two');
    assert.equal(saved.providers.find(p=>p.id===initial).apiKey, '');
    assert.ok(providerRequests.filter(r=>r.url==='/second/v1/models').every(r=>r.authorization==='Bearer fixture-two'));
    assert.ok(providerRequests.filter(r=>r.url==='/v1/models').every(r=>!r.authorization));
    await change(initial); await js(`document.getElementById('think-menu').hidden=true`);
  });
  if (process.env.POFU_QA_ONLY === '1') { console.log('RESULT visual and command checks passed'); return; }
  await check('thinking: xhigh chega ao servidor e recusa adapta realmente o payload', async () => {
    validateThinking = true;
    await js(`(() => { const slider=document.getElementById('think-slider');slider.value='5';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change')); })()`);
    await typeSlash('Teste sintético de thinking: responda apenas OK.'); await pressSlash('Enter');
    await js(`new Promise((resolve,reject)=>{let n=0;const poll=()=>document.getElementById('chat-box').textContent.includes('THINKING_OK')?resolve(true):++n>250?reject(new Error('Thinking request did not finish')):setTimeout(poll,40);poll();})`);
    assert.equal(thinkingBodies[0].reasoning_effort, 'xhigh');
    assert.equal(thinkingBodies[1].reasoning_effort, 'high');
    validateThinking = false;
    await js(`(() => { const slider=document.getElementById('think-slider');slider.value='0';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change')); })();new Promise(r=>setTimeout(r,80))`);
  });
  await check('menções azuis preservam texto, espaços e e-mails', async () => {
    const draft = 'Revise @src/main.ts e @"docs/meu arquivo.md"\nContato: dev@pofu.test';
    await typeSlash(draft);
    const marks = await js(`Array.from(document.querySelectorAll('#mention-highlight .file-mention'), m=>({text:m.textContent,color:getComputedStyle(m).color}))`);
    assert.deepEqual(marks.map(m=>m.text), ['@src/main.ts', '@"docs/meu arquivo.md"']);
    assert.ok(marks.every(m=>m.color === 'rgb(114, 188, 255)'));
    assert.equal(await js(`document.getElementById('user-input').value`), draft);
    assert.equal(await js(`document.getElementById('mention-highlight').clientWidth === document.getElementById('user-input').clientWidth`), true);
    if (captures) await capture('studio-mentions.png');
    await typeSlash('');
  });
  await check('menção por autocomplete adiciona aspas e anexo azul', async () => {
    await typeSlash('@arquivo');
    await js(`new Promise(resolve => { const poll=()=>document.querySelector('.mention-item') ? resolve(true) : setTimeout(poll,20); poll(); })`);
    await pressSlash('Enter');
    await js(`new Promise(resolve => { const poll=()=>document.querySelector('.mention-chip') ? resolve(true) : setTimeout(poll,20); poll(); })`);
    assert.equal(await js(`document.getElementById('user-input').value`), '@"arquivo com espaços.md" ');
    assert.equal(await js(`getComputedStyle(document.querySelector('.mention-chip .attach-name')).color`), 'rgb(139, 204, 255)');
    await js(`document.querySelector('.mention-chip button').click()`);
    await typeSlash('');
  });
  const manyLines = 'valor\n'.repeat(12000);
  writeFileSync(join(workspace, 'many.txt'), manyLines);
  await check('read_file entrega 12000 linhas em uma chamada', async () => assert.equal(await tool('read_file', { filename: 'many.txt' }), manyLines));
  await check('read_file continua dentro de uma linha sem perda', async () => {
    const text = 'x'.repeat(310000) + 'FIM_PO FU🦆';
    writeFileSync(join(workspace, 'minified.txt'), text);
    let cursor = 0, restored = '';
    while (cursor !== null) {
      const page = await js(`window.electronAPI.readFile(${JSON.stringify(join(workspace,'minified.txt'))},{char_offset:${cursor},maxChars:31001})`);
      restored += page.content; cursor = page.nextCharOffset;
    }
    assert.equal(restored, text);
    assert.match(await tool('read_file', { filename: 'minified.txt' }), /char_offset/);
  });
  await check('read_file encontra trecho distante diretamente e aceita caminho absoluto', async () => {
    const found = await tool('read_file', { filename: join(workspace, 'minified.txt'), query: 'FIM_PO FU' });
    assert.match(found, /FIM_PO FU🦆/); assert.match(found, /matchOffset=310000/);
    assert.ok(found.length < 1500);
    assert.match(data(await tool('read_file', { filename: '../outside.txt' })).error, /outside/i);
  });
  mkdirSync(join(workspace, 'large'));
  const hash = text => createHash('sha256').update(text).digest('hex');
  await check('arquivo de 5 MiB: read_file recompõe todas as páginas com Unicode e CRLF', async () => {
    const line = 'const value = "ação 🦆";\r\n';
    const text = line.repeat(Math.ceil(5 * 1024 * 1024 / Buffer.byteLength(line))) + 'FINAL_MULTILINE_POFU';
    writeFileSync(join(workspace, 'large', 'source.txt'), text);
    let cursor = 0, restored = '', calls = 0;
    const started = Date.now();
    while (cursor < text.length) {
      const raw = await tool('read_file', { filename: 'large/source.txt', char_offset: cursor });
      const range = raw.match(/^\[File .*characters (\d+)–(\d+) of (\d+)/);
      assert.ok(range, 'Janela precisa informar intervalo e continuação');
      assert.equal(Number(range[1]), cursor);
      const end = Number(range[2]);
      assert.ok(end > cursor); assert.ok(++calls < 100);
      restored += raw.slice(raw.indexOf('\n') + 1, raw.indexOf('\n') + 1 + end - cursor);
      cursor = end;
    }
    assert.equal(restored, text); assert.equal(hash(restored), hash(text));
    largeReads.push({ test: '5 MiB, read_file real', bytes: Buffer.byteLength(text), lines: text.split('\n').length, calls, sha256: hash(restored), elapsedMs: Date.now() - started });
  });
  await check('arquivo de 20 MiB em uma linha: IPC recompõe tudo e query alcança o final', async () => {
    const text = 'x'.repeat(20 * 1024 * 1024) + 'FINAL_GIGANTE_POFU🦆';
    const filename = join(workspace, 'large', 'single.txt');
    writeFileSync(filename, text);
    let cursor = 0, restored = '', calls = 0;
    const started = Date.now();
    while (cursor !== null) {
      const page = await js(`window.electronAPI.readFile(${JSON.stringify(filename)},{char_offset:${cursor},maxChars:2097153})`);
      assert.equal(page.success, true); assert.equal(page.charOffset, cursor);
      assert.ok(page.content.length > 0); assert.ok(++calls < 20);
      restored += page.content; cursor = page.nextCharOffset;
    }
    assert.equal(hash(restored), hash(text)); assert.equal(restored, text);
    const found = await tool('read_file', { filename, query: 'FINAL_GIGANTE_POFU' });
    assert.match(found, /FINAL_GIGANTE_POFU🦆/); assert.ok(found.length < 1500);
    const search = await tool('search_files', { query: 'FINAL_GIGANTE_POFU', file_pattern: 'large/single.txt' });
    assert.match(search, new RegExp(`^1:\\[col ${20 * 1024 * 1024 + 1}\\] …x+FINAL_GIGANTE_POFU`, 'm'));
    const broad = await tool('search_files', { query: '^x+', regex: true, file_pattern: 'large/single.txt' });
    assert.match(broad, /^1:\[col 1\] x+…$/m);
    assert.ok(broad.length < 1500); assert.match(broad, /read_file with query/);
    largeReads.push({ test: '20 MiB, linha única via IPC', bytes: Buffer.byteLength(text), calls, queryCalls: 1, sha256: hash(restored), elapsedMs: Date.now() - started });
  });
  await check('arquivo acima de 25 MiB: proteção explícita sem conteúdo parcialmente perdido', async () => {
    writeFileSync(join(workspace, 'large', 'oversize.txt'), Buffer.alloc(25 * 1024 * 1024 + 1, 120));
    assert.match(data(await tool('read_file', { filename: 'large/oversize.txt' })).error, /File too large/);
  });
  await check('erros de leitura e binários', async () => {
    assert.ok(data(await tool('read_file', { filename: 'missing.txt' })).error);
    writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
    assert.match(data(await tool('read_file', { filename: 'binary.bin' })).error, /Binary/);
  });
  await check('list_files e create_directory', async () => {
    assert.equal(data(await tool('create_directory', { dirname: 'src/nested' })).success, true);
    const entries = await tool('list_files', {});
    assert.match(entries, /^many\.txt  \d+(\.\d)? KB$/m); assert.match(entries, /^src\/$/m);
    const tree = await tool('list_files', { recursive: true });
    assert.match(tree, /^\.\/\n(  .+\n)*  many\.txt$/m);
    const md = await tool('list_files', { recursive: true, pattern: '*.md' });
    assert.match(md, /arquivo com espaços\.md/); assert.doesNotMatch(md, /many\.txt/);
  });
  await check('write_file bloqueia arquivo não lido e permite arquivo novo', async () => {
    writeFileSync(join(workspace, 'protected.txt'), 'preservar');
    assert.equal(data(await tool('write_file', { filename: 'protected.txt', content: 'perdido' })).success, false);
    assert.equal(readFileSync(join(workspace, 'protected.txt'), 'utf8'), 'preservar');
    assert.equal(data(await tool('write_file', { filename: 'new.txt', content: 'const value = 1;\r\n' })).success, true);
  });
  await check('edit_file diagnostica texto antigo e permite corrigir sem terminal', async () => {
    const current = '    let ny = p.y + this.vel.y * dt;\n    this.onGround = false;\n    if (!this.collides(p.x, ny, p.z)) {\n      p.y = ny;\n    }';
    writeFileSync(join(workspace, 'stale-edit.js'), current);
    const old = current.replace('p.x, ny, p.z', 'p.x, p.y, nz');
    const failed = data(await tool('edit_file', {filename: 'stale-edit.js', old_text: old, new_text: current}));
    assert.equal(failed.success, false);
    assert.equal(failed.operation_status, 'failed');
    assert.equal(failed.replacement_present, true);
    assert.match(failed.difference.actual, /p.x, ny, p.z/);
    assert.equal(readFileSync(join(workspace, 'stale-edit.js'), 'utf8'), current);
    const changed = data(await tool('edit_file', {filename: 'stale-edit.js', old_text: failed.current_excerpt, new_text: current.replace('p.y = ny;', 'p.y = Math.max(ny, 0);')}));
    assert.equal(changed.success, true);
    assert.match(readFileSync(join(workspace, 'stale-edit.js'), 'utf8'), /Math.max/);
  });
  await check('edit_file preserva CRLF e substituições literais com cifrão', async () => {
    assert.equal(data(await tool('edit_file', { filename: 'new.txt', old_text: 'value = 1', new_text: 'value = "$&"' })).success, true);
    assert.equal(readFileSync(join(workspace, 'new.txt'), 'utf8'), 'const value = "$&";\r\n');
    assert.equal(data(await tool('edit_file', { filename: 'new.txt', old_text: 'nao existe', new_text: 'x' })).success, false);
  });
  await check('edit_file tolera indentação e aplica lote atômico', async () => {
    const py = join(workspace, 'src', 'lote.py');
    writeFileSync(py, 'def f():\n    if x:\n        return 1\n    return 2\n');
    const tolerante = data(await tool('edit_file', { filename: 'src/lote.py', old_text: 'if x:\n    return 1', new_text: 'if x:\n    log()\n    return 1' }));
    assert.equal(tolerante.success, true); assert.equal(tolerante.matched_ignoring_whitespace, true);
    assert.equal(readFileSync(py, 'utf8'), 'def f():\n    if x:\n        log()\n        return 1\n    return 2\n');
    const antes = readFileSync(py, 'utf8');
    const falhou = data(await tool('edit_file', { filename: 'src/lote.py', edits: [{ old_text: 'return 2', new_text: 'return 3' }, { old_text: 'nao existe', new_text: 'x' }] }));
    assert.equal(falhou.success, false); assert.match(falhou.error, /^edits\[1\]: Snippet not found/);
    assert.equal(readFileSync(py, 'utf8'), antes);
    const lote = data(await tool('edit_file', { filename: 'src/lote.py', edits: [{ old_text: 'return 2', new_text: 'return 3' }, { old_text: 'log()', new_text: 'trace()' }] }));
    assert.equal(lote.success, true); assert.equal(lote.edits_applied, 2); assert.deepEqual(lote.lines_edited, [5, 3]);
    assert.match(readFileSync(py, 'utf8'), /trace\(\)[\s\S]*return 3/);
  });
  await check('write_file recusa arquivo alterado em disco desde a leitura', async () => {
    const f = join(workspace, 'src', 'stale.txt');
    writeFileSync(f, 'v1');
    await tool('read_file', { filename: 'src/stale.txt' });
    writeFileSync(f, 'v2 do usuário');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const stale = data(await tool('write_file', { filename: 'src/stale.txt', content: 'v3' }));
    assert.equal(stale.success, false); assert.equal(stale.stale, true);
    assert.equal(readFileSync(f, 'utf8'), 'v2 do usuário');
    await tool('read_file', { filename: 'src/stale.txt' });
    assert.equal(data(await tool('write_file', { filename: 'src/stale.txt', content: 'v3' })).success, true);
    // A edição do próprio agente atualiza o mtime conhecido: a escrita seguinte não é barrada.
    assert.equal(data(await tool('edit_file', { filename: 'src/stale.txt', old_text: 'v3', new_text: 'v4' })).success, true);
    assert.equal(data(await tool('write_file', { filename: 'src/stale.txt', content: 'v5' })).success, true);
    if (process.platform === 'win32')
      assert.equal(data(await tool('write_file', { filename: 'SRC/STALE.TXT', content: 'v6' })).success, true);
  });
  await check('read_file sugere o caminho certo e não reenvia leitura sem mudança', async () => {
    const miss = data(await tool('read_file', { filename: 'lotte.py' }));
    assert.match(miss.error, /File not found/); assert.deepEqual(miss.did_you_mean, ['src/lote.py']);
    writeFileSync(join(workspace, 'src', 'dedup.txt'), 'conteúdo original\n');
    const r = await js(`import('./out/renderer.js').then(async m => {
      const chat = m.activeChat();
      const ws = ${JSON.stringify(workspace)};
      const call = id => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      chat.messages.push(call('dedup-1'));
      const first = await m.runTool('read_file', { filename: 'src/dedup.txt' }, ws, 'dedup-1');
      chat.messages.push({ role: 'tool', tool_call_id: 'dedup-1', name: 'read_file', content: first });
      const second = await m.runTool('read_file', { filename: 'src/dedup.txt' }, ws, 'dedup-2');
      const other = await m.runTool('read_file', { filename: 'src/dedup.txt', query: 'original' }, ws, 'dedup-3');
      chat.messages.splice(-2);
      return { first, second, other };
    })`);
    assert.equal(r.first, 'conteúdo original\n');
    assert.equal(JSON.parse(r.second).unchanged, true); assert.match(JSON.parse(r.second).note, /history:dedup-1/);
    assert.match(r.other, /original/);
  });
  await check('delete_file mantém a proteção de leitura', async () => {
    assert.equal(data(await tool('delete_file', { filename: 'protected.txt' })).success, false);
    await tool('read_file', { filename: 'protected.txt' });
    assert.equal(data(await tool('delete_file', { filename: 'protected.txt' })).success, true);
  });
  await check('delete_file trata ausência e falha sem exceção IPC ou exclusão indevida', async () => {
    const absent = await tool('delete_file', {filename: 'already-missing.txt'});
    assert.equal(data(absent).success, true);
    assert.equal(data(absent).already_absent, true);
    assert.equal(data(absent).deleted, false);
    assert.equal(absent.alteracao, undefined);
    const again = data(await tool('delete_file', {filename: 'protected.txt'}));
    assert.equal(again.already_absent, true);
    const directory = await js(`window.electronAPI.deleteFile(${JSON.stringify(join(workspace, 'src'))})`);
    assert.equal(directory.success, false);
    assert.equal(directory.deleted, false);
    assert.ok(directory.code);
    assert.ok(readdirSync(workspace).includes('src'));
  });
  await check('search_files localiza termo no meio de linha minificada', async () => {
    const line = 'a'.repeat(10000) + 'ALVO_POFU' + 'z'.repeat(10000);
    writeFileSync(join(workspace, 'search.txt'), line);
    const result = await tool('search_files', { query: 'ALVO_POFU', file_pattern: '*.txt' });
    assert.match(result, /^search\.txt\n1:\[col 10001\] …a+ALVO_POFUz+…$/m);
    // O oversize.txt (>25 MiB) de um teste anterior é pulado e o resultado diz isso.
    assert.match(await tool('search_files', { query: 'ALVO_POFU', output_mode: 'files' }), /^1 file with 1 matching line:\nsearch\.txt: 1\n1 file\(s\) over 25 MiB were not scanned\.$/);
    // many.txt tem 12000 linhas com "valor": a contagem para no teto e diz isso.
    assert.equal(await tool('search_files', { query: 'valor', file_pattern: 'many.txt', output_mode: 'count' }),
      '10000 matching lines in 1 file (scanned 1).\nCount capped at 10000 matching lines; narrow the query or file_pattern.');
  });
  await check('search_files pagina e valida regex', async () => {
    const first = await tool('search_files', { query: 'valor', file_pattern: 'many.txt', max_results: 2 });
    assert.match(first, /continue with offset=2:/);
    const next = await tool('search_files', { query: 'valor', file_pattern: 'many.txt', max_results: 2, offset: 2 });
    assert.match(next, /^many\.txt\n1-valor\n2-valor\n3:valor\n4:valor\n5-valor\n6-valor$/m);
    assert.ok(data(await tool('search_files', { query: '[', regex: true })).error);
  });
  await check('execute_command preserva argumentos literais sem shell nem temporários', async () => {
    const literal = 'aspas " e \' & | > < %PATH% $HOME ; acentuação';
    const result = data(await tool('execute_command', { command: 'node', args: ['-e', 'console.log(process.argv[1])', literal] }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), literal);
    const colorido = data(await tool('execute_command', { command: 'node', args: ['-e', "const e=String.fromCharCode(27);process.stdout.write(e+'[31mRED'+e+'[0m'+String.fromCharCode(13,10))"] }));
    assert.equal(colorido.stdout, 'RED\n'); assert.equal(colorido.command, undefined);
    assert.equal(colorido.stderr, undefined); assert.equal(colorido.stdoutDropped, undefined);
    const failed = data(await tool('execute_command', {command:'node', args:['-e','process.exit(7)']}));
    assert.equal(failed.exitCode, 7); assert.equal(failed.failure_kind, 'command_exit');
    assert.equal(failed.success, false); assert.equal(failed.operation_status, 'failed');
    assert.equal(result.success, true); assert.equal(result.operation_status, 'completed');
    const invalid = data(await tool('execute_command', {command:'node', args:'not-an-array'}));
    assert.equal(invalid.success, false);
    const unknown = data(await tool('stop_process', {pid: -12345}));
    assert.equal(unknown.success, false); assert.ok(Array.isArray(unknown.managed_pids));
    assert.match(unknown.hint, /list_processes/);
  });
  await check('execute_command preserva stdout acima do antigo teto', async () => {
    const result = data(await tool('execute_command', { command: `node -e "process.stdout.write('x'.repeat(22000)+'FIM')"` }));
    assert.equal(result.exitCode, 0); assert.equal(result.stdout.length, 22003);
    const logs = data(await tool('read_process_output', { pid: result.pid }));
    assert.equal(logs.stdout, result.stdout);
  });
  await check('processos: aguardar, listar e rejeitar PID desconhecido', async () => {
    const started = data(await tool('execute_command', { command: `node -e "console.log('Listening on test');setTimeout(()=>console.log('FINAL_OK'),1000)"` }));
    assert.equal(started.backgrounded, true);
    const result = data(await tool('wait_for_process', { pid: started.pid, timeout_ms: 5000 }));
    assert.equal(result.exitCode, 0); assert.match(result.stdout, /FINAL_OK/);
    const listed = data(await tool('list_processes', {}));
    assert.ok(listed.finished.some(p => p.pid === started.pid));
    assert.equal(listed.running_count, listed.running.length);
    assert.ok(listed.finished.every(p => p.status !== 'running'));
    assert.equal(data(await tool('stop_process', { pid: 2147483647 })).success, false);
  });
  await check('stop_process encerra somente um processo gerenciado vivo', async () => {
    const started = data(await tool('execute_command', { command: `node -e "console.log('Listening on fixture');setInterval(()=>{},1000)"` }));
    const active = data(await tool('list_processes', {}));
    assert.ok(active.running.some(p => p.pid === started.pid));
    assert.equal(started.operation_status, 'running');
    assert.equal(data(await tool('stop_process', { pid: started.pid })).success, true);
    let status;
    for (let i = 0; i < 30; i++) {
      status = data(await tool('read_process_output', { pid: started.pid })).status;
      if (status === 'exited') break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(status, 'exited');
  });
  let savedHttp;
  await check('HTTP grande é recuperável sem repetir POST', async () => {
    const raw = await tool('http_request', { url: url + '/large', method: 'POST', body: '{}' });
    const result = data(raw);
    assert.equal(result.status, 200); assert.ok(result.result_id);
    const found = data(await tool('read_tool_result', { result_id: result.result_id, query: 'POFU_HTTP_MIDDLE' }));
    assert.match(found.content, /POFU_HTTP_MIDDLE/); assert.equal(posts, 1);
    savedHttp = await js(`import('./out/renderer.js').then(m => {
      const message={role:'tool',name:'http_request',tool_call_id:'saved-http',content:${JSON.stringify(raw)}};
      m.retainToolOutput(message); return message;
    })`);
    assert.match(savedHttp.retainedResult.text, /POFU_HTTP_MIDDLE/);
    assert.equal(savedHttp.content.includes('POFU_HTTP_MIDDLE'), false);
    const payload = await js(`import('./out/renderer.js').then(m => m.toApiMessages([${JSON.stringify(savedHttp)}]))`);
    assert.equal(JSON.stringify(payload).includes('retainedResult'), false);
    assert.equal(JSON.stringify(payload).includes('POFU_HTTP_MIDDLE'), false);
  });
  await check('fetch_url preserva texto além dos antigos 6000 caracteres', async () => {
    const result = data(await tool('fetch_url', { url: url + '/page' }));
    assert.ok(result.content.length > 20000); assert.equal(result.truncated, undefined);
  });
  await check('capture_page devolve imagem e texto de página real', async () => {
    const result = await tool('capture_page', { url: url + '/page', width: 800, height: 600, crop_selector: 'h1', wait_ms: 50 });
    assert.ok(result.image?.path, typeof result === 'string' ? result : JSON.stringify(result)); assert.match(data(result).visible_text, /Pofu funcionando/);
  });
  await check('capture_page preserva booleanos e separa falha de script', async () => {
    const good = data(await tool('capture_page', {url: url + '/page', wait_ms: 0, script: 'return {colChao:true, colAr:false};'}));
    assert.deepEqual(good.script_result, {colChao:true, colAr:false});
    assert.equal(good.script_status, 'completed');
    const bad = data(await tool('capture_page', {url: url + '/page', wait_ms: 0, script: 'throw new Error("SCRIPT_FAILED_FIXTURE");'}));
    assert.equal(bad.ok, true);
    assert.equal(bad.script_status, 'failed');
    assert.match(bad.script_error, /SCRIPT_FAILED_FIXTURE/);
  });
  await check('ask_user aguarda seleção e devolve a escolha', async () => {
    const pending = tool('ask_user', { question: 'Escolha uma opção de teste', options: ['Primeira', 'Segunda'] });
    await js(`new Promise(resolve => { const poll = () => document.querySelector('#question-options button') ? resolve(true) : setTimeout(poll, 20); poll(); })`);
    await js(`document.querySelector('#question-options button').click(); document.getElementById('question-send').click()`);
    assert.deepEqual(data(await pending).selected, ['Primeira']);
  });
  await check('web_search rejeita consulta vazia antes de acessar provedores', async () => {
    assert.match(data(await tool('web_search', { query: ' ' })).error, /must not be empty/);
  });
  await check('histórico truncado não deixa marca de poda compactando o resultado novo', async () => {
    const r = await js(`import('./out/renderer.js').then(m => {
      const chat = m.activeChat();
      const salvo = { msgs: chat.messages, manual: chat.podaManualAte, auto: chat.podaAutoAte };
      const tool = i => ({ role: 'tool', tool_call_id: 'p' + i, name: 'read_file', content: 'resultado ' + i });
      // Estado real visto num chat salvo: marcas de um histórico de 1794 mensagens, chat com 4.
      chat.podaManualAte = 1794; chat.podaAutoAte = 1781;
      chat.messages = [0, 1, 2, 3].map(tool);
      const cortes = m.compactToolResults(chat.messages).size;
      const curado = [chat.podaManualAte, chat.podaAutoAte];
      // E o truncamento de agora em diante já leva as marcas junto.
      chat.messages = Array.from({ length: 30 }, (_, i) => tool(i));
      chat.podaManualAte = 25; chat.podaAutoAte = 20;
      m.truncaHistorico(chat, 10);
      const truncado = [chat.messages.length, chat.podaManualAte, chat.podaAutoAte];
      chat.messages = salvo.msgs; chat.podaManualAte = salvo.manual; chat.podaAutoAte = salvo.auto;
      return { cortes, curado, truncado };
    })`);
    assert.equal(r.cortes, 0); assert.deepEqual(r.curado, [0, 0]); assert.deepEqual(r.truncado, [10, 10, 10]);
  });
  await check('compactação preserva resultado recente e o histórico original', async () => {
    const result = await js(`import('./out/renderer.js').then(m => {
      const messages = Array.from({length: 6}, (_, i) => ({role:'tool', tool_call_id:'t'+i, content:'a'.repeat(i===5?70000:90000)}));
      const sizes = messages.map(m=>m.content.length);
      const cuts = m.compactToolResults(messages);
      return { newestCut:cuts.has(5), count:cuts.size, unchanged:messages.every((m,i)=>m.content.length===sizes[i]), notices:[...cuts.values()] };
    })`);
    assert.equal(result.newestCut, false); assert.equal(result.unchanged, true);
    assert.ok(result.count > 0); assert.match(result.notices[0], /read_tool_result/);
  });
  await check('nenhum arquivo temporário criado pelas ferramentas de leitura', async () => {
    assert.deepEqual(readdirSync(workspace).sort(), ['arquivo com espaços.md','binary.bin','large','many.txt','minified.txt','new.txt','search.txt','src','stale-edit.js']);
    assert.deepEqual(readdirSync(join(workspace, 'large')).sort(), ['oversize.txt','single.txt','source.txt']);
  });
  await check('resultado compactado é recuperável depois de recarregar o app', async () => {
    await js(`window.electronAPI.loadStore().then(store => {
      store.chats.qa.messages = [
        { role:'user',content:'Revise @"arquivo com espaços.md"\\nPreserve as linhas.',attachments:[{name:'arquivo com espaços.md',mention:true,content:'Conteúdo de teste.'}] },
        { role:'assistant', content:null, tool_calls:[{id:'saved-command',type:'function',function:{name:'execute_command',arguments:'{}'}}] },
        { role:'tool',tool_call_id:'saved-command',name:'execute_command',content:JSON.stringify({stdout:'a'.repeat(40000)+'POFU_PERSISTIDO',exitCode:0}) },
        { role:'assistant',content:null,tool_calls:[{id:'saved-http',type:'function',function:{name:'http_request',arguments:'{}'}}] },
        ${JSON.stringify(savedHttp)}
      ];
      return window.electronAPI.saveStore(store);
    })`);
    win.reload();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await js(`new Promise(resolve => { const poll = () => document.querySelector('.tool-card') ? resolve(true) : setTimeout(poll,20); poll(); })`);
    assert.equal(await js(`document.querySelector('.message.user .file-mention').textContent`), '@"arquivo com espaços.md"');
    assert.equal(await js(`getComputedStyle(document.querySelector('.user-message-text')).whiteSpace`), 'pre-wrap');
    assert.match(await js(`document.querySelector('.user-message-text').innerText`), /\nPreserve as linhas\./);
    assert.equal(await js(`getComputedStyle(document.querySelector('.msg-attach-chip.mention-chip')).color`), 'rgb(139, 204, 255)');
    const recovered = data(await tool('read_tool_result', { result_id: 'history:saved-command', query: 'POFU_PERSISTIDO' }));
    assert.match(recovered.content, /POFU_PERSISTIDO/);
    const full = data(await tool('read_tool_result', { result_id: savedHttp.retainedResult.id, query: 'POFU_HTTP_MIDDLE' }));
    assert.match(full.content, /POFU_HTTP_MIDDLE/);
    const history = data(await tool('read_tool_result', { result_id: 'history:saved-http', query: 'POFU_HTTP_MIDDLE' }));
    assert.match(history.content, /POFU_HTTP_MIDDLE/);
    assert.equal(posts, 1);
  });
  console.log(`RESULT ${passed} integration checks passed`);
  console.log(JSON.stringify({ largeReads }));
  if (captures) writeFileSync(join(captures, 'integration-report.json'), JSON.stringify({ passed, failed: 0, tools: 18, profile: 'isolated', api: 'local synthetic fixtures', largeReads }, null, 2));
}
main().then(() => { server.close(); app.exit(0); }).catch(err => { console.error(err); server.close(); app.exit(1); });
