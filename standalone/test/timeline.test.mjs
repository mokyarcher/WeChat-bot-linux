import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, installBridge } from '../bowxt.mjs';
import { silenceDecision } from '../../upstream/wechat-bot/wechat-group-agent/lib/human2.mjs';

test('a new message uses observation time instead of a shared WeChat separator', () => {
  const message = normalizeMessage({ seq: 7, sender: 'Moky', direction: 'incoming',
    content: '可以 你终于回来了', timestamp: '2026-11-05T16:57:00+08:00',
    observed_at: '2026-11-05T09:00:02.814645+00:00' }, 1, '测试群');
  assert.equal(message.ts, Date.parse('2026-11-05T09:00:02.814645+00:00'));
  assert.equal(message.sourceTs, Date.parse('2026-11-05T16:57:00+08:00'));
});

test('a later reply is not silenced when timestamps are coarse or equal', () => {
  const now = new Date(2026, 10, 5, 17, 0).getTime();
  const self = { isSelf: true, ts: now - 60000, text: '你回来了' };
  const reply = { sender: 'person', isSelf: false, ts: now - 120000, text: '可以 你终于回来了' };
  assert.equal(silenceDecision({ now, recent: [self, reply], trigger: reply, energy: 0.8 }).silent, false);
});

test('custom names and actual mentions bypass ambient silence rules', () => {
  const now = new Date(2026, 10, 5, 17, 0).getTime();
  const recent = [{ isSelf: true, ts: now - 1000, text: '上一句' }];
  assert.equal(silenceDecision({ now, recent, trigger: { text: '@豆姐 你好' }, selfNames: ['豆姐'] }).silent, false);
  assert.equal(silenceDecision({ now, recent, trigger: { text: '你好', isAtMe: true } }).silent, false);
});

test('history and search respect the original plugin ordering contract', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ messages: [
    { seq: 1, message_type: 'text', direction: 'incoming', sender: 'A', content: '第一条' },
    { seq: 3, message_type: 'text', direction: 'unknown', content: '边界残留' },
    { seq: 2, message_type: 'text', direction: 'outgoing', content: '第二条' },
  ] }), { headers: { 'content-type': 'application/json' } }));
  class Client { constructor() { this._status = {}; this.onEvent = () => {}; } }
  const bridge = installBridge(Client, { chatId: 1, roomName: '测试群', baseUrl: 'http://localhost', log() {} });
  t.after(() => bridge.close());
  const client = new Client();
  assert.deepEqual((await client.call('history')).map(message => message.seq), [1, 2]);
  assert.deepEqual((await client.call('searchMessages')).items.map(message => message.seq), [2, 1]);
});
