let seq = 0;

/** 画布内节点 id：可读 + 时间序 + 同毫秒不撞。 */
export function createId(prefix: string): string {
  seq = (seq + 1) % 1000;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}${Math.round(Math.random() * 1296).toString(36)}`;
}
