#!/usr/bin/env node
/**
 * `scnet serve` —— 把 core.ts 的只读操作暴露成**本机** HTTP 接口。
 *
 * 定位：给"不是" agent 也不方便起 node 进程的程序用的（脚本、看板、别的语言的工具）。
 * 想让我在会话里直接调，用 `scnet mcp`（同一批操作，见 mcp.ts）。
 *
 * ── 三条安全决定，改之前先想清楚 ──────────────────────────────────────────────
 * 1. **默认只绑回环地址。** 非 127.0.0.1 / ::1 / localhost 一律拒绝，**唯一的例外是显式传
 *    `--host 0.0.0.0`**，而且会打印一条醒目的警告。这个例外的存在理由是容器：
 *    Docker 的端口发布是把流量代理到**容器的 IP**，不是容器的 loopback——
 *    容器里如果还绑 127.0.0.1，`-p` 发布出去也连不上。所以容器内必须绑 0.0.0.0，
 *    而"只对本机开放"这件事改由**发布侧**保证：`-p 127.0.0.1:8787:8787`。
 *    **这两件事必须成对出现**，只做一半就是把能力放到局域网上：
 *      - 容器内绑 0.0.0.0 + 发布 127.0.0.1  → 只有本机能连（正确）
 *      - 容器内绑 0.0.0.0 + 发布 0.0.0.0    → 全网能连（错，等于把 token 送出去）
 *      - 宿主上直接 `--host 0.0.0.0`        → 局域网能连（错，除非你确实要这样）
 *    另一条推论：容器内绑 0.0.0.0 意味着**同一个 docker 网络里的其他容器也能连**，
 *    所以 run 的时候要给它自己一个网络（见 Dockerfile 里的说明），不要和别的容器共网。
 * 2. **只读。** 这里不暴露上传 / 提交 / 取消。写操作是不可逆的（取消一个算了几天的
 *    作业），不该由一个没有认证的端口来提供。要做也得先有 token + 明确授权。
 * 3. **不套 `redact()`。** 因为 `redact()` 会把超过 10 项的数组截断，套在出口上会把
 *    `list_jobs` 直接弄坏。脱敏靠 core.ts 里每个操作**自己挑字段**（不许把平台原始
 *    返回丢出去），这条写在 core.ts 顶部。
 *
 * 用法：
 *   node src/cli.ts serve [--port 8787] [--host 127.0.0.1]
 *   curl 'http://127.0.0.1:8787/ops'
 *   curl 'http://127.0.0.1:8787/op/watch?id=67307378&steps=10000'
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { OPERATIONS, OPS_SCHEMA, coerceArgs, opByName, opError } from './core.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
/** 只允许这一个非回环地址，理由见顶部第 1 条（容器端口发布）。 */
const CONTAINER_BIND = '0.0.0.0';

export interface ServeOpts {
  host?: string;
  port?: number;
}

export interface ServeHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export const DEFAULT_PORT = 8787;

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    // 进度是会变的读数，任何一层缓存都会给出过期的"健康"
    'cache-control': 'no-store',
  });
  res.end(s);
}

export function startServer(o: ServeOpts = {}): Promise<ServeHandle> {
  const host = o.host ?? '127.0.0.1';
  if (host === CONTAINER_BIND) {
    // 只允许这一个例外，而且必须吼一声——见顶部第 1 条：容器内绑 0.0.0.0 只有配上
    // `-p 127.0.0.1:...` 才等于"只对本机开放"。配错了就是全网开放。
    console.warn(
      '\n⚠️  绑定了 0.0.0.0：这会把服务放到容器网络里所有能路由到它的地方（包括同网络的其他容器）。\n'
      + '   只有一种用法是对的：容器内跑，且发布时写 -p 127.0.0.1:<宿主机端口>:<容器端口>。\n'
      + '   在宿主上直接这样跑＝对局域网开放，等于把平台 token 递出去。\n',
    );
  } else if (!LOOPBACK.has(host)) {
    return Promise.reject(
      new Error(
        `拒绝绑定 ${host}：默认只允许回环地址（127.0.0.1 / ::1 / localhost）。`
        + `容器场景请显式传 --host ${CONTAINER_BIND} 并配 -p 127.0.0.1:...；`
        + '其他地址一律拒绝——原因见 src/serve.ts 顶部第 1 条。',
      ),
    );
  }
  const port = o.port ?? DEFAULT_PORT;
  const startedAt = Date.now();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, startedAt);
  });

  return new Promise<ServeHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const realPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://${host}:${realPort}`,
        port: realPort,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            // keep-alive 连接会让 close() 一直不回，直接断掉空闲连接
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, startedAt: number): Promise<void> {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: '只支持 GET（本服务只读）' });
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/') {
      return json(res, 200, {
        schema: OPS_SCHEMA,
        what: 'SCNet 只读接口（本机回环，只读，不含写操作）',
        endpoints: {
          'GET /health': '服务自身状态',
          'GET /ops': '操作清单（名字 / 摘要 / 入参 schema）',
          'GET /op/<name>?k=v': '调用一个操作',
        },
        ops: OPERATIONS.map((x) => x.name),
      });
    }

    if (path === '/health') {
      return json(res, 200, {
        ok: true,
        schema: OPS_SCHEMA,
        ops: OPERATIONS.length,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    if (path === '/ops') {
      return json(res, 200, {
        schema: OPS_SCHEMA,
        ops: OPERATIONS.map((x) => ({
          name: x.name,
          summary: x.summary,
          description: x.description,
          inputSchema: x.inputSchema,
        })),
      });
    }

    const m = /^\/op\/([A-Za-z0-9_]+)$/.exec(path);
    if (m) {
      const op = opByName(m[1]!);
      if (!op) {
        // 拼错操作名要明确说不存在，并给出候选——静默 404 会让人以为服务挂了
        return json(res, 404, {
          error: `没有这个操作：${m[1]}`,
          hint: '试试 /ops 看清单',
        });
      }
      let args: Record<string, unknown>;
      try {
        args = coerceArgs(op.inputSchema, Object.fromEntries(url.searchParams.entries()));
      } catch (e) {
        return json(res, 400, opError(e));
      }
      try {
        return json(res, 200, await op.handler(args));
      } catch (e) {
        // 平台/凭据/网络的问题都走这里。给 502 而不是 500：
        // "上游没答上来"和"这个服务自己崩了"是两回事，调用方要能分开重试。
        return json(res, 502, { schema: OPS_SCHEMA, op: op.name, ...opError(e) });
      }
    }

    return json(res, 404, { error: `未知路径 ${path}`, hint: 'GET / 看用法' });
  } catch (e) {
    return json(res, 500, opError(e));
  }
}
