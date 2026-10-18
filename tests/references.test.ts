import { describe, expect, it } from 'vitest';
import type { CanvasReference } from '@/types';
import { areCanvasReferencesEqual, buildReferenceNumberingInstruction, hasUsableTextReference } from '@/lib/references';

function ref(id: string, extra: Partial<CanvasReference> = {}): CanvasReference {
  return { id, url: `/api/files/${id}.png`, title: '参考图', kind: 'image', text: '', ...extra };
}

describe('composer 引用相等判断（按边派生，必须严格相等）', () => {
  it('完全一致判相等', () => {
    expect(areCanvasReferencesEqual([ref('a')], [ref('a')])).toBe(true);
    expect(areCanvasReferencesEqual(undefined, [])).toBe(true);
    expect(areCanvasReferencesEqual([], [])).toBe(true);
  });

  it('「有引用 → 零引用」必须判不等——断开连接 / 点 × 后 chip 要能消失', () => {
    expect(areCanvasReferencesEqual([ref('a')], [])).toBe(false);
    expect(areCanvasReferencesEqual([ref('a'), ref('b')], [])).toBe(false);
    expect(areCanvasReferencesEqual(undefined, [ref('a')])).toBe(false);
  });

  it('数量一致但内容不同判不等（来源 / 标题 / 文本顺序）', () => {
    expect(areCanvasReferencesEqual([ref('a')], [ref('b')])).toBe(false);
    expect(areCanvasReferencesEqual([ref('a', { title: 'x' })], [ref('a', { title: 'y' })])).toBe(false);
    expect(areCanvasReferencesEqual([ref('a'), ref('b')], [ref('b'), ref('a')])).toBe(false);
    expect(areCanvasReferencesEqual(
      [{ id: 'c', url: '', title: '文本引用', kind: 'text', text: '一只猫' }],
      [{ id: 'c', url: '', title: '文本引用', kind: 'text', text: '一只狗' }],
    )).toBe(false);
  });

  it('kind 归一化：缺省 kind 与 image 等价', () => {
    const current = { id: 'a', url: '/api/files/a.png', title: '参考图', text: '' } as CanvasReference;
    expect(areCanvasReferencesEqual([current], [ref('a')])).toBe(true);
  });
});

describe('hasUsableTextReference（连着文案节点就能空输入发送）', () => {
  const textRef: CanvasReference = { id: 't1', url: '', title: '文本引用', kind: 'text', text: '1: 碳晶板饰面\n2: 台阶' };

  it('有文案引用 → 允许发送', () => {
    expect(hasUsableTextReference([textRef])).toBe(true);
    expect(hasUsableTextReference([ref('img'), textRef])).toBe(true);
  });

  it('只有图片引用 / 空文案 → 仍要求手写提示词', () => {
    expect(hasUsableTextReference([ref('img')])).toBe(false);
    expect(hasUsableTextReference([{ ...textRef, text: '   ' }])).toBe(false);
    expect(hasUsableTextReference([])).toBe(false);
    expect(hasUsableTextReference(undefined)).toBe(false);
  });

  it('老数据里 kind 缺失但有文本、无 url 也算（兼容）', () => {
    const legacy = { id: 't2', url: '', title: '文本引用', text: '吧台区' } as CanvasReference;
    expect(hasUsableTextReference([legacy])).toBe(true);
  });
});

describe('buildReferenceNumberingInstruction（基准图不占图号）', () => {
  it('二次编辑基准图不计入编号，连线参考图从图1开始', () => {
    const text = buildReferenceNumberingInstruction(2, true);
    expect(text).toContain('二次编辑基准图');
    expect(text).toContain('不计入用户描述中的「图1 / 图2」编号');
    expect(text).toContain('从图1开始编号');
  });

  it('普通多图按提供顺序编号', () => {
    expect(buildReferenceNumberingInstruction(3, false)).toContain('图1、图2、图3');
  });

  it('单张普通参考图不额外插入编号说明', () => {
    expect(buildReferenceNumberingInstruction(1, false)).toBe('');
  });
});
