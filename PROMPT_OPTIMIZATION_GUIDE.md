# 提示词优化升级指南

> 历史方案，部分描述已不适用于当前实现。2026-11-16已取消按词数自动补词及固定四步参考图分析；当前行为与验证结果见 [图像设计编排](docs/image-planning.md)。本文示例不是实测结果。

## 本次优化内容总结

这份早期方案尝试调整提示词处理能力，但没有证据证明达到GPT官网同等水平，不能将规则数量或提示词长度当成画面质量。

---

## 1️⃣ 强化AI对话的视觉理解环节

### 改进点
- **问题**: 之前AI优化提示词时，对参考图的理解不够深入
- **解决**: 在`buildSystemSpec`中增加了参考图分析流程

### 新增功能
```typescript
// bridge/textApi.ts:158
export function buildSystemSpec(size: string, level: EnhanceLevel, hasReferenceImages: boolean = false)
```

当有参考图时，AI会先执行：
1. **主体识别**: 分析参考图里的主要对象
2. **风格特征**: 色系、光线、质感
3. **构图结构**: 主体位置、景深、画幅
4. **细节提取**: 纹理、材质、氛围感

### 关键约束
- 风格参考 → 只迁移氛围特征，主体必须全新
- 图生图 → 保留主体，只改用户要求的部分
- 自动过滤参考图中的文字、Logo、UI元素

---

## 2️⃣ 优化直连模式的提示词处理

### 改进点
- **问题**: 直连模式（不走Responses API）时，提示词过于简单
- **解决**: 新增`preprocessDirectPrompt`函数，纯规则优化

### 新增功能
```typescript
// bridge/textApi.ts:206
export function preprocessDirectPrompt(
  prompt: string,
  size: string,
  usage: ReferenceUsage,
  hasReference: boolean
)
```

#### 自动补充维度（当提示词<10词时）
- 横向画幅 → 添加 "wide horizontal composition"
- 竖向画幅 → 添加 "vertical portrait composition"
- 缺少光线 → 添加 "natural lighting"
- 缺少质感 → 添加 "high quality"

#### 参考图特殊处理
- 风格参考 → 自动添加 "Style reference only (do not replicate subject)"
- 图生图 → 自动添加 "Based on reference image"

### 应用位置
```typescript
// bridge/imageApi.ts:144
// 在generateWithImagesApi函数中自动应用
if (!params.imagesPrompt && referenceUrls.length > 0) {
  prompt = preprocessDirectPrompt(prompt, size, usage, true);
}
```

---

## 3️⃣ 增强System Prompt的反例示范

### 改进点
- **问题**: 之前的规范只说"要做什么"，没说"常见错误是什么"
- **解决**: 在`buildVisualPromptRules`中增加了6个常见错误案例

### 新增内容
```markdown
【常见错误与避坑】
❌ 错误1: 用户说"一只猫"，AI写"a cute fluffy Persian cat with blue eyes"
✅ 正确: "a cat" 即可，让模型发挥

❌ 错误2: 用户说"风格像梵高"，AI写"in the style of Van Gogh"
✅ 正确: "post-impressionist style with visible brushstrokes"

❌ 错误3: 参考图是风格参考，AI在提示词里描述了参考图的主体
✅ 正确: 只写"warm color palette, soft focus, dreamy atmosphere"

❌ 错误4: 用户提示词已经很详细(>50词)，AI还大幅改写
✅ 正确: 只补光线/构图这类必要维度

❌ 错误5: 用户说"不要背景"，AI写"simple background"
✅ 正确: "isolated on white background"

❌ 错误6: 用户说"根据参考图风格"，AI写"a [参考图里的主体]..."
✅ 正确: 完全不提参考图的主体，只写新场景
```

---

## 4️⃣ 对话式生成的上下文增强

### 改进点
- **问题**: MCP工具的提示词指导不够全面
- **解决**: `huiban_prompt_guide`返回更完整的规范

### 新增字段
```json
{
  "specWithReferences": "有参考图时使用的完整规范（包含视觉理解流程）",
  "referenceRules": {
    "commonMistakes": [
      "风格参考时不要描述参考图的主体",
      "图生图时必须明确保留什么、改动什么",
      "用户提示词已详细时只补必要维度",
      "不使用在世艺术家姓名"
    ]
  },
  "usageTips": {
    "withReferences": "有参考图时的工作流程",
    "withoutReferences": "无参考图时的工作流程",
    "shortPrompt": "短提示词的处理建议",
    "longPrompt": "长提示词的处理建议"
  }
}
```

---

## 📊 预期效果

### 直连模式
- 未经实测，不能提供提升百分比；原有自动补词已取消。

### AI对话模式
- 未经同条件图像对照，不能声称生成精准度已提高。

### 参考图质量
- 未经多场景验证，不能声称风格迁移准确率已提高。

---

## 🧪 测试建议

### 测试场景1: 风格参考
```markdown
用户输入: "一个科技感的办公室，根据参考图的氛围"
参考图: 某个特定的办公室照片

预期效果:
- ❌ 旧版: 可能会生成参考图里相同的桌椅、相同的布局
- ✅ 新版: 只迁移色调、光线感，生成全新的办公室场景
```

### 测试场景2: 图生图
```markdown
用户输入: "把这张图的猫换成狗"
参考图: 一只猫在沙发上

预期效果:
- ❌ 旧版: 可能改变沙发的样式或背景
- ✅ 新版: 只替换猫为狗，沙发、背景、构图完全保留
```

### 测试场景3: 短提示词优化
```markdown
用户输入: "一只猫"
画幅: 16:9

预期效果:
- ❌ 旧版: 直接发送"一只猫"
- ✅ 新版: 自动补充"a cat, wide horizontal composition, natural lighting, high quality"
```

### 测试场景4: 详细提示词保护
```markdown
用户输入: "A majestic orange tabby cat sitting on a vintage velvet armchair,
          soft afternoon sunlight streaming through lace curtains, creating
          warm highlights on its fur, 35mm film photography, shallow depth of field"

预期效果:
- ❌ 旧版: 可能大幅改写，丢失原有细节
- ✅ 新版: 只做轻度整理，保留用户的所有措辞和细节
```

---

## 🔄 迁移说明

### 不需要手动迁移
所有优化已自动生效，无需修改：
- ✅ 现有API接口保持不变
- ✅ 前端调用无需改动
- ✅ MCP工具自动升级

### 兼容性
- ✅ 向后兼容：旧的调用方式仍然有效
- ✅ 渐进增强：新功能只在满足条件时触发
- ✅ 安全降级：如果某个环节失败，会回退到原有逻辑

---

## 📝 代码变更清单

### 修改的文件
1. **bridge/textApi.ts**
   - `buildSystemSpec`: 增加`hasReferenceImages`参数
   - `buildVisualPromptRules`: 增加反例示范
   - `preprocessDirectPrompt`: 新增直连模式优化函数
   - `enhancePromptDetailed`: 传递参考图标志

2. **bridge/imageApi.ts**
   - 导入`preprocessDirectPrompt`和`ReferenceUsage`
   - `generateWithImagesApi`: 应用直连模式优化

3. **bridge/mcp.ts**
   - `huiban_prompt_guide`: 返回完整规范和使用建议

### 新增的导出
- `preprocessDirectPrompt`: 直连模式优化函数
- `buildSystemSpec`的第三个参数: `hasReferenceImages: boolean`

---

## 🎯 关键优化对比

### 优化前
```typescript
// 简单拼接
const prompt = params.imagesPrompt || params.prompt;
```

### 优化后
```typescript
// 智能优化
let prompt = params.imagesPrompt?.trim() || params.prompt;
if (!params.imagesPrompt && referenceUrls.length > 0) {
  const usage: ReferenceUsage = params.inputFidelity === 'high' ? 'edit' : 'style';
  prompt = preprocessDirectPrompt(prompt, size, usage, true);
}
```

### System Prompt优化前
```
你是图像生成模型的提示词工程师...
```

### System Prompt优化后
```
你是图像生成模型的提示词工程师...

【参考图分析流程】
在改写提示词之前，你必须先分析参考图：
1. 主体识别
2. 风格特征
3. 构图结构
4. 细节提取
```

---

## ✅ 下一步

### 建议测试流程
1. 重启bridge: `npm run dev:bridge`
2. 测试直连模式生图（不走AI优化）
3. 测试AI对话模式生图（走Responses API）
4. 对比GPT官网相同提示词的效果
5. 收集badcase，持续迭代

### 监控指标
- 用户满意度：生成结果是否符合预期
- 参考图准确率：风格迁移/图生图的准确性
- 提示词忠实度：是否保留用户原意
- 失败率：生成失败或跑偏的比例

---

## 📞 问题反馈

如果发现以下问题，请记录详细信息：
1. 提示词被过度改写
2. 参考图主体被错误复刻
3. 风格参考效果不佳
4. 直连模式生图质量下降

记录内容：
- 原始提示词
- 参考图（如有）
- 优化后的提示词
- 生成结果
- 预期效果

---

## 📚 相关文档

- [提示词规范](./bridge/textApi.ts) - 核心规范代码
- [MCP工具文档](./bridge/mcp.ts) - huiban_prompt_guide工具
- [图片生成API](./bridge/imageApi.ts) - 直连模式优化
