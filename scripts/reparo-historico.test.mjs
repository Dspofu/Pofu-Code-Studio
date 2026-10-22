import test from 'node:test';
import assert from 'node:assert/strict';
import { reparaChamadasSemResposta, RESULTADO_PERDIDO } from '../out/reparo-historico.js';

const chamada = (id, name = 'capture_page') => ({ id, type: 'function', function: { name, arguments: '{}' } });

test('histórico íntegro não muda', () => {
  const chat = { messages: [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: '', tool_calls: [chamada('a')] },
    { role: 'tool', tool_call_id: 'a', name: 'capture_page', content: 'ok' },
    { role: 'assistant', content: 'pronto' }
  ] };
  const antes = JSON.stringify(chat);
  assert.equal(reparaChamadasSemResposta(chat), 0);
  assert.equal(JSON.stringify(chat), antes);
});

test('app fechado no meio: a chamada sem resposta ganha um resultado logo depois das que voltaram', () => {
  const chat = { messages: [
    { role: 'user', content: 'capture' },
    { role: 'assistant', content: '', tool_calls: [chamada('a', 'read_file'), chamada('b')] },
    { role: 'tool', tool_call_id: 'a', name: 'read_file', content: 'conteúdo' }
  ] };
  assert.equal(reparaChamadasSemResposta(chat), 1);
  assert.deepEqual(chat.messages.slice(2).map(m => [m.role, m.tool_call_id, m.name]), [['tool', 'a', 'read_file'], ['tool', 'b', 'capture_page']]);
  assert.equal(chat.messages[3].content, RESULTADO_PERDIDO);
  assert.match(JSON.parse(RESULTADO_PERDIDO).error, /^No result/);
});

test('chamada no fim do histórico, sem nenhum resultado, e órfãs em mais de um ponto', () => {
  const chat = { messages: [
    { role: 'assistant', content: '', tool_calls: [chamada('x')] },
    { role: 'user', content: 'mensagem da fila' },
    { role: 'assistant', content: '', tool_calls: [chamada('y'), chamada('z')] }
  ] };
  assert.equal(reparaChamadasSemResposta(chat), 3);
  assert.deepEqual(chat.messages.map(m => m.role + (m.tool_call_id ? ':' + m.tool_call_id : '')),
    ['assistant', 'tool:x', 'user', 'assistant', 'tool:y', 'tool:z']);
});

test('marcas de poda depois do ponto de inserção andam junto; as de antes ficam', () => {
  const chat = { podaManualAte: 1, podaAutoAte: 4, messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [chamada('k')] },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'user', content: 'd' }
  ] };
  assert.equal(reparaChamadasSemResposta(chat), 1);
  assert.equal(chat.podaManualAte, 1);
  assert.equal(chat.podaAutoAte, 5);
  assert.equal(chat.messages[4].content, 'c', 'a marca continua apontando para a mesma mensagem');
});

test('chamada sem id (malformada) não é pareada', () => {
  const chat = { messages: [{ role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'x', arguments: '{}' } }] }] };
  assert.equal(reparaChamadasSemResposta(chat), 0);
});
