import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopComputer, chooseWindow, computerKeys, prepareComputerAction } from '../out/computer.js';

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

const tela = { id: 'p', label: 'Principal', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, physicalBounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0 };
const calculadora = { handle: '500', pid: 30, title: 'Minha Calculadora', x: 100, y: 100, width: 800, height: 600, minimized: false };
const dica = { handle: '501', pid: 30, title: 'Minha Calculadora - dica', x: 120, y: 120, width: 200, height: 80, minimized: false };
const editor = { handle: '600', pid: 77, title: 'Visual Studio Code', x: 0, y: 0, width: 1920, height: 1040, minimized: false };
// O cmd.exe (10) abriu o python (30): o PID que o execute_command devolve é o do cmd.
const arvore = [[10, 5], [30, 10], [77, 4]];
function comJanelas({ windows, processes = arvore, own = [] }) {
  const calls = [], pedidos = [], lista = structuredClone(windows);
  const computer = new DesktopComputer({ platform: 'win32', displays: () => [tela], primaryDisplay: () => 'p', sources: async () => [], ownPids: () => own,
    windowSources: async size => { pedidos.push(size); return lista.map(w => ({ id: `window:${w.handle}:0`, name: w.title, thumbnail: { isEmpty: () => false, getSize: () => size, toPNG: () => Buffer.from('janela') } })); },
    save: (bytes, id) => '/shots/' + id + '.png',
    input: async request => {
      calls.push(request);
      if (request.action === 'windows') return { success: true, windows: structuredClone(lista), processes };
      if (request.action !== 'place') return { success: true };
      const w = lista.find(j => j.handle === request.handle);
      if (request.restore && w.minimized) Object.assign(w, w.normal, { minimized: false });
      w.x += request.dx; w.y += request.dy;
      return { success: true, window: structuredClone(w) };
    } });
  computer.setEnabled(true);
  return { computer, calls, pedidos, janela: handle => lista.find(w => w.handle === handle) };
}

test('janela é achada por título, PID do processo pai ou window_id, a maior primeiro', () => {
  const todas = [dica, editor, calculadora];
  assert.deepEqual(chooseWindow('calculadora', todas, arvore).map(w => w.handle), ['500', '501']);
  assert.deepEqual(chooseWindow('Minha Calculadora - Dica', todas, arvore).map(w => w.handle), ['501']);
  assert.deepEqual(chooseWindow('10', todas, arvore).map(w => w.handle), ['500', '501']);
  assert.deepEqual(chooseWindow('window:600', todas, arvore).map(w => w.handle), ['600']);
  assert.deepEqual(chooseWindow('11', todas, arvore), []);
  assert.deepEqual(chooseWindow('3', [{ ...calculadora, pid: 1 }], [[1, 2], [2, 1]]), [], 'ciclo de PIDs reaproveitados não trava');
  assert.deepEqual(chooseWindow('x', [{ ...calculadora, title: 'x1', minimized: true }, { ...dica, title: 'x2' }], arvore).map(w => w.handle), ['501', '500']);
});

test('captura só a janela pedida, no tamanho real, e o clique cai nas coordenadas dela', async () => {
  const f = comJanelas({ windows: [editor, calculadora] });
  const shot = await f.computer.capture({ window: 'Calculadora' });
  assert.equal(shot.window_id, 'window:500'); assert.equal(shot.offscreen, false); assert.equal(shot.input_supported, true);
  assert.deepEqual(f.pedidos, [{ width: 800, height: 600 }]);
  assert.equal((await f.computer.action({ action: 'click', x: 0, y: 599, screenshot_id: shot.screenshot_id })).window_id, 'window:500');
  const clique = f.calls.at(-1);
  assert.deepEqual([clique.x, clique.y, clique.target, clique.bounds], [100, 699, { handle: '500', pid: 30 }, { x: 100, y: 100, width: 800, height: 600 }]);
  const grande = comJanelas({ windows: [{ ...calculadora, width: 3200, height: 1800 }] });
  await grande.computer.capture({ window: 'window:500' });
  assert.deepEqual(grande.pedidos, [{ width: 1600, height: 900 }]);
});

test('offscreen tira da tela só programa do agente, devolve ao lugar e recusa clique lá fora', async () => {
  const f = comJanelas({ windows: [editor, calculadora], own: [10] });
  assert.match((await f.computer.capture({ window: 'Visual Studio Code', offscreen: true })).error, /only moves windows of programs you started/);
  assert.ok(!f.calls.some(c => c.action === 'place'));
  const fora = await f.computer.capture({ window: 'Calculadora', offscreen: true });
  assert.equal(fora.offscreen, true); assert.equal(fora.input_supported, false); assert.match(fora.note, /bring it back with offscreen: false/);
  assert.ok(f.janela('500').x + 800 <= 0, JSON.stringify(f.janela('500')));
  assert.match((await f.computer.action({ action: 'click', x: 5, y: 5, screenshot_id: fora.screenshot_id })).error, /outside the visible screen/);
  assert.ok(!f.calls.some(c => c.action === 'click'));
  const volta = await f.computer.capture({ window: 'window:500', offscreen: false });
  assert.equal(volta.offscreen, false); assert.deepEqual([f.janela('500').x, f.janela('500').y], [100, 100]);
});

test('janela minimizada é restaurada antes do print, porque minimizada não tem pixels', async () => {
  const f = comJanelas({ windows: [{ ...calculadora, minimized: true, x: -32000, y: -32000, width: 160, height: 28, normal: { x: 100, y: 100, width: 800, height: 600 } }] });
  const shot = await f.computer.capture({ window: '30' });
  assert.match(shot.note, /was minimized/);
  assert.deepEqual(f.calls.filter(c => c.action === 'place').map(c => [c.restore, c.dx, c.dy]), [[true, 0, 0]]);
  assert.deepEqual(f.pedidos, [{ width: 800, height: 600 }]);
});

test('sem janela correspondente o erro lista as abertas; offscreen exige window', async () => {
  const f = comJanelas({ windows: [editor] });
  assert.match((await f.computer.capture({ window: 'Calculadora' })).error, /No open window matches "Calculadora"\. Open windows: "Visual Studio Code"/);
  assert.match((await f.computer.capture({ offscreen: true })).error, /requires window/);
  assert.ok(f.calls.every(c => c.action === 'windows'));
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
