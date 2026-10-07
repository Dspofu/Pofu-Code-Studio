import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHistory } from '../out/remote-history.js';
test('referências remotas permanecem estáveis e mudam após editar texto', () => {
  const history = new RemoteHistory(), message = { role: 'user', content: 'original' }, chat = { messages: [message] };
  const id = history.reference(message), revision = history.revision(chat);
  assert.equal(history.reference(message), id); assert.equal(history.revision(chat), revision); assert.equal(history.locate(chat, id, revision).index, 0);
  message.content = 'editado'; assert.notEqual(history.reference(message), id); assert.throws(() => history.locate(chat, id, revision), /conversa mudou/);
});
test('mensagem nova, remoção e conversa diferente invalidam ações antigas', () => {
  const history = new RemoteHistory(), message = { role: 'assistant', content: 'resposta' }, chat = { messages: [message] };
  const id = history.reference(message), revision = history.revision(chat);
  chat.messages.push({ role: 'user', content: 'outra' }); assert.throws(() => history.check(chat, revision), /conversa mudou/);
  chat.messages = []; assert.throws(() => history.locate(chat, id, history.revision(chat)), /não encontrada/);
  const other = { messages: [{ ...message }] }; assert.throws(() => history.locate(other, id, history.revision(other)), /não encontrada/);
});
test('resultados de ferramentas não podem ser editados isoladamente', () => {
  const history = new RemoteHistory(), message = { role: 'tool', content: 'resultado' }, chat = { messages: [message] };
  assert.throws(() => history.locate(chat, history.reference(message), history.revision(chat)), /não editável/);
});
test('alterar chamadas de ferramentas invalida a revisão', () => {
  const history = new RemoteHistory(), message = { role: 'assistant', content: '', tool_calls: [] }, chat = { messages: [message] };
  const revision = history.revision(chat); message.tool_calls.push({ id: 'call' }); assert.throws(() => history.check(chat, revision), /conversa mudou/);
});
