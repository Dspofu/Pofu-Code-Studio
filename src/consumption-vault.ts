import type { ProviderConfig } from './providers.js';

interface Cipher { available: () => boolean; encrypt: (text: string) => string; decrypt: (text: string) => string }
export function protectConsumptionKeys<T extends PersistedStore>(store: T, cipher: Cipher): T {
  const out = structuredClone(store);
  for (const provider of out.settings?.providers || []) {
    if (provider.usageAdminKey) {
      if (!cipher.available()) throw new Error('O sistema não oferece armazenamento protegido para a chave administrativa. Deixe o campo vazio para continuar com o consumo local.');
      (provider as ProviderConfig & { usageAdminKeyEncrypted?: string }).usageAdminKeyEncrypted = cipher.encrypt(provider.usageAdminKey);
    }
    delete provider.usageAdminKey;
  }
  return out;
}
export function restoreConsumptionKeys<T extends PersistedStore>(store: T, cipher: Cipher): T {
  for (const provider of store?.settings?.providers || []) {
    const record = provider as ProviderConfig & { usageAdminKeyEncrypted?: string };
    if (record.usageAdminKeyEncrypted) {
      try { provider.usageAdminKey = cipher.decrypt(record.usageAdminKeyEncrypted); }
      catch { provider.usageAdminKey = ''; }
      delete record.usageAdminKeyEncrypted;
    }
  }
  return store;
}
