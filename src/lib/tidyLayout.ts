/**
 * 画布局「整理」：按边的拓扑分层做「列 × 行」网格布局。
 *
 * 语义（对齐 dock 整理按钮）：顺着边的方向（参考图 → 生成节点 → 结果图）一层一列排开，
 * 层内按节点当前上下位置稳定排序——整理只是「把队伍排齐」，不改变谁在上谁在下。
 * 孤岛节点也一起整理：没有边的零散参考图铺在主流块下方当「搁板」，行内密铺、折行宽度贴着
 * 主流块——只摆了图没连线的画布靠这个也能一键收拢（此前孤岛完全不动，用户实测漏整理）。
 * 屏幕固定的功能条（左侧 rail / 左下角 dock）换算到画布坐标后是禁入区：布局算完若压住
 * 它们，整块平移到最近的不相交位置，别让卡片遮住图标（用户实测「图片遮住图标」）。
 * 容错：图里有环也收敛（松弛迭代轮次封顶），不会死循环。 */

/** 列间距 / 行间距（画布坐标 px）。
 *  列间距必须容得下「两端的断开剪刀」：端剪刀落在卡片边框外 96px，两块互不相撞还要再留
 *  30px，所以相邻两列至少差 2×CUT_MIN_REACH + 30 = 176px。取 176——再窄（比如 96）
 *  的话，整理完每条边都挤在把手圈里，剪刀直接不渲染，等于把断开功能整理没了。
 *  行间距只要求卡片不叠：48px 够竖向错开后曲线中段离把手圈更远。 */
export const TIDY_GAP_X = 176;
export const TIDY_GAP_Y = 48;

/** 禁入矩形外再留的呼吸距离（画布坐标 px）：平移后卡片不贴着脸叠在功能条边上。 */
const TIDY_AVOID_PADDING = 24;

export interface TidyNodeInput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TidyEdgeInput {
  source: string;
  target: string;
}

export interface TidyPosition {
  id: string;
  x: number;
  y: number;
}

/** 画布坐标系禁入矩形：屏幕固定的功能条 / dock 由调用方换算后传入。 */
export interface TidyAvoidRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TidyResult {
  /** 有新位置的节点（含没动但仍在流内的节点——调用方拿去统一落库更简单）。 */
  positions: TidyPosition[];
  /** 位置真的变了的节点 id：上层靠它判断「无需整理」和 toast 文案。 */
  movedIds: string[];
}

export interface TidyOptions {
  gapX?: number;
  gapY?: number;
  /** 画布坐标系禁入矩形，整理结果不许压住（左侧 rail / 左下角 dock 等屏幕固定 UI） */
  avoid?: TidyAvoidRect[];
}

/** 兜底盒子：宽高缺失时按标准生成卡片估算，别让 NaN 把布局搅成原点一坨。 */
function boxOf(node: TidyNodeInput): { width: number; height: number } {
  const width = Number(node.width);
  const height = Number(node.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 320,
    height: Number.isFinite(height) && height > 0 ? height : 320,
  };
}

/** 一组带盒子位置的节点的包围盒。 */
function bboxOf(boxes: Array<{ x: number; y: number; width: number; height: number }>): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
}

/** AABB 相交判定：两边在任一轴上不相交就算错开。 */
function overlaps(
  box: { x: number; y: number; width: number; height: number },
  rect: TidyAvoidRect,
): boolean {
  return box.x < rect.x + rect.width
    && rect.x < box.x + box.width
    && box.y < rect.y + rect.height
    && rect.y < box.y + box.height;
}

export function tidyLayout(
  nodes: TidyNodeInput[],
  edges: TidyEdgeInput[],
  options: TidyOptions = {},
): TidyResult {
  const gapX = Number.isFinite(options.gapX) && (options.gapX as number) > 0 ? (options.gapX as number) : TIDY_GAP_X;
  const gapY = Number.isFinite(options.gapY) && (options.gapY as number) > 0 ? (options.gapY as number) : TIDY_GAP_Y;
  const avoid = (Array.isArray(options.avoid) ? options.avoid : []).filter(
    (rect) => Number.isFinite(rect?.x) && Number.isFinite(rect?.y)
      && Number.isFinite(rect?.width) && Number.isFinite(rect?.height)
      && (rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0,
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (nodes.length === 0) return { positions: [], movedIds: [] };

  // 连通子集：有一条边把两端都接上，才算「在流里」
  const touching = new Set<string>();
  for (const edge of edges) {
    if (byId.has(String(edge.source)) && byId.has(String(edge.target))) {
      touching.add(String(edge.source));
      touching.add(String(edge.target));
    }
  }
  const flow = nodes.filter((node) => touching.has(node.id));
  // 孤岛（一条边都没有）也纳入整理：铺在主流块下方当搁板
  const islands = nodes.filter((node) => !touching.has(node.id));
  const flowIds = new Set(flow.map((node) => node.id));

  // 深度 = 从任意起点出发的最长路径长度。DAG 上迭代即收敛；有环时轮次封顶在节点数，
  // 之后值不再疯长（环上互相 +1 被 max 摊平），排出来的仍是合理的分层。
  const depth = new Map<string, number>(flow.map((node) => [node.id, 0]));
  const linked = edges.filter((edge) => flowIds.has(String(edge.source)) && flowIds.has(String(edge.target)));
  for (let round = 0; round < flow.length; round += 1) {
    let changed = false;
    for (const edge of linked) {
      const from = depth.get(String(edge.source));
      const to = depth.get(String(edge.target));
      if (from === undefined || to === undefined) continue;
      if (to < from + 1) {
        depth.set(String(edge.target), from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 分列：层内按「现上下位置 → 现左右位置」稳定排序，谁在上谁在下整理后不变
  const columns = new Map<number, TidyNodeInput[]>();
  for (const node of flow) {
    const level = depth.get(node.id) || 0;
    const bucket = columns.get(level);
    if (bucket) bucket.push(node);
    else columns.set(level, [node]);
  }
  const levels = [...columns.keys()].sort((left, right) => left - right);
  for (const bucket of columns.values()) {
    bucket.sort((left, right) => (left.y - right.y) || (left.x - right.x));
  }

  // 起点沿用现布局的左上角（含孤岛）：整理是「原地排齐」，不是整张画布搬家
  const startX = Math.min(...nodes.map((node) => node.x));
  const startY = Math.min(...nodes.map((node) => node.y));

  const positions: TidyPosition[] = [];
  let cursorX = startX;
  let flowBottom = startY;
  for (const level of levels) {
    const bucket = columns.get(level) || [];
    let cursorY = startY;
    let columnWidth = 0;
    for (const node of bucket) {
      const box = boxOf(node);
      const x = Math.round(cursorX);
      const y = Math.round(cursorY);
      positions.push({ id: node.id, x, y });
      cursorY += box.height + gapY;
      columnWidth = Math.max(columnWidth, box.width);
      flowBottom = Math.max(flowBottom, y + box.height);
    }
    cursorX += columnWidth + gapX;
  }
  // 最后一列的右缘（没有流时等于起点，主流宽度按 0 算）
  const flowRight = cursorX - gapX;

  if (islands.length > 0) {
    const shelf = [...islands].sort((left, right) => (left.y - right.y) || (left.x - right.x));
    const widest = Math.max(...shelf.map((node) => boxOf(node).width));
    // 折行目标宽度：贴着主流块的宽度；纯孤岛画布按 √n 列估一个近似方格的宽度
    const columnsGuess = Math.max(1, Math.ceil(Math.sqrt(shelf.length)));
    const targetWidth = flow.length > 0
      ? Math.max(flowRight - startX, widest)
      : columnsGuess * widest + (columnsGuess - 1) * gapY;
    let shelfY = flow.length > 0 ? flowBottom + gapY : startY;
    let shelfX = startX;
    let rowHeight = 0;
    for (const node of shelf) {
      const box = boxOf(node);
      // 放不下就换行；行首例外——孤岛比整行目标还宽时允许它独占一行
      if (shelfX > startX && shelfX + box.width > startX + targetWidth) {
        shelfX = startX;
        shelfY += rowHeight + gapY;
        rowHeight = 0;
      }
      positions.push({ id: node.id, x: Math.round(shelfX), y: Math.round(shelfY) });
      // 孤岛之间没有「两列要对边」的硬需求，横向按行间距密铺就够不叠卡片
      shelfX += box.width + gapY;
      rowHeight = Math.max(rowHeight, box.height);
    }
  }

  // 避让：整块平移让开禁入矩形（rail / dock）。
  // 不逐块贪心——先让 rail 再让 dock 会把两次位移叠成一个巨幅下移，内容直接飞出视野。
  // 改成在「0 + 各矩形四向逃逸距离」的候选里搜一个同时避开所有矩形的最小位移（曼哈顿代价），
  // 搜不到（极端重叠）才退回逐块贪心保底，图标不许被压住。
  if (avoid.length > 0) {
    const boxes = positions.map((item) => {
      const box = boxOf(byId.get(item.id) as TidyNodeInput);
      return { x: item.x, y: item.y, width: box.width, height: box.height };
    });
    const block = bboxOf(boxes);
    const dxCandidates = new Set<number>([0]);
    const dyCandidates = new Set<number>([0]);
    for (const rect of avoid) {
      dxCandidates.add(rect.x + rect.width + TIDY_AVOID_PADDING - block.x);
      dxCandidates.add(rect.x - TIDY_AVOID_PADDING - (block.x + block.width));
      dyCandidates.add(rect.y + rect.height + TIDY_AVOID_PADDING - block.y);
      dyCandidates.add(rect.y - TIDY_AVOID_PADDING - (block.y + block.height));
    }
    let best = { dx: 0, dy: 0, cost: Number.POSITIVE_INFINITY };
    for (const dx of dxCandidates) {
      for (const dy of dyCandidates) {
        const shifted = { x: block.x + dx, y: block.y + dy, width: block.width, height: block.height };
        if (!avoid.every((rect) => !overlaps(shifted, rect))) continue;
        const cost = Math.abs(dx) + Math.abs(dy);
        if (cost < best.cost) best = { dx, dy, cost };
      }
    }
    if (!Number.isFinite(best.cost)) {
      // 兜底：逐块贪心（可能叠加位移，但保证每块都被让开）
      for (const rect of avoid) {
        const box = bboxOf(boxes);
        if (!overlaps(box, rect)) continue;
        const dx = rect.x + rect.width + TIDY_AVOID_PADDING - box.x;
        const dy = rect.y + rect.height + TIDY_AVOID_PADDING - box.y;
        const shiftX = Math.abs(dx) <= Math.abs(dy);
        for (const item of boxes) {
          if (shiftX) item.x += dx;
          else item.y += dy;
        }
      }
    } else if (best.cost > 0) {
      for (const item of boxes) {
        item.x += best.dx;
        item.y += best.dy;
      }
    }
    positions.forEach((item, index) => {
      item.x = Math.round(boxes[index].x);
      item.y = Math.round(boxes[index].y);
    });
  }

  // movedIds 放最后算：避让平移可能把「本来没动」的节点也带走，那些节点同样要进撤回栈
  const movedIds = positions
    .filter((item) => {
      const original = byId.get(item.id);
      if (!original) return false;
      return Math.abs(item.x - original.x) > 0.5 || Math.abs(item.y - original.y) > 0.5;
    })
    .map((item) => item.id);

  return { positions, movedIds };
}
