import { describe, expect, it } from 'vitest';
import { buildMemoryContext, DEFAULT_MEMORY_POLICY, estimateTokens, memoryPromptBlock } from '../bridge/chatMemory';

const msg = (role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}) => ({ role, content, ...extra });

describe('buildMemoryContext', () => {
  it('uses a bounded short-term window and leaves older messages eligible for compaction', () => {
    const messages = Array.from({ length: 20 }, (_, index) => msg(index % 2 ? 'assistant' : 'user', `turn ${index} ${'detail '.repeat(45)}`));
    const context = buildMemoryContext(messages, {}, {
      shortTermMessageLimit: 6,
      shortTermTokenBudget: 10_000,
      summaryTriggerTokens: 1,
    });

    expect(context.shortTermMessages).toHaveLength(6);
    expect(context.shortTermMessages[0].content).toContain('turn 14');
    expect(context.shortTermMessages.at(-1)?.content).toContain('turn 19');
    expect(context.compactableMessages).toHaveLength(14);
    expect(context.shouldCompact).toBe(true);
  });

  it('keeps the newest message even when it alone exceeds the short-term budget', () => {
    const long = '细节'.repeat(2_000);
    const context = buildMemoryContext([msg('user', long)], {}, {
      shortTermTokenBudget: 10,
      shortTermMessageLimit: 8,
      summaryTriggerTokens: 100_000,
    });
    expect(context.shortTermMessages).toHaveLength(1);
    expect(context.shortTermMessages[0].content).toBe(long);
    expect(context.estimatedShortTermTokens).toBeGreaterThan(10);
  });

  it('does not request compaction before the threshold and retains a persisted summary', () => {
    const context = buildMemoryContext([msg('user', '设计一个极简咖啡品牌标志')], {
      summary: '用户偏好极简几何风格。',
      summaryMessageCount: 12,
    });
    expect(context.shouldCompact).toBe(false);
    expect(context.summary).toBe('用户偏好极简几何风格。');
    expect(context.summaryDraft).toBe(context.summary);
    expect(context.summaryMessageCount).toBe(12);
  });

  it('builds a compact, structured fallback summary from old messages and the active goal', () => {
    const messages = [
      msg('user', '给咖啡品牌做一个极简 Logo，主色用墨绿色'),
      msg('assistant', 'Logo 是用于门店招牌还是包装？'),
      msg('user', '用于包装，保留圆形构图，字体改得更现代，不要渐变'),
      msg('assistant', '收到，我会保留圆形构图，改为现代字体。'),
    ];
    const context = buildMemoryContext(messages, {}, {
      shortTermMessageLimit: 1,
      shortTermTokenBudget: 10,
      summaryTriggerTokens: 1,
      summaryTargetTokens: 120,
    });

    expect(context.shouldCompact).toBe(true);
    expect(context.goal.mode).toBe('image');
    expect(context.goal.statement).toContain('不要渐变');
    expect(context.goal.deliverable).toBe('图像生成结果');
    expect(context.goal.preserve.join(' ')).toContain('圆形构图');
    expect(context.goal.change.join(' ')).toContain('字体');
    expect(context.goal.rejected.join(' ')).toContain('渐变');
    expect(context.summaryDraft).toContain('当前目标');
    expect(context.summaryDraft.length).toBeLessThanOrEqual(360);
  });

  it('tracks explicit references separately and automatically breaks image inheritance for a new request', () => {
    const messages = [
      msg('user', '做一个品牌 Logo'),
      msg('assistant', '已生成。', { media: [{ nodeId: 'node-1', versionId: 'v1', url: '/api/files/logo.png' }] }),
      msg('user', '另外做一张开业海报', { attachments: [{ canvasId: 'canvas-2', nodeId: 'node-2', versionId: 'v7', title: '版式参考' }] }),
    ];
    const context = buildMemoryContext(messages);

    expect(context.visualWorkingSet.explicitNewRequest).toBe(true);
    expect(context.visualWorkingSet.inheritMode).toBe('new');
    expect(context.visualWorkingSet.base).toBeUndefined();
    expect(context.visualWorkingSet.references).toEqual([
      expect.objectContaining({ nodeId: 'node-2', versionId: 'v7', source: 'attachment' }),
    ]);
    expect(context.visualWorkingSet.recentOutputs).toEqual([]);
  });

  it('defaults to the most recent generated result as candidate base and includes memory in the prompt block', () => {
    const context = buildMemoryContext([
      msg('assistant', '已生成。', { media: [{ nodeId: 'node-1', versionId: 'v1' }] }),
      msg('user', '把图标线条再细一些'),
    ], {
      summary: '用户要求线性图标，不要渐变。',
      goal: { statement: '完善 Logo 图标' },
    });
    const block = memoryPromptBlock(context);

    expect(context.visualWorkingSet.inheritMode).toBe('edit');
    expect(context.visualWorkingSet.base?.versionId).toBe('v1');
    expect(block).toContain('早期摘要：用户要求线性图标');
    expect(block).toContain('默认候选基准版本：v1');
  });

  it('只在当前回合断开继承，后续回合回到最近结果自动继承', () => {
    const messages = [
      msg('assistant', '已生成新方向。', { media: [{ nodeId: 'node-2', versionId: 'v2', url: '/api/files/new.png' }] }),
      msg('user', '另外做一个开业海报'),
      msg('assistant', '已生成海报。', { media: [{ nodeId: 'node-3', versionId: 'v3', url: '/api/files/poster.png' }] }),
      msg('user', '再把标题放大一点'),
    ];
    const context = buildMemoryContext(messages);

    expect(context.visualWorkingSet.inheritMode).toBe('edit');
    expect(context.visualWorkingSet.base?.versionId).toBe('v3');
  });

  it('新需求切换当前目标和短期历史，但旧对话仍可进入摘要', () => {
    const messages = [
      { ...msg('user', '做一个极简 Logo，保留旧的圆形图案'), createdAt: '2026-10-14T00:00:00.000Z' },
      msg('assistant', '已生成 Logo。', { media: [{ nodeId: 'logo-1', versionId: 'logo-v1', url: '/api/files/logo.png' }] }),
      { ...msg('user', '另外做一张开业海报，不要渐变'), createdAt: '2026-10-14T00:00:02.000Z' },
    ];
    const context = buildMemoryContext(messages, {
      goal: { statement: '继续完善 Logo', preserve: ['圆形图案'], updatedAt: '2026-10-14T00:00:00.000Z' },
    }, { shortTermMessageLimit: 8, summaryTriggerTokens: 1 });

    expect(context.shortTermMessages).toHaveLength(1);
    expect(context.shortTermMessages[0].content).toContain('开业海报');
    expect(context.goal.statement).toContain('开业海报');
    expect(context.goal.preserve).not.toContain('圆形图案');
    expect(context.visualWorkingSet.base).toBeUndefined();
    expect(context.compactableMessages).toHaveLength(2);
  });

  it('摘要边界只前进到实际压缩的消息，后续只摘要新增旧消息', () => {
    const messages = Array.from({ length: 20 }, (_, index) => msg(index % 2 ? 'assistant' : 'user', `record ${index} ${'detail '.repeat(20)}`));
    const policy = { shortTermMessageLimit: 6, shortTermTokenBudget: 10_000, summaryTriggerTokens: 1 };
    const first = buildMemoryContext(messages, {}, policy);
    const nextMessages = [...messages, msg('user', 'record 20'), msg('assistant', 'record 21')];
    const next = buildMemoryContext(nextMessages, {
      summary: first.summaryDraft,
      summaryMessageCount: first.summaryMessageCount,
    }, policy);

    expect(first.summaryMessageCount).toBe(14);
    expect(next.compactableMessages).toHaveLength(2);
    expect(next.summaryMessageCount).toBe(16);
    expect(next.summaryDraft).toContain('record 20');
  });

  it('estimates Chinese and Latin text conservatively and exposes a usable default policy', () => {
    expect(estimateTokens('中文测试')).toBeGreaterThanOrEqual(4);
    expect(estimateTokens('abcd')).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_MEMORY_POLICY.shortTermTokenBudget).toBeGreaterThan(0);
  });
});
