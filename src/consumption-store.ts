import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { reportPeriod, tokenCounts, finiteCount, type ConsumptionConnection, type ConsumptionPeriod, type TokenCounts } from './consumption.js';

interface Entry extends TokenCounts { identity: string; day: string; model: string }

/** Chave só participa do hash; o registro de consumo nunca guarda credenciais ou mensagens. */
export function consumptionIdentity(connection: ConsumptionConnection) {
  return createHash('sha256').update(JSON.stringify([connection.id, connection.apiUrl.replace(/\/+$/, ''), connection.apiKey || ''])).digest('hex');
}

export class ConsumptionStore {
  private entries: Entry[];
  constructor(private file: string) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      this.entries = Array.isArray(value) ? value.filter(e => typeof e.identity === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.day) && typeof e.model === 'string') : [];
    } catch (err) {
      // Não sobrescreve um registro corrompido silenciosamente.
      if (existsSync(file)) throw new Error('O registro local de consumo não pôde ser lido.');
      this.entries = [];
    }
  }
  record(connection: ConsumptionConnection, usage: unknown, now = new Date()) {
    const tokens = tokenCounts(usage); if (!tokens) return false;
    const identity = consumptionIdentity(connection), day = now.toISOString().slice(0, 10), model = String(connection.model || '').slice(0, 200);
    const next = this.entries.map(e => ({ ...e }));
    let row = next.find(e => e.identity === identity && e.day === day && e.model === model);
    if (!row) { row = { identity, day, model, input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 0 }; next.push(row); }
    for (const key of ['input', 'output', 'cached', 'cacheWrite', 'requests'] as const) row[key] = finiteCount(row[key]) + finiteCount(tokens[key]);
    const cutoff = new Date(now.getTime() - 366 * 86400000).toISOString().slice(0, 10);
    const retained = next.filter(e => e.day >= cutoff);
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(retained), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
    this.entries = retained;
    return true;
  }
  summary(connection: ConsumptionConnection, period: ConsumptionPeriod, now = new Date()) {
    const identity = consumptionIdentity(connection), range = reportPeriod(period, now);
    const entries = this.entries.filter(e => e.identity === identity && e.day >= range.start.slice(0, 10) && e.day <= range.end.slice(0, 10));
    const tokens: TokenCounts = { input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 0 };
    const models = new Map<string, TokenCounts>();
    for (const row of entries) {
      const model = models.get(row.model) || { input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 0 };
      for (const key of ['input', 'output', 'cached', 'cacheWrite', 'requests'] as const) { tokens[key] += finiteCount(row[key]); model[key] += finiteCount(row[key]); }
      models.set(row.model, model);
    }
    return { tokens, period: range, models: [...models].map(([model, counts]) => ({ model, ...counts })),
      message: 'Chamadas do agente registradas por este Studio, para este perfil, endpoint e chave. Não inclui outros aplicativos nem chamadas sem usage. Datas agrupadas em UTC; até 366 dias preservados.' };
  }
}
