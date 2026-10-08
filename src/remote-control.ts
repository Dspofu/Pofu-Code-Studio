import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

export function remoteServer(raw: string) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('Use a origem HTTPS do site, sem caminho, usuário ou senha.');
  return u.origin;
}
interface Cipher { available(): boolean; encrypt(s: string): string; decrypt(s: string): string }
type Link = { server: string; deviceId: string; token: string; name: string; enabled: boolean };
export class RemoteControl {
  private link: Link | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private instance = randomUUID();
  private snapshot: unknown = null;
  private sent = '';
  private results: { id: string; ok: boolean }[] = [];
  private seen = new Set<string>();
  private delay = 1000;
  private retryAt: number | null = null;
  private state = 'disconnected';
  private message = 'Não conectado.';
  private generation = 0;
  private resumed = false;
  private paused = false;
  constructor(private file: string, private cipher: Cipher, private command: (c: any) => void, private changed: (s: any) => void) {}
  status() { return { server: this.link?.server || 'https://ai.pofuserver.com', deviceId: this.link?.deviceId || '', name: this.link?.name || '', enabled: !!this.link?.enabled, state: this.state, message: this.message, retryAt: this.retryAt }; }
  private announce(state: string, message: string) { const changed = this.state !== state || this.message !== message; this.state = state; this.message = message; if (changed) this.changed(this.status()); }
  private save() {
    if (!this.link) { if (existsSync(this.file)) unlinkSync(this.file); return; }
    if (!this.cipher.available()) throw new Error('O sistema não oferece armazenamento seguro para a conexão remota.');
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ ...this.link, token: undefined, encryptedToken: this.cipher.encrypt(this.link.token) }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  resume() {
    if (this.resumed) { if (this.paused && this.link?.enabled) { this.sent = ''; this.schedule(0); } return; } this.resumed = true;
    try {
      if (existsSync(this.file)) {
        const s = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!this.cipher.available()) throw new Error('secure storage unavailable');
        const token = this.cipher.decrypt(s.encryptedToken);
        if (!/^[a-f0-9]{64}$/.test(token) || typeof s.deviceId !== 'string') throw new Error('invalid credentials');
        this.link = { server: remoteServer(s.server), token, deviceId: s.deviceId, name: String(s.name || ''), enabled: s.enabled === true };
        if (this.link.enabled) this.schedule(0);
      }
    } catch { this.announce('error', 'Não foi possível restaurar a conexão. Faça o pareamento novamente.'); }
  }
  async pair(server: string, code: string, name: string) {
    if (!this.cipher.available()) throw new Error('O sistema não oferece armazenamento seguro para a conexão remota.');
    server = remoteServer(server);
    if (!/^[A-F0-9]{10}$/i.test(code)) throw new Error('Digite o código de 10 caracteres exibido no site.');
    const response = await fetch(server + '/api/code/remote/desktop/claim', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: name.slice(0, 100) }) });
    if (!response.ok) throw new Error(response.status === 409 ? 'Remova um dispositivo no site antes de conectar outro.' : 'Código inválido, vencido ou plano sem Code. Gere outro no site.');
    const result = await response.json();
    if (!/^[a-f0-9]{64}$/.test(result.token) || typeof result.deviceId !== 'string') throw new Error('Resposta de pareamento inválida.');
    this.stop(); this.link = { server, token: result.token, deviceId: result.deviceId, name, enabled: true };
    this.sent = ''; this.results = []; this.seen.clear(); this.save(); this.delay = 1000;
    this.announce('connecting', 'Conectando ao site…'); this.schedule(0);
    return this.status();
  }
  enable(enabled: boolean, forget = false) {
    this.stop();
    if (forget) this.link = null;
    else if (this.link) this.link.enabled = enabled;
    this.save(); this.sent = '';
    this.announce(enabled && this.link ? 'connecting' : 'disconnected', enabled && this.link ? 'Conectando ao site…' : 'Controle remoto desligado.');
    if (enabled && this.link) this.schedule(0);
    return this.status();
  }
  publish(snapshot: unknown) {
    const encoded = JSON.stringify(snapshot);
    if (Buffer.byteLength(encoded) > 220000) throw new Error('Estado do Studio grande demais para sincronizar.');
    this.snapshot = snapshot;
  }
  complete(id: string, ok: boolean) { if (this.seen.has(id) && !this.results.some(r => r.id === id)) this.results.push({ id, ok: ok === true }); }
  stop() { this.retryAt = null; this.generation++; this.paused = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.controller?.abort(); }
  private schedule(ms: number) { this.paused = false; this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, ms); this.timer.unref(); }
  private async tick() {
    if (!this.link?.enabled) return;
    const generation = this.generation, link = this.link;
    if (this.retryAt !== null) { this.retryAt = null; this.announce('connecting', 'Reconectando…'); }
    const encoded = JSON.stringify(this.snapshot), results = this.results.slice(0, 20);
    this.controller = new AbortController(); const controller = this.controller, timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(link.server + '/api/code/remote/desktop/sync', { method: 'POST', redirect: 'error', signal: this.controller.signal, headers: { Authorization: 'Bearer ' + link.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: this.instance, ...(this.snapshot && encoded !== this.sent ? { snapshot: this.snapshot } : {}), results }) });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) { link.enabled = false; this.save(); this.announce('error', 'Conexão revogada ou acesso indisponível. Confira a conta e faça o pareamento novamente.'); return; }
      if (!response.ok || !/json/i.test(response.headers.get('content-type') || '')) throw new Error('sync unavailable');
      const raw = await response.text(); if (raw.length > 6500000) throw new Error('response too large');
      const data = JSON.parse(raw);
      if (generation !== this.generation) return;
      this.sent = data.needsSnapshot ? '' : encoded; this.results = this.results.filter(r => !results.includes(r)); this.delay = 1000; this.retryAt = null;
      this.announce('online', 'Conectado ao Code.');
      for (const c of Array.isArray(data.commands) ? data.commands.slice(0, 20) : []) {
        if (typeof c?.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(c.id) || this.seen.has(c.id)) continue;
        this.seen.add(c.id); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
        if (typeof c.expiresAt !== 'number' || c.expiresAt < Date.now()) this.complete(c.id, false); else this.command(c);
      }
    } catch { if (generation === this.generation) { this.sent = ''; this.delay = 10000; this.retryAt = Date.now() + this.delay; this.announce('connecting', 'Site indisponível. Reconectando em 10s…'); } }
    finally { clearTimeout(timeout); if (generation === this.generation && this.link?.enabled) this.schedule(this.delay); }
  }
}
