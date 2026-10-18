#!/bin/zsh
# ════════════════════════════════════════════════════════════════
# 绘板一键启动（双击即用）
#   已在运行 → 直接打开浏览器；否则构建并启动（生产模式单进程，端口 3788）
#   停止请双击「停止.command」
# ════════════════════════════════════════════════════════════════
cd "$(dirname "$0")" || exit 1
LOG_DIR="logs"
mkdir -p "$LOG_DIR"

is_up() { lsof -nP -iTCP:$1 -sTCP:LISTEN >/dev/null 2>&1; }

# 1. 依赖（首次启动自动安装）
if [ ! -d "node_modules" ]; then
  echo "首次启动，正在安装依赖（约 1 分钟）…"
  npm install || { echo "依赖安装失败，请检查网络后重试"; exit 1; }
fi

# 2. 已在跑就直接打开，不重复起进程
if is_up 5199 && is_up 3788; then
  echo "检测到开发模式已在运行，直接打开。"
  open "http://127.0.0.1:5199"
  exit 0
fi
if is_up 3788; then
  echo "检测到绘板已在运行，直接打开。"
  open "http://127.0.0.1:3788"
  exit 0
fi

# 3. 构建（前端 + bridge）
echo "正在构建…"
npm run build || { echo "构建失败，请把上方报错发给 Codex"; exit 1; }

# 4. 后台启动（日志落在 logs/huiban.log）
echo "正在启动绘板（端口 3788）…"
nohup npm start > "$LOG_DIR/huiban.log" 2>&1 &
echo $! > "$LOG_DIR/huiban.pid"

# 5. 等待就绪后打开浏览器
for i in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:3788/api/canvases"; then break; fi
  sleep 1
done
if is_up 3788; then
  open "http://127.0.0.1:3788"
  echo "已打开浏览器。日志：$LOG_DIR/huiban.log（停止请双击「停止.command」）"
else
  echo "启动似乎失败了，请查看 $LOG_DIR/huiban.log"
fi
