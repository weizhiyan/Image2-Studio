import { describe, expect, it } from 'vitest';
import { nextRunEventCursor } from '@/lib/chatRunEvents';

describe('run 事件序号去重', () => {
  it('同一 run 的旧序号被跳过', () => {
    const cursor = { runId: 'run-1', seq: 5 };
    expect(nextRunEventCursor(cursor, 'run-1', { type: 'message_delta', text: 'x', seq: 4 })).toBeNull();
    expect(nextRunEventCursor(cursor, 'run-1', { type: 'message_delta', text: 'x', seq: 5 })).toBeNull();
  });

  it('新序号推进游标', () => {
    const cursor = { runId: 'run-1', seq: 5 };
    expect(nextRunEventCursor(cursor, 'run-1', { type: 'message_delta', text: 'x', seq: 6 }))
      .toEqual({ runId: 'run-1', seq: 6 });
  });

  it('换 run 后序号重新计算', () => {
    const cursor = { runId: 'run-1', seq: 9 };
    expect(nextRunEventCursor(cursor, 'run-2', { type: 'message_delta', text: 'x', seq: 1 }))
      .toEqual({ runId: 'run-2', seq: 1 });
  });

  it('没有 seq 的事件照常应用，不推进游标', () => {
    const cursor = { runId: 'run-1', seq: 5 };
    expect(nextRunEventCursor(cursor, 'run-1', { type: 'error', message: 'x' })).toEqual(cursor);
  });
});
