import { createHash } from 'node:crypto';
import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
export const displayIdentity = (chatId, name) => 'local:' + digest(chatId + '\0' + name).slice(0, 24);

export function createIdentities(dataDir, chatId) {
  const roomId = `bowxt:${chatId}@chatroom`, file = join(dataDir, 'member-identities.json');
  let names = new Set(), links = new Map(), fault = false;
  const checkName = name => {
    if (typeof name !== 'string' || !name || name !== name.trim() || name.length > 128 || /[\x00-\x1f]/.test(name)) throw new Error('昵称需为完整名称，不含前后空格或控制字符，最多 128 字符');
    return name;
  };
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version !== 1 || saved.roomId !== roomId || !Array.isArray(saved.names) || !Array.isArray(saved.links)) throw new Error('成员映射格式或群范围不符');
    names = new Set(saved.names.map(checkName)); links = new Map(saved.links);
    for (const [alias, target] of links) {
      checkName(alias); checkName(target);
      if (!names.has(target) || alias === target || links.has(target)) throw new Error('成员映射存在未知目标或循环');
    }
  }
  // Read-only seed: installing the feature does not rewrite existing business data.
  const memory = join(dataDir, 'memory', roomId.replace(/[^\w@.-]/g, '_') + '.json');
  if (existsSync(memory)) {
    const saved = JSON.parse(readFileSync(memory, 'utf8'));
    for (const m of saved.msgs || []) if (!m.isSelf && m.senderName) {
      try { names.add(checkName(m.senderName)); } catch { /* Non-identifiable display name stays unsupported. */ }
    }
  }
  const snapshot = () => ({ version: 1, roomId, names: [...names].sort(), links: [...links].sort(([a], [b]) => a.localeCompare(b)) });
  const save = () => {
    try {
      const fd = openSync(file + '.tmp', 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(snapshot())); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(file + '.tmp', file);
      if (process.platform !== 'win32') { const fd = openSync(dataDir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    } catch { fault = true; throw new Error('成员映射保存失败，请保持暂停并检查'); }
  };
  const preview = input => {
    if (fault) throw new Error('成员映射存储异常');
    const alias = checkName(input.alias);
    if (!['link', 'unlink'].includes(input.action)) throw new Error('未知映射操作');
    const target = input.action === 'unlink' ? links.get(alias) : (links.get(checkName(input.target)) || input.target);
    if (!target || !names.has(target)) throw new Error('请选择已记录的旧身份');
    if (input.action === 'link' && (alias === target || links.has(alias) || [...links.values()].includes(alias))) throw new Error('该昵称已绑定、被其他昵称引用或与目标相同，请先核对现有映射');
    const revision = digest(JSON.stringify([snapshot(), input.action, alias, target]));
    return { alias, target, action: input.action, revision, sourceId: displayIdentity(chatId, alias), targetId: displayIdentity(chatId, target),
      sourceAlreadySeen: names.has(alias), scope: '只影响此后接入的消息和查询时的身份解释；不改历史原文，不自动合并已生成的两份关系，也不处理同名成员。解除只影响后续，不撤销期间的人格/记忆变化。' };
  };
  return {
    fault: () => fault,
    list: () => ({ roomId, names: [...names].sort(), links: [...links].map(([alias, target]) => ({ alias, target })) }),
    apply(message, observe = false) {
      if (fault) throw new Error('成员映射异常，拒绝消息处理');
      if (message.roomId !== roomId || message.isSelf || !message.senderName) return message;
      const name = message.senderName;
      if (observe && !names.has(name)) {
        checkName(name); names.add(name);
        try { save(); } catch (error) { names.delete(name); throw error; }
      }
      const target = links.get(name);
      return target ? { ...message, sourceSenderId: message.sender, sender: displayIdentity(chatId, target), identityMapped: true } : message;
    },
    preview,
    commit(input) {
      if (input.confirm !== true) throw new Error('必须预览并明确确认成员映射');
      const plan = preview(input);
      if (plan.revision !== input.revision) throw new Error('成员映射预览已变化，请重新预览');
      const previous = new Map(links), previousNames = new Set(names);
      if (plan.action === 'unlink') links.delete(plan.alias); else { links.set(plan.alias, plan.target); names.add(plan.alias); }
      try { save(); } catch (error) { links = previous; names = previousNames; throw error; }
      return { ok: true, ...this.list() };
    },
  };
}
