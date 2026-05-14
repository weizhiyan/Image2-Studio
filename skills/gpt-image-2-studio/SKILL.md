---
name: gpt-image-2-studio
description: Build, operate, and improve this local GPT Image 2 generation studio with prompt-as-code workflows, style templates, ratio-aware image generation, LAN deployment, local history, and agent memory. Use when working on this image generation website, adding image models or relay endpoints, improving prompt optimization, creating reusable image style skills, analyzing generation history, or helping teammates use the LAN-hosted site.
---

# GPT Image 2 Studio

Use this skill when modifying or operating the local image generation website in this workspace.

## Core Workflow

1. Preserve the user intent before adding style details.
2. Convert casual Chinese prompts into structured image prompts.
3. Choose ratio automatically from reference images unless the user explicitly selects a fixed ratio.
4. Prefer local history and `data/skills/agent-memory.json` as user preference memory.
5. Save generation context for later analysis: source prompt, optimized prompt, model, ratio, size, references, outputs, and summary.

## Upstream awesome-gpt-image-2 Integration

Use the local vendor area instead of loading the whole upstream repository into context:

- Read first: `vendor/awesome-gpt-image-2/data/local-style-index.json`.
- Read only when needed: `vendor/awesome-gpt-image-2/upstream/data/cases.json` after running the sync script.
- Sync script: `vendor/awesome-gpt-image-2/scripts/sync-awesome-gpt-image-2.ps1`.
- Import plan: `vendor/awesome-gpt-image-2/docs/import-plan.md`.

Never paste the full upstream case library into a prompt. Match keywords, select a small preset/case subset, then use only those entries.

## Prompt-as-Code Pattern

Build prompts with these blocks:

```text
主体：{用户真正要画什么}
风格：{高端/黑金/霓虹/产品海报/摄影/插画等}
构图：{近景/居中/留白/纵深/海报式}
光影：{电影级布光/边缘光/柔光/高反差}
材质：{玻璃/金属/皮肤/织物/液态/颗粒}
比例：{自动/1:1/16:9/9:16/3:2/2:3}
文字策略：海报/封面允许用户指定标题、标语、品牌名；禁止乱码、错别字、无意义小字和额外文字
约束：不要水印、不要畸形结构、不要改用户主体
```

## Built-in Style Directions

- 高端黑金产品海报：黑色背景、金色边缘光、玻璃/金属材质、强主体、可控标题排版。
- 未来霓虹科技：紫蓝粉霓虹、半透明 UI、数字空间、强纵深。
- 极简高级摄影：干净留白、自然材质、柔和光影、真实镜头语言。
- 电影级角色视觉：明确人物主体、侧逆光、环境氛围、情绪表达。
- 社媒爆款封面：主体大、对比强、信息层次清楚、适合 16:9 或 9:16。

## Ratio Rules

- `auto`: If a reference image exists, infer the closest supported ratio from its dimensions.
- `1:1`: avatars, icons, product object studies.
- `16:9`: desktop covers, banners, landscape posters.
- `9:16`: mobile wallpaper, short-video cover, vertical poster.
- `3:2`: photography and wide product compositions.
- `2:3`: portrait, character, editorial illustration.

## Text Policy

- 海报、封面、宣传图允许用户明确指定的标题、标语、品牌名、活动信息和排版文字。
- 不要对海报场景默认加入“无文字 / 不要文字”。
- 用户明确说“不要文字、无文字、不加字”时，才严格禁止文字。
- 用户没提文字时，避免随机乱码、错别字、无意义小字和水印。
- 文案应少量、清晰、准确，优先保留用户原文，不要编造额外文字。

## Model Binding Notes

- Image model config lives in `.env`: `IMAGE_PROVIDER_BASE`, `IMAGE_PROVIDER_API_KEY`, `IMAGE_PROVIDER_MODEL`.
- Language/Agent optimizer config lives in `.env`: `AGENT_ENDPOINT`, `AGENT_API_KEY`.
- If `AGENT_ENDPOINT` is empty, use `backend/mini-agent.js`.
- Do not expose API keys to frontend files.

## Local Files

- Frontend: `frontend/index.html`, `frontend/css/styles.css`, `frontend/js/app.js`.
- Backend: `backend/server.js`, `backend/mini-agent.js`.
- History: `data/generation-history.json`.
- Memory: `data/skills/agent-memory.json`.
- Config template: `.env.example`.
- Upstream lazy-load index: `skills/gpt-image-2-studio/vendor/awesome-gpt-image-2/data/local-style-index.json`.

## LAN Deployment

Use `SERVER_HOST=0.0.0.0` and set `PUBLIC_BASE_URL` to the host computer LAN IP, for example `http://192.168.1.23:8787`.

Run with:

```bash
node backend/server.js
```

Teammates open the LAN URL in their browsers.
