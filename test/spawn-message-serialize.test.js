import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSerializedMessageHandler } from '../src/spawn.js';

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('serialized worker messages preserve emit order across slow handlers', async () => {
  const worker = new EventEmitter();
  const calls = [];
  worker.on('message', createSerializedMessageHandler({
    label: 'test',
    onMessage: async (msg) => {
      await wait(msg.delay);
      calls.push(msg.id);
    },
  }));

  worker.emit('message', { type: 'cc_event', id: 1, delay: 30 });
  worker.emit('message', { type: 'cc_event', id: 2, delay: 0 });
  worker.emit('message', { type: 'turn_complete', id: 3, delay: 0 });

  await wait(60);

  assert.deepEqual(calls, [1, 2, 3]);
});

test('serialized worker messages continue after a handler error', async () => {
  const worker = new EventEmitter();
  const calls = [];
  worker.on('message', createSerializedMessageHandler({
    label: 'test',
    onMessage: async (msg) => {
      calls.push(msg.id);
      if (msg.id === 1) throw new Error('boom');
    },
  }));

  worker.emit('message', { type: 'cc_event', id: 1 });
  worker.emit('message', { type: 'cc_event', id: 2 });
  worker.emit('message', { type: 'turn_complete', id: 3 });

  await wait(20);

  assert.deepEqual(calls, [1, 2, 3]);
});

test('serialized worker messages never run onMessage concurrently', async () => {
  const worker = new EventEmitter();
  let inFlight = 0;
  let maxInFlight = 0;
  worker.on('message', createSerializedMessageHandler({
    label: 'test',
    onMessage: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await wait(10);
      inFlight -= 1;
    },
  }));

  worker.emit('message', { type: 'cc_event', id: 1 });
  worker.emit('message', { type: 'cc_event', id: 2 });
  worker.emit('message', { type: 'turn_complete', id: 3 });

  await wait(50);

  assert.equal(maxInFlight, 1);
  assert.equal(inFlight, 0);
});
