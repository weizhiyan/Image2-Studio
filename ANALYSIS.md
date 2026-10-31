# 绘板核心问题分析（聚焦版）

**分析前提：** 已确认视频生成的基础设施都有：
- ✅ HTTP 路由 `POST /api/videos` (bridge/http.ts:569)
- ✅ 轮询器 `startVideoPoller()` (bridge/index.ts:59)
- ✅ 前端入口 `AddMenu` 有"视频生成"按钮
- ✅ 节点组件 `FlowImageNode` 处理 `kind='video'`
- ✅ 视频播放器 `<video>` 标签存在

---

## 一、视频生成问题（需实测定位）

### 1.1 可能的问题点

#### 问题 A：中转站接口适配不完整

```typescript
// videoApi.ts:136 - 自动识别逻辑
export function resolveVideoApiMode(profile: ModelProfile, requestedModel?: string): VideoApiMode {
  const configured = normalizeVideoApiMode(profile.videoApiMode);
  if (configured !== 'auto') return configured;
  const base = String(profile.baseUrl || '').toLowerCase();
  const model = String(requestedModel || profile.model || '').toLowerCase();
  return /grsai|dakka/.test(base) || model === 'minimax-h3' ? 'grsai-generate' : 'openai-videos';
}
```

**缺失：**
- `https://api.manxiaobai.online` 的识别规则
- `https://free.kk0606.com` 的识别规则
- `tt-image-2.5` 等模型的协议判断

#### 问题 B：模型配置默认值为空

```typescript
// settings.ts:180
function defaultModelForKind(kind: ProfileKind): string {
  if (kind === 'text' || kind === 'video') return '';  // ← 视频模型留空
  return 'gpt-image-1';
}
```

**后果：** 如果用户没填模型名，会触发异常：
```typescript
// videoApi.ts:123
function videoModelOf(profile: ModelProfile, requested?: string): string {
  const model = String(requested || profile.model || '').trim();
  if (!model) throw new Error('尚未选择视频模型：请先在模型设置中选择一个视频模型');
  return model;
}
```

**建议：** 保持为空（引导用户主动填写），但 UI 要提示"请手动输入模型名"

#### 问题 C：参考图必须上传图床

视频接口要求参考图必须是 **HTTPS 公网地址**，`/api/files/xxx.png` 中转站拉不到。

**检查：** `bridge/http.ts` 的 `/api/videos` 路由是否处理了参考图上传？

---

## 二、第三方 Agent 连接问题（严重）

### 2.1 连接指令内容不显示 ⚠️

```tsx
// AgentConnectDialog.tsx:103-109
<section className="agent-connect-config">
  <div className="agent-connect-config-head">
    <span>发给 Agent 的连接指令</span>
    <button onClick={copy}>{copied ? '已复制' : '复制指令'}</button>
  </div>
</section>
// ❌ 指令内容本身没有渲染！用户只能看到标题和复制按钮
```

**修复：**
```tsx
<pre className="agent-connect-config-code">{connectPrompt}</pre>
```

### 2.2 占位符未替换 ⚠️

```typescript
const mcpEntry = status.mcpEntry || '<项目绝对路径>/bridge/dist/index.js';
```

用户看到 `<项目绝对路径>` 会懵。

**修复：**
```typescript
// bridge/index.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
process.env.HUIBAN_PROJECT_ROOT = PROJECT_ROOT;
```

```typescript
// bridge/agentPresence.ts
mcpEntry: path.join(process.env.HUIBAN_PROJECT_ROOT!, 'bridge/dist/index.js')
```

---

## 三、AI 对话体验问题

### 3.1 没有流式输出

**现状：**
- `textApi.ts` 调用语言模型时 `stream: false`
- `runs.ts` 只在完成时推送一次 SSE
- `ChatMessageList` 一次性显示整段文本

**影响：** 长文本等待时看不到进度

**修复方案：**
1. `textApi.ts` 启用 `stream: true`
2. `runs.ts` 推送 `{ type: 'delta', delta: '...' }` 事件
3. `ChatMessageList` 累积显示

---

## 四、细节规范问题

### 4.1 错误提示不统一

- 有的用 `alert()`
- 有的写 `node.data.error`
- 有的在对话消息里

**建议：** 统一 Toast 组件

### 4.2 加载状态不统一

- 图片生成有"生成中"
- 模型列表拉取无 loading
- 参考图上传无进度

**优先级：** P2（当前还能接受）

---

## 五、视频功能增强（用户提出）

### 5.1 优化脚本按钮

**需求：** 视频节点增加"优化脚本"按钮，保留原意但让提示词更精准

**实现：**
```typescript
// FlowImageNode.tsx
{kind === 'video' && status === 'idle' && (
  <button onClick={async () => {
    const optimized = await enhancePromptApi({
      prompt,
      mode: 'video',
    });
    patchPrompt(optimized.prompt);
  }}>
    <MagicIcon /> 优化脚本
  </button>
)}
```

**需要新增：**
- `textApi.ts` 视频优化模式
- MCP 工具 `huiban_video_optimize`

### 5.2 AI 生成脚本（对话集成）

**需求：** 对话中让 AI 生成脚本，一键应用到画布

**实现：**
```typescript
// ChatMessageList.tsx - 消息右键菜单
<button onClick={() => {
  const script = extractVideoScript(message.content);
  createVideoNode({ prompt: script });
}}>
  应用到画布
</button>
```

---

## 六、优先级清单

### P0（立即修复）

1. ⚠️ **Agent 连接指令不显示**
   - [ ] `AgentConnectDialog` 渲染 `<pre>{connectPrompt}</pre>`
   - [ ] CSS 样式 `.agent-connect-config-code`
   
2. ⚠️ **占位符未替换**
   - [ ] `bridge/index.ts` 计算 `PROJECT_ROOT`
   - [ ] `agentPresence.ts` 使用真实路径

### P1（严重影响）

3. **视频生成可能跑不通**（需实测）
   - [ ] 测试 manxiaobai / kk0606 识别
   - [ ] 测试 `tt-image-2.5` 模型
   - [ ] 测试带参考图的生成（图床）

4. **AI 对话没有流式输出**
   - [ ] `textApi.ts` 启用 `stream: true`
   - [ ] `runs.ts` 推送 delta
   - [ ] `ChatMessageList` 打字机效果

### P2（改善体验）

5. **视频功能增强**
   - [ ] 优化脚本按钮
   - [ ] 对话消息应用到画布

6. **Agent 连接状态**
   - [ ] 显示当前操作的画布
   - [ ] 显示最近动作

7. **统一规范**
   - [ ] Toast 错误提示
   - [ ] 加载状态指示器

---

## 七、立即行动建议

### 第一步：修复 Agent 连接（15 分钟）

```tsx
// src/components/AgentConnectDialog.tsx
<section className="agent-connect-config">
  <div className="agent-connect-config-head">
    <span>发给 Agent 的连接指令</span>
    <button onClick={copy}>{copied ? '已复制' : '复制指令'}</button>
  </div>
  <pre className="agent-connect-config-code">{connectPrompt}</pre>
</section>
```

```css
/* src/components/AgentConnectDialog.css */
.agent-connect-config-code {
  margin-top: 12px;
  padding: 12px;
  background: var(--color-bg-tertiary);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
```

```typescript
// bridge/index.ts
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
process.env.HUIBAN_PROJECT_ROOT = PROJECT_ROOT;
```

```typescript
// bridge/agentPresence.ts
export async function readAgentPresence(): Promise<AgentStatus> {
  const projectRoot = process.env.HUIBAN_PROJECT_ROOT || '';
  return {
    ...
    mcpEntry: projectRoot ? path.join(projectRoot, 'bridge/dist/index.js') : '',
    nodeCommand: projectRoot ? path.join(projectRoot, 'bridge/mcp-launch.sh') : '',
  };
}
```

### 第二步：实测视频生成（30 分钟）

1. 添加 manxiaobai 视频模型（设置面板）
2. 画布双击 → 视频生成 → 输入提示词 → Enter
3. 观察：
   - Network 面板：是否 POST `/api/videos` 成功
   - 控制台：是否有报错
   - 节点：是否显示进度
   - 最终：是否播放视频

**如果失败：** 把错误日志发给我定位

### 第三步：流式对话（1 小时）

暂缓，先把前两步跑通。

---

## 八、总结

### 确认的问题

1. ⚠️ **Agent 连接指令不显示**（严重）
2. ⚠️ **占位符未替换**（严重）
3. ❓ **视频生成可能跑不通**（需实测）
4. **AI 对话无流式输出**（体验）
5. **错误提示不统一**（细节）

### 已排除的误判

- ~~画布上没有视频入口~~（有，AddMenu）
- ~~没有视频播放器~~（有，FlowImageNode）
- ~~节点选中不明显~~（有高亮）
- ~~加载状态缺失~~（当前可接受）

### 下一步

按"第七节"顺序修复：
1. Agent 连接指令（2 个文件）
2. 实测视频生成
3. 根据实测结果再调整优先级
