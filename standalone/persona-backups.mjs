import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function createPersonaBackups(data, roomId) {
  const parent = join(data, 'persona-backups');
  const file = roomId.replace(/[^\w@.-]/g, '_') + '.json';
  const current = join(data, 'persona', file);
  function saveCurrent(op, restoredFrom) {
    if (!existsSync(current)) throw new Error('当前人格尚未初始化，请先读取内心状态');
    const state = JSON.parse(readFileSync(current));
    if (state.roomId !== roomId) throw new Error('当前人格所属群不匹配');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const backup = mkdtempSync(join(parent, Date.now() + '-'));
    copyFileSync(current, join(backup, file));
    writeFileSync(join(backup, 'operation.json'), JSON.stringify({ op, at: new Date().toISOString(), roomId, restoredFrom }), { mode: 0o600 });
    return backup.split(/[\\/]/).at(-1);
  }
  const summary = state => ({ likes: state.tastes.likes.map(x => x.text).slice(0, 10), dislikes: state.tastes.dislikes.map(x => x.text).slice(0, 10), diaryCount: state.diary.length, diaryTitles: state.diary.slice(0, 3).map(x => x.title || '无题'), goals: (state.goals || []).map(x => x.text), narrativeVersion: state.narrative?.version || 0 });
  function read(id) {
    if (typeof id !== 'string' || !/^\d{13}-[a-zA-Z0-9]{6}$/.test(id)) throw new Error('备份标识无效');
    const target = realpathSync(join(parent, id, file));
    const rel = relative(realpathSync(parent), target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('备份路径不在允许目录');
    const bytes = readFileSync(target);
    const state = JSON.parse(bytes);
    if (state.roomId !== roomId || !Number.isFinite(state.schema) || !Number.isFinite(state.energy) || !Number.isFinite(state.mood?.valence) || !Array.isArray(state.tastes?.likes) || !Array.isArray(state.tastes?.dislikes) || !Array.isArray(state.diary)) throw new Error('备份格式或所属群不匹配');
    return { state, digest: hash(bytes) };
  }
  function preview(id) {
    const value = read(id);
    let operation = {};
    try { operation = JSON.parse(readFileSync(join(parent, id, 'operation.json'), 'utf8')); } catch { /* older snapshot */ }
    return { id, at: operation.at || new Date(Number(id.slice(0, 13))).toISOString(), op: operation.op || '未记录操作', snapshotHash: value.digest,
      currentHash: existsSync(current) ? hash(readFileSync(current)) : null, summary: summary(value.state) };
  }
  return {
    preview,
    create() { return { ok: true, id: saveCurrent('persona.manualSnapshot') }; },
    list() {
      if (!existsSync(parent)) return [];
      const items = [];
      for (const id of readdirSync(parent).filter(x => /^\d{13}-[a-zA-Z0-9]{6}$/.test(x)).sort().reverse().slice(0, 200)) {
        try { items.push(preview(id)); } catch { /* exclude damaged and foreign-room snapshots */ }
        if (items.length === 50) break;
      }
      return items;
    },
    restore({ id, currentHash, snapshotHash }, apply) {
      const value = read(id);
      if (!currentHash || !existsSync(current) || hash(readFileSync(current)) !== currentHash) throw new Error('当前人格已变化，请重新预览后恢复');
      if (value.digest !== snapshotHash) throw new Error('备份内容已变化，请重新预览');
      const backup = saveCurrent('persona.snapshotRestore', id);
      apply(value.state);
      return { ok: true, roomId, savedCurrentAs: backup };
    },
  };
}
