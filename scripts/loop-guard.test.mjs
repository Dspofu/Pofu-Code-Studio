import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, chaveDaChamada, assinaturaDoResultado, temEfeito } from '../out/loop-guard.js';

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
