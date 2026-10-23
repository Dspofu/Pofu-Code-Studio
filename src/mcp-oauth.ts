// SPDX-License-Identifier: Apache-2.0
// Login OAuth dos servidores MCP remotos (especificação de autorização do MCP): o servidor responde 401
// com `resource_metadata`, o Studio descobre o servidor de autorização, registra-se nele, abre o navegador
// com PKCE e recebe o código numa porta local. Os tokens ficam cifrados (safeStorage) por servidor.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface Cofre { available(): boolean; encrypt(s: string): string; decrypt(s: string): string }
type Registro = { authServer: string; clientId: string; port: number; authorizationEndpoint: string; tokenEndpoint: string; scope: string };
type Tokens = { accessToken: string; refreshToken?: string; expiresAt: number };
type Entrada = { registro?: Registro; tokens?: string };

const LOGIN_MS = 5 * 60_000;
const loopback = (u: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
// O endereço vem do servidor remoto e vai para o navegador (shell.openExternal) e para fetch: só https,
// ou http em loopback para os testes. Um servidor malicioso não pode mandar abrir file:// ou um app.
function seguro(raw: unknown, oQue: string): URL {
  let u: URL; try { u = new URL(String(raw)); } catch { throw new Error(`MCP OAuth: ${oQue} inválido.`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback(u))) throw new Error(`MCP OAuth: ${oQue} precisa ser https (${u.protocol}).`);
  return u;
}
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function json(url: string | URL, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const texto = await r.text();
  let dados: any = null; try { dados = JSON.parse(texto); } catch { /* corpo não-JSON vira erro abaixo */ }
  if (!r.ok || !dados) throw new Error(`MCP OAuth: ${new URL(String(url)).host} respondeu HTTP ${r.status}${dados?.error ? ' (' + dados.error + (dados.error_description ? ': ' + dados.error_description : '') + ')' : ''}.`);
  return dados;
}
function desafio(cabecalho: string) {
  return { metadata: /resource_metadata="([^"]+)"/i.exec(cabecalho)?.[1] || '', scope: /scope="([^"]*)"/i.exec(cabecalho)?.[1] || '' };
}

export class McpOAuth {
  private emAndamento = new Map<string, Promise<void>>();
  constructor(private arquivo: string, private cofre: Cofre, private abrirNavegador: (url: string) => unknown) {}

  private ler(): Record<string, Entrada> { try { return existsSync(this.arquivo) ? JSON.parse(readFileSync(this.arquivo, 'utf8')) : {}; } catch { return {}; } }
  private gravar(todos: Record<string, Entrada>) { const tmp = this.arquivo + '.tmp'; writeFileSync(tmp, JSON.stringify(todos, null, 1), { mode: 0o600 }); renameSync(tmp, this.arquivo); }
  private tokens(recurso: string): Tokens | null {
    const e = this.ler()[recurso]; if (!e?.tokens || !this.cofre.available()) return null;
    try { return JSON.parse(this.cofre.decrypt(e.tokens)); } catch { return null; }
  }
  private salvar(recurso: string, mudanca: { registro?: Registro; tokens?: Tokens | null }) {
    if (!this.cofre.available()) throw new Error('MCP OAuth: o sistema não oferece armazenamento seguro para guardar o login.');
    const todos = this.ler(), atual = todos[recurso] || {};
    if (mudanca.registro) atual.registro = mudanca.registro;
    if (mudanca.tokens === null) delete atual.tokens; else if (mudanca.tokens) atual.tokens = this.cofre.encrypt(JSON.stringify(mudanca.tokens));
    todos[recurso] = atual; this.gravar(todos);
  }

  temLogin(recurso: string) { return !!this.tokens(recurso); }
  sair(recurso: string) { const todos = this.ler(); if (todos[recurso]) { delete todos[recurso].tokens; this.gravar(todos); } }

  /** Cabeçalho Authorization do servidor, renovando antes se o token vence em menos de um minuto. */
  async cabecalho(recurso: string): Promise<string | null> {
    let t = this.tokens(recurso);
    if (t && t.expiresAt && t.expiresAt - Date.now() < 60_000) t = (await this.renovar(recurso)) ? this.tokens(recurso) : null;
    return t ? 'Bearer ' + t.accessToken : null;
  }

  async renovar(recurso: string): Promise<boolean> {
    const e = this.ler()[recurso], t = this.tokens(recurso);
    if (!e?.registro || !t?.refreshToken) return false;
    try {
      const r = await json(seguro(e.registro.tokenEndpoint, 'endpoint de token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: e.registro.clientId, resource: recurso }) });
      this.salvar(recurso, { tokens: this.paraTokens(r, t.refreshToken) });
      return true;
    } catch { this.salvar(recurso, { tokens: null }); return false; }
  }

  private paraTokens(r: any, refreshAnterior?: string): Tokens {
    if (typeof r?.access_token !== 'string' || !r.access_token) throw new Error('MCP OAuth: o servidor não devolveu access_token.');
    const segundos = Number(r.expires_in);
    return { accessToken: r.access_token, refreshToken: typeof r.refresh_token === 'string' ? r.refresh_token : refreshAnterior, expiresAt: Number.isFinite(segundos) && segundos > 0 ? Date.now() + segundos * 1000 : 0 };
  }

  /** Login completo pelo navegador. Um por servidor de cada vez: um segundo clique espera o primeiro. */
  entrar(recurso: string): Promise<void> {
    const atual = this.emAndamento.get(recurso); if (atual) return atual;
    const p = this.fluxo(recurso).finally(() => this.emAndamento.delete(recurso));
    this.emAndamento.set(recurso, p); return p;
  }

  private async descobrir(recurso: string) {
    const url = seguro(recurso, 'endereço do servidor MCP');
    const sonda = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pofu-code-studio', version: '0' } } }) });
    await sonda.text().catch(() => '');
    const d = desafio(sonda.headers.get('www-authenticate') || '');
    const metadataUrl = d.metadata ? seguro(d.metadata, 'metadata do recurso') : new URL(`/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`, url);
    const recursoMeta = await json(metadataUrl);
    const authServer = seguro(recursoMeta.authorization_servers?.[0], 'servidor de autorização');
    let as: any = null;
    for (const caminho of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      try { as = await json(new URL(caminho + (authServer.pathname === '/' ? '' : authServer.pathname), authServer)); break; } catch { /* tenta o próximo */ }
    }
    if (!as) throw new Error(`MCP OAuth: ${authServer.host} não publica os metadados de autorização.`);
    if (!as.registration_endpoint) throw new Error(`MCP OAuth: ${authServer.host} não permite registro automático de aplicativo. Use "headers" com uma chave de API, se o serviço oferecer.`);
    if (Array.isArray(as.code_challenge_methods_supported) && !as.code_challenge_methods_supported.includes('S256')) throw new Error('MCP OAuth: o servidor de autorização não aceita PKCE S256.');
    const scope = d.scope || (Array.isArray(recursoMeta.scopes_supported) ? recursoMeta.scopes_supported.join(' ') : '');
    return { authServer: authServer.href, as, scope };
  }

  private escutar(porta: number): Promise<Server> {
    return new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(porta, '127.0.0.1', () => resolve(s)); });
  }

  private async fluxo(recurso: string) {
    if (!this.cofre.available()) throw new Error('MCP OAuth: o sistema não oferece armazenamento seguro para guardar o login.');
    const { authServer, as, scope } = await this.descobrir(recurso);
    let registro = this.ler()[recurso]?.registro, servidor: Server | null = null;
    // O redirect registrado é exato: reaproveita a porta do registro; ocupada, registra de novo noutra.
    if (registro?.authServer === authServer) servidor = await this.escutar(registro.port).catch(() => null);
    if (!servidor) {
      servidor = await this.escutar(0);
      const port = (servidor.address() as { port: number }).port;
      const reg = await json(seguro(as.registration_endpoint, 'endpoint de registro'), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_name: 'Pofu Code Studio', redirect_uris: [`http://127.0.0.1:${port}/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }) })
        .catch(e => { servidor.close(); throw e; });
      if (typeof reg?.client_id !== 'string') { servidor.close(); throw new Error('MCP OAuth: o registro não devolveu client_id.'); }
      registro = { authServer, clientId: reg.client_id, port, authorizationEndpoint: seguro(as.authorization_endpoint, 'endpoint de autorização').href, tokenEndpoint: seguro(as.token_endpoint, 'endpoint de token').href, scope };
      this.salvar(recurso, { registro });
    }
    const redirectUri = `http://127.0.0.1:${registro.port}/callback`, verifier = b64url(randomBytes(48)), state = b64url(randomBytes(24));
    const autorizar = new URL(registro.authorizationEndpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: registro.clientId, redirect_uri: redirectUri, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: recurso, ...(registro.scope ? { scope: registro.scope } : {}) })) autorizar.searchParams.set(k, v);
    const codigo = await new Promise<string>((resolve, reject) => {
      const prazo = setTimeout(() => reject(new Error('MCP OAuth: o login não foi concluído em 5 minutos.')), LOGIN_MS);
      servidor.on('request', (req, res) => {
        const u = new URL(req.url || '/', redirectUri);
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const pagina = (titulo: string, texto: string) => `<!doctype html><meta charset="utf-8"><title>${titulo}</title><body style="font-family:system-ui;background:#141713;color:#eef2e9;display:grid;place-items:center;height:100vh;margin:0"><div><h1 style="font-size:20px">${titulo}</h1><p>${texto}</p></div>`;
        if (u.searchParams.get('state') !== state) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(pagina('Login não confirmado', 'A resposta não corresponde ao pedido do Pofu Code Studio. Tente entrar de novo pelo app.')); return; }
        clearTimeout(prazo);
        const erro = u.searchParams.get('error'), code = u.searchParams.get('code');
        res.writeHead(erro || !code ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' }).end(erro || !code ? pagina('Login cancelado', 'Volte ao Pofu Code Studio para tentar de novo.') : pagina('Login concluído', 'Pode fechar esta aba e voltar ao Pofu Code Studio.'));
        if (erro || !code) reject(new Error(`MCP OAuth: o login foi recusado (${erro || 'sem código'}).`)); else resolve(code);
      });
      Promise.resolve(this.abrirNavegador(autorizar.href)).catch(e => { clearTimeout(prazo); reject(e); });
    }).finally(() => { servidor.close(); servidor.closeAllConnections(); });
    const r = await json(registro.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: codigo, redirect_uri: redirectUri, client_id: registro.clientId, code_verifier: verifier, resource: recurso }) });
    this.salvar(recurso, { tokens: this.paraTokens(r) });
  }
}

export const pedeLoginOAuth = (wwwAuthenticate: string | null) => /resource_metadata=/i.test(wwwAuthenticate || '');
