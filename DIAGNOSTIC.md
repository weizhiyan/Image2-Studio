# 绘板问题诊断与修复指南

## 问题1: 节点删除失效

**根因**: 远程画布文档与本地 localStorage 不一致

**修复步骤**:
```bash
# 1. 清除所有远程画布文档(已执行)
rm -f ~/.huiban/canvas-docs.json ~/.huiban/video-tasks.json ~/.huiban/backups/*

# 2. 重启服务
pkill -f "node.*bridge"
npm start

# 3. 清除浏览器 localStorage
# 打开浏览器 F12 → Application → Local Storage → localhost:5199 → 全部删除
```

**测试**: 刷新页面 → 双击创建一个节点 → 删除它 → 应该**永久消失**(不再恢复)

---

## 问题2: 生成反馈不明确 + `fetch failed`

### 原因分析

`fetch failed` 通常意味着:
1. **中转站返回了 HTTP 错误** (4xx / 5xx)
2. **或者网络请求被浏览器拦截** (CORS / timeout)
3. **或者中转站 API 有变化** (Base URL / 参数不对)

### 诊断脚本

**在浏览器控制台运行** (F12 → Console):

```javascript
// 1. 检查视频配置
fetch('/api/settings').then(r => r.json()).then(d => {
  const videoProfiles = d.data.profiles.filter(p => p.kind === 'video');
  console.log('=== 视频模型配置 ===');
  console.log('个数:', videoProfiles.length);
  if (videoProfiles.length === 0) {
    console.error('❌ 没有配置视频模型!');
    return;
  }
  const active = videoProfiles[0];
  console.log('当前模型:', active.model);
  console.log('Base URL:', active.baseUrl);
  console.log('API Mode:', active.videoApiMode);
  console.log('Key已配置:', !!active.apiKey ? '✅' : '❌');
});

// 2. 测试视频生成请求(模拟)
setTimeout(() => {
  console.log('\n=== 模拟视频生成请求 ===');
  fetch('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: 'test_node',
      canvasId: 'test_canvas',
      prompt: '测试提示词',
      seconds: 5,
      resolution: '480p',
      ratio: '16:9',
    }),
  })
    .then(r => r.json())
    .then(d => console.log('响应:', d))
    .catch(e => console.error('请求失败:', e.message));
}, 1000);
```

### 如果返回错误

记录以下信息:

1. **后端日志** (Terminal):
```bash
tail -50 /tmp/huiban.log | grep -i "video\|error"
```

2. **浏览器 Network** (F12 → Network):
   - 找到 `/api/videos` 请求
   - 查看 Response 标签页的完整内容
   - 复制粘贴给我

3. **浏览器 Console** (F12 → Console):
   - 任何红色错误信息
   - 复制粘贴给我

---

## 问题3: 界面加载缓慢

### 快速优化

**立即生效的改动**:

在 `src/components/canvas/CanvasPage.tsx` 的开头加:

```typescript
// 延迟加载 SSE: 不在挂载时立即订阅，而是用户打开画布时再订阅
const subscribeCanvasEvents = useCallback(() => {
  const unsubImage = subscribePushedImages(activeId, onPushedImage);
  const unsubVideo = subscribePushedVideos(activeId, onPushedVideo);
  return () => {
    unsubImage?.();
    unsubVideo?.();
  };
}, [activeId, onPushedImage, onPushedVideo]);

useEffect(() => {
  if (!activeId) return;
  const unsubscribe = subscribeCanvasEvents();
  return unsubscribe;
}, [activeId, subscribeCanvasEvents]);
```

**图片懒加载**:

```typescript
// CanvasImage.tsx 加这个 hook
const [isVisible, setIsVisible] = useState(false);
const ref = useRef<HTMLImageElement>(null);

useEffect(() => {
  if (!ref.current) return;
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) setIsVisible(true);
  }, { rootMargin: '50px' });
  observer.observe(ref.current);
  return () => observer.disconnect();
}, []);

// 只在可见时加载
src={isVisible ? src : undefined}
```

---

## 问题4: 服务器状态疑问

### 确认当前状态

```bash
# 1. 查看服务是否已重启
ps aux | grep "node.*bridge"

# 2. 查看画布数据文件的时间戳
ls -lh ~/.huiban/canvas-docs.json

# 3. 查看最近的日志
tail -20 /tmp/huiban.log
```

### 完整清理步骤(推荐)

```bash
# 1. 停止所有服务
pkill -f "node.*bridge"
pkill -f "vite"

# 2. 清除所有旧数据
rm -rf ~/.huiban/canvas-docs.json
rm -rf ~/.huiban/video-tasks.json
rm -rf ~/.huiban/backups/*
rm -rf ~/.huiban/chat-docs.json

# 3. 清除浏览器数据
# 手动: F12 → Application → Clear site data

# 4. 重建前端
npm run build

# 5. 重启服务
npm start

# 6. 打开浏览器，刷新(不是 F5,而是 Ctrl+Shift+R 硬刷新)
```

---

## 完整排查流程

### 第一步: 清理并重启

```bash
rm -f ~/.huiban/*.json ~/.huiban/backups/*
npm run build
npm start
```

### 第二步: 测试文生视频(最简单的场景)

1. 浏览器打开 `http://localhost:5199`
2. 刷新页面
3. 双击创建视频节点
4. 输入: `一只猫在草地上跑,5秒`
5. 点生成
6. **观察**:
   - 节点上是否显示"视频生成中"
   - 是否有进度条(0% → 100%)
   - 右下角是否显示"已完成"或"fetch failed"

### 第三步: 如果显示 `fetch failed`

在浏览器 Console 运行上面的诊断脚本，然后:
- 打开后端日志: `tail -50 /tmp/huiban.log`
- 打开 Network 标签页,看 `/api/videos` 的响应
- 复制**完整的错误信息**给我

### 第四步: 测试图生视频(如果文生视频成功)

1. 生成一张图片(或上传参考图)
2. 创建视频节点
3. 连接图片到视频节点
4. 输入: `这张图动起来,微风拂过,8秒`
5. 点生成
6. **观察结果**

---

## 实时检查命令

保持运行这个,看实时日志:

```bash
tail -f /tmp/huiban.log | grep -i "video\|error\|submit"
```

在另一个终端测试生成,可以立即看到后端的处理过程。

---

## 如果问题持续

请给我:
1. 完整的 `/api/videos` 响应(整个 JSON)
2. 后端日志的最后 100 行
3. 你的中转站名称 + 模型名称
4. Base URL 的实际值(不要 Key)

我可以精准定位中转站适配问题。
