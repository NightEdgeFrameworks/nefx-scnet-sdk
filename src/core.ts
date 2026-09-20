/**
 * 核心层 —— 界面无关的一组**只读操作**。
 *
 * 为什么单独有这一层（2026-09-14 羽月定的规矩：可复用代码一律"核心 + 薄适配层"）：
 *   CLI、HTTP、MCP 三个界面必须是**同一份判据**的三个壳。以前 `watch` 的逻辑既在
 *   `cli.ts` 里排版、又在 `watch.ts` 里算，再加两个界面就会长出三份"什么算健康"。
 *   现在适配层只做两件事：解析入参 → 调这里 → 呈现。谁能被调用、返回什么字段，
 *   由下面这张 `OPERATIONS` 表说了算；加一个界面不改这里的任何东西。
 *
 * 三条硬约束（改这个文件前先读）：
 *   1. **不许把平台原始返回丢出去。** 每个 handler 自己挑字段、自己造一个干净对象。
 *      原因：`redact()` 会把 >10 项的数组截断（`list_jobs` 就废了），所以不能在出口
 *      统一脱敏；而原始返回里带着 token（`ep.region.token`）、aclHosts 几千个主机名之类
 *      不该外流的东西。挑字段是唯一既能脱敏又不破坏结构的做法。
 *   2. **凭据只在进程内。** 这里不读 secret.json、不打印它，`Endpoints` 只挑
 *      HPC/EFILE/ESH/home/userName/jobManagerId 六个字段，绝不整个吐出去。
 *   3. **有状态的操作要能被重复调用而不改变语义。** `watch` 每次调用都会落一个采样点，
 *      而速率/ETA 是"前后两点做差"——见 `watch.ts` 的 `MIN_RESAMPLE_SEC`：
 *      两次采样间隔太近时既不重算速率也不覆盖采样点。否则两个界面同时来问，
 *      就会算出 0 秒/步并误报"时间步没推进"。
 */
import { authenticate, getJson, usableRegions } from './auth.ts';
import { fetchQuota, listDirComplete, readRemoteText, resolveEndpoints, type Endpoints } from './api.ts';
import { ScnetClient } from './client.ts';
import { expandHome } from './jobtemplate.ts';
import {
  commandSourceOf,
  jsonSchema,
  openfoamCaseTemplate,
  renderCommand,
  starterTemplate,
  toSubmitBody,
  validateTemplate,
  workDirOf,
  type JobTemplate,
} from './jobtemplate.ts';
import { OPENFOAM_GATES } from './openfoam.ts';
import { getJob, listJobs, type JobListItem } from './jobs.ts';
import { formatWatch, watchJob, type WatchReport } from './watch.ts';

export const OPS_SCHEMA = 'scnet-client/ops@1';

// ── 端点缓存 ───────────────────────────────────────────────────────────────
/**
 * 认证 + 端点解析每次都要往返平台。服务形态下（HTTP 常驻、MCP 常驻）这个开销
 * 会被放大到每个请求一次，所以按区域缓存 10 分钟。
 * **不缓存凭据本身**——缓存的是解析结果，里面的 `region.token` 已经在进程内存里了，
 * 而它本来就在（每次调用也会解析出来一份）。
 */
const epCache = new Map<string, { at: number; ep: Endpoints }>();
const EP_TTL_MS = 10 * 60_000;

export async function endpointsFor(region?: string): Promise<Endpoints> {
  const key = region ?? '';
  const hit = epCache.get(key);
  if (hit && Date.now() - hit.at < EP_TTL_MS) return hit.ep;
  const ep = await (region ? new ScnetClient({ region }) : new ScnetClient({})).endpoints();
  epCache.set(key, { at: Date.now(), ep });
  return ep;
}

export function clearEndpointCache(): number {
  const n = epCache.size;
  epCache.clear();
  return n;
}

/** `watch` 结果的短时缓存。让 N 个调用方只产生 1 次真采样。 */
const watchCache = new Map<string, { at: number; v: WatchReport }>();
export const WATCH_CACHE_MS = 30_000;

// ── 入参解析 ───────────────────────────────────────────────────────────────

export type Args = Record<string, unknown>;

function needStr(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== 'string' || !v) throw new Error(`缺少参数 ${k}`);
  return v;
}

function optStr(a: Args, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' && v ? v : undefined;
}

function optNum(a: Args, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 ${k} 不是数字：${String(v)}`);
  return n;
}

// ── 操作表 ─────────────────────────────────────────────────────────────────

/**
 * 作业模板参数的两种收法：
 *   - HTTP/MCP 的 query/字符串形态 → JSON 文本，自己 parse；
 *   - MCP 直接传对象 → 原样用（结构化调用更自然，不必让调用方先 stringify）。
 * 解析失败要报清楚，不能悄悄退化成"空模板"——那会得到一份看起来合法、其实什么都没配的模板。
 */
function parseTemplateArg(a: Args): unknown {
  const v = a.template;
  if (typeof v === 'object' && v !== null) return v;
  if (typeof v !== 'string' || !v.trim()) throw new Error('缺少参数 template（模板 JSON 文本或对象）');
  try {
    return JSON.parse(v);
  } catch (e) {
    throw new Error(`template 不是合法 JSON：${(e as Error).message}`);
  }
}

export interface OpDef {
  /** MCP 工具名 / HTTP `/op/<name>`。全局唯一。 */
  name: string;
  /** 一行摘要，给人看 */
  summary: string;
  /** 给模型看的说明（会进 MCP 工具描述，**要短**——它按次进提示词） */
  description: string;
  /** JSON Schema（object）。HTTP 侧用它把 query string 转成正确类型 */
  inputSchema: Record<string, unknown>;
  handler: (a: Args) => Promise<unknown>;
}

const REGION_PROP = {
  region: { type: 'string', description: '区域名或 clusterId；省略用本机默认（西安）' },
} as const;

/**
 * 端点的公开投影。**只挑这六个字段** —— `Endpoints` 里有 `region.token`，
 * 整个吐出去就把凭据送进调用方（以及对方的日志）了。
 */
function safeEndpoints(ep: Endpoints): Record<string, unknown> {
  return {
    HPC: ep.HPC,
    EFILE: ep.EFILE,
    ESH: ep.ESH,
    home: ep.home,
    userName: ep.userName,
    jobManagerId: ep.jobManagerId,
  };
}

function safeJobItem(j: JobListItem): Record<string, unknown> {
  return {
    jobId: j.jobId === undefined ? null : String(j.jobId),
    jobName: j.jobName ?? null,
    // statC 分不出完成与取消，所以两个都留着，并给出可信的那个
    jobStatus: j.jobStatus ?? null,
    jobState: (j.jobState as string | undefined) ?? null,
    queue: j.queue ?? null,
    nodeUsed: j.nodeUsed ?? null,
    procNumUsed: j.procNumUsed === undefined ? null : String(j.procNumUsed),
    jobRunTime: j.jobRunTime ?? null,
    jobStartTime: (j.jobStartTime as string | undefined) ?? null,
  };
}

export const OPERATIONS: OpDef[] = [
  {
    name: 'probe',
    summary: '端点 / 区域 / 队列',
    description:
      '认证并列出可用区域、端点、队列名。用来确认凭据有效、区域对不对。只读，不提交任何作业。',
    inputSchema: { type: 'object', properties: { ...REGION_PROP }, additionalProperties: false },
    handler: async (a) => {
      const data = await authenticate();
      const regions = usableRegions(data);
      const out: Record<string, unknown>[] = [];
      for (const reg of regions) {
        const base = { clusterId: String(reg.clusterId), clusterName: reg.clusterName };
        if (String(reg.clusterId) === '0') {
          // 平台自身 token（ac）不能跑作业/传文件，说清楚，别让调用方以为它可用
          out.push({ ...base, usable: false, why: '平台自身 token（ac），不能用于作业与文件接口' });
          continue;
        }
        const ep = await resolveEndpoints(reg);
        const q = await getJson(
          `${ep.HPC}/openapi/v2/queuenames/users/${ep.userName}?strJobManagerID=${ep.jobManagerId}`,
          { token: reg.token },
        );
        const names = new Set<string>();
        const walk = (n: unknown, d = 0): void => {
          if (d > 8 || !n) return;
          if (Array.isArray(n)) return void n.forEach((x) => walk(x, d + 1));
          if (typeof n === 'object') {
            for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
              if (/^queuename$/i.test(k) && typeof v === 'string' && v) names.add(v);
              else walk(v, d + 1);
            }
          }
        };
        walk(q.data);
        out.push({ ...base, usable: true, ...safeEndpoints(ep), queues: [...names] });
      }
      return { schema: OPS_SCHEMA, regions: out };
    },
  },

  {
    name: 'list_jobs',
    summary: '实时作业列表',
    description:
      '列出该集群当前作业。注意 jobStatus=statC 分不出"跑完"和"被取消"，判终态要用 jobState。'
      + '作业结束后只在实时列表里保留约 5 分钟。',
    inputSchema: {
      type: 'object',
      properties: {
        ...REGION_PROP,
        limit: { type: 'integer', description: '返回条数，默认 25' },
        owner: { type: 'string', description: '作业属主，默认当前用户' },
        name: { type: 'string', description: '按作业名过滤' },
        stat: { type: 'string', description: '按平台状态过滤，如 statR' },
        queue: { type: 'string', description: '按队列过滤' },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const ep = await endpointsFor(optStr(a, 'region'));
      const js = await listJobs(ep, {
        limit: optNum(a, 'limit') ?? 25,
        owner: optStr(a, 'owner'),
        name: optStr(a, 'name'),
        stat: optStr(a, 'stat'),
        queue: optStr(a, 'queue'),
      });
      return {
        schema: OPS_SCHEMA,
        endpoint: ep.HPC,
        total: js.total ?? null,
        jobs: js.list.map(safeJobItem),
      };
    },
  },

  {
    name: 'job_detail',
    summary: '单个作业详情',
    description:
      '读一个作业的调度器状态。jobState 是唯一可信的终态判据（COMPLETED/FAILED/CANCELLED）；'
      + 'jobStatus=statC 不算。found=false 表示作业不存在（平台 code=0 且 data=null）。',
    inputSchema: {
      type: 'object',
      properties: { ...REGION_PROP, id: { type: 'string', description: '作业号' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const ep = await endpointsFor(optStr(a, 'region'));
      const d = await getJob(ep, needStr(a, 'id'));
      return {
        schema: OPS_SCHEMA,
        jobId: String(a.id),
        found: d.found,
        jobStatus: d.jobStatus ?? null,
        jobState: d.jobState ?? null,
        exitCode: d.exitCode ?? null,
        runTime: d.runTime ?? null,
        reason: d.reason ?? null,
        workDir: d.workDir ?? null,
      };
    },
  },

  {
    name: 'watch',
    summary: '健康 / 进度 / 预计完成',
    description:
      '采样一次作业：健康 / 进度 / 速度 / 预计完成。Fluent 与 OpenFOAM 都认（看 kind）：'
      + '前者读 .trn/stdout 的 `Flow time = .., time step = ..`，后者读算例里 `log.<solver>.<fresh|restart>` 的 `Time = `，'
      + 'ETA 靶子是 controlDict 的 endTime。速度靠与上次采样做差，两次查询至少隔 30 秒；'
      + '太近会 rate=null 且不覆盖采样点（见 sample）。rate/eta 是判别联合：Fluent 给秒/步，OpenFOAM 给秒/物理时间。',
    inputSchema: {
      type: 'object',
      properties: {
        ...REGION_PROP,
        id: { type: 'string', description: '作业号' },
        steps: { type: 'integer', description: '本批目标步数（只对 Fluent 有效）；给了才有 ETA 和批内进度' },
        format: { type: 'string', enum: ['json', 'text'], description: 'text 返回人读短句' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const id = needStr(a, 'id');
      const steps = optNum(a, 'steps');
      const cached = watchCache.get(id);
      let rep: WatchReport;
      if (cached && Date.now() - cached.at < WATCH_CACHE_MS) {
        rep = cached.v;
      } else {
        const ep = await endpointsFor(optStr(a, 'region'));
        rep = await watchJob(ep, id, steps === undefined ? {} : { steps });
        watchCache.set(id, { at: Date.now(), v: rep });
      }
      if (optStr(a, 'format') === 'text') {
        return { schema: OPS_SCHEMA, jobId: id, text: formatWatch(rep) };
      }
      return rep;
    },
  },

  {
    name: 'disk_quota',
    summary: '共享存储配额与已用量（GB）',
    description:
      '查账号的共享存储配额与已用量，一条记录一个挂载路径（家目录就是其中一条）。'
      + '**单位是 GB**（官方文档确认），已用百分比超 100% 表示已超额，如实报不做夹取。'
      + '这是平台侧的实时统计，不用递归列目录——比 du 快几个数量级。'
      + '若平台没开这个接口会返回 ok=false + reason（错误码 10009 = 没有权限访问接口）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...REGION_PROP,
        username: { type: 'string', description: '平台用户名；省略用端点里解析到的当前用户' },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const ep = await endpointsFor(optStr(a, 'region'));
      const r = await fetchQuota(ep, optStr(a, 'username'));
      return {
        schema: OPS_SCHEMA,
        ok: r.ok,
        userName: optStr(a, 'username') ?? ep.userName,
        unit: 'GB',
        entries: r.entries,
        // 顶层给一个"合计"便于一眼看：和是真实存在的量（配额是各路径之和），
        // 但只要有 null 就整体给 null——半个和在报表里比没有数字更危险。
        totalThresholdGB: r.entries.every((e) => e.thresholdGB !== null)
          ? r.entries.reduce((s, e) => s + (e.thresholdGB ?? 0), 0) : null,
        totalUsageGB: r.entries.every((e) => e.usageGB !== null)
          ? r.entries.reduce((s, e) => s + (e.usageGB ?? 0), 0) : null,
        ...(r.ok ? {} : { code: r.code, msg: r.msg, reason: r.reason ?? null }),
      };
    },
  },

  {
    name: 'list_dir',
    summary: '列远端目录（列全，不截断）',
    description:
      '列一个远端目录，**一次列全**（平台一次回不全就自动加大 limit 重问，不翻页——'
      + '平台的 offset 是空参数，实测翻页只会拿到重复数据）。'
      + '返回 dirs（全部子目录名）+ files（文件，含权限/属主/符号链接标志）+ total + truncated。'
      + 'truncated=true 表示问满 5 轮还没列全，此时 files 是不完整的，别当成"不存在"。',
    inputSchema: {
      type: 'object',
      properties: {
        ...REGION_PROP,
        path: { type: 'string', description: '远端目录，省略为家目录；支持 ~ 前缀' },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const ep = await endpointsFor(optStr(a, 'region'));
      const p = expandHome(optStr(a, 'path') ?? ep.home, ep.home);
      // 2026-09-15 起不再暴露 limit / offset：
      //   · offset 是空参数（实测 offset=0 与 offset=1000 首条相同），留着就是在邀请别人翻出重复数据；
      //   · limit 会被静默当成"目录就这么多"，而本仓库最贵的一类 bug 就是"没列出来"被读成"不存在"。
      // 想少要几条的调用方自己切返回数组——那是显示问题，不该由接口层截断。
      const r = await listDirComplete(ep, p);
      return {
        schema: OPS_SCHEMA,
        path: p,
        exists: r.exists,
        total: r.total ?? null,
        truncated: r.truncated ?? false,
        dirs: r.dirs,
        files: r.entries
          .filter((e) => e.isDirectory !== true)
          .map((e) => ({
            name: e.name,
            size: Number(e.size),
            mtime: e.lastModifiedTime ?? null,
            isSymbolicLink: e.isSymbolicLink === true,
            permission: e.permission ?? null,
            owner: e.owner ?? null,
            group: e.group ?? null,
          })),
      };
    },
  },

  {
    name: 'read_file',
    summary: '读远端文本一页',
    description:
      '读远端文本文件的一页（Fluent 的 .trn / stdout.<jobId> 都靠它）。'
      + 'dir=UP 读尾部、DOWN 读头部；默认读尾部，因为日志要看最后几行。'
      + '会先列父目录确认文件存在——平台读不存在的文件返回空正文 + code=0，跟"空文件"一模一样。',
    inputSchema: {
      type: 'object',
      properties: {
        ...REGION_PROP,
        path: { type: 'string', description: '远端文件绝对路径；支持 ~ 前缀' },
        page: { type: 'integer', description: '页码，从 1 开始' },
        dir: { type: 'string', enum: ['UP', 'DOWN'], description: 'UP=从尾部起（默认），DOWN=从头部起' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const ep = await endpointsFor(optStr(a, 'region'));
      const path = expandHome(needStr(a, 'path'), ep.home);
      const slash = path.lastIndexOf('/');
      const { entries, exists } = await listDirComplete(ep, slash > 0 ? path.slice(0, slash) : '/');
      const name = path.slice(slash + 1);
      if (!exists || !entries.some((f) => f.name === name)) {
        return { schema: OPS_SCHEMA, path, exists: false, text: null, why: '远端文件不存在' };
      }
      const dir = optStr(a, 'dir') === 'DOWN' ? 'DOWN' : 'UP';
      const r = await readRemoteText(ep, path, optNum(a, 'page') ?? 1, dir);
      return {
        schema: OPS_SCHEMA,
        path,
        exists: true,
        dir,
        text: r.text ?? '',
        totalLines: r.totalLines ?? null,
        totalPages: r.totalPages ?? null,
      };
    },
  },

  // ── 作业模板：离线、只读、三个界面共用 ────────────────────────────────────
  // 这一组是给第三方软件 / 别的 agent 用的：取起步模板 → 本地改造 → 校验 → 预览。
  // 全程不联网、不读凭据、不提交。真提交仍走 CLI 的 `run` 或库里的 `client.run()`
  // ——写操作不进这两个只读界面，理由见 serve.ts 顶部。
  {
    name: 'get_job_template',
    summary: '取作业起步模板（fluent / openfoam）',
    description:
      '不联网。kind=openfoam 取 OpenFOAM 求解模板（含七道门的清单），kind=fluent 取 Fluent 批量模板。'
      + '拿到的模板可直接填 inputs[].local 后交给 check/preview/run。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['fluent', 'openfoam'], description: '默认 fluent' },
        name: { type: 'string', description: '作业名，默认 my-run-001 / of-run-001' },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const kind = optStr(a, 'kind') === 'openfoam' ? 'openfoam' : 'fluent';
      const name = optStr(a, 'name');
      const template =
        kind === 'openfoam' ? openfoamCaseTemplate(name ?? 'of-run-001') : starterTemplate(name ?? 'my-run-001');
      return {
        schema: OPS_SCHEMA,
        kind,
        template,
        ...(kind === 'openfoam' ? { gates: OPENFOAM_GATES } : {}),
      };
    },
  },
  {
    name: 'check_job_template',
    summary: '离线校验作业模板',
    description:
      '不联网。校验字段/默认值/命令来源互斥，返回 errors 与 warnings。'
      + '默认把"本地文件不存在"降成警告——远端调用方看到的路径本来就不在本机。',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: '模板 JSON 文本（MCP 侧也可直接传对象）' },
      },
      required: ['template'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { template: t, errors, warnings } = validateTemplate(parseTemplateArg(a), { checkFiles: 'warn' });
      return { schema: OPS_SCHEMA, ok: errors.length === 0, errors, warnings, commandSource: commandSourceOf(t), template: t };
    },
  },
  {
    name: 'render_job_command',
    summary: '渲染将要在远端执行的 shell',
    description:
      '不联网。按模板的命令来源渲染出远端 shell 全文。'
      + 'openfoam 来源会一并返回七道门的判据清单——这是"跑完了吗"的产物契约，别只看返回码。',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: '模板 JSON 文本（MCP 侧也可直接传对象）' },
      },
      required: ['template'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { template: t, errors } = validateTemplate(parseTemplateArg(a), { checkFiles: 'warn' });
      if (errors.length) throw new Error(`模板校验未通过：${errors.join('；')}`);
      const source = commandSourceOf(t);
      return {
        schema: OPS_SCHEMA,
        source,
        command: renderCommand(t),
        ...(source === 'openfoam' ? { gates: OPENFOAM_GATES } : {}),
      };
    },
  },
  {
    name: 'preview_job_template',
    summary: '离线预览上传清单 / 工作目录 / 提交体',
    description:
      '不联网。给出上传清单、workDir、远端命令、提交体。'
      + 'home 与 jobManagerId 不传时用 $HOME / 空串占位——所以这三个字段在提交前必须由联网侧替换。',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: '模板 JSON 文本（MCP 侧也可直接传对象）' },
        home: { type: 'string', description: '远端家目录，默认 "$HOME"（占位）' },
        jobManagerId: { type: 'string', description: '调度器 ID，默认空串（占位）' },
        userName: { type: 'string', description: '平台用户名，默认空串（占位）' },
      },
      required: ['template'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { template: t, errors, warnings } = validateTemplate(parseTemplateArg(a), { checkFiles: 'warn' });
      if (errors.length) throw new Error(`模板校验未通过：${errors.join('；')}`);
      const home = optStr(a, 'home') ?? '$HOME';
      const source = commandSourceOf(t);
      return {
        schema: OPS_SCHEMA,
        source,
        warnings,
        workDir: workDirOf(t, home),
        uploads: t.inputs.map((i) => ({ local: i.local, remoteDir: expandHome(i.remoteDir, home) })),
        remoteCommand: renderCommand(t),
        submitBody: toSubmitBody(t, {
          home,
          jobManagerId: optStr(a, 'jobManagerId') ?? '',
          userName: optStr(a, 'userName') ?? '',
        }),
        placeholders: {
          home: home === '$HOME',
          jobManagerId: !optStr(a, 'jobManagerId'),
          userName: !optStr(a, 'userName'),
        },
        ...(source === 'openfoam' ? { gates: OPENFOAM_GATES } : {}),
      };
    },
  },
];

const BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

export function opByName(name: string): OpDef | undefined {
  return BY_NAME.get(name);
}

/**
 * 按 schema 把 HTTP query（全是字符串）转成正确类型。
 * 纯函数，有单测——`limit=25` 变成字符串 "25" 传给 `Number()` 也能用，
 * 但 `"false"` / `"0"` 这类会被 `Boolean()` 判成 true，所以必须按 schema 转。
 */
export function coerceArgs(schema: Record<string, unknown>, q: Record<string, string>): Args {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const out: Args = {};
  for (const [k, raw] of Object.entries(q)) {
    const t = props[k]?.type;
    if (!t) {
      // schema 里没声明的键一律丢掉，而不是透传——避免拼错参数被静默接受
      continue;
    }
    if (t === 'integer' || t === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`参数 ${k} 不是数字：${raw}`);
      out[k] = t === 'integer' ? Math.trunc(n) : n;
    } else if (t === 'boolean') {
      out[k] = raw === 'true' || raw === '1';
    } else {
      out[k] = raw;
    }
  }
  return out;
}

/** 把 handler 的报错整理成稳定的形状（两个界面共用）。 */
export function opError(e: unknown): { error: string; detail?: unknown } {
  const err = e as { name?: string; message?: string; detail?: unknown };
  return {
    error: err?.message ? String(err.message) : String(e),
    ...(err?.detail === undefined ? {} : { detail: err.detail }),
  };
}
