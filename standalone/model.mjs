import { findPreset } from './presets.mjs';
import { imageMime } from './vision.mjs';

export function createModelService(getConfig, getVisionConfig = () => null, onVisionState = () => {}) {
  let visionBusy = false;
  return {
    async *stream(options) {
      const hasImage = (options.messages || []).some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
      const visual = hasImage || options.provider === 'standalone-vision';
      const config = visual ? getVisionConfig() : getConfig();
      if (!config?.baseUrl || !config.model || !config.apiKey || (visual && !config.enabled)) throw new Error(visual ? '请先单独配置并启用视觉模型' : '请先配置模型接口、模型名和密钥');
      if (visual && visionBusy) throw new Error('视觉模型正在处理另一张图片，请稍后再试');
      const messages = [];
      if (options.system) messages.push({ role: 'system', content: options.system });
      for (const message of options.messages || []) {
        let content;
        if (typeof message.content === 'string') content = message.content;
        else if (visual) content = (message.content || []).map(block => {
          if (block.type === 'text') return { type: 'text', text: block.text };
          if (block.type !== 'image' || typeof block.attachment?.data !== 'string') throw new Error('视觉附件格式无效');
          const bytes = Buffer.from(block.attachment.data, 'base64');
          const mime = imageMime(bytes);
          if (mime !== block.attachment.mediaType) throw new Error('视觉附件类型不一致');
          return { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } };
        });
        else content = (message.content || []).map(block => {
          if (block.type !== 'text') throw new Error('文字接口不接收多媒体附件');
          return block.text;
        }).join('\n');
        messages.push({ role: message.role || 'user', content });
      }
      if (visual) { visionBusy = true; onVisionState('recognizing'); }
      try {
        const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey },
          body: JSON.stringify({ model: config.model, messages, temperature: options.temperature,
            max_tokens: visual ? Math.min(Number(options.maxTokens) || 2000, 2000) : options.maxTokens,
            stream: false, ...(visual ? {} : findPreset(config)?.requestDefaults) }),
          signal: visual ? AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(20000)])
            : options.signal || AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error((visual ? '视觉' : '模型') + '服务返回 HTTP ' + response.status);
        const result = await response.json();
        const text = result.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('模型返回空正文');
        if (visual) onVisionState('understood');
        yield { type: 'text-delta', text };
        if (result.usage) yield { type: 'usage', usage: result.usage };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } catch (error) {
        if (visual) onVisionState('vision_failed');
        if (error.message?.includes('服务返回 HTTP') || error.message === '模型返回空正文') throw error;
        throw new Error(visual ? '视觉请求失败或超时，请检查独立模型配置' : '模型请求失败或超时');
      } finally { if (visual) visionBusy = false; }
    },
  };
}
