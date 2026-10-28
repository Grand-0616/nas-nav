#!/bin/sh
set -e

# 容器入口：修正挂载目录属主后降权到 node 用户运行。
# 这样即使宿主机 ./config 目录是 root 创建的，也不会因为权限问题启动失败。
CONF_DIR="${CONFIG_DIR:-/app/config}"

if [ "$(id -u)" != "0" ]; then
  # 已经是非 root（如 docker run --user 指定），直接启动
  exec "$@"
fi

mkdir -p "$CONF_DIR"
# 只改这个目录，不动别处；失败（如只读挂载）不阻断启动
chown -R node:node "$CONF_DIR" 2>/dev/null || true

# 保留 --group-add 传入的附加组（典型用途：宿主机 docker 组，用于读写 docker.sock）。
# su-exec 会清空附加组，因此这里用 setpriv 做：
#   --regid / --reuid 指定主身份，--groups 保留需要的附加组。
# Alpine 自带的 setpriv 是 BusyBox 版，不支持这些选项；
# 镜像构建时已安装 util-linux 提供的完整 setpriv（见 Dockerfile）。
EXTRAS=$(awk '/^Groups:/{ $1=""; print }' /proc/self/status 2>/dev/null \
  | tr -s ' \t' '\n' | grep -v '^$' | grep -vx '0' | paste -sd, - )

if command -v setpriv >/dev/null 2>&1 && setpriv --help 2>&1 | grep -q -- '--reuid'; then
  # --init-groups 与 --groups 互斥，只能二选一
  if [ -n "$EXTRAS" ]; then
    exec setpriv --reuid=node --regid=node --groups "$EXTRAS" "$@"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec node "$@"
fi

exec "$@"
