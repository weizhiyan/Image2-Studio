import { describe, expect, it } from 'vitest';
import { applyMemoryCompaction, buildMemoryContext, defaultMemorySettings, normalizeMemorySettings, DEFAULT_MEMORY_POLICY, estimateTokens, memoryPromptBlock } from '../bridge/chatMemory';

const msg = (role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}) => ({ role, content, ...extra });

describe('memory settings and lossless compaction', () => {
  it('defaults and clamps public budgets with a coherent trigger', () => {
    expect(defaultMemorySettings()).toEqual({ enabled: true, shortTermMessageLimit: 12, shortTermTokenBudget: 4500, summaryTriggerTokens: 8000, summaryTargetTokens: 900, maxRecentOutputs: 4 });
    expect(normalizeMemorySettings({ enabled: false, shortTermMessageLimit: 900, shortTermTokenBudget: 16000, summaryTriggerTokens: 4000, summaryTargetTokens: 2, maxRecentOutputs: 99 })).toEqual({ enabled: false, shortTermMessageLimit: 40, shortTermTokenBudget: 16000, summaryTriggerTokens: 16300, summaryTargetTokens: 300, maxRecentOutputs: 4 });
    expect(normalizeMemorySettings({ shortTermTokenBudget: NaN, enabled: 'false' })).toEqual(defaultMemorySettings());
  });

  it('compacts on a short window overflow below the early trigger without silently forgetting raw text', () => {
    const messages = Array.from({ length: 14 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `原文${i}`, { id: `m${i}` }));
    const context = buildMemoryContext(messages);
    expect(context.estimatedFullTokens).toBeLessThan(8000);
    expect(context.shouldCompact).toBe(true);
    expect(context.compactableMessages.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(context.contextMessages).toEqual(messages);
    expect(context.summaryThroughMessageId).toBe('m1');
    expect(context.warning).toContain('未压缩原文');
    const updated = applyMemoryCompaction(context, { summary: '已确认包装用途。', goal: { statement: '人工或语义目标' } }, '2026-10-30T00:00:00.000Z');
    expect(updated.contextMessages).toHaveLength(12);
    expect(updated.warning).toBeUndefined();
    expect(memoryPromptBlock(updated)).toContain('已确认包装用途');
    expect(updated.goal.statement).toBe('人工或语义目标');
  });

  it('uses stable summary IDs across truncated history instead of stale counts', () => {
    const messages = Array.from({ length: 16 }, (_, i) => msg('user', `原文${i}`, { id: `m${i + 500}` }));
    const context = buildMemoryContext(messages, { summary: '旧摘要', summaryThroughMessageId: 'm501', summaryMessageCount: 500, memoryRevision: 7 });
    expect(context.compactableMessages.map((m) => m.id)).toEqual(['m502', 'm503']);
    expect(context.memoryRevision).toBe(7);
    const unknown = buildMemoryContext(messages, { summary: '旧摘要', summaryThroughMessageId: 'missing', summaryMessageCount: 999 });
    expect(unknown.compactableMessages).toHaveLength(4);
  });

  it('clearing bars earlier text and visuals and disabling injects only bounded recent messages', () => {
    const messages = [msg('user', '保留旧背景', { id: 'm0' }), msg('assistant', '旧图', { id: 'm1', media: [{ nodeId: 'old', versionId: 'v1' }] }), msg('user', '继续', { id: 'm2' })];
    const cleared = buildMemoryContext(messages, { clearedThroughMessageId: 'm1', summary: '旧摘要', goal: { statement: '旧目标' }, visualWorkingSet: { base: { nodeId: 'old' } } });
    expect(cleared.contextMessages.map((m) => m.id)).toEqual(['m2']);
    expect(cleared.visualWorkingSet.base).toBeUndefined();
    expect(cleared.summary).toBe('');
    const disabled = buildMemoryContext(Array.from({ length: 14 }, () => msg('user', '保留背景')), { summary: '不要注入', goal: { statement: '旧目标' } }, { enabled: false });
    expect(disabled.shouldCompact).toBe(false);
    expect(disabled.contextMessages).toHaveLength(12);
    expect(memoryPromptBlock(disabled)).not.toContain('不要注入');
    expect(memoryPromptBlock(disabled)).toContain('已关闭');
  });

  it('preserves manual brief and classifies clauses exclusively with newest constraints first', () => {
    const context = buildMemoryContext([msg('user', '不要改背景，字体改为现代，不要渐变')], { goal: { statement: '人工目标', preserve: Array.from({ length: 8 }, (_, i) => `旧约束${i}`) } });
    expect(context.goal.statement).toBe('人工目标');
    expect(context.goal.preserve[0]).toBe('不要改背景');
    expect(context.goal.change).toEqual(['字体改为现代']);
    expect(context.goal.rejected).toEqual(['不要渐变']);
    expect(context.goal.confirmed).toEqual([]);
  });

  it('does not re-extract old constraints over a newer manual brief and includes every brief list in the prompt', () => {
    const context = buildMemoryContext([msg('user', '保留旧背景', { createdAt: '2026-10-30T00:00:00Z' })], { goal: { statement: '手工目标', preserve: [], confirmed: ['已确认'], openQuestions: ['待定项'], updatedAt: '2026-10-30T00:00:02Z' } });
    expect(context.goal.preserve).toEqual([]);
    expect(memoryPromptBlock(context)).toContain('已确认');
    expect(memoryPromptBlock(context)).toContain('待定项');
    const blank = buildMemoryContext([msg('user', '旧目标', { createdAt: '2026-10-30T00:00:00Z' })], { goal: { statement: '', preserve: [], updatedAt: '2026-10-30T00:00:02Z' } });
    expect(blank.goal.statement).toBe('');
  });

  it('allows a manually updated brief after clear without reviving the old summary', () => {
    const messages = [msg('user', '旧历史', { id: 'before', createdAt: '2026-10-30T00:00:00Z' }), msg('user', '新需求', { id: 'after', createdAt: '2026-10-30T00:00:01Z' })];
    const context = buildMemoryContext(messages, { clearedThroughMessageId: 'before', goal: { statement: '清除后人工编辑', updatedAt: '2026-10-30T00:00:02Z' } });
    expect(context.goal.statement).toBe('清除后人工编辑');
    expect(context.contextMessages.map((m) => m.id)).toEqual(['after']);
    const manual = buildMemoryContext(messages, { clearedThroughMessageId: 'before', summary: '清除后手工摘要', summaryThroughMessageId: 'before', summaryUpdatedAt: '2026-10-30T00:00:02Z' });
    expect(manual.summary).toBe('清除后手工摘要');
  });

  it('does not inherit images from outside the disabled recent window', () => {
    const context = buildMemoryContext([msg('assistant', '旧图', { media: [{ nodeId: 'old' }] }), ...Array.from({ length: 12 }, () => msg('user', '继续'))], {}, { enabled: false });
    expect(context.visualWorkingSet.base).toBeUndefined();
    expect(context.visualWorkingSet.recentOutputs).toEqual([]);
  });

  it('uses the early threshold before window overflow while retaining the newest original message', () => {
    const context = buildMemoryContext([msg('user', '第一段', { id: 'm0' }), msg('assistant', '第二段', { id: 'm1' }), msg('user', '最新', { id: 'm2' })], {}, { shortTermMessageLimit: 40, shortTermTokenBudget: 16000, summaryTriggerTokens: 1 });
    expect(context.shouldCompact).toBe(true);
    expect(context.compactableMessages.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(context.shortTermMessages.map((m) => m.id)).toEqual(['m2']);
    expect(context.contextMessages).toHaveLength(3);
  });

  it('signals pause rather than truncating uncompressed text above the hard context ceiling', () => {
    const context = buildMemoryContext([msg('user', '中'.repeat(900))], {}, { hardContextTokenBudget: 100 });
    expect(context.requiresPause).toBe(true);
    expect(context.contextMessages[0].content).toHaveLength(900);
  });
});

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
