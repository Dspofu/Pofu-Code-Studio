import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTerminalOutput, formatSearch, formatListing, formatTree, suggestPaths, globToRegex } from '../out/tool-output.js';

const ESC = String.fromCharCode(27);

test('terminal: sem ANSI, sem redesenho de progresso e em LF', () => {
  const raw = `${ESC}[32mok${ESC}[0m\r\n 10%\r 50%\r100%\r\ndone\r\n`;
  assert.equal(cleanTerminalOutput(raw), 'ok\n100%\ndone\n');
});

test('terminal: linha repetida vira contagem, e o texto único fica intacto', () => {
  const raw = ['start', ...Array(50).fill('npm WARN deprecated x'), 'end'].join('\n');
  assert.equal(cleanTerminalOutput(raw), 'start\nnpm WARN deprecated x\n[previous line repeated 49 more times]\nend');
  assert.equal(cleanTerminalOutput('x'.repeat(22003)), 'x'.repeat(22003));
  assert.equal(cleanTerminalOutput('a\n\n\n\n\nb'), 'a\n\n\nb');
});

test('terminal: backspace apaga o caractere anterior', () => {
  assert.equal(cleanTerminalOutput('abx' + String.fromCharCode(8) + 'c'), 'abc');
});

const busca = (over = {}) => ({
  success: true, query: 'foo', totalFound: 3, scanned: 4, offset: 0, next_offset: null,
  matches: [
    { file: 'src/a.ts', line: 10, column: 3, text: '  foo();', before: [{ line: 9, text: 'x' }], after: [{ line: 11, text: '  foo(2);' }] },
    { file: 'src/a.ts', line: 11, column: 3, text: '  foo(2);', before: [{ line: 10, text: '  foo();' }], after: [{ line: 12, text: '}' }] },
    { file: 'src/b.ts', line: 40, column: 1, text: 'foo', before: [], after: [] }
  ], ...over
});

test('busca agrupa por arquivo e não repete contexto sobreposto', () => {
  assert.equal(formatSearch(busca()),
    '3 matches:\nsrc/a.ts\n9-x\n10:  foo();\n11:  foo(2);\n12-}\nsrc/b.ts\n40:foo');
});

test('busca paginada diz de onde continuar; blocos distantes ganham separador', () => {
  const r = formatSearch(busca({ totalFound: 90, next_offset: 3, matches: [
    { file: 'a', line: 1, column: 1, text: 'foo', after: [{ line: 2, text: 'y' }] },
    { file: 'a', line: 30, column: 1, text: 'foo', before: [{ line: 29, text: 'z' }] }] }));
  assert.equal(r, '90 matches; showing 1-2, continue with offset=3:\na\n1:foo\n2-y\n--\n29-z\n30:foo');
});

test('linha minificada sai como trecho com a coluna real', () => {
  const r = formatSearch(busca({ totalFound: 1, matches: [{ file: 'm.js', line: 1, column: 10001, text: 'aaALVOzz', textColumn: 9881, shortened: true }] }));
  assert.match(r, /1:\[col 10001\] …aaALVOzz…/); assert.match(r, /read_file with query/);
});

test('busca: modos files e count, e resultado vazio', () => {
  const fc = { 'src/a.ts': 2, 'src/b.ts': 1 };
  assert.equal(formatSearch({ success: true, mode: 'files', query: 'x', totalFound: 3, scanned: 9, fileCounts: fc }), '2 files with 3 matching lines:\nsrc/a.ts: 2\nsrc/b.ts: 1');
  assert.equal(formatSearch({ success: true, mode: 'count', query: 'x', totalFound: 3, scanned: 9, fileCounts: fc }), '3 matching lines in 2 files (scanned 9).');
  assert.equal(formatSearch({ success: true, query: 'x', totalFound: 0, scanned: 9, matches: [] }), 'No matches for "x" (scanned 9 files).');
  assert.match(formatSearch({ success: false, error: 'Invalid regex: x' }), /"error"/);
});

test('listagem: pastas primeiro, tamanho legível, filtro por glob', () => {
  const e = [{ name: 'b.ts', isDirectory: false, size: 2048 }, { name: 'src', isDirectory: true }, { name: 'a.md', isDirectory: false, size: 10 }];
  assert.equal(formatListing(e), 'src/\nb.ts  2.0 KB\na.md  10 B');
  assert.equal(formatListing(e, '*.md'), 'src/\na.md  10 B');
  assert.equal(formatListing([]), '(empty folder)');
});

test('árvore agrupa por pasta com caminho completo e filtra', () => {
  const files = ['README.md', 'src/main.ts', 'src/ui/button.tsx', 'src/renderer.ts'];
  assert.equal(formatTree(files), '4 files in 3 folders:\n./\n  README.md\nsrc/\n  main.ts\n  renderer.ts\nsrc/ui/\n  button.tsx');
  assert.equal(formatTree(files, { pattern: '*.ts' }), '2 files in 1 folder:\nsrc/\n  main.ts\n  renderer.ts');
  assert.match(formatTree(files, { capped: true }), /capped at 5000/);
});

test('sugestões: mesmo nome em outra pasta, outra extensão, erro de digitação', () => {
  const files = ['src/renderer.ts', 'docs/renderer.md', 'src/main.ts', 'lib/rendrer.ts', 'x/unrelated.ts'];
  assert.deepEqual(suggestPaths('renderer.ts', files), ['src/renderer.ts', 'docs/renderer.md', 'lib/rendrer.ts']);
  assert.deepEqual(suggestPaths('nada.xyz', files), []);
});

test('glob: ** cobre zero pastas', () => {
  assert.ok(globToRegex('src/**/*.js').test('src/app.js'));
  assert.ok(globToRegex('src/**/*.js').test('src/a/b/app.js'));
  assert.ok(!globToRegex('*.js').test('src/app.js'));
});
