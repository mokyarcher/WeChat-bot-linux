import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readMessagePage } from './history.mjs';

export function normalizeMessage(message, chatId, roomName) {
  const senderName = message.sender || '';
  const isSelf = message.direction === 'outgoing';
  // bowxt currently exposes display names. Scope them to the chat to avoid cross-group merges.
  const sender = isSelf ? 'linux-bot' : senderName
    ? 'local:' + createHash('sha256').update(chatId + '\0' + senderName).digest('hex').slice(0, 24) : '';
  return { id: 'bowxt:' + message.seq, roomId: `bowxt:${chatId}@chatroom`, roomName,
    sender, senderName: isSelf ? '我' : senderName, isSelf, isGroup: true,
    type: 1, typeName: 'text', text: message.content || '', content: message.content || '',
    // Linux UI timestamps are shared group separators, not per-message send times.
    ts: Date.parse(message.observed_at) || Date.parse(message.timestamp) || Date.now(),
    observedAt: Date.parse(message.observed_at) || null, sourceTs: Date.parse(message.timestamp) || null,
    seq: message.seq, timeBasis: 'observed', isAtMe: !!message.is_at_me };
}

export function installBridge(BridgeClient, settings) {
  const clients = new Set();
  const roomId = `bowxt:${settings.chatId}@chatroom`;
  const bindingFile = settings.dataDir ? join(settings.dataDir, 'chat-binding.json') : null;
  let binding = bindingFile && existsSync(bindingFile) ? JSON.parse(readFileSync(bindingFile, 'utf8')) : { name: settings.roomName };
  settings.roomName = binding.name;
  let consumer = 'standalone-soul-v1';
  const counters = { msgsIn: 0, msgsOut: 0 };
  const requestFile = settings.dataDir ? join(settings.dataDir, 'send-requests.json') : null;
  const requests = new Map(requestFile && existsSync(requestFile) ? JSON.parse(readFileSync(requestFile, 'utf8')) : []);
  function saveRequests() {
    if (!requestFile) return;
    writeFileSync(requestFile + '.tmp', JSON.stringify([...requests]), { mode: 0o600 });
    renameSync(requestFile + '.tmp', requestFile);
  }
  let polling = false;
  let backendConnected = null;
  let generation = 0;
  let claimAbort;
  let timer;
  async function api(path, body, method = 'POST', signal) {
    const response = await fetch(settings.baseUrl + path, {
      method: body === undefined ? 'GET' : method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Linux 接入服务 HTTP ' + response.status);
    return response.json();
  }
  const status = () => ({ loggedIn: backendConnected, self: 'linux-bot', mock: false, counters,
    stickers: { count: 0 }, polling, identityScope: 'group-display-name' });
  async function tick(epoch) {
    if (!polling || epoch !== generation) return;
    if (!clients.size) { timer = setTimeout(() => void tick(epoch), 250); return; }
    const activeConsumer = consumer;
    const started = Date.now();
    let failed = false;
    const controller = new AbortController();
    claimAbort = controller;
    try {
      const result = await api(`/api/agents/${activeConsumer}/claim`, {
        chat_ids: [settings.chatId], limit: 10, lease_seconds: 60, timeout: 10,
        require_sender: true, require_at_me: false, replay_existing: false,
      }, 'POST', controller.signal);
      for (const delivery of result.deliveries || []) {
        // A paused or replaced subscription must never dispatch a stale claim.
        if (!polling || epoch !== generation) return;
        const message = delivery.message;
        // Refuse unexpected rooms even if the backend ignores the subscription filter.
        if (message.chat_id !== settings.chatId) throw new Error('接入服务返回了非白名单群消息');
        if (message.message_type === 'text') {
          const normalized = normalizeMessage(message, settings.chatId, settings.roomName);
          counters.msgsIn++;
          for (const client of clients) client.onEvent({ t: 'msg', m: normalized });
        }
        await api(`/api/agents/${activeConsumer}/deliveries/${message.seq}/ack`, { lease_token: delivery.lease_token }, 'POST', controller.signal);
      }
    } catch (error) {
      failed = true;
      if (!controller.signal.aborted) settings.log('接入轮询：' + error.message);
    } finally {
      if (claimAbort === controller) claimAbort = undefined;
      if (polling && epoch === generation) {
        // Real long polls wait on backend events. Bound fast empty responses and
        // failures as well, so a misbehaving backend cannot cause a busy loop.
        const delay = failed ? 1500 : Math.max(0, 100 - (Date.now() - started));
        timer = setTimeout(() => void tick(epoch), delay);
      }
    }
  }
  BridgeClient.prototype.connect = function () {
    this.closed = false;
    this.connected = true;
    this._status.connected = true;
    clients.add(this);
    queueMicrotask(() => {
      this.onEvent({ t: 'ws-open' });
      this.onEvent({ t: 'hello', status: status(), counters, mock: false });
    });
  };
  BridgeClient.prototype.close = function () {
    this.closed = true;
    this.connected = false;
    this._status.connected = false;
    clients.delete(this);
  };
  BridgeClient.prototype.call = async function (op, args = {}) {
    if (args.roomId && args.roomId !== roomId) throw new Error('目标群不在 Linux 白名单');
    if (op === 'identify') return { ok: true };
    if (op === 'status') {
      try { backendConnected = !!(await api('/api/status')).wechat_connected; }
      catch { backendConnected = null; }
      return status();
    }
    if (op === 'pollStatus') return { paused: !polling, hardStopped: false };
    if (op === 'rooms') return [{ roomId, name: settings.roomName }];
    if (op === 'members') return { members: [], selfWxid: 'linux-bot', nameMap: {} };
    if (op === 'stickers') return { stickers: [], count: 0 };
    if (op === 'pickSticker') return null;
    if (op === 'history' || op === 'searchMessages') {
      const result = await api(`/api/chats/${settings.chatId}/messages?recent=1&limit=100`);
      const items = (result.messages || [])
        .filter(message => message.message_type === 'text' && ['incoming', 'outgoing'].includes(message.direction))
        .map(message => normalizeMessage(message, settings.chatId, settings.roomName))
        .sort((a, b) => a.seq - b.seq);
      const selected = args.query ? items.filter(item => item.text.includes(args.query)) : items;
      // Upstream searchMessages returns newest first; the plugin reverses it when seeding context.
      return op === 'history' ? selected : { items: selected.reverse() };
    }
    if (op === 'sendText') {
      if (!polling) throw new Error('自动发送尚未启用');
      if (!args.text?.trim()) throw new Error('回复正文为空');
      // Stable idempotency key protects retries after HTTP response loss.
      const signature = createHash('sha256').update(roomId + '\0' + args.text + (args.requestId ? '\0' + args.requestId : '')).digest('hex');
      let request = requests.get(signature);
      if (!request || (!args.requestId && request.completed && Date.now() - request.createdAt > 60000)) {
        for (const [key, previous] of requests) {
          if (!previous.manual && previous.completed && Date.now() - previous.createdAt > 60000) requests.delete(key);
        }
        request = { clientId: randomUUID(), createdAt: Date.now(), completed: false, manual: !!args.requestId };
        requests.set(signature, request);
        saveRequests();
      }
      const queued = await api(`/api/chats/${settings.chatId}/messages`, { text: args.text, client_id: request.clientId });
      let message = queued.message;
      const deadline = Date.now() + 25000;
      while (message.delivery_status === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 700));
        message = (await api(`/api/messages/${message.seq}`)).message;
      }
      if (message.delivery_status !== 'sent') throw new Error('发送状态待核查：' + message.delivery_status);
      request.completed = true;
      saveRequests();
      counters.msgsOut++;
      return { rc: 0, verified: true };
    }
    throw new Error('Linux 首期尚未支持操作：' + op);
  };
  return {
    roomId, status,
    messagePage(options) {
      return readMessagePage(api, settings.chatId, m => normalizeMessage(m, settings.chatId, settings.roomName), options);
    },
    roomBinding() { return { ...binding, roomId, chatId: settings.chatId }; },
    async renameRoom(expectedName, name) {
      if (polling) throw new Error('请先暂停回复再修改群名');
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 128 || /[\x00-\x1f]/.test(name)) throw new Error('群名无效');
      name = name.trim();
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline) {
        const state = await api('/api/status');
        if (!state.paused) throw new Error('接入未暂停，拒绝修改');
        if (state.worker_paused && !state.queue_depth) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error('UI 工作线程未安全暂停，请检查待发送任务');
      const path = `/api/chats/${settings.chatId}`;
      await api(path, { name, expected_name: expectedName }, 'PATCH');
      const next = { name, previousName: expectedName };
      try {
        if (!bindingFile) throw new Error('未配置持久化目录');
        writeFileSync(bindingFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
        renameSync(bindingFile + '.tmp', bindingFile);
      } catch (error) {
        try { await api(path, { name: expectedName, expected_name: name }, 'PATCH'); }
        catch { throw new Error('保存失败且回退未确认，请保持暂停并检查群配置'); }
        throw error;
      }
      binding = next; settings.roomName = name;
      return this.roomBinding();
    },
    async inspect() {
      try {
        const [state, chats] = await Promise.all([api('/api/status'), api('/api/chats')]);
        return { state, chats: chats.chats || [] };
      } catch (error) { return { error: error.message }; }
    },
    async enable(enabled) {
      polling = false;
      const epoch = ++generation;
      clearTimeout(timer);
      claimAbort?.abort();
      const startedAt = Date.now() / 1000;
      await api('/api/control', { mode: enabled ? 'polling' : 'paused' }, 'PATCH');
      if (!enabled) return;
      try {
        const deadline = Date.now() + 30000;
        let ready = false;
        while (Date.now() < deadline) {
          const state = await api('/api/status');
          if (state.last_error) throw new Error(state.last_error);
          if (state.wechat_connected && state.last_poll_completed_at > startedAt) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!ready) throw new Error('微信首次同步超时，请检查登录和测试群');
        // A fresh consumer starts after the initial viewport snapshot, avoiding replies to old bubbles.
        consumer = 'standalone-soul-' + randomUUID();
        await api(`/api/agents/${consumer}/claim`, { chat_ids: [settings.chatId], limit: 1,
          lease_seconds: 60, timeout: 0, require_sender: true, replay_existing: false });
        if (epoch !== generation) return;
        polling = true;
        void tick(epoch);
      } catch (error) {
        await api('/api/control', { mode: 'paused' }, 'PATCH');
        throw error;
      }
    },
    close() { polling = false; generation++; clearTimeout(timer); claimAbort?.abort(); for (const client of [...clients]) client.close(); },
  };
}
