#!/bin/zsh
# 绘板一键启动（单例语义）：
#   启动前把当前已在跑的实例全部终止（vite 5199 / bridge 3788 / stdin 保活），只保留最新起的这一份
# 用法：
#   hb-start.sh            重启：全杀 → 全起（默认）
#   hb-start.sh stop       只杀不起
#   hb-start.sh status     查看健康状态
#   hb-start.sh --build    重启前先 npm run build（改了 bridge 代码、dist 落后时才用）
set -u
PROJ="$(cd "$(dirname "$0")" && pwd)"
LOG="$PROJ/logs"
BRIDGE_PORT=3788
VITE_PORT=5199
mkdir -p "$LOG"

pids_on_port() { lsof -nP -tiTCP:$1 -sTCP:LISTEN 2>/dev/null; }

stop_one() {
  local port=$1 name=$2 pids i
  pids=$(pids_on_port $port)
  if [[ -n "$pids" ]]; then
    print -r -- "→ 终止旧 $name（:$port）pid: $(print -r -- $pids | tr '\n' ' ')"
    print -r -- $pids | xargs kill 2>/dev/null
    for i in {1..15}; do
      [[ -z "$(pids_on_port $port)" ]] && break
      sleep 0.3
    done
    pids=$(pids_on_port $port)
    [[ -n "$pids" ]] && print -r -- $pids | xargs kill -9 2>/dev/null
    sleep 0.3
  fi
}

stop_all() {
  stop_one $VITE_PORT vite
  stop_one $BRIDGE_PORT bridge
  # vite 可能残留 esbuild 子进程（cmdline 带项目绝对路径，只会命中绘板自己）
  pkill -f "$PROJ/node_modules/.bin/vite" 2>/dev/null
  # bridge 的 stdin 保活 python（持有管道写端，防 MCP stdio 因 stdin EOF 退出）
  local holder
  holder=$(cat /tmp/huiban-bridge-holder.pid 2>/dev/null)
  [[ -n "$holder" ]] && kill $holder 2>/dev/null
  rm -f /tmp/huiban-bridge-holder.pid /tmp/huiban-bridge.pid /tmp/huiban-vite.pid
  return 0
}

start_bridge() {
  nohup python3 - "$PROJ" >>"$LOG/hb-start.log" 2>&1 <<'PY' &
import os, signal, subprocess, sys
proj = sys.argv[1]
os.chdir(proj)
r, w = os.pipe()
log = open(os.path.join(proj, 'logs', 'huiban.log'), 'ab')
bridge = subprocess.Popen(['node', 'bridge/dist/index.js'],
                          stdin=r, stdout=log, stderr=subprocess.STDOUT,
                          start_new_session=True)
os.close(r); log.close()
open('/tmp/huiban-bridge.pid', 'w').write(str(bridge.pid))
open('/tmp/huiban-bridge-holder.pid', 'w').write(str(os.getpid()))
print('bridge pid', bridge.pid, flush=True)
with open(w, 'wb', 0):
    signal.pause()
PY
  wait_http "http://127.0.0.1:$BRIDGE_PORT/api/health" bridge 15
}

start_vite() {
  # 与 bridge 同一套 detach：start_new_session，避免被启动方（终端 / 脚本 / 提权命令）的收尸带走
  python3 - "$PROJ" >>"$LOG/hb-start.log" 2>&1 <<'PY'
import os, subprocess, sys
proj = sys.argv[1]
bin = os.path.join(proj, 'node_modules', '.bin', 'vite')
cmd = [bin] if os.access(bin, os.X_OK) else ['npx', 'vite']
log = open(os.path.join(proj, 'logs', 'vite-5199.log'), 'ab')
vite = subprocess.Popen(cmd, cwd=proj, stdin=subprocess.DEVNULL,
                        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
log.close()
open('/tmp/huiban-vite.pid', 'w').write(str(vite.pid))
print('vite pid', vite.pid, flush=True)
PY
  if ! wait_http "http://127.0.0.1:$VITE_PORT/" vite 30; then
    return 1
  fi
  local pid
  pid=$(cat /tmp/huiban-vite.pid 2>/dev/null)
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    print "✗ vite 启动进程已退出，可能是端口 $VITE_PORT 被其他程序占用"
    return 1
  fi
}

wait_http() {
  local url=$1 name=$2 timeout=$3 i
  for i in $(seq 1 $((timeout * 4))); do
    if curl -fs -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      print "✓ $name 就绪：$url"
      return 0
    fi
    sleep 0.25
  done
  print "✗ $name 启动超时：$url（日志在 $LOG）"
  return 1
}

status_all() {
  local ok=0
  curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$VITE_PORT/" 2>/dev/null \
    && print "✓ vite    http://127.0.0.1:$VITE_PORT/" || { print "✗ vite    http://127.0.0.1:$VITE_PORT/"; ok=1; }
  curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$BRIDGE_PORT/api/health" 2>/dev/null \
    && print "✓ bridge  http://127.0.0.1:$BRIDGE_PORT/api/health" || { print "✗ bridge  http://127.0.0.1:$BRIDGE_PORT/api/health"; ok=1; }
  return $ok
}

build=0
for a in "$@"; do
  case "$a" in
    stop) stop_all; print "已全部停止"; exit 0 ;;
    status) status_all; exit $? ;;
    --build) build=1 ;;
    *) print "未知参数：$a（可用：stop / status / --build）"; exit 2 ;;
  esac
done

if [[ $build -eq 1 ]]; then
  print "→ npm run build（tsc + vite build + bridge tsc）"
  if ! ( cd "$PROJ" && npm run build ) >>"$LOG/hb-start.log" 2>&1; then
    print "✗ build 失败，已中止启动（详见 $LOG/hb-start.log）"
    exit 1
  fi
  print "✓ build 完成"
fi

print "→ 清理存量实例（单例：只留最新这一份）"
stop_all
print "→ 启动 bridge（3788）与 vite（5199）"
if ! start_bridge; then
  print "✗ 后台未就绪，因此没有启动前端。请先查看后台日志后重试。"
  print "日志：$LOG/huiban.log / $LOG/hb-start.log"
  exit 1
fi
if ! start_vite; then
  print "✗ 前端启动失败。请查看日志：$LOG/vite-5199.log"
  exit 1
fi
print ""
print "绘板已启动：浏览器打开 http://127.0.0.1:5199/"
