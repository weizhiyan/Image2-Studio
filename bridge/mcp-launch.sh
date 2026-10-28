#!/bin/sh
# WorkBuddy 启动 stdio MCP 时使用的是精简 PATH，且可能注入旧版 Node 不支持的
# NODE_OPTIONS。这里显式解析一个可用的 Node，避免子进程启动即退出。
set -u
unset NODE_OPTIONS

find_node() {
  if [ -n "${HUIBAN_NODE:-}" ] && [ -x "${HUIBAN_NODE}" ]; then
    printf '%s\n' "${HUIBAN_NODE}"
    return 0
  fi

  for candidate in "${HOME}"/.workbuddy/binaries/node/versions/*/bin/node; do
    if [ -x "${candidate}" ]; then
      workbuddy_node="${candidate}"
    fi
  done
  if [ -n "${workbuddy_node:-}" ]; then
    printf '%s\n' "${workbuddy_node}"
    return 0
  fi

  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
    printf '%s\n' "${candidate}"
    return 0
  fi

  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "${HOME}/.local/node/bin/node" /usr/bin/node; do
    if [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

node_bin="$(find_node)" || {
  echo "[huiban] 未找到可用的 Node，请用 HUIBAN_NODE 指定 node 的绝对路径" >&2
  exit 127
}

exec "${node_bin}" "$@"
