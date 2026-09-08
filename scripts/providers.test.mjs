import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateProviders, activateProvider, rememberProvider, validateProvider } from '../out/providers.js';
import { DEFAULT_SETTINGS, THINK_LEVELS } from '../out/constants.js';

test('migração preserva a conexão antiga e separa as credenciais por provedor', () => {
  const settings = { ...DEFAULT_SETTINGS, apiUrl: 'http://localhost:1234/v1', apiKey: 'fixture-one', model: 'one' };
  migrateProviders(settings);
  assert.equal(settings.providers.length, 1); assert.equal(settings.apiKey, 'fixture-one');
  const first = settings.activeProviderId;
  settings.providers.push({ id: 'two', name: 'Segundo', apiUrl: 'http://localhost:5678/v1', apiKey: 'fixture-two', model: 'two', thinkLevel: 'muito_alto' });
  activateProvider(settings, 'two'); assert.equal(settings.apiKey, 'fixture-two'); assert.equal(settings.thinkLevel, 'muito_alto');
  settings.model = 'two-new'; rememberProvider(settings);
  activateProvider(settings, first); assert.equal(settings.apiKey, 'fixture-one'); assert.equal(settings.model, 'one');
  migrateProviders(settings); activateProvider(settings, 'two'); assert.equal(settings.model, 'two-new');
  assert.deepEqual(THINK_LEVELS[settings.thinkLevel].payload, { reasoning_effort: 'xhigh' });
  assert.equal(THINK_LEVELS.padrao.payload, null);
});

test('provedores rejeitam endpoint inválido e recuperam seleção removida', () => {
  const settings = { ...DEFAULT_SETTINGS }; migrateProviders(settings);
  for (const apiUrl of ['file:///tmp', 'https://user:pass@example.test/v1', 'invalid'])
    assert.throws(() => validateProvider({ ...settings.providers[0], apiUrl }));
  settings.activeProviderId = 'missing'; migrateProviders(settings);
  assert.equal(settings.activeProviderId, settings.providers[0].id);
});
