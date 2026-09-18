import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

// O instalador NSIS grava o `description` no atalho do Menu Iniciar. O campo do .lnk guarda
// até MAX_PATH (260): com 412 caracteres o resto invadiu a pasta de trabalho e o caminho do
// ícone, e o atalho aparecia em branco.
test('descrição cabe no atalho do Windows', () => {
  assert.ok(pkg.description.length < 260, `description com ${pkg.description.length} caracteres`);
});

test('ícone do Windows existe e tem os tamanhos do atalho e da barra', () => {
  const ico = readFileSync(new URL('../' + pkg.build.win.icon, import.meta.url));
  assert.equal(ico.readUInt16LE(2), 1);
  const tamanhos = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
  for (const t of [16, 32, 48, 256]) assert.ok(tamanhos.includes(t), `falta ${t}x${t} em ${pkg.build.win.icon}`);
});
