// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.

const { app, BrowserWindow, Notification, shell } = require('electron');
const { servidorOAuthFalso } = require('./fixtures/mcp-oauth-falso.cjs');
// O "navegador" do login OAuth do MCP: segue o redirecionamento do servidor de autorização até o callback local.
const abertosNoNavegador = [];
shell.openExternal = async url => { abertosNoNavegador.push(url); await fetch(url); };
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');

const profile = mkdtempSync(join(tmpdir(), 'pofu-user-flows-'));
const workspace = join(profile, 'project'), otherWorkspace = join(profile, 'other');
mkdirSync(workspace); mkdirSync(otherWorkspace);
writeFileSync(join(workspace, 'guard.txt'), 'Arquivo do projeto.');
const captures = process.env.POFU_QA_OUTPUT || join(profile, 'captures'); mkdirSync(captures, { recursive: true });
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(Response.json({}, { status: 404 })) : originalFetch(url, ...args);
let hold = false;
const requests = [], pending = [];
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
function finish(res, content = '') {
  if (res.destroyed) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(event({ choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } }) + 'data: [DONE]\n\n');
}
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture', meta: { n_ctx: 32768 } }] }));
  if (!req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  if (!hold) return finish(res, 'RESPOSTA ' + body.messages.findLast(m => m.role === 'user').content);
  pending.push(res); res.setHeader('Content-Type', 'text/event-stream'); res.write(': connected\n\n');
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: {
    providers: [
      { id: 'ready', name: 'API de teste', apiUrl, apiKey: '', model: 'fixture', thinkLevel: 'padrao' },
      { id: 'empty', name: 'Sem modelo', apiUrl, apiKey: '', model: '', thinkLevel: 'padrao' }
    ], activeProviderId: 'ready', maxTokens: 1024, webSearch: false
  }, activeChatId: 'first', chats: {
    first: { id: 'first', name: 'Primeira conversa', path: workspace, messages: [] },
    second: { id: 'second', name: 'Outro projeto', path: otherWorkspace, messages: [] }
  } }));
  await import(pathToFileURL(resolve('out/main.js'))); await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const js = code => win.webContents.executeJavaScript(code);
  const remote = command => js("import('./out/renderer.js').then(m=>m.executeRemoteCommand(" + JSON.stringify(command) + '))');
  const snapshot = () => js("import('./out/renderer.js').then(m=>m.studioRemoteSnapshot())");
  const type = text => js("(() => { const input=document.getElementById('user-input');input.value=" + JSON.stringify(text)
    + ";input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  const enter = () => js("document.getElementById('user-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  const send = async text => { await type(text); await enter(); };
  const select = id => js("document.querySelector('[data-chat-id=" + JSON.stringify(id) + "]').click()");
  const draft = () => js("document.getElementById('user-input').value");
  const attachmentNames = () => js("[...document.querySelectorAll('#attachments .attach-name')].map(n=>n.textContent)");
  const attach = name => js("(() => { const data=new DataTransfer();data.items.add(new File(['Conteúdo de teste']," + JSON.stringify(name)
    + ",{type:'text/plain'}));const input=document.getElementById('file-input');input.files=data.files;input.dispatchEvent(new Event('change')); })()");
  async function until(code, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    console.error(await js("JSON.stringify(['chat-box','user-input','btn-chat-bottom'].map(id=>{const node=document.getElementById(id);return {id,height:node.clientHeight,scrollHeight:node.scrollHeight,top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,viewport:innerHeight};}))"));
    await capture('failure');
    throw new Error('Tempo excedido: ' + code + '\n' + await js("document.getElementById('chat-box').textContent.slice(-1200)"));
  }
  const idle = () => until("!document.body.classList.contains('agent-running')");
  async function capture(name, compact = false) {
    win.setContentSize(compact ? 820 : 1380, compact ? 680 : 820); win.showInactive();
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(captures, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.hide();
  }
  const key = (value, shift = false) => js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:" + JSON.stringify(value)
    + ',shiftKey:' + shift + ',bubbles:true,cancelable:true}))');
  let passed = 0;
  const check = async (name, action) => { await action(); passed++; console.log('PASS ' + name); };
  await until("document.querySelectorAll('.chat-item').length===2 && document.getElementById('studio-model').textContent==='fixture'");
  await check('rascunhos e anexos ficam na conversa de origem; Novo chat mantém o projeto', async () => {
    await type('Rascunho do primeiro projeto'); await attach('primeiro.txt');
    await until("document.querySelector('#attachments .attach-name')?.textContent==='primeiro.txt'");
    await select('second'); assert.equal(await draft(), ''); assert.deepEqual(await attachmentNames(), []);
    await type('Rascunho do segundo projeto'); await select('first');
    assert.equal(await draft(), 'Rascunho do primeiro projeto'); assert.deepEqual(await attachmentNames(), ['primeiro.txt']);
    await js("document.querySelector('.btn-new-chat').click()");
    const newChat = (await snapshot()).activeChatId;
    assert.equal((await snapshot()).chats.find(c => c.id === newChat).path, workspace);
    assert.equal(await draft(), ''); assert.deepEqual(await attachmentNames(), []);
    assert.equal(await js('document.activeElement.id'), 'user-input');
    await select('first'); assert.equal(await draft(), 'Rascunho do primeiro projeto');
    await select('second'); assert.equal(await draft(), 'Rascunho do segundo projeto');
    assert.equal(requests.length, 0);
  });
  await check('leitura de anexo que termina depois da troca fica no chat certo', async () => {
    await select('second');
    await js("(() => { const original=FileReader.prototype.readAsText;FileReader.prototype.readAsText=function(file){window.releaseAttachmentRead=()=>{FileReader.prototype.readAsText=original;original.call(this,file);};}; })()");
    await attach('segundo.txt'); await select('first'); await js('window.releaseAttachmentRead()');
    await until("import('./out/renderer.js').then(m=>m.activeChat().id==='first')");
    assert.deepEqual(await attachmentNames(), ['primeiro.txt']);
    await select('second'); await until("document.querySelector('#attachments .attach-name')?.textContent==='segundo.txt'");
    assert.deepEqual(await attachmentNames(), ['segundo.txt']);
  });
  await check('atalho e site criam conversas com compositor limpo e mesmo projeto', async () => {
    await send('/novo'); await until("import('./out/renderer.js').then(m=>m.activeChat().id!=='second')");
    let state = await snapshot(); assert.equal(state.chats.find(c => c.id === state.activeChatId).path, otherWorkspace);
    assert.equal(await draft(), ''); assert.deepEqual(await attachmentNames(), []);
    await type('Rascunho antes do comando remoto'); const previous = state.activeChatId;
    await remote({ type: 'new-chat' }); state = await snapshot();
    assert.equal(state.chats.find(c => c.id === state.activeChatId).path, otherWorkspace);
    assert.equal(await draft(), ''); await select(previous); assert.equal(await draft(), 'Rascunho antes do comando remoto');
    await select('first'); await type('');
    await js("document.querySelector('#attachments .attach-remove').click()");
  });
  await check('navegação durante geração preserva histórico, projeto e mensagens da fila', async () => {
    hold = true; await send('TAREFA ATIVA'); await until("document.querySelector('.typing-etapa')?.textContent==='Conexão aberta'");
    await send('CONTINUE_EM_FILA'); await type('Pedido ainda não enviado'); await attach('rascunho.txt');
    await until("document.querySelector('#attachments .attach-name')?.textContent==='rascunho.txt'");
    await select('second'); await js("document.querySelector('.btn-new-chat').click();document.querySelector('[data-chat-id=first] .chat-delete').click();document.getElementById('btn-select-folder').click()");
    const state = await snapshot();
    assert.equal(state.activeChatId, 'first'); assert.equal(state.queued, 1); assert.equal(state.chats.find(c => c.id === 'first').path, workspace);
    assert.equal(await js("document.querySelector('.btn-new-chat').disabled && document.getElementById('btn-select-folder').disabled"), true);
    assert.equal(await js("document.querySelector('[data-chat-id=second] .chat-name').disabled"), true);
    assert.equal(await js("document.getElementById('folder-menu').hidden"), true);
    assert.equal(await js("import('./out/renderer.js').then(m=>m.activeChat().messages.filter(x=>x.role==='user').length)"), 1);
    assert.equal(await js("document.getElementById('btn-stop').hidden"), false);
    assert.equal(await js("document.getElementById('btn-send').getAttribute('aria-label').includes('fila')"), true);
    await capture('studio-draft-stop'); await capture('studio-draft-stop-compact', true);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("(() => { const stop=document.getElementById('btn-stop').getBoundingClientRect();return stop.width>=40 && stop.height>=28 && stop.bottom<=innerHeight; })()"), true);
  });
  await check('Parar mantém o rascunho e a fila pode continuar mesmo depois de trocar de chat', async () => {
    const before = requests.length; await js("document.getElementById('btn-stop').click()"); await idle();
    assert.equal(await draft(), 'Pedido ainda não enviado'); assert.deepEqual(await attachmentNames(), ['rascunho.txt']);
    assert.equal((await snapshot()).queued, 1); assert.equal(requests.length, before);
    await select('second'); assert.equal((await snapshot()).queued, 0); await select('first');
    assert.equal((await snapshot()).queued, 1); assert.equal(await draft(), 'Pedido ainda não enviado');
    await type(''); await js("document.querySelector('#attachments .attach-remove').click()"); hold = false;
    await js("document.getElementById('btn-send').click()"); await until("document.getElementById('chat-box').textContent.includes('RESPOSTA CONTINUE_EM_FILA')"); await idle();
    assert.equal((await snapshot()).queued, 0); assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).messages.findLast(m => m.role === 'user').content, 'CONTINUE_EM_FILA');
    assert.equal(await js("document.querySelector('.btn-new-chat').disabled"), false);
  });
  await check('modais respondem a Esc, contêm Tab e devolvem o foco sem alterar a conexão', async () => {
    await js("document.getElementById('btn-open-settings').focus();document.getElementById('btn-open-settings').click()");
    assert.equal(await js('document.activeElement.id'), 'btn-close-modal');
    await key('Tab', true); assert.equal(await js('document.activeElement.id'), 'btn-save-settings');
    await key('Tab'); assert.equal(await js('document.activeElement.id'), 'btn-close-modal');
    await js("document.querySelector('[data-tab=tab-personalizacao]').click();document.getElementById('api-url').value='http://nao-salvo.invalid/v1';document.getElementById('api-url').dispatchEvent(new Event('input',{bubbles:true}))");
    await capture('studio-settings-keyboard'); await key('Escape');
    assert.equal(await js("document.getElementById('settings-modal').classList.contains('active')"), false);
    assert.equal(await js('document.activeElement.id'), 'btn-open-settings');
    assert.equal(await js("document.getElementById('chat-box').textContent.includes('sem salvar')"), true);
    assert.equal((await snapshot()).providerId, 'ready');
    await js("document.getElementById('btn-processes').focus();document.getElementById('btn-processes').click()");
    assert.equal(await js('document.activeElement.id'), 'btn-close-processes');
    await key('Tab', true); assert.equal(await js('document.activeElement.id'), 'btn-clear-finished');
    await key('Tab'); assert.equal(await js('document.activeElement.id'), 'btn-close-processes');
    await key('Escape'); assert.equal(await js("document.getElementById('processes-modal').classList.contains('active')"), false);
    assert.equal(await js('document.activeElement.id'), 'btn-processes');
  });
  await check('nova conversa zera o contexto e não herda permissão de escrita de leituras anteriores', async () => {
    assert.equal((await snapshot()).usage.contextUsed, 210);
    await js("import('./out/renderer.js').then(m=>m.runTool('read_file',{filename:'guard.txt'}," + JSON.stringify(workspace) + '))');
    await js("document.querySelector('.btn-new-chat').click()");
    assert.equal((await snapshot()).usage.contextUsed, 0);
    const result = await js("import('./out/renderer.js').then(m=>m.runTool('write_file',{filename:'guard.txt',content:'Substituição indevida'}," + JSON.stringify(workspace) + '))');
    const failure = JSON.parse(typeof result === 'string' ? result : result.text);
    assert.equal(failure.success, false); assert.match(failure.error, /has not been read in this conversation/);
    assert.equal(require('node:fs').readFileSync(join(workspace, 'guard.txt'), 'utf8'), 'Arquivo do projeto.');
    await select('first'); assert.equal((await snapshot()).usage.contextUsed, 210);
  });
  await check('imagem WebP arrastada do navegador vira PNG com os pixels para o modelo e abre em tela cheia', async () => {
    // O nativeImage do main só decodifica PNG/JPEG: o WebP chegava vazio e o modelo ouvia que "não recebe imagens".
    const pasta = join(profile, 'screenshots'), { readdirSync, readFileSync } = require('node:fs');
    const salvos = () => { try { return readdirSync(pasta).filter(n => n.includes('foto.webp')); } catch { return []; } };
    await js("(async () => { const c=document.createElement('canvas');c.width=64;c.height=48;const g=c.getContext('2d');g.fillStyle='#e11';g.fillRect(0,0,64,48);const blob=await new Promise(r=>c.toBlob(r,'image/webp',0.9));const data=new DataTransfer();data.items.add(new File([blob],'foto.webp',{type:'image/webp'}));document.querySelector('.main-content').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); })()");
    await until("[...document.querySelectorAll('#attachments .attach-name')].some(n=>n.textContent==='foto.webp')");
    for (let i = 0; i < 50 && !salvos().length; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(salvos().length, 1, 'os pixels do WebP não foram salvos');
    const png = readFileSync(join(pasta, salvos()[0]));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG'); assert.equal(png.readUInt32BE(16), 64); assert.equal(png.readUInt32BE(20), 48);
    // Clicar na miniatura abre a imagem salva (não a miniatura de 140 px) em tela cheia; Esc fecha; Enter abre pelo teclado.
    await js("[...document.querySelectorAll('#attachments .attach-chip')].find(c=>c.textContent.includes('foto.webp')).querySelector('.attach-thumb').click()");
    await until("document.querySelector('.shot-viewer img')?.complete && document.querySelector('.shot-viewer img').naturalWidth>0");
    assert.deepEqual(await js("(() => { const i=document.querySelector('.shot-viewer img');return [i.src.startsWith('file:'), i.src.includes('foto.webp'), i.naturalWidth, i.naturalHeight, i.alt]; })()"), [true, true, 64, 48, 'foto.webp']);
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await until("!document.querySelector('.shot-viewer')");
    await js("(() => { const t=[...document.querySelectorAll('#attachments .attach-thumb')].find(i=>i.alt==='foto.webp');t.focus();t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()");
    await until("!!document.querySelector('.shot-viewer')"); await js("document.querySelector('.shot-viewer').click()"); await until("!document.querySelector('.shot-viewer')");
    await send('Veja a imagem'); await until("!!document.querySelector('.message.user .msg-attach-thumb[alt=\"foto.webp\"]')"); await idle();
    await js("document.querySelector('.message.user .msg-attach-thumb[alt=\"foto.webp\"]').click()");
    await until("document.querySelector('.shot-viewer img')?.complete && document.querySelector('.shot-viewer img').naturalWidth>0");
    assert.deepEqual(await js("(() => { const i=document.querySelector('.shot-viewer img');return [i.src.startsWith('file:'), i.naturalWidth]; })()"), [true, 64], 'a bolha enviada abre a imagem salva');
    await js("document.querySelector('.shot-viewer').click()"); await until("!document.querySelector('.shot-viewer')");
    // O painel Code do site pede a imagem inteira pelo controle remoto (get-image): volta no espelho, em JPEG que cabe nele.
    const espelho = await snapshot(), comImagem = espelho.messages.find(m => m.role === 'user' && m.images?.some(i => i.name === 'foto.webp'));
    assert.ok(espelho.capabilities.includes('image-view-v1') && comImagem?.id);
    await remote({ type: 'get-image', chatId: espelho.activeChatId, messageId: comImagem.id, index: 0 });
    const imagem = (await snapshot()).image;
    assert.equal(imagem.name, 'foto.webp'); assert.equal(imagem.messageId, comImagem.id); assert.match(imagem.dataUrl, /^data:image\/jpeg;base64,/); assert.ok(imagem.dataUrl.length <= 100000);
    await assert.rejects(remote({ type: 'get-image', chatId: espelho.activeChatId, messageId: comImagem.id, index: 2 }), /não encontrada/);
  });
  await check('sem modelo a mensagem e os anexos continuam no compositor', async () => {
    await remote({ type: 'set-provider', providerId: 'empty' }); await until("document.getElementById('studio-model').textContent==='Configure seu modelo'");
    await type('Mantenha meu pedido'); await attach('preservado.txt'); await until("document.querySelector('#attachments .attach-name')?.textContent==='preservado.txt'");
    const before = requests.length; await enter();
    assert.equal(await draft(), 'Mantenha meu pedido'); assert.deepEqual(await attachmentNames(), ['preservado.txt']); assert.equal(requests.length, before);
    assert.equal(await js("document.getElementById('chat-box').textContent.includes('Seu rascunho foi mantido')"), true);
    await remote({ type: 'set-provider', providerId: 'ready' }); await until("document.getElementById('studio-model').textContent==='fixture'");
    await type(''); await js("document.querySelector('#attachments .attach-remove').click()");
  });
  await check('rolagem permite ler mensagens antigas e voltar a acompanhar o streaming', async () => {
    hold = true; await send('RESPOSTA LONGA'); await until("document.querySelector('.typing-etapa')?.textContent==='Conexão aberta'");
    const res = pending.at(-1);
    res.write(event({ choices: [{ delta: { content: 'Primeiro trecho\n\n' + 'Linha de demonstração da resposta.\n\n'.repeat(90) }, finish_reason: null }] }));
    await until("document.getElementById('chat-box').scrollHeight>document.getElementById('chat-box').clientHeight+300");
    assert.equal(await js("(() => {const text=document.querySelector('.streaming .md-body').firstChild;const range=document.createRange();range.setStart(text,0);range.setEnd(text,14);const first=range.getBoundingClientRect();const offset=text.textContent.indexOf('Linha de');range.setStart(text,offset);range.setEnd(text,offset+8);return range.getBoundingClientRect().top>=first.bottom;})()"), true, 'o texto em streaming precisa preservar as linhas');
    await js("document.getElementById('chat-box').scrollTop=120"); await until("!document.getElementById('btn-chat-bottom').hidden");
    const before = await js("document.getElementById('chat-box').scrollTop");
    res.write(event({ choices: [{ delta: { content: 'NOVO TRECHO NO FIM\n\n' }, finish_reason: null }] }));
    await until("document.getElementById('chat-box').textContent.includes('NOVO TRECHO NO FIM')");
    assert.equal(await js("document.getElementById('chat-box').scrollTop"), before);
    await capture('studio-scroll-back', true);
    await js("document.getElementById('btn-chat-bottom').click()"); await until("document.getElementById('btn-chat-bottom').hidden");
    assert.equal(await js("(() => {const chat=document.getElementById('chat-box');return chat.scrollHeight-chat.scrollTop-chat.clientHeight<80;})()"), true);
    // Roda de verdade, subindo menos que a faixa de 80 px: a rolagem animada do Chromium dava o
    // primeiro passo, o pedaço seguinte do stream puxava de volta ao fim e a tela piscava.
    const centro = await js("(() => {const r=document.getElementById('chat-box').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
    await js("window.__rodaY=null;document.getElementById('chat-box').addEventListener('wheel',e=>{window.__rodaY=e.deltaY;},{once:true})");
    // Janela oculta às vezes ainda não tem quadro para o teste de acerto: reenvia até a PRIMEIRA chegar.
    for (let i = 0; i < 30 && await js('window.__rodaY') === null; i++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: centro.x, y: centro.y });
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: centro.x, y: centro.y, deltaX: 0, deltaY: 40, canScroll: true });
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(await js('window.__rodaY') < 0, 'o evento de roda precisa subir');
    for (let i = 0; i < 6; i++) { res.write(event({ choices: [{ delta: { content: 'pedaço ' + i + ' da resposta.\n\n' }, finish_reason: null }] })); await new Promise(r => setTimeout(r, 60)); }
    await until("document.getElementById('chat-box').textContent.includes('pedaço 5')");
    assert.ok(await js("(() => {const chat=document.getElementById('chat-box');return chat.scrollHeight-chat.scrollTop-chat.clientHeight;})()") >= 20, 'a subida curta foi puxada de volta ao fim');
    assert.equal(await js("document.getElementById('btn-chat-bottom').hidden"), false);
    await js("document.getElementById('btn-chat-bottom').click()"); await until("document.getElementById('btn-chat-bottom').hidden");
    res.write(event({ choices: [{ delta: { content: 'RESPOSTA FINAL' }, finish_reason: null }] }));
    await until("document.getElementById('chat-box').textContent.includes('RESPOSTA FINAL')");
    assert.equal(await js("document.getElementById('btn-chat-bottom').hidden"), true);
    res.end(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'); await idle(); hold = false;
  });
  await check('MCP com login OAuth: Entrar abre o navegador, guarda o login cifrado e conecta; Sair apaga', async () => {
    const falso = await servidorOAuthFalso();
    const salvarMcp = async texto => { await js("document.getElementById('btn-open-settings').click()"); await js("(() => { const i=document.getElementById('input-mcp'); i.value=" + JSON.stringify(texto) + "; i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('btn-save-settings').click(); })()"); await until("!document.getElementById('settings-modal').classList.contains('active')"); };
    try {
      await salvarMcp(JSON.stringify({ mcpServers: { oauth: { type: 'http', url: falso.url } } }));
      await until("document.getElementById('mcp-status').textContent.includes('oauth — precisa entrar')", 10000);
      assert.equal(abertosNoNavegador.length, 0, 'sincronizar não abre o navegador sozinho');
      await js("document.getElementById('btn-open-settings').click()");
      await js("[...document.querySelectorAll('#mcp-status .mcp-acao')].find(b=>b.textContent==='Entrar').click()");
      await until("document.getElementById('mcp-status').textContent.includes('oauth — 1 ferramenta(s)')", 15000);
      assert.equal(abertosNoNavegador.length, 1); assert.match(abertosNoNavegador[0], /code_challenge_method=S256/);
      assert.ok(await js("[...document.querySelectorAll('#mcp-status .mcp-acao')].some(b=>b.textContent==='Sair')"));
      assert.ok((await js("import('./out/renderer.js').then(m=>m.activeTools().map(t=>t.function.name))")).includes('mcp__oauth__gerar_video'));
      const gravado = require('node:fs').readFileSync(join(profile, 'mcp-oauth.json'), 'utf8');
      assert.doesNotMatch(gravado, /acesso-|renova-/, 'tokens só cifrados pelo safeStorage');
      await js("document.getElementById('mcp-status').scrollIntoView({block:'center'})"); await capture('mcp-oauth', true);
      await js("[...document.querySelectorAll('#mcp-status .mcp-acao')].find(b=>b.textContent==='Sair').click()");
      await until("document.getElementById('mcp-status').textContent.includes('oauth — precisa entrar')", 10000);
      await js("document.getElementById('btn-close-modal').click()");
    } finally {
      await salvarMcp('');
      falso.server.closeAllConnections(); falso.server.close();
    }
  });
  await check('apagar conversa inativa mantém o rascunho; apagar a ativa restaura a próxima', async () => {
    await type('Rascunho após a tarefa');
    const spare = (await snapshot()).chats.find(c => !['first', 'second'].includes(c.id)).id;
    await remote({ type: 'delete-chat', chatId: spare });
    assert.equal(await draft(), 'Rascunho após a tarefa'); assert.equal((await snapshot()).activeChatId, 'first');
    await remote({ type: 'delete-chat', chatId: 'first' });
    assert.equal((await snapshot()).activeChatId, 'second'); assert.deepEqual(await attachmentNames(), ['segundo.txt']);
    assert.equal(await draft(), '', 'o comando /novo foi consumido, não deve reaparecer no rascunho');
  });
  console.log('RESULT ' + passed + ' verificações dos fluxos de uso passaram. Capturas: ' + captures);
}
main().then(() => { server.closeAllConnections(); server.close(); app.exit(0); }, error => {
  console.error(error); server.closeAllConnections(); server.close(); app.exit(1);
});
setTimeout(() => { console.error('Tempo máximo da revisão dos fluxos excedido.'); app.exit(1); }, 90000);
