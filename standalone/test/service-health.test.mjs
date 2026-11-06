import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceHealth } from '../service-health.mjs';
test('desktop checks are read only, cached and force-refreshable', async () => {
  let calls = 0;
  const inspect = createServiceHealth({ enabled: true, fetcher: async url => {
    calls++; return new Response(url.includes('19091') ? '{"status":"OK"}' : '<html>noVNC</html>');
  }, vnc: async () => { calls++; } });
  const first = await inspect();
  assert.equal(first.items.length, 3);
  assert.ok(first.items.every(i => i.level === 'ok'));
  assert.equal(await inspect(), first); assert.equal(calls, 3);
  await inspect(true); assert.equal(calls, 6);
});
test('unconfigured checks do not contact local services and failures cannot be green', async () => {
  const off = createServiceHealth({ fetcher: () => { throw new Error('must not call'); } });
  assert.equal((await off()).configured, false);
  const fail = createServiceHealth({ enabled: true, fetcher: async () => { throw new Error('secret error'); }, vnc: async () => { throw new Error('offline'); } });
  const report = await fail();
  assert.ok(report.items.every(i => i.level === 'bad'));
  assert.ok(!JSON.stringify(report).includes('secret error'));
});
