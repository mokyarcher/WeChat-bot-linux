import { createConnection } from 'node:net';

export function probeVnc() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 5900 });
    let banner = Buffer.alloc(0), settled = false;
    const finish = error => {
      if (settled) return; settled = true; socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(2500, () => finish(new Error('VNC 握手超时')));
    socket.on('error', () => finish(new Error('VNC 端口不可达')));
    socket.on('end', () => finish(new Error('VNC 未返回完整握手')));
    socket.on('close', () => finish(new Error('VNC 连接提前关闭')));
    socket.on('data', chunk => {
      banner = Buffer.concat([banner, chunk]);
      if (banner.length >= 12) finish(/^RFB \d{3}\.\d{3}\n/.test(banner.toString()) ? null : new Error('VNC 握手无效'));
    });
  });
}

export function createServiceHealth({ enabled = false, fetcher = fetch, vnc = probeVnc, now = Date.now } = {}) {
  let cached, pending;
  return async function inspect(force = false) {
    if (!enabled) return { configured: false, checkedAt: now(), items: [] };
    if (pending) return pending;
    if (!force && cached && now() - cached.checkedAt < 30000) return cached;
    pending = (async () => {
      const checks = [
        ['网页桌面服务', async () => {
          const r = await fetcher('http://127.0.0.1:6080/vnc.html', { signal: AbortSignal.timeout(2500), redirect: 'error' });
          if (!r.ok || !(await r.text()).includes('noVNC')) throw new Error('noVNC 页面不可用');
          return 'noVNC 页面可读取；不代表已经看到桌面画面';
        }],
        ['桌面认证服务', async () => {
          const r = await fetcher('http://127.0.0.1:19091/api/health', { signal: AbortSignal.timeout(2500), redirect: 'error' });
          if (!r.ok || String((await r.json()).status).toLowerCase() !== 'ok') throw new Error('认证服务健康接口异常');
          return 'Authelia 健康接口正常；未执行用户登录或手机绑定';
        }],
        ['VNC 桌面端口', async () => { await vnc(); return 'RFB 初始握手正常；未输入密码、未操控微信'; }],
      ];
      const items = await Promise.all(checks.map(async ([name, run]) => {
        try { return { name, level: 'ok', text: await run() }; }
        catch { return { name, level: 'bad', text: '服务探测失败或超时', advice: '检查对应服务；此检查不会自动重启服务' }; }
      }));
      cached = { configured: true, checkedAt: now(), items };
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
