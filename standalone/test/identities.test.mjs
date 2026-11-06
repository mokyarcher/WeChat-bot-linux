import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentities, displayIdentity } from '../identities.mjs';
import { normalizeMessage } from '../bowxt.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'member-identity-'));
const message = name => normalizeMessage({ seq: 1, sender: name, direction: 'incoming', content: 'fixture' }, 1, 'fixture');

test('confirmed rename preserves canonical sender across restart and unlink affects only future messages', () => {
  const data = temp(), identities = createIdentities(data, 1);
  const old = identities.apply(message('old'), true), fresh = identities.apply(message('new'), true);
  const plan = identities.preview({ action: 'link', alias: 'new', target: 'old' });
  assert.equal(plan.sourceAlreadySeen, true);
  assert.throws(() => identities.commit(plan));
  identities.commit({ ...plan, confirm: true });
  assert.equal(identities.apply(message('new')).sender, old.sender);
  assert.notEqual(fresh.sender, old.sender); // Existing observations are not rewritten.
  const restarted = createIdentities(data, 1);
  assert.equal(restarted.apply(message('new')).sender, displayIdentity(1, 'old'));
  const before = readFileSync(join(data, 'member-identities.json'));
  restarted.preview({ action: 'unlink', alias: 'new' });
  assert.deepEqual(readFileSync(join(data, 'member-identities.json')), before);
  const remove = restarted.preview({ action: 'unlink', alias: 'new' });
  restarted.commit({ ...remove, confirm: true });
  assert.equal(restarted.apply(message('new')).sender, fresh.sender);
  assert.throws(() => restarted.commit({ ...remove, confirm: true }));
});

test('mapping rejects stale previews, unknown target, cross-group store and target reassignment chains', () => {
  const data = temp(), identities = createIdentities(data, 1);
  identities.apply(message('old'), true);
  const plan = identities.preview({ action: 'link', alias: 'new', target: 'old' });
  identities.apply(message('other'), true);
  assert.throws(() => identities.commit({ ...plan, confirm: true }));
  identities.commit({ ...identities.preview({ action: 'link', alias: 'new', target: 'old' }), confirm: true });
  assert.throws(() => identities.preview({ action: 'link', alias: 'old', target: 'other' }));
  assert.throws(() => identities.preview({ action: 'link', alias: 'x', target: 'unknown' }));
  assert.throws(() => identities.preview({ action: 'link', alias: 'x\n', target: 'old' }));
  assert.throws(() => createIdentities(data, 2));
  assert.equal(identities.apply({ ...message('new'), roomId: 'bowxt:2@chatroom' }).sender, displayIdentity(1, 'new'));
});
