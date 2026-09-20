/**
 * 核心层 / 两个界面的离线测试。
 *
 * 全部**不联网**：测的是"入参怎么解析""操作表长得对不对""协议消息怎么回"
 * 这些纯逻辑。任何需要凭据的路径都不在这里碰——那些靠真作业验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPERATIONS, OPS_SCHEMA, coerceArgs, opByName, opError } from '../src/core.ts';
import { DEFAULT_PORT } from '../src/serve.ts';
import { handleMessage, isMainModule } from '../src/mcp.ts';

// ── 操作表本身的完整性 ─────────────────────────────────────────────────────

test('操作名唯一且非空', () => {
  const names = OPERATIONS.map((o) => o.name);
  assert.equal(new Set(names).size, names.length, '有重名操作');
  for (const n of names) assert.match(n, /^[a-z][a-z0-9_]*$/);
});

test('每个操作都有摘要、短描述和 object 形态的 inputSchema', () => {
  for (const o of OPERATIONS) {
    assert.ok(o.summary.length > 0, `${o.name} 缺 summary`);
    assert.ok(o.description.length > 0, `${o.name} 缺 description`);
    // MCP 的 inputSchema 必须是 object 根
    assert.equal(o.inputSchema.type, 'object', `${o.name} 的 inputSchema 根不是 object`);
  }
});

test('description 要短：它按次进提示词，长了就是给自己加税', () => {
  for (const o of OPERATIONS) {
    assert.ok(o.description.length <= 300, `${o.name} 的 description 有 ${o.description.length} 字，太长了`);
  }
});

test('inputSchema 的 required 每一项都必须在 properties 里声明', () => {
  for (const o of OPERATIONS) {
    // 注意：test/*.mjs 不经类型剥离，这里不能写 TS 的 `as`（实测会被 node --check 拦下）
    const props = o.inputSchema.properties ?? {};
    const req = o.inputSchema.required ?? [];
    for (const k of req) {
      assert.ok(k in props, `${o.name}: required 里有 ${k}，但 properties 里没有`);
    }
  }
});

test('opByName 认得所有操作，认不出别的', () => {
  for (const o of OPERATIONS) assert.equal(opByName(o.name)?.name, o.name);
  assert.equal(opByName('nope'), undefined);
});

test('只读服务不含写操作（上传/提交/取消）', () => {
  // 这条是硬约束：见 src/serve.ts 顶部第 2 条。加写操作必须先改那段的理由。
  const names = OPERATIONS.map((o) => o.name).join(',');
  for (const forbidden of ['upload', 'put', 'submit', 'run', 'kill', 'cancel', 'delete', 'rm']) {
    assert.ok(!names.includes(forbidden), `只读层里出现了写操作：${forbidden}`);
  }
});

// ── 入参解析（HTTP query → 类型）────────────────────────────────────────────

test('coerceArgs 按 schema 转类型', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' }, scale: { type: 'number' } },
  };
  assert.deepEqual(coerceArgs(schema, { path: '/a', limit: '25', scale: '1.5' }), {
    path: '/a',
    limit: 25,
    scale: 1.5,
  });
  assert.equal(coerceArgs(schema, { limit: '7' }).limit, 7);
  assert.equal(coerceArgs(schema, { limit: '7.9' }).limit, 7, 'integer 要截断而不是取整到 8 以外');
});

test('coerceArgs 丢掉 schema 里没声明的键（拼错的参数不许被静默接受）', () => {
  const schema = { type: 'object', properties: { id: { type: 'string' } } };
  assert.deepEqual(coerceArgs(schema, { id: '1', idd: '2', typo: 'x' }), { id: '1' });
});

test('coerceArgs 对非数字报错，而不是塞 NaN 进去', () => {
  const schema = { type: 'object', properties: { limit: { type: 'integer' } } };
  assert.throws(() => coerceArgs(schema, { limit: 'abc' }), /不是数字/);
});

test('coerceArgs 的 boolean 转换不用 Boolean("false")', () => {
  const schema = { type: 'object', properties: { v: { type: 'boolean' } } };
  assert.equal(coerceArgs(schema, { v: 'false' }).v, false);
  assert.equal(coerceArgs(schema, { v: '0' }).v, false);
  assert.equal(coerceArgs(schema, { v: 'true' }).v, true);
  assert.equal(coerceArgs(schema, { v: '1' }).v, true);
});

// ── 错误整形 ───────────────────────────────────────────────────────────────

test('opError 保留 message 与 detail', () => {
  assert.deepEqual(opError(new Error('坏了')), { error: '坏了' });
  const withDetail = Object.assign(new Error('坏了'), { detail: { code: '815007' } });
  assert.deepEqual(opError(withDetail), { error: '坏了', detail: { code: '815007' } });
  assert.equal(opError('纯字符串').error, '纯字符串');
});

// ── MCP 协议（纯函数，不起子进程、不走管道）──────────────────────────────

test('initialize 回显认识过的协议版本', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const result = r.result;
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.equal(result.serverInfo.name, 'scnet');
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
});

test('initialize 遇到不认识的协议版本时降级，而不是把 harness 卡死', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
});

test('通知不回消息（回了客户端会因为未知 id 报错）', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
});

test('tools/list 的每个工具都有 name/description/inputSchema，且和 OPERATIONS 一一对应', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = r.result.tools;
  assert.equal(tools.length, OPERATIONS.length);
  for (const t of tools) {
    assert.ok(t.name && t.description);
    assert.equal(t.inputSchema.type, 'object');
  }
  assert.deepEqual(tools.map((t) => t.name), OPERATIONS.map((o) => o.name));
});

test('ping 有 id 才回', async () => {
  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'ping' }), null);
});

test('未知方法用 -32601，未知工具用 -32602 并列出可选工具', async () => {
  const m = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(m.error.code, -32601);

  const t = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '不存在', arguments: {} } });
  assert.equal(t.error.code, -32602);
  assert.deepEqual(t.error.data.available, OPERATIONS.map((o) => o.name));
});

test('工具存在但调用失败 → isError 结果（而不是协议错误）', async () => {
  // watch 缺必填参数 id —— 在联网之前就会因为参数校验抛错，所以这条不需要网络
  const r = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'watch', arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /缺少参数 id/);
});

// ── HTTP 侧的启动约束（只测拒绝分支，不真起服务）─────────────────────────

test('serve 默认拒绝一切非回环地址', async () => {
  const { startServer } = await import('../src/serve.ts');
  await assert.rejects(() => startServer({ host: '192.168.1.10', port: 0 }), /只允许回环地址/);
  await assert.rejects(() => startServer({ host: '10.0.0.5', port: 0 }), /只允许回环地址/);
});

test('0.0.0.0 是唯一的例外，而且只因为它才可能被容器用到', async () => {
  // 这条不是"允许对外"——容器的端口发布代理的是容器 IP，容器里绑 127.0.0.1 就连不上，
  // 所以容器内必须绑 0.0.0.0，安全性改由发布侧 `-p 127.0.0.1:...` 保证。
  // 这里只断言"它不被拒绝"，以及"别的非回环地址仍然被拒绝"（上一条）。
  const { startServer } = await import('../src/serve.ts');
  const h = await startServer({ host: '0.0.0.0', port: 0 });
  assert.match(h.url, /^http:\/\/0\.0\.0\.0:\d+$/);
  await h.close();
});

test('默认端口是个正经的高位端口', () => {
  assert.ok(DEFAULT_PORT > 1024 && DEFAULT_PORT < 65536);
});

test('OPS_SCHEMA 有版本号', () => {
  assert.match(OPS_SCHEMA, /^scnet-client\/ops@\d+$/);
});

// ── MCP 直接运行时的入口判据 ───────────────────────────────────────────────
// 对应实测踩过的坑："有 shebang、有导出，但没有入口" —— `node src/mcp.ts`
// 会静默地什么都不做（不报错、不输出、stderr 也空）。这条判据必须可测。

test('isMainModule：自己就是主模块时为真', () => {
  const url = 'file:///C:/x/src/mcp.ts';
  assert.equal(isMainModule('C:\\x\\src\\mcp.ts', url), true);
});

test('isMainModule：被别的文件 import 时为假（否则会被双重启动）', () => {
  assert.equal(isMainModule('C:\\x\\src\\cli.ts', 'file:///C:/x/src/mcp.ts'), false);
});

test('isMainModule：没有 argv[1] 时为假（比如以 -e 或 REPL 方式跑）', () => {
  assert.equal(isMainModule(undefined, 'file:///C:/x/src/mcp.ts'), false);
  assert.equal(isMainModule('', 'file:///C:/x/src/mcp.ts'), false);
});
