// Cliente MCP (Model Context Protocol). A configuração segue o formato que quase todo
// servidor publicado já traz no README — o mesmo JSON do Claude Desktop, Cursor, Cline e
// Claude Code — para o usuário poder colar sem traduzir:
//   { "mcpServers": { "nome": { "command": "npx", "args": ["-y", "pacote"], "env": {…} },
//                     "remoto": { "url": "https://…/mcp", "headers": { "Authorization": "…" } } } }
// Dois transportes: stdio (processo local, JSON-RPC por linha) e Streamable HTTP. O SSE
// antigo, separado em dois endpoints, foi descontinuado pela especificação e fica de fora.
import { spawn, type ChildProcess } from 'child_process';

export type McpConfig = {
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
  url?: string; headers?: Record<string, string>;
  disabled?: boolean; timeout?: number;
};
export type McpFerramenta = { name: string; description?: string; inputSchema?: any; annotations?: any };

const PROTOCOLO = '2025-06-18';
// npx/uvx baixam o pacote na primeira vez: a inicialização pode levar bem mais que uma chamada.
const INICIO_MS = 90000;
const CHAMADA_MS = 120000;

interface Transporte {
  request(method: string, params: any, timeoutMs: number): Promise<any>;
  notify(method: string, params?: any): void;
  fechar(): void;
  diagnostico(): string;
}

// No Windows, npx/npm/uvx são .cmd, que o Node só executa com shell desde a correção do
// CVE-2024-27980; e passar args em array junto com shell:true é depreciado. Então a linha
// de comando é montada aqui, com aspas só onde o cmd.exe precisa.
function linhaWindows(cmd: string, args: string[]) {
  const q = (s: string) => /^[\w.:\\/@=+-]+$/.test(s) ? s : '"' + s.replace(/"/g, '\\"') + '"';
  return [cmd, ...args].map(q).join(' ');
}

class Stdio implements Transporte {
  private proc: ChildProcess;
  private buffer = '';
  private seq = 0;
  private pendentes = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private stderr = '';
  private encerrado: string | null = null;

  constructor(cfg: McpConfig, private matar: (pid: number) => void, private aoNotificar: (method: string) => void) {
    const env = { ...process.env, ...(cfg.env || {}) };
    const opts: any = { env, cwd: cfg.cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
    this.proc = process.platform === 'win32'
      ? spawn(linhaWindows(cfg.command, cfg.args || []), { ...opts, shell: true })
      : spawn(cfg.command, cfg.args || [], opts);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const linha = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (linha) this.recebe(linha);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c: string) => { this.stderr = (this.stderr + c).slice(-4000); });
    this.proc.on('error', (e) => this.falha(`could not start "${cfg.command}": ${e.message}`));
    this.proc.on('exit', (code) => this.falha(`server process exited (code ${code})`));
  }

  private recebe(linha: string) {
    let msg;
    try { msg = JSON.parse(linha); } catch { return; } // log fora do protocolo no stdout
    if (msg.id != null && this.pendentes.has(msg.id) && !msg.method) {
      const p = this.pendentes.get(msg.id);
      this.pendentes.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Pedido do servidor ao cliente: ping precisa de resposta; o resto não foi anunciado
    // nas capabilities, então "método não suportado".
    if (msg.method && msg.id != null) {
      this.escreve(msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported by Pofu Code Studio' } });
      return;
    }
    if (msg.method) this.aoNotificar(msg.method);
  }

  private falha(motivo: string) {
    if (this.encerrado) return;
    this.encerrado = motivo;
    for (const [, p] of this.pendentes) { clearTimeout(p.timer); p.reject(new Error(this.diagnostico())); }
    this.pendentes.clear();
  }

  private escreve(obj: any) {
    if (this.encerrado || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  diagnostico() {
    const cauda = this.stderr.trim().split('\n').slice(-6).join('\n');
    return (this.encerrado || 'MCP server error') + (cauda ? `\n${cauda}` : '');
  }

  request(method: string, params: any, timeoutMs: number) {
    if (this.encerrado) return Promise.reject(new Error(this.diagnostico()));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendentes.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pendentes.set(id, { resolve, reject, timer });
      this.escreve({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: any) { this.escreve({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }

  fechar() {
    this.falha('closed');
    try { this.proc.stdin.end(); } catch { /* já fechado */ }
    // Com shell no Windows o PID é do cmd.exe: sem derrubar a árvore, o node do servidor
    // fica órfão a cada reconexão.
    if (this.proc.pid) this.matar(this.proc.pid);
  }
}

class Http implements Transporte {
  private seq = 0;
  private sessao = '';
  private ultimoErro = '';
  constructor(private cfg: McpConfig) {}

  private cabecalhos() {
    return {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOLO,
      ...(this.sessao ? { 'Mcp-Session-Id': this.sessao } : {}),
      ...(this.cfg.headers || {})
    };
  }

  private async respostaSse(r: Response, id: number) {
    const reader = r.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buffer = '', dados: string[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let inicio = 0;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] !== '\n' && buffer[i] !== '\r') continue;
          // Um CRLF pode vir em dois chunks, assim como um caractere UTF-8 no decoder.
          if (buffer[i] === '\r' && i + 1 === buffer.length && !done) break;
          const linha = buffer.slice(inicio, i);
          if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++;
          inicio = i + 1;
          if (linha === '') {
            let msg;
            try { msg = JSON.parse(dados.join('\n')); } catch { /* evento não-JSON */ }
            dados = [];
            if (msg?.id === id && !msg.method) return msg;
          } else if (linha === 'data' || linha.startsWith('data:')) {
            dados.push(linha.slice(5).replace(/^ /, ''));
          }
        }
        buffer = buffer.slice(inicio);
        if (done) return null;
      }
    } finally {
      // Receber a resposta conclui a chamada; esperar EOF trava em servidores que mantêm SSE aberto.
      await reader.cancel().catch(() => { /* conexão já encerrada */ });
      reader.releaseLock();
    }
  }

  async request(method: string, params: any, timeoutMs: number) {
    const id = ++this.seq;
    const r = await fetch(this.cfg.url, {
      method: 'POST', headers: this.cabecalhos(), signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.sessao = sid;
    if (!r.ok) { this.ultimoErro = `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`; throw new Error(this.ultimoErro); }
    let msg = null;
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
      msg = await this.respostaSse(r, id);
    } else {
      const texto = await r.text();
      if (texto) msg = JSON.parse(texto);
    }
    if (!msg || msg.id !== id || msg.method) throw new Error(`MCP server sent no response to "${method}"`);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }

  notify(method: string, params?: any) {
    fetch(this.cfg.url, { method: 'POST', headers: this.cabecalhos(), body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) })
      .catch(() => { /* notificação não tem resposta a esperar */ });
  }

  fechar() {
    if (this.sessao) fetch(this.cfg.url, { method: 'DELETE', headers: this.cabecalhos() }).catch(() => { /* melhor esforço */ });
  }

  diagnostico() { return this.ultimoErro || 'MCP HTTP error'; }
}

export class McpServidor {
  estado: 'conectando' | 'ok' | 'erro' | 'desligado' = 'conectando';
  erro = '';
  ferramentas: McpFerramenta[] = [];
  private t: Transporte | null = null;

  constructor(public nome: string, private cfg: McpConfig, private versao: string, private matar: (pid: number) => void) {}

  async conectar() {
    if (this.cfg.disabled) { this.estado = 'desligado'; return; }
    try {
      if (!this.cfg.command && !this.cfg.url) throw new Error('Config needs "command" (local server) or "url" (remote server).');
      this.t = this.cfg.url ? new Http(this.cfg) : new Stdio(this.cfg, this.matar, (m) => {
        if (m === 'notifications/tools/list_changed') this.listar().catch(() => { /* fica a lista anterior */ });
      });
      await this.t.request('initialize', {
        protocolVersion: PROTOCOLO, capabilities: {},
        clientInfo: { name: 'pofu-code-studio', version: this.versao }
      }, this.cfg.timeout || INICIO_MS);
      this.t.notify('notifications/initialized');
      await this.listar();
      this.estado = 'ok';
    } catch (e) {
      this.estado = 'erro';
      this.erro = String(e && e.message || e);
      this.fechar();
    }
  }

  private async listar() {
    const todas: McpFerramenta[] = [];
    let cursor;
    for (let pagina = 0; pagina < 20; pagina++) {
      const r = await this.t.request('tools/list', cursor ? { cursor } : {}, this.cfg.timeout || CHAMADA_MS);
      todas.push(...(r?.tools || []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    this.ferramentas = todas;
  }

  async chamar(ferramenta: string, args: any) {
    if (this.estado !== 'ok' || !this.t) throw new Error(`MCP server "${this.nome}" is not connected${this.erro ? ': ' + this.erro : ''}.`);
    return this.t.request('tools/call', { name: ferramenta, arguments: args || {} }, this.cfg.timeout || CHAMADA_MS);
  }

  fechar() {
    try { this.t?.fechar(); } catch { /* já fechado */ }
    this.t = null;
  }
}

// O que o modelo recebe de um tools/call: texto como está, o resto descrito. Imagem e áudio
// não vão como base64 no texto — seriam milhares de tokens de lixo para um modelo de texto.
export function textoDoResultado(r: any) {
  const partes: string[] = [];
  for (const c of r?.content || []) {
    if (c.type === 'text') partes.push(c.text);
    else if (c.type === 'image' || c.type === 'audio') partes.push(`[${c.type}: ${c.mimeType || 'unknown type'}, ${Math.round((c.data || '').length * 0.75 / 1024)} KB — not shown as text]`);
    else if (c.type === 'resource') partes.push(c.resource?.text ?? `[resource: ${c.resource?.uri || '?'}]`);
    else if (c.type === 'resource_link') partes.push(`[resource link: ${c.uri}${c.name ? ' — ' + c.name : ''}]`);
  }
  if (!partes.length && r?.structuredContent !== undefined) partes.push(JSON.stringify(r.structuredContent));
  return partes.join('\n');
}
