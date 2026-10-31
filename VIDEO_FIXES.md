# 视频生成链路修复清单

## 已修复的问题

### 🔴 问题 1: 文生视频被强制要求参考图 (致命)
**位置**: `bridge/http.ts:600-640`

**原问题**:
```typescript
if (rawImageUrls.length === 0 && rawFileNames.length === 0) {
  json(res, 400, { code: 1, data: null, msg: '请先把一张图片节点连接到视频节点,再提交图生视频' });
  return;
}
```
用户输入"一只猫在草地上奔跑"点生成 → 直接报错"请先连图片" → 完全不可用

**修复**: 重构了参考图检查逻辑,只在 `hasReferenceImages === true` 时才检查图床配置,文生视频不再强制要求参考图。

---

### 🟡 问题 2: 轮询器的成品重复下载
**位置**: `bridge/videoTasks.ts:248-252`

**原问题**: `isPending` 只检查 `record.url`,导致 GrsAI 同步协议的任务下载到一半 bridge 重启后会被重复轮询。

**修复**:
```typescript
function isPending(record: VideoTaskRecord): boolean {
  if (record.status === 'completed' || record.status === 'failed') return false;
  if (record.url) return false;
  if (record.submissionUnknown) return false;
  return record.status === 'queued' || record.status === 'in_progress';
}
```
现在同时检查 `status` 和 `url`,已完成的任务不会被重复轮询。

---

### 🟡 问题 3: 分辨率只适配 GrsAI
**位置**: `bridge/videoApi.ts:143-165`

**原问题**: 硬编码 `720p → 768p`,只适配 GrsAI,其他模型(Minimax / Kling / Grok)会报 `invalid resolution`。

**修复**: 新增 `resolveVideoResolution(profile, requested)` 函数,按模型自适应:
- **GrsAI**: 720p → 768p (文档写死的怪异命名)
- **Minimax-H3**: 480p→SD, 720p/1080p→HD (只有两档)
- **其他模型**: 原样透传 480p / 720p / 1080p

---

### 🟢 问题 4: 视频节点进度条
**位置**: `src/components/canvas/FlowImageNode.tsx:122-132`

**检查结果**: 进度条组件 `NodeVideoRunningVisual` 和样式 `.image-node-video-progress` 已完整实现,`videoStatus==='running'` 时会显示 0-100% 的进度。

**无需修复**,已经正常工作。

---

### 🟢 问题 5: 视频提示词规范缺失
**位置**: `bridge/mcp.ts:新增工具`

**原问题**: AI 对话只有图片提示词规范(`huiban_prompt_guide`),不知道怎么写视频提示词。

**修复**: 新增 `huiban_video_prompt_guide` MCP 工具,返回:
- **结构要素**: 主体动作、镜头运动(推拉摇移/跟随/环绕/固定)、场景环境、时长与节奏、画面风格
- **典型场景**: IP 动效、背景动效、产品展示、交互动效(各有提示词模板)
- **实例**:
  - `一只橘猫从沙发跳到窗台,镜头跟随,阳光洒进客厅,5秒,温馨生活风格`
  - `Logo 从屏幕中央旋转放大,粒子特效环绕,赛博朋克风格,蓝紫色调,8秒`
  - `产品从左侧滑入画面中央,360度环绕展示,白色背景,专业摄影棚光线,12秒`
- **参考图规则**: 首帧(锁定主体)、尾帧(定向过渡)、风格参考(只迁移氛围)
- **实用技巧**: 时长控制、镜头稳定性、避免过度描述、画幅选择

---

### 🟢 问题 6: 参考图用途混淆
**位置**: `bridge/videoApi.ts:64-76` + `174-191`

**原问题**: 直接把 `imageUrls` 数组扔进请求体,没区分首帧/尾帧/风格参考。

**修复**:
1. 类型定义加上 `referenceMode?: 'first_frame' | 'last_frame' | 'style'`
2. 请求体构建函数加上详细注释,标注各模型的参考图处理方式
3. 预留 TODO 注释:`// TODO:按 referenceMode 分拆 first_frame / end_frame / style_reference`

**实际分拆逻辑**需要确认各模型的具体参数名后实现(例如 Kling 的尾帧字段是 `endFrame` 还是 `lastFrame`)。

---

## ⚠️ 待定问题(需要你的反馈)

### 问题 7: 模型配置字段冗余
**位置**: `bridge/settings.ts:ModelProfile`

**问题描述**:
```typescript
export interface ModelProfile {
  id: string;
  kind: ProfileKind; // 'image' | 'text' | 'video'
  model: string;
  defaultSize: string; // ← 视频配置里是空串,但字段一直在
  imageApiMode?: ImageApiMode; // ← 只有 image 用,video 配置里挂着
  responsesModel?: string; // ← 只有 image 用
  videoApiMode?: VideoApiMode; // ← 只有 video 用
}
```

**建议方案**: 拆分成三个专属接口:
- `ImageProfileConfig { model, defaultSize, models, enabledModels, imageApiMode, responsesModel }`
- `VideoProfileConfig { model, models, enabledModels, videoApiMode }`
- `TextProfileConfig { model, models, textFormat }`

**工作量**: 大(需要改 `settings.ts` / `settingsStore.ts` / `SettingsPanel.tsx` 三处),而且会影响已保存的配置文件。

**决策**: 先放着,等前面修复测试通过后再决定要不要重构。

---

## 📋 测试清单

### 1. 文生视频(问题 1 修复验证)
- [ ] 输入纯文本提示词(无参考图)点生成 → 应该正常提交,不报错
- [ ] 提交后 bridge 日志应该显示 `已受理` / `视频任务已受理`

### 2. 图生视频(参考图链路)
- [ ] 连接一张图片节点到视频节点 → 点生成 → 应该先上传图床再提交任务
- [ ] 没配置图床时应该报错:`图生视频需要先把本机图片转为公网 HTTPS 地址`

### 3. 轮询器(问题 2 修复验证)
- [ ] 提交任务后在 `~/.huiban/video-tasks.json` 看到记录
- [ ] 任务完成后 `status: "completed"` 且 `url: "/api/files/xxx.mp4"`
- [ ] 重启 bridge → 该任务不应该被重新轮询(日志里不出现这个 taskId)

### 4. 分辨率兼容(问题 3 修复验证)
- [ ] 选择 **Minimax-H3** 模型,选 **480p** → 发送给上游的应该是 `SD`
- [ ] 选择 **Minimax-H3** 模型,选 **1080p** → 发送给上游的应该是 `HD`
- [ ] 选择 **GrsAI** 模型,选 **720p** → 发送给上游的应该是 `768p`
- [ ] 选择 **Kling / Seedance** 模型,选 **1080p** → 发送给上游的应该是 `1080p`(原样透传)

### 5. 进度显示(问题 4 验证)
- [ ] 提交任务后节点上应该显示 `视频生成中` + 进度条
- [ ] 进度应该从 0% 逐渐增长到 100%
- [ ] 进度条样式应该是紫色/蓝色渐变(与图片生成的流光一致)

### 6. AI 对话视频提示词(问题 5 验证)
- [ ] 在对话里问"帮我生成一个 IP 动效" → AI 应该先调 `huiban_video_prompt_guide`
- [ ] 返回的提示词应该包含:主体动作、镜头运动、时长、风格
- [ ] 例如:`小猫咪眨眼,头部轻微摆动,镜头固定,可爱卡通风格,5秒`

### 7. 参考图用途(问题 6 标注验证)
- [ ] 代码里 `VideoCreateParams` 有 `referenceMode` 字段
- [ ] 请求体构建函数有详细注释说明首帧/尾帧/风格的区别
- [ ] (实际分拆逻辑等你确认各模型参数后再测)

---

## 🚀 下一步

1. **立即测试**: 按上面清单逐条验证,重点是问题 1(文生视频)和问题 3(分辨率)
2. **确认模型参数**: 给我看一次真实的中转站请求/响应(Minimax / Kling / GrsAI 各一次),我补全参考图用途的实际分拆逻辑
3. **考虑重构**: 测试通过后再决定要不要做问题 7(模型配置拆分),不着急

---

## 📝 额外发现

在审查代码时还发现了一些**小问题**(不影响核心功能,但值得注意):

1. **图床配置缺失提示不够明显**: 用户第一次图生视频时,报错只在提交阶段出现,建议在连接图片节点时就前置检查并提示"需要配置图床"
2. **视频节点的失败重试按钮缺失**: `NodeSelectionToolbar` 里有图片的重试按钮,但视频节点失败后只能手动删除再重新创建
3. **视频进度推送的防抖缺失**: `bridge/videoTasks.ts:290` 的 `pushVideo` 在进度变化时立即推送,1% → 2% → 3% 会发 100 次 SSE,建议加个 5% 步进或 3 秒防抖

这些放到第二优先级,等核心问题测试通过后再看要不要改。
