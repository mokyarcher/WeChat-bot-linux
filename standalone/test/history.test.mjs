import test from 'node:test';
import assert from 'node:assert/strict';
import { readMessagePage } from '../history.mjs';
const message = (seq, content = '测试') => ({ seq, content, chat_id: 1, message_type: 'text', direction: 'incoming' });
const normalize = m => ({ seq: m.seq, text: m.content });
test('history uses recent/before cursors and searches only the scanned page', async () => {
  const urls = [];
  const api = async path => { urls.push(path); return { messages: [message(4, '匹配'), message(5, '其他')] }; };
  const page = await readMessagePage(api, 1, normalize, { query: '匹配', limit: 2 });
  assert.deepEqual(page.items.map(m => m.seq), [4]);
  assert.equal(page.scanned, 2); assert.equal(page.nextBefore, 4);
  assert.match(urls[0], /recent=1/);
  await readMessagePage(api, 1, normalize, { before: 4, limit: 2 });
  assert.match(urls[1], /before=4/);
});
test('history rejects invalid cursors, large pages and unexpected rooms', async () => {
  await assert.rejects(readMessagePage(() => {}, 1, normalize, { before: -1 }));
  await assert.rejects(readMessagePage(() => {}, 1, normalize, { limit: 101 }));
  await assert.rejects(readMessagePage(async () => ({ messages: [{ ...message(1), chat_id: 2 }] }), 1, normalize, {}));
});

test('date range uses first receipt time with inclusive start and exclusive end', async () => {
  const messages = [
    { ...message(1), observed_at: '2026-11-05T15:59:59Z' },
    { ...message(2), observed_at: '2026-11-05T16:00:00Z' },
    { ...message(3), observed_at: '2026-11-06T15:59:59Z' },
    { ...message(4), observed_at: '2026-11-06T16:00:00Z' },
    { ...message(5), timestamp: '2026-11-06T12:00:00Z' },
  ];
  const api = async () => ({ messages });
  const page = await readMessagePage(api, 1, normalize, { since: '2026-11-05T16:00:00.000Z', until: '2026-11-06T16:00:00.000Z' });
  assert.deepEqual(page.items.map(m => m.seq), [3, 2]);
  assert.equal(page.unknownTimeCount, 1);
  const all = await readMessagePage(api, 1, normalize);
  assert.equal(all.items.find(m => m.seq === 5).receivedAt, null);
});

test('date filters reject invalid calendar dates and reversed ranges', async () => {
  await assert.rejects(readMessagePage(() => {}, 1, normalize, { since: '2026-02-30T00:00:00.000Z' }));
  await assert.rejects(readMessagePage(() => {}, 1, normalize, { since: '2026-11-07T00:00:00.000Z', until: '2026-11-06T00:00:00.000Z' }));
  await assert.rejects(readMessagePage(() => {}, 1, normalize, { until: '明天' }));
});
