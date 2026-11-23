// Servidor MCP mínimo (stdio) para os testes: lista paginada, ferramenta somente-leitura,
// ferramenta que falha, ferramenta que devolve imagem e um log fora do protocolo no stdout,
// que o cliente deve ignorar.
// Com --mudo, nunca responde (para testar o prazo de inicialização).
// Com --muitas, imita um servidor grande (o Higgsfield tem 184 ferramentas): 180 ferramentas
// de schema farto, para o app carregar sob demanda, e uma só que responde (check_balance).
import { createInterface } from 'node:readline';

const mudo = process.argv.includes('--mudo');
const muitas = process.argv.includes('--muitas');
const areas = ['image', 'video', 'audio', 'scene', 'layer', 'clip', 'mask', 'camera', 'light', 'material', 'track', 'effect'];
const verbos = ['create', 'list', 'delete', 'update', 'export', 'render', 'duplicate', 'inspect', 'animate', 'apply', 'move', 'rename', 'trim', 'split', 'merge'];
const grandes = areas.flatMap(a => verbos.map(v => ({ name: `${v}_${a}`,
  description: `${v[0].toUpperCase() + v.slice(1)} a ${a} in the hosted studio project. ` + 'Accepts the project id, the target and many optional settings. '.repeat(6),
  inputSchema: { type: 'object', properties: Object.fromEntries(['project_id', 'target', 'name', 'width', 'height', 'duration', 'seed', 'quality', 'format', 'preset']
    .map(p => [p, { type: 'string', description: `The ${p.replace('_', ' ')} for this ${a} operation; see the studio documentation for accepted values.` }])), required: ['project_id'] } })));
grandes.splice(40, 0, { name: 'check_balance', description: 'Returns the remaining credit balance of the account. Free, spends nothing.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } });
const ferramentas = muitas ? grandes : [
  { name: 'somar', description: 'Adds two numbers.', annotations: { readOnlyHint: true },
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'anotar', description: 'Stores a note.', inputSchema: { type: 'object', properties: { texto: { type: 'string' } } } },
  { name: 'falhar', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'print', description: 'Returns a screenshot.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { quebrada: { type: 'boolean' } } } }
];
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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
  if (muitas && msg.method === 'tools/call')
    return responde(msg.id, msg.params.name === 'check_balance' ? { content: [{ type: 'text', text: 'Credits: 77 | Plan: free' }] } : { content: [{ type: 'text', text: 'ok' }] });
  if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params;
    if (name === 'somar') return responde(msg.id, { content: [{ type: 'text', text: String(a.a + a.b) }] });
    if (name === 'anotar') return responde(msg.id, { content: [{ type: 'text', text: `anotado: ${a.texto}` }] });
    if (name === 'print') return responde(msg.id, { content: [{ type: 'text', text: 'tela' }, { type: 'image', mimeType: 'image/png', data: a?.quebrada ? 'bm9wZQ==' : PNG_1X1 }] });
    return responde(msg.id, { isError: true, content: [{ type: 'text', text: 'falha proposital' }] });
  }
  if (msg.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } }) + '\n');
}).on('close', () => process.exit(0));
