import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, applyEdits, reindent } from '../out/edit-match.js';

test('exato continua o primeiro caminho, com $& literal', () => {
  const r = applyEdit('const a = 1;\n', 'a = 1', 'a = "$&$1$$"');
  assert.equal(r.ok, true); assert.equal(r.strategy, 'exact');
  assert.equal(r.content, 'const a = "$&$1$$";\n');
});

test('CRLF: trecho em LF casa e o texto novo entra em CRLF', () => {
  const r = applyEdit('a\r\nb\r\nc\r\n', 'a\nb', 'x\ny');
  assert.equal(r.strategy, 'crlf');
  assert.equal(r.content, 'x\r\ny\r\nc\r\n');
});

test('indentação diferente casa e o novo bloco herda o recuo do arquivo', () => {
  const file = 'def f():\n    if x:\n        return 1\n    return 2\n';
  const r = applyEdit(file, 'if x:\n    return 1', 'if x:\n    log()\n    return 1');
  assert.equal(r.ok, true); assert.equal(r.strategy, 'trimmed');
  assert.equal(r.content, 'def f():\n    if x:\n        log()\n        return 1\n    return 2\n');
});

test('espaço no fim da linha e tabs misturados não impedem o casamento', () => {
  const r = applyEdit('\tfoo(a,  b);   \n\tbar();\n', 'foo(a, b);\nbar();', 'foo(a, b);\nbaz();');
  assert.equal(r.ok, true); assert.equal(r.strategy, 'whitespace');
  assert.equal(r.content, '\tfoo(a, b);\n\tbaz();\n');
});

test('aspas tipográficas do modelo casam com aspas retas do arquivo', () => {
  const r = applyEdit('msg = "it\'s ok"\nnext()\n', 'msg = \u201cit\u2019s ok\u201d\nnext()', 'msg = "fine"\nnext()');
  assert.equal(r.ok, true); assert.equal(r.strategy, 'unicode');
  assert.equal(r.content, 'msg = "fine"\nnext()\n');
});

test('\\n literal de argumento serializado duas vezes', () => {
  const r = applyEdit('one\ntwo\nthree', 'one\\ntwo', 'uno\\ndos');
  assert.equal(r.strategy, 'escaped'); assert.equal(r.content, 'uno\ndos\nthree');
});

test('ambíguo devolve as linhas e não escreve', () => {
  const r = applyEdit('x();\ny();\nx();\n', 'x();', 'z();');
  assert.equal(r.ok, false); assert.equal(r.kind, 'ambiguous'); assert.deepEqual(r.lines, [1, 3]);
});

test('replace_all exige texto exato quando há mais de um casamento', () => {
  assert.equal(applyEdit('x();\nx();\n', 'x();', 'z();', true).content, 'z();\nz();\n');
  const r = applyEdit('  x();\n    x();\n', 'x(); ', 'z();', true);
  assert.equal(r.ok, false); assert.equal(r.kind, 'ambiguous_fuzzy');
});

test('sem casamento nem por espaço: not_found (diagnóstico fica com editDiagnostics)', () => {
  const r = applyEdit('alpha\nbeta\n', 'alpha\ngamma', 'x');
  assert.equal(r.ok, false); assert.equal(r.kind, 'not_found');
});

test('trecho vazio, só espaço ou idêntico são recusados', () => {
  assert.equal(applyEdit('a', '', 'b').kind, 'empty');
  assert.equal(applyEdit('a', '   ', 'b').kind, 'empty');
  assert.equal(applyEdit('a', 'a', 'a').kind, 'identical');
});

test('old_text terminado em quebra consome a quebra também', () => {
  const r = applyEdit('  a\n  b\nc\n', 'a\nb\n', '');
  assert.equal(r.ok, true); assert.equal(r.content, 'c\n');
});

test('várias edições são atômicas e enxergam a anterior', () => {
  const ok = applyEdits('a\nb\nc\n', [{ old_text: 'a', new_text: 'A' }, { old_text: 'A\nb', new_text: 'A\nB' }]);
  assert.equal(ok.ok, true); assert.equal(ok.content, 'A\nB\nc\n');
  assert.deepEqual(ok.applied.map(e => e.line), [1, 1]);
  const falha = applyEdits('a\nb\n', [{ old_text: 'a', new_text: 'A' }, { old_text: 'nope', new_text: 'x' }]);
  assert.equal(falha.ok, false); assert.equal(falha.index, 1); assert.equal(falha.failure.kind, 'not_found');
});

test('reindent preserva o aninhamento relativo', () => {
  assert.equal(reindent('    if a:', 'if a:', 'if a:\n  b()\nc()'), '    if a:\n      b()\n    c()');
});
