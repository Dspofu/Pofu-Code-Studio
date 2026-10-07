export type ConsumptionKind = 'openai' | 'anthropic' | 'openrouter' | 'deepseek' | 'pofu' | 'compatible';
export type ConsumptionPeriod = 'month' | '7d' | '30d';
export interface ConsumptionConnection {
  id: string; apiUrl: string; apiKey: string; model?: string;
  usageAdminKey?: string; usageUrl?: string;
}
export interface TokenCounts { input: number; output: number; cached: number; cacheWrite: number; requests: number | null }
export interface UsageBalance { unit: string; remaining: number | null; used: number | null; limit?: number | null }
export interface ConsumptionReport {
  provider: ConsumptionKind; label: string; status: 'ok' | 'partial' | 'needs-key' | 'unsupported' | 'error';
  scope: 'account' | 'organization' | 'key' | 'unknown';
  updatedAt: string; message: string;
  tokens?: TokenCounts; balances?: UsageBalance[];
  costs?: { amount: number; currency: string }; costPeriod?: string;
  cycle?: { used: number; limit: number; renewsAt: number | null; grant?: number };
  plan?: string; period?: { start: string; end: string }; partial?: boolean;
}

export function consumptionKind(apiUrl: string): ConsumptionKind {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    if (host === 'api.openai.com') return 'openai';
    if (host === 'api.anthropic.com') return 'anthropic';
    if (host === 'openrouter.ai') return 'openrouter';
    if (host === 'api.deepseek.com') return 'deepseek';
    if (['ai.pofuserver.com', 'origin.pofuserver.com'].includes(host)) return 'pofu';
  } catch {}
  return 'compatible';
}
export const consumptionNames: Record<ConsumptionKind, string> = {
  openai: 'OpenAI', anthropic: 'Claude / Anthropic', openrouter: 'OpenRouter', deepseek: 'DeepSeek', pofu: 'Pofu Server', compatible: 'API compatível / personalizada'
};

export function reportPeriod(period: ConsumptionPeriod, now = new Date()) {
  const start = period === 'month' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (period === '7d' ? 6 : 29)));
  return { start: start.toISOString(), end: now.toISOString() };
}

export function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function amount(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}
export function tokenCounts(usage: any): TokenCounts | null {
  if (!usage || typeof usage !== 'object') return null;
  if (!['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens'].some(k => typeof usage[k] === 'number')) return null;
  const anthropicCache = usage.cache_creation_input_tokens !== undefined || usage.cache_read_input_tokens !== undefined;
  const cacheWrite = finiteCount(usage.cache_creation_input_tokens ?? usage.input_tokens_details?.cache_write_tokens);
  const cached = finiteCount(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens);
  const input = finiteCount(usage.prompt_tokens ?? usage.input_tokens) + (anthropicCache ? cacheWrite + cached : 0);
  return { input, output: finiteCount(usage.completion_tokens ?? usage.output_tokens), cached, cacheWrite, requests: 1 };
}

// O relatório é autenticado na origem escolhida pelo usuário; redirecionamentos não levam chaves a outro servidor.
async function getJson(url: URL, headers: Record<string, string>, signal: AbortSignal, fetcher: typeof fetch): Promise<any> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Endpoint de consumo inválido.');
  const response = await fetcher(url.href, { headers, redirect: 'error', signal, cache: 'no-store' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  if (!/\bjson\b/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw new Error('O endpoint não retornou JSON de consumo.'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Relatório vazio.');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2000000) throw new Error('Relatório maior que o limite de leitura.'); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Relatório de consumo inválido.'); }
}

function compatibleReport(json: any, fallback: ConsumptionReport): ConsumptionReport {
  if (json?.schema !== 'ai-usage/v1' || !Array.isArray(json.balances)) throw new Error('Esta API não fornece o contrato ai-usage/v1.');
  const balances = json.balances.slice(0, 8).map((b: any) => ({ unit: String(b.unit || '').slice(0, 24), remaining: amount(b.remaining), used: amount(b.used), limit: amount(b.limit) }));
  if (!balances.length || balances.some(b => !b.unit || (b.remaining === null && b.used === null))) throw new Error('Relatório sem saldo ou consumo válido.');
  const cycle = json.cycle && amount(json.cycle.used) !== null && amount(json.cycle.limit) !== null
    ? { used: amount(json.cycle.used), limit: amount(json.cycle.limit), renewsAt: amount(json.cycle.renewsAt), grant: amount(json.cycle.grant) } : undefined;
  return { ...fallback, provider: json.provider?.id === 'pofu' ? 'pofu' : 'compatible', label: String(json.provider?.name || fallback.label).slice(0, 100), status: 'ok',
    scope: json.scope === 'key' ? 'key' : 'account', balances, cycle, plan: json.plan?.name ? String(json.plan.name).slice(0, 100) : undefined,
    message: 'Saldo e consumo informados pela API. Créditos são uma unidade própria, separada dos tokens registrados pelo Studio.' };
}

async function pagedRows(url: URL, headers: Record<string, string>, signal: AbortSignal, fetcher: typeof fetch) {
  const rows: any[] = [], seen = new Set<string>(); let partial = false;
  for (let page = 0; page < 12; page++) {
    const json = await getJson(url, headers, signal, fetcher);
    if (!Array.isArray(json.data)) throw new Error('Relatório sem lista de dados.');
    for (const bucket of json.data) {
      if (!Array.isArray(bucket.results)) throw new Error('Relatório sem resultados válidos.');
      rows.push(...bucket.results);
    }
    if (!json.has_more) return { rows, partial: false };
    if (typeof json.next_page !== 'string' || seen.has(json.next_page)) throw new Error('Paginação de consumo inválida.');
    seen.add(json.next_page); url.searchParams.set('page', json.next_page); partial = true;
  }
  return { rows, partial: true };
}

export async function queryConsumption(connection: ConsumptionConnection, period: ConsumptionPeriod = 'month', fetcher: typeof fetch = fetch, now = new Date()): Promise<ConsumptionReport> {
  const kind = consumptionKind(connection.apiUrl);
  const base: ConsumptionReport = { provider: kind, label: consumptionNames[kind], status: 'error', scope: 'unknown', updatedAt: now.toISOString(), message: '' };
  const range = reportPeriod(period, now), signal = AbortSignal.timeout(20000);
  try {
    const endpoint = new URL(connection.apiUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Endpoint inválido.');
    if (['openai', 'anthropic', 'openrouter', 'deepseek'].includes(kind) && (endpoint.protocol !== 'https:' || endpoint.port)) throw new Error('O endpoint de consumo exige o host HTTPS oficial.');
    // Relatórios administrativos só são chamados em hosts oficiais reconhecidos.
    if (kind === 'openai' || kind === 'anthropic') {
      if (endpoint.protocol !== 'https:' || endpoint.port) throw new Error('Relatório administrativo exige o endpoint HTTPS oficial.');
      if (!connection.usageAdminKey?.trim()) return { ...base, status: 'needs-key', scope: 'organization', message: 'Este provedor exige uma chave administrativa de consumo. A chave comum continua servindo para as chamadas; os tokens locais aparecem abaixo.' };
      const anthropic = kind === 'anthropic';
      const headers = anthropic ? { 'x-api-key': connection.usageAdminKey, 'anthropic-version': '2023-06-01', 'User-Agent': 'PofuCodeStudio/1 (https://github.com/Dspofu/Pofu-Code-Studio)' }
        : { Authorization: `Bearer ${connection.usageAdminKey}` };
      const usageUrl = new URL(anthropic ? '/v1/organizations/usage_report/messages' : '/v1/organization/usage/completions', endpoint.origin);
      const costUrl = new URL(anthropic ? '/v1/organizations/cost_report' : '/v1/organization/costs', endpoint.origin);
      for (const url of [usageUrl, costUrl]) {
        url.searchParams.set(anthropic ? 'starting_at' : 'start_time', anthropic ? range.start : String(Date.parse(range.start) / 1000));
        url.searchParams.set(anthropic ? 'ending_at' : 'end_time', anthropic ? range.end : String(Math.floor(Date.parse(range.end) / 1000)));
        url.searchParams.set('bucket_width', '1d'); url.searchParams.set('limit', '31');
      }
      const [usageResult, costsResult] = await Promise.allSettled([pagedRows(usageUrl, headers, signal, fetcher), pagedRows(costUrl, headers, signal, fetcher)]);
      const tokens: TokenCounts = { input: 0, output: 0, cached: 0, cacheWrite: 0, requests: anthropic ? null : 0 };
      if (usageResult.status === 'fulfilled') for (const row of usageResult.value.rows) {
        tokens.input += finiteCount(anthropic ? row.uncached_input_tokens : row.input_tokens);
        tokens.output += finiteCount(row.output_tokens);
        tokens.cached += finiteCount(anthropic ? row.cache_read_input_tokens : row.input_cached_tokens);
        const writes = anthropic ? finiteCount(row.cache_creation?.ephemeral_5m_input_tokens) + finiteCount(row.cache_creation?.ephemeral_1h_input_tokens) : finiteCount(row.input_cache_write_tokens);
        tokens.cacheWrite += writes;
        if (anthropic) tokens.input += finiteCount(row.cache_read_input_tokens) + writes;
        else tokens.requests += finiteCount(row.num_model_requests);
      }
      let cost = 0;
      if (costsResult.status === 'fulfilled') for (const row of costsResult.value.rows) {
        const raw = anthropic ? row.amount : row.amount?.value;
        if (amount(raw) === null || (row.currency && row.currency.toUpperCase() !== 'USD') || (!anthropic && row.amount?.currency?.toUpperCase() !== 'USD')) throw new Error('Unidade monetária do relatório não reconhecida.');
        cost += amount(raw) / (anthropic ? 100 : 1);
      }
      if (usageResult.status === 'rejected' && costsResult.status === 'rejected') throw usageResult.reason;
      const partial = usageResult.status === 'rejected' || costsResult.status === 'rejected'
        || (usageResult.status === 'fulfilled' && usageResult.value.partial) || (costsResult.status === 'fulfilled' && costsResult.value.partial);
      return { ...base, status: partial ? 'partial' : 'ok', scope: 'organization', period: range, partial,
        tokens: usageResult.status === 'fulfilled' ? tokens : undefined, costs: costsResult.status === 'fulfilled' ? { amount: cost, currency: 'USD' } : undefined,
        message: `Relatório da organização inteira, incluindo uso fora do Studio.${partial ? ' Parte do relatório não pôde ser consultada; os totais podem estar incompletos.' : ''}` };
    }
    const headers = connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {};
    if (kind === 'openrouter') {
      const json = await getJson(new URL('/api/v1/key', endpoint.origin), headers, signal, fetcher);
      const data = json.data; if (amount(data?.usage) === null) throw new Error('Relatório da chave inválido.');
      const current = period === 'month' ? amount(data.usage_monthly) : null;
      return { ...base, status: 'ok', scope: 'key', balances: [{ unit: 'USD', remaining: amount(data.limit_remaining), used: amount(data.usage), limit: amount(data.limit) }],
        costs: current === null ? undefined : { amount: current, currency: 'USD' }, costPeriod: current === null ? undefined : 'Mês atual (relatório do provedor)',
        message: 'Consumo da chave. O valor restante é o limite disponível da chave, quando definido; não é o saldo total da conta. Períodos de 7/30 dias estão disponíveis apenas no registro local.' };
    }
    if (kind === 'deepseek') {
      const json = await getJson(new URL('/user/balance', endpoint.origin), headers, signal, fetcher);
      const balances = (Array.isArray(json.balance_infos) ? json.balance_infos : []).filter((b: any) => ['USD', 'CNY'].includes(b.currency) && amount(b.total_balance) !== null)
        .map((b: any) => ({ unit: b.currency, remaining: amount(b.total_balance), used: null }));
      if (!balances.length) throw new Error('Relatório de saldo inválido.');
      return { ...base, status: 'ok', scope: 'account', balances, message: 'Saldo disponível informado pelo DeepSeek. O histórico de tokens abaixo é o registrado neste Studio.' };
    }
    const url = new URL(endpoint.href.replace(/\/+$/, '') + '/usage');
    if (url.origin !== endpoint.origin) throw new Error('O endpoint de consumo deve ter a mesma origem da API.');
    try { return compatibleReport(await getJson(url, headers, signal, fetcher), base); }
    catch (err) {
      if (kind === 'pofu' && String(err.message) === 'HTTP 404') {
        const old = await getJson(new URL(endpoint.href.replace(/\/+$/, '') + '/credits'), headers, signal, fetcher);
        if (amount(old.credits) === null || amount(old.used) === null) throw new Error('Relatório de créditos inválido.');
        return { ...base, status: 'ok', scope: 'account', balances: [{ unit: 'credits', remaining: amount(old.credits), used: amount(old.used) }], message: 'Saldo da conta Pofu, compartilhado pelo site e pelas chaves. Servidor antigo: dados do ciclo ainda indisponíveis.' };
      }
      throw err;
    }
  } catch (err) {
    // Não repassa corpo, URL, credenciais nem mensagem arbitrária de terceiros à interface/logs.
    const error = String(err?.message || '');
    const unsupported = /HTTP 404|não fornece o contrato|não retornou JSON/.test(error);
    const unauthorized = /HTTP 401|HTTP 403/.test(error);
    const message = unauthorized ? 'A credencial não permite consultar o consumo deste provedor.'
      : unsupported ? 'Esta API não disponibiliza um relatório de consumo compatível. O registro local continua disponível.'
      : /mesma origem|endpoint HTTPS oficial|Endpoint.*inválido|endpoint de consumo/i.test(error) ? error
      : /HTTP 429/.test(error) ? 'O provedor limitou as consultas. Tente novamente mais tarde.' : 'Não foi possível consultar o consumo. Verifique a conexão e tente novamente.';
    return { ...base, status: unsupported ? 'unsupported' : 'error', message };
  }
}
