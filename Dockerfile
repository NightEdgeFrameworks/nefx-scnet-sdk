# SCNet 只读接口 —— 容器镜像
#
# 为什么用容器（以及为什么不完全用）：见 README「容器」一节。一句话：容器在这里买到的是
# **常驻**（Docker 自带的 restart 策略就是现成的服务管家）和**整箱搬走**，
# 不是依赖隔离——这个项目是零依赖的，没什么可隔离的。
#
# 构建：
#   docker build -t nefx-scnet-sdk:0.1 .
# 运行（**注意 -p 必须绑宿主回环**，理由见 src/serve.ts 顶部第 1 条）：
#   docker network create scnet-net          # 自己一个网络：别的容器就连不到它
#   docker volume create scnet-state         # 存 token 缓存与 watch 采样点（跨重建存活）
#   docker run -d --name scnet-api --restart unless-stopped \
#     --network scnet-net \
#     -p 127.0.0.1:8787:8787 \
#     -v scnet-state:/var/lib/scnet \
#     -v "%USERPROFILE%\.nefx\scnet:/root/.nefx/scnet:ro" \
#     -v "<你的算例目录>:/cases:ro" \
#     nefx-scnet-sdk:0.1
#
# 凭证**不进镜像**：只读挂载到容器里的 ~/.nefx/scnet（auth.ts 默认就找这个路径）。
# 绝不用 `-e SCNET_ACCESS_KEY=...`——那会把凭证写进 `docker inspect`。

# Node 24 起原生支持类型剥离，所以这个项目没有构建步骤，直接把源码拷进去就能跑。
FROM node:24-alpine

# 可写状态目录改成容器自己的 /var/lib/scnet。
# 为什么必须：凭据目录是**只读**挂载，而 token 缓存和 watch 采样点默认都想写在那儿。
# 2026-09-14 实测：不设这一项，容器里第一次调接口就报
#   EROFS: read-only file system, open '/root/.nefx/scnet/token-cache.json'
# ——一个纯粹用来省一次认证的缓存，把整个接口调用打死了（现在那条路也修成了不致命）。
# 配 run 时的命名卷 `-v scnet-state:/var/lib/scnet`，watch 的基准点才能跨容器重建存活：
# 它正是"两次采样算速率/ETA"的依据，丢了就得重新攒一个基准。
ENV SCNET_STATE_DIR=/var/lib/scnet

# 零依赖，所以不 npm install、不留 node_modules。--omit=dev 也无所谓，压根没有。
WORKDIR /app

# 只拷运行时真正用得到的东西（见 .dockerignore：test/、runs/ 都不进来）
COPY package.json ./
COPY src/ ./src/
COPY templates/ ./templates/
COPY examples/ ./examples/
COPY README.md ./

# 容器内必须绑 0.0.0.0，否则 -p 发布不到（Docker 代理的是容器 IP，不是容器 loopback）。
# 这一步的安全性由**发布侧**保证：`-p 127.0.0.1:8787:8787`。
CMD ["node", "src/cli.ts", "serve", "--host", "0.0.0.0", "--port", "8787"]

# 健康检查只看"进程还答得上话"，**不代表凭证有效、平台可达**。
# 真正的可用性判据是 `GET /op/probe`（它会真去认证一次）。
HEALTHCHECK --interval=60s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
