#!/usr/bin/env node
/**
 * `scnet mcp` —— 用 **stdio** 把 core.ts 的同一批只读操作暴露成 MCP 工具。
 *
 * 定位：让别的 agent / MCP 客户端（DSH 的 dsh-mcp-client、Claude Code、Codex……）
 * 把我的能力当原生工具调。跟 `scnet serve`（HTTP）是同一批操作的两个壳，见 core.ts。
 *
 * ── 为什么手写协议而不是装 @modelcontextprotocol/sdk ─────────────────────────────
 * 这个仓库的铁规矩是**零运行时依赖**。MCP 的 stdio 传输
 * 其实就是"一行一个 JSON-RPC 2.0 对象"，一个只提供 tools 能力的服务端只需要认
 * 六个方法（initialize / notifications/initialized / tools/list / tools/call / ping，
 * 其余通知忽略），一百多行就够。为这点东西引入一棵依赖树，不值。
 * **代价要写清楚**：手写实现只保证覆盖上面这几种消息；将来 MCP 规范加了新方法，
 * 这里会以 -32601 明确拒绝（而不是静默答错），但那意味着"跟随规范升级"要自己做。
 *
 * ── 一个容易踩的协议细节 ──────────────────────────────────────────────────────
 * **stdout 是协议通道，只能出 JSON。** 任何 `console.log` 都会污染流、把客户端弄崩。
 * 所有诊断一律走 stderr（见 `diag()`）。
 *
 * 配置片段（DSH：settings.yaml / profile 的 plugins 里加一条）：
 *   - id: mcp-scnet
 *     name: '@deepseek-ai/dsh-mcp-client'
 *     config:
 *       serverName: scnet
 *       transport: stdio
 *       command: node
 *       args: ['C:\\Users\\hanyo\\Documents\\dsh-agent\\D260914-scnet-client\\src\\mcp.ts']
 *       cwd: 'C:\\Users\\hanyo\\Documents\\dsh-agent\\D260914-scnet-client'
 * 工具会以 `mcp__scnet__<name>` 出现。
 * **注意 token 成本**：这些工具的描述每次请求都会进提示词。所以这里的 description
 * 都写得很短——加工具就是给自己加税，别为了"顺便"多暴露几个。
 */
import { pathToFileURL } from 'node:url';

import { OPERATIONS, OPS_SCHEMA, opByName, opError } from './core.ts';

const SERVER_NAME = 'scnet';
const SERVER_VERSION = '0.1.0';
/**
 * 支持并回显的协议版本。客户端报一个我们认识的版本就照原样回（这是规范要求的协商方式）；
 * 不认识就回我们自己最新的，让客户端自己决定要不要继续。
 * 不认识时报错更"正确"，但那会让整个 harness 起不来——宁可协商降级，也不要让服务端
 * 因为一个版本字符串把主流程卡死。
 */
const DEFAULT_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function diag(msg: string): void {
  process.stderr.write(`[scnet-mcp] ${msg}\n`);
}

type Id = string | number | null;

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

/** 工具清单。**描述要短**——它按次进提示词，见文件头。 */
function toolList(): Array<Record<string, unknown>> {
  return OPERATIONS.map((o) => ({
    name: o.name,
    description: o.description,
    inputSchema: o.inputSchema,
  }));
}

/**
 * 处理一条消息，**返回要发回去的对象**（通知返回 null）。
 *
 * 特意做成"输入消息 → 输出消息"的纯函数（不碰 stdin/stdout），
 * 这样协议层可以离线单测——不用起子进程、不用管道，也就不会因为
 * Windows 上的管道限制而没法测。`serveStdio()` 只负责读行、调它、写回。
 */
export async function handleMessage(msg: JsonRpcMsg): Promise<Record<string, unknown> | null> {
  const { method, params } = msg;
  // 没有 id 的是通知，按规范一律不回（回了客户端会因为收到未知 id 而报错）
  const isNotification = msg.id === undefined;
  const id: Id = msg.id ?? null;
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string, data?: unknown): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  switch (method) {
    case 'initialize': {
      const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      const pv = KNOWN_PROTOCOLS.has(asked) ? asked : DEFAULT_PROTOCOL;
      if (asked && !KNOWN_PROTOCOLS.has(asked)) {
        diag(`客户端要求协议版本 ${asked}，本服务端不认识；回 ${pv} 让客户端决定`);
      }
      return ok({
        protocolVersion: pv,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'SCNet（曙光超算）只读接口。判作业终态必须用 jobState，jobStatus=statC 分不出完成与被取消。'
          + '长作业用 watch 看进度和预计完成时间。本服务端不提供上传/提交/取消。',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return null; // 通知：静默
    case 'ping':
      return isNotification ? null : ok({});
    case 'tools/list':
      return ok({ tools: toolList() });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const op = opByName(name);
      if (!op) {
        // 工具名不存在是"调用方的错"，按 MCP 约定用协议层错误，
        // 而不是 isError 结果——后者意味着"工具跑了但失败了"。
        return err(-32602, `未知工具：${name}`, { available: OPERATIONS.map((o) => o.name) });
      }
      try {
        const value = await op.handler(args);
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return ok({
          content: [{ type: 'text', text }],
          // structuredContent 给程序化调用方留一份不丢类型的版本。
          // 只在结果是对象时给：规范要求它是 object，数组/标量会不合规。
          ...(value && typeof value === 'object' && !Array.isArray(value)
            ? { structuredContent: value }
            : {}),
          isError: false,
        });
      } catch (e) {
        // 工具**跑起来了但失败了**（平台拒了、凭据不对、网络断）——这是 isError 结果的场景，
        // 不是协议错误。客户端要能把它当"一次失败的调用"展示，而不是"协议坏了"。
        const info = opError(e);
        return ok({ content: [{ type: 'text', text: `失败：${info.error}` }], isError: true });
      }
    }
    default:
      return isNotification ? null : err(-32601, `未实现的方法：${String(method)}`);
  }
}

export function serveStdio(): void {
  let buf = '';
  /**
   * 在飞的请求数。
   *
   * 【实测踩到的 bug，2026-09-14】第一版在 stdin 的 'end' 上直接 `process.exit(0)`。
   * 结果：客户端"把请求写进来、然后关掉 stdin"这种用法（用管道喂几行最典型）
   * **一条回复都收不到**——`handleMessage` 是 async，`exit` 在它们 resolve 之前就把进程杀了。
   * 现在改成：end 之后先等在飞的请求跑完，再退。
   * 正确的 MCP 客户端通常不会关 stdin，但"请求写完就关"是合法的，不能靠运气。
   */
  let pending = 0;
  let seen = 0;
  let ended = false;
  /**
   * stdin 关了以后怎么退。
   *
   * 【实测踩到的第二个坑，2026-09-14】第一版在这里 `process.exit(0)`，
   * 结果"管道喂几行、然后关 stdin"这种用法**一条回复都收不到**。两个原因叠在一起：
   *   1. `handleMessage` 是 async，exit 在它们 resolve 之前就把进程杀了；
   *   2. 就算等它们跑完再 exit，**pipe 下 process.stdout 的写入是异步的**，
   *      `exit()` 会把还没 flush 的那几行直接丢掉。
   * 所以正确做法是：**不要主动 exit**。stdin 结束、在飞请求也都结束后，
   * 事件循环自然空了，Node 会 flush 完 stdout 再退。
   * 下面那个 unref 的兜底定时器只防一种情况：别的库（比如 fetch 的连接池）
   * 挂着 handle 让进程不肯退——那时 200 ms 后强制退，输出早就 flush 完了。
   */
  const maybeExit = (): void => {
    if (!ended || pending > 0) return;
    diag(`stdin 结束：收到 ${seen} 条消息，全部处理完毕，等 stdout flush 后自然退出`);
    process.stdin.pause();
    setTimeout(() => process.exit(0), 200).unref();
  };

  const dispatch = async (msg: JsonRpcMsg): Promise<void> => {
    pending++; // async 函数体在第一个 await 之前是同步执行的，所以这行一定是同步的
    try {
      const out = await handleMessage(msg);
      if (out) send(out);
    } catch (e) {
      diag(`处理 ${String(msg.method)} 时抛出：${String((e as Error)?.message ?? e)}`);
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'Internal error' } });
      }
    } finally {
      pending--;
      maybeExit();
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        // 解析不了就没有 id 可回；只能报 -32700 并把 id 置 null
        diag(`收到非 JSON 行（已忽略）：${line.slice(0, 200)}`);
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      seen++;
      // 不 await：让慢调用不阻塞后面到达的消息；退出的时机交给 pending 计数
      void dispatch(msg);
    }
  });
  process.stdin.on('end', () => {
    ended = true;
    maybeExit();
  });
  diag(`就绪（stdio，${OPERATIONS.length} 个只读工具，schema=${OPS_SCHEMA}）`);
}

// ── 直接运行时的入口 ───────────────────────────────────────────────────────
/**
 * 这个文件是不是"被直接运行的那个"。
 * 抽成纯函数是为了能被单测——它对应的失效模式是**静默的**（见下面那段教训）。
 */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

/**
 * `node src/mcp.ts` 也必须能用（MCP 客户端通常就是把这一行写进 args）。
 *
 * 【踩过的坑，2026-09-14】这个文件原来**只有导出、没有入口**：`node src/mcp.ts` 定义完导出
 * 就立刻正常退出了——不报错、不输出、stderr 也空，看起来像"服务端起不来但没有任何线索"。
 * 而 `node src/cli.ts mcp` 是好的（cli.ts 调了 serveStdio），所以很久都不会发现。
 * 判据必须用"这个文件是不是主模块"，这样 cli.ts import 它时**不会**被双重启动。
 */
if (isMainModule(process.argv[1], import.meta.url)) {
  serveStdio();
}
