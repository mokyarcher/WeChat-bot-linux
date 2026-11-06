export function buildLinuxHealth(snapshot, bridge, model, now = Date.now()) {
  const items = [];
  const add = (name, level, text, advice = '') => items.push({ name, level, text, advice });
  const state = snapshot.state;
  add('Linux 接入服务', state ? 'ok' : 'bad', state ? 'HTTP API 可达；不使用 hook' : '无法获取接入状态', snapshot.error || '');
  if (state) {
    add('微信连接', state.wechat_connected ? 'ok' : 'warn', state.wechat_connected ? '接入客户端已连接微信；不等同于确认账号登录' : '尚未连接微信，请检查远程桌面');
    const chat = snapshot.chats?.find(c => c.id === bridge.chatId);
    add('监听群', !chat || chat.last_error ? 'bad' : 'ok', chat ? `${chat.name}${chat.last_error ? '：' + chat.last_error : '；内部 ID ' + chat.id}` : '未找到指定群', chat?.last_error ? '检查群名、搜索浮层和输入锁；不要绕过安全保护' : '');
    const age = (now / 1000 - Number(state.last_poll_completed_at));
    const paused = state.paused || !bridge.polling;
    add('消息扫描', paused ? 'warn' : !Number.isFinite(age) || age > 60 ? 'bad' : 'ok', paused ? '接入或消费已暂停' : Number.isFinite(age) ? `最近成功扫描 ${Math.max(0, Math.round(age))} 秒前；无新消息不代表故障` : '尚无成功扫描记录');
    if (state.last_error) add('接入错误', 'bad', state.last_error);
  }
  add('模型配置', model.hasKey ? 'ok' : 'warn', model.hasKey ? '密钥已配置；本次未调用模型验证' : '尚未配置模型密钥');
  if (bridge.turns) add('业务轮次', bridge.turns.fault ? 'bad' : bridge.turns.needsReview ? 'warn' : 'ok',
    bridge.turns.fault ? '轮次存储异常，消费已停止' : `处理中/待处理 ${bridge.turns.pending}；待核查 ${bridge.turns.needsReview}`,
    bridge.turns.needsReview ? '查看运维日志中的待核查轮次；未完成轮次不会自动重放，发送结果需核查' : '');
  if (snapshot.services?.configured) items.push(...snapshot.services.items.map(item => ({ ...item, text: item.text + '；探测于 ' + new Date(snapshot.services.checkedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) })));
  return { at: now, platform: 'linux', clientConnected: state ? !!state.wechat_connected : null, items, bad: items.filter(i => i.level === 'bad'), warn: items.filter(i => i.level === 'warn') };
}
