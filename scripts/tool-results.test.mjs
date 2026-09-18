import test from 'node:test';
import assert from 'node:assert/strict';
import { fileWindow, formatFileWindow, ToolResultStore } from '../out/tool-results.js';

test('consulta literal localiza o meio de arquivo grande sem leituras intermediárias', () => {
  const text = 'a'.repeat(100000) + 'TARGET_VALUE=42' + 'z'.repeat(100000);
  const result = fileWindow(text, { query: 'TARGET_VALUE', maxChars: 4000 });
  assert.match(result.content, /TARGET_VALUE=42/);
  assert.equal(result.matchOffset, 100000);
  assert.ok(result.content.length <= 4000);
  assert.equal(fileWindow(text, { query: 'missing' }).success, false);
});

test('resultado preservado pode repopular cache após reiniciar', () => {
  const oldStore = new ToolResultStore();
  const page = JSON.parse(oldStore.encode({ stdout: 'a'.repeat(20000) + 'RECUPERADO' }, 4000, 'chat'));
  const original = oldStore.snapshot(page.result_id, 'chat');
  assert.equal(oldStore.snapshot(page.result_id, 'outro'), undefined);
  const newStore = new ToolResultStore();
  newStore.restore(page.result_id, original, 'chat');
  assert.match(JSON.parse(newStore.read(page.result_id, 0, 4000, 'chat', 'RECUPERADO')).content, /RECUPERADO/);
});

test('leitura completa não tem teto fixo de linhas', () => {
  const text = 'x\n'.repeat(12000);
  const result = fileWindow(text, { maxChars: 30000 });
  assert.equal(result.complete, true);
  assert.equal(result.content, text);
  assert.equal(formatFileWindow('a.txt', result), text);
});

for (const [name, text] of Object.entries({
  minificado: 'a'.repeat(23001),
  unicode: 'ação 🦆\r\n'.repeat(2400),
  misto: 'primeira\n' + '🦆'.repeat(9000) + '\r\núltima\n'
})) test(`continuação recupera cada caractere: ${name}`, () => {
  let cursor = 0, restored = '', calls = 0;
  do {
    const page = fileWindow(text, { char_offset: cursor, maxChars: 1001 });
    assert.equal(page.success, true);
    assert.ok(page.content.length <= 1001);
    assert.ok(page.content.length > 0);
    restored += page.content;
    cursor = page.nextCharOffset;
    if (cursor !== null) assert.match(formatFileWindow('a.txt', page), /char_offset/);
    assert.ok(++calls < 100);
  } while (cursor !== null);
  assert.equal(restored, text);
});

test('linhas específicas, arquivo vazio e argumentos inválidos', () => {
  assert.equal(fileWindow('a\r\nb\r\nc', { offset: 2, limit: 1 }).content, 'b\r\n');
  assert.equal(fileWindow('').empty, true);
  for (const opts of [{ offset: -1 }, { offset: 8 }, { limit: 0 }, { char_offset: 1.5 }, { char_offset: 999 }])
    assert.equal(fileWindow('a\nb', opts).success, false);
});

test('resultados paginados preservam JSON, status, escapes e conteúdo integral', () => {
  const store = new ToolResultStore();
  const value = { success: true, exitCode: 7, stdout: '\\"\n🦆'.repeat(9000), stderr: 'erro importante' };
  let raw = store.encode(value, 4000, 'chat-a');
  let result = JSON.parse(raw), restored = result.content, calls = 0;
  assert.equal(result.exitCode, 7);
  while (result.next_offset !== null) {
    raw = store.read(result.result_id, result.next_offset, 4000, 'chat-a');
    assert.ok(raw.length <= 4000);
    result = JSON.parse(raw); restored += result.content;
    assert.ok(++calls < 200);
  }
  assert.deepEqual(JSON.parse(restored), value);
});

test('consulta literal encontra o meio sem reexecutar a ferramenta', () => {
  const store = new ToolResultStore();
  const first = JSON.parse(store.encode({ body: 'a'.repeat(12000) + 'POFU_OK' + 'z'.repeat(12000) }, 4000, 'a'));
  const found = JSON.parse(store.read(first.result_id, 0, 4000, 'a', 'POFU_OK'));
  assert.match(found.content, /POFU_OK/);
  assert.equal(JSON.parse(store.read(first.result_id, 0, 4000, 'a', 'ausente')).found, false);
  assert.ok(JSON.parse(store.read(first.result_id, 0, 4000, 'outro-chat')).error);
  assert.ok(JSON.parse(store.read(first.result_id, -1, 4000, 'a')).error);
});

test('cache limitado informa expulsão e não repete ações com efeitos colaterais', () => {
  const store = new ToolResultStore();
  const first = JSON.parse(store.encode({ body: 'a'.repeat(5000) }, 2000, 'a'));
  for (let i = 0; i < 33; i++) store.encode({ body: 'b'.repeat(5000) }, 2000, 'a');
  assert.match(JSON.parse(store.read(first.result_id, 0, 2000, 'a')).error, /Never automatically repeat/);
  assert.ok(JSON.parse(store.encode({ body: 'x'.repeat(9 * 1024 * 1024) }, 4000, 'a')).error);
});

test('IDs de sessões diferentes nunca recuperam um resultado novo por engano', () => {
  const first = new ToolResultStore(), second = new ToolResultStore();
  const before = JSON.parse(first.encode({ body: 'a'.repeat(5000) }, 2000, 'chat'));
  const after = JSON.parse(second.encode({ body: 'b'.repeat(5000) }, 2000, 'chat'));
  assert.notEqual(before.result_id, after.result_id);
  assert.ok(JSON.parse(second.read(before.result_id, 0, 2000, 'chat')).error);
});

test('erro enorme não impede avanço do cursor', () => {
  const store = new ToolResultStore();
  const first = JSON.parse(store.encode({ error: 'e'.repeat(20000) }, 1024, 'chat'));
  assert.ok(first.next_offset > 0);
  assert.ok(first.content.length > 0);
});

test('saída em texto é guardada sem JSON por cima e sobrevive à restauração', () => {
  const texto = 'src/a.ts\n10:  const "x" = 1;\n' + 'y'.repeat(5000);
  const store = new ToolResultStore();
  assert.equal(store.encode('curto "sem escape"', 1000, 'chat'), 'curto "sem escape"');
  const page = JSON.parse(store.encode(texto, 1500, 'chat'));
  assert.equal(page.content, texto.slice(0, page.content.length));
  const outro = new ToolResultStore();
  outro.restore(page.result_id, texto, 'chat');
  let cursor = 0, junto = '';
  while (cursor !== null) {
    const p = JSON.parse(outro.read(page.result_id, cursor, 1500, 'chat'));
    junto += p.content; cursor = p.next_offset;
  }
  assert.equal(junto, texto);
});
