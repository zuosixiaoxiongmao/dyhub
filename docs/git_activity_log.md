## [2026-11-10 02:07:56] f1cac50: feat(ai): 新增 AI 自动发言助手与实时回复日志

**Files:** 5 files changed
**Lines:** +260 -5

### 变更内容
- 新增 `src/ai/chatAssistant.ts`：按房间聚合弹幕，按配置间隔调用 OpenAI 兼容接口，由模型判断是否值得回复（`[SKIP]`），支持多提示词文件、配置持久化与运行日志。
- `src/api/server.ts`：新增 `/api/ai-chat` 配置接口、提示词查询/保存接口、日志查询接口，以及 `/api/ai-chat/log-stream` WebSocket 实时日志流。
- `src/index.ts`：装配 `ChatAssistant`，随服务关闭一并释放。
- `src/ui/dashboard.html`：新增 AI 设置面板（开关、API 地址/模型/Key、间隔、弹幕条数、提示词管理）与 AI 回复日志面板。
- `src/dispatch/wsServer.ts`：`WsDispatcher` 改为 `noServer` 模式手动匹配 `/ws` 路径。

### 提交原因
为直播间增加可配置的 AI 自动参与聊天能力，并在控制台实时展示每轮判断结果，便于观察与调试。同时修复 WS 端点共存问题：`ws` 以 `{ server, path }` 挂载时会对不匹配路径的 upgrade 请求回 400，与新增的 AI 日志端点共用 HTTP server 时会打断已升级的连接，改为手动路径匹配后两个端点互不干扰。

---

## [2026-11-12 23:10:25] 0623d5a: feat(ai): 新增弹幕游戏改进建议记录工具

**Files:** 5 files changed
**Lines:** +325 -13

### 变更内容
- 新增 `src/ai/suggestionStore.ts`：把 AI 提炼的游戏改进建议持久化到 `data/ai-suggestions.json`，按房间隔离、同房间 7 天内相同内容去重，最多保留 2000 条，支持列表、删除与按房间清空。
- `src/ai/chatAssistant.ts`：新增 `record_suggestion` Agent 工具（建议内容、观众昵称、分类、原始弹幕），在固定工作流中引导模型识别玩法/平衡/功能/体验/性能/BUG 等改进建议；新增 `suggestionEnabled` 配置（默认开启），调试面板模拟弹幕不写入建议库，日志中展示记录/去重结果。
- `src/api/server.ts`：新增 `GET/DELETE /api/ai-chat/suggestions`、`DELETE /api/ai-chat/suggestions/:id`。
- `src/ui/dashboard.html`：AI 设置新增“记录游戏改进建议”开关，并新增建议查看面板（刷新、逐条删除、清空全部）。
- `CLAUDE.md`：补充建议库模块与控制面接口说明。

### 提交原因
让 AI 在分析直播弹幕时自动沉淀观众对游戏的改进建议，避免有价值的产品反馈随弹幕流丢失；控制台可直接查看和维护，方便后续整理进需求池。

---
