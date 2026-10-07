import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingCommands, parseSlash, slashCommands } from '../out/slash-commands.js';

test('comandos e aliases resolvem para a mesma ação', () => {
  for (const command of slashCommands) {
    assert.equal(parseSlash('/' + command.name).command, command);
    for (const alias of command.aliases) assert.equal(parseSlash('/' + alias.toUpperCase()).command, command);
  }
});

test('filtra sugestões sem tratar caminhos e texto comum como comandos', () => {
  assert.equal(matchingCommands('/').length, 13);
  assert.equal(matchingCommands('/rev')[0].name, 'revisar');
  for (const text of ['olhe /config', '/src/app.ts', 'https://example.com', '/file.txt']) assert.equal(parseSlash(text), null);
  assert.equal(matchingCommands('/revisar src').length, 0);
  assert.equal(parseSlash('/inexistente').command, undefined);
});

test('argumentos de pedidos preservam caminhos e múltiplas linhas', () => {
  const parsed = parseSlash('/revisar src/main.ts\nVerifique o tratamento de erros.');
  assert.equal(parsed.command.name, 'revisar');
  assert.equal(parsed.args, 'src/main.ts\nVerifique o tratamento de erros.');
});
