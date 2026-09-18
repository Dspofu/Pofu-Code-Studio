import test from 'node:test';
import assert from 'node:assert/strict';
import { editDiagnostics } from '../out/edit-diagnostics.js';

test('edição desatualizada aponta a diferença real, sem alegar cache', () => {
  const current = '    let ny = p.y + this.vel.y * dt;\n    this.onGround = false;\n    if (!this.collides(p.x, ny, p.z)) {\n      p.y = ny;\n    }';
  const old = current.replace('p.x, ny, p.z', 'p.x, p.y, nz');
  const result = editDiagnostics(current, old, current);
  assert.equal(result.file_changed, false);
  assert.equal(result.replacement_present, true);
  assert.equal(result.difference.line, 3);
  assert.match(result.difference.actual, /p.x, ny, p.z/);
  assert.equal(result.current_excerpt, current);
});
test('diferença de indentação preserva CRLF no trecho retornado', () => {
  const result = editDiagnostics('  function run() {\r\n    return 1;\r\n  }', 'function run() {\n  return 1;\n}', 'different');
  assert.equal(result.candidate_line, 1);
  assert.equal(result.difference.actual, '  function run() {');
  assert.match(result.current_excerpt, /\r\n/);
});
test('trecho desconhecido não inventa candidato e exclusão não consta como aplicada', () => {
  const result = editDiagnostics('const alpha = 1;', 'completely unrelated snippet', '');
  assert.equal(result.candidate_line, undefined);
  assert.equal(result.replacement_present, false);
});
test('diagnóstico de linha minificada tem orçamento explícito', () => {
  const line = 'const longValue = "' + 'a'.repeat(100000) + '";';
  const result = editDiagnostics(line, line.replace('aaa', 'bbb'), 'new value');
  assert.ok(result.current_excerpt.length <= 4000);
  assert.equal(result.excerpt_truncated, true);
  assert.equal(result.difference.lines_shortened, true);
});
