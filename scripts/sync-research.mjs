// Atualização explícita dos módulos portáteis; o app distribuído não depende do saas.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const source = resolve(process.argv[2] || '../Saas');
mkdirSync('src/research', { recursive: true });
const files = ['functions/research', 'functions/searchResults', 'lib/webpage', 'lib/researchReader', 'lib/exaSearch'];
for (const file of files) {
  const text = readFileSync(resolve(source, 'src', file + '.ts'), 'utf8')
    .replace(/from '\.\.\/(?:functions|lib)\/([^']+)\.ts'/g, "from './$1.js'")
    .replace(/from '\.\/([^']+)\.ts'/g, "from './$1.js'")
    .replace('Provedor de pesquisa indisponível', 'Search provider unavailable')
    .replace('Provedor de pesquisa: HTTP', 'Search provider: HTTP');
  writeFileSync('src/research/' + file.split('/').at(-1) + '.ts', '// Adaptado do saas/src/' + file + '.ts; atualizar com scripts/sync-research.mjs.\n' + text);
}
