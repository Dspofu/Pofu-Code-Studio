// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

import test from 'node:test';
import assert from 'node:assert/strict';
import { delegateTasksTool, runSubagents, SUBAGENT_TOOL_NAMES, validateSubagentTasks } from '../out/subagents.js';

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const call = (name, args = {}) => ({ id: 'model-id', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const answer = content => ({ message: { content }, finishReason: 'stop' });
const invoke = (...calls) => ({ message: { content: '', tool_calls: calls }, finishReason: 'tool_calls' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const tasks = [{ name: 'Busca', task: 'Inspecione os arquivos.' }];
const noop = async () => 'resultado';

test('schema oferece tarefas isoladas e valida quantidade, conteúdo e nomes', () => {
  assert.equal(delegateTasksTool.function.name, 'delegate_tasks');
  assert.deepEqual(validateSubagentTasks([{ task: '  Leia src/a.ts  ' }]), [{ name: 'Agente 1', task: 'Leia src/a.ts' }]);
  assert.deepEqual(validateSubagentTasks([{ name: '  Testes  ', task: 'Leia testes.' }]), [{ name: 'Testes', task: 'Leia testes.' }]);
  for (const invalid of [null, {}, [], Array.from({ length: 4 }, () => ({ task: 'x' })), ['x'], [{ task: ' ' }], [{ task: 1 }], [{ task: 'x', name: 2 }], [{ task: 'x'.repeat(12001) }], [{ task: 'x', name: 'x'.repeat(81) }]])
    assert.throws(() => validateSubagentTasks(invalid));
  assert.equal(SUBAGENT_TOOL_NAMES.has('read_file'), true);
  assert.equal(SUBAGENT_TOOL_NAMES.has('execute_command'), false);
});

test('três subagentes geram em paralelo e devolvem somente resumo', { timeout: 2000 }, async () => {
  let active = 0, peak = 0;
  let release;
  const barrier = new Promise(resolve => release = resolve);
  const result = await runSubagents(Array.from({ length: 3 }, (_, i) => ({ name: `A${i}`, task: `Tarefa ${i}` })), {
    tools: [], execute: noop,
    complete: async ({ worker, messages }) => {
      active++; peak = Math.max(peak, active);
      if (active === 3) release();
      await barrier;
      active--;
      assert.equal(messages[1].content, worker.task);
      return answer(worker.name);
    }
  });
  assert.equal(peak, 3);
  assert.equal(result.success, true);
  assert.equal(new Set(result.agents.map(agent => agent.id)).size, 3);
  assert.deepEqual(result.agents.map(agent => agent.result), ['A0', 'A1', 'A2']);
  assert.ok(result.agents.every(agent => agent.turns === 1 && agent.tool_calls === 0));
  assert.ok(result.agents.every(agent => !('messages' in agent) && !('history' in agent)));
});

test('histórico e IDs de ferramentas não vazam entre os trabalhadores', async () => {
  const seen = new Map();
  const result = await runSubagents([{ task: 'alpha' }, { task: 'beta' }], {
    tools: [tool('read_file')],
    complete: async ({ worker, messages }) => {
      assert.ok(!messages.some(message => message.content === (worker.task === 'alpha' ? 'beta' : 'alpha')));
      if (worker.turns === 1) return invoke(call('read_file', { filename: worker.task + '.txt' }));
      assert.equal(messages.at(-1).content, `conteúdo ${worker.task}`);
      assert.equal(messages.at(-2).tool_calls[0].id, messages.at(-1).tool_call_id);
      return answer(`resumo ${worker.task}`);
    },
    execute: async ({ worker, args, toolCallId, messages }) => {
      assert.equal(args.filename, worker.task + '.txt');
      assert.equal(messages.length, 3);
      assert.equal(messages.at(-1).tool_calls[0].id, toolCallId);
      seen.set(worker.id, toolCallId);
      return `conteúdo ${worker.task}`;
    }
  });
  assert.equal(result.success, true);
  assert.equal(new Set(seen.values()).size, 2);
  assert.deepEqual(result.agents.map(agent => agent.tool_calls), [1, 1]);
});

test('executor recusa ações mutáveis, MCP, visão, perguntas e delegação recursiva mesmo se forem fornecidas', async () => {
  const forbidden = ['execute_command', 'write_file', 'edit_file', 'delete_file', 'capture_screen', 'computer_action', 'capture_page', 'view_image', 'ask_user', 'delegate_tasks', 'mcp__api__edit'];
  let executions = 0;
  const result = await runSubagents(tasks, {
    tools: [...forbidden.map(tool), tool('read_file')],
    complete: async ({ worker, tools, messages }) => {
      assert.deepEqual(tools.map(value => value.function.name), ['read_file']);
      if (worker.turns === 1) return invoke(...forbidden.map(name => call(name)));
      assert.equal(messages.filter(message => message.role === 'tool').length, forbidden.length);
      for (const message of messages.filter(value => value.role === 'tool'))
        assert.match(JSON.parse(message.content).error, /unavailable.*read-only/);
      return answer('Sem ações indevidas.');
    },
    execute: async () => { executions++; return ''; }
  });
  assert.equal(result.success, true);
  assert.equal(executions, 0);
});

test('ferramenta de leitura não anunciada e busca web desabilitada também são recusadas', async () => {
  let executions = 0;
  await runSubagents(tasks, {
    tools: [tool('read_file')], execute: async () => { executions++; return ''; },
    complete: async ({ worker, messages }) => {
      if (worker.turns === 1) return invoke(call('web_search', { query: 'x' }), call('fetch_url', { url: 'https://example.test' }));
      assert.ok(messages.filter(message => message.role === 'tool').every(message => JSON.parse(message.content).error.includes('unavailable')));
      return answer('Recurso indisponível.');
    }
  });
  assert.equal(executions, 0);
});

test('argumentos inválidos são normalizados no histórico e nunca chegam ao executor', async () => {
  const invalid = ['{', '[]', 'null', '1', '"texto"'];
  let executions = 0;
  await runSubagents(tasks, {
    tools: [tool('read_file')], execute: async () => { executions++; return ''; },
    complete: async ({ worker, messages }) => {
      if (worker.turns === 1) return invoke(...invalid.map(argumentsText => ({ function: { name: 'read_file', arguments: argumentsText } })));
      const assistant = messages.findLast(message => message.role === 'assistant');
      assert.ok(assistant.tool_calls.every(value => value.function.arguments === '{}'));
      assert.ok(messages.filter(message => message.role === 'tool').every(value => /complete JSON object/.test(JSON.parse(value.content).error)));
      return answer('Argumentos corrigidos no histórico.');
    }
  });
  assert.equal(executions, 0);
});

test('trava impede a terceira chamada com o mesmo resultado e preserva IDs de leitura', async () => {
  let executions = 0;
  const result = await runSubagents(tasks, {
    tools: [tool('read_file')], execute: async () => { executions++; return 'mesmo'; },
    complete: async ({ worker, messages }) => {
      if (worker.turns <= 3) return invoke(call('read_file', { filename: 'a.ts' }));
      assert.match(JSON.parse(messages.at(-1).content).error, /Loop detected/);
      return answer('Revisão concluída.');
    }
  });
  assert.equal(executions, 2);
  assert.equal(result.agents[0].tool_calls, 2);
  assert.equal(result.success, true);
});

test('falha de ferramenta volta ao modelo sem derrubar o trabalhador', async () => {
  const result = await runSubagents(tasks, {
    tools: [tool('read_file')], execute: async () => { throw new Error('arquivo ausente'); },
    complete: async ({ worker, messages }) => {
      if (worker.turns === 1) return invoke(call('read_file', { filename: 'ausente.ts' }));
      assert.match(JSON.parse(messages.at(-1).content).error, /Tool read_file failed: arquivo ausente/);
      return answer('Arquivo ausente.');
    }
  });
  assert.equal(result.success, true);
});

test('falha de um subagente preserva os resultados dos outros e achados parciais', async () => {
  const result = await runSubagents([{ task: 'boa' }, { task: 'ruim' }], {
    tools: [tool('read_file')], execute: noop,
    complete: async ({ worker }) => {
      if (worker.task === 'boa') return answer('Análise completa.');
      if (worker.turns === 1) return { ...invoke(call('read_file')), message: { content: 'Achei um candidato.', tool_calls: [call('read_file')] } };
      throw new Error('Servidor falhou.');
    }
  });
  assert.equal(result.success, false);
  assert.equal(result.agents[0].status, 'completed');
  assert.equal(result.agents[1].status, 'failed');
  assert.equal(result.agents[1].result, 'Achei um candidato.');
  assert.match(result.agents[1].error, /Servidor falhou/);
});

test('cancelamento não aguarda uma geração que ignora AbortSignal', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let started = 0, usage = 0, release;
  const stuck = new Promise(resolve => release = resolve);
  const running = runSubagents([{ task: 'a' }, { task: 'b' }, { task: 'c' }], {
    tools: [], execute: noop, onUsage: () => usage++,
    complete: async () => { started++; return stuck; }
  }, { signal: controller.signal });
  await tick();
  assert.equal(started, 3);
  controller.abort();
  const result = await running;
  assert.ok(result.agents.every(worker => worker.status === 'cancelled'));
  assert.equal(result.success, false);
  release({ ...answer('resposta atrasada'), usage: { total_tokens: 10 } });
  await tick();
  assert.equal(usage, 0);
  assert.ok(result.agents.every(worker => !worker.result));
});

test('cancelamento não aguarda IPC e não executa ferramentas seguintes', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let executions = 0, release;
  const stuck = new Promise(resolve => release = resolve);
  const running = runSubagents(tasks, {
    tools: [tool('read_file')], complete: async () => invoke(call('read_file', { filename: 'a' }), call('read_file', { filename: 'b' })),
    execute: async () => { executions++; return stuck; }
  }, { signal: controller.signal });
  await tick();
  assert.equal(executions, 1);
  controller.abort();
  const result = await running;
  assert.equal(result.agents[0].status, 'cancelled');
  release('saída atrasada');
  await tick();
  assert.equal(executions, 1);
});

test('signal já abortado impede qualquer chamada externa', async () => {
  const controller = new AbortController(); controller.abort();
  let complete = 0;
  const result = await runSubagents(tasks, { tools: [], execute: noop, complete: async () => { complete++; return answer('x'); } }, { signal: controller.signal });
  assert.equal(complete, 0);
  assert.equal(result.agents[0].status, 'cancelled');
  assert.equal(result.agents[0].turns, 0);
});

test('ausência de mensagem, resposta vazia, erro da API e corte não são sucesso', async () => {
  for (const response of [{}, { message: { content: ' ' } }, { apiError: 'offline' }, { ...answer('parcial'), finishReason: 'length' }]) {
    const result = await runSubagents(tasks, { tools: [], execute: noop, complete: async () => response });
    assert.equal(result.success, false);
    assert.equal(result.agents[0].status, 'failed');
    assert.ok(result.agents[0].error);
  }
});

test('limite de turnos encerra ciclos com resultado parcial e não depende da trava geral do app', async () => {
  const result = await runSubagents(tasks, {
    tools: [tool('read_file')], execute: noop,
    complete: async ({ worker }) => ({ message: { content: `achado ${worker.turns}`, tool_calls: [call('read_file', { filename: String(worker.turns) })] } })
  }, { maxTurns: 2 });
  assert.equal(result.success, false);
  assert.equal(result.agents[0].turns, 2);
  assert.equal(result.agents[0].tool_calls, 2);
  assert.equal(result.agents[0].result, 'achado 2');
  assert.match(result.agents[0].error, /turn limit reached \(2\)/);
});

test('resposta com ferramentas demais ou lista malformada não dispara o executor', async () => {
  for (const toolCalls of [Array.from({ length: 13 }, () => call('read_file')), {}]) {
    let executions = 0;
    const result = await runSubagents(tasks, { tools: [tool('read_file')], execute: async () => { executions++; return ''; }, complete: async () => ({ message: { tool_calls: toolCalls } }) });
    assert.equal(result.agents[0].status, 'failed');
    assert.equal(executions, 0);
  }
});

test('compactação é explícita, preserva JSON integral e recupera pelo histórico do trabalhador', async () => {
  const output = JSON.stringify({ success: true, value: 'texto completo '.repeat(1000), quotes: '"\\\n' });
  let recovered = false;
  const result = await runSubagents(tasks, {
    tools: [tool('read_file'), tool('read_tool_result')],
    complete: async ({ worker, messages }) => {
      if (worker.turns === 1) return invoke(call('read_file', { filename: 'a.json' }));
      if (worker.turns === 2) {
        const notice = JSON.parse(messages.at(-1).content);
        assert.equal(notice.compacted, true);
        assert.match(notice.note, /read_tool_result/);
        return invoke(call('read_tool_result', { result_id: notice.result_id }));
      }
      return answer('Conteúdo integral preservado.');
    },
    execute: async ({ name, args, messages }) => {
      if (name === 'read_file') return output;
      const original = messages.find(message => message.role === 'tool' && `history:${message.tool_call_id}` === args.result_id);
      assert.equal(original.content, output);
      assert.equal(JSON.parse(original.content).value, 'texto completo '.repeat(1000));
      recovered = true;
      return '{"success":true,"content":"janela recuperada"}';
    }
  }, { maxContextChars: 2200 });
  assert.equal(result.success, true);
  assert.equal(recovered, true);
});

test('contexto irredutível falha claramente sem cortar a tarefa ou JSON', async () => {
  let completions = 0;
  const result = await runSubagents([{ task: 'tarefa '.repeat(1000) }], {
    tools: [], execute: noop, complete: async () => { completions++; return answer('x'); }
  }, { maxContextChars: 1024 });
  assert.equal(result.agents[0].status, 'failed');
  assert.match(result.agents[0].error, /context limit reached/);
  assert.equal(completions, 0);
});

test('eventos recebem cópias, falhas visuais não quebram tarefas e consumo é informado', async () => {
  const events = [], usage = [];
  const result = await runSubagents(tasks, {
    tools: [], execute: noop,
    complete: async () => ({ ...answer('Tudo certo.'), usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    onEvent: worker => { events.push({ ...worker }); worker.name = 'alteração externa'; throw new Error('UI ausente'); },
    onUsage: value => usage.push(value)
  }, { systemPrompt: 'Instruções do projeto.' });
  assert.equal(result.success, true);
  assert.equal(result.agents[0].name, 'Busca');
  assert.equal(events.at(-1).status, 'completed');
  assert.deepEqual(usage, [{ prompt_tokens: 100, completion_tokens: 20 }]);
});

test('resumo longo é devolvido inteiro para o adapter decidir a paginação', async () => {
  const content = 'resultado '.repeat(20000);
  const result = await runSubagents(tasks, { tools: [], execute: noop, complete: async () => answer(content) });
  assert.equal(result.agents[0].result, content);
});

test('hook retém saídas integrais no histórico local sem enviá-las ao modelo', async () => {
  let retained = false;
  const result = await runSubagents(tasks, {
    tools: [tool('read_file'), tool('read_tool_result')],
    onToolResult: (message, worker) => {
      assert.equal(worker.name, 'Busca');
      message.retainedResult = { id: 'result-teste', text: 'conteúdo integral secreto' };
      retained = true;
    },
    complete: async ({ worker, messages }) => {
      if (worker.turns === 1) return invoke(call('read_file', { filename: 'a.ts' }));
      assert.ok(messages.every(message => !('retainedResult' in message)));
      assert.ok(!JSON.stringify(messages).includes('conteúdo integral secreto'));
      if (worker.turns === 2) return invoke(call('read_tool_result', { result_id: 'result-teste' }));
      return answer('Recuperação concluída.');
    },
    execute: async ({ name, messages }) => {
      if (name === 'read_file') return '{"result_id":"result-teste","content":"janela"}';
      assert.equal(messages.find(message => message.role === 'tool').retainedResult.text, 'conteúdo integral secreto');
      return 'recuperado';
    }
  }, { maxTurns: 3 });
  assert.equal(retained, true);
  assert.equal(result.success, true);
  assert.equal(result.agents[0].tool_calls, 2);
});

test('limite interno de 24 turnos não pode ser desabilitado pelas opções', async () => {
  const result = await runSubagents(tasks, {
    tools: [tool('read_file')], execute: noop,
    complete: async ({ worker }) => invoke(call('read_file', { filename: String(worker.turns) }))
  }, { maxTurns: 1000 });
  assert.equal(result.agents[0].turns, 24);
  assert.match(result.agents[0].error, /turn limit reached \(24\)/);
});
