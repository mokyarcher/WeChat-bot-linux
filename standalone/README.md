# 独立运行层开发说明

架构与入口见 [项目说明](../README.md)，线上操作见 [部署维护](../部署维护.md)，待办统一见 [面板适配计划](../Linux面板适配计划.md)。

## 代码职责

| 文件 | 职责 |
|---|---|
| server.mjs | HTTP 服务、宿主接口适配、原插件 apply 加载、配置与动作白名单 |
| bowxt.mjs | 群范围约束、消息格式、长轮询、历史搜索、发送请求幂等与确认 |
| model.mjs / presets.mjs | OpenAI-compatible Chat Completions 与预设、密钥复用规则 |
| history.mjs | 当前群已记录消息的游标分页与逐页文字匹配，限制页大小、游标和群范围 |
| service-health.mjs | 显式开启后的 noVNC、Authelia 和 VNC 本机只读检查，30 秒缓存及并发合并 |
| persona-backups.mjs | 当前群人格快照列表/摘要、路径与双摘要校验、恢复前回退副本；不处理全量部署备份 |
| memory-backups.mjs | 当前群长期记忆整库快照、摘要预览、路径与双摘要校验、恢复前回退副本；不导出短期聊天或其他群数据 |
| setup.html | 模型配置、测试与启停首页 |
| bowxt-test-group-web.py | 接入包装入口、限制 chat_id=1、关闭自动发现、报告扫描完成、识别自身昵称 |
| wechat-soul.service / nginx-*.conf | 现有服务器模板，其他主机使用前需调整 |
| desktop-auth.service / nginx-desktop.conf | Authelia systemd 模板、网页桌面鉴权与 WSS 代理；nginx-https.conf 引用已安装的位置配置，部署前须准备认证服务 |
| prepare-management.py | 当前部署的初始化辅助脚本，不是完整安装或升级工具 |
| test/ | 假模型、假接入服务及时间/暂停边界回归 |

历史查询支持 since/until 标准 UTC ISO 边界（含开始、不含结束）；页面按北京时间日期生成边界，结束日期含当天。日期匹配只使用 observed_at，未知接收时间不猜测，回传 unknownTimeCount。仍按原始记录页推进游标，不根据非单调的微信分组时间提前终止分页。

业务在 upstream/wechat-bot/wechat-group-agent/lib，已有本地补丁，并非原样上游。修改面板后需要重新生成 lib/client.js。

## 启动

需要 Node.js 22+ 和已运行的 bowxt 服务。以下为 Linux shell 示例：

```bash
cd standalone
BOT_ROOT=.. BOT_DATA=./data node server.mjs
```

| 变量 | 默认值 / 含义 |
|---|---|
| BOT_ROOT | ..，包含 upstream/wechat-bot 的根目录 |
| BOT_DATA | ./data，私有数据目录，相对工作目录解析 |
| PORT | 18788，仅监听 127.0.0.1 |
| BOWXT_URL | http://127.0.0.1:8787 |
| BOWXT_CHAT_ID | 1；包装入口同样固定为 1，改变量不会自动开放其他群 |
| BOWXT_CHAT_NAME | 小鲸鱼调教，需与 bowxt 配置和微信标题一致 |
| PUBLIC_ORIGIN | 公网来源校验，线上为 https://chat-manage.sharex.team |
| DESKTOP_HEALTHCHECKS | 默认关闭，值为 1 时探测固定本机 6080、19091、5900，不执行登录或 UI 操作 |

进程将 DSH_HOME 指向 BOT_DATA，不需要安装 DSH。持久化配置覆盖代码默认值，因此仅改默认值不代表线上参数会随之变化。

## 配置与边界

首页提供模型预设与自定义接口。密钥保存于 BOT_DATA/model.json，状态只返回 hasKey；不同接口不能静默沿用旧密钥。当前部署用 DeepSeek，其余预设主要经模拟验证，不能保证实际账号已开通相应模型。

完整面板位于 /wechat-bot，操作受 supportedActions 和 editableConfig 限制。开放前必须核对实际实现、群范围、参数、持久化和错误反馈，而非只解除白名单。旧自检、固定登录状态等待适配。

当前仅投递文字；跨群记忆关闭，昵称身份有同名/改名限制。消费 ACK 表示已交给原插件，不保证异步回复、记忆更新已完成。退出恢复待补；发送不确定时需核查，不盲目重试。

记忆页支持当前群长期记忆的完整快照、摘要预览和恢复。创建/恢复前需暂停接入并确认 UI 工作线程空闲，恢复会先保存当前 facts 并更新业务内存缓存，之后保持暂停。快照目录为 `BOT_DATA/memory-snapshots/`，与单次低权重清理备份 `memory-backups/` 分开。当前不提供自动保留清理，也不包括短期对话、人格状态或模型配置。

手动页通过 /runtime/messages 查询最近和更早记录，仅限接入已记录消息，不是微信全量历史；关键词逐页匹配。手动 sendText 动作要求固定房间、纯文字不超过 2000 字和请求 UUID；总回复或接入暂停均阻止。相同 UUID + 文本沿用持久化发送请求，不同点击生成新 UUID；未确认请求保存在当前标签页 sessionStorage，成功后清除。出站映射中的 manual 项保留以支持跨时段重试，后续需补保留策略与容量维护。

服务启动后接入默认暂停，启用时先建立快照，再消费后续消息。业务回复开关与底层监听/发送暂停不是同一项控制。

## 验证

在 standalone 目录执行：

```bash
node --test test/*.test.mjs
```

需要回环通信和子进程权限。修改原面板/业务时，在 upstream/wechat-bot/wechat-group-agent 执行：

```bash
node build-client.mjs
node scripts/test-all.mjs
```

当前上游检查仅 5 项静态检查，不是全部历史单测。修改 bowxt 遵循其 AGENTS.md / AGENT.md；实机只在授权群低频验证。现有验证结果与原有失败项见部署维护文档。

## 发布维护规则

按 2026-11-06 用户要求，修改或发布不再例行在云服务器创建备份。先核对当前状态并尽量保留启停状态；出问题先询问用户，再决定是否用本地 Git 指定提交回退相关代码。Git 不恢复或覆盖运行数据、模型密钥、微信登录卷。面板人格/记忆快照及恢复前保护保持原有行为。详细规则见 [部署维护](../部署维护.md)。
