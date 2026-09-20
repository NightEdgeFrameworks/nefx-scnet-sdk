/**
 * 作业操作：提交 / 列表 / 详情 / 取消 / 等待。
 *
 * ⚠️ 本文件里最容易踩的坑（实测结论，别改）：
 *   jobStatus=statC **无法区分"已完成"和"已取消"**，两者都是 statC。
 *   唯一可信的终态判据是调度器层的 JobState（COMPLETED / FAILED / CANCELLED / …）。
 *   同理，DELETE 返回 code=0 也不代表真的取消了——必须回查 JobState。
 */
import type { Endpoints } from './api.ts';
import { getJson } from './auth.ts';
import type { SubmitBody } from './jobtemplate.ts';
import { die, show } from './redact.ts';

export interface JobListItem {
  jobId?: string | number;
  jobName?: string;
  jobStatus?: string;
  queue?: string;
  nodeUsed?: string;
  procNumUsed?: number | string;
  jobRunTime?: string;
  [k: string]: unknown;
}

export interface JobDetail {
  raw: Record<string, unknown>;
  /** 平台有没有返回作业对象。false 时下面几个字段全是 undefined，**不要**当成"状态未知" */
  found: boolean;
  jobStatus?: string;
  jobState?: string;
  exitCode?: string;
  runTime?: string;
  /** 调度器给的原因，失败时最有用（实测：NonZeroExitCode） */
  reason?: string;
  workDir?: string;
}

const TERMINAL_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'NODE_FAIL',
  'BOOT_FAIL',
  'OUT_OF_MEMORY',
  'PREEMPTED',
  'DEADLINE',
]);

/**
 * 在对象里按 key 名浅递归找一个字段（平台返回结构在不同接口下不完全一致）。
 * **空字符串和 null 一律当作"没有"**——见下面 parseJobDetail 的注释，这是实测踩过的坑。
 */
function pickDeep(obj: unknown, keyRe: RegExp, maxDepth = 4): unknown {
  if (maxDepth < 0 || !obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keyRe.test(k) && v !== '' && v !== null && v !== undefined) return v;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const got = pickDeep(v, keyRe, maxDepth - 1);
      if (got !== undefined) return got;
    }
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

/**
 * 解析作业详情。
 *
 * ⚠️ 实测（2026-09-14）：查询**不存在**的作业号时，平台返回的是
 *   `{"httpStatus":200,"code":"0","msg":"success","data":null}`
 * 也就是 code=0 + 空 data。如果不看 `data` 是不是 null，就会把"作业不存在"
 * 当成"状态还没出来"，在轮询里空转到超时。
 *
 * ⚠️ 还有一个更阴的（2026-09-14 拿 `scontrol show job 67302235` 对照时发现）：
 * `data.exitCode` 在外层是**空字符串**，而真正的退出码在 `data.jobInitAttr.ExitCode`（"0:0"）。
 * 按 key 名找到第一个就返回的写法会取到那个空串，于是 CLI 打印出
 * `ExitCode = `（空白）——而"空白"看起来跟"不知道"一模一样。作业失败后第一件事就是看退出码，
 * 所以这里改成：**先查调度器层 `jobInitAttr`，再退到外层扁平查找；空串不算命中。**
 */
export function parseJobDetail(j: Record<string, unknown>): JobDetail {
  const raw = j.data as unknown;
  const found = raw !== null && raw !== undefined && typeof raw === 'object' && Object.keys(raw as object).length > 0;
  const data = (found ? raw : {}) as Record<string, unknown>;
  // 调度器层优先。jobInitAttr 里是 SLURM 的原生字段，比平台自己那层更可信。
  const init = (pickDeep(data, /^jobinitattr$/i) ?? {}) as Record<string, unknown>;
  const g = (k: RegExp) => {
    const fromScheduler = pickDeep(init, k, 2);
    return fromScheduler !== undefined ? fromScheduler : pickDeep(data, k);
  };
  return {
    raw: j,
    found,
    jobStatus: str(g(/^jobstatus$/i)),
    jobState: str(g(/^jobstate$/i)),
    exitCode: str(g(/^exitcode$/i)),
    runTime: str(g(/^jobruntime$/i)),
    reason: str(g(/^reason$/i)),
    workDir: str(g(/^workdir$/i)),
  };
}

/**
 * 读该集群调度器上当前可用的队列名。
 * `check --online` 用它拦下拼错的 queue —— 队列名写错只有在**提交时**才会暴露，
 * 而那时文件已经传上去了。
 */
export async function listQueueNames(ep: Endpoints): Promise<string[]> {
  const r = await getJson(
    `${ep.HPC}/openapi/v2/queuenames/users/${ep.userName}?strJobManagerID=${ep.jobManagerId}`,
    { token: ep.region.token },
  );
  const out = new Set<string>();
  const walk = (n: unknown, depth = 0): void => {
    if (depth > 8 || !n) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    if (typeof n === 'object') {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (/^queuename$/i.test(k) && typeof v === 'string' && v) out.add(v);
        else walk(v, depth + 1);
      }
    }
  };
  walk(r.data);
  if (!out.size) {
    // 字段名变了也别静默返回空——把原始返回交出去让人看见
    const m = JSON.stringify(r).match(/"queueName"\s*:\s*"([^"]+)"/g) ?? [];
    for (const s of m) out.add(s.replace(/.*"([^"]+)"$/, '$1'));
  }
  return [...out];
}

/** 提交作业，返回 jobId。 */
export async function submitJob(ep: Endpoints, body: SubmitBody): Promise<string> {
  const r = await getJson(`${ep.HPC}/openapi/v2/apptemplates/BASIC/BASE/job`, { token: ep.region.token }, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (String(r.code) !== '0') {
    show('提交失败（脱敏）', r);
    die('提交被平台拒绝——先看 queue 名对不对（用 `scnet probe` 查可用队列）');
  }
  return String(r.data);
}

export async function listJobs(
  ep: Endpoints,
  o: { owner?: string; start?: number; limit?: number; name?: string; stat?: string; queue?: string } = {},
): Promise<{ total?: number; list: JobListItem[]; raw: Record<string, unknown> }> {
  const qs = new URLSearchParams({
    strClusterIDList: ep.jobManagerId,
    strJobOwner: o.owner ?? ep.userName,
    start: String(o.start ?? 0),
    limit: String(o.limit ?? 25),
  });
  if (o.name) qs.set('strJobName', o.name);
  if (o.stat) qs.set('strJobStat', o.stat);
  if (o.queue) qs.set('strQueueName', o.queue);
  const r = await getJson(`${ep.HPC}/openapi/v2/jobs?${qs.toString()}`, { token: ep.region.token });
  const d = (r.data ?? {}) as { total?: number; list?: JobListItem[] };
  return { total: d.total, list: d.list ?? [], raw: r };
}

export async function getJob(ep: Endpoints, jobId: string | number): Promise<JobDetail> {
  const r = await getJson(`${ep.HPC}/openapi/v2/jobs/${jobId}`, { token: ep.region.token });
  return parseJobDetail(r);
}

/**
 * 取消作业。
 * 返回里只有 code=0 不足以判定成功，调用方应回查 JobState。
 */
export async function cancelJobs(
  ep: Endpoints,
  jobIds: Array<string | number>,
  owner?: string,
): Promise<Record<string, unknown>> {
  const who = owner ?? ep.userName;
  const strJobInfoMap = jobIds.map((i) => `${ep.jobManagerId},${who}:${i}:;`).join('');
  const res = await fetch(`${ep.HPC}/openapi/v2/jobs`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', token: ep.region.token },
    body: new URLSearchParams({ jobMethod: '5', strJobInfoMap }).toString(),
  });
  const txt = await res.text();
  try {
    return JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return { raw: txt.slice(0, 400) };
  }
}

export interface WaitResult {
  jobId: string;
  state: string;
  detail: JobDetail;
  polls: number;
  elapsedMs: number;
}

/**
 * 轮询直到终态。
 * 判据只用 JobState；jobStatus=statC 不算终态（它分不出完成还是取消）。
 */
export async function waitForJob(
  ep: Endpoints,
  jobId: string | number,
  o: {
    intervalMs?: number;
    timeoutMs?: number;
    onTick?: (d: JobDetail, elapsedMs: number) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<WaitResult> {
  const interval = o.intervalMs ?? 15000;
  const timeout = o.timeoutMs ?? 12 * 3600 * 1000;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  let polls = 0;
  let last: JobDetail | undefined;
  for (;;) {
    polls++;
    const d = await getJob(ep, jobId);
    last = d;
    o.onTick?.(d, Date.now() - t0);
    const st = (d.jobState ?? '').toUpperCase();
    if (st && TERMINAL_STATES.has(st)) {
      return { jobId: String(jobId), state: st, detail: d, polls, elapsedMs: Date.now() - t0 };
    }
    if (Date.now() - t0 > timeout) {
      return {
        jobId: String(jobId),
        state: st || 'TIMEOUT_LOCAL',
        detail: d,
        polls,
        elapsedMs: Date.now() - t0,
      };
    }
    await sleep(interval);
  }
}
