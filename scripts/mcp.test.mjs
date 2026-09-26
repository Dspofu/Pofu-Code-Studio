import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpServidor, textoDoResultado } from '../out/mcp.js';

const fake = fileURLToPath(new URL('./fixtures/mcp-fake.mjs', import.meta.url));
const matar = (pid) => { try { process.kill(pid); } catch { /* já saiu */ } };

test('stdio: conecta, pagina a lista, chama e separa erro da ferramenta', async () => {
  const s = new McpServidor('fake', { command: process.execPath, args: [fake] }, '1.0.0', matar);
  await s.conectar();
  assert.equal(s.estado, 'ok', s.erro);
  assert.deepEqual(s.ferramentas.map(f => f.name), ['somar', 'anotar', 'falhar']);
  assert.equal(textoDoResultado(await s.chamar('somar', { a: 2, b: 3 })), '5');
  const falha = await s.chamar('falhar', {});
  assert.equal(falha.isError, true); assert.equal(textoDoResultado(falha), 'falha proposital');
  s.fechar();
  await assert.rejects(s.chamar('somar', { a: 1, b: 1 }), /not connected/);
});

test('stdio: comando inexistente e servidor mudo viram erro, sem travar', async () => {
  const inexistente = new McpServidor('x', { command: 'comando-que-nao-existe-pofu' }, '1', matar);
  await inexistente.conectar();
  assert.equal(inexistente.estado, 'erro');
  const mudo = new McpServidor('m', { command: process.execPath, args: [fake, '--mudo'], timeout: 800 }, '1', matar);
  await mudo.conectar();
  assert.equal(mudo.estado, 'erro'); assert.match(mudo.erro, /timed out/);
  const semNada = new McpServidor('v', {}, '1', matar);
  await semNada.conectar();
  assert.match(semNada.erro, /"command".*"url"/);
  const desligado = new McpServidor('d', { command: 'x', disabled: true }, '1', matar);
  await desligado.conectar();
  assert.equal(desligado.estado, 'desligado');
});

test('Streamable HTTP: sessão, resposta JSON e resposta em SSE', async () => {
  const vistos = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      vistos.push({ method: req.method, sessao: req.headers['mcp-session-id'], auth: req.headers.authorization });
      if (req.method !== 'POST') { res.statusCode = 204; return res.end(); }
      const msg = JSON.parse(raw);
      if (msg.id == null) { res.statusCode = 202; return res.end(); }
      if (msg.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'sessao-42'); res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'h' } } }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      const result = msg.method === 'tools/list' ? { tools: [{ name: 'eco', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'eco:' + msg.params.arguments.x }] };
      res.end('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
        'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const s = new McpServidor('h', { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer t' } }, '1', matar);
  await s.conectar();
  assert.equal(s.estado, 'ok', s.erro);
  assert.equal(textoDoResultado(await s.chamar('eco', { x: 'oi' })), 'eco:oi');
  assert.equal(vistos.at(-1).sessao, 'sessao-42'); assert.equal(vistos.at(-1).auth, 'Bearer t');
  s.fechar();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(vistos.at(-1).method, 'DELETE');
  server.close();
});

test('resultado: texto como está, binário descrito, estrutura como JSON', () => {
  assert.equal(textoDoResultado({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'x'.repeat(4096) }] }),
    'a\n[image: image/png, 3 KB — not shown as text]');
  assert.equal(textoDoResultado({ content: [{ type: 'resource', resource: { uri: 'file:///x', text: 'conteúdo' } }, { type: 'resource_link', uri: 'file:///y', name: 'y' }] }),
    'conteúdo\n[resource link: file:///y — y]');
  assert.equal(textoDoResultado({ content: [], structuredContent: { ok: 1 } }), '{"ok":1}');
});
