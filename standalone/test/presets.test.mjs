import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRESETS, resolveModelConfig } from '../presets.mjs';
import { createModelService } from '../model.mjs';

test('a preset can be saved with only its ID and API key', () => {
  const config = resolveModelConfig({ presetId: 'deepseek-flash', apiKey: ' test-key ' }, {});
  assert.equal(config.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.model, 'deepseek-flash');
  assert.equal(config.apiKey, 'test-key');
});

test('switching providers requires a new key while models on the same endpoint can reuse it', () => {
  const saved = resolveModelConfig({ presetId: 'deepseek-flash', apiKey: 'deepseek-secret' }, {});
  assert.throws(() => resolveModelConfig({ presetId: 'qwen-plus' }, saved), /该平台的 API Key/);
  const config = resolveModelConfig({ presetId: 'deepseek-pro' }, saved);
  assert.equal(config.apiKey, saved.apiKey);
  assert.equal(config.model, 'deepseek-v4-pro');
  assert.throws(() => resolveModelConfig({ presetId: 'unknown', apiKey: 'test' }, {}), /未知模型预设/);
});

test('custom saved configurations remain usable', () => {
  const saved = { baseUrl: 'https://example.com/v1', model: 'custom-model', apiKey: 'secret' };
  assert.equal(resolveModelConfig({ baseUrl: saved.baseUrl, model: 'another-model' }, saved).apiKey, 'secret');
  assert.throws(() => resolveModelConfig({ baseUrl: 'https://different.example/v1', model: 'another-model' }, saved), /该平台/);
});

test('official presets send their provider-specific chat parameters', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '连接正常' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  for (const preset of MODEL_PRESETS) {
    const config = resolveModelConfig({ presetId: preset.id, apiKey: 'fixture' }, {});
    const service = createModelService(() => config);
    const chunks = [];
    for await (const chunk of service.stream({ messages: [{ role: 'user', content: '测试' }], maxTokens: 100 })) chunks.push(chunk);
    assert.equal(chunks[0].text, '连接正常');
  }
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].body.thinking.type, 'disabled');
  assert.equal(requests.find(request => request.body.model === 'qwen-plus').body.enable_thinking, false);
});
