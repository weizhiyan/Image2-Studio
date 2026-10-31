# 视频生成：跑通 + 稳定方案

## 一、现在为什么跑不通（三条，都已实测）

### 1. 协议用错了

`api.lk888.ai` 不提供 OpenAI 视频端点。实测 `POST /v1/videos` → 404。
正确端点是 `POST /v1/media/generate` + `GET /v1/media/status`。

### 2. 每个模型的参数名都不一样（最关键的架构问题）

实测三个模型：

| 模型 | 参考图参数 | 时长参数 | 其它 |
|---|---|---|---|
| `seedance-2.0-anci` | `images` | `duration` 4~15 | `version`(快速/标准) `aspect_ratio` `resolution`(720p) |
| `wan2.6-shouzheng` | `img_url` | `duration` 3/6/9/12/15 | `quality`(fast/standard) `resolution`(720P/1080P) `shot_type` `prompt_extend` |
| `gk-video-3.5` | `images`（必填） | `duration` 1~15 | `aspect_ratio` `resolution`(720p/480p) |

**没有一套通用参数能覆盖所有模型。** 硬编码一套 → 换个模型就挂。

### 3. 你的余额只剩 1 算力

```
GET /v1/skills/balance
→ {"balance":1,"unit":"算力"}

seedance-2.0-anci   6.6528 / 次
wan2.6-shouzheng    0.5443 / 次
gk-video-3.5        0.1362 / 秒
```

你当前配置的 `seedance-2.0-guanfang-anmiao` 是**按秒计费**，余额 1 根本不够。
**这一条本身就足以让「视频生成一直有问题」。**

---

## 二、目标架构：让「加了模型就能跑」成为自然结果

### 核心洞察

这个中转站把**模型参数 schema 暴露成了 API**：

```
GET /v1/skills/models?type=video           → 模型清单（含 available_for_this_key）
GET /v1/skills/models/{name}               → 该模型的 params 定义
GET /v1/skills/models/{name}/pricing       → 该模型的价格
GET /v1/skills/balance                     → 余额
```

`params` 长这样：

```json
[
  {"name":"duration","label":"视频时长","type":"select","required":true,
   "options":[{"label":"4","value":"4"},{"label":"5","value":"5"}]},
  {"name":"images","label":"参考图片","type":"upload","required":false},
  {"name":"prompt","label":"提示词","type":"textarea","required":true}
]
```

所以**不要为每个模型写代码**，而是：

> 拉到 params → 动态渲染表单 → 用户填 → 原样塞进 `params` 发出去

`type` 到控件的映射：

| type | 控件 |
|---|---|
| `select` / `radio` | 下拉 / 单选，值必须取自 `options[].value` |
| `upload` | 上传（本机图 → 图床 或 直接 data URL） |
| `switch` | 开关，值 `true`/`false` |
| `textarea` | 多行输入 |

### 接口契约（可直接照抄）

**提交**
```http
POST {base}/v1/media/generate
Authorization: Bearer {key}
Content-Type: application/json

{
  "model": "wan2.6-shouzheng",
  "prompt": "一只猫从沙发上跳下来，镜头跟随",
  "params": { "quality": "fast", "resolution": "720P", "aspect_ratio": "16:9",
              "duration": "3", "img_url": "https://..." }
}
```
```json
{ "code": 200, "data": { "task_id": 12345 }, "msg": "Task created successfully" }
```

> `task_id` 是数字。`data.任务ids` 等中文字段是兼容老 SDK 的，**不要用**，官方说 2 个月后下线。

**轮询**
```http
GET {base}/v1/media/status?task_id=12345
```
```json
{
  "cost": 1.5, "error": "", "is_final": true, "progress": "100%",
  "result_type": "video", "result_url": "https://cdn.example.com/video/abc.mp4",
  "state": "success", "status": "生成完成", "status_group": "已完成", "task_id": 12345
}
```

判据：
- `is_final === false` → 继续轮询（**不要**用 `state` 猜）
- `is_final === true && result_url` → 成功，下载
- `is_final === true && error` → 失败，把 `error` 给人看
- `progress` 是字符串 `"45%"`，要 `parseInt`

**参考图**
- `upload` 类型参数收**公网直链 URL**
- 也支持 `data:<mime>;base64,<数据>` 内联（单文件 ≤10MB、单次合计 ≤30MB、请求体 ≤50MB）
- **所以本机 `/api/files/xxx.png` 可以直接转 data URL 塞进去，不一定非要图床** ← 这能省掉 catbox 那一步

---

## 三、落地步骤

### Step 1：协议显式化（不要猜）

```ts
export type VideoApiMode =
  | 'openai-videos'      // OpenAI Sora 格式
  | 'grsai-generate'     // GrsAI
  | 'media-generate'     // 中转站通用（lk888 / kk0606 / 同类）
  | 'ark-format'         // 火山方舟格式（seedance 官方直连）
  | 'auto';
```

设置面板里给下拉，默认 `auto`，但**识别不出来时不要静默落到 openai-videos**，
而是提示「无法识别该中转站的视频协议，请手动选择」。

### Step 2：新增 `media-generate` 适配器

`bridge/videoApi.ts` 加三个函数：

```ts
listMediaModels(profile, type='video')   // GET /v1/skills/models?type=video
describeMediaModel(profile, name)        // GET /v1/skills/models/{name} → params
createMediaTask(profile, {model, prompt, params})  // POST /v1/media/generate
getMediaTask(profile, taskId)            // GET /v1/media/status?task_id=
```

`VideoTaskSnapshot` 增加 `isFinal` 字段，轮询以它为准。

### Step 3：视频节点动态表单

节点里不要写死「时长 / 分辨率 / 比例」三个下拉。
选中模型后拉 `params`，按 schema 渲染。用户改模型时表单自动换。

**这直接实现了你要的「添加模型 → 流程就能跑通」。**

### Step 4：生成前预检（省得白跑）

```ts
const [balance, pricing] = await Promise.all([...]);
if (balance.balance < estimatedCost) {
  return fail(`余额不足：本次约需 ${estimatedCost} 算力，当前 ${balance.balance}。请充值或换更便宜的模型`);
}
```

顺便把 `available_for_this_key === false` 的模型**从可选列表里过滤掉**
（官方明确说这类模型硬调必 403，不是 Key 失效也不是余额问题）。

### Step 5：修轮询记账（GrsAI 路径同样受益）

`bridge/videoTasks.ts` catch 分支必须写回 attempts：

```ts
} catch (err) {
  const updated = await patchTask(record.taskId, { attempts, error: message });
  if (attempts >= MAX_POLL_ATTEMPTS) { ... }
}
```

退避：5s → 10s → 20s → 30s 封顶。

### Step 6：下载兜底

`result_url` 下载加 `AbortSignal.timeout(120_000)`；
超时/失败时**保留远端 URL 直接显示**，后台重试本地化。

---

## 四、稳定性清单

| 风险 | 处理 |
|---|---|
| 中转站换协议 | 协议下拉 + 识别失败时明确报错，不静默兜底 |
| 模型参数各异 | 从 `/v1/skills/models/{name}` 动态渲染，不硬编码 |
| 余额不足 | 生成前查 `/v1/skills/balance` + `/pricing`，不够直接提示 |
| 模型不可用 | 过滤 `available_for_this_key === false` |
| 轮询 404 | 区分「还没好」和「过期」：10 分钟内继续，之后提示核查 |
| 轮询永不结束 | catch 分支写回 attempts + 指数退避 |
| 视频 CDN 慢 | 下载超时 120s，失败降级远端 URL |
| 图床上传失败 | 优先试 data URL 内联，失败再走图床 |
| bridge 重启丢任务 | 已有 `video-tasks.json` 持久化，保留 |
| 重复提交计费 | 已有 `submissionUnknown` 机制，保留 |

---

## 五、立刻可做的三件事

1. **充值**（当前 1 算力，连最便宜的模型都跑不了几次）
2. 换一个**按次计费且便宜**的模型测试：`wan2.6-shouzheng`（0.54/次）或 `gk-video-3.5`（0.1362/秒 × 3 秒 ≈ 0.41）
3. 视频想先能用：**用 GrsAI 那一路**，先修 Step 5 的 attempts 记账

---

## 六、附：本次实测的原始响应

```bash
# 端点清单
GET  https://api.lk888.ai/v1/skills

# 视频模型（含 available_for_this_key）
GET  https://api.lk888.ai/v1/skills/models?type=video

# 单模型参数 schema
GET  https://api.lk888.ai/v1/skills/models/wan2.6-shouzheng

# 价格
GET  https://api.lk888.ai/v1/skills/models/wan2.6-shouzheng/pricing

# 余额
GET  https://api.lk888.ai/v1/skills/balance
→ {"balance":1,"unit":"算力"}
```
