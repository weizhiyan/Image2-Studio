# 请求可信：F10/F11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. 本会话串行实施，不创建 worktree，不提交代码。

**Goal:** 修复 Responses 外层模型选错，以及新增参考图被旧续接吞掉的问题。

**Architecture:** 在 bridge 内放置不依赖 Node 的纯请求上下文 helper，供画布与聊天复用。供应商适配器只在调用方显式确认纯基准续接时省略基准图，其他带图请求保留全部素材并断开旧链；三个生产入口不再把图像模型当外层模型。

**Tech Stack:** TypeScript、React、Node bridge、Vitest。

**Spec:** `../../../../文档归档/AI深度优化/2026-11-07_代码核验清单与优先级.md` 的 F10/F11，以及同目录生成链路改造建议的阶段 A。F01/F02/F03/F05 属于后续同阶段小批次，不混入这次验收。

## Global Constraints

- 不调用付费生图或语言模型，不读取真实 Key、画布、聊天、图片，不改真实配置。
- 所有测试使用独立 HUIBAN_DATA_ROOT，先创建 media；上游使用完整 mock 与合成素材。
- 保留既存 dirty 改动、真实尺寸、写锁、墓碑、备份、CAS、停止状态和占位节点生命周期。
- 不 commit、push、创建 PR 或 worktree。当前分支为 fix/trusted-image-requests。
- 不升级模型默认值，不跨供应商组合语言模型名与图像供应商 Key。
- 不新增 UI 控件，不改 CSS，不改 bridge 的 rootDir。

## Task 1：独立模型与续接合同

**Files:** 新增 `bridge/imageRequestContext.ts`、`tests/imageRequestContext.test.ts`；修改 `bridge/imageApi.ts`、`tests/imageApi.test.ts`。

**Interfaces:**

```ts
resolveResponseModel(profile: { responsesModel?: string }, requested?: string): string
resolveImageContinuation(input: {
  base?: { responseId?: string; imageGenerationCallId?: string;
    responseProfileId?: string; responseModel?: string; model?: string };
  profile: { id: string; model: string; responsesModel?: string };
  apiMode: 'images' | 'responses'; model?: string;
  isEdit: boolean; hasNewReferences: boolean;
}): { previousResponseId?: string; previousImageGenerationCallId?: string;
      reusePreviousImage?: boolean; resetReason?: string }
```

- [x] 添加 wire 回归：`models: ['image-model']` 不否定 `responsesModel: 'reasoner'`，请求外层为 reasoner，工具为 image-model。
- [x] 添加 wire 回归：旧 response + 两张图时，提交两张图且无 previous_response_id；一张未确认基准的新图同样不可被吞。
- [x] 纯基准去重测试明确传 `reusePreviousImage: true`；只有该标志且素材最多一张才允许省略图片。
- [x] helper 表驱动断言：相同配置可续接；新增参考、换工具模型、换外层模型、换 profile、换 route、旧版本无工具模型全部断链且不带旧 call ID。

```ts
expect(resolveResponseModel({ responsesModel: 'reasoner' })).toBe('reasoner');
expect(resolveImageContinuation({ base, profile, apiMode: 'responses',
  isEdit: true, hasNewReferences: true }).previousResponseId).toBeUndefined();
```

- [x] 隔离运行以下命令，先观察模型值/图片集合断言失败，再实现 helper 和适配器修复，然后同命令转绿。

观察记录：首轮四文件 79 项中 9 失败（外层模型被写成图像模型、带参考图仍携带旧 response、MCP/HTTP 外层选错、HTTP 未透传去重标志）；helper 骨架 12 项中 3 失败；随后全部转绿。

```bash
ROOT=$(mktemp -d /tmp/huiban-trusted-red.XXXXXX); mkdir -p "$ROOT/media"; HUIBAN_DATA_ROOT="$ROOT" npm test -- tests/imageApi.test.ts tests/imageRequestContext.test.ts
```

实现要点：`resolveResponseModel` 优先合法显式 requested，其次 profile.responsesModel；空白或历史占位 GPT 回落现有默认 gpt-5.5。绝不拿 profile.model 或 image-only 模型列表筛外层模型。适配器防御规则：

```ts
const reuse = params.reusePreviousImage === true && references.length <= 1;
const previous = references.length === 0 || reuse ? params.previousResponseId : undefined;
```

## Task 2：接入全部生产入口

**Files:** 修改 `bridge/http.ts`、`bridge/mcp.ts`、`bridge/runs.ts`、`src/pages/CanvasPage.tsx`、`src/lib/bridge.ts`、`src/stores/settingsStore.ts`；扩展 `tests/manualGenerationPersistence.test.ts`、`tests/mcp.test.ts`、`tests/chatRuns.test.ts`；新增 `tests/generationProfile.test.ts`。

**Interfaces:** Task 1 的两个纯 helper；`GenerateParams` 与 `GenerateRequest` 增加可选 `reusePreviousImage: boolean`。

- [x] 在 HTTP/MCP/聊天的真实业务 harness 添加独立 outer/tool 回归；图像 profile 配置 reasoner，图像模型列表只有 image-model，断言传入适配器的有效 outer 为 reasoner，而不是 image-model。
- [x] 聊天新增同配置基准续接及切工具模型/新参考断链测试；保留原图锚点、确认、CAS 与占位测试。
- [x] 运行以下测试观察正确 red。

```bash
ROOT=$(mktemp -d /tmp/huiban-trusted-callers.XXXXXX); mkdir -p "$ROOT/media"; HUIBAN_DATA_ROOT="$ROOT" npm test -- tests/manualGenerationPersistence.test.ts tests/mcp.test.ts tests/chatRuns.test.ts
```

- [x] 三入口统一 `responseModel: resolveResponseModel(profile)`。聊天 guard 调用 Task 1 helper，`hasNewReferences` 沿用 explicitReferenceUrls.length > 0，不删除原图锚点策略。
- [x] 画布先解析节点选择的 generationProfile 再校验 Key、模型、route、defaultSize。helper 使用实际工具模型；新增外参或 referenceDataUrlOverride 断链，断链不得携带旧 call ID；请求转发 reusePreviousImage。
- [x] 同命令确认 green；类型检查确认 bridge 纯 helper 可被前端安全引入。

实现说明：画布通过 `activeProfileOf(settings, composer.data.profileId)` 先定实际配置（显式节点配置优先，缺失回退 active），Key/模型/接口/默认尺寸都取自这一路；`tests/generationProfile.test.ts` 覆盖该选择行为。HTTP 的请求体类型改为 `Record<string, unknown>`，`reusePreviousImage` 仅接受严格 `true`。

## Task 3：验收与范围记录

- [x] 全量测试使用新的隔离数据根；执行 `npm run lint` 和 `npx tsc -p tsconfig.bridge.json --noEmit`。
- [x] 检查本轮相对开始时的文件差异，不把既存 dirty 改动算本轮产出；保留所有写入防线。
- [x] 报告测试数量、实际修复与仍未实施的阶段 A 项。没有真实供应商/付费画质验证，不声称等同官网。

```bash
ROOT=$(mktemp -d /tmp/huiban-trusted-full.XXXXXX); mkdir -p "$ROOT/media"; HUIBAN_DATA_ROOT="$ROOT" npm test
```

```bash
npm run lint && npx tsc -p tsconfig.bridge.json --noEmit
```

## 验收记录（2026-11-09 至 2026-11-10）

**自动化**

- 全量：104 个测试文件、1014 项通过（隔离 `HUIBAN_DATA_ROOT`，预建 `media`，退出码 0）。相对修复前 991 项基线净增 23 项。
- 类型：`npm run lint`（`tsc -b`）与 `npx tsc -p tsconfig.bridge.json --noEmit` 均通过。
- 测试输出仍有 36 条既存 `useLayoutEffect` 服务端渲染警告；未发现其他 Warning/Error/FAIL 行。不宣称“零警告”。
- 本批相对开始时的 tracked 净差异为 10 个文件、494 行 diff；另含本批新增的 `bridge/imageRequestContext.ts`、`tests/imageRequestContext.test.ts`、`tests/generationProfile.test.ts`、本计划文件，以及对既存 untracked `tests/manualGenerationPersistence.test.ts` 的增量。既存 dirty 改动未计入本批产出。

**实际应用验收（隔离、合成数据、无付费）**

用生产构建（`npm run build`）在 `127.0.0.1:3799` 启动真实 bridge，独立数据根、合成 PNG、本机 loopback 假上游；浏览器实际操作生成节点。三例实测请求：

| 用例 | 浏览器 → bridge | bridge → 上游 |
| --- | --- | --- |
| 纯基准续接 | profileId=`selected`（节点显式配置，全局 active 无 Key）、previousResponseId=`resp_base-only`、reuse=true、1 张基准图 | outer=`same-provider-reasoner`、tool=`image-model`、previous=`resp_base-only`、input_image=0 |
| 新增参考图 | previous=null、callId=null、reuse=false、2 张图（基准+外参） | outer 正确、previous 缺失、input_image=2（两张哈希与浏览器提交一致） |
| 切换图像模型 | model=`image-v2`、previous=null、reuse=false、1 张基准图 | tool=`image-v2`、previous 缺失、input_image=1 |

三例生成均回填到原节点（`status=done`，版本带 `responseProfileId=selected` 与实际位图尺寸 320×240），画布连线与版本叠加正常。验证结束后已停止隔离服务并删除临时启动配置与合成数据。

**未覆盖**

- 未做真实供应商调用、画质/计费/取消验证，不能据此声称“等同官网效果”。
- F01（Images 末端隐式补词）、F02（局部编辑分类与编号）、F03（版本冻结与失读明确失败）、F05（原请求重试）属于后续阶段 A 小批次，本批未实施。
- 未提交、未推送、未创建 PR 或 worktree。

## 补充修复：生效配置回退（2026-11-10）

**问题**：选中的全局配置缺 Key 时，即使另一路已经配好，顶部仍提示“生图模型尚未配置”，新建节点也默认落到缺 Key 的那一路。

**改动**：

- `bridge/settings.ts` 新增 `imageProfileReady` / `effectiveImageProfile`：选中的配置完整就用它，否则让位给第一路真正可用（启用 + 地址 + Key + 默认模型）的生图配置；全都不完整时保留选中项，让报错指向用户正在编辑的配置。
- `activeProfile`（`/api/generate` 缺省、MCP、健康检查共用）改用生效配置；`imageModelReadiness` 同步，提示不再误报。
- 新增 `storedActiveProfile` 供 `publicView` 回显用户选中的 id：生效回退只影响解析，不会因为打开设置面板保存一次就悄悄改写 `activeProfileId`。
- 前端 `activeProfileOf(settings)` 未显式指定时同样优先完整可用的配置；显式 `profileId` 仍原样返回（节点自己的选择优先）。

**验证**：`tests/settingsProfiles.test.ts` 新增 3 项、`tests/generationProfile.test.ts` 调整为 3 项（先观察失败再实现）。全量 104 文件 / 1018 项通过，`npm run lint` 与 bridge `--noEmit` 通过。隔离应用实测：存储的 active 为无 Key 配置、另一路可用时，`/api/health` 报告 `configured=true` 且指向可用配置，页面顶部提示消失，新建生成节点默认带上可用配置的 `profileId`/模型；`/api/settings` 仍回显用户选中的 id。
