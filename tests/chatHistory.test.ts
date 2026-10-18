import { describe, expect, it } from 'vitest';
import { buildAgentHistory } from '../bridge/runs';

describe('buildAgentHistory visual context', () => {
  it('无显式引用时只回喂最近基准图', () => {
    const history = buildAgentHistory([
      { role: 'assistant', content: '第一张', media: [{ versionId: 'v1', url: '/api/files/old.png' }] },
      { role: 'assistant', content: '第二张', media: [{ versionId: 'v2', url: '/api/files/latest.png' }] },
      { role: 'user', content: '把它的标题放大一些' },
    ], { inheritMode: 'edit', baseImageUrl: '/api/files/latest.png' });

    expect(history.at(-1)?.images).toEqual(['/api/files/latest.png']);
  });

  it('显式引用优先于自动继承的基准图', () => {
    const history = buildAgentHistory([
      { role: 'user', content: '参考图做成同样的风格', attachments: [{ url: '/api/files/reference.png' }] },
    ], { inheritMode: 'auto', baseImageUrl: '/api/files/previous.png' });

    expect(history.at(-1)?.images).toEqual(['/api/files/reference.png']);
  });

  it('新需求不会把上一任务的图片注入当前用户消息', () => {
    const history = buildAgentHistory([
      { role: 'assistant', content: '上个任务结果', media: [{ versionId: 'v1', url: '/api/files/old.png' }] },
      { role: 'user', content: '另外做一个全新的 Logo' },
    ], { inheritMode: 'new' });

    expect(history.at(-1)?.images).toBeUndefined();
  });

  it('结构化询问答案会进入后续 Agent 上下文', () => {
    const history = buildAgentHistory([
      {
        role: 'user',
        content: '已回答：补充几个信息',
        askResponse: {
          title: '补充几个信息',
          questions: [{ id: 'subject', title: '主体是什么？', answers: ['产品本身'] }],
        },
      },
    ]);

    expect(history[0]?.content).toContain('主体是什么？');
    expect(history[0]?.content).toContain('产品本身');
  });
});
