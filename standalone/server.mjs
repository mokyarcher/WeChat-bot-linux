import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModelService } from './model.mjs';
import { installBridge } from './bowxt.mjs';
import { buildLinuxHealth } from './health.mjs';
import { createServiceHealth } from './service-health.mjs';
import { createPersonaBackups } from './persona-backups.mjs';
import { createMemoryBackups } from './memory-backups.mjs';
import { createTurnJournal } from './turns.mjs';
import { MODEL_PRESETS, findPreset, resolveModelConfig } from './presets.mjs';

const root = resolve(process.env.BOT_ROOT || '..');
const data = resolve(process.env.BOT_DATA || './data');
mkdirSync(data, { recursive: true });
process.env.DSH_HOME = data;
const modelFile = join(data, 'model.json');
let model = existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : {};
const pluginDir = join(root, 'upstream/wechat-bot/wechat-group-agent/lib');
const { BridgeClient } = await import(pathToFileURL(join(pluginDir, 'bridge-client.mjs')));
const log = message => console.log(new Date().toISOString(), message);
const lifecycle = createTurnJournal(data, `bowxt:${Number(process.env.BOWXT_CHAT_ID || 1)}@chatroom`);
const bridge = installBridge(BridgeClient, {
  baseUrl: process.env.BOWXT_URL || 'http://127.0.0.1:8787',
  chatId: Number(process.env.BOWXT_CHAT_ID || 1), roomName: process.env.BOWXT_CHAT_NAME || '小鲸鱼调教', dataDir: data, log, lifecycle,
});
const routes = [];
const cleanup = [];
const tools = new Map();
const hooks = new Map();
const publicOrigin = process.env.PUBLIC_ORIGIN || '';
let roomMaintenance = false;
let personaWriteBusy = false;
let memoryWriteBusy = false;
const serviceHealth = createServiceHealth({ enabled: process.env.DESKTOP_HEALTHCHECKS === '1' });
const personaBackups = createPersonaBackups(data, bridge.roomId);
const memoryBackups = createMemoryBackups(data, bridge.roomId);
const personaWrites = new Set(['persona.diaryWrite', 'persona.tasteAdd', 'persona.tasteRemove', 'persona.goalReroll', 'persona.narrativeWrite', 'persona.narrativeRestore', 'persona.traitsReset', 'persona.selfReview']);
const memoryWrites = new Set(['memory.add', 'memory.extract', 'memory.pin', 'memory.review', 'memory.sweep', 'memory.archive', 'memory.purge']);
const supportedActions = new Set(['status', 'rooms', 'members', 'history', 'searchMessages', 'memory.list',
  'memory.add', 'memory.extract', 'memory.pin', 'memory.review', 'memory.sweep', 'memory.archive', 'memory.purgePreview', 'memory.purge',
  'persona.state', 'persona.traits', 'persona.load', 'persona.astro', 'outbox.stats', 'sendText', ...personaWrites]);
const editableConfig = new Set(['enabled', 'persona', 'personaLore', 'personaExamples', 'botName', 'aliases',
  'masterName', 'replyProbability', 'minReplyGapMs', 'maxRepliesPer10Min', 'quietHours', 'memoryExtract',
  'temperature', 'maxTokens', 'debounceMs', 'typingDelayScale',
  'repeatWindowMs', 'conversationWindowMs', 'continuationChance', 'maxConsecutiveTurns',
  'cannedChance', 'contextMessages', 'backfillLimit', 'splitChance', 'maxLines',
  'maxPartsLimit', 'splitHardMax', 'longBubbleMax']);
const ctx = {
  standaloneLifecycle: lifecycle,
  standaloneRoom: () => ({ roomId: bridge.roomId, name: bridge.roomBinding().name }),
  logger: { info: log },
  on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); },
  emit(name, ...args) { return hooks.get(name)?.(...args); },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); },
  get(name) { return this[name]; },
  agentDefaultModel: { currentSelection: () => ({ provider: 'standalone', model: model.model || 'unconfigured' }) },
  llm: createModelService(() => model),
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
  webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } },
  connection: { requestRejection({ headers }) {
    const host = headers.host || '';
    const isPublic = publicOrigin && host === new URL(publicOrigin).host;
    if (!isPublic && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return 403;
    if (headers.origin && headers.origin !== (isPublic ? publicOrigin : 'http://' + host)) return 403;
  } },
};
async function waitForSafePause() {
  if (bridge.status().polling) return false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const backend = await bridge.inspect();
    if (!backend.state?.paused) throw new Error('接入暂停状态未确认，拒绝操作');
    if (backend.state.worker_paused && !backend.state.queue_depth && !bridge.status().polling
      && !lifecycle.summary().active && !lifecycle.summary().pending && !lifecycle.summary().fault) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
const { apply } = await import(pathToFileURL(join(pluginDir, 'index.js')));
apply(ctx, {
  bridgeUrl: 'bowxt://local', enabled: true, rooms: [bridge.roomId], autoOpenPanel: false,
  botName: '小鲸鱼',
  memoryDir: join(data, 'memory'), logFile: join(data, 'bot.log'),
  memoryScope: 'room', memoryCrossGroup: 'none',
  debounceMs: 400, typingDelayScale: 0.25,
  proactive: false, humanProactiveTopic: false, momentAuto: false, momentFromChat: false,
  douyinShare: false, petSync: false, voiceModelOn: false, voiceSay: false,
  visionOnImage: false, visionOnEmoticon: false, visionOnVideo: false, voiceOnVoice: false,
  linkVideo: false, stickerChance: 0, genStickerChance: 0,
});

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new Error('请求过大');
  }
  return JSON.parse(text || '{}');
}
const server = http.createServer(async (req, res) => {
  try {
    if (ctx.connection.requestRejection(req)) return json(res, 403, { error: '拒绝跨站访问' });
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/runtime/turns' && req.method === 'GET') return json(res, 200, { summary: lifecycle.summary(), items: lifecycle.list() });
    if (path === '/runtime/turns/resume' && req.method === 'POST') {
      const input = await readJson(req);
      if (!bridge.status().polling || roomMaintenance || personaWriteBusy || memoryWriteBusy) return json(res, 409, { error: '请先启用机器人，并等待维护或编辑任务完成' });
      if (typeof ctx.resumeStandaloneQueued !== 'function') throw new Error('业务层未接通续处理');
      return json(res, 200, await lifecycle.resume(input, ctx.resumeStandaloneQueued));
    }
    if (path === '/runtime/turns/outbound' && req.method === 'GET') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      return json(res, 200, await bridge.inspectOutbound(lifecycle.outbound(id)));
    }
    if (path === '/runtime/turns/resolve' && req.method === 'POST') {
      const input = await readJson(req);
      if (!await waitForSafePause()) return json(res, 409, { error: '请先暂停，并等待业务与微信操作空闲' });
      return json(res, 200, lifecycle.resolve(input));
    }
    if (path === '/runtime/persona-backups/create' && req.method === 'POST') {
      await readJson(req);
      if (personaWriteBusy) return json(res, 409, { error: '请等待当前人格编辑完成' });
      return json(res, 200, personaBackups.create());
    }
    if (path === '/runtime/persona-backups' && req.method === 'GET') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      return json(res, 200, id ? personaBackups.preview(id) : { items: personaBackups.list() });
    }
    if (path === '/runtime/persona-backups/restore' && req.method === 'POST') {
      const input = await readJson(req);
      if (input.confirm !== true || bridge.status().polling || personaWriteBusy || roomMaintenance) return json(res, 409, { error: '请先暂停回复，并等待其他人格编辑完成后确认恢复' });
      if (!await waitForSafePause()) return json(res, 409, { error: '业务轮次或 UI 尚未安全暂停' });
      if (typeof ctx.restoreStandalonePersona !== 'function') throw new Error('当前业务未接通人格恢复');
      personaWriteBusy = true;
      try {
        const deadline = Date.now() + 20000;
        let idle = false;
        while (Date.now() < deadline) {
          const backend = await bridge.inspect();
          if (!backend.state?.paused) throw new Error('接入暂停状态未确认，拒绝恢复');
          if (backend.state.worker_paused && !backend.state.queue_depth) { idle = true; break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!idle) throw new Error('UI 尚未安全暂停，请核对待发送任务');
        return json(res, 200, personaBackups.restore(input, ctx.restoreStandalonePersona));
      }
      finally { personaWriteBusy = false; }
    }
    if (path === '/runtime/memory-backups' && req.method === 'GET') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      return json(res, 200, id ? memoryBackups.preview(id) : { items: memoryBackups.list() });
    }
    if (path === '/runtime/memory-backups/create' && req.method === 'POST') {
      await readJson(req);
      if (memoryWriteBusy || personaWriteBusy || roomMaintenance) return json(res, 409, { error: '请等待当前记忆或人格操作完成' });
      memoryWriteBusy = true;
      try {
        const idle = await waitForSafePause();
        if (!idle) return json(res, 409, { error: '接入尚未安全暂停，未创建快照' });
        return json(res, 200, memoryBackups.create());
      } finally { memoryWriteBusy = false; }
    }
    if (path === '/runtime/memory-backups/restore' && req.method === 'POST') {
      const input = await readJson(req);
      if (input.confirm !== true || memoryWriteBusy || personaWriteBusy || roomMaintenance) return json(res, 409, { error: '请先暂停回复，并等待记忆或人格操作完成后确认恢复' });
      memoryWriteBusy = true;
      try {
        if (!await waitForSafePause()) throw new Error('UI 尚未安全暂停，请核对待发送任务');
        if (typeof ctx.restoreStandaloneMemory !== 'function') throw new Error('当前业务未接通记忆恢复');
        return json(res, 200, memoryBackups.restore(input, ctx.restoreStandaloneMemory));
      } finally { memoryWriteBusy = false; }
    }
    if (path === '/runtime/messages' && req.method === 'GET') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      return json(res, 200, await bridge.messagePage({ before: params.get('before') || undefined, query: params.get('query') || '', limit: params.get('limit') || 50, since: params.get('since') || undefined, until: params.get('until') || undefined }));
    }
    if (path === '/runtime/room' && req.method === 'GET') return json(res, 200, bridge.roomBinding());
    if (path === '/runtime/room' && req.method === 'POST') {
      if (roomMaintenance) throw new Error('正在维护群配置，请稍后重试');
      const { expectedName, name } = await readJson(req);
      roomMaintenance = true;
      try { return json(res, 200, await bridge.renameRoom(expectedName, name)); }
      finally { roomMaintenance = false; }
    }
    const inspect = async (force = false) => {
      const [snapshot, services] = await Promise.all([bridge.inspect(), serviceHealth(force)]);
      return { snapshot, services, health: buildLinuxHealth({ ...snapshot, services }, { ...bridge.status(), chatId: Number(process.env.BOWXT_CHAT_ID || 1) }, { hasKey: !!model.apiKey }) };
    };
    const health = async (force = false) => (await inspect(force)).health;
    if (path === '/runtime/diagnostics' && req.method === 'GET') {
      const result = await inspect(true);
      return json(res, 200, { health: result.health, services: result.services, backend: result.snapshot.state || null,
        room: bridge.roomBinding(), bridge: bridge.status(), process: { uptimeSeconds: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576), node: process.version } });
    }
    if (path === '/wechat-bot/api/state' && req.method === 'GET') {
      let body, code;
      const capture = { writeHead(status) { code = status; }, end(value) { body = value; } };
      await routes.find(route => path.startsWith(route.path)).handler(req, capture);
      const state = JSON.parse(body);
      if (code !== 200) return json(res, code, state);
      state.health = await health();
      // Lite upstream snapshots omit bridge.status. Use the same live snapshot
      // as the health checks rather than converting an omitted field to false.
      state.bridge.status = { ...(state.bridge.status || {}), loggedIn: state.health.clientConnected };
      state.platform = 'linux';
      state.editableKeys = [...editableConfig];
      state.supportedActions = [...supportedActions, 'selfcheck'];
      state.features = (state.features || []).map(feature => ({ ...feature, unsupported: !editableConfig.has(feature.key) }));
      return json(res, 200, state);
    }
    if (path === '/' || path === '/runtime') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(new URL('./setup.html', import.meta.url)));
    }
    if (path === '/runtime/status' && req.method === 'GET') return json(res, 200, {
      model: { baseUrl: model.baseUrl || '', model: model.model || '', hasKey: !!model.apiKey,
        presetId: findPreset(model)?.id || 'custom' }, bridge: bridge.status(),
    });
    if (path === '/runtime/presets' && req.method === 'GET') return json(res, 200, { presets: MODEL_PRESETS });
    if (path === '/runtime/model' && req.method === 'POST') {
      const input = await readJson(req);
      const next = resolveModelConfig(input, model);
      writeFileSync(modelFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
      renameSync(modelFile + '.tmp', modelFile);
      model = next;
      return json(res, 200, { ok: true });
    }
    if (path === '/runtime/model/test' && req.method === 'POST') {
      let text = '';
      for await (const chunk of ctx.llm.stream({ messages: [{ role: 'user', content: '请回复：连接正常' }], maxTokens: 100 })) {
        if (chunk.type === 'text-delta') text += chunk.text;
      }
      return json(res, 200, { ok: true, text });
    }
    if (path === '/runtime/enable' && req.method === 'POST') {
      if (roomMaintenance) throw new Error('群配置维护中，请等待完成后再启停');
      const { enabled } = await readJson(req);
      if (typeof enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
      if (enabled && !model.apiKey) throw new Error('请先配置并测试模型');
      await bridge.enable(enabled);
      return json(res, 200, { ok: true, enabled });
    }
    if (path.startsWith('/wechat-bot/api/providers') || path.endsWith('/models') || path.endsWith('/image')) {
      return json(res, 409, { error: '请通过独立运行设置页配置模型；多媒体能力后续接入' });
    }
    if (path === '/wechat-bot/api/action' && req.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('请求过大'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.op === 'selfcheck') return json(res, 200, { ok: true, result: await health(true) });
      if (!supportedActions.has(body.op)) return json(res, 409, { error: '该操作尚未适配 Linux 独立版' });
      const writingMemory = memoryWrites.has(body.op);
      if (writingMemory && memoryWriteBusy) return json(res, 409, { error: '上一项记忆操作尚未完成，请等待结果后刷新' });
      if (body.op === 'memory.purgePreview') {
        const a = body.args || {};
        if ((a.maxWeight !== undefined && (!Number.isFinite(a.maxWeight) || a.maxWeight < 0 || a.maxWeight > 0.15)) || (a.neverUsed !== undefined && a.neverUsed !== true)) return json(res, 400, { error: '仅支持权重不高于 0.15 且从未使用的记忆预览' });
      }
      if (body.op === 'memory.purge') {
        const a = body.args || {};
        if (a.confirm !== true || typeof a.previewId !== 'string' || !/^[\da-f-]{36}$/i.test(a.previewId)) return json(res, 400, { error: '请先预览并明确确认归档' });
      }
      if (personaWrites.has(body.op)) {
        const a = body.args || {};
        if (a.confirm !== true || (a.room && a.room !== bridge.roomId)) return json(res, 400, { error: '请确认人格编辑，且只能操作当前监听群' });
        if (body.op.startsWith('persona.taste') && (!['likes', 'dislikes'].includes(a.kind) || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 300)) return json(res, 400, { error: '偏好类型或内容无效（最多 300 字）' });
        if (body.op === 'persona.narrativeRestore' && (!Number.isInteger(a.version) || a.version < 1)) return json(res, 400, { error: '自传版本无效' });
      }
      if (body.op === 'sendText') {
        const a = body.args || {};
        const savedFile = join(data, 'wechat-bot/config.json');
        const enabled = !existsSync(savedFile) || JSON.parse(readFileSync(savedFile, 'utf8')).enabled !== false;
        if (!enabled || !bridge.status().polling) return json(res, 409, { error: '回复或接入已暂停，手动发送也被阻止' });
        if (a.room !== bridge.roomId || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 2000 || !/^[\da-f-]{36}$/i.test(a.requestId || '') || Object.keys(a).some(k => !['room', 'text', 'requestId'].includes(k))) return json(res, 400, { error: '仅允许当前群的纯文字发送（最多 2000 字），需有效请求标识' });
      }
      if (body.op.startsWith('memory.')) {
        body.args ||= {};
        if (body.args.room && body.args.room !== bridge.roomId) return json(res, 409, { error: '记忆操作仅允许当前监听群' });
        body.args.room = bridge.roomId;
        chunks.length = 0;
        chunks.push(Buffer.from(JSON.stringify(body)));
      }
      // The original panel handler reads the request stream. Recreate it after checking its operation.
      const { Readable } = await import('node:stream');
      const replay = Readable.from(chunks); replay.url = req.url; replay.method = req.method; replay.headers = req.headers;
      const writingPersona = personaWrites.has(body.op);
      if (writingPersona && personaWriteBusy) return json(res, 409, { error: '上一项人格编辑尚未完成，请等待结果后刷新' });
      if (writingMemory) memoryWriteBusy = true;
      if (writingPersona) personaWriteBusy = true;
      try {
        if (body.op === 'memory.purge') {
          const file = bridge.roomId.replace(/[^\w@.-]/g, '_') + '.json';
          const source = join(data, 'facts', file);
          if (!existsSync(source)) return json(res, 409, { error: '当前群尚无记忆文件，无法备份及归档' });
          const parent = join(data, 'memory-backups');
          mkdirSync(parent, { recursive: true, mode: 0o700 });
          const backup = mkdtempSync(join(parent, Date.now() + '-'));
          copyFileSync(source, join(backup, file));
          writeFileSync(join(backup, 'operation.json'), JSON.stringify({ op: body.op, at: new Date().toISOString(), roomId: bridge.roomId }), { mode: 0o600 });
        }
        if (writingPersona) {
          const source = join(data, 'persona');
          const parent = join(data, 'persona-backups');
          mkdirSync(parent, { recursive: true, mode: 0o700 });
          const backup = mkdtempSync(join(parent, Date.now() + '-'));
          for (const file of existsSync(source) ? readdirSync(source).filter(f => f.endsWith('.json')) : []) copyFileSync(join(source, file), join(backup, file));
          writeFileSync(join(backup, 'operation.json'), JSON.stringify({ op: body.op, at: new Date().toISOString(), roomId: bridge.roomId }), { mode: 0o600 });
        }
        return await routes.find(route => path.startsWith(route.path)).handler(replay, res);
      } finally { if (writingPersona) personaWriteBusy = false; if (writingMemory) memoryWriteBusy = false; }
    }
    if (path === '/wechat-bot/api/import') return json(res, 409, { error: '首期尚未开放整份配置导入' });
    if (path === '/wechat-bot/api/config' && req.method === 'POST') {
      const input = await readJson(req);
      if (!input.patch || Object.keys(input.patch).some(key => !editableConfig.has(key))) {
        return json(res, 409, { error: '首期支持人设、称呼、发言频率、作息和记忆开关；平台配置由独立运行层管理' });
      }
      const { Readable } = await import('node:stream');
      const replay = Readable.from([Buffer.from(JSON.stringify(input))]);
      replay.url = req.url; replay.method = req.method; replay.headers = req.headers;
      return await routes.find(route => path.startsWith(route.path)).handler(replay, res);
    }
    const route = routes.find(route => path.startsWith(route.path));
    if (route) return await route.handler(req, res);
    json(res, 404, { error: '接口不存在' });
  } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.end(); }
});
server.listen(Number(process.env.PORT || 18788), '127.0.0.1', () => log('独立运行管理页 http://127.0.0.1:' + server.address().port));
async function stop() {
  bridge.close();
  for (const dispose of cleanup.reverse()) { try { dispose(); } catch (error) { log(error.message); } }
  server.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
