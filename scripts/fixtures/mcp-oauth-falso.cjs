// Servidor MCP que exige login OAuth + servidor de autorização com registro automático e PKCE, em loopback.
// Usado pelo test:ux para exercitar o botão Entrar com o IPC e o safeStorage reais.
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');

const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function servidorOAuthFalso() {
  const estado = { registros: 0, desafios: new Map(), validos: new Set(), seq: 0 };
  const server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`, u = new URL(req.url, base);
    let corpo = ''; for await (const c of req) corpo += c;
    const json = (dados, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(dados)); };
    if (u.pathname === '/mcp') {
      if (!estado.validos.has(String(req.headers.authorization || '').replace(/^Bearer /, ''))) { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="openid"` }); return res.end('{"error":"Unauthorized"}'); }
      const msg = JSON.parse(corpo);
      if (msg.id == null) { res.statusCode = 202; return res.end(); }
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'oauth-falso' } } });
      if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'gerar_video', description: 'Ferramenta de teste atrás de login.', inputSchema: { type: 'object' } }] } });
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    }
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json({ resource: base + '/mcp', authorization_servers: [base + '/as'] });
    if (u.pathname === '/.well-known/oauth-authorization-server/as') return json({ authorization_endpoint: base + '/as/authorize', token_endpoint: base + '/as/token', registration_endpoint: base + '/as/register', code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/as/register') { estado.registros++; return json({ client_id: 'cliente-' + estado.registros }, 201); }
    if (u.pathname === '/as/authorize') {
      const redirect = new URL(u.searchParams.get('redirect_uri')), code = 'codigo-' + (++estado.seq);
      estado.desafios.set(code, u.searchParams.get('code_challenge'));
      redirect.searchParams.set('code', code); redirect.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: redirect.href }); return res.end();
    }
    if (u.pathname === '/as/token') {
      const p = new URLSearchParams(corpo), desafio = estado.desafios.get(p.get('code'));
      if (!desafio || b64url(createHash('sha256').update(p.get('code_verifier') || '').digest()) !== desafio) return json({ error: 'invalid_grant' }, 400);
      const token = 'acesso-' + (++estado.seq); estado.validos.add(token);
      return json({ access_token: token, refresh_token: 'renova-' + estado.seq, expires_in: 3600 });
    }
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, estado, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

module.exports = { servidorOAuthFalso };
