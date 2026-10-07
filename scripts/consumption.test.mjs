import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumptionKind, queryConsumption, tokenCounts, reportPeriod } from '../out/consumption.js';
import { ConsumptionStore } from '../out/consumption-store.js';
import { protectConsumptionKeys, restoreConsumptionKeys } from '../out/consumption-vault.js';
import { migrateProviders, validateProvider } from '../out/providers.js';
import { DEFAULT_SETTINGS } from '../out/constants.js';

const now = new Date('2026-10-06T18:00:00Z');
const connection = { id: 'fixture', apiUrl: 'https://api.openai.com/v1', apiKey: 'fixture-chat', model: 'modelo', usageAdminKey: 'fixture-admin' };
const json = (value, status = 200) => Response.json(value, { status });
const buckets = rows => ({ data: [{ results: rows }], has_more: false });
const pofu = { schema: 'ai-usage/v1', provider: { id: 'pofu', name: 'Pofu Server' }, scope: 'account', balances: [{ unit: 'credits', remaining: 0, used: 1200 }],
  cycle: { used: 1200, limit: 1200, renewsAt: null }, plan: { name: 'Studio' } };

test('identificação por host real, nunca por texto ou prefixo da chave', () => {
  assert.equal(consumptionKind('https://api.openai.com/v1'), 'openai');
  assert.equal(consumptionKind('https://api.anthropic.com/v1'), 'anthropic');
  assert.equal(consumptionKind('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(consumptionKind('https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(consumptionKind('https://ai.pofuserver.com/v1'), 'pofu');
  for (const endpoint of ['https://api.openai.com.evil.test/v1', 'https://evil.test/api.openai.com', 'invalid']) assert.equal(consumptionKind(endpoint), 'compatible');
});
test('tokens OpenAI, Anthropic e DeepSeek preservam cache sem duplicar entrada', () => {
  assert.deepEqual(tokenCounts({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } }), { input: 100, output: 20, cached: 30, cacheWrite: 0, requests: 1 });
  assert.deepEqual(tokenCounts({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }), { input: 140, output: 20, cached: 30, cacheWrite: 10, requests: 1 });
  assert.equal(tokenCounts({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 }).input, 100);
  assert.equal(tokenCounts({}), null); assert.equal(tokenCounts(null), null);
});
test('períodos seguem UTC e incluem hoje em 7/30 dias', () => {
  assert.equal(reportPeriod('month', now).start, '2026-10-01T00:00:00.000Z');
  assert.equal(reportPeriod('7d', now).start, '2026-09-30T00:00:00.000Z');
  assert.equal(reportPeriod('30d', now).start, '2026-09-07T00:00:00.000Z');
});
test('chave comum não dispara consulta administrativa', async () => {
  for (const apiUrl of ['https://api.openai.com/v1', 'https://api.anthropic.com/v1']) {
    const result = await queryConsumption({ ...connection, apiUrl, usageAdminKey: '' }, 'month', () => { throw new Error('não deve consultar'); }, now);
    assert.equal(result.status, 'needs-key'); assert.equal(result.tokens, undefined);
  }
});
test('OpenAI pagina uso e custos, envia só chave administrativa e soma dólares', async () => {
  const calls = [];
  const result = await queryConsumption(connection, 'month', async (raw, init) => {
    const url = new URL(raw); calls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer fixture-admin'); assert.equal(init.redirect, 'error');
    if (url.pathname.endsWith('/costs')) return json(buckets([{ amount: { value: 1.25, currency: 'usd' } }]));
    const page = url.searchParams.get('page');
    return json({ data: [{ results: [{ input_tokens: 100, output_tokens: 20, input_cached_tokens: 10, num_model_requests: 1 }] }], has_more: !page, next_page: page ? null : 'second' });
  }, now);
  assert.equal(result.status, 'ok'); assert.equal(result.partial, false);
  assert.equal(result.tokens.input, 200); assert.equal(result.tokens.requests, 2); assert.equal(result.costs.amount, 1.25);
  assert.equal(result.scope, 'organization'); assert.equal(calls.length, 3);
});
test('Claude agrega caches e converte centavos para USD, sem inventar requisições', async () => {
  const result = await queryConsumption({ ...connection, apiUrl: 'https://api.anthropic.com/v1' }, 'month', async (url, init) => {
    assert.equal(init.headers['x-api-key'], 'fixture-admin');
    return json(buckets(String(url).includes('cost_report') ? [{ amount: '123.78912', currency: 'USD' }]
      : [{ uncached_input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }]));
  }, now);
  assert.equal(result.status, 'ok'); assert.equal(result.tokens.input, 180); assert.equal(result.tokens.cacheWrite, 30);
  assert.equal(result.tokens.requests, null); assert.equal(result.costs.amount, 1.2378912);
});
test('falha de custos preserva tokens com relatório parcial', async () => {
  const result = await queryConsumption(connection, 'month', async url => String(url).includes('/costs') ? json({}, 403) : json(buckets([{ input_tokens: 50, output_tokens: 2 }])), now);
  assert.equal(result.status, 'partial'); assert.equal(result.tokens.input, 50); assert.equal(result.costs, undefined);
});
test('paginação limitada é sinalizada e cursor repetido não causa loop', async () => {
  let calls = 0;
  const result = await queryConsumption(connection, 'month', async url => {
    if (String(url).includes('/costs')) return json(buckets([]));
    calls++; return json({ data: [{ results: [{ input_tokens: 1 }] }], has_more: true, next_page: String(calls) });
  }, now);
  assert.equal(calls, 12); assert.equal(result.partial, true); assert.equal(result.tokens.input, 12);
});
test('Pofu personalizado identifica o contrato, preserva saldo zero e ciclo', async () => {
  const result = await queryConsumption({ ...connection, apiUrl: 'http://localhost:9999/v1' }, 'month', async (url, init) => {
    assert.equal(url, 'http://localhost:9999/v1/usage'); assert.equal(init.headers.Authorization, 'Bearer fixture-chat'); return json(pofu);
  }, now);
  assert.equal(result.provider, 'pofu'); assert.equal(result.status, 'ok'); assert.equal(result.balances[0].remaining, 0);
  assert.equal(result.cycle.limit, 1200); assert.equal(result.tokens, undefined);
});
test('Pofu antigo consulta créditos, outros hosts não recebem sondagens extras', async () => {
  let calls = 0;
  const result = await queryConsumption({ ...connection, apiUrl: 'https://ai.pofuserver.com/v1' }, 'month', async url => {
    calls++; return String(url).endsWith('/usage') ? json({}, 404) : json({ credits: 40, used: 5, email: 'fixture@invalid' });
  }, now);
  assert.equal(calls, 2); assert.equal(result.balances[0].remaining, 40); assert.ok(!JSON.stringify(result).includes('fixture@invalid'));
});
test('OpenRouter usa chave comum e distingue limite da chave de saldo da conta', async () => {
  const result = await queryConsumption({ ...connection, apiUrl: 'https://openrouter.ai/api/v1' }, 'month', async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key'); assert.equal(init.headers.Authorization, 'Bearer fixture-chat');
    return json({ data: { usage: 2, usage_monthly: 1, limit_remaining: null, limit: null } });
  }, now);
  assert.equal(result.scope, 'key'); assert.equal(result.balances[0].remaining, null); assert.equal(result.costs.amount, 1);
});
test('DeepSeek mantém moedas distintas e não inventa consumo histórico', async () => {
  const result = await queryConsumption({ ...connection, apiUrl: 'https://api.deepseek.com/v1' }, 'month', async () => json({ balance_infos: [{ currency: 'CNY', total_balance: '10.50' }, { currency: 'USD', total_balance: '0.00' }] }), now);
  assert.deepEqual(result.balances.map(b => b.remaining), [10.5, 0]); assert.equal(result.balances[0].used, null);
});
test('endpoint desconhecido e HTML de login viram indisponível, não saldo zero', async () => {
  for (const response of [json({}, 404), new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }), json({ balance: 10 })]) {
    const result = await queryConsumption({ ...connection, apiUrl: 'https://unknown.test/v1' }, 'month', async () => response, now);
    assert.equal(result.status, 'unsupported'); assert.equal(result.balances, undefined);
  }
});
test('endpoint de outra origem e host oficial em HTTP não recebem chaves', async () => {
  for (const config of [{ apiUrl: 'https://unknown.test/v1', usageUrl: 'https://other.test/usage' }, { apiUrl: 'http://api.openai.com/v1' }]) {
    const result = await queryConsumption({ ...connection, ...config }, 'month', () => { throw new Error('não deve consultar'); }, now);
    assert.equal(result.status, 'error');
  }
});
test('erros não devolvem mensagens arbitrárias com credenciais', async () => {
  const result = await queryConsumption(connection, 'month', async () => { throw new Error('fixture-admin private account'); }, now);
  assert.equal(result.status, 'error'); assert.ok(!JSON.stringify(result).includes('fixture-admin'));
});
test('registro persiste, separa perfis, endpoints, chaves e modelos sem credenciais', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pofu-consumo-')), 'consumo.json');
  const store = new ConsumptionStore(file);
  store.record(connection, { prompt_tokens: 100, completion_tokens: 20 }, now);
  store.record({ ...connection, model: 'outro' }, { prompt_tokens: 50, completion_tokens: 10 }, now);
  store.record({ ...connection, id: 'other' }, { prompt_tokens: 1000, completion_tokens: 1 }, now);
  store.record({ ...connection, apiKey: 'rotated' }, { prompt_tokens: 2000, completion_tokens: 1 }, now);
  store.record({ ...connection, apiUrl: 'https://other.test/v1' }, { prompt_tokens: 3000, completion_tokens: 1 }, now);
  assert.equal(store.record(connection, {}), false);
  const saved = new ConsumptionStore(file).summary(connection, 'month', now);
  assert.equal(saved.tokens.input, 150); assert.equal(saved.tokens.requests, 2); assert.equal(saved.models.length, 2);
  assert.ok(!readFileSync(file, 'utf8').includes('fixture-chat'));
});
test('registro respeita período e não sobrescreve arquivo corrompido', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pofu-period-')), 'consumo.json'), store = new ConsumptionStore(file);
  store.record(connection, { prompt_tokens: 100, completion_tokens: 1 }, new Date('2026-09-29T00:00:00Z'));
  store.record(connection, { prompt_tokens: 10, completion_tokens: 1 }, now);
  assert.equal(store.summary(connection, '7d', now).tokens.input, 10); assert.equal(store.summary(connection, '30d', now).tokens.input, 110);
  writeFileSync(file, 'broken'); assert.throws(() => new ConsumptionStore(file)); assert.equal(readFileSync(file, 'utf8'), 'broken');
});
test('chave administrativa protegida no disco, migração preserva cada perfil', () => {
  const provider = { ...connection, name: 'Fixture', thinkLevel: 'padrao', usageUrl: '/v1/usage' };
  const cipher = { available: () => true, encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
  const protectedStore = protectConsumptionKeys({ settings: { providers: [provider] } }, cipher);
  assert.ok(!JSON.stringify(protectedStore).includes('fixture-admin')); assert.equal(provider.usageAdminKey, 'fixture-admin');
  const restored = restoreConsumptionKeys(protectedStore, cipher); assert.equal(restored.settings.providers[0].usageAdminKey, 'fixture-admin');
  const settings = { ...DEFAULT_SETTINGS, providers: [provider] }; migrateProviders(settings);
  assert.equal(settings.providers[0].usageAdminKey, 'fixture-admin'); assert.equal(settings.providers[0].usageUrl, '/v1/usage');
  assert.throws(() => protectConsumptionKeys({ settings: { providers: [provider] } }, { ...cipher, available: () => false }));
  assert.throws(() => validateProvider({ ...provider, usageUrl: 'https://evil.test/usage' }));
});
