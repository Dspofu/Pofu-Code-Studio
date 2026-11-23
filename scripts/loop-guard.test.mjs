import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, chaveDaChamada, assinaturaDoResultado, temEfeito, resultadoEmAndamento, LIMITE_EM_ANDAMENTO } from '../out/loop-guard.js';

const falha = pid => JSON.stringify({ pid, stderr: "'cat' não é reconhecido", success: false, exitCode: 1 });

test('mesmo resultado duas vezes bloqueia a terceira, mesmo com PID diferente', () => {
  const g = new LoopGuard();
  const k = chaveDaChamada('execute_command', { command: 'cat package.json' });
  g.registra(k, falha(100), true);
  assert.equal(g.bloqueia(k), 0);
  g.registra(k, falha(200), true);
  assert.equal(g.bloqueia(k), 2);
});

test('resultado que muda não é loop (esperar o servidor subir)', () => {
  const g = new LoopGuard();
  const k = chaveDaChamada('capture_page', { url: 'http://localhost:3000' });
  g.registra(k, '{"error":"ERR_CONNECTION_REFUSED"}', false);
  g.registra(k, '{"ok":true,"title":"App"}', false);
  assert.equal(g.bloqueia(k), 0);
});

test('A, B, A, B alternados são pegos — a falha documentada do opencode', () => {
  const g = new LoopGuard();
  const a = chaveDaChamada('read_file', { filename: 'x' }), b = chaveDaChamada('list_files', {});
  for (let i = 0; i < 2; i++) { g.registra(a, 'mesmo', false); g.registra(b, 'lista', false); }
  assert.equal(g.bloqueia(a), 2); assert.equal(g.bloqueia(b), 2);
});

test('efeito colateral alheio e instrução nova zeram a contagem', () => {
  const g = new LoopGuard();
  const teste = chaveDaChamada('execute_command', { command: 'npm test' });
  g.registra(teste, 'FAIL', true); g.registra(teste, 'FAIL', true);
  g.registra(chaveDaChamada('execute_command', { command: 'npm install x' }), 'ok', true);
  assert.equal(g.bloqueia(teste), 0);
  g.registra(teste, 'FAIL', true); g.registra(teste, 'FAIL', true);
  g.novaInstrucao();
  assert.equal(g.bloqueia(teste), 0);
});

test('argumentos em outra ordem são a mesma chamada; campos voláteis não contam', () => {
  assert.equal(chaveDaChamada('search_files', { query: 'a', regex: true }), chaveDaChamada('search_files', { regex: true, query: 'a' }));
  assert.equal(assinaturaDoResultado('{"result_id":"result-1","content":"x"}'), assinaturaDoResultado('{"content":"x","result_id":"result-2"}'));
  assert.notEqual(assinaturaDoResultado('a'), assinaturaDoResultado('b'));
});

test('PID e ID do resultado identificam a chamada e não podem ser descartados', () => {
  const g = new LoopGuard();
  for (const [nome, campo, antes, depois] of [
    ['read_process_output', 'pid', 100, 200],
    ['wait_for_process', 'pid', 100, 200],
    ['read_tool_result', 'result_id', 'result-1', 'result-2']
  ]) {
    const primeira = chaveDaChamada(nome, { [campo]: antes });
    const outra = chaveDaChamada(nome, { [campo]: depois });
    g.registra(primeira, 'mesma saída', false);
    g.registra(primeira, 'mesma saída', false);
    assert.equal(g.bloqueia(primeira), 2);
    assert.notEqual(primeira, outra);
    assert.equal(g.bloqueia(outra), 0);
  }
  assert.notEqual(chaveDaChamada('mcp__api__consulta', { filtros: { status: 'ok', pid: 1 } }),
    chaveDaChamada('mcp__api__consulta', { filtros: { status: 'ok', pid: 2 } }));
});

test('o que tem efeito colateral', () => {
  assert.equal(temEfeito('read_file', {}), false);
  assert.equal(temEfeito('edit_file', {}), true);
  assert.equal(temEfeito('http_request', { method: 'get' }), false);
  assert.equal(temEfeito('http_request', { method: 'POST' }), true);
  assert.equal(temEfeito('capture_page', { script: 'x.click()' }), true);
  assert.equal(temEfeito('computer_action', { action: 'click' }), true);
  assert.equal(temEfeito('capture_screen', {}), false);
  assert.equal(temEfeito('view_image', { filename: 'a.png' }), false);
});

test('acompanhar operação em andamento não é loop até o teto maior', () => {
  const g = new LoopGuard();
  const k = chaveDaChamada('mcp__higgsfield__scene_builder_3d_get_operation', { operationId: 'query-render-preview-03', waitSeconds: 30 });
  const rodando = JSON.stringify({ ok: true, operation: { id: 'query-render-preview-03', status: 'running', finishedAt: null } });
  for (let i = 0; i < LIMITE_EM_ANDAMENTO - 1; i++) { g.registra(k, rodando, false); assert.equal(g.bloqueia(k), 0, `polling ${i + 1}`); }
  g.registra(k, rodando, false);
  assert.equal(g.bloqueia(k), LIMITE_EM_ANDAMENTO, 'operação que nunca termina ainda é looping');
});

test('resultado terminado repetido continua bloqueando na terceira', () => {
  const g = new LoopGuard();
  const k = chaveDaChamada('mcp__x__get_operation', { id: 1 });
  const ok = JSON.stringify({ operation: { status: 'succeeded' } });
  g.registra(k, ok, false); g.registra(k, ok, false);
  assert.equal(g.bloqueia(k), 2);
});

test('detecção de em andamento: JSON aninhado e status curto em texto, não log longo', () => {
  assert.equal(resultadoEmAndamento('{"operation":{"status":"checkpointing"}}'), true);
  assert.equal(resultadoEmAndamento('{"jobs":[{"state":"queued"}]}'), true);
  assert.equal(resultadoEmAndamento('{"status":"completed"}'), false);
  assert.equal(resultadoEmAndamento('Job 187d504f-69b1-4a14-a982-91a0f113cfdc — in_progress'), true);
  assert.equal(resultadoEmAndamento('PASS a\nrunning tests in parallel\nFAIL b\n' + 'x'.repeat(400)), false);
  assert.equal(resultadoEmAndamento('build ok'), false);
});
