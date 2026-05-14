# 导入策略

目标：吸收 `awesome-gpt-image-2` 的 Prompt-as-Code、风格库、案例库思想，但避免运行时和 AI 上下文过载。

## 推荐本地结构

```text
vendor/awesome-gpt-image-2/
├── data/
│   └── local-style-index.json      # 小索引，默认读取
├── upstream/                       # 同步脚本拉取的原始上游文件
│   ├── data/cases.json
│   ├── data/style-library.json
│   └── agents/skills/gpt-image-2-style-library/
├── scripts/
│   └── sync-awesome-gpt-image-2.ps1
└── docs/import-plan.md
```

## 懒加载规则

- 默认：只读 `local-style-index.json`。
- 用户要“产品海报”：只读取 `poster/product/luxury` 相关条目。
- 用户要“复刻某案例”：再打开 `upstream/data/cases.json` 并按关键词筛选。
- 用户要“扩展风格库”：把筛选后的条目整理进本地 `local-style-index.json`。

## 后续接入方式

可以把 `local-style-index.json` 接到 `backend/mini-agent.js`：

1. 根据用户提示词匹配 `keywords`。
2. 取最高分 style preset。
3. 把 preset 的 `promptBlocks` 拼进 Agent 优化提示词。
4. 每次生成后根据用户反馈更新 `data/skills/agent-memory.json`。

