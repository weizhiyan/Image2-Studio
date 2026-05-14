# awesome-gpt-image-2 本地接入区

来源仓库：`https://github.com/freestylefly/awesome-gpt-image-2`

本目录不是把全仓库一次性塞给 AI，而是采用“懒加载”结构：

- `data/local-style-index.json`：本地轻量风格索引，平时只读这个。
- `docs/import-plan.md`：同步策略和文件放置规则。
- `scripts/sync-awesome-gpt-image-2.ps1`：需要完整案例库时再运行的同步脚本。
- `upstream/`：运行同步脚本后存放上游原始文件。

使用原则：

1. 默认只读取 `data/local-style-index.json`。
2. 只有用户明确要求某类案例时，才打开对应上游文件。
3. 不把完整 `cases.json`、完整 style library 一次性塞进上下文。
4. 本网站运行时优先用 `backend/mini-agent.js` 和 `data/skills/agent-memory.json`。

