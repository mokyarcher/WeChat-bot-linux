// Official endpoints and model identifiers checked on 2026-11-05.
export const MODEL_PRESETS = [
  { id: 'deepseek-flash', label: 'DeepSeek · Flash', baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash', docs: 'https://api-docs.deepseek.com/',
    note: '使用 DeepSeek 开放平台的 API Key。', requestDefaults: { thinking: { type: 'disabled' } } },
  { id: 'deepseek-pro', label: 'DeepSeek · V4 Pro', baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro', docs: 'https://api-docs.deepseek.com/',
    note: '使用 DeepSeek 开放平台的 API Key。', requestDefaults: { thinking: { type: 'disabled' } } },
  { id: 'qwen-plus', label: '通义千问 · Qwen Plus（北京）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus', docs: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    note: '使用阿里云百炼北京地域的标准 API Key。', requestDefaults: { enable_thinking: false } },
  { id: 'glm-5.2', label: '智谱 GLM · GLM-5.2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2', docs: 'https://docs.bigmodel.cn/cn/guide/start/quick-start',
    note: '使用智谱开放平台的标准 API Key。', requestDefaults: { thinking: { type: 'disabled' } } },
  { id: 'doubao-pro', label: '豆包 · Seed 2.1 Pro', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-1-pro-260915', docs: 'https://docs.volcengine.com/docs/ark/text-generation?lang=en',
    note: '使用火山方舟 API Key，并先开通此模型。', requestDefaults: { thinking: { type: 'disabled' } } },
];

export function findPreset(config) {
  return MODEL_PRESETS.find(preset => preset.baseUrl === String(config.baseUrl || '').replace(/\/$/, '') && preset.model === config.model);
}

export function resolveModelConfig(input, previous) {
  const preset = input.presetId && input.presetId !== 'custom'
    ? MODEL_PRESETS.find(item => item.id === input.presetId) : null;
  if (input.presetId && input.presetId !== 'custom' && !preset) throw new Error('未知模型预设');
  const url = new URL(preset?.baseUrl || input.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址不合法');
  const baseUrl = url.toString().replace(/\/$/, '');
  const model = String(preset?.model || input.model || '').trim();
  if (!model) throw new Error('请填写模型名');
  const suppliedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const sameEndpoint = baseUrl === String(previous.baseUrl || '').replace(/\/$/, '');
  const apiKey = suppliedKey || (sameEndpoint ? previous.apiKey : '');
  if (!apiKey) throw new Error(sameEndpoint ? '请填写 API Key' : '更换模型平台后，请填写该平台的 API Key');
  return { baseUrl, model, apiKey, presetId: preset?.id || 'custom' };
}
