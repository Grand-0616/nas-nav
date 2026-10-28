# NAS 导航监控助手 - 自托管镜像
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用缓存层）。带 lockfile 用 npm ci 保证可重现构建
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 复制后端源码与前端静态资源
COPY server/ ./
COPY public/ ./public/

# 用 scp / rsync 从 Windows 或严格 umask 的环境传上来的目录常是 drwx------，
# COPY 会把这个权限原样带进镜像；进程降权到 node 用户后就读不到静态文件，
# 表现为页面能开但 /js/app.js 返回 EACCES。这里统一放宽为「所有人可读、目录可进入」。
RUN chmod -R a+rX /app/public

# 降权运行需要 su-exec；保留 --group-add 附加组需要完整版 setpriv
# （Alpine 自带的 /usr/bin/setpriv 是 BusyBox 版，不支持 --reuid/--regid/--groups）
RUN apk add --no-cache su-exec util-linux \
 && ln -sf /usr/bin/setpriv /usr/local/bin/setpriv-full

# 数据卷：配置文件持久化（映射到宿主机）
VOLUME ["/app/config"]

ENV NODE_ENV=production
ENV PORT=8080
ENV CONFIG_DIR=/app/config
# NAS 上 https 服务常用自签证书。这里**不再**全局关闭证书校验
# （NODE_TLS_REJECT_UNAUTHORIZED=0 会让访问公网 PT 站时也不验证书），
# 改为在代码里按目标地址判断：只有内网/私有地址才放宽，公网保持严格校验。
# 确实需要全局放宽时，自行加环境变量 ALLOW_INSECURE_TLS=1（不推荐）。

# 非 root 运行：容器逃逸面更小（Docker socket 仍按挂载权限生效）
# 注意：如需读写挂载的 config 目录，宿主机目录需允许 uid 1000 写入（见 README）
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

# 以 root 启动入口脚本再降权，保证挂载目录的属主问题不阻断启动
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
