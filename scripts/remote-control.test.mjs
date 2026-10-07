import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteControl, remoteServer } from '../out/remote-control.js';
const delay = ms => new Promise(r => setTimeout(r, ms));
const cipher = { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
const token = 'a'.repeat(64);
test('origem HTTPS exata ou loopback HTTP; nada de credenciais, caminho ou query', () => {
  assert.equal(remoteServer('https://ai.pofuserver.com'), 'https://ai.pofuserver.com'); assert.equal(remoteServer('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  for (const url of ['http://example.org', 'file:///tmp', 'https://key@example.org', 'https://example.org/foo', 'https://example.org/?key=bad', 'https://example.org/#bad']) assert.throws(() => remoteServer(url));
});
test('pareamento requer cofre do sistema antes de enviar o código', async () => {
  const remote = new RemoteControl(join(mkdtempSync(join(tmpdir(),'pofu-remote-')), 'link.json'), { ...cipher, available: () => false }, () => {}, () => {});
  await assert.rejects(remote.pair('https://example.org', 'A123456789', 'pc'), /armazenamento seguro/);
});
test('credencial protegida, estado público sem token, stop e retomada explícita', async () => {
  const oldFetch = global.fetch, bodies = [], file = join(mkdtempSync(join(tmpdir(),'pofu-remote-')), 'link.json');
  global.fetch = async (url, opts) => { bodies.push({ url, body: JSON.parse(opts.body), headers: opts.headers, redirect: opts.redirect }); return Response.json(url.endsWith('/claim') ? { deviceId:'device-test',token } : { commands: [], needsSnapshot: false }); };
  const r = new RemoteControl(file, cipher, () => {}, () => {});
  try {
    await r.pair('http://127.0.0.1:1234', 'A123456789', 'pc'); r.publish({ chatText: 'teste' }); await delay(25); r.enable(false);
    assert.ok(!JSON.stringify(r.status()).includes(token)); assert.ok(!readFileSync(file,'utf8').includes(token)); assert.equal(bodies[0].redirect,'error');
    const restored = new RemoteControl(file, cipher, () => {}, () => {}); restored.resume(); assert.equal(restored.status().enabled,false); assert.equal(restored.status().deviceId,'device-test'); restored.enable(false,true); assert.equal(existsSync(file),false); restored.stop();
  } finally { r.stop(); global.fetch = oldFetch; }
});
test('reconexão pede estado inteiro e um comando duplicado nunca executa duas vezes', async () => {
  const oldFetch = global.fetch, bodies = [], commands = [], file = join(mkdtempSync(join(tmpdir(),'pofu-remote-')), 'link.json'); let polls = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body); bodies.push(body);
    if (url.endsWith('/claim')) return Response.json({ deviceId:'device-test',token });
    polls++; return Response.json({ needsSnapshot: polls === 1, commands: [{ id: 'unique-command', type:'stop', expiresAt:Date.now()+10000 }] });
  };
  let remote;
  remote = new RemoteControl(file, cipher, c => { commands.push(c.id); remote.complete(c.id,true); }, () => {});
  try {
    await remote.pair('http://127.0.0.1:1234','A123456789','pc'); remote.publish({chatText:'estado'});
    await delay(1150); remote.stop(); assert.equal(commands.length,1); assert.ok(bodies[1].snapshot); assert.ok(bodies[2].snapshot); assert.deepEqual(bodies[2].results,[{id:'unique-command',ok:true}]);
  } finally { remote.stop(); global.fetch = oldFetch; }
});
test('401 desliga conexão, impede novo polling e não mostra chave de erro', async () => {
  const oldFetch = global.fetch; let polls=0;
  global.fetch = async url => url.endsWith('/claim') ? Response.json({deviceId:'device-test',token}) : (polls++,Response.json({error:token},{status:401}));
  const r = new RemoteControl(join(mkdtempSync(join(tmpdir(),'pofu-remote-')),'link.json'),cipher,()=>{},()=>{});
  try { await r.pair('http://127.0.0.1:1234','A123456789','pc'); await delay(50); assert.equal(r.status().enabled,false); assert.equal(r.status().state,'error'); assert.ok(!JSON.stringify(r.status()).includes(token)); assert.equal(polls,1); }
  finally { r.stop(); global.fetch = oldFetch; }
});
