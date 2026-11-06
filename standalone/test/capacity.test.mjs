import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createTurnJournal } from '../turns.mjs';

const roomId = 'bowxt:1@chatroom';
const message = n => ({ id: `bowxt:${n}`, roomId, typeName: 'text', text: 'private original '.repeat(1000) });
const filename = n => createHash('sha256').update(`bowxt:${n}`).digest('hex');
const setup = () => { const data = mkdtempSync(join(tmpdir(), 'turn-capacity-')); return { data, journal: createTurnJournal(data, roomId) }; };

test('archive preserves full original and duplicate suppression after restart, protects unresolved and recent work', async t => {
  const { data, journal } = setup(); const now = Date.now();
  t.mock.method(Date, 'now', () => now - 31 * 86400000);
  for (const n of [1, 2, 3]) journal.receive(message(n));
  journal.ignore(message(1), 'policy');
  await journal.batch([message(2)], async () => journal.sent());
  await journal.batch([message(3)], async () => journal.fail('send_unconfirmed'));
  t.mock.restoreAll();
  journal.receive(message(4)); journal.ignore(message(4), 'recent');
  const original = readFileSync(join(data, 'turns', filename(1) + '.json'));
  const preview = journal.capacity(); assert.equal(preview.eligible, 2);
  assert.throws(() => journal.compact({ confirm: false, previewHash: preview.previewHash }));
  assert.equal(journal.compact({ confirm: true, previewHash: preview.previewHash }).archived, 2);
  assert.deepEqual(gunzipSync(readFileSync(join(data, 'turns/archive', filename(1) + '.json.gz'))), original);
  assert.ok(!readFileSync(join(data, 'turns', filename(1) + '.json'), 'utf8').includes('private original'));
  const restored = createTurnJournal(data, roomId);
  assert.equal(restored.summary().archived, 2); assert.equal(restored.summary().needsReview, 1);
  assert.equal(restored.receive(message(1)), false); assert.equal(restored.receive(message(2)), false);
  assert.equal(restored.capacity().activeRecords, 2); assert.equal(restored.capacity().eligible, 0);
  assert.throws(() => restored.compact({ confirm: true, previewHash: preview.previewHash }));
});

test('changed previews and externally edited records are refused before archiving', async t => {
  const { data, journal } = setup(), now = Date.now();
  t.mock.method(Date, 'now', () => now - 32 * 86400000);
  journal.receive(message(1)); journal.ignore(message(1), 'policy');
  t.mock.restoreAll(); const preview = journal.capacity();
  journal.receive(message(2)); journal.queued(message(2));
  assert.throws(() => journal.compact({ confirm: true, previewHash: preview.previewHash }));
  journal.ignore(message(2), 'policy');
  const file = join(data, 'turns', filename(1) + '.json');
  const record = JSON.parse(readFileSync(file)); record.reason = 'external'; writeFileSync(file, JSON.stringify(record));
  assert.throws(() => journal.capacity());
  assert.equal(readdirSync(join(data, 'turns')).filter(n => n.endsWith('.json')).length, 2);
});

test('partial archive failure never discards the original and corrupt archives fail closed', async t => {
  const { data, journal } = setup(), now = Date.now();
  t.mock.method(Date, 'now', () => now - 32 * 86400000);
  journal.receive(message(1)); journal.ignore(message(1), 'policy');
  t.mock.restoreAll(); const preview = journal.capacity();
  const archive = join(data, 'turns/archive'); mkdirSync(archive);
  mkdirSync(join(archive, filename(1) + '.json.gz'));
  assert.throws(() => journal.compact({ confirm: true, previewHash: preview.previewHash }));
  assert.equal(journal.summary().fault, true);
  assert.ok(JSON.parse(readFileSync(join(data, 'turns', filename(1) + '.json'))).message);
  // Independent successful archive, then damage its compressed payload.
  const next = setup();
  t.mock.method(Date, 'now', () => now - 32 * 86400000);
  next.journal.receive(message(1)); next.journal.ignore(message(1), 'policy'); t.mock.restoreAll();
  next.journal.compact({ confirm: true, previewHash: next.journal.capacity().previewHash });
  writeFileSync(join(next.data, 'turns/archive', filename(1) + '.json.gz'), 'corrupt');
  assert.throws(() => createTurnJournal(next.data, roomId));
  assert.throws(() => next.journal.receive(message(1)));
});
