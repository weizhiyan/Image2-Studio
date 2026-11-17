import assert from 'node:assert/strict';
import { preprocessDirectPrompt } from './bridge/dist/textApi.js';

const cases = [
  { name: '简短英文原文', prompt: 'a cat', size: '1920x1080', usage: 'style', hasReference: false },
  { name: '风格参考不额外补词', prompt: 'a modern office', size: '1024x1024', usage: 'style', hasReference: true },
  { name: '编辑要求不额外改写', prompt: 'change the color to blue', size: '1024x1024', usage: 'edit', hasReference: true },
  { name: '中文光线与材质原样保留', prompt: '柔和自然光，细腻材质，高清细节', size: '1024x1024', usage: 'style', hasReference: false },
  { name: '画幅不触发文字补充', prompt: 'a portrait', size: '768x1344', usage: 'style', hasReference: false },
  { name: '只清理首尾空白', prompt: '  黑白Logo\n不要阴影  ', size: '1024x1024', usage: 'style', hasReference: false },
];

for (const item of cases) {
  const result = preprocessDirectPrompt(item.prompt, item.size, item.usage, item.hasReference);
  assert.equal(result, item.prompt.trim(), item.name);
  console.log(`通过：${item.name}`);
}

console.log('直连预处理检查完成；此脚本不调用模型，不评价成图质量。');
