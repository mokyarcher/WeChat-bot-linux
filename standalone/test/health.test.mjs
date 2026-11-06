import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinuxHealth } from '../health.mjs';
const now = 100000;
const bridge = { chatId: 1, polling: true };
const model = { hasKey: true };
const snapshot = { state: { wechat_connected: true, last_poll_completed_at: 99, paused: false }, chats: [{ id: 1, name: '测试群' }] };
test('idle group remains healthy when scans succeed, and checks do not call model', () => {
  const health = buildLinuxHealth(snapshot, bridge, model, now);
  assert.equal(health.bad.length, 0);
  assert.equal(health.clientConnected, true);
  assert.ok(health.items.find(i => i.name === '模型配置').text.includes('未调用'));
});
test('stale scan, wrong group and API failure are not green', () => {
  assert.ok(buildLinuxHealth({ ...snapshot, state: { ...snapshot.state, last_poll_completed_at: 1 } }, bridge, model, now).bad.length);
  assert.ok(buildLinuxHealth({ ...snapshot, chats: [] }, bridge, model, now).bad.length);
  assert.ok(buildLinuxHealth({ error: 'HTTP timeout' }, bridge, model, now).bad.length);
  assert.equal(buildLinuxHealth({ error: 'HTTP timeout' }, bridge, model, now).clientConnected, null);
});
test('pause is explicit and transient failures remain visible', () => {
  assert.ok(buildLinuxHealth(snapshot, { ...bridge, polling: false }, model, now).warn.length);
  assert.ok(buildLinuxHealth({ ...snapshot, chats: [{ id: 1, name: '测试群', last_error: 'input locked' }] }, bridge, model, now).bad.some(i => i.text.includes('input locked')));
});
