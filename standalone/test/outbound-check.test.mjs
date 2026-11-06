import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectOutbound } from '../outbound-check.mjs';

const request = (id, seq) => ({ requestId: id, seq, clientId: 'client-' + id,
  textHash: createHash('sha256').update('private reply').digest('hex') });
const message = (id, status = 'sent') => ({ seq: 4, chat_id: 1, direction: 'outgoing', client_id: 'client-' + id, content: 'private reply', delivery_status: status });

test('outbound checks separate sent/pending/failed, expose no content and never mutate request state', async () => {
  const requests = new Map(['a', 'b', 'c'].map((id, i) => [id, request(id, i + 1)]));
  const before = JSON.stringify([...requests]);
  const result = await inspectOutbound(async path => {
    assert.match(path, /^\/api\/messages\/\d+$/);
    const index = Number(path.split('/').at(-1)) - 1;
    return { message: message(['a', 'b', 'c'][index], ['sent', 'pending', 'failed'][index]) };
  }, 1, ['a', 'b', 'c', 'missing'], requests);
  assert.deepEqual(result.items.map(x => x.status), ['sent', 'pending', 'failed', 'no_request_record']);
  assert.equal(JSON.stringify([...requests]), before);
  assert.ok(!JSON.stringify(result).includes('private reply'));
  assert.ok(!JSON.stringify(result).includes('client-'));
});

test('lost response searches once by exact client identity and missing history remains unknown', async () => {
  let calls = 0;
  const requests = new Map(['a', 'b', 'c'].map(id => [id, request(id)]));
  requests.get('c').completed = true;
  const result = await inspectOutbound(async path => {
    calls++; assert.equal(path, '/api/chats/1/messages?recent=1&limit=100');
    return { messages: [message('a'), { ...message('b'), chat_id: 2 }] };
  }, 1, ['a', 'b', 'c'], requests);
  assert.equal(calls, 1);
  assert.deepEqual(result.items.map(x => x.status), ['sent', 'unknown', 'local_confirmed']);
  assert.equal(result.items[1].scope, 'recent_100');
});

test('foreign/reused/changed message and offline backend cannot be presented as sent', async () => {
  const requests = new Map([['a', request('a', 4)]]);
  for (const patch of [{ chat_id: 2 }, { client_id: 'other' }, { direction: 'incoming' }, { content: 'changed' }]) {
    const result = await inspectOutbound(async () => ({ message: { ...message('a'), ...patch } }), 1, ['a'], requests);
    assert.equal(result.items[0].status, 'identity_mismatch');
  }
  const offline = await inspectOutbound(async () => { throw Error('private backend error'); }, 1, ['a'], requests);
  assert.equal(offline.items[0].status, 'unavailable');
  assert.ok(!JSON.stringify(offline).includes('private backend error'));
});

test('outbound inspection is bounded and explicitly reports omitted segments', async () => {
  const ids = Array.from({ length: 23 }, (_, i) => String(i));
  const result = await inspectOutbound(() => { throw Error('no request should query backend'); }, 1, ids, new Map());
  assert.equal(result.total, 23); assert.equal(result.items.length, 20); assert.equal(result.truncated, true);
});
