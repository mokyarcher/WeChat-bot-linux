import { findPreset } from './presets.mjs';

export function createModelService(getConfig) {
  return {
    async *stream(options) {
      const config = getConfig();
      if (!config.baseUrl || !config.model || !config.apiKey) throw new Error('请先配置模型接口、模型名和密钥');
      const messages = [];
      if (options.system) messages.push({ role: 'system', content: options.system });
      for (const message of options.messages || []) {
        const content = typeof message.content === 'string' ? message.content
          : (message.content || []).map(block => {
            if (block.type !== 'text') throw new Error('当前独立运行层仅接入文字模型');
            return block.text;
          }).join('\n');
        messages.push({ role: message.role || 'user', content });
      }
      const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey },
        body: JSON.stringify({ model: config.model, messages, temperature: options.temperature,
          max_tokens: options.maxTokens, stream: false, ...findPreset(config)?.requestDefaults }),
        signal: options.signal || AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error('模型服务返回 HTTP ' + response.status);
      const result = await response.json();
      const text = result.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('模型返回空正文');
      yield { type: 'text-delta', text };
      if (result.usage) yield { type: 'usage', usage: result.usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}
