import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionParts } from '../out/mention-highlight.js';
import { workspacePath } from '../out/workspace-path.js';

test('menções identificam caminhos simples e com espaços, sem alterar o texto', () => {
  const text = 'Confira @src/main.ts e @"docs/meu arquivo.md"\nEmail: nome@site.com';
  const parts = mentionParts(text);
  assert.equal(parts.map(p => p.text).join(''), text);
  assert.deepEqual(parts.filter(p => p.mention).map(p => p.text), ['@src/main.ts', '@"docs/meu arquivo.md"']);
  assert.equal(mentionParts('<img src=x onerror=alert(1)>').some(p => p.mention), false);
});

test('caminhos relativos e absolutos do projeto resolvem para o mesmo arquivo', () => {
  assert.equal(workspacePath('D:\\coding\\app', 'src/file.ts'), 'D:/coding/app/src/file.ts');
  assert.equal(workspacePath('D:\\coding\\app', 'D:\\coding\\app\\src\\file.ts'), 'D:/coding/app/src/file.ts');
  assert.equal(workspacePath('/repo', 'src/../file.ts'), '/repo/file.ts');
  for (const path of ['../other/file', 'D:/elsewhere/file', 'D:/coding/application/file'])
    assert.throws(() => workspacePath('D:/coding/app', path), /outside/);
});
