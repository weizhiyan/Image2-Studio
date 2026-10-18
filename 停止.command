#!/bin/zsh
# ════════════════════════════════════════════════════════════════
# 绘板停止：关掉占用 3788 / 5199 端口的进程
# ════════════════════════════════════════════════════════════════
cd "$(dirname "$0")" || exit 1
for PORT in 3788 5199; do
  PIDS=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "停止端口 $PORT 上的进程：$PIDS"
    kill $PIDS 2>/dev/null
  fi
done
sleep 1
echo "已停止。数据不受影响（localStorage + bridge 存档双份保存）。"
