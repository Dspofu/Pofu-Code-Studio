// Smoke remoto opcional: somente fixtures sintéticas, chave recebida no ambiente.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFileTool, readResultTool, fileWindow, formatFileWindow, ToolResultStore } from '../out/tool-results.js';
import { system_prompt } from '../out/constants.js';
const endpoint = process.env.POFU_TEST_API_URL;
const key = process.env.POFU_TEST_API_KEY;
if (!endpoint || !key) throw new Error('Set POFU_TEST_API_URL and POFU_TEST_API_KEY. This test makes real API requests.');
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const response = await fetch(endpoint.replace(/\/$/, '') + '/models', { headers, signal: AbortSignal.timeout(30000) });
if (!response.ok) {
  const failure = { passed: false, stage: 'models', httpStatus: response.status };
  if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify(failure, null, 2));
  throw new Error(`API unavailable: /models returned HTTP ${response.status}`);
}
const models = await response.json();
const model = process.env.POFU_TEST_MODEL || models.data?.[0]?.id;
assert.ok(model);
const store = new ToolResultStore();
const retained = JSON.parse(store.encode({ stdout: 'a'.repeat(20000) + 'PROVA_CENTRAL=POFU-VERDE-42' + 'z'.repeat(20000), exitCode: 0 }, 3000, 'smoke'));
const basicCases = [
  { name: 'arquivo completo', text: 'inicio=POFU-INICIO\n' + 'x\n'.repeat(6000) + 'fim=POFU-FINAL', budget: 20000,
    prompt: 'Read fixture.txt and report the exact inicio and fim values. Use read_file.', expect: ['POFU-INICIO', 'POFU-FINAL'], maxReads: 1 },
  { name: 'linha longa com continuação', text: 'x'.repeat(6100) + ' FINAL_CODE=POFU-CURSOR-73', budget: 4000,
    prompt: 'Read fixture.txt and report the exact FINAL_CODE at the end. Follow any continuation cursor.', expect: ['POFU-CURSOR-73'], maxReads: 2 },
  { name: 'resultado de comando preservado',
    prompt: `A command already finished. Its output is retained as ${retained.result_id}. Use read_tool_result with query PROVA_CENTRAL to retrieve and report its exact value.`, expect: ['POFU-VERDE-42'], maxReads: 0 }
];
const line = 'const item = 1;\r\n';
const halfSource = line.repeat(Math.ceil(2.5 * 1024 * 1024 / line.length));
const largeCases = [
  { name: 'arquivo de 5 MiB: dois trechos distantes',
    text: halfSource + 'CENTRAL_5M=POFU-MEIO-584\r\n' + halfSource + 'FINAL_5M=POFU-FIM-925', budget: 8000,
    prompt: 'O arquivo fixture.txt tem 5 MiB de código. Encontre os valores exatos de CENTRAL_5M e FINAL_5M e me informe ambos.',
    expect: ['POFU-MEIO-584', 'POFU-FIM-925'], maxReads: 2 },
  { name: 'arquivo de 20 MiB: uma linha minificada',
    text: 'x'.repeat(10 * 1024 * 1024) + ' CENTRAL_20M=POFU-MEIO-317 ' + 'z'.repeat(10 * 1024 * 1024) + ' FINAL_20M=POFU-FIM-862', budget: 8000,
    prompt: 'O arquivo fixture.txt tem 20 MiB em uma única linha. Descubra os valores de CENTRAL_20M e FINAL_20M e me informe ambos.',
    expect: ['POFU-MEIO-317', 'POFU-FIM-862'], maxReads: 2 }
];
const cases = (process.env.POFU_TEST_LARGE_ONLY === '1' ? largeCases : [...basicCases, ...largeCases])
  .filter(fixture => !process.env.POFU_TEST_CASE || fixture.name.includes(process.env.POFU_TEST_CASE));
// Oferece a alternativa para medir a escolha; comandos reais nunca rodam neste smoke.
const terminalTool = { type: 'function', function: { name: 'execute_command',
  description: 'Run a terminal command in the workspace. Returns stdout, stderr and exitCode.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
const listTool = { type: 'function', function: { name: 'list_files',
  description: 'Lists files and folders with size. Use recursive=true to discover project files in one call, without terminal dir/find commands.',
  parameters: { type: 'object', properties: { subpath: { type: 'string' }, recursive: { type: 'boolean' } } } } };
const report = [];
for (const fixture of cases) {
  const messages = [{ role: 'system', content: system_prompt('/fixture', false, false) }, { role: 'user', content: fixture.prompt }];
  const calls = [];
  const requests = [];
  let answer = '';
  for (let turn = 0; turn < 5; turn++) {
    const response = await fetch(endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model, messages, tools: [readFileTool, readResultTool, listTool, terminalTool], temperature: 0, max_tokens: 2048, stream: false })
    });
    if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
    const json = await response.json();
    const msg = json.choices?.[0]?.message;
    assert.ok(msg);
    messages.push(msg);
    if (!msg.tool_calls?.length) { answer = msg.content || ''; break; }
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      calls.push(tc.function.name);
      requests.push({ tool: tc.function.name, query: args.query, char_offset: args.char_offset });
      let content;
      if (tc.function.name === 'read_file') {
        assert.equal(args.filename, 'fixture.txt');
        content = formatFileWindow(args.filename, fileWindow(fixture.text, { ...args, maxChars: fixture.budget }));
      } else if (tc.function.name === 'read_tool_result') {
        content = store.read(args.result_id, args.offset ?? 0, 4000, 'smoke', args.query);
      } else if (tc.function.name === 'list_files') {
        content = JSON.stringify([{ name: 'fixture.txt', isDirectory: false, size: Buffer.byteLength(fixture.text || '') }]);
      } else {
        const failure = { test: fixture.name, passed: false, calls, requests, unexpectedTool: tc.function.name, command: args.command };
        if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify([...report, failure], null, 2));
        console.log(JSON.stringify(failure));
        throw new Error(`Unexpected tool: ${tc.function.name}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
    }
  }
  for (const value of fixture.expect) assert.ok(answer.includes(value), `Missing expected value for ${fixture.name}`);
  const reads = calls.filter(x => x === 'read_file').length;
  assert.ok(reads <= fixture.maxReads, `${reads} reads for ${fixture.name}`);
  const result = { test: fixture.name, model, passed: true, bytes: fixture.text ? Buffer.byteLength(fixture.text) : undefined, calls, requests };
  report.push(result);
  if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(result));
}
