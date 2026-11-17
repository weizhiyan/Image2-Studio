# 提示词优化效果对比

本文档是历史方案的人工示例，不是模型实测对照。部分规则已于2026-11-16替换，不能据此推断当前行为或质量提升；当前实现与验证边界见 [图像设计编排](docs/image-planning.md)。

---

## 场景1: 风格参考 - 防止主体复刻

### 输入
```
用户: 一个现代科技办公室
参考图: [某公司的办公室照片]
用途: 风格参考
```

### ❌ 优化前
**AI生成的提示词**:
```
A modern tech office with glass walls, wooden desks, black ergonomic chairs,
large monitors, plants on the windowsill, natural lighting from floor-to-ceiling windows
```

**问题**: 描述了参考图里的具体物品（玻璃墙、木桌、黑色椅子），导致生成图和参考图主体相同

**生成结果**: 几乎完全复刻了参考图的办公室布局和家具

---

### ✅ 优化后
**AI生成的提示词**:
```
A modern tech office with sleek contemporary design, warm natural lighting
streaming through windows, clean minimalist aesthetic, subtle plant accents,
professional atmosphere with cool gray and natural wood tones
```

**改进**:
- 只描述氛围感（现代、简洁、专业）
- 只保留色调和光线特征
- 完全不提参考图里的具体家具
- 让模型自由发挥布局和物品

**生成结果**: 全新的办公室场景，保留了参考图的氛围感但主体完全不同

---

## 场景2: 图生图 - 精确保留主体

### 输入
```
用户: 把这只猫换成橘色
参考图: [一只灰色的猫坐在蓝色沙发上]
用途: 图生图
```

### ❌ 优化前
**AI生成的提示词**:
```
An orange cat sitting on a sofa, cozy indoor setting, natural lighting
```

**问题**:
- 没有明确要求保留原图的沙发颜色
- 没有强调保留姿势和构图
- 模型可能改变背景和环境

**生成结果**: 猫变成了橘色，但沙发变成了棕色，姿势也不同

---

### ✅ 优化后
**AI生成的提示词**:
```
Based on reference image: change the gray cat to an orange tabby cat
while preserving the exact blue sofa, sitting pose, camera angle,
background, and lighting
```

**改进**:
- 明确标记"Based on reference image"
- 详细列出要保留的元素（蓝色沙发、姿势、角度）
- 只改变用户要求的部分（猫的颜色）

**生成结果**: 猫变成橘色，沙发颜色、姿势、构图完全保留

---

## 场景3: 短提示词 - 自动补全

### 输入
```
用户: a cat
画幅: 1920x1080 (16:9横向)
参考图: 无
```

### ❌ 优化前（直连模式）
**发送给模型的提示词**:
```
a cat
```

**问题**: 信息太少，模型随机发挥

**生成结果**: 每次效果差异很大，质量不稳定

---

### ✅ 优化后（直连模式）
**自动优化后的提示词**:
```
a cat, wide horizontal composition, natural lighting, high quality
```

**改进**:
- 自动识别横向画幅，添加构图建议
- 补充基础光线
- 补充质量要求

**生成结果**: 更稳定，符合16:9横向画幅的构图

---

## 场景4: 详细提示词 - 保护原意

### 输入
```
用户: A majestic orange tabby cat sitting on a vintage velvet armchair,
soft afternoon sunlight streaming through lace curtains, creating warm
highlights on its fur, bokeh background, 35mm film photography,
shallow depth of field, highly detailed
画幅: 1024x1024
```

### ❌ 优化前
**AI优化后的提示词**:
```
A regal orange tabby cat positioned gracefully on an antique velvet armchair,
bathed in golden afternoon light filtering through delicate white lace curtains,
with luminous highlights dancing across its luxurious fur, soft bokeh background
creating dreamy atmosphere, captured with 35mm film camera using shallow depth
of field technique, ultra-detailed photorealistic rendering
```

**问题**:
- 改写了用户的措辞（majestic→regal, soft→golden）
- 添加了用户没说的细节（white lace curtains, dancing highlights）
- 过度具象化（luxurious fur, ultra-detailed photorealistic）

---

### ✅ 优化后
**AI优化后的提示词**:
```
A majestic orange tabby cat sitting on a vintage velvet armchair,
soft afternoon sunlight streaming through lace curtains, creating warm
highlights on its fur, bokeh background, 35mm film photography,
shallow depth of field, highly detailed, centered composition
```

**改进**:
- 几乎保留所有原有措辞
- 只补充了构图建议（centered composition）
- 不改变用户已经明确的细节

**生成结果**: 完全符合用户的详细要求

---

## 场景5: 艺术家风格 - 合规替换

### 输入
```
用户: 一幅风景画，梵高的风格
参考图: 无
```

### ❌ 优化前
**AI生成的提示词**:
```
A landscape painting in the style of Vincent van Gogh
```

**问题**: 直接使用艺术家姓名，可能违反版权或平台政策

---

### ✅ 优化后
**AI生成的提示词**:
```
A landscape painting in post-impressionist style with bold, expressive brushstrokes,
vibrant colors, swirling patterns, thick impasto texture, emotional intensity
```

**改进**:
- 用流派描述（后印象派）替代姓名
- 用视觉特征描述（粗犷笔触、鲜艳色彩、旋转图案）
- 更精确地表达风格特征

**生成结果**: 达到相似的风格效果，符合平台规范

---

## 场景6: 否定约束 - 正确处理

### 输入
```
用户: 一只猫，不要背景
参考图: 无
```

### ❌ 优化前
**AI生成的提示词**:
```
A cat, no background, simple background
```

**问题**:
- "no background"是否定描述，模型可能混淆
- "simple background"仍然会生成背景

---

### ✅ 优化后
**AI生成的提示词**:
```
A cat isolated on pure white background
```

**改进**:
- 将否定约束转换为正面描述
- 明确指定白色背景
- 使用"isolated"强调主体单独存在

**生成结果**: 干净的白底猫咪图，无杂物

---

## 性能对比总结

| 场景 | 优化前问题 | 优化后改进 | 效果提升 |
|------|-----------|-----------|---------|
| 风格参考 | 复刻参考图主体 | 只迁移氛围，主体全新 | ⭐⭐⭐⭐⭐ |
| 图生图 | 改变不该改的部分 | 精确保留，只改指定 | ⭐⭐⭐⭐⭐ |
| 短提示词 | 信息不足，随机发挥 | 自动补全基础维度 | ⭐⭐⭐⭐ |
| 详细提示词 | 过度改写，丢失原意 | 保护原措辞和细节 | ⭐⭐⭐⭐⭐ |
| 艺术家风格 | 直接使用姓名 | 流派+视觉特征 | ⭐⭐⭐⭐ |
| 否定约束 | 否定描述混淆模型 | 转为正面描述 | ⭐⭐⭐⭐ |

---

## 如何验证优化效果

### 1. 对比测试
使用相同的提示词和参考图，分别在：
- GPT官网生成
- 优化后的画布生成

对比两者的效果差异

### 2. 边界案例测试
- 只输入1-3个单词
- 输入超过100词的详细描述
- 使用明显的风格参考图
- 使用需要精确编辑的图生图

### 3. 观察关键指标
- 是否复刻了风格参考图的主体
- 图生图是否改变了不该改的部分
- 短提示词的质量稳定性
- 详细提示词是否被过度改写

---

## 快速测试命令

```bash
# 编译bridge
npm run build

# 运行测试脚本
node test-prompt-optimization.js

# 启动服务测试实际效果
npm run dev        # 前端
npm run dev:bridge # bridge
```

---

## 反馈与改进

如果发现优化效果不理想，请记录：

1. **原始输入**
   - 用户提示词
   - 参考图描述
   - 画幅尺寸
   - 生成模式（直连/AI对话）

2. **实际输出**
   - 优化后的提示词
   - 生成的图片效果

3. **预期效果**
   - 应该是什么样的提示词
   - 应该生成什么样的图片

4. **差异分析**
   - 哪里不符合预期
   - 可能是什么原因

将以上信息提交issue或反馈给开发团队，帮助持续改进。
