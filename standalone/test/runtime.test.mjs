import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { displayIdentity } from '../identities.mjs';
import { visionTestImage } from '../vision.mjs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { normalizeMessage } from '../bowxt.mjs';
import { createModelService } from '../model.mjs';
import { migrateList } from '../../upstream/wechat-bot/wechat-group-agent/lib/memory-v2.mjs';

test('same nickname is scoped by group', () => {
  const input = { seq: 1, sender: '测试人', content: '你好', direction: 'incoming', is_at_me: true };
  assert.notEqual(normalizeMessage(input, 1, 'A').sender, normalizeMessage(input, 2, 'B').sender);
  assert.equal(normalizeMessage(input, 1, 'A').isAtMe, true);
});

test('original persona and memory survive standalone startup and restart', { timeout: 90000 }, async t => {
  const root = resolve(import.meta.dirname, '../..');
  const data = mkdtempSync(join(tmpdir(), 'wechat-soul-test-'));
  mkdirSync(join(data, 'memory'));
  mkdirSync(join(data, 'facts'));
  const memorySeed = migrateList([
    { id: 'low-weight-fixture', text: '一次性活动的临时安排', strength: 1, importance: 0.05, at: Date.now() },
    { id: 'pinned-fixture', text: '固定成员生日', strength: 1, importance: 0.05, pinned: true, at: Date.now() },
    { id: 'important-fixture', text: '不可协商的重要约定', strength: 1, importance: 0.99, at: Date.now() },
  ]).items;
  writeFileSync(join(data, 'facts/bowxt_1@chatroom.json'), JSON.stringify(memorySeed));
  writeFileSync(join(data, 'memory/bowxt_1@chatroom.json'), JSON.stringify({ roomName: '测试群', msgs: Array.from({ length: 6 }, (_, i) => ({ id: 'seed:' + i, ts: Date.now() - (6 - i) * 1000, isSelf: true, sender: 'self', text: '一起喝茶，聊聊天气。' })) }));
  const prompts = [];
  const visionPrompts = [];
  let rejectVision = false;
  const sends = [];
  let delivery;
  let rejectNarrative = false;
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    let result = {};
    if (/^\/api\/messages\/(40|41)\/image$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'image/png' }); res.end(visionTestImage()); return;
    }
    if (req.url === '/vision/chat/completions') {
      visionPrompts.push(body);
      if (rejectVision) { res.writeHead(503); res.end('private-vision-response'); return; }
      result = { choices: [{ message: { content: '一块白色方块。' } }] };
    } else if (/^\/api\/messages\/(40|41)$/.test(req.url)) {
      result = { message: { seq: Number(req.url.split('/').at(-1)), chat_id: 1, direction: 'incoming', message_type: 'image', image_url: 'present' } };
    } else if (req.url === '/v1/chat/completions') {
      prompts.push(body);
      const sys = body.messages.find(m => m.role === 'system')?.content || '';
      let content = '嗯，记着呢。';
      if (JSON.stringify(body.messages).includes('白色方块')) content = '看到一块白色的小方块。';
      if (sys.includes('短短的日记')) content = JSON.stringify({ title: '茶香', text: '今天和群友喝茶聊天，记住了大家的偏好。', likes: [], dislikes: [] });
      if (sys.includes('我是个什么样的人')) content = rejectNarrative ? '我是人工智能助手' : '我是豆姐，喜欢喝茶，也喜欢和熟悉的群友慢慢聊天。我记得大家随口说过的小事，会认真听别人讲今天发生了什么。遇到不懂的问题我会直接承认，遇到开心的事也愿意一起笑。我不喜欢把每句话都讲成说明书，希望自己说话自然一点，有自己的喜好，也给别人留出空间。忙的时候可以安静坐着，闲下来再端起茶杯继续聊。';
      if (sys.includes('复盘自己')) content = JSON.stringify({ findings: ['回答短一点，先说具体内容'] });
      result = { choices: [{ message: { content } }] };
    } else if (req.url === '/api/status') result = { paused: true, worker_paused: true, queue_depth: 0, wechat_connected: true, last_poll_completed_at: Date.now() / 1000 + 1 };
    else if (req.url.endsWith('/claim')) {
      result = { deliveries: delivery ? [delivery] : [] }; delivery = undefined;
    } else if (req.url.includes('/ack')) result = { ok: true };
    else if (req.url === '/api/chats/1/messages' && req.method === 'POST') {
      sends.push(body); result = { message: { seq: 101, delivery_status: 'sent' } };
    } else if (req.url.includes('/messages?')) result = { messages: [] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => fake.close());
  const backend = `http://127.0.0.1:${fake.address().port}`;
  let child;
  let base;
  let logs = '';
  async function start() {
    logs = '';
    child = spawn(process.execPath, [join(root, 'standalone/server.mjs')], {
      cwd: join(root, 'standalone'), env: { ...process.env, BOT_ROOT: root, BOT_DATA: data,
        USERPROFILE: data, HOME: data, BOWXT_URL: backend, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', buffer => { logs += buffer; }); child.stderr.on('data', buffer => { logs += buffer; });
    const deadline = Date.now() + 15000;
    while (!logs.match(/http:\/\/127.0.0.1:(\d+)/)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    base = logs.match(/http:\/\/127.0.0.1:\d+/)[0];
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  }
  t.after(stop);
  async function api(path, body) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  await start();
  await api('/runtime/model', { baseUrl: backend + '/v1', model: 'fixture', apiKey: 'fixture-secret' });
  const publicState = await api('/runtime/status');
  assert.equal(publicState.model.hasKey, true);
  const liteState = await api('/wechat-bot/api/state?lite=1');
  assert.equal(liteState.bridge.status.loggedIn, true);
  assert.equal(liteState.bridge.status.loggedIn, liteState.health.clientConnected);
  assert.ok(!JSON.stringify(publicState).includes('fixture-secret'));
  await api('/wechat-bot/api/config', { patch: { persona: '你是喜欢喝茶的群友豆姐。', quietHours: '', replyProbability: 0 } });
  await api('/wechat-bot/api/action', { op: 'memory.add', args: { room: 'bowxt:1@chatroom', add: '测试人不喝咖啡。' } });
  const before = await api('/wechat-bot/api/action', { op: 'memory.list', args: { room: 'bowxt:1@chatroom' } });
  assert.ok(before.result.facts.some(fact => fact.text.includes('不喝咖啡')));
  const previewPurge = () => api('/wechat-bot/api/action', { op: 'memory.purgePreview', args: { maxWeight: 0.15, neverUsed: true } });
  const purge = previewId => api('/wechat-bot/api/action', { op: 'memory.purge', args: { previewId, confirm: true } });
  const firstPreview = (await previewPurge()).result;
  assert.ok(firstPreview.items.some(item => item.id === 'low-weight-fixture'));
  assert.ok(!firstPreview.items.some(item => ['pinned-fixture', 'important-fixture'].includes(item.id)));
  await api('/wechat-bot/api/action', { op: 'memory.add', args: { add: '这条新增记忆用于验证清理预览失效。' } });
  await assert.rejects(purge(firstPreview.previewId));
  const refreshedPreview = (await previewPurge()).result;
  assert.equal((await purge(refreshedPreview.previewId)).result.done, true);
  await assert.rejects(purge(refreshedPreview.previewId));
  const purged = await api('/wechat-bot/api/action', { op: 'memory.list', args: { archived: true } });
  assert.ok(purged.result.facts.some(item => item.id === 'low-weight-fixture'));
  await api('/wechat-bot/api/action', { op: 'memory.archive', args: { id: 'low-weight-fixture', archived: false } });
  assert.ok(readdirSync(join(data, 'memory-backups')).length > 0);
  const edit = (op, args = {}) => api('/wechat-bot/api/action', { op, args: { ...args, confirm: true } });
  await api('/wechat-bot/api/action', { op: 'persona.state' });
  await assert.rejects(api('/wechat-bot/api/action', { op: 'persona.goalReroll', args: {} }));
  await edit('persona.tasteAdd', { kind: 'likes', text: '测试专用桂花茶' });
  const inner = await api('/wechat-bot/api/action', { op: 'persona.state' });
  assert.equal(inner.result.roomId, 'bowxt:1@chatroom');
  assert.ok(inner.result.tastes.likes.some(taste => taste.text === '测试专用桂花茶'));
  const diary = await edit('persona.diaryWrite');
  assert.equal(diary.result.ok, true, JSON.stringify(diary));
  const review = await edit('persona.selfReview');
  assert.equal(review.result.ok, true, JSON.stringify(review));
  assert.equal((await edit('persona.goalReroll')).result.ok, true);
  const narrative = await edit('persona.narrativeWrite');
  assert.equal(narrative.result.ok, true, JSON.stringify(narrative));
  assert.equal((await edit('persona.narrativeWrite')).result.ok, true);
  assert.equal((await edit('persona.narrativeRestore', { version: narrative.result.version })).result.ok, true);
  rejectNarrative = true;
  assert.equal((await edit('persona.narrativeWrite')).result.ok, false);
  rejectNarrative = false;
  assert.ok(readdirSync(join(data, 'persona-backups')).length >= 6);
  const snapshots = await api('/runtime/persona-backups');
  const beforeTaste = snapshots.items.find(item => item.op === 'persona.tasteAdd');
  assert.ok(beforeTaste);
  const preview = await api('/runtime/persona-backups?id=' + beforeTaste.id);
  const recovered = await api('/runtime/persona-backups/restore', { id: preview.id, currentHash: preview.currentHash, snapshotHash: preview.snapshotHash, confirm: true });
  const restoredPersona = await api('/wechat-bot/api/action', { op: 'persona.state' });
  assert.ok(!restoredPersona.result.tastes.likes.some(taste => taste.text === '测试专用桂花茶'));
  const undo = await api('/runtime/persona-backups?id=' + recovered.savedCurrentAs);
  await api('/runtime/persona-backups/restore', { id: undo.id, currentHash: undo.currentHash, snapshotHash: undo.snapshotHash, confirm: true });
  const factId = before.result.facts.find(fact => fact.text.includes('不喝咖啡')).id;
  await api('/wechat-bot/api/config', { patch: { conversationWindowMs: 180000, continuationChance: 0.9, splitChance: 0.2, maxLines: 2 } });
  await api('/wechat-bot/api/action', { op: 'memory.archive', args: { id: factId } });
  const archived = await api('/wechat-bot/api/action', { op: 'memory.list', args: { archived: true } });
  assert.ok(archived.result.facts.some(fact => fact.id === factId));
  await api('/wechat-bot/api/action', { op: 'memory.archive', args: { id: factId, archived: false } });
  await stop();
  await start();
  const savedConfig = await api('/wechat-bot/api/state?lite=1');
  const savedInner = await api('/wechat-bot/api/action', { op: 'persona.state' });
  assert.ok(savedInner.result.tastes.likes.some(taste => taste.text === '测试专用桂花茶'));
  assert.ok(savedInner.result.diary.some(entry => entry.title === '茶香'));
  await edit('persona.tasteRemove', { kind: 'likes', text: '测试专用桂花茶' });
  assert.equal(savedConfig.config.conversationWindowMs, 180000);
  assert.equal(savedConfig.config.splitChance, 0.2);
  const restored = await api('/wechat-bot/api/action', { op: 'memory.list', args: { room: 'bowxt:1@chatroom' } });
  assert.ok(restored.result.facts.some(fact => fact.text.includes('不喝咖啡')));
  await api('/runtime/enable', { enabled: true });
  const capacity = await api('/runtime/storage');
  assert.equal(capacity.turns.eligible, 0);
  await assert.rejects(api('/runtime/storage/compact', { confirm: true, previewHash: capacity.turns.previewHash }));
  const manualArgs = { room: 'bowxt:1@chatroom', text: '手动发送模拟验证', requestId: '11111111-1111-4111-8111-111111111111' };
  const sentManual = await api('/wechat-bot/api/action', { op: 'sendText', args: manualArgs });
  assert.equal(sentManual.result.rc, 0);
  const firstClientId = sends.at(-1).client_id;
  await api('/wechat-bot/api/action', { op: 'sendText', args: manualArgs });
  assert.equal(sends.at(-1).client_id, firstClientId);
  await api('/wechat-bot/api/action', { op: 'sendText', args: { ...manualArgs, requestId: '22222222-2222-4222-8222-222222222222' } });
  assert.notEqual(sends.at(-1).client_id, firstClientId);
  await api('/runtime/enable', { enabled: false });
  await assert.rejects(api('/wechat-bot/api/action', { op: 'sendText', args: manualArgs }));
  await api('/runtime/enable', { enabled: true });
  delivery = { lease_token: 'fixture-lease', message: { seq: 10, chat_id: 1, sender: '测试人',
    message_type: 'text', content: '@豆姐 我不喝咖啡，记得吗？', is_at_me: true,
    direction: 'incoming', observed_at: new Date().toISOString() } };
  const deadline = Date.now() + 25000;
  while (!sends.map(send => send.text).join('').includes('记着呢') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(sends.length, logs);
  const prompt = prompts.findLast(prompt => prompt.messages.some(message => message.content.includes('咖啡')));
  assert.ok(prompt, JSON.stringify(prompts));
  assert.ok(prompt.messages.some(message => message.content.includes('喜欢喝茶')));
  assert.ok(prompt.messages.some(message => message.content.includes('不喝咖啡')));
  assert.ok(sends.map(send => send.text).join('').includes('记着呢'));
  while ((await api('/runtime/turns')).summary.pending && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await api('/runtime/turns')).summary.counts.completed, 1, logs);
  const receipt = { lease_token: 'fixture-lease', message: { seq: 11, chat_id: 1, sender: '测试人',
    message_type: 'text', content: '@豆姐 中断恢复模拟消息', is_at_me: true,
    direction: 'incoming', observed_at: new Date().toISOString() } };
  await api('/wechat-bot/api/config', { patch: { debounceMs: 5000 } });
  delivery = receipt;
  const queuedDeadline = Date.now() + 3000;
  while (!(await api('/runtime/turns')).summary.counts.queued && Date.now() < queuedDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await api('/runtime/turns')).summary.counts.queued, 1);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL'); await exited;
  const sendsBeforeRestart = sends.length;
  await start();
  const interrupted = await api('/runtime/turns');
  assert.equal(interrupted.summary.needsReview, 1);
  assert.equal(interrupted.items[0].id, 'bowxt:11');
  assert.equal((await api('/runtime/turns/outbound?id=bowxt%3A11')).total, 0);
  await assert.rejects(api('/runtime/turns/outbound?id=other'));
  assert.equal((await api('/runtime/status')).bridge.polling, false);
  await api('/runtime/enable', { enabled: true });
  delivery = receipt; // Simulate a redelivery after a lost ACK.
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(sends.length, sendsBeforeRestart);
  assert.equal((await api('/runtime/turns')).summary.pending, 0);
  assert.equal((await api('/runtime/turns')).summary.needsReview, 1);
  await assert.rejects(api('/runtime/turns/resolve', { ...interrupted.items[0], confirm: true }));
  await api('/runtime/enable', { enabled: false });
  await assert.rejects(api('/runtime/turns/resolve', { ...interrupted.items[0], confirm: false }));
  assert.equal((await api('/runtime/turns/resolve', { ...interrupted.items[0], confirm: true })).ok, true);
  assert.equal((await api('/runtime/turns')).summary.needsReview, 0);
  assert.equal(sends.length, sendsBeforeRestart);
  await api('/runtime/enable', { enabled: true });
  delivery = { ...receipt, message: { ...receipt.message, seq: 12, content: '@豆姐 请说说喝茶的事情' } };
  const resumeDeadline = Date.now() + 4000;
  while (!(await api('/runtime/turns')).summary.counts.queued && Date.now() < resumeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await api('/runtime/turns')).summary.counts.queued, 1);
  const killed = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await killed;
  await start();
  const recoverable = (await api('/runtime/turns')).items.find(item => item.id === 'bowxt:12');
  assert.equal(recoverable.canResume, true);
  await assert.rejects(api('/runtime/turns/resume', { ...recoverable, confirm: true }));
  await api('/runtime/enable', { enabled: true });
  await api('/runtime/turns/resume', { ...recoverable, confirm: true });
  await assert.rejects(api('/runtime/turns/resume', { ...recoverable, confirm: true }));
  const doneDeadline = Date.now() + 20000;
  while ((await api('/runtime/turns')).summary.pending && Date.now() < doneDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await api('/runtime/turns')).summary.pending, 0, logs);
  assert.equal((await api('/runtime/turns')).summary.needsReview, 0, logs);
  const memory = JSON.parse(readFileSync(join(data, 'memory/bowxt_1@chatroom.json')));
  assert.equal(memory.msgs.filter(m => m.id === 'bowxt:12').length, 1);
  await api('/runtime/enable', { enabled: false });
  const textPatch = { quietHours: '00:00-12:00,12:00-23:59,23:59-00:00', quietAllow: [],
    humanSilence: false, humanPunctStyle: true, humanFiller: false, maxReplyChars: 24, contextMessages: 0, backfillLimit: 0, debounceMs: 0 };
  await api('/wechat-bot/api/config', { patch: textPatch });
  for (const patch of [{ quietAllow: ['unknown'] }, { humanSilence: 'wrong' }, { maxReplyChars: 1.5 }]) {
    await assert.rejects(api('/wechat-bot/api/config', { patch }));
  }
  const block = join(data, 'wechat-bot/config.json.tmp'); mkdirSync(block);
  await assert.rejects(api('/wechat-bot/api/config', { patch: { maxReplyChars: 25 } })); rmdirSync(block);
  assert.equal((await api('/runtime/text-config')).values.maxReplyChars, 24);
  await stop(); await start();
  const effective = await api('/runtime/text-config');
  for (const [key, value] of Object.entries(textPatch)) assert.deepEqual(effective.values[key], value, key);
  assert.equal(effective.dependencies.humanFillerActive, false);
  await api('/runtime/enable', { enabled: true });
  const sendCount = sends.length, modelCount = prompts.length;
  const waitForRound = async seq => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const row = (await api('/runtime/turns/recent')).items.find(r => r.id === 'bowxt:' + seq && !r.ongoing);
      if (row) return row;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('round did not finish: ' + seq + logs);
  };
  delivery = { ...receipt, message: { ...receipt.message, seq: 30 } };
  const quietRound = await waitForRound(30);
  assert.equal(quietRound.reason, 'quiet_hours');
  assert.equal(sends.length, sendCount); assert.equal(prompts.length, modelCount);
  assert.ok(quietRound.timingAvailable);
  const plan = await api('/runtime/identities/preview', { action: 'link', alias: '改名后的测试人', target: '测试人' });
  await assert.rejects(api('/runtime/identities/commit', { ...plan, confirm: true }));
  await api('/runtime/enable', { enabled: false });
  await api('/runtime/identities/commit', { ...plan, confirm: true });
  const personaBeforeRename = JSON.parse(readFileSync(join(data, 'persona/bowxt_1@chatroom.json')));
  assert.ok(Object.hasOwn(personaBeforeRename.affinity, displayIdentity(1, '测试人')));
  await stop(); await start();
  assert.equal((await api('/runtime/identities')).links[0].target, '测试人');
  await api('/runtime/enable', { enabled: true });
  delivery = { ...receipt, message: { ...receipt.message, seq: 31, sender: '改名后的测试人' } };
  assert.equal((await waitForRound(31)).reason, 'quiet_hours');
  const personaAfterRename = JSON.parse(readFileSync(join(data, 'persona/bowxt_1@chatroom.json')));
  assert.ok(Object.hasOwn(personaAfterRename.affinity, displayIdentity(1, '测试人')));
  assert.ok(!Object.hasOwn(personaAfterRename.affinity, displayIdentity(1, '改名后的测试人')));
  assert.equal(sends.length, sendCount); assert.equal(prompts.length, modelCount);
  await api('/runtime/enable', { enabled: false });
  await api('/wechat-bot/api/config', { patch: { quietHours: '', quietAllow: ['at', 'name'], minReplyGapMs: 0, repeatWindowMs: 0,
    typingDelayScale: 0, maxReplyChars: 200, cannedChance: 0, splitChance: 0 } });
  await api('/runtime/vision', { enabled: true, baseUrl: backend + '/vision', model: 'vision-fixture', apiKey: 'separate-vision-fixture' });
  const visualState = await api('/runtime/vision'); assert.equal(visualState.hasKey, true); assert.ok(!JSON.stringify(visualState).includes('separate-vision-fixture'));
  await api('/runtime/enable', { enabled: true });
  delivery = { ...receipt, message: { ...receipt.message, seq: 40, message_type: 'image', content: '[图片]' } };
  assert.equal((await waitForRound(40)).state, 'completed', logs);
  assert.equal(visionPrompts.length, 1);
  assert.match(visionPrompts[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.ok(prompts.at(-1).messages.some(m => String(m.content).includes('白色方块')));
  assert.ok(sends.at(-1).text.includes('白色'));
  assert.equal(readdirSync(join(data, 'media-temp')).length, 0);
  rejectVision = true;
  await api('/runtime/vision', { enabled: true, baseUrl: backend + '/vision', model: 'vision-fixture-2', apiKey: '' });
  const beforeImageFailure = sends.length;
  delivery = { ...receipt, message: { ...receipt.message, seq: 41, message_type: 'image', content: '[图片]' } };
  assert.equal((await waitForRound(41)).reason, 'image_understanding_failed');
  assert.equal(sends.length, beforeImageFailure); assert.equal(visionPrompts.length, 2);
  assert.ok(!logs.includes('private-vision-response'));
  await api('/runtime/vision', { enabled: false, baseUrl: backend + '/vision', model: 'vision-fixture-2', apiKey: '' });
  delivery = { ...receipt, message: { ...receipt.message, seq: 42, message_type: 'image', content: '[图片]' } };
  assert.equal((await waitForRound(42)).reason, 'image_disabled');
  assert.equal(visionPrompts.length, 2);
  await api('/runtime/enable', { enabled: false });
});

test('model errors do not leak provider response bodies or keys', async () => {
  const service = createModelService(() => ({ baseUrl: 'http://127.0.0.1:1', model: 'test', apiKey: 'secret' }));
  await assert.rejects(async () => { for await (const chunk of service.stream({ messages: [] })) void chunk; });
});
