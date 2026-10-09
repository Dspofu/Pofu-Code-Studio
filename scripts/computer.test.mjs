import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopComputer, computerKeys, prepareComputerAction } from '../out/computer.js';

const display = { id: 'secondary', label: 'Monitor 2', bounds: { x: -1280, y: 0, width: 1280, height: 720 },
  physicalBounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5, rotation: 0 };
const observation = { id: 'seen', created: 0, display, width: 960, height: 540, target: { handle: '123', pid: 99 } };
function fixture(overrides = {}) {
  const calls = [], saved = [], png = Buffer.from('pixels');
  let now = 100, displays = [structuredClone(display)];
  const deps = { platform: 'win32', now: () => now, displays: () => displays, primaryDisplay: () => display.id,
    sources: async () => [{ display_id: display.id, name: display.label, thumbnail: { isEmpty: () => false, getSize: () => ({ width: 960, height: 540 }), toPNG: () => png } }],
    save: (bytes, id) => { saved.push({ bytes, id }); return '/screens/' + id + '.png'; },
    input: async request => { calls.push(request); return request.action === 'observe' ? { success: true, handle: '123', pid: 99 } : { success: true }; }, ...overrides };
  return { computer: new DesktopComputer(deps), calls, saved, time: n => { now = n; }, layout: ds => { displays = ds; } };
}

test('desktop desligado recusa captura e input antes de acessar adaptadores', async () => {
  const f = fixture();
  assert.equal((await f.computer.capture()).success, false);
  assert.equal((await f.computer.action({ action: 'click' })).success, false);
  assert.equal(f.calls.length, 0); assert.equal(f.saved.length, 0);
});

test('coordenadas do PNG mapeiam para monitor secundário com DPI e origem negativa', () => {
  const first = prepareComputerAction({ action: 'click', x: 0, y: 0 }, observation);
  const last = prepareComputerAction({ action: 'move', x: 959, y: 539 }, observation);
  assert.deepEqual([first.x, first.y], [-1919, 1]);
  assert.deepEqual([last.x, last.y], [-1, 1079]);
  assert.equal(first.button, 'left');
  for (const pair of [[-1, 0], [960, 0], [0, 540], [0.5, 1], ['2', 1], [NaN, 1]])
    assert.throws(() => prepareComputerAction({ action: 'click', x: pair[0], y: pair[1] }, observation), /coordinates/);
});

test('validação distingue atalhos de texto e impõe limites da ferramenta', () => {
  assert.deepEqual(computerKeys(['CTRL', 'L']), [17, 76]);
  assert.deepEqual(computerKeys(['Alt', 'Tab']), [18, 9]);
  assert.deepEqual(computerKeys(['F24']), [135]);
  for (const keys of [[], ['CTRL', 'CTRL'], ['A', 'B'], ['F25'], 'CTRL+L', [1]]) assert.throws(() => computerKeys(keys));
  const literal = 'Olá 🐾; $(Get-Process)\r\ntexto\tfinal';
  assert.equal(prepareComputerAction({ action: 'type', text: literal }, observation).text, literal.replace(/\r\n/g, '\n'));
  for (const text of ['', 'x'.repeat(2001), 'x\0y']) assert.throws(() => prepareComputerAction({ action: 'type', text }, observation));
  for (const args of [{ action: 'click', x: 1, y: 1, button: 'extra' }, { action: 'scroll', x: 1, y: 1, direction: 'down', amount: 11 }, { action: 'scroll', x: 1, y: 1, direction: 'diagonal' }, { action: 'delete' }]) assert.throws(() => prepareComputerAction(args, observation));
});

test('uma observação permite somente uma ação; ID incorreto nunca envia input', async () => {
  const f = fixture(); f.computer.setEnabled(true);
  const shot = await f.computer.capture();
  assert.equal(shot.success, true); assert.deepEqual([shot.width, shot.height], [960, 540]);
  assert.equal(shot.dataUrl, 'data:image/png;base64,' + Buffer.from('pixels').toString('base64'));
  assert.equal((await f.computer.action({ action: 'key', screenshot_id: 'wrong', keys: ['ENTER'] })).success, false);
  assert.equal((await f.computer.action({ action: 'key', screenshot_id: shot.screenshot_id, keys: ['ENTER'] })).success, true);
  assert.equal((await f.computer.action({ action: 'key', screenshot_id: shot.screenshot_id, keys: ['ENTER'] })).success, false);
  assert.deepEqual(f.calls.map(c => c.action), ['observe', 'key']);
});

test('primary seleciona o monitor principal sem aceitar IDs desconhecidos', async () => {
  const f = fixture(); f.computer.setEnabled(true);
  const shot = await f.computer.capture({ display_id: 'primary' });
  assert.equal(shot.success, true); assert.equal(shot.display_id, display.id);
  assert.equal((await f.computer.capture({ display_id: 'inventado' })).success, false);
  assert.equal((await f.computer.action({ action: 'key', screenshot_id: shot.screenshot_id, keys: ['ENTER'] })).success, false);
  assert.deepEqual(f.calls.map(c => c.action), ['observe']);
});

test('captura expirada, mudança de monitor e revogação exigem nova observação', async () => {
  const f = fixture(); f.computer.setEnabled(true);
  let shot = await f.computer.capture(); f.time(120101);
  assert.equal((await f.computer.action({ action: 'type', text: 'ok', screenshot_id: shot.screenshot_id })).success, false);
  shot = await f.computer.capture(); f.layout([{ ...display, rotation: 90 }]);
  assert.equal((await f.computer.action({ action: 'type', text: 'ok', screenshot_id: shot.screenshot_id })).success, false);
  f.computer.setEnabled(false); f.computer.setEnabled(true);
  assert.equal((await f.computer.action({ action: 'type', text: 'ok', screenshot_id: shot.screenshot_id })).success, false);
  assert.ok(f.calls.every(c => c.action === 'observe'));
});

test('falha nativa informa falha e consome captura para não repetir input parcial', async () => {
  const f = fixture({ input: async r => r.action === 'observe' ? { success: true, handle: '123', pid: 99 } : { success: false, error: 'Focus changed.' } });
  f.computer.setEnabled(true); const shot = await f.computer.capture();
  const result = await f.computer.action({ action: 'type', text: 'ok', screenshot_id: shot.screenshot_id });
  assert.equal(result.success, false); assert.match(result.error, /Focus changed/); assert.match(result.hint, /Do not assume/);
  assert.match((await f.computer.action({ action: 'type', text: 'ok', screenshot_id: shot.screenshot_id })).error, /already used/);
});

test('captura em plataforma sem input permanece disponível e não executa observe', async () => {
  const f = fixture({ platform: 'linux' }); f.computer.setEnabled(true);
  const shot = await f.computer.capture(); assert.equal(shot.success, true); assert.equal(shot.input_supported, false);
  assert.equal((await f.computer.action({ action: 'key', keys: ['ENTER'], screenshot_id: shot.screenshot_id })).success, false);
  assert.equal(f.calls.length, 0);
});

test('captura sem pixels ou monitor ambíguo recusa ação', async () => {
  const f = fixture({ sources: async () => [] }); f.computer.setEnabled(true);
  assert.equal((await f.computer.capture()).success, false);
  assert.equal((await f.computer.action({ action: 'key', keys: ['ENTER'], screenshot_id: 'x' })).success, false);
});

test('uma recaptura que falha invalida a observação anterior', async () => {
  const f = fixture(); f.computer.setEnabled(true);
  const shot = await f.computer.capture();
  assert.equal((await f.computer.capture({ display_id: 'missing' })).success, false);
  assert.equal((await f.computer.action({ action: 'key', keys: ['ENTER'], screenshot_id: shot.screenshot_id })).success, false);
  assert.ok(f.calls.every(c => c.action === 'observe'));
});

test('Parar cancela uma captura pendente sem salvar pixels e libera a próxima operação', async () => {
  let resolveSources;
  const f = fixture({ sources: () => new Promise(r => { resolveSources = r; }) }); f.computer.setEnabled(true);
  const pending = f.computer.capture();
  await new Promise(r => setImmediate(r));
  assert.equal((await f.computer.capture()).success, false);
  f.computer.cancel();
  const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('Parar não liberou a captura.')), 300))]);
  assert.equal(result.success, false); assert.match(result.error, /cancelled/i); assert.equal(f.saved.length, 0);
  resolveSources([]);
});

test('Parar cancela input em andamento e invalida o ID observado', async () => {
  const f = fixture({ input: async (r, signal) => r.action === 'observe' ? { success: true, handle: '123', pid: 99 } : new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Computer action cancelled.')), { once: true })) });
  f.computer.setEnabled(true); const shot = await f.computer.capture();
  const action = f.computer.action({ action: 'type', text: 'teste', screenshot_id: shot.screenshot_id });
  await new Promise(r => setImmediate(r)); f.computer.cancel();
  assert.equal((await action).success, false);
  assert.equal((await f.computer.action({ action: 'type', text: 'teste', screenshot_id: shot.screenshot_id })).success, false);
});

test('a parte em PowerShell do helper roda no Windows PowerShell 5.1', async () => {
  // [ushort], [short], [ulong] e [uint] só existem do PowerShell 6 em diante; no 5.1, que é
  // o que o Windows traz, o cast falha e toda ação de tecla quebrava (o C# do Add-Type pode).
  const { WINDOWS_COMPUTER_SCRIPT } = await import('../out/computer-windows.js');
  const [antes, resto] = WINDOWS_COMPUTER_SCRIPT.split("@'\n");
  const powershell = antes + resto.slice(resto.indexOf("\n'@") + 3);
  assert.ok(powershell.includes('[PofuInput]::Keys('));
  assert.doesNotMatch(powershell, /\[(ushort|short|ulong|uint|sbyte)(\[\])?\]/i);
});
