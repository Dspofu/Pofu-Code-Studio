// Servidor MCP mínimo (stdio) para os testes: lista paginada, ferramenta somente-leitura,
// ferramenta que falha e um log fora do protocolo no stdout, que o cliente deve ignorar.
// Com --mudo, nunca responde (para testar o prazo de inicialização).
import { createInterface } from 'node:readline';

const mudo = process.argv.includes('--mudo');
const ferramentas = [
  { name: 'somar', description: 'Adds two numbers.', annotations: { readOnlyHint: true },
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'anotar', description: 'Stores a note.', inputSchema: { type: 'object', properties: { texto: { type: 'string' } } } },
  { name: 'falhar', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } }
];
const responde = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
process.stdout.write('servidor fake iniciando (log fora do protocolo)\n');
process.stderr.write('stderr: pronto\n');

createInterface({ input: process.stdin }).on('line', (linha) => {
  if (mudo) return;
  const msg = JSON.parse(linha);
  if (msg.method === 'initialize')
    return responde(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });
  if (msg.method === 'tools/list')
    return responde(msg.id, msg.params?.cursor ? { tools: ferramentas.slice(2) } : { tools: ferramentas.slice(0, 2), nextCursor: 'p2' });
  if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params;
    if (name === 'somar') return responde(msg.id, { content: [{ type: 'text', text: String(a.a + a.b) }] });
    if (name === 'anotar') return responde(msg.id, { content: [{ type: 'text', text: `anotado: ${a.texto}` }] });
    return responde(msg.id, { isError: true, content: [{ type: 'text', text: 'falha proposital' }] });
  }
  if (msg.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } }) + '\n');
}).on('close', () => process.exit(0));
