import { createHash } from 'node:crypto';

// All access goes through the bridge's GET-only query callback. Never enqueue or
// promote a business turn to completed based on a send record alone.
export async function inspectOutbound(api, chatId, requestIds, requests) {
  const selected = requestIds.slice(0, 20);
  const byId = new Map([...requests.values()].filter(r => r.requestId).map(r => [r.requestId, r]));
  let recent;
  const recentPage = () => recent ||= api(`/api/chats/${chatId}/messages?recent=1&limit=100`);
  const items = await Promise.all(selected.map(async (requestId, index) => {
    const request = byId.get(requestId);
    const base = { part: index + 1, locallyConfirmed: !!request?.completed };
    if (!request) return { ...base, status: 'no_request_record' };
    try {
      let message;
      if (Number.isSafeInteger(request.seq) && request.seq > 0) {
        message = (await api(`/api/messages/${request.seq}`)).message;
      } else {
        const result = await recentPage();
        message = result.messages?.find(m => m.chat_id === chatId && m.client_id === request.clientId);
        if (!message) return { ...base, status: request.completed ? 'local_confirmed' : 'unknown', scope: 'recent_100' };
      }
      if (!message || message.chat_id !== chatId || message.direction !== 'outgoing'
        || message.client_id !== request.clientId || typeof message.content !== 'string'
        || !request.textHash || createHash('sha256').update(message.content).digest('hex') !== request.textHash) {
        return { ...base, status: 'identity_mismatch' };
      }
      const status = ['sent', 'pending', 'failed'].includes(message.delivery_status) ? message.delivery_status : 'unknown';
      return { ...base, status, seq: message.seq };
    } catch { return { ...base, status: 'unavailable' }; }
  }));
  return { checkedAt: Date.now(), total: requestIds.length, truncated: requestIds.length > selected.length, items };
}
