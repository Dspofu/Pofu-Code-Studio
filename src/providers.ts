export interface ProviderConfig {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  thinkLevel: ThinkLevel;
}

export function validateProvider(provider: ProviderConfig) {
  if (!provider.name.trim()) throw new Error('Dê um nome ao provedor.');
  let url: URL;
  try { url = new URL(provider.apiUrl); } catch { throw new Error('Informe um endpoint HTTP ou HTTPS válido.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Use um endpoint HTTP ou HTTPS sem credenciais na URL.');
}

export function rememberProvider(settings: Settings) {
  const provider = settings.providers?.find(p => p.id === settings.activeProviderId);
  if (provider) Object.assign(provider, {
    apiUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model, thinkLevel: settings.thinkLevel
  });
}

export function activateProvider(settings: Settings, id: string) {
  const provider = settings.providers?.find(p => p.id === id);
  if (!provider) throw new Error('Provedor não encontrado.');
  settings.activeProviderId = id;
  Object.assign(settings, { apiUrl: provider.apiUrl, apiKey: provider.apiKey, model: provider.model,
    thinkLevel: provider.thinkLevel, noThink: provider.thinkLevel === 'desligado' });
}

export function migrateProviders(settings: Settings) {
  const seen = new Set<string>();
  settings.providers = (Array.isArray(settings.providers) ? settings.providers : [])
    .filter(p => p && typeof p.id === 'string' && !seen.has(p.id) && seen.add(p.id))
    .map(p => ({ id: p.id, name: String(p.name || 'Provedor'), apiUrl: String(p.apiUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(p.apiKey || ''), model: String(p.model || ''),
      thinkLevel: ['padrao', 'desligado', 'baixo', 'medio', 'alto', 'muito_alto', 'maximo'].includes(p.thinkLevel) ? p.thinkLevel : 'padrao' }));
  if (!settings.providers.length) settings.providers.push({ id: 'provider-initial', name: 'Meu provedor',
    apiUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model, thinkLevel: settings.thinkLevel });
  activateProvider(settings, settings.providers.some(p => p.id === settings.activeProviderId)
    ? settings.activeProviderId : settings.providers[0].id);
}
