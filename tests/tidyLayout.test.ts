import { describe, expect, it } from 'vitest';
import { CUT_MIN_REACH, CUT_PAIR_SPACING } from '@/components/canvas/FlowEdge';
import { TIDY_GAP_X, TIDY_GAP_Y, tidyLayout, type TidyEdgeInput, type TidyNodeInput } from '@/lib/tidyLayout';

function node(id: string, x: number, y: number, width = 320, height = 320): TidyNodeInput {
  return { id, x, y, width, height };
}

describe('tidyLayout', () => {
  it('按边分层排成从左到右的列：链 A→B→C 深度递增', () => {
    const nodes = [node('a', 0, 0), node('b', 900, 40), node('c', 1800, 80)];
    const edges: TidyEdgeInput[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const { positions } = tidyLayout(nodes, edges);
    const at = (id: string) => positions.find((item) => item.id === id)!;
    expect(at('a').x).toBe(0);
    // b 的 x = a 的宽 + 列间距
    expect(at('b').x).toBe(320 + TIDY_GAP_X);
    expect(at('c').x).toBe(320 * 2 + TIDY_GAP_X * 2);
    // 同一列的 y 从起点依次往下叠，间距 = 行间距
    expect(at('a').y).toBe(0);
  });

  it('菱形分层：中间层同列、末端汇到下一列', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 200), node('c', 500, 600), node('d', 1000, 400)];
    const edges: TidyEdgeInput[] = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ];
    const { positions } = tidyLayout(nodes, edges);
    const at = (id: string) => positions.find((item) => item.id === id)!;
    expect(at('b').x).toBe(at('c').x);
    expect(at('b').y).toBe(0);
    expect(at('c').y).toBe(320 + TIDY_GAP_Y);
    expect(at('d').x).toBe(320 * 2 + TIDY_GAP_X * 2);
  });

  it('层内按现位置稳定排序：同一列按当前上下位置排，不按连线先后', () => {
    const nodes = [node('upper', 0, 400), node('lower', 300, 0), node('sink', 900, 200)];
    const edges: TidyEdgeInput[] = [
      { source: 'upper', target: 'sink' },
      { source: 'lower', target: 'sink' },
    ];
    // upper / lower 同为第 0 层：按当前 y 排（lower 在上），与 edges 顺序无关
    const { positions } = tidyLayout(nodes, edges);
    const at = (id: string) => positions.find((item) => item.id === id)!;
    expect(at('lower').y).toBe(0);
    expect(at('upper').y).toBe(320 + TIDY_GAP_Y);
    expect(at('sink').y).toBe(0);
  });

  it('孤岛节点也纳入整理：排在主流块下方的搁板上', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 0), node('island', 1234, 567)];
    const edges: TidyEdgeInput[] = [{ source: 'a', target: 'b' }];
    const result = tidyLayout(nodes, edges);
    expect(result.positions.map((item) => item.id).sort()).toEqual(['a', 'b', 'island']);
    const at = (id: string) => result.positions.find((item) => item.id === id)!;
    // 搁板贴在主流块底边下一行行距，左缘与主流对齐
    expect(at('island').y).toBe(320 + TIDY_GAP_Y);
    expect(at('island').x).toBe(0);
    expect(result.movedIds).toContain('island');
  });

  it('没有边时也整理：孤岛们铺成搁板，不再整体不动', () => {
    const nodes = [node('a', 10, 10), node('b', 20, 20), node('c', 30, 30)];
    const result = tidyLayout(nodes, []);
    expect(result.positions).toHaveLength(3);
    // 锚点沿用现布局左上角
    const at = (id: string) => result.positions.find((item) => item.id === id)!;
    expect(at('a')).toEqual({ id: 'a', x: 10, y: 10 });
    // 行内密铺间距 = 行间距；折行目标按 √n 列宽估
    expect(at('b').x).toBe(10 + 320 + TIDY_GAP_Y);
    expect(at('b').y).toBe(10);
  });

  it('孤岛搁板按主流宽度折行：主流多宽，搁板一行就排多宽', () => {
    // 主流两列，块宽 = 320×2 + 列间距；三个孤岛（320 宽、48 密铺）第二行放第三个
    const nodes = [
      node('a', 0, 0),
      node('b', 320 + TIDY_GAP_X, 0),
      node('i1', 900, 900),
      node('i2', 950, 950),
      node('i3', 1000, 1000),
    ];
    const edges: TidyEdgeInput[] = [{ source: 'a', target: 'b' }];
    const { positions } = tidyLayout(nodes, edges);
    const at = (id: string) => positions.find((item) => item.id === id)!;
    const shelfY = 320 + TIDY_GAP_Y;
    expect(at('i1').y).toBe(shelfY);
    expect(at('i2').y).toBe(shelfY);
    expect(at('i3').y).toBe(shelfY + 320 + TIDY_GAP_Y);
    expect(at('i3').x).toBe(0);
  });

  it('整理结果避开画布功能条：压住左侧 rail 时整块右移让开', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 0)];
    const edges: TidyEdgeInput[] = [{ source: 'a', target: 'b' }];
    // 左侧竖条禁入区（rail 的画布坐标近似）
    const rail = { x: -200, y: -300, width: 260, height: 1200 };
    const { positions, movedIds } = tidyLayout(nodes, edges, { avoid: [rail] });
    const at = (id: string) => positions.find((item) => item.id === id)!;
    // 右移量 = rail 右缘 + 呼吸距 - 块左缘 = -200 + 260 + 24 = 84（比下移 924 小，取右移）
    expect(at('a').x).toBe(84);
    expect(at('b').x).toBe(84 + 320 + TIDY_GAP_X);
    // 本来没动的 a 被平移带走，也要进撤回栈
    expect(movedIds).toContain('a');
    expect(movedIds).toContain('b');
  });

  it('多块禁入区取整体最小位移：一步让开，不把两次让位叠成巨幅下移', () => {
    // 三个孤岛铺成 2×2 搁板（块 x [0,248]、y [0,248]）；rail / dock 横在块中央，左侧再横一块
    // 挡住向上逃逸。贪心会先下移让 rail（144）、再下移让 dock（50）、再右移让左墙（124），
    // 叠成 (124,194) 的斜跳；最小位移搜索应一步右移 174 同时让开三块。
    const nodes = [node('a', 0, 0, 100, 100), node('b', 0, 200, 100, 100), node('c', 0, 400, 100, 100)];
    const avoid = [
      { x: -100, y: 100, width: 250, height: 20 },
      { x: -100, y: 150, width: 250, height: 20 },
      { x: -1000, y: -100, width: 1100, height: 1000 },
    ];
    const { positions, movedIds } = tidyLayout(nodes, [], { avoid });
    const at = (id: string) => positions.find((item) => item.id === id)!;
    expect(at('a')).toEqual({ id: 'a', x: 174, y: 0 });
    expect(at('b')).toEqual({ id: 'b', x: 322, y: 0 });
    expect(at('c')).toEqual({ id: 'c', x: 174, y: 148 });
    expect(movedIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('不与功能条相交时原位不动', () => {
    // 本来就整齐：b 正好落在 tidy 该在的位置，禁入区也在左侧不沾边
    const nodes = [node('a', 600, 0), node('b', 600 + 320 + TIDY_GAP_X, 0)];
    const edges: TidyEdgeInput[] = [{ source: 'a', target: 'b' }];
    const rail = { x: -200, y: -300, width: 500, height: 1200 };
    const { positions, movedIds } = tidyLayout(nodes, edges, { avoid: [rail] });
    const at = (id: string) => positions.find((item) => item.id === id)!;
    expect(at('a').x).toBe(600);
    expect(movedIds).toEqual([]);
  });

  it('环不会死循环，且每个节点都有位置', () => {
    const nodes = [node('a', 0, 0), node('b', 800, 0), node('c', 400, 500)];
    const edges: TidyEdgeInput[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
      { source: 'a', target: 'c' },
    ];
    const { positions } = tidyLayout(nodes, edges);
    expect(positions).toHaveLength(3);
  });

  it('位置已整齐时 movedIds 为空', () => {
    const nodes = [node('a', 0, 0), node('b', 320 + TIDY_GAP_X, 0)];
    const edges: TidyEdgeInput[] = [{ source: 'a', target: 'b' }];
    expect(tidyLayout(nodes, edges).movedIds).toEqual([]);
  });

  it('列间距容得下两端的断开剪刀', () => {
    // 端剪刀落在卡片边框外 CUT_MIN_REACH，两块互不相撞还要 CUT_PAIR_SPACING。
    // 列间距小于这个数，整理完每条边都挤在把手圈里、剪刀直接不渲染——断开功能就被整理没了。
    expect(TIDY_GAP_X).toBeGreaterThanOrEqual(CUT_MIN_REACH * 2 + CUT_PAIR_SPACING);
  });

  it('自定义间距生效', () => {
    const nodes = [node('a', 0, 0), node('b', 100, 0)];
    const edges: TidyEdgeInput[] = [{ source: 'a', target: 'b' }];
    const { positions } = tidyLayout(nodes, edges, { gapX: 20, gapY: 10 });
    const at = (id: string) => positions.find((item) => item.id === id)!;
    expect(at('b').x).toBe(340);
  });
});
