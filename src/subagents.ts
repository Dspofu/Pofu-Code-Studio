// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

import { chaveDaChamada, LoopGuard } from './loop-guard.js';

export const SUBAGENT_TOOL_NAMES = new Set([
  'list_files', 'read_file', 'search_files', 'list_definitions',
  'read_tool_result', 'fetch_url', 'web_search'
]);

export const delegateTasksTool = {
  type: 'function', function: {
    name: 'delegate_tasks',
    description: 'Delegates up to 3 independent research or code-inspection tasks to parallel read-only subagents using this provider and workspace. Give each a specific task and needed context. Returns their findings; make changes yourself after reviewing them.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { tasks: {
        type: 'array', minItems: 1, maxItems: 3,
        items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', description: 'Short label for this task.', maxLength: 80 },
          task: { type: 'string', description: 'Complete, self-contained assignment. Include relevant paths or facts.', minLength: 1, maxLength: 12000 }
        }, required: ['task'] }
      } }, required: ['tasks']
    }
  }
};

export interface SubagentTask { name: string; task: string }
export interface SubagentWorker extends SubagentTask {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  turns: number;
  tool_calls: number;
}
export interface SubagentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  retainedResult?: { id: string; text: string };
}
interface SubagentCompletion {
  message?: { content?: string; tool_calls?: ToolCall[] };
  usage?: any;
  aborted?: boolean;
  apiError?: string;
  finishReason?: string;
}
export interface SubagentDependencies {
  tools: any[];
  complete(args: { messages: SubagentMessage[]; tools: any[]; signal: AbortSignal; worker: SubagentWorker }): Promise<SubagentCompletion>;
  execute(args: { name: string; args: Record<string, any>; toolCallId: string; worker: SubagentWorker; messages: SubagentMessage[]; signal: AbortSignal }): Promise<string>;
  onEvent?(worker: SubagentWorker): void;
  onUsage?(usage: any): void;
  onToolResult?(message: SubagentMessage, worker: SubagentWorker): void;
}
export interface SubagentOptions {
  signal?: AbortSignal;
  systemPrompt?: string;
  maxTurns?: number;
  maxContextChars?: number;
}

export function validateSubagentTasks(tasks: unknown): SubagentTask[] {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 3)
    throw new Error('delegate_tasks requires between 1 and 3 tasks.');
  return tasks.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.task !== 'string' || !value.task.trim())
      throw new Error(`tasks[${index}].task must be a non-empty string.`);
    if (value.task.length > 12000) throw new Error(`tasks[${index}].task exceeds 12000 characters. Narrow the assignment.`);
    if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 80))
      throw new Error(`tasks[${index}].name must be a string of at most 80 characters.`);
    return { name: value.name?.trim() || `Agente ${index + 1}`, task: value.task.trim() };
  });
}

function aborted() {
  const error = new Error('Subagent cancelled by the user.');
  error.name = 'AbortError';
  return error;
}
function checkSignal(signal: AbortSignal) { if (signal.aborted) throw aborted(); }

// IPC e adaptadores externos nem sempre observam o signal. Parar não pode esperar por eles.
function interruptible<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const cancel = () => reject(aborted());
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { checkSignal(signal); return start(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}

function errorText(error: any) { return String(error?.message || error || 'Unknown subagent error.'); }

function normalizedCalls(calls: ToolCall[]) {
  return calls.map(call => {
    const rawName = call?.function?.name;
    const name = typeof rawName === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rawName) ? rawName : 'unknown';
    const raw = call?.function?.arguments;
    let args: Record<string, any> = null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw ?? {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch { /* chamada truncada deve receber diagnóstico, nunca chegar ao executor */ }
    return {
      args,
      call: {
        id: `subtool-${globalThis.crypto.randomUUID()}`,
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args || {}) }
      }
    };
  });
}

function payloadMessages(messages: SubagentMessage[], tools: any[], maxChars: number) {
  const copy = messages.map(message => {
    const result: SubagentMessage = { role: message.role };
    if (message.content !== undefined) result.content = message.content;
    if (message.tool_calls) result.tool_calls = structuredClone(message.tool_calls);
    if (message.tool_call_id) result.tool_call_id = message.tool_call_id;
    if (message.name) result.name = message.name;
    return result;
  });
  const weight = () => JSON.stringify(copy).length + JSON.stringify(tools).length;
  if (weight() <= maxChars) return copy;
  const canRecover = tools.some(tool => tool.function.name === 'read_tool_result');
  if (canRecover) {
    for (const message of copy) {
      if (message.role !== 'tool' || !message.tool_call_id) continue;
      const notice = JSON.stringify({ compacted: true, result_id: `history:${message.tool_call_id}`,
        note: 'Old subagent tool output compacted. Use read_tool_result with this result_id to retrieve its original content. Do not repeat the original request just to recover output.' });
      if (typeof message.content !== 'string' || message.content.length <= notice.length) continue;
      message.content = notice;
      if (weight() <= maxChars) return copy;
    }
  }
  throw new Error('Subagent context limit reached. Narrow the task or request smaller file ranges and search results. Original tool outputs were preserved; no JSON was truncated.');
}

export async function runSubagents(tasks: unknown, deps: SubagentDependencies, options: SubagentOptions = {}) {
  const assignments = validateSubagentTasks(tasks);
  if (!deps || typeof deps.complete !== 'function' || typeof deps.execute !== 'function')
    throw new Error('Subagents require completion and tool-execution adapters.');
  const tools = structuredClone((deps.tools || []).filter(tool => tool?.type === 'function' && SUBAGENT_TOOL_NAMES.has(tool.function?.name)));
  const allowed = new Set(tools.map(tool => tool.function.name));
  const maxTurns = Math.min(24, Math.max(1, Math.floor(Number(options.maxTurns) || 12)));
  const maxContextChars = Math.max(1024, Math.floor(Number(options.maxContextChars) || 100000));
  const signal = options.signal || new AbortController().signal;
  const system = `${options.systemPrompt || ''}\n\nYou are a read-only subagent. Complete only the assigned task, use the provided inspection tools, and return concise findings with file paths and evidence. You cannot modify files, run commands, control the computer, or create subagents.`.trim();
  const emit = (worker: SubagentWorker) => { try { deps.onEvent?.({ ...worker }); } catch { /* falha de apresentação não interrompe a tarefa */ } };
  const agents = await Promise.all(assignments.map(async assignment => {
    const worker: SubagentWorker = { ...assignment, id: `subagent-${globalThis.crypto.randomUUID()}`, status: 'running', turns: 0, tool_calls: 0 };
    const messages: SubagentMessage[] = [{ role: 'system', content: system }, { role: 'user', content: assignment.task }];
    const guard = new LoopGuard();
    emit(worker);
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        checkSignal(signal);
        const payload = payloadMessages(messages, tools, maxContextChars);
        worker.turns++;
        emit(worker);
        const result = await interruptible(() => deps.complete({ messages: payload, tools: structuredClone(tools), signal, worker: { ...worker } }), signal);
        checkSignal(signal);
        if (result?.aborted) throw aborted();
        if (result?.apiError) throw new Error(`Subagent API error: ${result.apiError}`);
        if (!result?.message) throw new Error('Subagent received no assistant message.');
        if (result.usage) deps.onUsage?.(result.usage);
        const content = typeof result.message.content === 'string' ? result.message.content : '';
        if (content.trim()) worker.result = content;
        const calls = result.message.tool_calls;
        if (calls != null && !Array.isArray(calls)) throw new Error('Subagent received malformed tool_calls.');
        if (!calls?.length) {
          if (result.finishReason === 'length') throw new Error('Subagent response was cut off by the token limit.');
          if (!content.trim()) throw new Error('Subagent returned no text or tool calls.');
          worker.status = 'completed';
          emit(worker);
          return worker;
        }
        if (calls.length > 12) throw new Error('Subagent requested too many tools in one turn (maximum 12).');
        const normalized = normalizedCalls(calls);
        messages.push({ role: 'assistant', content, tool_calls: normalized.map(item => item.call) });
        for (const item of normalized) {
          checkSignal(signal);
          const name = item.call.function.name;
          let output: string;
          if (!SUBAGENT_TOOL_NAMES.has(name) || !allowed.has(name)) {
            output = JSON.stringify({ error: `Tool ${name} is unavailable to this read-only subagent. Use only the tools provided in this request. Do not create subagents or attempt actions with side effects.` });
          } else if (!item.args) {
            output = JSON.stringify({ error: `Arguments for ${name} must be a complete JSON object. Resend valid JSON.` });
          } else {
            const key = chaveDaChamada(name, item.args);
            if (guard.bloqueia(key)) {
              output = JSON.stringify({ error: `Loop detected: this exact ${name} call already returned the same result twice. It was not run again. Use the previous result or change your approach.` });
            } else {
              try {
                worker.tool_calls++;
                emit(worker);
                output = await interruptible(() => deps.execute({ name, args: item.args, toolCallId: item.call.id, worker: { ...worker }, messages, signal }), signal);
                checkSignal(signal);
                if (typeof output !== 'string') output = JSON.stringify(output ?? { error: 'Tool returned no output.' });
              } catch (error) {
                if (signal.aborted || error?.name === 'AbortError') throw error;
                output = JSON.stringify({ error: `Tool ${name} failed: ${errorText(error)}` });
              }
              guard.registra(key, output, false);
            }
          }
          const toolMessage: SubagentMessage = { role: 'tool', tool_call_id: item.call.id, name, content: output };
          messages.push(toolMessage);
          deps.onToolResult?.(toolMessage, { ...worker });
        }
      }
      throw new Error(`Subagent turn limit reached (${maxTurns}). The task is incomplete; review any partial findings before continuing.`);
    } catch (error) {
      worker.status = signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
      worker.error = errorText(error);
      emit(worker);
      return worker;
    }
  }));
  return { success: agents.every(worker => worker.status === 'completed'), agents };
}
