# Image Studio

一个独立运行的生图网站，支持 GPT Image / OpenAI 兼容中转站、参考图上传、截图粘贴、历史图二次修改，以及可选 Agent 提示词优化。

## 特性

- 文生图：无参考图时调用兼容的 `/images/generations`。
- 图生图：上传、拖拽、粘贴或选择历史图后调用兼容的 `/images/edits`。
- Agent 优化：优先使用 `LANGUAGE_MODEL_BASE` / `LANGUAGE_MODEL_API_KEY` / `LANGUAGE_MODEL_NAME` 调用语言模型优化提示词；未配置时使用本地小 Agent。
- 内置小 Agent：`backend/mini-agent.js` 负责意图提取、参考图约束、记忆偏好注入和提示词组合。
- 持续学习：每次生成后自动总结风格特点、比例、模型、参考图数量等参数，并写入 skills 记忆。
- 本地归档：输入图、输出图和索引保存在 `data/`。
- 高端极简 UI：大输入区、轻量控制、图片优先的结果和历史面板。

## 运行

```bash
copy .env.example .env
node backend/server.js
```

打开 `http://127.0.0.1:8787`。

如果 PowerShell 禁止运行 `npm.ps1`，可以直接使用 `node backend/server.js`，本项目 MVP 不依赖 npm 安装。

## 局域网分享给同事

1. 在你的电脑上查看局域网 IP，例如 Windows 里运行 `ipconfig`，找到类似 `192.168.1.23` 的 IPv4 地址。
2. 编辑 `.env`：

```env
SERVER_HOST=0.0.0.0
PORT=8787
PUBLIC_BASE_URL=http://你的局域网IP:8787
```

示例：

```env
PUBLIC_BASE_URL=http://192.168.1.23:8787
```

3. 启动服务：`node backend/server.js`
4. 同事在同一个局域网浏览器打开：`http://你的局域网IP:8787`
5. 如果访问不了，检查 Windows 防火墙是否允许 Node.js 或端口 `8787` 入站访问。

## 环境变量

```env
SERVER_HOST=0.0.0.0
PORT=8787
PUBLIC_BASE_URL=http://127.0.0.1:8787
# 图像生成模型：GPT Image 或兼容中转站
IMAGE_PROVIDER_BASE=https://api.openai.com/v1
IMAGE_PROVIDER_API_KEY=sk-your-key
IMAGE_PROVIDER_MODEL=gpt-image-2
IMAGE_PROVIDER_NAME=openai-compatible
IMAGE_DEFAULT_SIZE=1024x1024
IMAGE_DEFAULT_QUALITY=high

# 语言模型 / 小 Agent：用于提示词优化，不直接生成图片
LANGUAGE_MODEL_BASE=
LANGUAGE_MODEL_API_KEY=
LANGUAGE_MODEL_NAME=gpt-4.1-mini

# 可选：旧版自定义 Agent 接口；通常不用填
AGENT_ENDPOINT=
AGENT_API_KEY=
```

中转站只要兼容 OpenAI Images API，即可把 `IMAGE_PROVIDER_BASE` 改成中转站地址，把 `IMAGE_PROVIDER_MODEL` 改成中转站要求的模型名。

## 语言模型与 Agent

推荐配置三件套：

```env
LANGUAGE_MODEL_BASE=https://api.openai.com/v1
LANGUAGE_MODEL_API_KEY=sk-your-language-key
LANGUAGE_MODEL_NAME=gpt-4.1-mini
```

后端会调用兼容 OpenAI 的 `/chat/completions` 接口优化提示词。如果 `LANGUAGE_MODEL_BASE` 或 `LANGUAGE_MODEL_API_KEY` 留空，就自动使用 `backend/mini-agent.js` 本地小 Agent。

## 旧版 Agent Endpoint 协议

如果不用语言模型三件套，而是有自定义 Agent 服务，则设置 `AGENT_ENDPOINT`。当 `AGENT_ENDPOINT` 有值时，后端会发送：

```json
{
  "task": "optimize_image_prompt",
  "sourcePrompt": "用户原始提示词",
  "basePrompt": "系统合成提示词",
  "previousPrompt": "上一轮提示词",
  "images": [],
  "rules": ["不改变用户核心意图", "只输出最终提示词", "不调用工具", "不写文件"]
}
```

Agent 可返回纯文本，或返回：

```json
{ "prompt": "优化后的最终生图提示词" }
```

## API

- `GET /api/config`：前端配置状态。
- `POST /api/images/upload`：保存上传或粘贴图片。
- `POST /api/images/optimize-prompt`：调用 Agent 或自动回退。
- `POST /api/images/generate`：生成图片并保存输出。
- `GET /api/images/history`：读取历史输出。
- `GET /api/images/file/:id`：通过索引 ID 安全访问图片。

## 数据目录

```text
data/
├── images.json
├── generation-history.json
├── skills/
│   └── agent-memory.json
└── images/
    ├── inputs/YYYY-MM/
    └── outputs/YYYY-MM/
```

`generation-history.json` 保存每次生图的完整上下文；`skills/agent-memory.json` 保存 Agent 从历史生成中总结出的偏好标签和经验，用于后续提示词优化。

错误日志保存在：

```text
data/error-logs/errors.json
data/error-logs/YYYY-MM-DD.md
```

如果前端显示失败，会返回 `errorId`，可到上述日志里查详细堆栈和接口信息。
