# 绘板 Agent 协作规则

绘板（Huiban）是一个**轻量画布生图工具**：画布里写提示词即生图，Codex 对话出图直接落画布。
绘板是独立项目，维护自己的 UI 规范、Token、组件与交互约定；项目内的规范文件和实现是唯一工程依据。

## 命令

```bash
npm run dev        # 前端 5199（/api 代理到 bridge 3788）
npm run dev:bridge # bridge 开发模式（HTTP + SSE + MCP stdio 同一进程）
npm run build      # tsc -b && vite build && tsc -p tsconfig.bridge.json
npm start          # 生产模式：一个 node 进程同时服务页面、SSE、MCP
npm test           # vitest run
```

架构一句话：**浏览器只管画布；生图出口、Key、媒体文件全在 bridge 进程**。Codex 通过
MCP（stdio）调 `huiban_generate`，bridge 生成后经 SSE 把图推给订阅了该画布的标签页。

## 设计规范（改任何样式前先读）

项目级 UI 与基础交互规范见 `UI_BASELINE.md`。开始任何新界面、重要界面改版或新增交互控件前必须先读，并使用 Q-UI baseline 的 kickoff、implementation、acceptance 工作流。只把标为“已确认”的规则当成硬约束；遇到会显著影响结果的“待确认项”，先与用户对齐，不自行补成项目规范。

绘板自己的设计基线在 `UI_BASELINE.md`，Token 唯一来源是 `src/styles/tokens.css`；
节点样式、动画、画布视角和控件均由本项目维护。沿用本项目现有组件与 Token，
但不要因为某段实现过去曾参考外部产品，就把它视为不可修改或必须同步的外部组件。
`src/lib/canvasViewport.ts`、`src/components/canvas/useCanvasViewControls.ts`、
`src/components/canvas/CanvasControls.tsx`（`CanvasRail` + `CanvasDock`）是绘板画布内部实现，
修改画布缩放与交互时在本项目内维护。`src/components/canvas/Nodes.css` 当前未 import，
仅作历史文件保留，不视为活动样式来源。

画布下拉弹窗统一用 `--surface-popover-glass-bg` / `--surface-popover-glass-blur`（半透明 + 模糊），
别再各写一份 `color-mix`。

### 硬规则：设计 Token

唯一来源是 `src/styles/tokens.css`。`tests/tokens.guard.test.ts` 会机器校验，
绕过它等于 `npm test` 红。

1. **组件 CSS 里不得出现字面量**：`font-size` / `border-radius` / 颜色（hex、rgb/rgba、hsl）/
   动效时长与缓动，只能写 `var(--…)`。唯一豁免是 `1px` 描边宽度。
2. **透明度分三层**，不许跨层：L0 原始色只在 tokens.css；L1 语义 Token 的 alpha 只能用
   `color-mix(in srgb, X n%, transparent)` 派生；L2 组件局部 Token（`--hb-*` / `--node-*`）
   只能从 L1 派生。组件规则体里只能 `var()`。
3. **主题差异只写在 tokens.css**，组件 CSS 里不许出现 `[data-theme="light"]` 块。
4. 新增 Token 前先确认 tokens.css 里没有语义接近的；拿不准就用现成的，别急着加。

### 节点视觉

画布节点使用本项目约定的 DOM 结构（`image-flow-node` / `image-node-{composer|image|reference}` /
`image-node-composer-shell` / `image-node-media` / `image-handle`…）。改节点先改类名对应的
CSS，不要新造平行结构。节点尺寸经 `--image-node-width` 注入（JS 写入、CSS 只读）。
新增节点必须遵循 `UI_BASELINE.md` 的节点规范：复用外壳、顶部类型标识、状态反馈、连接与画布生命周期中的新增/删除动效及撤销路径。文本节点通过右下角拉伸手柄拖拽调整宽高，预览内容区不移动节点；编辑框与操作控件不触发节点移动。

## 画布外壳与节点动效

- 视角持久化走 `useCanvasViewControls`：`flowViewport` 只进本地 state（高频），
  `persistCanvasViewport` 在 `onMoveEnd` 写 store；`resetToBestView` 是 `fitView({padding:0.22})`。
  缩放区间 `CANVAS_ZOOM_MIN/MAX`（0.15–6），左下角滑块是对数行程。
  滑块缩放走 `setCanvasZoom`：锚点优先选中节点包围盒中心（多选取整体中心），
  没有选中才用当前视口中心——纯函数在 `canvasViewport.ts` 的 `zoomViewportAroundAnchor`，
  别再把「直接改 zoom 不改 x/y」那套写回来（画布会往左上角漂）。
- `initialPanTool: true`：默认左键平移。`interactionProps` 整份铺给 `<ReactFlow>`，
  不要再手写 `selectionOnDrag` / `panOnDrag` / `zoomOnDoubleClick`。
- 节点动效三件套只在组件 state 里（**不写 node.data**，否则会被持久化）：
  `enteringNodeIds`（错相 `--image-node-enter-delay`）/ `exitingNodeIds`（`onBeforeDelete` 延后真删）/
  `freshResultNodeId`（出图一次性脉冲）。class 由 `flowNodes` memo 注入到 `node.className`，
  摘 class 走节点的 `onAnimationEnd` → `hb:image-node-animation-end`。
  水合灌入的整批节点**不播**入场动画（`skipEnteringDiffRef`）。
- 生成节点右下角的 `image-node-resize-handle` 探出卡片 20px、完全透明、未选中也能拖；
  拖拽事件是 `hb:image-node-resize-start`，落定后写 `cardWidth` / `nodeHeight` / `nodeHeightManual`。
- 图片节点放大预览有两个入口：图片左上角 `.image-node-media-zoom`、选中后浮出的
  `NodeSelectionToolbar`（放大查看 / 替换 / 下载）。点图片本身不再直接开预览。
- 页面根节点要挂 `image-canvas-page`（`.hb-shell` 上同时挂），否则 `.image-canvas-page.is-entering …`
  那一整批逐层入场动画全是死的（此前没人挂这个类，dock / rail 的 `msg-enter` 从没跑过，踩过）。
  `ImageNodes.css` 里 `.is-entering .canvas-dock/.canvas-rail` 与 `.image-canvas-flow` 是**两条独立规则**，
  别把选择器合并——合并等于把 dock / rail 的入场 delay 并进画布规则，动画直接消失（踩过）。
- `normalizeCanvasGraph` 在水合时跑：剔除非画布 kind、清一次性 `className`、剪掉指向已删节点的悬空连线。
  它**不**做空节点回收：本项目的 `queued` 状态不会出现在空节点判断里，不得添加基于陈旧状态码的自动删除逻辑。

## 多路生图配置

`bridge/settings.ts` 存 `profiles: ModelProfile[]` + `activeProfileId`，每路各有 Base URL / Key /
模型列表；`publicView` 只吐不带 Key 的视图。旧版扁平字段会在首次读取时整体迁移成一路并立刻落盘
（id 稳定，节点上存的 `profileId` 才不会失效）。`apiKey` 传空串 = 不修改。
生图出口 `/api/generate` 与 MCP `huiban_generate` 都接受 `profileId`，缺省走 active。
每路配置带 `enabled` 开关（settings.ts，缺省 true）：停用不参与默认竞选——
`activeProfile` / `textProfilesOf` 会跳过（全停用时退回原池不抛空），显式按 `profileId`
指定的仍认。界面启停入口统一在左侧配置卡片，停用当前生效那路时前端自动让位并提示。

## 画布状态约定（改 CanvasPage 前必读）

`nodesRef` / `edgesRef` 是画布**真源**，只在写操作里推进（`appendNode` / `patchNode` / `onNodesChange` /
`setEdgesBoth` / hydrate），**绝不由渲染回写**。渲染期回写会被高优先级渲染用旧 state 覆盖，
之后同一 tick 里的连线同步（`syncComposerReferences`）就会读不到刚建的节点——参考图缩略图时有时无就是这个原因。
节点尺寸也分流：`data.width/height` 是位图像素（只用来算比例），`data.cardWidth` 才是卡片宽度。
注入 CSS 的 `--image-aspect-ratio` 是**宽/高**（与 CSS `aspect-ratio` 同向），而 `aspect.ts` 的 `parseSizeRatio`/
`ratioToNumber` 返回的是**高/宽**——换算在 `nodeAspectRatio()` 里取倒数，别在别处再翻一次（写反过一次，卡片会被拉成竖条）。

## 输入态与引用（改节点交互前先读）

- **拖动与编辑不打架**：`.image-node-composer-shell textarea` 默认 `pointer-events: none; cursor: grab`，
  整张卡片随手拖；只有 `.editing`（节点被选中）时才 `pointer-events: auto; cursor: text`。
  `composerEditing` 写在 `node.data` 里，但每次渲染都由 `editingNodeId` 重新推出，刷新后自愈，不留陈旧态。
- **退出输入态只由三件事触发**：换选到别的节点、多选（shift）、点空白（`onPaneClick`）。
  `onSelectionChange` 选中清单暂时为空时**不做判断**——React Flow 建新节点会先报一次 `[]`，
  这时清除编辑态会把"双击菜单 → 新建节点"刚拿到的编辑态擦掉。
- **聚焦要跟帧重试**：React Flow 在节点测量完成前给 `.react-flow__node` 挂 `visibility: hidden`，
  那一帧 `focus()` 静默失败。新建节点时必须 rAF 重试到焦点真的落上（最多 8 帧）。
- **引用分两种**：`CanvasReference.kind === 'image'` 画缩略图；`'text'`（或只有 text 没有 url）画 T 图标小方块，
  点击把上游提示词拼进当前提示词。`syncComposerReferences` 与 `flowNodes` memo 用同一套
  `buildCanvasReference` / `areCanvasReferencesEqual`，落盘形状和展示形状必须一致。
- 删引用 chip = 删那条边，不删上游节点（`referenceId` 就是上游节点 id）。

## 画布持久化（双份，改任何一边都要想另一边）

浏览器 localStorage 是**工作副本**，bridge 的 `~/.huiban/canvas-docs.json`（`PUT/DELETE/GET /api/canvases`）
是**整文档第二拷贝**。启动时：本地还是一张空默认画布 → `adoptCanvases` 整体采用服务端列表（按 updatedAt 排序）；
否则 `mergeCanvases` 同 id 取新的一侧，并把本地较新的回推（`putCanvasDoc`）。活动画布变更后 600ms 防抖上桥。
删画布走 `DELETE /api/canvases/:id`。registry（`canvases.json`，只有名字）继续供 MCP `huiban_canvases` 列目录。
别把这里改回「只存名字」或「只存浏览器」——用户明确要求换浏览器打开链接要有记录。

**顺手清空占位画布**：活动画布定下来之后，删掉「名字叫 `默认画布` + 0 节点 0 边」且非活动的画布
（只在已经存在有内容的画布时才动，全新安装仍保留那一张当工作台）。注意**不能**加"本地独占"条件——
空占位早就被浏览器回推 bridge 了，那条判断会让清理永远失效（踩过）。当前活动画布正是空占位时，
先切到最近更新的有内容画布，别让用户对着空白页。

## 顶栏与连线（绘板交互约定）

- **连线触发范围**：拖手柄松手时只要落在某个节点上就建边，**不要求对准圆形手柄**。
  `onConnectEnd` 里取 `event.target.closest('.react-flow__node')` 的 id 交给 `connectPending`；
  手柄对接成功的情况 `onConnect` 会先建边并清掉 `pendingConnectionRef`，走不到这段。
  `connectPending` 自带去重 + 自连守卫，同一对节点不会被接两次。
- **画布下拉贴左边缘展开**（`canvas-page.css` 的 `.workflow-menu`：`left: 0; transform: none`），
  并通过 `max-width: calc(100vw - 24px)` 防止窄窗口右侧溢出。
- **顶栏透明**（`global.css` 的 `.hb-topbar`：`background: transparent; border-bottom: none`），
  直接透出画布网点，不另起一块底色。
- **节点浮层放不下就完整翻到卡片下方**（`CanvasPage` 的 `toolbarStyle` / `selectionToolbarStyle`，
  定位纯函数在 `src/lib/nodeOverlayPlacement.ts`）。旧写法 `clamp(nodeTop - 52, 72, …)`
  在节点顶到可视区上沿时会把工具栏按在安全线上、正好压进卡片里（用户报"被挤下来"）。
  现在：上方空间足够就贴上方，否则整体放到 `卡片底部 + 12`；不再把下方坐标 clamp 回顶部安全线。
  横向仍居中并收在容器安全边距内。两处浮层共用同一套规则，别只改一处。

- 画布选择器使用本项目的 `top-nav-workflow-*` / `workflow-menu-*` 结构（CSS 在 `canvas-page.css` 尾部）：
  点名字重命名，箭头展开下拉做新建 / 切换 / 删除。**没有**删除、上传参考图、自动定位按钮——自动定位始终开启。
- 连线由本项目的 `components/canvas/FlowEdge.tsx`（渐变 beam + SMIL 流光）和 `CanvasPage.tsx` 里的
  `CanvasEdge` 包装（`EDGE_INSET = 24`，用 `useInternalNode` 的实测宽度算节点边框，比偏移
  `props.sourceX` 稳——ReactFlow 对"伸出节点 40px 的 + 按钮 handle"测的位置有陈旧误差）。
  边的高亮分两档：与选中节点相连 `edge-related`（76%），边自身被选中 `selected`（72%）。
- 画布背景统一 `--color-bg-canvas`（顶栏同色），网点 `--color-canvas-dot`。

## 启动时的占位画布清理

合并服务端文档并定好 `activeId` 之后，会删掉"名字叫 `默认画布` + 0 节点 0 边 +
不是当前活动画布"的占位画布（仅在已有带内容的画布时）。没有这段，每次刷新都会凭空多一张空默认画布。
删之前必须先落 `activeId`，否则新建的空画布会被误删；只认 `默认画布` 这个名字，用户自己命名的空画布不碰。
**不能**再加"本地独占"条件，理由见上一节。

## 节点尺寸（改 resize / 盒子计算前必读）

`aspect.ts` 的 `nodeBoxFor` **必须**认 `nodeHeightManual` + `nodeHeight`：
composer 手动拖过高度时用 `clamp(nodeHeight, MIN/MAX_COMPOSER_NODE_HEIGHT)`，其余才按 `width / aspect` 推导。
少了这个分支，`startResize` 把高度写进 `data.nodeHeight` 却拿不到盒子，视觉上就是"只能等比拖"（踩过）。
宽高上下限与 `CanvasPage` 共用 `aspect.ts` 那一份常量，别在两处各写一遍。

## 画布写入的三条保险（改 bridge 或前端写路径前必读）

历史上真的丢过一次用户图库（16 节点全空），根因是"只带 name 的 PUT 会把没建档的画布写成空文档"加上
多标签页并发读-改-写整个 JSON。现在有三条防线，**任何改动都不许绕开**：

1. **写串行化**：`bridge/http.ts` 里所有 `canvas-docs.json` 的写都走 `withCanvasWriteLock`，
   读-改-写锁在同一进程内串成一条链。多个浏览器标签页 + React StrictMode 双跑 effect 是常态。
2. **name-only PUT 不许建空文档**：请求体没有 `nodes`/`edges` 且该画布没有历史文档时直接返回。
   所以 `CanvasPage` 的水合 effect **不再调 `registerCanvas`**——每切一次画布就发一次只带 name 的 PUT
   正是最危险的那条路径。注册交给 `createCanvas` / `renameCanvas` 和 `putCanvasDoc`（整文档上桥）。
3. **空快照不许覆盖有内容**：启动回推时，本地 0 节点 0 边而服务端同 id 有内容的，直接跳过。

另外每次写 `canvas-docs.json` 前会往 `~/.huiban/backups/` 留一份滚动备份（保留最近 5 份），
万一还有漏网路径也能手工捞回。排查"画布怎么空了"第一步就看这个目录。

## 生图链路

- 浏览器生成：composer 节点 Enter → 该节点**就地**转运行态 → `POST /api/generate`（bridge 代理中转站，绕开 CORS）
  → 结果（fetch 响应，或 bridge SSE 广播回该画布）落回**同一节点**并变成 `image` → 有“自动定位”时 `setCenter` 聚焦（420ms）。
- 选中 composer 时节点上方浮出 `NodeGenerationToolbar`（模型 / 比例），写进 `data.model` / `data.ratio`；
  `runComposer` 的画幅优先级：提示词显式写法 > 工具栏预设 > 设置里的默认尺寸。
- Codex 生成：MCP `huiban_generate {prompt, canvasId}` → bridge 生成 → 双通道落画布：
  ① appendCanvasImageNodes 写 canvas-docs.json（走同一条 withCanvasWriteLock 链 + 滚动备份），
  ② pushImage 推 SSE 给订阅该画布的标签页。浏览器没开时 ① 保证图不丢，刷新/切画布随水合出来；
  PUT 整文档时 keepExternalNodesOnSnapshot 会把「MCP 刚写、本地旧快照还没有」的节点捞回来
  （判据 source==='mcp' 且 createdAt 晚于请求 updatedAt；用户真删后 updatedAt 更新，不复活）。
- MCP 工具面（`bridge/mcp.ts`，业务逻辑与协议壳分离，单测见 tests/mcp.test.ts）：
  huiban_generate / huiban_canvases / huiban_canvas_create / huiban_nodes / huiban_models / huiban_config /
  huiban_prompt_guide / huiban_optimize（后两个把提示词优化链路暴露给 agent：guide 返回
  `buildSystemSpec` 同款规范零拷贝，optimize 包 `enhancePromptDetailed`，入参默认与 /api/enhance 对齐；
  为取规范，textApi.ts 导出 LEVEL_SPECS / buildSystemSpec 两个常量，链路逻辑本身不许改）。
  huiban_generate 支持 ratio、n（1~8）、referenceImages（/api/files、http(s)、dataURL 三种入口）、
  referenceUsage/inputFidelity、model、profileId、label。参考图入口归一化在 resolveReferenceDataUrls。
  huiban_generate 的调用顺序是先校验（prompt / Key / canvasId）再调上游——坏 canvasId 不会先烧一张图；
  上游失败会被包成「生图接口调用失败：<原因>（检查 baseUrl / Key / 网络）」返回。工具级异常一律
  转 isError:true 的结果而非断连接，agent 可据此自纠。
- 两条路共用同一 Key/模型配置（`bridge/settings.ts`，存 `~/.huiban/settings.json`）。

## 对话（一张画布一条线程）

右下角 AI 按钮展开右侧抽屉。设计前提：**消息只存 nodeId / versionId 引用，图片本体永远在
画布节点上——对话是画布的视图，不是第二数据源**，因此不用给对话再设计一套并发合并。

- **thread id = canvasId**：`useChatStore` 的 threads 以 canvasId 为键，跟随 activeId 切换。
  首条消息落时按内容起标题（超 24 字截断），之后不自动改。
- **每轮发送的落地路径**（`CanvasPage.sendChatMessage`）：用户消息上屏 → 建 composer 节点
  （不选中、不进输入态，别抢画布焦点）→ 引用图**连边**（runComposer 的参考图数组走
  `buildOrderedReferences`，认边不认 `data.references`；先 patch `referenceOrder` 再
  `syncComposerReferences`，chips 编号与发送顺序才一致）→ 占位 assistant 消息
  （pendingNodeId）→ `runComposerRef.current(nodeId, prompt, { previousVersionId })` →
  出图后补 media / 失败补 error。节点排布：`chatAnchorRef` 锚点 + 每 3 张换一行。
- **上下文续接**在 `runComposer` 里算：上一轮 assistant 消息 `media[0].versionId` →
  `findVersionOnCanvas` 找版本 → 同口径校验（同 profile + 同 responsesModel）才续
  responseId。断了不静默：`ComposerRunResult.context` 带回 resetReason，消息上出徽标。
- **双份持久化**：localStorage（`huiban-chat-v1`，工作副本）+ bridge `/api/chats`
  （`~/.huiban/chat-docs.json`，第二拷贝）。bridge 侧 `bridge/chat.ts` 与 canvas-docs
  同款三条保险：写串行链 + 滚动备份 + **单调时间戳**（旧快照不覆盖新数据）。消息入库前
  `normalizeChatThread` 清洗：>64KB 的 dataURL 剥掉、单线程截断到 500 条。
  活动画布变更后 600ms 防抖上桥（与 putCanvasDoc 同节拍）；删画布时 `dropThread` 连带删。
- **定位**：消息媒体格定位按钮 → `revealResultNode(nodeId, { onlyIfOffscreen: false })`
  （显式一律归位）；生成后自动定位走 `onlyIfOffscreen: true`（视口内不挪镜头），
  开关在面板头部，默认开。
- 组件在 `src/components/chat/`：ChatPanel（外壳）/ ChatMessageList / ChatComposer /
  ChatIcons。CSS 全额走 token（tokens.guard 会拦字面量）；浮层材质用
  `--surface-popover-glass-*`，图上的控件用 `--media-chrome-*`（恒定深色）。
- 「引用到对话」入口在 NodeSelectionToolbar（结果节点选中态）：`addDraftAttachment`
  （同节点替换、同 url 去重）+ 展开面板。

## 跨平台底线

- 数据一律走 `bridge/paths.ts` 的 `DATA_DIR`（`~/.huiban`，Win 同样成立），不许写死绝对路径。
- macOS 专属路径（如 `/Applications/...`）只允许出现在探测逻辑里，且必须有 PATH 兜底。
- 新增系统调用（打开文件、定位目录）必须按 `process.platform` 分支，参照
  `bridge/http.ts` 的媒体文件处理。
