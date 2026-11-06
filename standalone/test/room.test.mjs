import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBridge } from '../bowxt.mjs';
test('rename preserves room identity, persists and refuses unpaused backend', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'room-binding-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let name = '旧群', paused = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/status')) return new Response(JSON.stringify({ paused, worker_paused: true, queue_depth: 0 }));
    const patch = JSON.parse(options.body);
    assert.equal(patch.expected_name, name);
    name = patch.name;
    return new Response('{}');
  });
  class Client {}
  const settings = { baseUrl: 'http://fixture', dataDir, chatId: 1, roomName: '旧群', log() {} };
  const bridge = installBridge(Client, settings);
  const renamed = await bridge.renameRoom('旧群', '新群');
  assert.equal(renamed.roomId, 'bowxt:1@chatroom');
  assert.equal(renamed.previousName, '旧群');
  const restarted = installBridge(class {}, { ...settings, roomName: '默认群' });
  assert.equal(restarted.roomBinding().name, '新群');
  paused = false;
  await assert.rejects(bridge.renameRoom('新群', '错误群'), /未暂停/);
  assert.equal(bridge.roomBinding().name, '新群');
});
