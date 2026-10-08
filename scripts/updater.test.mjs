import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baixaInstalador, detectaMetodo, escolheAsset, sha256Esperado } from '../out/updater.js';

const assets = [
  { name: 'pofu-code-studio-1.8.0.x86_64.rpm', url: 'r', size: 1 },
  { name: 'pofu-code-studio_1.8.0_amd64.deb', url: 'd', size: 1 },
  { name: 'Pofu.Code.Studio.Setup.1.8.0.exe.blockmap', url: 'b', size: 1 },
  { name: 'Pofu.Code.Studio.Setup.1.8.0.exe', url: 'e', size: 1 },
];

test('cada formato pega só o próprio instalador e a própria arquitetura', () => {
  assert.equal(escolheAsset(assets, 'deb', 'x64').url, 'd');
  assert.equal(escolheAsset(assets, 'rpm', 'x64').url, 'r');
  assert.equal(escolheAsset(assets, 'nsis', 'x64').url, 'e');
  assert.equal(escolheAsset(assets, 'deb', 'arm64'), undefined);
  assert.equal(escolheAsset(assets, 'deb', 'ia32'), undefined);
});

test('sha256 só vale no formato publicado pelo GitHub', () => {
  const hex = 'a'.repeat(64);
  assert.equal(sha256Esperado('sha256:' + hex.toUpperCase()), hex);
  assert.equal(sha256Esperado(undefined), undefined);
  assert.equal(sha256Esperado('sha512:' + hex), undefined);
  assert.equal(sha256Esperado('sha256:abc'), undefined);
});

test('sem empacotamento não há instalação automática', async () => {
  assert.equal(await detectaMetodo({ isPackaged: false, execPath: process.execPath, productName: 'X' }), null);
  assert.equal(await detectaMetodo({ isPackaged: true, execPath: join(tmpdir(), 'nada', 'x.exe'), productName: 'X', platform: 'win32' }), null);
  assert.equal(await detectaMetodo({ isPackaged: true, execPath: '/x', productName: 'X', platform: 'darwin' }), null);
});

async function servidor(corpo, lento = false) {
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Length': corpo.length });
    if (!lento) return res.end(corpo);
    res.write(corpo.subarray(0, 10)); await new Promise(ok => setTimeout(ok, 2000)); res.end(corpo.subarray(10));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${server.address().port}/arquivo` };
}

test('download confere o sha256, informa progresso e apaga o arquivo que não confere', async () => {
  const corpo = Buffer.alloc(300_000, 7), digest = 'sha256:' + createHash('sha256').update(corpo).digest('hex');
  const { server, url } = await servidor(corpo);
  const dir = mkdtempSync(join(tmpdir(), 'pofu-upd-'));
  try {
    const fases = [];
    const arquivo = await baixaInstalador({ name: 'setup 1.exe', url, size: corpo.length, digest }, dir, new AbortController().signal, p => fases.push(p.fase));
    assert.deepEqual(readFileSync(arquivo), corpo);
    assert.ok(fases.includes('conferindo'));
    await assert.rejects(baixaInstalador({ name: 'ruim.exe', url, size: 1, digest: 'sha256:' + 'b'.repeat(64) }, dir, new AbortController().signal, () => {}), /não confere/);
    assert.equal(existsSync(join(dir, 'ruim.exe')), false);
    await assert.rejects(baixaInstalador({ name: 'sem.exe', url, size: 1 }, dir, new AbortController().signal, () => {}), /sha256/);
  } finally { server.close(); }
});

test('cancelar no meio do download não deixa arquivo pela metade', async () => {
  const corpo = Buffer.alloc(50_000, 1);
  const { server, url } = await servidor(corpo, true);
  const dir = mkdtempSync(join(tmpdir(), 'pofu-upd-'));
  try {
    const controle = new AbortController(); setTimeout(() => controle.abort(), 300);
    await assert.rejects(baixaInstalador({ name: 'x.deb', url, size: corpo.length, digest: 'sha256:' + 'c'.repeat(64) }, dir, controle.signal, () => {}));
    assert.deepEqual(readdirSync(dir), []);
  } finally { server.closeAllConnections(); server.close(); }
});
