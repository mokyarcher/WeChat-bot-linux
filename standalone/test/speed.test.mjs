import test from 'node:test';
import assert from 'node:assert/strict';
import { installBridge } from '../bowxt.mjs';
import { humanDelayMs } from '../../upstream/wechat-bot/wechat-group-agent/lib/policy.mjs';

test('typing wait can be shortened without changing original default', () => {
  const original = humanDelayMs('你好呀', 'at', 0.5);
  assert.equal(original, Math.round(400 + 3 * 36.5 + 450));
  assert.equal(humanDelayMs('你好呀', 'at', 0.5, 0.25), Math.round(original / 4));
  assert.equal(humanDelayMs('你好呀', 'at', 0.5, 0), 0);
});

test('long poll dispatches immediately and ignores a claim completed after pause', async t => {
  let pending;
  let acks = 0;
  const waits = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    let result = {};
    if (url.endsWith('/api/status')) result = { wechat_connected: true, last_poll_completed_at: Date.now() / 1000 + 1 };
    if (url.endsWith('/claim')) {
      const body = JSON.parse(options.body);
      waits.push(body.timeout);
      if (body.timeout) return new Promise(resolve => { pending = value => resolve(new Response(JSON.stringify(value))); });
    }
    if (url.endsWith('/ack')) acks++;
    return new Response(JSON.stringify(result));
  });
  class Client {}
  const events = [];
  const bridge = installBridge(Client, { chatId: 1, roomName: '测试群', baseUrl: 'http://fixture', log() {} });
  t.after(() => bridge.close());
  const client = new Client();
  client._status = {};
  client.onEvent = event => { if (event.t === 'msg') events.push(event); };
  client.connect();
  const delivery = seq => ({ deliveries: [{ lease_token: 'lease', message: {
    seq, chat_id: 1, message_type: 'text', content: '测试', sender: '测试人', direction: 'incoming',
  } }] });
  await bridge.enable(true);
  assert.deepEqual(waits, [0, 10]);
  pending(delivery(1));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(events.length, 1);
  assert.equal(acks, 1);
  await bridge.enable(false);
  pending(delivery(2)); // A backend may complete even when the request was aborted.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
  assert.equal(acks, 1);
});
