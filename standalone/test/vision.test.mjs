import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchImage, visionTestImage, imageMime, attachments, resolveVisionConfig, MAX_IMAGE_BYTES } from '../vision.mjs';
import { createModelService } from '../model.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'vision-adapter-'));
const png = visionTestImage();
const meta = { seq: 2, chat_id: 1, direction: 'incoming', message_type: 'image', image_url: 'https://untrusted.example/image' };

test('image retrieval validates chat/type and uses fixed asset path, keeps private bytes as temporary file', async () => {
  const data = temp(); let gets = 0;
  const image = await fetchImage({ dataDir: data, chatId: 1, messageId: 'bowxt:2', api: async path => { assert.equal(path, '/api/messages/2'); return { message: meta }; },
    fetchAsset: async path => { gets++; assert.equal(path, '/api/messages/2/image'); return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
  assert.equal(image.mime, 'image/png'); assert.deepEqual(readFileSync(image.file), png); assert.equal(gets, 1);
  for (const patch of [{ chat_id: 2 }, { seq: 3 }, { direction: 'outgoing' }, { message_type: 'text' }]) {
    await assert.rejects(fetchImage({ dataDir: data, chatId: 1, messageId: 'bowxt:2', api: async () => ({ message: { ...meta, ...patch } }), fetchAsset: () => assert.fail('must not fetch') }));
  }
  await assert.rejects(fetchImage({ dataDir: data, chatId: 1, messageId: '../../private', api: () => assert.fail('invalid seq'), fetchAsset() {} }));
});

test('missing, oversized and mismatched images fail without creating payload files', async () => {
  const data = temp(), base = { dataDir: data, chatId: 1, messageId: 'bowxt:2', timeoutMs: 0 };
  await assert.rejects(fetchImage({ ...base, api: async () => ({ message: { ...meta, image_url: null } }), fetchAsset: () => assert.fail() }));
  for (const response of [new Response(png, { headers: { 'content-type': 'text/html' } }), new Response('bad', { headers: { 'content-type': 'image/png' } }), new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) } })]) {
    await assert.rejects(fetchImage({ ...base, api: async () => ({ message: meta }), fetchAsset: async () => response }));
  }
  assert.deepEqual(readdirSync(data), []);
  assert.throws(() => imageMime(Buffer.alloc(MAX_IMAGE_BYTES + 1)));
});

test('vision configuration cannot inherit credentials from text or another endpoint', () => {
  const saved = resolveVisionConfig({ enabled: true, baseUrl: 'https://vision.example/v1', model: 'vision', apiKey: 'fixture-vision' });
  assert.equal(resolveVisionConfig({ enabled: true, baseUrl: saved.baseUrl, model: 'vision2' }, saved).apiKey, saved.apiKey);
  assert.throws(() => resolveVisionConfig({ enabled: true, baseUrl: 'https://other.example/v1', model: 'vision' }, saved));
  assert.throws(() => resolveVisionConfig({ enabled: true, baseUrl: 'https://user:pass@example.com/v1', model: 'vision', apiKey: 'fixture' }));
});

test('image blocks route only to independent visual model; text requests stay text-only', async t => {
  const calls = [], states = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, body: JSON.parse(options.body), auth: options.headers.authorization }); return new Response(JSON.stringify({ choices: [{ message: { content: 'a white square' } }] })); });
  const service = createModelService(() => ({ baseUrl: 'https://text.example/v1', model: 'text', apiKey: 'text-fixture' }),
    () => ({ enabled: true, baseUrl: 'https://vision.example/v1', model: 'vision', apiKey: 'vision-fixture' }), s => states.push(s));
  const refs = await attachments.saveImages([{ data: png, mediaType: 'image/png' }]);
  for await (const chunk of service.stream({ provider: 'standalone-vision', messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', attachment: refs[0] }] }] })) void chunk;
  for await (const chunk of service.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'chat' }] }] })) void chunk;
  assert.equal(calls[0].url, 'https://vision.example/v1/chat/completions'); assert.equal(calls[0].body.model, 'vision');
  assert.match(calls[0].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(calls[0].auth, 'Bearer vision-fixture'); assert.equal(calls[1].auth, 'Bearer text-fixture');
  assert.equal(typeof calls[1].body.messages[0].content, 'string'); assert.deepEqual(states, ['recognizing', 'understood']);
});

test('visual failure never leaks provider error or reuses text route', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('secret provider response', { status: 403 }));
  const service = createModelService(() => ({ apiKey: 'text-secret' }), () => ({ enabled: true, baseUrl: 'https://vision.example', model: 'vision', apiKey: 'vision-secret' }));
  await assert.rejects(async () => { for await (const chunk of service.stream({ provider: 'standalone-vision', messages: [] })) void chunk; }, error => error.message === '视觉服务返回 HTTP 403');
});

test('only one visual request runs while ordinary text remains independent', async t => {
  let release;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('vision.example')) return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'fixture' } }] }))); });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'text fixture' } }] }));
  });
  const service = createModelService(() => ({ baseUrl: 'https://text.example', model: 'text', apiKey: 'text-fixture' }),
    () => ({ enabled: true, baseUrl: 'https://vision.example', model: 'vision', apiKey: 'vision-fixture' }));
  const collect = async options => { for await (const chunk of service.stream(options)) void chunk; };
  const pending = collect({ provider: 'standalone-vision', messages: [] });
  await assert.rejects(collect({ provider: 'standalone-vision', messages: [] }), /正在处理另一张图片/);
  await collect({ messages: [{ role: 'user', content: 'normal chat' }] });
  release(); await pending;
});
