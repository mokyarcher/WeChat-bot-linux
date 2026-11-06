import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTurnJournal } from '../turns.mjs';

test('round durations sum measured stages, preserve skip reason and omit message text', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const journal = createTurnJournal(mkdtempSync(join(tmpdir(), 'turn-timing-')), 'bowxt:1@chatroom');
  const m = { id: 'bowxt:1', roomId: 'bowxt:1@chatroom', text: 'private text' };
  journal.receive(m); now += 10; journal.queued(m); now += 400;
  await journal.batch([m], async () => { now += 20; journal.phase('generating'); now += 200; journal.phase('typing'); now += 30; journal.phase('sending'); now += 50; journal.sent(); });
  const round = journal.recent()[0];
  assert.equal(round.totalMs, 710);
  assert.equal(round.segments.reduce((n, part) => n + part.ms, 0), round.totalMs);
  assert.equal(round.reason, 'reply_confirmed');
  assert.ok(!JSON.stringify(round).includes('private text'));
  journal.receive({ ...m, id: 'bowxt:2' });
  await journal.batch([{ ...m, id: 'bowxt:2' }], async () => journal.skip('quiet_hours'));
  assert.ok(journal.recent().some(r => r.reason === 'quiet_hours'));
});

test('interruption is not claimed as measured execution time', () => {
  const data = mkdtempSync(join(tmpdir(), 'turn-interrupt-time-'));
  const journal = createTurnJournal(data, 'bowxt:1@chatroom');
  journal.receive({ id: 'bowxt:1', roomId: 'bowxt:1@chatroom' });
  const restored = createTurnJournal(data, 'bowxt:1@chatroom');
  const round = restored.recent()[0];
  assert.equal(round.totalMs, null); assert.equal(round.includesInterruption, true);
  assert.ok(round.segments.some(s => s.ms === null));
});
