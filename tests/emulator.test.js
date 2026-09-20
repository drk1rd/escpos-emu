'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { createEmulator } = require('../src/server');
const { Client } = require('../src/client');

/**
 * End to end: a real socket, a real HTTP API, a real job log.
 *
 * Everything binds on 127.0.0.1 with port 0, so the suite never guesses at a
 * free port and never touches the network the machine is really on.
 */

const send = (port, payload) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.end(Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1'))
    );
    socket.on('close', resolve);
    socket.on('error', reject);
  });

/** Connect and report how the device answered, without waiting for ever. */
const probe = (port, ms = 800) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('hung');
    }, ms);
    socket.on('connect', () => socket.write('x'));
    socket.on('close', () => {
      clearTimeout(timer);
      resolve('closed');
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      resolve(err.code);
    });
  });

const ticket = (clock) =>
  Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from('TICKET 1183\n3 x CAPPUCCINO\nPrinted ', 'latin1'),
    Buffer.from(clock, 'latin1'),
    Buffer.from([0x0a, 0x1d, 0x56, 0x00]),
  ]);

/** A fresh emulator with two devices, torn down by the caller. */
async function startEmulator() {
  const emu = createEmulator({
    subnet: null,
    dataDir: null,
    devices: [
      { id: 'kitchen', name: 'KITCHEN', ip: '127.0.0.1', port: 0, columns: 48 },
      { id: 'bar', name: 'BAR', ip: '127.0.0.1', port: 0, columns: 32 },
    ],
  });
  const { url } = await emu.start({ httpPort: 0, httpHost: '127.0.0.1' });
  return {
    emu,
    client: new Client(url),
    port: (id) => emu.devices.get(id).port,
    stop: () => emu.stop(),
  };
}

test('a job sent to a device is recorded on that device and nowhere else', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  await send(port('kitchen'), ticket('21:40:33'));
  const job = await client.waitForJob('CAPPUCCINO', { device: 'kitchen' });

  assert.strictEqual(job.deviceId, 'kitchen');
  assert.match(job.text, /3 x CAPPUCCINO/);
  assert.strictEqual((await client.jobs({ device: 'bar' })).length, 0, 'the bar printed something');
});

test('expectExactlyOne passes for one ticket', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  await send(port('kitchen'), ticket('21:40:33'));
  const job = await client.expectExactlyOne('CAPPUCCINO', { device: 'kitchen', settleMs: 120 });
  assert.ok(job.id);
});

test('the same round printed twice is caught, though the clock differs', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  // Byte-different, layout-identical: what a duplicated ticket looks like in
  // the wild. A hash of the bytes would see two unrelated jobs.
  await send(port('kitchen'), ticket('21:40:33'));
  await send(port('kitchen'), ticket('21:40:35'));

  await client.waitForJob('CAPPUCCINO', { device: 'kitchen' });
  await new Promise((r) => setTimeout(r, 150));

  const stats = await client.stats();
  assert.strictEqual(stats.duplicates, 1, 'the repeat was not flagged');

  await assert.rejects(
    () => client.expectExactlyOne('CAPPUCCINO', { device: 'kitchen', settleMs: 120 }),
    /expected exactly one job .* found 2/s
  );
});

test('two genuine rounds of the same drink are not a duplicate', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  await send(port('kitchen'), 'TICKET 1183\n1 x MANGO BEER\n');
  await send(port('kitchen'), 'TICKET 1184\n1 x MANGO BEER\n');
  await new Promise((r) => setTimeout(r, 150));

  const stats = await client.stats();
  assert.strictEqual(stats.total, 2);
  assert.strictEqual(stats.duplicates, 0, 'a second round was mistaken for a repeat');
});

test('each failure mode answers the way that hardware does', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  await client.setMode('bar', 'refuse');
  assert.strictEqual(await probe(port('bar')), 'ECONNREFUSED', 'a powered-off printer refuses');

  await client.setMode('bar', 'reset');
  assert.strictEqual(await probe(port('bar')), 'ECONNRESET', 'a paper-out printer drops');

  await client.setMode('bar', 'hang');
  assert.strictEqual(await probe(port('bar')), 'hung', 'a hung printer never answers');

  /*
    A working printer is not "the one that closes the socket". It holds the
    connection open and lets the client hang up, exactly as `hang` does - the
    difference is that it READS. So the test for `accept` is that the bytes
    arrive and become a job, which is the only observable that separates the
    two from outside.
  */
  await client.setMode('bar', 'accept');
  await send(port('bar'), 'back in service\n');
  const job = await client.waitForJob('back in service', { device: 'bar' });
  assert.ok(job, 'a working printer did not record the job');
});

test('a hung printer records nothing, so a job cannot look sent', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  await client.setMode('kitchen', 'hang');
  await probe(port('kitchen'), 300);

  assert.strictEqual(
    (await client.jobs({ device: 'kitchen' })).length,
    0,
    'a hung printer must not produce a job'
  );
});

test('a device coming back up binds again, so a reprint can succeed', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  const before = port('kitchen');
  await client.setMode('kitchen', 'refuse');
  assert.strictEqual(await probe(before), 'ECONNREFUSED');

  await client.setMode('kitchen', 'accept');
  const after = port('kitchen');
  await send(after, ticket('22:00:00'));
  const job = await client.waitForJob('CAPPUCCINO', { device: 'kitchen' });
  assert.ok(job, 'the reprint did not land');
});

test('paper runs out, and from then on the device accepts and drops', async (t) => {
  const { client, emu, port, stop } = await startEmulator();
  t.after(stop);

  await client.setPaper('kitchen', 1);
  await send(port('kitchen'), 'first\n');
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(emu.devices.get('kitchen').paper, 0);
  assert.strictEqual(emu.devices.get('kitchen').mode, 'reset');

  await send(port('kitchen'), 'second\n').catch(() => {});
  await new Promise((r) => setTimeout(r, 150));

  const jobs = await client.jobs({ device: 'kitchen' });
  assert.strictEqual(jobs.length, 1, 'a job was recorded after the paper ran out');
});

test('a job held on an open socket is still recorded', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  // A client that does not close its connection between tickets would
  // otherwise print nothing at all until it disconnected.
  const socket = net.connect(port('kitchen'), '127.0.0.1', () => socket.write('held open\n'));
  t.after(() => socket.destroy());

  const job = await client.waitForJob('held open', { device: 'kitchen', timeoutMs: 4000 });
  assert.match(job.text, /held open/);
});

test('the log can be searched and cleared', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  await send(port('kitchen'), 'ONE\n');
  await send(port('bar'), 'TWO\n');
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual((await client.jobsContaining('ONE')).length, 1);
  assert.strictEqual((await client.jobsContaining('nothing here')).length, 0);

  await client.reset();
  assert.strictEqual((await client.jobs()).length, 0);
});

test('a 32-column device flags a line too wide for its roll', async (t) => {
  const { client, port, stop } = await startEmulator();
  t.after(stop);

  await send(port('bar'), 'THIS LINE IS DELIBERATELY LONGER THAN THIRTY-TWO\n');
  const job = await client.waitForJob('DELIBERATELY', { device: 'bar' });
  assert.deepStrictEqual(job.overWidth, [0], 'the over-wide line was not flagged');
});
