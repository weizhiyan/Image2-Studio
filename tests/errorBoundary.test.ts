import { describe, expect, it } from 'vitest';
import ErrorBoundary from '@/components/ErrorBoundary';

describe('ErrorBoundary', () => {
  const error = new Error('测试崩溃');

  it('getDerivedStateFromError 把错误收进 state', () => {
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });

  it('无错误时原样渲染 children', () => {
    const instance = new ErrorBoundary({ children: '画布内容' });
    expect(instance.render()).toBe('画布内容');
  });

  it('有错误时渲染兜底报错页，并带上真实错误信息', () => {
    const instance = new ErrorBoundary({ children: '画布内容' });
    instance.state = { error };
    const tree = instance.render() as { props: { className: string; children: unknown } };
    expect(tree.props.className).toBe('hb-error-screen');
    expect(JSON.stringify(tree.props.children)).toContain('测试崩溃');
    expect(JSON.stringify(tree.props.children)).toContain('页面出错了');
  });
});
