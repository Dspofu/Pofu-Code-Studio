// Janelas recuperáveis: o conteúdo não precisa virar um arquivo temporário no projeto.
export function fileWindow(text: string, opts: any = {}) {
  const total = text === '' ? 0 : text.split('\n').length;
  const maxChars = Math.max(2, Math.floor(Number(opts.maxChars) || 40000));
  let from = 0;
  if (opts.char_offset !== undefined) {
    if (!Number.isInteger(opts.char_offset) || opts.char_offset < 0 || opts.char_offset > text.length)
      return { success: false, error: 'char_offset must be an integer inside the file.' };
    from = opts.char_offset;
  } else {
    const line = opts.offset ?? 1;
    if (!Number.isInteger(line) || line < 1 || (total > 0 && line > total))
      return { success: false, error: `offset must be between 1 and ${Math.max(1, total)}.` };
    for (let n = 1; n < line; n++) from = text.indexOf('\n', from) + 1;
  }
  let matchOffset: number | undefined;
  if (opts.query !== undefined) {
    if (typeof opts.query !== 'string' || !opts.query.length) return { success: false, error: 'query must be a non-empty literal string.' };
    matchOffset = text.indexOf(opts.query, from);
    if (matchOffset < 0) return { success: false, error: 'The literal query was not found at or after the requested offset.' };
    const nearby = Math.max(from, matchOffset - Math.min(200, Math.floor(maxChars / 4)));
    const lineStart = matchOffset > 0 ? text.lastIndexOf('\n', matchOffset - 1) + 1 : 0;
    from = Math.max(from, lineStart >= nearby ? lineStart : nearby);
    if (/[\uDC00-\uDFFF]/.test(text[from])) from--;
  }
  const start = text.slice(0, from).split('\n').length;
  let until = text.length;
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1)
      return { success: false, error: 'limit must be a positive integer.' };
    let p = from;
    for (let n = 0; n < opts.limit; n++) {
      p = text.indexOf('\n', p);
      if (p < 0) break;
      p++;
      if (n === opts.limit - 1) until = p;
    }
  }
  let to = Math.min(until, from + maxChars);
  if (to < until) {
    const newline = text.lastIndexOf('\n', to - 1);
    if (newline >= from) to = newline + 1;
    // Não divide pares UTF-16 nem CRLF entre duas janelas.
    else if (/[\uD800-\uDBFF\r]/.test(text[to - 1])) to--;
  }
  const content = text.slice(from, to);
  const hasMore = to < text.length;
  return { success: true, empty: text.length === 0, content, total, start,
    end: start + (content.match(/\n/g)?.length || 0) - (content.endsWith('\n') ? 1 : 0),
    charOffset: from, matchOffset, totalChars: text.length, nextCharOffset: hasMore ? to : null,
    hasMore, complete: from === 0 && !hasMore,
    charClipped: hasMore && !content.endsWith('\n') };
}

export function formatFileWindow(filename: string, res: any) {
  if (!res?.success) return JSON.stringify({ error: res?.error || 'Could not read the file.',
    ...(res?.did_you_mean ? { did_you_mean: res.did_you_mean } : {}) });
  if (res.empty) return `File "${filename}" is empty.`;
  if (res.complete) return res.content;
  const next = res.hasMore ? `\n\n[More content available. Continue with read_file ${JSON.stringify({
    filename, char_offset: res.nextCharOffset
  })}. This cursor includes the rest of a partially read line. Do not create temporary files.]` : '\n[End of file.]';
  return `[File ${JSON.stringify(filename)} — lines ${res.start}–${res.end} of ${res.total}; characters ${res.charOffset}–${res.charOffset + res.content.length} of ${res.totalChars}${res.matchOffset !== undefined ? `; matchOffset=${res.matchOffset}` : ''}]\n${res.content}${next}`;
}

export const readFileTool = {
  type: 'function', function: {
    name: 'read_file',
    description: 'Reads UTF-8 workspace files up to 25 MiB, including files with millions of characters in a single minified line. query searches the ENTIRE file and returns the matching context directly; the context budget does not limit how far query can search. Omit limit to return the whole file when it fits; otherwise follow the exact char_offset. For a known filename, call this directly without a terminal existence/size check. Re-reading an unchanged range returns a short "unchanged" note instead of the content.',
    parameters: { type: 'object', properties: {
      filename: { type: 'string', description: 'Path relative to the workspace (an absolute path inside it also works).' },
      offset: { type: 'integer', description: 'First line, 1-based.' },
      limit: { type: 'integer', description: 'Max lines. Omit to read as much as fits.' },
      query: { type: 'string', description: 'Literal text to jump to; searches the whole file.' },
      char_offset: { type: 'integer', description: 'Cursor from a previous partial read; overrides offset.' },
      full: { type: 'boolean', description: 'Return a large source file whole instead of its structure (costly; e.g. before rewriting it).' }
    }, required: ['filename'] }
  }
};

export const readResultTool = {
  type: 'function', function: {
    name: 'read_tool_result',
    description: 'Pages through a large or compacted tool output kept by the app, without re-running the command or request. Pass the result_id (or "history:<id>") and next_offset; query jumps to a literal.',
    parameters: { type: 'object', properties: {
      result_id: { type: 'string', description: 'ID from the partial or compacted result.' },
      offset: { type: 'integer', description: 'Character cursor (next_offset); default 0.' },
      query: { type: 'string', description: 'Literal term to locate at or after offset.' }
    }, required: ['result_id'] }
  }
};

// Limita a memória por sessão; a expulsão é explícita na próxima consulta ao ID.
const CACHE_CHARS = 8 * 1024 * 1024;
const CACHE_ENTRIES = 32;
export class ToolResultStore {
  private entries = new Map<string, { text: string; scope: string; metadata: Record<string, any> }>();
  private session = globalThis.crypto.randomUUID();
  private sequence = 0;
  private size = 0;
  snapshot(id: string, scope: string) {
    const entry = this.entries.get(id);
    return entry?.scope === scope ? entry.text : undefined;
  }
  restore(id: string, text: string, scope: string) {
    if (this.entries.get(id)?.scope === scope || typeof text !== 'string') return;
    // Busca e listagem guardam TEXTO, não JSON: o que não parseia é restaurado como veio.
    let value: any = text;
    try { value = JSON.parse(text); } catch { /* saída em texto */ }
    this.encode(typeof value === 'string' ? text : value, 1, scope, id);
  }
  // Texto entra como está. Serializar uma string com JSON.stringify escaparia cada aspa e
  // cada quebra de linha, e é esse o formato que o modelo recebe quando o resultado cabe.
  encode(value: any, budget: number, scope: string, restoredId?: string) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length <= budget) return text;
    if (text.length > CACHE_CHARS) return JSON.stringify({ error: 'Tool output exceeds the 8 Mi-character memory limit. Narrow the request.', total_chars: text.length });
    if (restoredId && this.entries.has(restoredId)) {
      this.size -= this.entries.get(restoredId).text.length;
      this.entries.delete(restoredId);
    }
    while (this.size + text.length > CACHE_CHARS || this.entries.size >= CACHE_ENTRIES) {
      const id = this.entries.keys().next().value;
      this.size -= this.entries.get(id).text.length;
      this.entries.delete(id);
    }
    const id = restoredId || `result-${this.session}-${++this.sequence}`;
    const metadata = {};
    for (const key of ['success', 'ok', 'error', 'exitCode', 'pid', 'status', 'finished', 'backgrounded', 'stdoutDropped', 'stderrDropped']) {
      if (value?.[key] !== undefined) {
        const item = value[key];
        metadata[key] = typeof item === 'string' ? item.slice(0, 160) : item;
      }
    }
    this.entries.set(id, { text, scope, metadata }); this.size += text.length;
    return this.read(id, 0, budget, scope);
  }
  read(id: string, offset: number, budget: number, scope: string, query?: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.scope !== scope) return JSON.stringify({ error: 'Result unavailable in this chat (expired, app restarted, or unknown ID). Run the original read-only request again if needed. Never automatically repeat an action with side effects.' });
    if (!Number.isInteger(offset) || offset < 0 || offset > entry.text.length)
      return JSON.stringify({ error: 'offset must be an integer inside the retained result.' });
    if (query) {
      const found = entry.text.indexOf(query, offset);
      if (found < 0) return JSON.stringify({ result_id: id, found: false, total_chars: entry.text.length });
      offset = Math.max(offset, found - 160);
    }
    const serialize = (end: number) => JSON.stringify({ ...entry.metadata, result_id: id, offset, next_offset: end < entry.text.length ? end : null,
      total_chars: entry.text.length, partial: end < entry.text.length || offset > 0,
      content: entry.text.slice(offset, end),
      note: 'Content is a window of the original JSON. Use read_tool_result with result_id and next_offset, or query to jump to a term. The original output is preserved with this tool call in the chat history. No rerun or temporary file is needed.' });
    // Conta também os escapes do JSON: aspas e barras não podem furar o orçamento.
    let low = offset, high = Math.min(entry.text.length, offset + Math.max(2, budget));
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (serialize(mid).length <= Math.max(1024, budget)) low = mid;
      else high = mid - 1;
    }
    let end = low;
    if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1])) end--;
    return serialize(end);
  }
}
