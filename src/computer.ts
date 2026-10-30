// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.

import { randomUUID } from 'node:crypto';
import { COMPUTER_CAPTURE_TIMEOUT_MS, COMPUTER_IMAGE_MAX_SIDE, COMPUTER_OBSERVATION_MS } from './constants.js';

export interface ComputerDisplay {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  physicalBounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  rotation: number;
}
interface ComputerImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
}
// Retângulo visível da janela, em pixels físicos, como o helper do Windows devolve.
export interface ComputerWindow { handle: string; pid: number; title: string; x: number; y: number; width: number; height: number; minimized: boolean }
interface ComputerDependencies {
  platform: string;
  displays(): ComputerDisplay[];
  primaryDisplay(): string;
  sources(): Promise<Array<{ display_id: string; name: string; thumbnail: ComputerImage }>>;
  windowSources(size: { width: number; height: number }): Promise<Array<{ id: string; name: string; thumbnail: ComputerImage }>>;
  // PIDs dos comandos que o agente rodou: só a janela de um programa dele pode sair da tela.
  ownPids(): number[];
  save(png: Buffer, id: string): string;
  input(request: Record<string, any>, signal: AbortSignal): Promise<any>;
  now?: () => number;
}
interface Observation {
  id: string;
  created: number;
  display?: ComputerDisplay;
  window?: ComputerWindow;
  width: number;
  height: number;
  target?: { handle: string; pid: number };
}

const descende = (pid: number, raizes: number[], processes: number[][]) => {
  const pai = new Map(processes.map(([filho, dele]) => [filho, dele]));
  for (let i = 0; i < 64 && pid; i++, pid = pai.get(pid)) if (raizes.includes(pid)) return true;
  return false;
};

// window_id de uma captura anterior, PID (o execute_command devolve o do cmd.exe, então vale
// qualquer descendente) ou parte do título. A maior janela vem primeiro: programa costuma ter
// janelas auxiliares pequenas, e a minimizada só ganha quando é a única.
export function chooseWindow(query: string, windows: ComputerWindow[], processes: number[][]) {
  const texto = query.trim(), id = /^window:(\d+)$/i.exec(texto);
  let achadas: ComputerWindow[];
  if (id) achadas = windows.filter(w => w.handle === id[1]);
  else if (/^\d+$/.test(texto)) achadas = windows.filter(w => descende(w.pid, [Number(texto)], processes));
  else {
    const busca = texto.toLowerCase();
    achadas = windows.filter(w => w.title.toLowerCase().includes(busca));
    if (achadas.some(w => w.title.toLowerCase() === busca)) achadas = achadas.filter(w => w.title.toLowerCase() === busca);
  }
  return achadas.sort((a, b) => Number(a.minimized) - Number(b.minimized) || b.width * b.height - a.width * a.height);
}

const sobrepoe = (w: { x: number; y: number; width: number; height: number }, d: ComputerDisplay) => {
  const b = d.physicalBounds;
  return w.x < b.x + b.width && w.x + w.width > b.x && w.y < b.y + b.height && w.y + w.height > b.y;
};

const KEY_CODES: Record<string, number> = {
  CTRL: 17, CONTROL: 17, ALT: 18, SHIFT: 16, WIN: 91, WINDOWS: 91, META: 91, SUPER: 91,
  ENTER: 13, RETURN: 13, TAB: 9, ESC: 27, ESCAPE: 27, SPACE: 32, BACKSPACE: 8,
  DELETE: 46, DEL: 46, INSERT: 45, HOME: 36, END: 35, PAGEUP: 33, PAGEDOWN: 34,
  LEFT: 37, ARROWLEFT: 37, UP: 38, ARROWUP: 38, RIGHT: 39, ARROWRIGHT: 39, DOWN: 40, ARROWDOWN: 40,
  CAPSLOCK: 20, PRINTSCREEN: 44,
};
export function computerKeys(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error('keys must contain 1 to 5 key names.');
  const codes = value.map(key => {
    if (typeof key !== 'string') throw new Error('Each key must be a key name, for example CTRL, L or ENTER.');
    const name = key.toUpperCase();
    const code = KEY_CODES[name] ?? (/^[A-Z0-9]$/.test(name) ? name.charCodeAt(0) : /^F([1-9]|1\d|2[0-4])$/.test(name) ? 111 + Number(name.slice(1)) : undefined);
    if (code === undefined) throw new Error(`Unsupported key: ${key.slice(0, 40)}. Use type for text.`);
    return code;
  });
  if (new Set(codes).size !== codes.length || codes.slice(0, -1).some(code => ![16, 17, 18, 91].includes(code))) throw new Error('Use modifiers followed by one key, for example ["CTRL", "L"].');
  return codes;
}

export function prepareComputerAction(args: any, observation: Observation) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Computer action must be an object.');
  const allowed = ['click', 'double_click', 'move', 'scroll', 'key', 'type'];
  if (!allowed.includes(args.action)) throw new Error('Unsupported computer action.');
  const request: Record<string, any> = { action: args.action, target: observation.target };
  const coordinates = ['click', 'double_click', 'move', 'scroll'].includes(args.action);
  if (coordinates) {
    if (!Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x < 0 || args.y < 0 || args.x >= observation.width || args.y >= observation.height)
      throw new Error(`x and y must be integer coordinates inside the screenshot (${observation.width} x ${observation.height}).`);
    const bounds = observation.window ?? observation.display.physicalBounds;
    request.x = bounds.x + Math.min(bounds.width - 1, Math.floor((args.x + 0.5) * bounds.width / observation.width));
    request.y = bounds.y + Math.min(bounds.height - 1, Math.floor((args.y + 0.5) * bounds.height / observation.height));
  }
  if (args.action === 'click' || args.action === 'double_click') {
    if (args.button !== undefined && !['left', 'right', 'middle'].includes(args.button)) throw new Error('button must be left, right or middle.');
    request.button = args.button ?? 'left';
  }
  if (args.action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(args.direction)) throw new Error('direction must be up, down, left or right.');
    const amount = args.amount ?? 3;
    if (!Number.isInteger(amount) || amount < 1 || amount > 10) throw new Error('amount must be an integer from 1 to 10 wheel steps.');
    request.direction = args.direction; request.amount = amount;
  }
  if (args.action === 'key') request.codes = computerKeys(args.keys);
  if (args.action === 'type') {
    if (typeof args.text !== 'string' || !args.text.length || args.text.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.text)) throw new Error('text must contain 1 to 2000 characters without control characters (newlines and tabs are allowed).');
    request.text = args.text.replace(/\r\n?/g, '\n');
  }
  return request;
}

export class DesktopComputer {
  private enabled = false;
  private observation?: Observation;
  private controller?: AbortController;
  private generation = 0;
  private busy = false;
  // Quanto cada janela foi empurrada para fora da tela: offscreen: false a devolve ao mesmo lugar.
  private deslocadas = new Map<string, { dx: number; dy: number }>();
  constructor(private deps: ComputerDependencies) {}
  setEnabled(enabled: boolean) { this.enabled = enabled === true; if (!this.enabled) this.cancel(); }
  cancel() { this.generation++; this.observation = undefined; this.controller?.abort(); }
  private check() { if (!this.enabled) throw new Error('Computer access is disabled. Enable it in settings before using desktop tools.'); }
  private now() { return (this.deps.now || Date.now)(); }
  private result(error: any) { return { success: false, error: String(error?.message || error), hint: 'Capture the screen again before retrying. Do not assume input was applied.' }; }
  private limited<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout>, onAbort: () => void;
    return Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Screen capture timed out.')), COMPUTER_CAPTURE_TIMEOUT_MS);
      onAbort = () => reject(new Error('Screen capture cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
  }
  async capture(opts: any = {}) {
    if (this.busy) return this.result(new Error('Another computer operation is still running.'));
    this.busy = true;
    const generation = this.generation, controller = this.controller = new AbortController();
    try {
      this.check();
      this.observation = undefined;
      if (!opts || typeof opts !== 'object' || Array.isArray(opts) || (opts.display_id !== undefined && typeof opts.display_id !== 'string')) throw new Error('display_id must be a string returned by capture_screen.');
      if (opts.window !== undefined && (typeof opts.window !== 'string' || !opts.window.trim() || opts.window.length > 200)) throw new Error('window must be part of a window title, a process ID or a window_id returned by capture_screen.');
      if (opts.offscreen !== undefined && (typeof opts.offscreen !== 'boolean' || opts.window === undefined)) throw new Error('offscreen must be true or false and requires window: it moves one program window, never the screen.');
      if (opts.window !== undefined) return await this.captureWindow(opts, generation, controller.signal);
      const displays = this.deps.displays();
      const displayId = opts.display_id === 'primary' ? this.deps.primaryDisplay() : (opts.display_id ?? this.deps.primaryDisplay());
      const display = displays.find(d => d.id === displayId);
      if (!display) throw new Error('Display was not found. Capture the screen without display_id to list available displays.');
      const target = this.deps.platform === 'win32' ? await this.deps.input({ action: 'observe' }, controller.signal) : undefined;
      if (target && (!/^[1-9]\d*$/.test(target.handle) || !Number.isInteger(target.pid) || target.pid <= 0)) throw new Error('No foreground window is available. Unlock the desktop and retry.');
      const sources = await this.limited(this.deps.sources(), controller.signal);
      this.check();
      if (generation !== this.generation) throw new Error('Screen capture cancelled.');
      // display_id pode faltar em certos capturadores; só o monitor único é inequívoco.
      const source = sources.find(s => s.display_id === display.id) || (displays.length === 1 && sources.length === 1 ? sources[0] : undefined);
      if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture is unavailable. Check the operating system screen recording permission.');
      const image = source.thumbnail, { width, height } = image.getSize();
      if (width < 1 || height < 1) throw new Error('Screen capture was empty.');
      if (JSON.stringify(display) !== JSON.stringify(this.deps.displays().find(d => d.id === display.id))) throw new Error('Display layout changed while capturing. Retry capture_screen.');
      const id = randomUUID(), png = image.toPNG(), path = this.deps.save(png, id);
      this.observation = { id, created: this.now(), display, width, height, target };
      return { success: true, path, dataUrl: 'data:image/png;base64,' + png.toString('base64'), width, height,
        screenshot_id: id, display_id: display.id, input_supported: this.deps.platform === 'win32',
        displays: displays.map(d => ({ id: d.id, label: d.label, width: d.physicalBounds.width, height: d.physicalBounds.height })),
        note: 'Coordinates use this image, with (0, 0) at its top-left. screenshot_id expires in 120 seconds and after one action.' };
    } catch (error) { return this.result(error); }
    finally { this.busy = false; if (this.controller === controller) this.controller = undefined; }
  }
  // Só a janela do programa, mesmo coberta por outras: o print do monitor inteiro trazia junto o
  // que o usuário estava fazendo. Fora da tela ela continua sendo desenhada (medido), então o
  // programa pode rodar sem aparecer; minimizada, não — por isso é restaurada antes.
  private async captureWindow(opts: any, generation: number, signal: AbortSignal) {
    const windows = this.deps.platform === 'win32', notas: string[] = [];
    let janela: ComputerWindow | undefined, fonte: { id: string; name: string; thumbnail: ComputerImage } | undefined;
    if (windows) {
      const lista = await this.deps.input({ action: 'windows' }, signal);
      const abertas: ComputerWindow[] = lista?.windows || [], processos: number[][] = lista?.processes || [];
      for (const handle of this.deslocadas.keys()) if (!abertas.some(w => w.handle === handle)) this.deslocadas.delete(handle);
      const [achada, ...outras] = chooseWindow(opts.window, abertas, processos);
      if (!achada) throw new Error(`No open window matches "${opts.window}". Open windows: ${abertas.slice(0, 15).map(w => JSON.stringify(w.title)).join(', ') || 'none'}. A program's window only exists after it opens.`);
      janela = achada;
      if (outras.length) notas.push(`${outras.length} other window(s) also matched: ${outras.slice(0, 5).map(w => `"${w.title}" (window:${w.handle})`).join(', ')}. Pass a window_id to pick one.`);
      if (janela.minimized) {
        janela = (await this.deps.input({ action: 'place', handle: janela.handle, restore: true, dx: 0, dy: 0 }, signal)).window;
        notas.push('The window was minimized and was restored to be captured: minimized windows have no pixels.');
      }
      const displays = this.deps.displays(), naTela = displays.some(d => sobrepoe(janela, d));
      let dx = 0, dy = 0;
      if (opts.offscreen === true && naTela) {
        if (!descende(janela.pid, this.deps.ownPids(), processos)) throw new Error(`offscreen only moves windows of programs you started with execute_command; "${janela.title}" belongs to another program.`);
        dx = Math.min(...displays.map(d => d.physicalBounds.x)) - janela.width - 200 - janela.x;
      } else if (opts.offscreen === false && !naTela) {
        const volta = this.deslocadas.get(janela.handle), principal = (displays.find(d => d.id === this.deps.primaryDisplay()) || displays[0]).physicalBounds;
        [dx, dy] = volta ? [-volta.dx, -volta.dy] : [principal.x + 40 - janela.x, principal.y + 40 - janela.y];
      }
      if (dx || dy) {
        janela = (await this.deps.input({ action: 'place', handle: janela.handle, restore: false, dx, dy }, signal)).window;
        const antes = this.deslocadas.get(janela.handle) || { dx: 0, dy: 0 };
        if (opts.offscreen) this.deslocadas.set(janela.handle, { dx: antes.dx + dx, dy: antes.dy + dy }); else this.deslocadas.delete(janela.handle);
      }
      // A miniatura é AMPLIADA até o tamanho pedido (uma janela de 586 px voltava com 1600):
      // pedir o tamanho real dá pixels fiéis e coordenadas sem escala.
      const escala = Math.min(1, COMPUTER_IMAGE_MAX_SIDE / Math.max(janela.width, janela.height, 1));
      const fontes = await this.limited(this.deps.windowSources({ width: Math.max(1, Math.round(janela.width * escala)), height: Math.max(1, Math.round(janela.height * escala)) }), signal);
      fonte = fontes.find(f => f.id.startsWith(`window:${janela.handle}:`));
    } else {
      if (opts.offscreen !== undefined) throw new Error('offscreen is supported on Windows only.');
      // Sem o helper do Windows, a janela é achada pelo título na lista do próprio capturador.
      const fontes = await this.limited(this.deps.windowSources({ width: COMPUTER_IMAGE_MAX_SIDE, height: COMPUTER_IMAGE_MAX_SIDE }), signal);
      const busca = opts.window.trim().toLowerCase();
      fonte = fontes.find(f => f.name.toLowerCase() === busca) || fontes.find(f => f.name.toLowerCase().includes(busca));
      if (!fonte) throw new Error(`No open window matches "${opts.window}". Open windows: ${fontes.slice(0, 15).map(f => JSON.stringify(f.name)).join(', ') || 'none'}.`);
    }
    this.check();
    if (generation !== this.generation) throw new Error('Screen capture cancelled.');
    if (!fonte || fonte.thumbnail.isEmpty()) throw new Error('The window could not be captured. Windows on another virtual desktop and windows of elevated programs have no pixels to capture.');
    const image = fonte.thumbnail, { width, height } = image.getSize();
    const id = randomUUID(), png = image.toPNG(), path = this.deps.save(png, id);
    const visivel = !!janela && this.deps.displays().some(d => sobrepoe(janela, d));
    this.observation = { id, created: this.now(), window: janela, width, height, target: janela && { handle: janela.handle, pid: janela.pid } };
    if (janela && !visivel) notas.push('The window is outside the visible screen: it keeps running without covering the user\'s work, but clicks cannot reach it there (capture it with offscreen: false first). Before you finish, bring it back with offscreen: false or stop the program.');
    return { success: true, path, dataUrl: 'data:image/png;base64,' + png.toString('base64'), width, height,
      screenshot_id: id, window_id: janela && 'window:' + janela.handle, title: janela?.title ?? fonte.name, pid: janela?.pid,
      offscreen: janela ? !visivel : undefined, input_supported: windows && visivel,
      note: ['This image shows only that window. Coordinates use this image, with (0, 0) at its top-left. screenshot_id expires in 120 seconds and after one action.', ...notas].join(' ') };
  }
  async action(args: any) {
    if (this.busy) return this.result(new Error('Another computer operation is still running.'));
    this.busy = true;
    const controller = this.controller = new AbortController();
    try {
      this.check();
      if (this.deps.platform !== 'win32') throw new Error('Computer input is currently supported on Windows only. Screen capture is available on this platform.');
      const observation = this.observation;
      if (!observation || args?.screenshot_id !== observation.id || this.now() - observation.created > COMPUTER_OBSERVATION_MS) throw new Error('screenshot_id is missing, expired or already used. Call capture_screen before acting.');
      if (observation.display && JSON.stringify(observation.display) !== JSON.stringify(this.deps.displays().find(d => d.id === observation.display.id))) throw new Error('Display layout changed. Capture the screen again.');
      const request = prepareComputerAction(args, observation);
      if (observation.window) {
        if (request.x !== undefined && !this.deps.displays().some(d => sobrepoe({ x: request.x, y: request.y, width: 1, height: 1 }, d)))
          throw new Error('That point of the window is outside the visible screen. Capture it with offscreen: false before acting on it.');
        const { x, y, width, height } = observation.window;
        request.bounds = { x, y, width, height }; // o helper confere: janela que mudou de lugar receberia o clique no ponto errado
      }
      this.observation = undefined;
      const result = await this.deps.input(request, controller.signal);
      if (controller.signal.aborted) throw new Error('Computer action cancelled.');
      if (!result?.success) throw new Error(result?.error || 'Windows input failed.');
      return { success: true, action: args.action, display_id: observation.display?.id, window_id: observation.window && 'window:' + observation.window.handle,
        note: 'Input was sent. Capture the screen to verify the result before another action.' };
    } catch (error) { return this.result(error); }
    finally { this.busy = false; if (this.controller === controller) this.controller = undefined; }
  }
}
