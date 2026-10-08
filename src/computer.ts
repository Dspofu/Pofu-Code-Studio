// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.

import { randomUUID } from 'node:crypto';
import { COMPUTER_CAPTURE_TIMEOUT_MS, COMPUTER_OBSERVATION_MS } from './constants.js';

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
interface ComputerDependencies {
  platform: string;
  displays(): ComputerDisplay[];
  primaryDisplay(): string;
  sources(): Promise<Array<{ display_id: string; name: string; thumbnail: ComputerImage }>>;
  save(png: Buffer, id: string): string;
  input(request: Record<string, any>, signal: AbortSignal): Promise<any>;
  now?: () => number;
}
interface Observation {
  id: string;
  created: number;
  display: ComputerDisplay;
  width: number;
  height: number;
  target?: { handle: string; pid: number };
}

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
    const bounds = observation.display.physicalBounds;
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
  constructor(private deps: ComputerDependencies) {}
  setEnabled(enabled: boolean) { this.enabled = enabled === true; if (!this.enabled) this.cancel(); }
  cancel() { this.generation++; this.observation = undefined; this.controller?.abort(); }
  private check() { if (!this.enabled) throw new Error('Computer access is disabled. Enable it in settings before using desktop tools.'); }
  private now() { return (this.deps.now || Date.now)(); }
  private result(error: any) { return { success: false, error: String(error?.message || error), hint: 'Capture the screen again before retrying. Do not assume input was applied.' }; }
  async capture(opts: any = {}) {
    if (this.busy) return this.result(new Error('Another computer operation is still running.'));
    this.busy = true;
    const generation = this.generation, controller = this.controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>, onAbort: () => void;
    try {
      this.check();
      this.observation = undefined;
      if (!opts || typeof opts !== 'object' || Array.isArray(opts) || (opts.display_id !== undefined && typeof opts.display_id !== 'string')) throw new Error('display_id must be a string returned by capture_screen.');
      const displays = this.deps.displays();
      const display = displays.find(d => d.id === (opts.display_id ?? this.deps.primaryDisplay()));
      if (!display) throw new Error('Display was not found. Capture the screen without display_id to list available displays.');
      const target = this.deps.platform === 'win32' ? await this.deps.input({ action: 'observe' }, controller.signal) : undefined;
      if (target && (!/^[1-9]\d*$/.test(target.handle) || !Number.isInteger(target.pid) || target.pid <= 0)) throw new Error('No foreground window is available. Unlock the desktop and retry.');
      const sources = await Promise.race([this.deps.sources(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Screen capture timed out.')), COMPUTER_CAPTURE_TIMEOUT_MS); onAbort = () => reject(new Error('Screen capture cancelled.')); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); })]);
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
    finally { clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort); this.busy = false; if (this.controller === controller) this.controller = undefined; }
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
      if (JSON.stringify(observation.display) !== JSON.stringify(this.deps.displays().find(d => d.id === observation.display.id))) throw new Error('Display layout changed. Capture the screen again.');
      const request = prepareComputerAction(args, observation);
      this.observation = undefined;
      const result = await this.deps.input(request, controller.signal);
      if (controller.signal.aborted) throw new Error('Computer action cancelled.');
      if (!result?.success) throw new Error(result?.error || 'Windows input failed.');
      return { success: true, action: args.action, display_id: observation.display.id, note: 'Input was sent. Capture the screen to verify the result before another action.' };
    } catch (error) { return this.result(error); }
    finally { this.busy = false; if (this.controller === controller) this.controller = undefined; }
  }
}
