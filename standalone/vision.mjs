import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Deterministic valid 1x1 white PNG; used only by an explicit paid connection test.
export function visionTestImage() {
  const chunk = (name, payload) => {
    const data = Buffer.concat([Buffer.from(name), payload]); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(payload.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
export function imageMime(bytes) {
  if (bytes.length > MAX_IMAGE_BYTES || !bytes.length) throw new Error('图片为空或超过 8 MiB');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  throw new Error('不支持的图片格式');
}

export function resolveVisionConfig(input, saved = {}) {
  if (typeof input.enabled !== 'boolean') throw new Error('图片感知启用状态需为布尔值');
  let baseUrl = String(input.baseUrl || '').replace(/\/+$/, '');
  const model = String(input.model || '').trim();
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('视觉接口需为无凭据、查询或片段的 HTTP(S) 地址');
    baseUrl = url.href.replace(/\/+$/, '');
  }
  if (model.length > 200 || /[\r\n]/.test(model)) throw new Error('视觉模型名称无效');
  let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey && !input.clearKey && baseUrl === saved.baseUrl) apiKey = saved.apiKey || '';
  if (input.enabled && (!baseUrl || !model || !apiKey)) throw new Error('请单独填写视觉接口、模型和密钥；不能沿用文字模型密钥');
  return { enabled: input.enabled, baseUrl, model, apiKey };
}

export function visionScope(config) {
  return createHash('sha256').update(JSON.stringify([config.baseUrl, config.model])).digest('hex').slice(0, 20);
}

// Only existing bowxt records/assets are read. No desktop operations or URL supplied
// by a message is used, and every lookup is bound to the configured chat and seq.
export async function fetchImage({ api, fetchAsset, dataDir, chatId, messageId, timeoutMs = 12000 }) {
  const match = /^bowxt:([1-9]\d*)$/.exec(messageId || '');
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('图片消息标识无效');
  const seq = Number(match[1]), deadline = Date.now() + timeoutMs;
  let message;
  do {
    message = (await api(`/api/messages/${seq}`)).message;
    if (!message || message.seq !== seq || message.chat_id !== chatId || message.direction !== 'incoming' || message.message_type !== 'image') throw new Error('图片不属于当前群入站消息');
    if (message.image_url) break;
    if (Date.now() >= deadline) throw new Error('图片尚未取得，未进行识别');
    await new Promise(resolve => setTimeout(resolve, 400));
  } while (true);
  const response = await fetchAsset(`/api/messages/${seq}/image`);
  if (!response.ok) throw new Error('图片读取失败 HTTP ' + response.status);
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) { await response.body.cancel().catch(() => {}); throw new Error('图片超过 8 MiB'); }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks), mime = imageMime(bytes);
  if (response.headers.get('content-type')?.split(';')[0] !== mime) throw new Error('图片类型与内容不一致');
  const dir = join(dataDir, 'media-temp'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(name));
  for (const name of files) if (Date.now() - statSync(join(dir, name)).mtimeMs > 3600000) unlinkSync(join(dir, name));
  if (readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(name)).length >= 16) throw new Error('图片临时文件已达上限，请检查未结束任务');
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
  const file = join(dir, randomUUID() + '.' + extension); writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  return { file, mime, bytes: bytes.length };
}

export const attachments = {
  async saveImages(images) {
    return images.map(image => {
      const bytes = Buffer.from(image.data), mime = imageMime(bytes);
      if (mime !== image.mediaType) throw new Error('附件格式不一致');
      return { data: bytes.toString('base64'), mediaType: mime };
    });
  },
};
