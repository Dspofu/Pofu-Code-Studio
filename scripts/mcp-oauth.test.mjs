// Login OAuth dos servidores MCP remotos (src/mcp-oauth.ts) contra um servidor de autorização e um servidor
// MCP falsos em loopback: descoberta, registro, PKCE, state, troca do código, cofre, renovação e recusas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpOAuth } from '../out/mcp-oauth.js';
import { McpServidor } from '../out/mcp.js';

const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cofre = (disponivel = true) => ({ available: () => disponivel, encrypt: s => 'cifrado:' + Buffer.from(s).toString('base64').split('').reverse().join(''), decrypt: s => Buffer.from(s.slice(8).split('').reverse().join(''), 'base64').toString() });
const matar = () => {};

async function cenario(t, { authServers } = {}) {
  const estado = { registros: [], desafios: new Map(), validos: new Set(), seq: 0, recusar: false, chamadas: [] };
  const server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`, u = new URL(req.url, base);
    let corpo = ''; for await (const c of req) corpo += c;
    const json = (dados, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(dados)); };
    if (u.pathname === '/mcp') {
      const auth = req.headers.authorization || '';
      if (!estado.validos.has(auth.replace(/^Bearer /, ''))) { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="openid offline_access"` }); return res.end('{"error":"Unauthorized"}'); }
      const msg = JSON.parse(corpo); estado.chamadas.push(msg.method);
      if (msg.id == null) { res.statusCode = 202; return res.end(); }
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'falso' } } });
      if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'gerar', inputSchema: { type: 'object' } }] } });
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok:' + auth }] } });
    }
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json({ resource: base + '/mcp', authorization_servers: authServers ? authServers(base) : [base + '/as'], scopes_supported: ['openid', 'offline_access'] });
    if (u.pathname === '/.well-known/oauth-authorization-server/as') return json({ issuer: base + '/as', authorization_endpoint: base + '/as/authorize', token_endpoint: base + '/as/token', registration_endpoint: base + '/as/register', code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/as/register') { const r = JSON.parse(corpo); estado.registros.push(r); return json({ client_id: 'cliente-' + estado.registros.length, redirect_uris: r.redirect_uris }, 201); }
    if (u.pathname === '/as/authorize') {
      const p = u.searchParams, reg = estado.registros.at(-1);
      assert.equal(p.get('response_type'), 'code'); assert.equal(p.get('code_challenge_method'), 'S256'); assert.equal(p.get('resource'), base + '/mcp');
      assert.ok(reg.redirect_uris.includes(p.get('redirect_uri')), 'redirect_uri registrado');
      const redirect = new URL(p.get('redirect_uri'));
      if (estado.recusar) { redirect.searchParams.set('error', 'access_denied'); redirect.searchParams.set('state', p.get('state')); }
      else { const code = 'codigo-' + (++estado.seq); estado.desafios.set(code, { challenge: p.get('code_challenge'), redirect: p.get('redirect_uri') }); redirect.searchParams.set('code', code); redirect.searchParams.set('state', p.get('state')); }
      res.writeHead(302, { Location: redirect.href }); return res.end();
    }
    if (u.pathname === '/as/token') {
      const p = new URLSearchParams(corpo);
      if (p.get('grant_type') === 'authorization_code') {
        const d = estado.desafios.get(p.get('code')); estado.desafios.delete(p.get('code'));
        if (!d || d.redirect !== p.get('redirect_uri') || b64url(createHash('sha256').update(p.get('code_verifier') || '').digest()) !== d.challenge) return json({ error: 'invalid_grant' }, 400);
        const t = 'acesso-' + (++estado.seq); estado.validos.add(t); return json({ access_token: t, refresh_token: 'renova-' + estado.seq, expires_in: 3600, token_type: 'Bearer' });
      }
      if (p.get('grant_type') === 'refresh_token' && /^renova-/.test(p.get('refresh_token'))) { const t = 'acesso-' + (++estado.seq); estado.validos.add(t); return json({ access_token: t, expires_in: 3600, token_type: 'Bearer' }); }
      return json({ error: 'invalid_grant' }, 400);
    }
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`, pasta = mkdtempSync(join(tmpdir(), 'pofu-mcp-oauth-')), arquivo = join(pasta, 'mcp-oauth.json');
  const abertos = [];
  // O "navegador": segue o 302 do servidor de autorização até o callback local, como o usuário clicando em Permitir.
  const navegador = async href => { abertos.push(href); await fetch(href); };
  return { server, url, arquivo, estado, abertos, navegador };
}

test('login completo: 401 vira "precisa entrar", o navegador autoriza com PKCE e o servidor conecta', { timeout: 20000 }, async t => {
  const c = await cenario(t), oauth = new McpOAuth(c.arquivo, cofre(), c.navegador);
  const auth = { cabecalho: () => oauth.cabecalho(c.url), renovar: () => oauth.renovar(c.url) };
  const srv = new McpServidor('falso', { url: c.url }, '1', matar, auth);
  await srv.conectar();
  assert.equal(srv.estado, 'login'); assert.match(srv.erro, /pede login/); assert.equal(c.abertos.length, 0, 'conectar nunca abre o navegador sozinho');
  await oauth.entrar(c.url);
  assert.equal(c.abertos.length, 1); assert.ok(oauth.temLogin(c.url));
  const reg = c.estado.registros[0];
  assert.deepEqual([reg.client_name, reg.token_endpoint_auth_method, reg.grant_types.includes('refresh_token')], ['Pofu Code Studio', 'none', true]);
  assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const gravado = readFileSync(c.arquivo, 'utf8'); assert.doesNotMatch(gravado, /acesso-|renova-/, 'tokens só cifrados no disco');
  await srv.conectar();
  assert.equal(srv.estado, 'ok', srv.erro); assert.deepEqual(srv.ferramentas.map(f => f.name), ['gerar']);
  srv.fechar();
});

test('token revogado é renovado uma vez com o refresh_token, e a chamada segue', { timeout: 20000 }, async t => {
  const c = await cenario(t), oauth = new McpOAuth(c.arquivo, cofre(), c.navegador);
  await oauth.entrar(c.url);
  const srv = new McpServidor('falso', { url: c.url }, '1', matar, { cabecalho: () => oauth.cabecalho(c.url), renovar: () => oauth.renovar(c.url) });
  await srv.conectar(); assert.equal(srv.estado, 'ok');
  c.estado.validos.clear();
  const r = await srv.chamar('gerar', {});
  assert.match(r.content[0].text, /^ok:Bearer acesso-\d+$/); assert.ok(c.estado.validos.has(r.content[0].text.slice(10)));
  srv.fechar();
});

test('segundo login reaproveita o registro e a porta; Sair apaga só os tokens', { timeout: 20000 }, async t => {
  const c = await cenario(t), oauth = new McpOAuth(c.arquivo, cofre(), c.navegador);
  await oauth.entrar(c.url); oauth.sair(c.url);
  assert.equal(oauth.temLogin(c.url), false);
  await oauth.entrar(c.url);
  assert.equal(c.estado.registros.length, 1, 'um registro só');
  assert.equal(new URL(c.abertos[1]).searchParams.get('redirect_uri'), c.estado.registros[0].redirect_uris[0]);
 
});

test('callback com state errado é recusado e não conclui o login', { timeout: 20000 }, async t => {
  const c = await cenario(t);
  let respostaForjada;
  const oauth = new McpOAuth(c.arquivo, cofre(), async href => {
    const redirect = new URL(href).searchParams.get('redirect_uri');
    respostaForjada = await fetch(redirect + '?code=roubado&state=outro');
    await fetch(href);
  });
  await oauth.entrar(c.url);
  assert.equal(respostaForjada.status, 400); assert.ok(oauth.temLogin(c.url));
 
});

test('login recusado no navegador vira erro claro', { timeout: 20000 }, async t => {
  const c = await cenario(t), oauth = new McpOAuth(c.arquivo, cofre(), c.navegador);
  c.estado.recusar = true;
  await assert.rejects(oauth.entrar(c.url), /login foi recusado \(access_denied\)/);
  assert.equal(oauth.temLogin(c.url), false);
 
});

test('servidor de autorização fora de https não é aberto no navegador', { timeout: 20000 }, async t => {
  for (const ruim of ['http://exemplo.invalid/as', 'file:///C:/Windows/System32/calc.exe']) {
    const c = await cenario(t, { authServers: () => [ruim] }), oauth = new McpOAuth(c.arquivo, cofre(), c.navegador);
    await assert.rejects(oauth.entrar(c.url), /precisa ser https/);
    assert.equal(c.abertos.length, 0);
  }
});

test('sem armazenamento seguro o login nem começa', { timeout: 20000 }, async t => {
  const c = await cenario(t), oauth = new McpOAuth(c.arquivo, cofre(false), c.navegador);
  await assert.rejects(oauth.entrar(c.url), /armazenamento seguro/);
  assert.equal(c.abertos.length, 0);
});
