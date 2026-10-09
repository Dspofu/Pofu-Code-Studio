// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

const { app, BrowserWindow, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');

const profile = mkdtempSync(join(tmpdir(), 'pofu-subagents-'));
const workspace = join(profile, 'project');
const captures = process.env.POFU_QA_OUTPUT || join(profile, 'captures');
mkdirSync(workspace); mkdirSync(captures, { recursive: true });
writeFileSync(join(workspace, 'alpha.txt'), 'ALPHA_SECRET: análise isolada de alpha.\n');
writeFileSync(join(workspace, 'beta.txt'), 'BETA_MARKER: resultado de pesquisa.\n');
writeFileSync(join(workspace, 'protected.txt'), 'ORIGINAL_PROTECTED\n');
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/')
  ? Promise.resolve(Response.json({}, { status: 404 })) : originalFetch(url, ...args);

function latch() { let release; return { promise: new Promise(ok => { release = ok; }), release: value => release(value) }; }
const firstChildren = latch(), alphaHistoryReady = latch(), parentFinal = latch(), queueChildren = latch();
const bodies = [], childBodies = [], parentBodies = [], cancelledConnections = new Set();
let firstChildCount = 0, activeChildren = 0, peakChildren = 0, alphaHistoryId = '', parentWaiting = false;
const CHILD_TOTAL = 29007, PARENT_TOTAL = 4096;

function emit(res, step, total = PARENT_TOTAL) {
  if (res.destroyed) return;
  const delta = step.tool ? { tool_calls: [{ index: 0, id: step.id || 'fixture-call', type: 'function', function: {
    name: step.tool, arguments: JSON.stringify(step.args)
  } }] } : { content: step.content };
  res.setHeader('Content-Type', 'text/event-stream');
  res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: total - 7, completion_tokens: 7, total_tokens: total } }) + '\n\n' +
    'data: [DONE]\n\n');
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.end();
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'subagent-fixture', meta: { n_ctx: 32768 } }] }));
  if (req.url.endsWith('/props')) return res.end(JSON.stringify({ default_generation_settings: {}, chat_template: '' }));
  if (!req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const entry = { body, authorization: req.headers.authorization, started: Date.now() };
    bodies.push(entry);
    const root = body.tools?.some(tool => tool.function?.name === 'delegate_tasks');
    const user = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
    const toolMessages = body.messages.filter(message => message.role === 'tool');
    if (root) {
      parentBodies.push(entry);
      const userIndex = body.messages.findLastIndex(message => message.role === 'user');
      const delegated = body.messages.slice(userIndex + 1).some(message => message.name === 'delegate_tasks');
      if (user === 'BATCH_PARALLEL') {
        if (!delegated) return emit(res, { tool: 'delegate_tasks', id: 'parent-parallel', args: { tasks: [
          { name: 'Leitura Alpha', task: 'WORKER_ALPHA: inspect alpha.txt and recover your own read output.' },
          { name: 'Busca Beta', task: 'WORKER_BETA: search BETA_MARKER, then check an unavailable history ID.' }
        ] } });
        parentWaiting = true;
        await parentFinal.promise;
        return emit(res, { content: 'PARENT_PARALLEL_DONE' }, 8192);
      }
      if (user === 'BATCH_FORBIDDEN') {
        if (!delegated) return emit(res, { tool: 'delegate_tasks', id: 'parent-forbidden', args: { tasks: [
          { name: 'Revisão protegida', task: 'WORKER_FORBIDDEN: attempt an unavailable write_file, then report the denial.' }
        ] } });
        return emit(res, { content: 'PARENT_FORBIDDEN_DONE' });
      }
      if (user === 'BATCH_CANCEL') return emit(res, { tool: 'delegate_tasks', id: 'parent-cancel', args: { tasks: [
        { name: 'Espera A', task: 'WORKER_CANCEL_A: pending request.' },
        { name: 'Espera B', task: 'WORKER_CANCEL_B: pending request.' }
      ] } });
      if (user === 'BATCH_QUEUE') {
        if (!delegated) return emit(res, { tool: 'delegate_tasks', id: 'parent-queue', args: { tasks: [
          { name: 'Fila A', task: 'WORKER_QUEUE_A: wait, then report QUEUE_A_DONE.' },
          { name: 'Fila B', task: 'WORKER_QUEUE_B: wait, then report QUEUE_B_DONE.' }
        ] } });
        return emit(res, { content: 'PARENT_QUEUE_DONE' });
      }
      const transportTasks = {
        BATCH_RETRY: [{ name: 'Reconexão', task: 'WORKER_TRANSPORT_RETRY: inspect a transient server failure.' }],
        BATCH_RETRY_CANCEL: [{ name: 'Espera cancelável', task: 'WORKER_TRANSPORT_CANCEL: inspect a server failure until stopped.' }],
        BATCH_AUTH: [
          { name: 'Autenticação', task: 'WORKER_TRANSPORT_AUTH: inspect a rejected authentication.' },
          { name: 'Análise preservada', task: 'WORKER_TRANSPORT_HEALTHY: return a useful independent finding.' }
        ],
        BATCH_THINK: [
          { name: 'Raciocínio alto', task: 'WORKER_THINK_HIGH: use an accepted reasoning level.' },
          { name: 'Raciocínio médio', task: 'WORKER_THINK_MEDIUM: use another accepted reasoning level.' }
        ]
      };
      if (transportTasks[user]) {
        if (!delegated) return emit(res, { tool: 'delegate_tasks', id: 'parent-' + user.toLowerCase(), args: { tasks: transportTasks[user] } });
        return emit(res, { content: 'PARENT_' + user.slice('BATCH_'.length) + '_DONE' });
      }
      if (user === 'continue') return emit(res, { content: 'PARENT_CONTINUE_DONE' });
      return emit(res, { content: 'PARENT_FIXTURE_DONE' });
    }
    childBodies.push(entry);
    const task = body.messages.find(message => message.role === 'user')?.content || '';
    if (task.startsWith('WORKER_ALPHA') || task.startsWith('WORKER_BETA')) {
      activeChildren++; peakChildren = Math.max(peakChildren, activeChildren);
      res.once('close', () => { activeChildren--; });
      if (!toolMessages.length) {
        if (++firstChildCount === 2) firstChildren.release();
        await firstChildren.promise;
        if (task.startsWith('WORKER_ALPHA')) return emit(res, { tool: 'read_file', args: { filename: 'alpha.txt' } }, CHILD_TOTAL);
        await alphaHistoryReady.promise;
        return emit(res, { tool: 'search_files', args: { query: 'BETA_MARKER' } }, CHILD_TOTAL);
      }
      if (task.startsWith('WORKER_ALPHA')) {
        if (toolMessages.length === 1) {
          alphaHistoryId = toolMessages[0].tool_call_id; alphaHistoryReady.release();
          return emit(res, { tool: 'read_tool_result', args: { result_id: 'history:' + alphaHistoryId, query: 'ALPHA_SECRET' } }, CHILD_TOTAL);
        }
        return emit(res, { content: [
          '## ALPHA_FINDING: alpha.txt contém a evidência de leitura.',
          '', '**Evidência:** conteúdo confirmado em `alpha.txt`.', '',
          '```ts', 'const evidência = "ALPHA_SECRET";', '```', '',
          '<script>window.POFU_UNSAFE_SUBAGENT=true</script>',
          '<img src="invalid-subagent-image" onerror="window.POFU_UNSAFE_SUBAGENT=true">'
        ].join('\n') }, CHILD_TOTAL);
      }
      if (toolMessages.length === 1) return emit(res, { tool: 'read_tool_result', args: { result_id: 'history:' + alphaHistoryId } }, CHILD_TOTAL);
      if (toolMessages.length === 2) return emit(res, { tool: 'read_tool_result', args: { result_id: 'history:root-only' } }, CHILD_TOTAL);
      return emit(res, { content: 'BETA_FINDING: beta.txt contém BETA_MARKER.' }, CHILD_TOTAL);
    }
    if (task.startsWith('WORKER_FORBIDDEN')) {
      if (!toolMessages.length) return emit(res, { tool: 'write_file', args: { filename: 'protected.txt', content: 'ILLEGAL_WRITE' } }, CHILD_TOTAL);
      return emit(res, { content: 'FORBIDDEN_FINDING: a ferramenta de escrita foi recusada.' }, CHILD_TOTAL);
    }
    if (task.startsWith('WORKER_CANCEL')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(': waiting\n\n');
      res.once('close', () => cancelledConnections.add(task.split(':')[0]));
      return;
    }
    if (task.startsWith('WORKER_QUEUE')) {
      await queueChildren.promise;
      return emit(res, { content: task.includes('QUEUE_A') ? 'QUEUE_A_DONE' : 'QUEUE_B_DONE' }, CHILD_TOTAL);
    }
    if (task.startsWith('WORKER_TRANSPORT_RETRY:')) {
      const attempts = childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_TRANSPORT_RETRY:')).length;
      if (attempts === 1) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: { message: 'Temporary inference failure.' } }));
      }
      return emit(res, { content: 'RETRY_FINDING: a conexão foi recuperada.' }, CHILD_TOTAL);
    }
    if (task.startsWith('WORKER_TRANSPORT_CANCEL:')) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: { message: 'Temporary failure while awaiting user stop.' } }));
    }
    if (task.startsWith('WORKER_TRANSPORT_AUTH:')) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Synthetic rejected authentication.' } }));
    }
    if (task.startsWith('WORKER_TRANSPORT_HEALTHY:'))
      return emit(res, { content: 'HEALTHY_FINDING: a análise independente foi preservada.' }, CHILD_TOTAL);
    if (task.startsWith('WORKER_THINK_HIGH:') || task.startsWith('WORKER_THINK_MEDIUM:')) {
      const accepted = task.startsWith('WORKER_THINK_HIGH:') ? 'high' : 'medium';
      if (body.reasoning_effort !== accepted) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: `Unsupported reasoning_effort: ${body.reasoning_effort}. Supported types are ${accepted} and low.` } }));
      }
      return emit(res, { content: 'THINK_FINDING_' + accepted.toUpperCase() + ': configuração aceita.' }, CHILD_TOTAL);
    }
    throw new Error('Unexpected synthetic subagent request: ' + task);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.statusCode = 500;
    if (!res.destroyed) res.end(JSON.stringify({ error: { message: error.message } }));
  }
});

async function main() {
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(join(profile, 'app-store.json'), JSON.stringify({ settings: {
    providers: [{ id: 'fixture', name: 'Provedor isolado', apiUrl: origin + '/v1', apiKey: 'synthetic-key', model: 'subagent-fixture', thinkLevel: 'muito_alto' }],
    activeProviderId: 'fixture', webSearch: false
  }, activeChatId: 'chat', chats: { chat: { id: 'chat', name: 'Teste de subagentes', path: workspace, messages: [
    { role: 'user', content: 'Inspecione uma evidência reservada ao pai.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'root-only', type: 'function', function: { name: 'read_file', arguments: '{"filename":"parent.txt"}' } }] },
    { role: 'tool', tool_call_id: 'root-only', name: 'read_file', content: 'PARENT_ONLY_SECRET' },
    { role: 'assistant', content: 'Evidência do pai registrada.' }
  ] } } }));
  await import(pathToFileURL(resolve('out/main.js'))); await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(ok => win.webContents.once('did-finish-load', ok));
  const js = code => win.webContents.executeJavaScript(code);
  async function until(code, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await js(code)) return; await new Promise(ok => setTimeout(ok, 30)); }
    throw new Error('Tempo excedido: ' + code + '\n' + await js(`document.getElementById('chat-box').textContent.slice(-3000)`));
  }
  const send = text => js(`(() => { const input=document.getElementById('user-input'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  const idle = () => until(`!document.body.classList.contains('agent-running')`);
  const history = () => js(`import('./out/renderer.js').then(m=>m.activeChat().messages)`);
  const tool = (name, args) => js(`import('./out/renderer.js').then(m=>m.runTool(${JSON.stringify(name)},${JSON.stringify(args)},${JSON.stringify(workspace)}))`);
  const data = raw => JSON.parse(typeof raw === 'string' ? raw : raw.text);
  const snapshot = () => js(`import('./out/renderer.js').then(m=>m.studioRemoteSnapshot())`);
  const childRequests = task => childBodies.filter(entry => entry.body.messages[1]?.content.startsWith(task));
  const row = task => `[...document.querySelectorAll('.subagent-row')].find(row=>row.querySelector('.subagent-task').textContent.startsWith(${JSON.stringify(task)}))`;
  const status = task => `(${row(task)})?.querySelector('.subagent-status')?.textContent || ''`;
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  async function capture(name) {
    win.setSize(1380, 860); win.showInactive();
    await js(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
    await new Promise(ok => setTimeout(ok, 200));
    writeFileSync(join(captures, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.hide();
  }
  await until(`document.getElementById('info-model-name').textContent.includes('subagent-fixture')`);

  await check('duas tarefas usam requisições concorrentes e status visível', async () => {
    await send('BATCH_PARALLEL');
    await until(`document.querySelectorAll('.subagents-panel .subagent-row').length===2`);
    await capture('subagentes-em-andamento');
    await until(`document.querySelectorAll('.subagent-row[data-status="completed"]').length===2`);
    await until(`document.getElementById('chat-box').textContent.includes('ALPHA_FINDING') && document.getElementById('chat-box').textContent.includes('BETA_FINDING')`);
    const deadline = Date.now() + 5000;
    while (!parentWaiting && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 20));
    assert.equal(firstChildCount, 2); assert.ok(peakChildren >= 2, 'crianças devem ter requisições simultâneas');
    assert.equal(parentWaiting, true);
  });
  await check('provedor e uso acumulado preservam o contexto do pai', async () => {
    assert.ok(bodies.every(entry => entry.authorization === 'Bearer synthetic-key'));
    assert.ok(bodies.every(entry => entry.body.model === 'subagent-fixture'));
    assert.equal((await snapshot()).usage.contextUsed, PARENT_TOTAL);
    assert.ok(childBodies.every(entry => !entry.body.tools.some(t => t.function.name === 'delegate_tasks')));
    assert.ok(childBodies.every(entry => entry.body.tools.every(t => ['list_files','read_file','search_files','list_definitions','read_tool_result','fetch_url','web_search'].includes(t.function.name))));
    assert.ok(childBodies.every(entry => !JSON.stringify(entry.body.messages).includes('PARENT_ONLY_SECRET')));
    parentFinal.release(); await until(`document.getElementById('chat-box').textContent.includes('PARENT_PARALLEL_DONE')`); await idle();
    assert.equal(await js(`Number(document.getElementById('usage-requests').textContent)`), bodies.length);
    assert.ok(await js(`Number(document.getElementById('usage-prompt').textContent.replace(/\\D/g,'')) > ${CHILD_TOTAL * 2}`));
  });
  await check('histórico e recuperação de resultados ficam isolados por criança', async () => {
    const alpha = childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_ALPHA')).at(-1).body;
    const beta = childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_BETA')).at(-1).body;
    const alphaTools = alpha.messages.filter(m => m.role === 'tool');
    assert.match(alphaTools[1].content, /ALPHA_SECRET/);
    const betaTools = beta.messages.filter(m => m.role === 'tool');
    assert.match(betaTools[0].content, /BETA_MARKER/);
    assert.ok(JSON.parse(betaTools[1].content).error);
    assert.ok(JSON.parse(betaTools[2].content).error);
    assert.doesNotMatch(JSON.stringify(betaTools), /ALPHA_SECRET|PARENT_ONLY_SECRET/);
    const messages = await history(), delegated = messages.find(m => m.name === 'delegate_tasks');
    const result = JSON.parse(delegated.content);
    assert.equal(result.agents.length, 2); assert.ok(result.agents.every(a => a.status === 'completed'));
    assert.match(result.agents[0].result, /ALPHA_FINDING/); assert.match(result.agents[1].result, /BETA_FINDING/);
    assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.name), ['read_file', 'delegate_tasks']);
    assert.ok(parentBodies.at(-1).body.messages.some(m => m.name === 'delegate_tasks' && m.content.includes('ALPHA_FINDING')));
    assert.doesNotMatch(JSON.stringify(parentBodies.at(-1).body.messages), /subtool-/);
  });
  await check('leitura da criança não autoriza o pai a sobrescrever arquivo', async () => {
    const result = data(await tool('write_file', { filename: 'alpha.txt', content: 'PARENT_ILLEGAL_WRITE' }));
    assert.equal(result.success, false);
    assert.match(result.error, /read|unread|not.*seen/i);
    assert.match(readFileSync(join(workspace, 'alpha.txt'), 'utf8'), /ALPHA_SECRET/);
  });
  await check('resultados usam Markdown formatado e HTML sanitizado', async () => {
    assert.equal(await js(`document.querySelectorAll('.subagent-output h2').length`), 1);
    assert.equal(await js(`document.querySelectorAll('.subagent-output .code-block pre code').length`), 1);
    assert.equal(await js(`document.querySelectorAll('.subagent-output script,.subagent-output [onerror]').length`), 0);
    assert.equal(await js(`window.POFU_UNSAFE_SUBAGENT===true`), false);
    assert.match(await js(`document.querySelector('.subagent-output h2').textContent`), /ALPHA_FINDING/);
    await js(`document.querySelector('.subagent-output h2').closest('details').open=true;document.querySelector('.subagents-panel').closest('.tool-card').scrollIntoView({block:'start',behavior:'instant'})`);
    await capture('subagentes-markdown');
    await js(`document.querySelector('.subagent-output h2').closest('details').open=false`);
  });
  await check('ferramenta mutável forçada é recusada antes do IPC', async () => {
    await send('BATCH_FORBIDDEN'); await until(`document.getElementById('chat-box').textContent.includes('PARENT_FORBIDDEN_DONE')`); await idle();
    assert.equal(readFileSync(join(workspace, 'protected.txt'), 'utf8'), 'ORIGINAL_PROTECTED\n');
    const denied = childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_FORBIDDEN')).at(-1).body.messages.find(m => m.role === 'tool');
    assert.match(JSON.parse(denied.content).error, /unavailable|read-only/);
    assert.equal(await js(`document.getElementById('confirm-modal').classList.contains('active')`), false);
  });
  await check('Parar cancela todas as conexões pendentes sem continuar o pai', async () => {
    await send('BATCH_CANCEL');
    const deadline = Date.now() + 15000;
    while (childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_CANCEL')).length < 2 && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 30));
    assert.equal(childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_CANCEL')).length, 2);
    const before = parentBodies.length, start = Date.now();
    await js(`document.getElementById('btn-send').click()`); await idle();
    assert.ok(Date.now() - start < 2500);
    await until(`document.querySelectorAll('.subagent-row[data-status="cancelled"]').length===2`);
    await new Promise(ok => setTimeout(ok, 100));
    assert.equal(cancelledConnections.size, 2); assert.equal(parentBodies.length, before);
  });
  await check('continue durante delegação sai da fila uma vez', async () => {
    await send('BATCH_QUEUE');
    const deadline = Date.now() + 15000;
    while (childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_QUEUE')).length < 2 && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 30));
    assert.equal(childBodies.filter(entry => entry.body.messages[1].content.startsWith('WORKER_QUEUE')).length, 2);
    await send('continue'); assert.equal((await snapshot()).queued, 1);
    queueChildren.release(); await until(`document.getElementById('chat-box').textContent.includes('PARENT_CONTINUE_DONE')`); await idle();
    const messages = await history(); assert.equal(messages.filter(m => m.role === 'user' && m.content === 'continue').length, 1);
    assert.equal(parentBodies.filter(entry => entry.body.messages.at(-1)?.content === 'continue').length, 1);
    for (const call of messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []))
      assert.equal(messages.filter(m => m.role === 'tool' && m.tool_call_id === call.id).length, 1, 'cada chamada do pai deve ter um resultado');
  });
  await check('falha 500 aguarda dez segundos com contagem regressiva antes de reconectar', async () => {
    const task = 'WORKER_TRANSPORT_RETRY:';
    await send('BATCH_RETRY');
    await until(`/Reconectando em (?:9|10)s/.test(${status(task)})`);
    assert.equal(childRequests(task).length, 1);
    await until(`/Reconectando em [78]s/.test(${status(task)})`, 5000);
    assert.equal(childRequests(task).length, 1, 'não deve haver repetição antes do fim dos dez segundos');
    await until(`document.getElementById('chat-box').textContent.includes('PARENT_RETRY_DONE')`, 20000);
    await idle();
    const attempts = childRequests(task);
    assert.equal(attempts.length, 2);
    assert.ok(attempts[1].started - attempts[0].started >= 9950, `intervalo medido: ${attempts[1].started - attempts[0].started}ms`);
    assert.equal(await js(status(task)), 'Concluído');
    const result = JSON.parse((await history()).findLast(message => message.name === 'delegate_tasks').content);
    assert.equal(result.success, true);
    assert.match(result.agents[0].result, /RETRY_FINDING/);
  });
  await check('Parar durante a contagem regressiva cancela rapidamente sem repetir a chamada', async () => {
    const task = 'WORKER_TRANSPORT_CANCEL:';
    await send('BATCH_RETRY_CANCEL');
    await until(`/Reconectando em (?:9|10)s/.test(${status(task)})`);
    const parents = parentBodies.length, started = Date.now();
    await js(`document.getElementById('btn-send').click()`); await idle();
    assert.ok(Date.now() - started < 2500);
    await until(`(${row(task)})?.dataset.status==='cancelled'`);
    await new Promise(ok => setTimeout(ok, 250));
    assert.equal(childRequests(task).length, 1);
    assert.equal(parentBodies.length, parents, 'o pai não deve fazer outra geração após Parar');
    assert.equal(await js(status(task)), 'Interrompido');
  });
  await check('401 não repete a autenticação e preserva a análise concluída do outro filho', async () => {
    await send('BATCH_AUTH');
    await until(`document.getElementById('chat-box').textContent.includes('PARENT_AUTH_DONE')`); await idle();
    assert.equal(childRequests('WORKER_TRANSPORT_AUTH:').length, 1);
    assert.equal(childRequests('WORKER_TRANSPORT_HEALTHY:').length, 1);
    const result = JSON.parse((await history()).findLast(message => message.name === 'delegate_tasks').content);
    assert.equal(result.success, false);
    assert.equal(result.agents[0].status, 'failed');
    assert.match(result.agents[0].error, /HTTP 401/);
    assert.equal(result.agents[1].status, 'completed');
    assert.match(result.agents[1].result, /HEALTHY_FINDING/);
    assert.equal(await js(status('WORKER_TRANSPORT_AUTH:')), 'Falhou');
    assert.equal(await js(status('WORKER_TRANSPORT_HEALTHY:')), 'Concluído');
    const payload = parentBodies.at(-1).body.messages.findLast(message => message.name === 'delegate_tasks');
    assert.match(payload.content, /HEALTHY_FINDING/);
    assert.match(payload.content, /HTTP 401/);
  });
  await check('níveis de raciocínio recusados se adaptam no payload de cada filho sem alterar o pai', async () => {
    await send('BATCH_THINK');
    await until(`document.getElementById('chat-box').textContent.includes('PARENT_THINK_DONE')`); await idle();
    assert.deepEqual(childRequests('WORKER_THINK_HIGH:').map(entry => entry.body.reasoning_effort), ['xhigh', 'high']);
    assert.deepEqual(childRequests('WORKER_THINK_MEDIUM:').map(entry => entry.body.reasoning_effort), ['xhigh', 'medium']);
    assert.equal(parentBodies.at(-1).body.reasoning_effort, 'xhigh');
    const result = JSON.parse((await history()).findLast(message => message.name === 'delegate_tasks').content);
    assert.equal(result.success, true);
    assert.ok(result.agents.every(agent => agent.status === 'completed'));
  });
  await check('resultados expandidos cabem na janela compacta', async () => {
    win.setContentSize(820, 680);
    await js(`document.querySelectorAll('.subagent-row details').forEach(details=>details.open=true)`);
    win.showInactive(); await js(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
    await new Promise(ok => setTimeout(ok, 150));
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true, await js(`JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,15).map(node=>({tag:node.tagName,id:node.id,class:node.className,right:node.getBoundingClientRect().right}))})`));
    assert.equal(await js(`[...document.querySelectorAll('.subagent-row')].every(row=>row.scrollWidth<=row.clientWidth+1)`), true);
    win.showInactive(); await js(`new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true))))`);
    writeFileSync(join(captures, 'subagentes-compactos.png'), (await win.webContents.capturePage()).toPNG()); win.hide();
    await js(`document.querySelectorAll('.subagent-row details').forEach(details=>details.open=false)`);
    win.setContentSize(1380, 820);
  });
  await check('cartões e conclusões são restaurados ao recarregar', async () => {
    await capture('subagentes-concluidos');
    win.reload(); await new Promise(ok => win.webContents.once('did-finish-load', ok));
    await until(`document.querySelectorAll('.subagents-panel').length>=3`);
    assert.match(await js(`document.getElementById('chat-box').textContent`), /ALPHA_FINDING/);
    assert.match(await js(`document.getElementById('chat-box').textContent`), /FORBIDDEN_FINDING/);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true);
    await capture('subagentes-restaurados');
  });
  console.log(`RESULT ${passed} verificações de subagentes passaram. Capturas: ${captures}`);
}

main().then(() => { server.closeAllConnections(); server.close(); app.exit(0); }, error => {
  console.error(error); server.closeAllConnections(); server.close(); app.exit(1);
});
setTimeout(() => { console.error('Tempo máximo do ensaio de subagentes excedido.'); app.exit(1); }, 120000);
