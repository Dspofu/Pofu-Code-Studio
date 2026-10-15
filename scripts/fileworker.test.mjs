// Teste funcional da pocca de workers (fileworker.ts): exercita o caminho REAL do main
// (despacho -> thread -> resultado) para provar que o refactor preservou o comportamento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileOps } from '../out/fileworker.js';

const ws = mkdtempSync(join(tmpdir(), 'pofu-fileworker-'));
const data = join(ws, 'data');
const user = join(ws, 'user');
mkdirSync(data);
mkdirSync(user);
writeFileSync(join(data, 'a.ts'), 'export function foo() {\n  return 1;\n}\n');
writeFileSync(join(data, 'b.py'), 'def bar():\n    return 2\n');
writeFileSync(join(data, 'big.txt'), 'x'.repeat(1_000_000) + 'ALVO_AQUI' + 'y'.repeat(500_000));

const pool = fileOps(user);

test('read-file devolve janela, mtime e size', async () => {
  const r = await pool.run('read-file', { filePath: join(data, 'a.ts'), opts: {} });
  assert.equal(r.success, true);
  assert.match(r.content, /foo/);
  assert.ok(r.mtimeMs > 0);
  assert.ok(r.size > 0);
});

test('read-file com query localiza o meio de arquivo grande', async () => {
  const r = await pool.run('read-file', { filePath: join(data, 'big.txt'), opts: { query: 'ALVO_AQUI', maxChars: 2000 } });
  assert.match(r.content, /ALVO_AQUI/);
});

test('read-file inexistente devolve did_you_mean', async () => {
  const r = await pool.run('read-file', { filePath: join(data, 'a.tsx'), opts: { workspace: data } });
  assert.equal(r.success, false);
  assert.ok(r.did_you_mean, 'deve sugerir o arquivo certo');
  assert.ok(r.did_you_mean.includes('a.ts'));
});

test('list-files devolve nome, isDirectory e size', async () => {
  const r = await pool.run('list-files', { dirPath: data });
  assert.ok(Array.isArray(r));
  const a = r.find(e => e.name === 'a.ts');
  assert.equal(a.isDirectory, false);
  assert.ok(a.size > 0);
});

test('list-tree varre recursivamente', async () => {
  const r = await pool.run('list-tree', { rootPath: data });
  assert.ok(r.files.includes('a.ts'));
  assert.ok(r.files.includes('b.py'));
});

test('outline devolve definições por arquivo', async () => {
  const r = await pool.run('outline', { target: data, opts: { workspace: data } });
  assert.equal(r.success, true);
  assert.ok(r.files.length >= 2);
  const ts = r.files.find(f => f.file.endsWith('a.ts'));
  assert.ok(ts.defs.some(d => /foo/.test(d.text)), 'deve achar a função foo');
});

test('search-files acha por texto e conta', async () => {
  const r = await pool.run('search-files', { rootPath: data, opts: { query: 'return' } });
  assert.equal(r.success, true);
  assert.ok(r.totalFound >= 2);
  assert.ok(r.matches.length >= 1);
});

test('write-file cria, grava snapshot e diff', async () => {
  const r = await pool.run('write-file', { filePath: join(data, 'novo.txt'), content: 'linha1\nlinha2\n', opts: {} });
  assert.equal(r.success, true);
  assert.equal(r.created, true);
  assert.ok(existsSync(join(data, 'novo.txt')));
  assert.ok(r.snapshotId);
  assert.ok(r.diff.linhas.length > 0);
});

test('write-file recusa sobrescrever sem leitura (requireRead)', async () => {
  const r = await pool.run('write-file', { filePath: join(data, 'a.ts'), content: 'x', opts: { requireRead: true } });
  assert.equal(r.success, false);
  assert.match(r.error, /not been read/i);
});

test('edit-file troca trecho exato e grava', async () => {
  writeFileSync(join(data, 'e.txt'), 'alpha beta gamma\n');
  const r = await pool.run('edit-file', { filePath: join(data, 'e.txt'), oldText: 'beta', newText: 'BETA', replaceAll: false, opts: {} });
  assert.equal(r.success, true);
  assert.equal(readFileSync(join(data, 'e.txt'), 'utf-8'), 'alpha BETA gamma\n');
  assert.ok(r.snapshotId);
});

test('get-diff remonta o diff de um snapshot', async () => {
  const w = await pool.run('write-file', { filePath: join(data, 'd.txt'), content: 'v1\n', opts: {} });
  const r = await pool.run('get-diff', { snapshotId: w.snapshotId });
  assert.ok(Array.isArray(r.linhas));
});

test('undo-change restaura o conteúdo anterior', async () => {
  writeFileSync(join(data, 'u.txt'), 'original\n');
  const w = await pool.run('write-file', { filePath: join(data, 'u.txt'), content: 'modificado\n', opts: { requireRead: false } });
  const snap = w.snapshotId;
  assert.equal(readFileSync(join(data, 'u.txt'), 'utf-8'), 'modificado\n');
  const r = await pool.run('undo-change', { snapshotId: snap });
  assert.equal(r.success, true);
  assert.equal(readFileSync(join(data, 'u.txt'), 'utf-8'), 'original\n');
});

test('undo-change de criação apaga o arquivo (estado anterior)', async () => {
  const w = await pool.run('write-file', { filePath: join(data, 'novo2.txt'), content: 'x\n', opts: {} });
  const r = await pool.run('undo-change', { snapshotId: w.snapshotId });
  assert.equal(r.success, true);
  assert.equal(r.apagado, true);
  assert.ok(!existsSync(join(data, 'novo2.txt')));
});

test('delete-file apaga e salva snapshot', async () => {
  writeFileSync(join(data, 'del.txt'), 'sumir\n');
  const r = await pool.run('delete-file', { filePath: join(data, 'del.txt'), opts: {} });
  assert.equal(r.success, true);
  assert.equal(r.deleted, true);
  assert.ok(!existsSync(join(data, 'del.txt')));
});

test('store-load/store-save ida e volta', async () => {
  const s = await pool.run('store-save', { file: join(user, 'app-store.json'), data: { chats: [1, 2, 3] } });
  assert.equal(s.success, true);
  const l = await pool.run('store-load', { file: join(user, 'app-store.json') });
  assert.deepEqual(l.data, { chats: [1, 2, 3] });
});

test('operações paralelas não se perdem (poca)', async () => {
  for (let i = 0; i < 5; i++) writeFileSync(join(data, `p${i}.txt`), `conteudo ${i}\n`);
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    pool.run('read-file', { filePath: join(data, `p${i}.txt`), opts: {} })));
  rs.forEach((r, i) => assert.match(r.content, new RegExp(`conteudo ${i}`)));
});

test('clean up', () => { pool.dispose(); rmSync(ws, { recursive: true, force: true }); });
