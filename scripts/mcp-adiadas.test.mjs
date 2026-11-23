import test from 'node:test';
import assert from 'node:assert/strict';
import { descricaoDoCarregador, desembrulhaArgs, resolveCarga, respostaDaCarga, MAX_CARGA_POR_CONSULTA } from '../out/mcp-adiadas.js';

const f = (server, tool, description) => ({ nome: `mcp__${server}__${tool}`, server, tool, description });
const adiadas = [
  f('higgsfield', 'balance', 'Returns the credit balance of the account. Free.'),
  f('higgsfield', 'generate_3d', 'Generates a 3D model from text. Spends credits.'),
  f('higgsfield', 'scene_builder_3d_create_project', 'Creates a hosted 3D Jutsu project.'),
  f('higgsfield', 'get_preset_instructions', 'Loads the instructions of a preset.'),
  f('blender', 'render', 'Renders the active scene.')
];

test('índice escreve o prefixo uma vez por servidor', () => {
  const d = descricaoDoCarregador(adiadas);
  assert.match(d, /higgsfield \(full name = mcp__higgsfield__<name>\): balance, generate_3d, scene_builder_3d_create_project, get_preset_instructions/);
  assert.match(d, /blender \(full name = mcp__blender__<name>\): render/);
  assert.equal((d.match(/mcp__higgsfield__/g) || []).length, 1);
});

test('carrega por nome completo, curto e sem diferenciar maiúsculas', () => {
  const r = resolveCarga({ names: ['mcp__higgsfield__balance', 'GENERATE_3D'] }, adiadas);
  assert.deepEqual(r.carregar.map(x => x.tool), ['balance', 'generate_3d']);
  assert.deepEqual(r.naoAchadas, []);
});

test('nome inexistente vira busca por palavra-chave', () => {
  const r = resolveCarga({ names: ['create_3d_project'] }, adiadas);
  assert.deepEqual(r.naoAchadas, ['create_3d_project']);
  assert.equal(r.carregar[0].tool, 'scene_builder_3d_create_project');
});

test('consulta pontua nome acima da descrição e respeita o teto', () => {
  const r = resolveCarga({ query: 'credit balance' }, adiadas);
  assert.equal(r.carregar[0].tool, 'balance');
  const muitas = Array.from({ length: 30 }, (_, i) => f('s', `render_${i}`, 'Renders things.'));
  assert.equal(resolveCarga({ query: 'render' }, muitas).carregar.length, MAX_CARGA_POR_CONSULTA);
});

test('names como string separada por vírgula também vale', () => {
  assert.deepEqual(resolveCarga({ names: 'balance, render' }, adiadas).carregar.map(x => x.tool), ['balance', 'render']);
});

test('resposta lista o carregado e o erro diz o que fazer', () => {
  const ok = respostaDaCarga([adiadas[0]], [], new Set(['mcp__higgsfield__balance']));
  assert.match(ok, /^Loaded 1 MCP tool/);
  assert.match(ok, /- mcp__higgsfield__balance \(already loaded\): Returns the credit balance of the account\./);
  const erro = JSON.parse(respostaDaCarga([], ['xyz'], new Set()));
  assert.match(erro.error, /xyz/);
  assert.ok(erro.hint);
});

test('argumentos embrulhados num campo fora do schema são desembrulhados', () => {
  const schema = { type: 'object', properties: { preset: { type: 'string' } } };
  assert.deepEqual(desembrulhaArgs({ prompt: { preset: '/3d-jutsu' } }, schema), { args: { preset: '/3d-jutsu' }, campo: 'prompt' });
  // Campo que o schema tem, objeto com chave estranha, ou mais de uma chave: fica como veio.
  const comObjeto = { type: 'object', properties: { options: { type: 'object' }, preset: {} } };
  assert.equal(desembrulhaArgs({ options: { preset: 'x' } }, comObjeto).campo, null);
  assert.equal(desembrulhaArgs({ prompt: { outro: 1 } }, schema).campo, null);
  assert.equal(desembrulhaArgs({ prompt: { preset: 'x' }, preset: 'y' }, schema).campo, null);
  assert.equal(desembrulhaArgs({ prompt: { preset: 'x' } }, { type: 'object' }).campo, null);
});
