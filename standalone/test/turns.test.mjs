import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTurnJournal } from '../turns.mjs';
import { installBridge } from '../bowxt.mjs';
import { createOutbox } from '../../upstream/wechat-bot/wechat-group-agent/lib/outbox.mjs';

const roomId = 'bowxt:1@chatroom';
const temp = () => mkdtempSync(join(tmpdir(), 'wechat-turns-'));
const message = n => ({ id: `bowxt:${n}`, roomId, text: '模拟消息' });
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待模拟状态超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('durable receipt survives restart and duplicate claims never restart unfinished work', () => {
  const data = temp();
  const journal = createTurnJournal(data, roomId);
  assert.equal(journal.receive(message(1)), true);
  assert.equal(journal.receive(message(1)), false);
  assert.throws(() => journal.receive({ ...message(2), roomId: 'other' }));
  const restored = createTurnJournal(data, roomId);
  assert.equal(restored.summary().needsReview, 1);
  assert.equal(restored.list()[0].reason, 'interrupted');
  assert.equal(restored.receive(message(1)), false);
  assert.ok(!JSON.stringify(restored.list()).includes('模拟消息'));
  const item = restored.list()[0];
  assert.throws(() => restored.resolve({ ...item, updatedAt: item.updatedAt - 1, confirm: true }));
  assert.throws(() => restored.resolve(item));
  assert.equal(restored.resolve({ ...item, confirm: true }).ok, true);
  assert.equal(restored.summary().needsReview, 0);
  assert.equal(restored.summary().counts.skipped, 1);
  assert.throws(() => restored.resolve({ ...item, confirm: true }));
});

test('merged batches keep per-part identities and explicit skipped/failed outcomes', async () => {
  const data = temp();
  const journal = createTurnJournal(data, roomId);
  for (const n of [1, 2, 3, 4]) { journal.receive(message(n)); journal.queued(message(n)); }
  let ids;
  await journal.batch([message(1), message(2)], async () => {
    ids = [journal.outboundId(), journal.outboundId()];
    journal.sent(); journal.sent();
  });
  assert.notEqual(ids[0], ids[1]);
  assert.match(ids[0], /^turn:[a-f0-9]{64}:part:0$/);
  await journal.batch([message(3)], async () => journal.skip('silence'));
  await journal.batch([message(4)], async () => { journal.sent(); journal.fail('send_unconfirmed'); });
  const restored = createTurnJournal(data, roomId);
  assert.deepEqual(restored.summary().counts, { completed: 2, skipped: 1, needs_review: 1 });
  const records = readdirSync(join(data, 'turns')).map(name => JSON.parse(readFileSync(join(data, 'turns', name))));
  assert.deepEqual(records.find(record => record.id === 'bowxt:1').outboundIds, ids);
});

test('business task remains active until background memory work settles', async () => {
  const journal = createTurnJournal(temp(), roomId);
  journal.receive(message(1));
  let finish;
  const pending = journal.batch([message(1)], async () => {
    void journal.task(() => new Promise(resolve => { finish = resolve; }));
    journal.sent();
  });
  await waitFor(() => !!finish);
  assert.ok(journal.summary().active > 0);
  assert.equal(journal.summary().counts.processing, 1);
  finish(); await pending;
  assert.equal(journal.summary().active, 0);
  assert.equal(journal.summary().counts.completed, 1);
});

test('outbox captures identity before shared drain, preserves identical distinct replies and never retries uncertain sends', async () => {
  const journal = createTurnJournal(temp(), roomId);
  const sent = [];
  let attempts = 0;
  const outbox = createOutbox({
    cfg: { minGapMs: 0, baseBackoffMs: 0 },
    prepare: (_, args) => ({ ...args, requestId: journal.outboundId() }),
    send: async (_, args) => {
      attempts++;
      if (args.text === 'uncertain') throw Object.assign(new Error('unconfirmed'), { retryable: false });
      sent.push(args.requestId); await new Promise(resolve => setTimeout(resolve, 5)); return { verified: true };
    },
  });
  for (const n of [1, 2]) journal.receive(message(n));
  await Promise.all([1, 2].map(n => journal.batch([message(n)], async () => {
    await outbox.sendText(roomId, 'same reply'); journal.sent();
  })));
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1]);
  await assert.rejects(outbox.sendText(roomId, 'uncertain'));
  assert.equal(attempts, 3);
  assert.equal(outbox.stats.retried, 0);
});

test('receipt write failure prevents dispatch and ACK and stops consumption', async t => {
  const data = temp();
  const journal = createTurnJournal(data, roomId);
  const name = createHash('sha256').update('bowxt:1').digest('hex') + '.json';
  mkdirSync(join(data, 'turns', name)); // Make atomic rename fail without touching real data.
  let claim = 0, acks = 0, events = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    let result = {};
    if (url.endsWith('/api/status')) result = { wechat_connected: true, last_poll_completed_at: Date.now() / 1000 + 1 };
    if (url.endsWith('/claim') && JSON.parse(options.body).timeout) {
      claim++;
      result = { deliveries: [{ lease_token: 'fixture', message: { seq: 1, chat_id: 1, message_type: 'text', sender: 'fixture', direction: 'incoming', content: 'fixture' } }] };
    }
    if (url.endsWith('/ack')) acks++;
    return new Response(JSON.stringify(result));
  });
  class Client { constructor() { this._status = {}; this.onEvent = e => { if (e.t === 'msg') events++; }; } }
  const bridge = installBridge(Client, { dataDir: data, chatId: 1, roomName: 'fixture', baseUrl: 'http://fixture', lifecycle: journal, log() {} });
  t.after(() => bridge.close());
  new Client().connect();
  await bridge.enable(true);
  await waitFor(() => journal.summary().fault);
  assert.equal(acks, 0); assert.equal(events, 0); assert.equal(claim, 1);
  assert.equal(bridge.status().polling, false);
});

test('stable send record survives response loss and confirmed sends are never POSTed twice', async t => {
  const data = temp();
  let posts = 0;
  let firstId;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    let result = {};
    if (url.endsWith('/api/status')) result = { wechat_connected: true, last_poll_completed_at: Date.now() / 1000 + 1 };
    if (url.endsWith('/messages')) {
      const body = JSON.parse(options.body); posts++;
      if (posts === 1) { firstId = body.client_id; throw new Error('response lost after enqueue'); }
      assert.equal(body.client_id, firstId);
      result = { message: { seq: 51, delivery_status: 'sent' } };
    }
    return new Response(JSON.stringify(result));
  });
  class Client { constructor() { this._status = {}; this.onEvent = () => {}; } }
  const settings = { chatId: 1, roomName: 'fixture', baseUrl: 'http://fixture', dataDir: data, log() {} };
  let bridge = installBridge(Client, settings);
  await bridge.enable(true);
  const args = { roomId, text: 'fixture', requestId: 'turn:fixture:part:0' };
  await assert.rejects(new Client().call('sendText', args), error => error.retryable === false);
  bridge.close();
  bridge = installBridge(Client, settings);
  t.after(() => bridge.close());
  await bridge.enable(true);
  await new Client().call('sendText', args);
  await new Client().call('sendText', args);
  assert.equal(posts, 2); // Explicit verification after restart uses the SAME backend key.
  await assert.rejects(new Client().call('sendText', { ...args, text: 'changed' }));
  assert.equal(posts, 2);
});
