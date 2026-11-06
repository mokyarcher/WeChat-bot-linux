export async function readMessagePage(api, chatId, normalize, { before, query = '', limit = 50, since, until } = {}) {
  const parseBound = value => {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('日期边界需为标准 UTC 时间');
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('日期边界无效');
    return time;
  };
  const start = parseBound(since), end = parseBound(until);
  if (start !== null && end !== null && start >= end) throw new Error('开始日期必须早于结束边界');
  limit = Number(limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每页条数需为 1–100');
  if (before !== undefined && (!Number.isSafeInteger(Number(before)) || Number(before) <= 0)) throw new Error('历史游标无效');
  if (typeof query !== 'string' || query.length > 200) throw new Error('搜索词过长');
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set('before', String(before)); else params.set('recent', '1');
  const result = await api(`/api/chats/${chatId}/messages?${params}`);
  const raw = result.messages || [];
  if (raw.some(m => m.chat_id !== chatId)) throw new Error('历史记录包含非目标群');
  const textMessages = raw.filter(m => m.message_type === 'text' && ['incoming', 'outgoing'].includes(m.direction));
  const timed = textMessages.map(m => ({ ...normalize(m), receivedAt: Number.isFinite(Date.parse(m.observed_at)) ? Date.parse(m.observed_at) : null }));
  const items = timed.filter(m => (!query || m.text.includes(query)) &&
    ((start === null && end === null) || (m.receivedAt !== null && (start === null || m.receivedAt >= start) && (end === null || m.receivedAt < end))))
    .sort((a, b) => b.seq - a.seq);
  return { items, scanned: raw.length, nextBefore: raw.length === limit ? Math.min(...raw.map(m => m.seq)) : null,
    unknownTimeCount: timed.filter(m => m.receivedAt === null).length, since: since || null, until: until || null,
    scope: '仅查询接入服务已经记录的消息；关键词与日期逐页匹配。日期为首次接收时间，开始含边界、结束不含边界；未知接收时间不参与日期匹配。' };
}
