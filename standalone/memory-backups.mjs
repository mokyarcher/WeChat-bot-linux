import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function createMemoryBackups(data, roomId) {
  const parent = join(data, 'memory-snapshots');
  const file = roomId.replace(/[^\w@.-]/g, '_') + '.json';
  const current = join(data, 'facts', file);

  function readFacts(path) {
    const bytes = readFileSync(path);
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('记忆文件超过快照大小限制');
    const facts = JSON.parse(bytes);
    if (!Array.isArray(facts) || facts.length > 50000 || facts.some(x => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.text !== 'string' || !x.text.trim())) {
      throw new Error('记忆文件格式无效');
    }
    const ids = facts.map(x => x.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error('记忆文件含重复 ID，拒绝快照');
    return { bytes, facts };
  }

  function saveCurrent(op, restoredFrom) {
    if (!existsSync(current)) throw new Error('当前群尚无记忆文件，无法创建快照');
    readFacts(current);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(parent, Date.now() + '-'));
    copyFileSync(current, join(dir, file));
    writeFileSync(join(dir, 'operation.json'), JSON.stringify({ op, at: new Date().toISOString(), roomId, restoredFrom }), { mode: 0o600 });
    return dir.split(/[\\/]/).at(-1);
  }

  function read(id) {
    if (typeof id !== 'string' || !/^\d{13}-[a-zA-Z0-9]{6}$/.test(id)) throw new Error('快照标识无效');
    const target = realpathSync(join(parent, id, file));
    const rel = relative(realpathSync(parent), target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('快照路径不在允许目录');
    const { bytes, facts } = readFacts(target);
    let operation;
    try { operation = JSON.parse(readFileSync(join(parent, id, 'operation.json'), 'utf8')); } catch { throw new Error('快照信息缺失或损坏'); }
    if (operation.roomId !== roomId) throw new Error('快照所属群不匹配');
    return { bytes, facts, digest: hash(bytes), operation };
  }

  function preview(id) {
    const saved = read(id);
    const facts = saved.facts;
    return { id, at: saved.operation.at, op: saved.operation.op || '未记录操作', snapshotHash: saved.digest,
      currentHash: existsSync(current) ? hash(readFileSync(current)) : null,
      summary: { total: facts.length, active: facts.filter(x => !x.archived).length, archived: facts.filter(x => x.archived).length, pinned: facts.filter(x => x.pinned).length,
        samples: facts.filter(x => !x.archived).slice(-5).map(x => x.text.slice(0, 160)) } };
  }

  return {
    create() { return { ok: true, id: saveCurrent('memory.manualSnapshot') }; },
    list() {
      if (!existsSync(parent)) return [];
      const items = [];
      for (const id of readdirSync(parent).filter(x => /^\d{13}-[a-zA-Z0-9]{6}$/.test(x)).sort().reverse().slice(0, 200)) {
        try { items.push(preview(id)); } catch { /* exclude damaged and foreign-room snapshots */ }
        if (items.length === 50) break;
      }
      return items;
    },
    preview,
    restore({ id, currentHash, snapshotHash }, apply) {
      const saved = read(id);
      if (!currentHash || !existsSync(current) || hash(readFileSync(current)) !== currentHash) throw new Error('当前记忆已变化，请重新预览后恢复');
      if (saved.digest !== snapshotHash) throw new Error('快照内容已变化，请重新预览');
      const before = saveCurrent('memory.snapshotRestore', id);
      apply(saved.facts, roomId);
      return { ok: true, roomId, restored: saved.facts.length, savedCurrentAs: before };
    },
  };
}
