import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const terminal = new Set(['completed', 'skipped', 'needs_review']);
const hash = text => createHash('sha256').update(text).digest('hex');

// Private runtime data, deliberately separate from the source checkout and Git.
export function createTurnJournal(dataDir, roomId) {
  const dir = join(dataDir, 'turns');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const records = new Map();
  const scope = new AsyncLocalStorage();
  let active = 0;
  let fault = false;
  function save(record) {
    const file = join(dir, hash(record.id) + '.json');
    try {
      const fd = openSync(file + '.tmp', 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(file + '.tmp', file);
      // Persist the rename too. Windows does not support opening directories this way.
      if (process.platform !== 'win32') {
        const fd = openSync(dir, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      records.set(record.id, record);
    } catch { fault = true; throw new Error('轮次记录写入失败，停止消费；请检查数据目录'); }
  }
  for (const name of readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (record.version !== 1 || record.roomId !== roomId || hash(record.id) + '.json' !== name
      || !['received', 'queued', 'processing', ...terminal].includes(record.state)) throw new Error('轮次记录格式或群范围不符，拒绝启动');
    records.set(record.id, record);
    if (!terminal.has(record.state)) save({ ...record, state: 'needs_review', reason: 'interrupted', updatedAt: Date.now() });
  }
  const change = (ids, patch) => {
    for (const id of ids) {
      const record = records.get(id);
      if (!record) throw new Error('轮次尚未持久化');
      save({ ...record, ...patch, updatedAt: Date.now() });
    }
  };
  const inScope = () => scope.getStore();
  return {
    receive(message) {
      if (fault) throw new Error('轮次存储异常，拒绝消费');
      if (message.roomId !== roomId || !message.id) throw new Error('轮次群范围或消息标识无效');
      if (records.has(message.id)) return false;
      save({ version: 1, id: message.id, roomId, message, state: 'received', receivedAt: Date.now(), updatedAt: Date.now() });
      return true;
    },
    async ingest(message, fn) {
      active++;
      try {
        await fn(message);
        if (records.get(message.id)?.state === 'received') change([message.id], { state: 'skipped', reason: 'not_queued' });
      } catch (error) {
        change([message.id], { state: 'needs_review', reason: 'ingest_failed' });
        throw error;
      } finally { active--; }
    },
    queued(message) { change([message.id], { state: 'queued', phase: 'debounce' }); },
    ignore(message, reason) { change([message.id], { state: 'skipped', reason }); },
    async batch(messages, fn) {
      const ids = messages.map(message => message.id);
      const batchId = hash(JSON.stringify([roomId, ids]));
      const context = { ids, batchId, part: 0, sent: 0, failed: false, tasks: [], closed: false };
      active++;
      try {
        change(ids, { state: 'processing', phase: 'decision', batchId });
        return await scope.run(context, async () => {
          try { return await fn(); }
          catch (error) { context.failed = true; throw error; }
          finally {
            // Memory extraction remains off the send path, but belongs to completion.
            await Promise.allSettled(context.tasks);
            context.closed = true;
            change(ids, { state: context.failed ? 'needs_review' : context.sent ? 'completed' : 'skipped',
              phase: 'finished', reason: context.failed ? 'processing_failed' : context.sent ? 'reply_confirmed' : context.reason || 'policy_or_empty_reply' });
          }
        });
      } finally { active--; }
    },
    phase(phase) { const c = inScope(); if (c && !c.closed) change(c.ids, { phase }); },
    fail(reason) { const c = inScope(); if (c && !c.closed) { c.failed = true; change(c.ids, { phase: reason, failureStage: reason }); } },
    skip(reason) { const c = inScope(); if (c && !c.closed) c.reason = reason; },
    outboundId() {
      const c = inScope();
      if (!c || c.closed) return `operation:${randomUUID()}`;
      const requestId = `turn:${c.batchId}:part:${c.part++}`;
      for (const id of c.ids) {
        const record = records.get(id);
        change([id], { outboundIds: [...(record.outboundIds || []), requestId] });
      }
      return requestId;
    },
    sent() { const c = inScope(); if (c && !c.closed) { c.sent++; change(c.ids, { phase: 'send_confirmed' }); } },
    task(fn) {
      const c = inScope();
      active++;
      const promise = Promise.resolve().then(fn).catch(error => { if (c && !c.closed) c.failed = true; throw error; }).finally(() => { active--; });
      if (c && !c.closed) c.tasks.push(promise);
      return promise;
    },
    summary() {
      const counts = {};
      for (const record of records.values()) counts[record.state] = (counts[record.state] || 0) + 1;
      return { active, pending: (counts.received || 0) + (counts.queued || 0) + (counts.processing || 0), needsReview: counts.needs_review || 0, fault, counts };
    },
    list() {
      return [...records.values()].filter(r => r.state === 'needs_review').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100)
        .map(({ id, batchId, state, phase, failureStage, reason, receivedAt, updatedAt }) => ({ id, batchId, state, phase, failureStage, reason, receivedAt, updatedAt }));
    },
    outbound(id) {
      const record = records.get(id);
      if (!record || record.state !== 'needs_review') throw new Error('未找到当前群待核查轮次，请刷新列表');
      return [...(record.outboundIds || [])];
    },
    resolve({ id, updatedAt, confirm }) {
      const record = records.get(id);
      if (confirm !== true || !record || record.state !== 'needs_review' || record.updatedAt !== updatedAt) throw new Error('请刷新并确认待核查轮次');
      change([id], { state: 'skipped', reason: 'manually_reviewed', reviewedAt: Date.now() });
      return { ok: true };
    },
  };
}
