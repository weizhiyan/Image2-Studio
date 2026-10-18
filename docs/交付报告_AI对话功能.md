# 绘板 AI 对话功能 · 交付报告

按《绘板 AI 对话功能：交互、动画与验收方案》一比一复刻实现。本报告按方案 §21 的十项交付要求逐项输出。

---

## 1. 修改文件清单

**bridge 端（Node）**

| 文件 | 变更 | 说明 |
|---|---|---|
| `bridge/agent.ts` | 新增 | Agent 调用链：chat 格式原生 tools（流式）+ JSON 指令回落双协议 |
| `bridge/runs.ts` | 新增 | Agent 运行循环：run 生命周期、SSE 事件、generate_image 工具执行、节点落盘 |
| `bridge/chat.ts` | 重写 | 线程实体 CRUD，含旧数据迁移 |
| `bridge/http.ts` | 修改 | 新增 `/api/chat/threads`、`/api/chat/runs`、`/api/chat/runs/:id/events`（SSE）、`/api/chat/runs/:id/stop` |
| `bridge/hub.ts` | 修改 | `PushedImage` 增加 `source: 'chat'` 字段 |

**前端（React + zustand）**

| 文件 | 变更 | 说明 |
|---|---|---|
| `src/types.ts` | 修改 | 新增 `ChatThread / ChatMessage / ChatToolCall / ChatImageRef` |
| `src/stores/chatStore.ts` | 重写 | 多线程模型：`threads[] / activeThreadId / activeRun / draftBase / unread` |
| `src/lib/bridge.ts` | 修改 | 新增 `startChatRun / subscribeChatRunEvents / stopChatRun` 与事件类型 |
| `src/components/chat/ChatPanel.tsx` | 新增 | 悬浮卡片面板（420px、FAB、历史菜单、调宽、收起） |
| `src/components/chat/ChatComposer.tsx` | 新增 | 输入区（发送/停止、引用 chips、@ 菜单） |
| `src/components/chat/ChatMessageList.tsx` | 新增 | 消息列表（Markdown、工具过程卡、媒体三动作） |
| `src/components/chat/ChatIcons.tsx` | 新增 | 图标 |
| `src/components/chat/ChatPanel.css` | 新增 | 全 Token 化样式（过 tokens.guard） |
| `src/pages/CanvasPage.tsx` | 修改 | 对话区块替换为 agent 流：`startChatRunFlow / applyChatRunEvent / locateChatRef / retryChatMessage / continueEditFromChat`；运行恢复 effect；线程跟随画布 effect |

**测试**：`tests/chat.test.ts`、`tests/chatStore.test.ts`、`tests/chatPanel.test.tsx` 全部重写适配新 API。

---

## 2. 新增数据结构和接口说明

### 数据结构（`src/types.ts`）

```ts
ChatThread  { id, canvasId, title, messages, createdAt, updatedAt }
ChatMessage { id, role, content, status: 'running'|'done'|'stopped'|'error'|'unknown',
              error?, toolCalls?, media?, attachments?, createdAt }
ChatToolCall { id, name, args, status: 'running'|'done'|'error'|'stopped',
               steps?, error?, media? }
ChatImageRef { canvasId, nodeId, versionId, url, title }   // 版本级引用
```

图片事实源仍是画布节点；消息只存 `nodeId + versionId` 引用，不存大 base64。

### HTTP / SSE 接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/chat/threads` | GET / PUT / DELETE | 线程列表、保存、删除（删线程不删画布节点） |
| `/api/chat/runs` | POST | 起一个 run：前端传权威快照（thread + 占位 assistant 消息 + 版本级 references），返回 runId |
| `/api/chat/runs/:id/events` | GET（SSE） | 事件流；晚到连接先补发缓冲事件（刷新重连），25s 心跳 |
| `/api/chat/runs/:id/stop` | POST | 停止运行（AbortController） |

### SSE 事件

`message_delta`（文字增量）/ `thinking` / `tool_started` / `tool_progress` / `image_completed`（含 media：nodeId + versionId）/ `tool_finished`（done|error|stopped）/ `message_done` / `error` / `run_closed`

### Agent 双协议（`bridge/agent.ts`）

1. **chat 格式原生 tools**（`/chat/completions` 流式）：主路径，流式文字 + tool_calls 增量归并；
2. **JSON 指令回落**：provider 不支持 tools（5xx / 400 tool 类错误 / responses 优先）时，模型以 `{"action":"generate_image","args":{...}}` 表达调用，bridge 解析执行。含围栏与裸 JSON 两种候选匹配；非流式路径整段补发一次 `message_delta`，前端才收得到 round 1 点评。

### 工具：`generate_image`

参数 `prompt / referenceImages(编号) / referenceUsage(style|edit) / ratio / count(1-4) / baseVersionId`。单轮上限 2 次生图、4 个模型回合。节点 id 由 `runId+callId+序号` 确定性生成——重复事件不会建重复节点。responseId 续接仅限同配置同模型。

---

## 3. 面板状态和动画状态说明

**收起态**：右下角圆形 FAB（AI 按钮），不占画布空间。
**展开态**：右侧悬浮卡片（默认 420px，可调宽），右/底留稳定间距、统一圆角，覆盖节点但不引起位移，画布不重排。

**动画**：展开从左下角视觉原点起（opacity + 轻微 scale + 向上位移，180-240ms），收起反向；`prefers-reduced-motion` 下取消位移缩放只留淡入淡出；动画只用 transform/opacity。收起后不渲染不可见动画。

**状态机**：`closed → opening → open → closing → closed`；收起保留草稿与滚动位置；焦点收起后回到 AI 按钮。

---

## 4. 线程迁移策略

旧版「一画布一线程」数据（`canvasId` 键）在 bridge 启动/首次读取时自动迁移为该画布的默认线程（保留全部消息与引用），线程更新时间单调递增；本地 zustand persist 与 bridge 存储合并采用「写锁串行链 + 滚动备份 + 单调时间戳拒旧快照」，旧快照不能覆盖新数据。

---

## 5. 视觉验收结果

- ✅ 悬浮卡片而非整侧抽屉；右/底稳定间距、四角一致圆角、不贴边
- ✅ 打开时画布不重排、被覆盖节点不位移；小窗口无横向溢出
- ✅ 面板材质用绘板现有 Token（CSS 全过 tokens.guard），无新增紫色/渐变
- ✅ 图片卡稳定宽高（加载不跳）；多图网格窄面板下正常换行；长文本不溢出
- ✅ 按钮尺寸稳定，hover/focus 状态清楚

## 6. 交互验收结果

- ✅ FAB 打开 / 收起按钮关闭（草稿、滚动位置保留）/ 标题打开历史 / 新建后可切回旧对话 / 切画布跟随显示对应线程
- ✅ 画布图片「引用到对话」自动开面板出 chip；`@` 搜索选图；多图引用可调顺序
- ✅ 消息图片「定位」跨画布、切版本、定位节点；「引用」放回输入区
- ✅ Enter 发送 / Shift+Enter 换行；运行中可停止；失败可重试且不产生重复节点
- ✅ 点面板外部不误关；历史/引用/工具菜单支持 Escape

## 7. 功能验收结果

- ✅ 纯聊天不强制生图；需求不完整先追问；明确生成触发工具
- ✅ 工具过程在消息中显示（可折叠过程卡）；生成图落画布节点
- ✅ 消息图片与节点 `nodeId+versionId` 关联；下一轮自动续接最新版本
- ✅ 刷新后消息/线程/引用/节点都在；bridge 重启不重复建节点（`reconcileLostRuns` 把残留 running 标为 unknown，不伪装完成）；删对话不删节点；删画布清理其线程
- ✅ 端到端冒烟：真实模型 run 全事件链通过（追问→生图→点评）；生图一次 `fetch failed` 后 agent 循环自动重试成功

## 8. 无障碍和性能检查结果

- ✅ AI/关闭/定位/引用/预览/停止/重试按钮均有 `aria-label`；工具运行状态用 `role="status"`
- ✅ 键盘可完整操作面板；收起后焦点回 AI 按钮
- ✅ 动画仅 transform/opacity；消息列表只在必要时滚底；token 增量不触发画布重渲染（消息与画布状态分离）；面板收起后停渲染

## 9. 执行过的命令及结果

| 命令 | 结果 |
|---|---|
| `npm test` | ✅ 29 个文件、**266 个测试全部通过** |
| `npm run lint`（tsc -b） | ✅ 无错误 |
| `npm run build` | ✅ 713ms 构建完成（产物 dist/） |
| `npx tsc -p tsconfig.bridge.json` | ✅ 编译通过（bridge/dist） |
| 端到端冒烟（/tmp/hb-smoke2 :3789） | ✅ 事件链完整；两个 bug 修复均验证通过 |

**冒烟中修复的两个 bug**（本期最后收尾）：
1. 模型输出无围栏裸 JSON 时残渣漏进消息 content → `extractJsonAction/stripJsonAction` 支持围栏 > 行首 `{` > 首个完整 JSON 对象三候选，剥离后落盘为纯文字（已验证 content 无残渣）；
2. JSON 回落协议非流式、round 1 点评前端收不到 → 非流式路径整段补发 `onTextDelta` → `message_delta`（已验证前端收到完整点评）。

## 10. 未完成项、已知风险和需要产品确认的内容

**未完成（方案 §20 第四阶段，方案未列为本期必做）**：
- 上下文徽标与「更换模型/接口模式时显示上下文重置原因」的 UI 提示（底层续接判断已实现：异配置自动断链）
- 长线程摘要（当前用「最近 6 张生成图回喂 + 完整文字历史」控 token）

**已知风险**：
- `thinking` 事件已定义未启用（上游供应商普遍不推思维链增量）
- 上游 429 限流会导致单次 run 报错，用户可点重试；生图供应商偶发 `fetch failed` 已由循环自动重试兜住
- 线程历史无长度截断，超长线程 token 成本会增长（待第四阶段摘要解决）

**需要产品确认**：
- 面板默认宽度 420px、调宽范围是否符合手感
- 「图 N」编号制引用在多图场景的表述是否需要更直观的缩略图选择器

---

**服务已重启**：bridge http://127.0.0.1:3788 · 前端 http://127.0.0.1:5199/ （浏览器打开即用）
