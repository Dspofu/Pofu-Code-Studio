// Copia src/websearch.js para out/ após o tsc.
// O websearch.js NÃO é compilado: é fonte versionada (gerada noutro repositório,
// ver o cabeçalho do arquivo) e o tsc só emite os .ts. Sem esta cópia o
// out/main.js falha no boot com ERR_MODULE_NOT_FOUND: 'out/websearch.js'.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const origem = `${raiz}/src/websearch.js`;
const destino = `${raiz}/out/websearch.js`;

if (!existsSync(origem)) {
  console.error(`copy-websearch: origem não encontrada: ${origem}`);
  process.exit(1);
}
mkdirSync(dirname(destino), { recursive: true });
copyFileSync(origem, destino);
console.log('copy-websearch: out/websearch.js atualizado');
