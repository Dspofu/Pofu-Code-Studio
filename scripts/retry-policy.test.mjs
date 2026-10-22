import test from 'node:test';
import assert from 'node:assert/strict';
import { RetryPolicy, esperaDaTentativa, retryAfterMs } from '../out/retry-policy.js';
import { MAX_REQUEST_RETRIES, RETRY_AFTER_MAX_MS, RETRY_DELAYS_MS } from '../out/constants.js';

test('a espera cresce a cada falha e para no último degrau', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(n => esperaDaTentativa(n)), [2000, 4000, 8000, 15000, 30000, 30000]);
  assert.equal(RETRY_DELAYS_MS.length, MAX_REQUEST_RETRIES - 1, 'um degrau por repetição');
});

test('Retry-After só aumenta a espera, e até o teto', () => {
  assert.equal(esperaDaTentativa(3, 1000), 8000);
  assert.equal(esperaDaTentativa(1, 20000), 20000);
  assert.equal(esperaDaTentativa(1, 3_600_000), RETRY_AFTER_MAX_MS);
});

test('Retry-After em segundos, em data HTTP e no corpo', () => {
  assert.equal(retryAfterMs('7'), 7000);
  assert.equal(retryAfterMs('0'), 0);
  const agora = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 12:00:30 GMT', '', agora), 30000);
  assert.equal(retryAfterMs(null, 'Rate limit reached. Please try again in 1.5s.'), 1500);
  assert.equal(retryAfterMs(null, '{"error":{"retry_after": 3}}'), 3000);
  assert.equal(retryAfterMs(null, 'try again in 250ms'), 250);
  assert.equal(retryAfterMs(null, 'erro qualquer'), 0);
});

test('a política repete até o teto de tentativas', () => {
  const p = new RetryPolicy();
  const esperas = [];
  for (let i = 0; i < 10; i++) {
    const espera = p.proxima(`Stream interrompido ${i}`);
    if (espera === null) break;
    esperas.push(espera);
  }
  assert.deepEqual(esperas, RETRY_DELAYS_MS);
  assert.equal(p.falhasAteAgora, MAX_REQUEST_RETRIES);
});

test('o mesmo erro HTTP três vezes seguidas é determinístico e encerra', () => {
  const p = new RetryPolicy();
  assert.equal(p.proxima('HTTP 500: template error'), 2000);
  assert.equal(p.proxima('HTTP 500: template error'), 4000);
  assert.equal(p.proxima('HTTP 500: template error'), null);
});

test('503 "Loading model" idêntico continua sendo esperado: é o servidor carregando', () => {
  const p = new RetryPolicy();
  for (let i = 0; i < MAX_REQUEST_RETRIES - 1; i++) assert.notEqual(p.proxima('HTTP 503: {"error":{"message":"Loading model"}}'), null);
  assert.equal(p.proxima('HTTP 503: {"error":{"message":"Loading model"}}'), null, 'só o teto de tentativas encerra');
});

test('erros HTTP diferentes entre si continuam sendo repetidos', () => {
  const p = new RetryPolicy();
  assert.notEqual(p.proxima('HTTP 500: parse error at 10'), null);
  assert.notEqual(p.proxima('HTTP 500: parse error at 22'), null);
  assert.notEqual(p.proxima('HTTP 500: parse error at 31'), null);
});

test('queda de conexão sempre com a mesma mensagem não aciona a regra do erro idêntico', () => {
  const p = new RetryPolicy();
  for (let i = 0; i < MAX_REQUEST_RETRIES - 1; i++) assert.notEqual(p.proxima('Failed to fetch'), null);
  assert.equal(p.proxima('Failed to fetch'), null);
});

test('teto por tipo de falha: servidor travado ganha uma repetição só', () => {
  const p = new RetryPolicy();
  assert.equal(p.proxima('Servidor parado: nada chegou', { maxTentativas: 2 }), 2000);
  assert.equal(p.proxima('Servidor parado: nada chegou', { maxTentativas: 2 }), null);
});
