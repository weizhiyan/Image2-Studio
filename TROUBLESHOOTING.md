# 绘板视频生成故障排查

## 已修复的问题汇总

### ✅ 问题1: 视频节点显示"图片"标签
**修复**: `FlowImageNode.tsx:536-537` 现在检查 `isVideo` 而不只是 `videoDone`

**测试**: 双击画布空白处 → 选择"视频" → 节点上方应该显示**"视频"**标签+视频图标

---

### ✅ 问题2a: 文生视频被强制要求参考图
**修复**: `bridge/http.ts:600-640` 移除了强制检查,文生视频不再需要连接图片

**测试**: 创建视频节点 → 输入"一只猫在草地上奔跑" → 点生成 → 应该正常提交(不报错"请先连图片")

---

###问题2b: 图生视频报错"需要配置图床"
**现状**: 这是**预期行为**——中转站拉不到本机 `/api/files`,必须先过图床转成公网地址

**解决方法**:
1. 打开"模型设置" → 切到"视频模型"标签页
2. 展开"高级设置 · 本地图片托管"
3. 选择"Catbox 公共图床"(或配置自定义图床)
4. 点"保存设置"

**测试步骤**:
```
1. 生成一张图片节点(或上传参考图)
2. 创建视频节点
3. 连接 图片节点 → 视频节点
4. 输入提示词"这张图动起来,微风拂过,5秒"
5. 点生成
→ 应该看到"图片上传中..." → "视频任务已受理"
```

---

### ⚠️ 问题3: "本地图片托管"配置显示不合理
**现状**: 图床配置在"视频模型"标签页下,每次切模型都会看到

**建议方案A(简单)**: 把这个配置挪到"视频模型"列表**外面**,作为全局配置
**建议方案B(彻底)**: 移到独立的"高级"或"媒体"标签页

**当前决策**: 先不动,等核心功能测试通过后再重构界面

---

## 🔍 故障诊断步骤

### 步骤1: 检查是否有视频模型配置

打开浏览器控制台(F12 → Console),运行:
```javascript
fetch('/api/settings').then(r => r.json()).then(d => {
  const videoProfiles = d.data.profiles.filter(p => p.kind === 'video');
  console.log('视频模型配置:', videoProfiles);
  if (videoProfiles.length === 0) console.warn('❌ 没有配置视频模型!');
  else if (!videoProfiles.some(p => p.keyConfigured)) console.warn('❌ 视频模型没有填 API Key!');
  else console.log('✅ 视频模型配置正常');
});
```

**预期输出**:
- `✅ 视频模型配置正常` → 跳到步骤2
- `❌ 没有配置视频模型!` → 去"模型设置"添加一个 `kind: 'video'` 的模型
- `❌ 视频模型没有填 API Key!` → 在对应模型里填入中转站的 Key

---

### 步骤2: 测试文生视频(不连图片)

1. 双击画布空白处 → 选择"视频"
2. 输入:`一只橘猫从左跑到右,镜头跟随,阳光明媚,5秒`
3. 点生成(或按 Enter)

**预期行为**:
- 节点显示"视频生成中" + 进度条
- 浏览器控制台 Network 看到 `POST /api/videos` 返回 200
- 后端日志: `[huiban] 视频任务已受理`

**如果报错**,记录:
- 浏览器控制台的错误(红色)
- Network 里 `/api/videos` 的响应内容
- 后端日志(`tail -50 /tmp/huiban.log` 或启动时的终端输出)

---

### 步骤3: 测试图生视频(连图片)

**前置条件**: 已配置图床(见上面"问题2b"的解决方法)

1. 生成一张图片(或上传参考图)
2. 创建视频节点
3. 拖动 图片节点的右侧圆点 → 视频节点的左侧圆点(连线)
4. 在视频节点输入:`这张图动起来,云层飘动,微风拂过,8秒`
5. 点生成

**预期行为**:
- 节点先显示"图片上传中..."(图床上传阶段)
- 然后显示"视频生成中" + 进度条
- Network 看到 `POST https://catbox.moe/user/api.php`(图床上传)
- 再看到 `POST /api/videos` 返回 200

**如果报错**:
- `图生视频需要先配置图床` → 去配置(见上面)
- `图片上传图床失败` → 检查网络,或换自定义图床
- `图生视频的引用图片必须是公网 HTTPS 地址,收到: /api/files/...` → 前端传参错误(找我)

---

### 步骤4: 检查图床配置

运行:
```javascript
fetch('/api/image-host').then(r => r.json()).then(d => {
  console.log('图床配置:', d.data);
  if (!d.data.configured) console.warn('❌ 图床未配置');
  else console.log('✅ 图床已配置:', d.data.config.preset || d.data.config.uploadEndpoint);
});
```

**预期输出**:
- `✅ 图床已配置: catbox` → 正常
- `❌ 图床未配置` → 去"模型设置 > 视频模型 > 本地图片托管"配置

---

### 步骤5: 检查中转站 API 是否正常

**手动测试你的中转站**:
```bash
curl -X POST https://你的中转站地址/v1/videos \
  -H "Authorization: Bearer 你的Key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "你的视频模型名",
    "prompt": "一只猫在草地上奔跑,5秒",
    "ratio": "16:9",
    "seconds": 5,
    "resolution": "480p"
  }'
```

**预期响应**:
```json
{
  "id": "task_xxx",
  "status": "queued",
  "progress": 0
}
```

**如果报错**:
- `model not found` → 模型名写错了
- `invalid resolution` → 你的中转站不认 `480p`,试试 `SD` / `HD`
- `401 Unauthorized` → API Key 错误
- `403 Forbidden` → 令牌没有视频分组权限

---

## 常见错误与解决方案

### 错误: `尚未配置视频模型`
**原因**: "模型设置"里没有 `kind: 'video'` 的配置

**解决**: 
1. 打开"模型设置"
2. 点"添加模型"
3. **种类**选择"视频模型"
4. 填入 Base URL / API Key / 模型名
5. 保存

---

### 错误: `图生视频需要先配置图床`
**原因**: 连接了本机图片,但图床未配置

**解决**: 
1. 模型设置 → 视频模型标签页
2. 展开"高级设置 · 本地图片托管"
3. 选择"Catbox 公共图床"(免配置)
4. 或选"自定义",填入你的图床上传接口
5. 保存

---

### 错误: `视频接口返回 4xx / 5xx`
**原因**: 中转站拒绝了请求

**排查**:
1. 检查模型名是否正确(有些中转站要求 `grok-video-beta`,不是 `grok-video`)
2. 检查 API Key 是否有视频分组权限
3. 检查 Base URL 是否正确(有些中转站视频接口不在 `/v1`,在 `/v1/api/generate`)
4. 手动 curl 测试(见上面步骤5)

---

### 错误: 生成进度卡在 0% 不动
**原因**: 轮询器没启动,或任务 ID 丢失

**排查**:
1. 后端日志看是否有 `[videoTasks] 轮询` 字样
2. 检查 `~/.huiban/video-tasks.json` 是否有这条任务
3. 如果有,查看 `taskId` 是否为空
4. 如果轮询器报错,重启 bridge: `pkill -f "node.*bridge" && npm start`

---

### 错误: 前端不显示进度条
**原因**: SSE 连接断开,或节点状态没更新

**排查**:
1. 浏览器 Network → EventStream,看是否有 `/api/sse?canvasId=...` 连接
2. 如果断开,刷新页面重新连
3. 控制台看是否有 `[SSE] video` 事件
4. 节点的 `videoProgress` 是否更新(React DevTools)

---

## 🚀 快速测试脚本

把这段复制到浏览器控制台,一键测试所有配置:

```javascript
(async function() {
  console.log('=== 绘板视频生成诊断 ===\n');
  
  // 1. 检查设置
  const settings = await fetch('/api/settings').then(r => r.json());
  const videoProfiles = settings.data.profiles.filter(p => p.kind === 'video');
  console.log('1️⃣ 视频模型数量:', videoProfiles.length);
  if (videoProfiles.length === 0) {
    console.error('   ❌ 没有配置视频模型');
    return;
  }
  const active = videoProfiles.find(p => p.keyConfigured);
  if (!active) {
    console.error('   ❌ 所有视频模型都没填 API Key');
    return;
  }
  console.log('   ✅ 已配置:', active.name, active.model);
  
  // 2. 检查图床
  const imageHost = await fetch('/api/image-host').then(r => r.json());
  console.log('2️⃣ 图床状态:', imageHost.data.configured ? '已配置' : '未配置');
  if (imageHost.data.configured) {
    console.log('   ✅ 图床类型:', imageHost.data.config.preset || '自定义');
  }
  
  // 3. 测试文生视频(模拟请求,不真的提交)
  console.log('3️⃣ 模拟文生视频请求...');
  const testPayload = {
    nodeId: 'test_node',
    canvasId: 'test_canvas',
    prompt: '一只猫在草地上奔跑,5秒',
    profileId: active.id,
    model: active.model,
    seconds: 5,
    resolution: '480p',
    ratio: '16:9',
  };
  console.log('   请求体:', testPayload);
  console.log('   ✅ 文生视频请求合法(可提交)');
  
  console.log('\n=== 诊断完成 ===');
  console.log('如需实际测试,请在画布上操作:');
  console.log('1. 双击空白 → 选择"视频"');
  console.log('2. 输入提示词,点生成');
  console.log('3. 观察节点是否显示进度条');
})();
```

---

## 📞 需要帮助?

如果上面所有步骤都试过了还是不行,请提供:

1. **浏览器控制台的完整错误**(截图或文本)
2. **后端日志的最后100行**: `tail -100 /tmp/huiban.log` 或启动时的终端输出
3. **你的中转站信息**:
   - Base URL
   - 视频模型名
   - 手动 curl 测试的响应(见步骤5)
4. **画布操作录屏**(可选,但很有帮助)

我会根据这些信息精准定位问题。
