import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeEventStream } from '../src/lib/eventStream';
import { subscribeCanvasLocate, subscribeCanvasUpdated, subscribeChatRunEvents, subscribePushedImages, subscribePushedVideos } from '../src/lib/bridge';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  close = vi.fn();

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe('实时连接复用与释放', () => {
  it('图片、视频和画布同步共用一条连接，各自只接收对应事件', () => {
    const onImage = vi.fn();
    const onVideo = vi.fn();
    const onUpdate = vi.fn();
    cleanups.push(subscribePushedImages('canvas/a', onImage));
    cleanups.push(subscribePushedVideos('canvas/a', onVideo));
    cleanups.push(subscribeCanvasUpdated('canvas/a', onUpdate));
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/api/events?canvasId=canvas%2Fa');
    source.emit('image', { type: 'image', canvasId: 'canvas/a' });
    source.emit('video', { type: 'video', canvasId: 'canvas/a' });
    source.emit('canvas-updated', { type: 'canvas-updated', canvasId: 'canvas/a', updatedAt: 'now' });
    expect(onImage).toHaveBeenCalledTimes(1);
    expect(onVideo).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    source.emit('image', { type: 'image', canvasId: 'other' });
    source.dispatchEvent(new MessageEvent('image', { data: 'broken json' }));
    expect(onImage).toHaveBeenCalledTimes(1);
  });

  it('取消单个订阅不影响其他订阅，最后一个离开才释放连接，重复清理安全', () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = subscribeEventStream('/shared', [{ type: 'image', handler: first }]);
    const disposeSecond = subscribeEventStream('/shared', [{ type: 'image', handler: second }]);
    cleanups.push(disposeFirst, disposeSecond);
    const source = FakeEventSource.instances[0];
    disposeFirst();
    disposeFirst();
    expect(source.close).not.toHaveBeenCalled();
    source.emit('image', {});
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    disposeSecond();
    expect(source.close).toHaveBeenCalledTimes(1);
    cleanups.push(subscribeEventStream('/shared', [{ type: 'image', handler: first }]));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('反复切画布不会遗留旧连接，跨画布定位仍独立接收', () => {
    const locate = vi.fn();
    const disposeLocate = subscribeCanvasLocate(locate);
    cleanups.push(disposeLocate);
    for (let index = 0; index < 20; index += 1) {
      const disposeImage = subscribePushedImages(`canvas-${index}`, vi.fn());
      const disposeVideo = subscribePushedVideos(`canvas-${index}`, vi.fn());
      disposeImage();
      disposeVideo();
    }
    expect(FakeEventSource.instances.filter((source) => source.close.mock.calls.length === 0)).toHaveLength(1);
    FakeEventSource.instances[0].emit('locate', { type: 'locate', nodeId: 'target', canvasId: 'other' });
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it.each(['message_done', 'error'] as const)('对话收到 %s 后自动释放，不累积长期连接', (type) => {
    const onEvent = vi.fn();
    const cleanup = subscribeChatRunEvents(`run-${type}`, onEvent);
    cleanups.push(cleanup);
    const source = FakeEventSource.instances[0];
    source.emit('message_delta', { type: 'message_delta', text: 'hello' });
    expect(source.close).not.toHaveBeenCalled();
    source.emit(type, { type, status: 'done', message: 'failure' });
    expect(source.close).toHaveBeenCalledTimes(1);
    source.emit('message_delta', { type: 'message_delta', text: 'late' });
    expect(onEvent).toHaveBeenCalledTimes(2);
    cleanup();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('同一轮对话重复订阅只占一条连接，并把终态发给两个订阅者', () => {
    const first = vi.fn();
    const second = vi.fn();
    cleanups.push(subscribeChatRunEvents('same-run', first), subscribeChatRunEvents('same-run', second));
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    source.emit('message_done', { type: 'message_done', status: 'done' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(source.close).toHaveBeenCalledTimes(1);
  });
});
