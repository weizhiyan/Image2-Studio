# 绘板问题诊断报告（实测版）

> 本文所有结论都来自**实际调用你机器上的配置与中转站接口**，不是读代码猜的。
> 复现脚本在 `/tmp/hb-diag/`，命令都在文中。

---

## 一、结论速览

| 项目 | 状态 | 根因 |
|---|---|---|
| 图片生成（GrsAI / grsai.dakka.com.cn） | ✅ 正常 | 端到端 35.7s 出图并落盘 |
| 图片生成（公司 / mxcwyq.top） | ❌ 失败 | 中转站生图成功，但它返回的图片地址在 `api.image2pro.top`，**下载速度只有 1.3–15 KB/s**；bridge 下载时**没有超时**，最终报 `fetch failed` |
| 视频生成（Free Ai / api.lk888.ai） | ❌ 必然失败 | 代码走 OpenAI `/v1/videos`，该站**根本没有这个端点**；正确端点是 `POST /v1/media/generate` |
| 视频生成（GrsAI minimax-h3） | ⚠️ 时好时坏 | 端点正确，但结果查询 404 的**重试/超时记账有洞**，失败时把上游原始 JSON 直接抛给用户 |

---

## 二、图片生成：为什么「公司」这一路必挂

### 2.1 实测证据

**① 生图接口本身是好的：**

```
POST https://mxcwyq.top/v1/images/generations
model: gpt-image-2.5-sunburst
→ 200 OK，37.8s
→ {"data":[{"url":"https://api.image2pro.top/vimg/55a204573afa6d4fa2786613c0818cfa"}]}
```

**② 但这个图片地址慢到不可用：**

```
GET https://api.image2pro.top/vimg/55a204573afa6d4fa2786613c0818cfa
→ 200，Content-Type: image/png
→ 180 秒只下了 234 KB / 2.44 MB（1.3 KB/s）
→ 换 HTTP/1.1：15 KB/s，Range 请求：5.4 KB/s
→ HEAD 请求：404
```

按 15 KB/s 算，一张 2.4 MB 的图要 **2 分 40 秒**；按 1.3 KB/s 算要 **31 分钟**。

**③ 走 bridge 的真实结果：**

```
POST http://127.0.0.1:3788/api/generate
{"prompt":"...","profileId":"profile_mv6b3gey_4uptv0"}
→ 62.16 秒后 HTTP 500
→ {"code":1,"data":null,"msg":"fetch failed"}
```

### 2.2 代码缺陷

`bridge/imageApi.ts:198-204`：

```ts
} else if (item.url) {
  const fetched = await fetch(item.url);          // ← 没有 signal，没有超时
  if (!fetched.ok) throw new Error(`下载生成图失败：${fetched.status}`);
  const buffer = Buffer.from(await fetched.arrayBuffer());   // ← 没有超时
  const extension = item.url.split('?')[0].split('.').pop() || 'png';
  saved.push({ ...(await saveBuffer(buffer, extension)), revisedPrompt: item.revised_prompt });
}
```

外层 `generateImages()` 虽然设了 300 秒的 `AbortController`（第 336 行），但**这个 signal 只传给了生图请求，没传给图片下载**。所以：

- 下载卡住 → 外层 300 秒定时器 abort 了也没人监听
- Node undici 自己的连接超时触发 → 抛出裸的 `fetch failed`
- 这个裸错误一路冒到前端，用户只看到 `fetch failed`，完全不知道发生了什么

**这是「连最基础的生图都生不了」的直接原因。**

### 2.3 对比：同一套代码，GrsAI 完全正常

```
POST https://grsai.dakka.com.cn/v1/images/generations  → 200，25.3s
返回 https://file6.aitohumanize.com/file/xxx.png
GET 该地址 → 200，2.1 MB / 2.3s（897 KB/s）
走 bridge → 35.7s 出图，文件落盘成功
```

**结论：主链路代码没坏，是「公司」这一路的图床太慢 + 缺超时兜底。**

### 2.4 建议修复（按优先级）

1. **给下载加超时 + signal**（必做，10 行）
   ```ts
   const fetched = await fetch(item.url, {
     signal: AbortSignal.any([
       params.signal ?? new AbortController().signal,
       AbortSignal.timeout(120_000),
     ]),
   });
   ```
   失败时把原因说人话：`图片已生成，但从 <host> 下载超时（120s），该图床速度 <2KB/s`

2. **尝试 `response_format: "b64_json"`**（实测：该中转站**不支持**）
   实测 `{response_format:'b64_json'}` 请求 180 秒超时，中转站既没内联返回也没正常回 URL。
   这条路对 `mxcwyq.top` 走不通，但对别家可能有效——建议做成「配置项 + 失败自动回退」，
   不要写死。

3. **下载失败时降级用远端 URL**
   节点先显示 `https://api.image2pro.top/...`，后台再慢慢缓存。
   代价：远端 URL 可能过期，需在节点上标注「未本地化」。

4. **给每路配置一个「图片下载超时」设置**，默认 120 秒，慢图床用户自己调大。

---

## 三、视频生成：为什么两条都跑不通

### 3.1 Free Ai / api.lk888.ai —— 协议完全用错

中转站自己在 404 里写清楚了：

```
POST https://api.lk888.ai/v1/videos
→ 404
{"error":{"message":"Invalid URL (POST /v1/videos). 本平台不提供 OpenAI 视频格式端点
（POST /v1/videos、GET /v1/videos、/v1/videos/{id}/content 等）。
视频生成请使用平台异步端点：POST /v1/media/generate 提交（model 传视频模型名），
GET /v1/media/status?task_id=xxx 轮询结果；
gk-video-3.5、gk-video-3 也可用 GK 官方视频格式：
POST /v1/videos/generations 提交，GET /v1/videos/{request_id} 查询。
可调 GET /v1/skills/models?type=video 查看可用模型。"}}
```

而 `bridge/videoApi.ts:131-137` 的判断：

```ts
export function resolveVideoApiMode(profile, requestedModel?) {
  const configured = normalizeVideoApiMode(profile.videoApiMode);
  if (configured !== 'auto') return configured;
  const base = String(profile.baseUrl || '').toLowerCase();
  const model = String(requestedModel || profile.model || '').toLowerCase();
  return /grsai|dakka/.test(base) || model === 'minimax-h3' ? 'grsai-generate' : 'openai-videos';
}
```

`api.lk888.ai` 既不匹配 `grsai|dakka`，模型也不是 `minimax-h3` → 落到 `openai-videos` → 必然 404。

### 3.2 lk888 的真实契约（实测）

```
POST https://api.lk888.ai/v1/media/generate
{}                                   → {"code":400,"data":{"详情":"缺少必要参数 model"}}
{model:'seedance-2.0-anci'}          → {"code":400,"data":{"详情":"缺少必要参数 prompt（可放在请求体顶层，也可放在 params 里）"}}
{model:'seedance-2.0-anci',
 prompt:'test', duration:999}        → {"code":400,"data":{"详情":"参数 duration 的值 999 超出该模型支持的时长范围（4~15 秒），支持的值: 4/5/.../15"}}

GET https://api.lk888.ai/v1/media/status?task_id=__nope__
→ {"code":400,"msg":"task_id 格式错误"}

GET https://api.lk888.ai/v1/skills/models?type=video
→ 200，返回完整视频模型清单（含 display_name / description / input_hint / tags）
```

**关键点：**

- 提交端点：`POST /v1/media/generate`，必填 `model` + `prompt`，`prompt` 可放顶层或 `params` 里
- 轮询端点：`GET /v1/media/status?task_id=xxx`
- 模型清单：`GET /v1/skills/models?type=video`（**这个可以做成「一键拉取模型列表」**）
- 返回体是 `{code, data, msg, error_code}` 这套，**不是 OpenAI 的 `{id, status}`**

### 3.3 参考图必须公网直链

模型 `seedance-2.0-anci` 的 `input_hint` 原文：

> Images must be publicly accessible direct links

所以图生视频必须先把 `/api/files/xxx.png` 传到图床。你当前图床配置是 catbox：

```
uploadUrl: https://catbox.moe/user/api.php
fileField: file
extraFields: { reqtype: fileupload }
```

这条路是通的，但要注意：
- catbox 在国内经常被墙/很慢，上传可能失败
- 失败时 `describeImageHostFailure` 的提示要足够具体

### 3.4 GrsAI minimax-h3 —— 端点对，但重试记账有洞

你的真实任务记录（`~/.huiban/video-tasks.json`）：

```json
{ "taskId": "6-5fd4d2f7-...",  "model": "minimax-h3", "status": "failed",
  "error": "视频接口返回 404：{\"error\":\"result not exist, valid for 2 hours\"}" }
{ "taskId": "11-ee10dc10-...", "model": "minimax-h3", "status": "completed" }
```

一条成功、一条失败。失败的那条把上游裸 JSON 直接抛给了用户。

代码问题在 `bridge/videoTasks.ts:318-335`：

```ts
} catch (err) {
  // 查询本身失败（网络抖 / 429）：不当成任务失败，下一轮再试。
  if (attempts >= MAX_POLL_ATTEMPTS) {
    ... patchTask(..., { status: 'failed', error: message ... })
  }
}
```

`attempts` 是局部变量 `(record.attempts || 0) + 1`，**catch 分支只在 `attempts >= 600` 时才写回 `record.attempts`**。
所以一旦查询持续失败，`record.attempts` 一直停在旧值，`attempts` 永远是 1，
这个任务会**每 5 秒查一次、永远查下去**，既不超时也不结束。

> 注：那条 `failed` 记录里带的是 404 原文，说明它曾经走到过 `attempts >= 600` 分支——
> 也就是先成功轮询了约 50 分钟、之后才开始 404。这个记录可能产生于今天 12:38 之前的旧构建，
> 但上面说的「错误路径不累加 attempts」在当前代码里确实存在，需要修。

另外 GrsAI 的 `/v1/api/result?id=` 在结果没准备好时**返回 404 而不是 `{status:'running'}`**，现在的代码把 404 当异常抛，虽然会被 catch 住重试，但：
- 没有退避（固定 5 秒一次）
- 没有区分「还没好」和「真没了」
- 最终报错信息是给机器看的

### 3.5 建议修复

**核心思路：把「协议猜测」换成「显式选择 + 适配器注册表」。**

1. **`VideoApiMode` 增加 `media-generate`**
   ```ts
   export type VideoApiMode = 'auto' | 'openai-videos' | 'grsai-generate' | 'media-generate';
   ```

2. **新增适配器（`bridge/videoApi.ts`）**
   ```ts
   // 提交
   POST {base}/media/generate
   body: { model, prompt, duration, resolution, aspect_ratio, images? }
   → { code: 0, data: { task_id: '...' } }   // 具体字段名用一次真实请求确认

   // 查询
   GET {base}/media/status?task_id=xxx
   → { code: 0, data: { status: 'pending|processing|succeeded|failed', progress, videos: [{url}] } }
   ```

3. **设置面板把「协议」做成下拉**，别再自动猜：
   ```
   视频协议：[自动识别 ▾]  OpenAI Videos / GrsAI / Media Generate(中转站通用)
   ```
   旁边放一个「拉取视频模型」按钮，走 `GET /v1/skills/models?type=video`。

4. **修 `attempts` 记账**
   ```ts
   } catch (err) {
     const updated = await patchTask(record.taskId, { attempts, error: message });  // ← 关键
     if (attempts >= MAX_POLL_ATTEMPTS) { ...失败... }
   }
   ```

5. **错误说人话**
   ```ts
   if (err instanceof VideoRequestError && err.status === 404) {
     // GrsAI: 结果还没好，或已过期
     → 继续轮询；超过 10 分钟后提示「任务可能已过期，请到中转站后台核查」
   }
   ```

6. **轮询加退避**：5s → 10s → 20s，封顶 30s，别固定 5 秒打 50 分钟。

---

## 四、竞品分析：成熟项目怎么做「配模型 → 传参考图 → 出结果」

> 说明：本次会话的 WebSearch / WebFetch 都被网络策略拦截（返回空 / 域名无法验证），
> 以下是对这些项目架构的**既有认知**，没有实时抓取源码。落地前请让执行的 AI 对着仓库复核。

### 4.1 ComfyUI（节点式生成的事实标准）

| 环节 | 做法 |
|---|---|
| 配模型 | 用户在节点里选本地模型文件；API 节点单独填 Key |
| 参考图 | `POST /upload/image` 传到服务端 `input/` 目录，节点里用**文件名**引用 |
| 执行 | `POST /prompt` 返回 `prompt_id`，`GET /history/{id}` 轮询，或 WebSocket `/ws` 收逐节点进度 |
| 结果 | 写到 `output/`，前端用 `/view?filename=...` 取 |
| 视频 | 由 `WanVideo` / `HunyuanVideo` / `LTX-Video` 等节点完成，本质还是「图/视频张量进，帧序列出」 |

**最值得抄的一点：参考图走服务端本地文件，不需要公网 URL。** 因为生成发生在服务端，模型直接读本地文件。
绘板做不到这点，是因为生成发生在**第三方中转站**，所以必须把图变成公网地址——这是架构决定的，不是实现失误。

**可抄的第二点：进度是逐节点的、流式的。** 绘板视频只有一个百分比，可以加阶段（排队 → 生成中 → 下载中）。

### 4.2 SwarmUI / InvokeAI（队列式）

- 统一的 **job queue**：提交 → 排队 → 运行 → 完成，每个 job 有 id 和状态
- 前端订阅事件流（SSE/WS）拿进度，而不是前端自己轮询
- 参考图同样上传到服务端图库，用 id 引用
- **后端适配器分层**：`Backend` 接口 + 多实现（ComfyUI / 本地 / 远端），换后端不改前端

**可抄的点：绘板的 `videoTasks.ts` 其实已经是这个形状了，差的是「适配器注册表」和「统一事件协议」。**

### 4.3 Open WebUI / LibreChat（对话式）

- 生图配置在管理员设置里：`base URL + key + model`，跟绘板的 profile 一样
- 参考图以 **base64** 塞进请求体，不依赖图床
- 结果拿到 URL 后**前端直接渲染远端地址**，不强制本地化

**可抄的点：不强制下载。** 绘板现在「必须下载到本地才能显示」是慢图床下的死穴。
建议：远端 URL 先显示，后台异步缓存，缓存成功再替换。

### 4.4 对绘板的三条硬建议

1. **参考图链路做成「自动 + 可见」**
   - 检测到本机 `/api/files/` → 自动上传图床 → 在节点上显示上传进度
   - 上传失败给出可操作提示（换图床 / 粘贴公网链接）
   - 图床配置从「高级设置里藏很深」提到视频节点的第一次使用时引导

2. **协议适配器必须显式可选**
   - 中转站的视频 API 五花八门（OpenAI Videos / GrsAI / media-generate / Ark 格式 / 各家私有）
   - 自动猜一定猜不全，猜错的表现就是「404 / 参数错误」这种用户完全看不懂的报错
   - 给一个下拉 + 「测试连接」按钮，比什么都强

3. **任何网络等待都必须有超时和可读错误**
   - 图片下载、视频下载、图床上传、结果轮询，四处都要
   - 错误信息要包含：哪个域名、等了多久、可能的原因、下一步怎么做

---

## 五、改造清单（可直接交给执行的 AI）

### P0 — 让现有功能先能跑

- [ ] `bridge/imageApi.ts:199` 图片下载加 `AbortSignal.timeout` + 透传外层 signal
- [ ] 下载失败时错误信息带域名 + 耗时 + 速度
- [ ] `bridge/videoApi.ts` 增加 `media-generate` 适配器（`/media/generate` + `/media/status`）
- [ ] `bridge/settings.ts` 的 `VideoApiMode` 加 `'media-generate'`
- [ ] `SettingsPanel` 视频配置增加「协议」下拉 + 「拉取视频模型」按钮（`GET /v1/skills/models?type=video`）
- [ ] `bridge/videoTasks.ts:318` catch 分支写回 `attempts`
- [ ] GrsAI 404 语义化：未就绪 → 继续轮询；超过 10 分钟 → 提示核查

### P1 — 体验

- [ ] 图片下载失败降级为远端 URL 显示 + 后台重试缓存
- [ ] 视频轮询退避（5s→30s）
- [ ] 视频节点阶段化进度（排队 / 生成中 / 下载中）
- [ ] 图床上传进度 + 失败引导
- [ ] 视频生成增加 MCP 工具 `huiban_video_generate`（现在 `huiban_video_prompt_guide` 里写着「尚未暴露」）

### P2 — 稳定性

- [ ] 每个适配器加契约测试（用真实中转站的错误响应做 fixture）
- [ ] 视频任务增加「手动重试下载」（上游成功但下载失败时）
- [ ] 所有出站 fetch 统一走一个带超时/重试/日志的封装

---

## 六、待验证

- [x] `gpt-image-2.5-sunburst` 是否支持 `response_format: "b64_json"` → **不支持，180s 超时**
- [ ] lk888 `media/generate` 成功响应的确切字段名（需要一个真实任务）
- [ ] lk888 参考图的字段名是 `images` / `reference_images` / 还是放 `params` 里

---

## 附录：复现命令

```bash
# 图片：确认生图接口本身正常
node /tmp/hb-diag/test.mjs

# 图片：确认图床慢
curl -o /dev/null -w '%{speed_download} B/s\n' --max-time 60 \
  'https://api.image2pro.top/vimg/<id>'

# 图片：走 bridge 复现 500
curl -X POST http://127.0.0.1:3788/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"test","profileId":"profile_mv6b3gey_4uptv0"}'

# 视频：确认 lk888 不支持 /v1/videos
node /tmp/hb-diag/videndpoint.mjs

# 视频：确认 media/generate 契约
node /tmp/hb-diag/media.mjs

# 视频：列出可用视频模型
node /tmp/hb-diag/skills.mjs
```
