/**
 * console-feed —— 给 dsh-console 的「曙光作业信息」喂数据的一个**纯 JSON 出口**。
 *
 * 为什么是独立进程 + stdout JSON，而不是让 dsh-console 直接 import 本项目的 src：
 *
 *  1) **超时必须能被真的杀掉。** dsh-console 的调度器（src/core/scheduler.ts 顶部第 3 条）明写
 *     "这里只能放弃等待，JS 里杀不掉同步阻塞"。平台接口一旦挂住，进程内调用会拖住整个控制台；
 *     子进程则可以被真杀。这是选进程边界最主要的原因，不是洁癖。
 *  2) **各留一份真源。** 平台字段名、鉴权、分页规则只在本项目里维护一份；console 只认下面这个
 *     payload 契约。console 不需要知道我们的模块结构，我们也不需要为它改导出。
 *  3) 两个项目各自的 import-check / 测试边界不动。
 *
 * ★ 输出契约（改动必须同步 dsh-console/src/plugins/scnet/feed.ts 里的解析与单测）：
 *   - stdout 会先有本项目的其它打印（不许假定"只有一行"）；
 *   - **最后一行**必定是一个单行 JSON，形如 {"ok":true,...} 或 {"ok":false,"error":"..."}；
 *   - 调用方从尾部往前找第一个能解析出 `ok` 布尔字段的行，**不要**按行号或首行取。
 *   - 任何情况下都会打印那个 JSON（包括抛异常时），失败时另外把退出码置 1。
 *
 * 用法：node tools/console-feed.mjs [--history-hours 24] [--live-limit 50]
 * 不打印凭据值（凭据只在进程内使用；ep.region.token 从不输出）。
 */

import { ScnetClient } from '../src/client.ts';
import { listJobs } from '../src/jobs.ts';
import { getJson } from '../src/auth.ts';

function argNum(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
/** 平台接口要 'YYYY-MM-DD HH:mm:ss' 这种本地时间串（实测口径，别用 ISO 的 T/Z）。 */
function platformTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 实时列表每条：把已知字段挑出来，同时原样留 raw（平台加字段时不用改代码就能存下来）。 */
function normalizeLive(j) {
  return {
    jobId: j.jobId === undefined ? null : String(j.jobId),
    name: j.jobName ?? null,
    /** ⚠️ jobStatus 的 statC 分不出"完成"和"取消"——只用来显示，别拿它判终态 */
    platformStatus: j.jobStatus ?? null,
    queue: j.queue ?? null,
    nodes: j.nodeUsed ?? null,
    cores: j.procNumUsed === undefined ? null : Number(j.procNumUsed),
    runTime: j.jobRunTime ?? null,
    raw: j,
  };
}

/** 历史列表每条：字段名与实时列表**不同**（这是实测出来的，不是笔误）。 */
function normalizeHistory(j) {
  return {
    jobId: j.jobId === undefined ? null : String(j.jobId),
    name: j.jobName ?? null,
    /** slurm 短码：statC 完成 / statD 失败 / statT 超时 / statDE 取消 / statRQ 重跑 / statN 节点异常 */
    state: j.jobState ?? null,
    queue: j.queue ?? null,
    nodes: j.nodect === undefined ? null : Number(j.nodect),
    cores: j.jobProcNum === undefined ? null : Number(j.jobProcNum),
    host: j.jobExecHost ?? null,
    queueTime: j.jobQueueTime ?? null,
    startTime: j.jobStartTime ?? null,
    endTime: j.jobEndTime ?? null,
    /** 实际运行秒数（字符串，保留平台原样的 4 位小数） */
    walltimeUsedSec: j.jobWalltimeUsed ?? null,
    /** ⚠️ 记账侧口径，**不是**脚本退出码（实测同一个作业历史报 10005、调度器报 37:0）。原样保留，别改名叫 exitCode。 */
    acctExitStatus: j.jobExitStatus ?? null,
    /** ⚠️ 不可信：实测 121 条 OpenFOAM/Fluent 作业里 121 条中 121 个记 BASE。只做原样透传。 */
    appType: j.appType ?? null,
    workdir: j.workdir ?? null,
    acctTime: j.acctTime ?? null,
    raw: j,
  };
}

async function fetchHistory(ep, hours, cap) {
  const until = new Date();
  const from = new Date(until.getTime() - hours * 3600_000);
  const qs = new URLSearchParams({
    strClusterNameList: ep.jobManagerId,
    strUser: ep.userName,
    timeType: 'CUSTOM',
    startTime: platformTime(from),
    endTime: platformTime(until),
    start: '0',
    limit: String(cap),
    isQueryByQueueTime: 'false',
  });
  const r = await getJson(`${ep.HPC}/openapi/v2/historyjobs?${qs.toString()}`, { token: ep.region.token });
  if (String(r.code) !== '0') {
    return { ok: false, error: `historyjobs code=${r.code} msg=${r.msg}`, total: null, jobs: [] };
  }
  const d = (r.data ?? {});
  const list = Array.isArray(d.list) ? d.list : [];
  return {
    ok: true,
    error: null,
    total: d.total ?? null,
    /** 一次要满 limit 就是全拿了；要不满说明窗口内就这么多 */
    jobs: list.map(normalizeHistory),
  };
}

async function main() {
  const historyHours = argNum('history-hours', 24);
  const liveLimit = argNum('live-limit', 50);
  const at = Date.now();
  const c = new ScnetClient({ region: '0' });
  const ep = await c.endpoints();

  const liveRaw = await listJobs(ep, { limit: liveLimit });
  const live = {
    total: liveRaw.total ?? null,
    jobs: (liveRaw.list ?? []).map(normalizeLive),
  };

  const history = await fetchHistory(ep, historyHours, 200);

  return {
    ok: true,
    at,
    who: { user: ep.userName, jobManagerId: ep.jobManagerId },
    window: { fromMs: at - historyHours * 3600_000, toMs: at, historyHours },
    live,
    history,
    warnings: history.ok ? [] : [`历史作业列表取失败：${history.error}`],
  };
}

let payload;
try {
  payload = await main();
} catch (err) {
  payload = { ok: false, error: (err && err.message) ? err.message : String(err), at: Date.now() };
}
// 最后一行必须是它：前面无论打印过什么，调用方都从尾部往前找。
process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exit(payload.ok ? 0 : 1);
