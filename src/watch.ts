/**
 * `scnet watch` —— 作业健康 / 进度 / 预计完成时间。
 *
 * 为什么要有它（而不是"我盯着"）：
 *   我在两个回合之间不存在。长作业（这次是 10000 步、几十小时）必须由**脚本**来盯，
 *   所以"健康检查"这件事必须落成可复用的代码，能被计划任务反复调用。
 *
 * 数据来源（都是实测过的）：
 *   1. 调度器：getJob → JobState / RunTime / walltimeReq / NodeList。
 *      判活只能用它，`jobStatus=statC` 分不出完成与取消。
 *   2. 工作目录列表：file/list（注意必须带 limit，否则只回 10 条）。
 *   3. 进度文本——**两种作业的落点完全不同，这是本文件 2026-09-17 的主要改动**：
 *
 *      · Fluent：`fluent-*.trn` 是 Fluent 自己的 transcript，**逐步增量写盘**，
 *        比 stdout 可靠（stdout 在批处理下可能整块缓冲）。里面每完成一个时间步就打印一行
 *        `Flow time = <t>s, time step = <N>`，所以"当前第几步"能直接读出来。
 *        `fluent-<rank>-error.log` 非空＝某个 rank 出过事。
 *
 *      · OpenFOAM：**没有 .trn 这种东西**。求解器的 stdout 被渲染器重定向进了算例目录里的
 *        `log.<solver>.<fresh|restart>`（见 `openfoam.ts`），里面每推进一步打印一行
 *        `Time = <t>`；作业自己的 `stdout.<jobId>` 只有脚本各道门 echo 出来的几行
 *        （`GATE-ENV OK` / `GATE-UNPACK OK <算例绝对路径>` / `FRESH=` / 末尾的
 *        `Time <first> -> <last>`）。所以 OpenFOAM 的进度必须**再读一次求解器日志的尾巴**，
 *        而算例目录要从 stdout 里那句 `GATE-UNPACK OK` 取——工作目录是几个作业共用的，
 *        算例却可能在子目录里，靠猜会猜错。
 *
 * 进度率与 ETA 怎么算（重要）：
 *   进度文本里**没有时间戳**，单次采样算不出速度。所以每次采样都把
 *   (时间, 步号/物理时间) 存一份到磁盘，下一次采样拿前后两点做差 —— 这样即使每次都是
 *   独立的短命进程（计划任务就是这种形态），也能算出速度与 ETA。
 *   两种作业的"快慢"单位不同，所以 `rate` / `eta` 是**判别联合**：
 *   Fluent 给 秒/步，OpenFOAM 给 秒/单位物理时间（它按物理时间推进，没有"步"这个刻度）。
 *   OpenFOAM 的 ETA 靶子从算例的 `system/controlDict` 里读 `endTime` —— 那是这一轮真正的
 *   目标时刻（渲染器会把模板里的 endTime 写进去）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { listDirComplete, readRemoteText, type Endpoints, type RemoteEntry } from './api.ts';
import { STATE_DIR } from './auth.ts';
// `listJobs` 是给"详情接口没给 StartTime，退到实时列表去取 jobStartTime"那条兜底用的。
// 【2026-09-17 修】它原来**只被调用、没被 import**：`node --check` 只查语法，离线测试又不走那条路径，
// 于是一个 ReferenceError 被那里外层的 try/catch 静静吞掉——兜底从来没生效过，而报告看起来一切正常。
import { getJob, listJobs, type JobDetail } from './jobs.ts';

// ── 纯函数（可离线单测）────────────────────────────────────────────────────

/** `HH:MM:SS` / `H:MM:SS` → 秒。不合法返回 null。 */
export function hmsToSec(s: string | undefined | null): number | null {
  if (typeof s !== 'string') return null;
  const p = s.split(':').map(Number);
  if (p.length !== 3 || p.some((x) => !Number.isFinite(x))) return null;
  return p[0]! * 3600 + p[1]! * 60 + p[2]!;
}

/**
 * 把平台给的时间戳解析成毫秒。**必须显式按北京时区解析。**
 *
 * 实测（2026-09-14）：平台返回的是 `2026-09-14T14:47:13` 这种**不带时区**的字符串，
 * 而它表示的是北京时间（同一时刻 UTC 是 06:47:13，用提交时间对过）。
 * 直接交给 `Date.parse` 会按**本机时区**解释——本机恰好也在 UTC+8 时看着没问题，
 * 但换一台机器（比如 UTC 的 CI）就会整体差 8 小时，把 10 分钟算成 8 小时前。
 */
export function parsePlatformTime(s: string | undefined | null): number | null {
  if (typeof s !== 'string' || !s) return null;
  const hasZone = /([Zz]|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(hasZone ? s : `${s}+08:00`);
  return Number.isFinite(ms) ? ms : null;
}

export interface FlowPoint {
  /** 物理时间，秒 */
  t: number;
  /** 时间步号 */
  step: number;
}

/**
 * 从 transcript 文本里抽出**最后一个** `Flow time = ..s, time step = ..`。
 * 只有推进完一个时间步才会打印这一行，所以它天然就是"已完成步数"。
 */
export function parseFlowTime(text: string): FlowPoint | null {
  let last: FlowPoint | null = null;
  const re = /Flow time\s*=\s*([\d.eE+-]+)s,\s*time step\s*=\s*(\d+)/g;
  for (const m of text.matchAll(re)) {
    last = { t: Number(m[1]), step: Number(m[2]) };
  }
  return last;
}

/** 作业类型。判据来自**内容**（文件名只当兜底，工作目录是共用的、名字可能是别的作业的）。 */
export type JobKind = 'fluent' | 'openfoam';

/**
 * OpenFOAM 求解器日志里的时间行：`Time = 0.55`。每推进一步打印一行。
 *
 * 与渲染器 `GATE-SOLVER` 里的 grep 是同一个锚点（`'^Time = '`），别改成"包含 Time ="——
 * OpenFOAM 的日志里还有 `ExecutionTime = 12.3 s  ClockTime = 11 s`、`Time = 0.55` 之外
 * 还有 `deltaT = ...`、`Courant Number ...`，用宽松的锚点会读进不相干的数字。
 */
const OF_TIME_RE = /^Time = ([0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?)[ \t]*$/gm;

/**
 * 从 OpenFOAM 日志里抽时间行。
 *
 * ⚠ **`first` / `last` 是"这一页里的首末"，不是作业全程的首末** —— DOM 读的是尾页。
 * 只有当你读的是整份日志时它才等于全程首末（渲染器里 `grep -hE '^Time = ' | head -1` 就是那种用法）。
 * 这里只用 `last`（"现在到底推进到哪"），`count` 只当"这页里有几行"的弱信号用。
 */
export function parseOpenfoamTimes(text: string): { first: number; last: number; count: number } | null {
  const times: number[] = [];
  for (const m of text.matchAll(OF_TIME_RE)) times.push(Number(m[1]));
  if (times.length === 0) return null;
  return { first: times[0]!, last: times[times.length - 1]!, count: times.length };
}

/**
 * 从 `system/controlDict` 的文本里读 `endTime`。
 *
 * 为什么值得多读一个文件：OpenFOAM 作业的"还剩多少"必须有个靶子，而 endTime 就是这一轮
 * 真正的目标时刻——渲染器会把它写进 controlDict（续算那轮还会 `sed` 改写），所以读它比
 * 从模板里猜可靠。**只在字面量是纯数字时当数用**：OpenFOAM 的字典允许 `#calc`、变量引用
 * 一类写法，读不动的就返回 null（不给 ETA，而不是给一个假的）。
 */
export function parseEndTime(text: string): number | null {
  const m = /^[ \t]*endTime[ \t]+([0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?)[ \t]*;/m.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * 认作业类型。**内容优先**，只在内容认不出来时调用方才退回文件名。
 *
 * 顺序有讲究：Fluent 的判据（`Flow time = <t>s, time step = <N>`）最专一，先认它，
 * 免得某个恰好也打 `Time = ...` 的 Fluent 转录被 OpenFOAM 的锚点抢走。
 */
export function detectJobKind(text: string): JobKind | null {
  if (!text) return null;
  if (/Flow time\s*=\s*[\d.eE+-]+s,\s*time step\s*=\s*\d+/.test(text)) return 'fluent';
  if (/^Time = /m.test(text)) return 'openfoam';
  if (/\bGATE-(?:ENV|UNPACK|MESH|SETFIELDS|DECOMPOSE|LAUNCHER|SOLVER|RESTART)\b/.test(text)) return 'openfoam';
  if (/=== OPENFOAM RUN END|FOAM FATAL|WM_PROJECT_VERSION/.test(text)) return 'openfoam';
  return null;
}

/**
 * 从 `stdout.<jobId>` 里取算例目录的绝对路径。
 *
 * 渲染器 GATE-UNPACK 那行打的是 `GATE-UNPACK OK  $CASE`，而 `$CASE="$PWD/${caseSubdir}"`，
 * caseSubdir 缺省是 `.`，于是实测量到的是 `.../of-verify-s1b/.` —— 末尾这层 `/.'` 要去掉。
 * 取最后一个匹配：日志里可能出现多次（比如后续再解包），最后那次才是当前算例。
 */
export function openfoamCaseDir(stdoutText: string): string | null {
  let last: string | null = null;
  for (const m of stdoutText.matchAll(/^GATE-UNPACK OK[ \t]+(.+?)[ \t]*$/gm)) last = m[1]!;
  if (!last) return null;
  const p = last.replace(/\/\.$/, '').replace(/\/+$/, '');
  return p.length > 0 ? p : null;
}

/**
 * 从 `stdout.<jobId>` 里取求解器日志的文件名。
 *
 * 新版渲染器在起求解器前打 `--- <solver> -parallel  (np=N)  日志 <_slog>`，`_slog` 带上
 * 分支后缀（`log.interFoam.fresh` / `log.interFoam.restart`）。**旧版渲染器没打这一行**
 * （作业 67916044 的 stdout 里就没有），所以取不到时要退到按文件名 + 时间窗挑。
 */
export function openfoamLogName(stdoutText: string): string | null {
  let last: string | null = null;
  for (const m of stdoutText.matchAll(/日志[ \t]+(\S+)/g)) last = m[1]!;
  return last !== null && SOLVER_LOG_RE.test(last) ? last : null;
}

/**
 * 「作业在跑，但还没找到进度文件」这一句话该怎么说。**必须分类型**——这就是 2026-09-17
 * 要修的那条假警报：原判据只认 Fluent 的 `.trn`，喂给它一个 OpenFOAM 作业时会说
 * "工作目录里还没有 .trn"，而 **OpenFOAM 永远不会有 .trn**（它的进度在
 * `log.<solver>.<fresh|restart>` 里）。把判据抽成纯函数，就是为了能离线钉住
 * "不许再合回一句通吃的文案"——这种回归在真实作业上要花一个作业才看得见。
 */
export function missingProgressRisk(kind: JobKind | null): string {
  if (kind === 'openfoam') {
    return '作业在跑，但还没找到 OpenFOAM 求解器日志（log.<solver>.<fresh|restart>）：'
      + '建网格/分区/挑 launcher 那几分钟本来就没有它，若已跑很久则要看看算例是不是不在 workDir 里';
  }
  if (kind === 'fluent') {
    return '作业在跑，但工作目录里还没有 .trn：可能还没到 Fluent 启动，或工作目录不对';
  }
  return '作业在跑，但工作目录里既没有 Fluent 的 .trn，也没有 OpenFOAM 的 log.<solver>.<fresh|restart>：'
    + '进度无从谈起，先确认 workDir 对不对';
}

/**
 * 进度文本里"有没有致命行"。
 *
 * 【为什么不能一句正则了事】OpenFOAM 求解器**每次正常启动**都会打一行：
 *   `trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE).`   ← v2212 实测原文
 * （别的版本写作 `sigFpe : Enabling floating point exception trapping (FOAM_SIGFPE).`）
 * 它既含 `sigFpe` 又含 `Floating point exception`——任何把这两个当致命指纹的正则都会把它吃进去，
 * 于是**每个健康的 OpenFOAM 作业一开跑就报"有致命行"**。2026-09-17 在真作业 67942379 上实测到
 * 这条假警报（那次还同时暴露了"把日志头当尾读"的方向 bug，所以读到的正是这行启动横幅）。
 *
 * 判据按**行**来：命中 `(FOAM_SIGFPE)` 的行是启动横幅，跳掉；其余照旧。
 * 真崩的指纹另加 `sigHandler`（FOAM_SIGFPE 打开时 FPE 的栈帧里必有它）与 `core dumped`。
 */
const FATAL_LINE_RE = /FATAL|Error Object|Segmentation fault|sigFpe|sigHandler|Floating point exception|core dumped/i;

export function hasFatalLine(text: string): boolean {
  return text.split('\n').some((l) => FATAL_LINE_RE.test(l) && !/FOAM_SIGFPE/.test(l));
}

/**
 * 采样点。存盘后下一次就能算速率。
 *
 * 【跨版本兼容】`kind` / `logBytes` 是 2026-09-17 加的。老采样点里没有它们——那时只有
 * Fluent，所以缺省按 `fluent` + `trnBytes` 解释，别把 `undefined` 当第三种类型。
 */
export interface WatchSample {
  at: number;
  state: string;
  runTimeSec: number | null;
  step: number | null;
  flowTime: number | null;
  trnBytes: number | null;
  /** OpenFOAM 求解器日志的字节数（Fluent 用 `trnBytes`）。 */
  logBytes?: number | null;
  /** 本次采样认定的作业类型。缺省（老采样点）＝ `fluent`。 */
  kind?: JobKind | null;
  /**
   * 本作业**第一次采样**看到的步号。
   * 为什么要它：从 dat 续算时，Fluent 一读进 data 就已经站在重启时刻的那一步上了
   * （实测 /file/read-data 之后 transcript 里立刻有 `Flow time = 2.93s, time step = 7871`），
   * 所以"步号非空"**不代表**已经开始推进。判断"有没有真的往前走"必须跟这个基线比。
   */
  baselineStep?: number | null;
}

/**
 * 启动宽限期（秒）。实测 28 核读 48.6 MB 算例 + Metis 分区 198 万单元 + 读 771.7 MB dat
 * 一共 78 秒；核数越多这段通常越长。宽限期内"步号没动"是正常的，不报风险——
 * 否则计划任务每次都会在启动阶段误报一次，狼来了喊多了就没人看了。
 *
 * 这条不只用于"没推进"，也用于"还没看到进度文件"：OpenFOAM 作业在建网格、分区、
 * 挑 launcher 那几分钟里**本来就没有** `log.<solver>.*`，那时候报"找不到日志"是假警报。
 */
export const STARTUP_GRACE_SEC = 300;

/**
 * 两次采样之间的最小间隔（秒）。
 *
 * 【为什么必须有这条，2026-09-14 加】
 * 速率是 `(now - prev.at) / (step - prev.step)`。原来只要 `dStep > 0` 就算，
 * 于是"两个调用方几乎同时来问"会算出**极小的时间差**，甚至 `dStep === 0` ——
 * 后者会走到下面那条分支，报出 `时间步没推进` 这个**假警报**（作业其实好得很）。
 * 单个 CLI 手动敲不会碰到（人手不可能 3 秒内敲两次），
 * 但**服务形态一定会**：HTTP 有两个客户端、MCP 里模型连着调两次 `watch`，
 * 都会立刻踩上。所以判据得放在这一层，而不是靠调用方自觉。
 *
 * 语义（三条一起看）：
 *   1. 间隔 < 这个值：不算速率、不报"没推进"、**也不覆盖已存的采样点**——
 *      这样下一次够间隔的采样仍然拿得到有意义的差值。
 *   2. 间隔 >= 这个值：正常算速率并落盘。
 *   3. 第一次采样（没有 prev）：照常落盘，作为基线。
 * 默认 30 秒：一个 30 秒/步量级的作业，30 秒里步号大概率至少动一格；
 * 动不了也不该由一次 3 秒的窗口来定罪。这是个**保守**取值，宁可晚一轮报警。
 */
export const MIN_RESAMPLE_SEC = 30;

/** 采样节流的判据（纯函数，离线可测）。 */
export function resampleDecision(
  prevAt: number | null,
  now: number,
  minGapSec = MIN_RESAMPLE_SEC,
): { tooSoon: boolean; sincePrevSec: number | null; retryInSec: number | null } {
  if (prevAt === null) return { tooSoon: false, sincePrevSec: null, retryInSec: null };
  const sincePrevSec = (now - prevAt) / 1000;
  const tooSoon = sincePrevSec < minGapSec;
  return {
    tooSoon,
    sincePrevSec,
    retryInSec: tooSoon ? Math.max(0, Math.ceil(minGapSec - sincePrevSec)) : null,
  };
}

/**
 * 速率。**两种作业量的不是同一个东西，所以是判别联合**——不要合回一个 `secPerStep`：
 * OpenFOAM 按物理时间推进，`Time = 0.55` 里那个数是**物理时间**，不是步号，
 * 报成"秒/步"就是把两种口径混在一个字段名里，读到的人必然误读。
 */
export type WatchRate =
  | {
      kind: 'step';
      secPerStep: number;
      stepsPerHour: number;
      /** 采样基准：与哪一次采样做的差 */
      from: string;
      overSteps: number;
    }
  | {
      kind: 'simTime';
      /** 每推进一个单位物理时间要多少秒墙钟 */
      secPerSimTime: number;
      /** 每小时推进多少物理时间 */
      simTimePerHour: number;
      from: string;
      overSimTime: number;
    };

/** ETA。同 `WatchRate`：Fluent 的靶子是"本批还差多少步"，OpenFOAM 的靶子是 controlDict 的 endTime。 */
export type WatchEta =
  | {
      kind: 'step';
      stepsLeft: number;
      seconds: number;
      finishAt: string;
      /** ETA 能不能塞进剩余墙钟 */
      fitsInWalltime: boolean | null;
    }
  | {
      kind: 'simTime';
      /** 离 endTime 还差多少物理时间 */
      simTimeLeft: number;
      /** 靶子（controlDict 里的 endTime） */
      endTime: number;
      seconds: number;
      finishAt: string;
      fitsInWalltime: boolean | null;
    };

export interface WatchReport {
  /**
   * `@2`：`rate` / `eta` 从"一个固定形状"改成了判别联合（OpenFOAM 没有步号），
   * 顶层多了 `kind`。读到 `@1` 的第三方代码要按新形状取值，所以版本号必须动。
   */
  schema: 'scnet-client/watch@2';
  jobId: string;
  sampledAt: string;
  state: string;
  /** 认出来的作业类型；`null`＝还没能判定（例如作业刚起、stdout 与日志都还空着）。 */
  kind: JobKind | null;
  /** 一切正常＝true；有 risk 或终态失败＝false */
  healthy: boolean;
  verdict: string;
  /** 真正可信的"已跑多久"：由 StartTime 算出来（接口里的 RunTime 是滞后的） */
  elapsedSec: number | null;
  /** 接口给的 RunTime，原样保留用于交叉核对（实测会滞后好几分钟） */
  runTimeSec: number | null;
  walltimeSec: number | null;
  walltimeLeftSec: number | null;
  nodes: string | null;
  exitCode: string | null;
  reason: string | null;
  progress: {
    /** Fluent 的时间步号。OpenFOAM 没有这个刻度，一律 null。 */
    step: number | null;
    /** 物理时间。Fluent 取 `Flow time`，OpenFOAM 取求解器日志末行 `Time = ` 的值。 */
    flowTime: number | null;
    /** 本批目标的绝对步号（需要 --steps 才给；**只对 Fluent 有意义**） */
    targetStep: number | null;
    stepsDoneInBatch: number | null;
    pct: number | null;
  };
  rate: WatchRate | null;
  eta: WatchEta | null;
  files: {
    trn?: { name: string; size: number };
    /** OpenFOAM 的求解器日志。`dir` 是它的绝对目录（算例可能在 workDir 的子目录里）。 */
    openfoamLog?: { name: string; size: number; dir: string };
    stdout?: { name: string; size: number };
    errorLogs: Array<{ name: string; size: number }>;
  };
  risks: string[];
  /**
   * 这次采样对"速率基准"做了什么。**服务/多调用方场景必须读这个字段**：
   * `persisted=false` 表示距上次采样不足 `MIN_RESAMPLE_SEC`，本次没有更新基准点，
   * 因此 `rate` 一定是 null（不是零速度，是"这次测不出来"）。
   */
  sample: {
    persisted: boolean;
    sincePrevSec: number | null;
    minGapSec: number;
    retryInSec: number | null;
  };
}

function watchDir(): string {
  // 基准点落在 SCNET_STATE_DIR 下（默认跟着凭据目录走，见 auth.ts 的 resolveStateDir）——
  // 容器里凭据目录是只读挂载，
  // 写不进去就会让整个 watch 报 EROFS，见 auth.ts 里 STATE_DIR 的注释。
  const d = process.env.SCNET_WATCH_DIR ?? join(STATE_DIR, 'watch');
  mkdirSync(d, { recursive: true });
  return d;
}

function loadSample(jobId: string): WatchSample | null {
  try {
    return JSON.parse(readFileSync(join(watchDir(), `${jobId}.json`), 'utf8')) as WatchSample;
  } catch {
    return null;
  }
}

/** 落盘基准点。返回**是否真的写成功**——报告里的 `sample.persisted` 用它，不靠猜。 */
function saveSample(jobId: string, s: WatchSample): boolean {
  try {
    writeFileSync(join(watchDir(), `${jobId}.json`), JSON.stringify(s, null, 2));
    return true;
  } catch (e) {
    console.error(`[scnet] watch 基准点写不进去（${(e as NodeJS.ErrnoException).code}），本次仍照常报告，但下次算不出速率。`);
    return false;
  }
}

// ── 报告组装 ───────────────────────────────────────────────────────────────

const TERMINAL_OK = new Set(['COMPLETED']);
const TERMINAL_BAD = new Set(['FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY', 'BOOT_FAIL', 'DEADLINE', 'PREEMPTED']);

export interface WatchOpts {
  /**
   * 本批还要推进多少步；给了才有批内进度和 ETA。
   *
   * **只对 Fluent 有意义**：OpenFOAM 按物理时间推进，没有"步"这个刻度，传了也不参与计算
   * （`progress.targetStep` 保持 null，ETA 改按 controlDict 的 endTime 算）。
   * 不做"静默当成别的东西"——那样两个界面会给出同一字段的两种含义。
   */
  steps?: number;
  /** 不落采样点（只读一眼，不污染速率基准） */
  noPersist?: boolean;
}

/**
 * 一个远端条目"有多新"，用于排序。优先用平台给的 `lastModifiedTime`
 * （形如 `2026-09-14 14:56:41`，**没有时区后缀**，按北京时间补 `+08:00`）；
 * 拿不到就退到文件名里的时间戳（`fluent-YYYYMMDD-HHMMSS-<pid>.trn`，字典序即时间序）。
 * 排序只需要单调，但补齐时区才能正确做差，所以两步都做全。
 */
function entryTimeMs(e: RemoteEntry): number {
  const raw = e.lastModifiedTime;
  if (raw) {
    const s = String(raw).trim().replace(' ', 'T');
    const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) ? s : '';
    if (iso) {
      const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}+08:00`;
      const t = Date.parse(withZone);
      if (Number.isFinite(t)) return t;
    }
  }
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(e.name);
  if (m) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** 按"最新"排序取第一条（并列时按名字倒序兜底，保证结果稳定）。 */
function newestFirst<T extends RemoteEntry>(xs: T[]): T | undefined {
  return xs
    .slice()
    .sort((a, b) => entryTimeMs(b) - entryTimeMs(a) || b.name.localeCompare(a.name))[0];
}

/** 只从文件名里解出 Fluent 的启动时刻（`fluent-YYYYMMDD-HHMMSS-<pid>.trn`），解不出返回 0。 */
function nameStartMs(e: RemoteEntry): number {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(e.name);
  if (!m) return 0;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 挑出"当前这次作业正在写"的那份 transcript。
 *
 * 【2026-09-14 实测踩到的坑，代价很高，而且踩了两次】
 * 第一版的判据是"挑最大的那份"，理由写的是"正在跑的那个会一直长"。它在 28 核那批作业上
 * 挑错了：工作目录里同时躺着当天早先留下的 `fluent-20260914-114138-20446.trn`（842 KB，
 * 早已写完不动）和本次作业的 `fluent-20260914-144722-13778.trn`（139 KB，正在长）。
 * 挑大的 → 永远读那份死的，于是 `watch` 连报两次"时间步没推进"，而作业其实在正常推进。
 *
 * 改成"挑 mtime 最新的"之后又踩了第二次：**这个工作目录是被所有作业共用的**
 * （`scnet-runs/fluent-case`），28 核跑完、56 核的 probe 一提交，最新的一份 `.trn`
 * 就变成**别人的**了——那份 probe 的时刻表里没有 `Flow time` 行，于是绝对步号解析成空。
 *
 * 所以最终判据是三条一起用：
 *   1. 只考虑 `.trn`；
 *   2. 用作业自己的 `StartTime` / `EndTime` 把窗口卡住——
 *      transcript 的改动时间必须落在 [StartTime − 5 分钟, EndTime + 30 秒] 内。
 *      前面留 5 分钟是启动宽限（Fluent 起来到写第一行有延迟）；后面只留 30 秒，
 *      **不能留多**——留 2 分钟时，紧接着提交的下一个作业（实测只隔 8 秒）就会漏进来。
 *   3. 在窗口内的候选里取**最新**的那份。
 * 窗口内一个都没有（例如接口没给时间）时，退化成"全体取最新"，但那时调用方应当知道
 * 这条判据是弱的。
 *
 * **已知限制，必须写下来**：`.trn` 文件名里**没有作业号**，只有 Fluent 自己启动的时刻。
 * 所以"上一个作业刚结束、下一个作业立刻提交"这种情形，光靠时间窗口分不干净——
 * 真正的解法是**每个作业给一个自己的工作目录**（`scnet-runs/<算例>/<批次>/`），
 * 而不是把挑文件的判据越写越聪明。顺序提交时本函数够用；
 * 万一挑错了，`watchJob` 会因为"读到了 .trn 但没有 Flow time 行"报一条风险，
 * 而不是安静地显示"第  步"。
 */
export function pickTranscript(
  entries: RemoteEntry[],
  window: { startMs?: number } = {},
): RemoteEntry | undefined {
  const trns = entries.filter((f) => /^fluent-.*\.trn$/.test(f.name));
  if (trns.length === 0) return undefined;
  const { startMs } = window;

  // 主判据：**文件名里的启动时刻要贴着作业的 StartTime**。
  // 为什么不用"改动时间落在 [StartTime, EndTime]"：一是 EndTime 不一定在返回里，
  // 二是紧挨着的下一个作业会落进同一个窗口（实测上一个结束、下一个 8 秒后就提交）。
  // 而"Fluent 启动时刻 ≈ 作业 StartTime + 几十秒"这条对**运行中**和**已结束**的作业都成立，
  // 也不受后续作业影响——这才是区分"谁是谁"的那一维。
  // （这条是踩了两次之后才定下来的：先是按体积挑错，再是按 mtime 挑到别人的。）
  if (startMs !== undefined) {
    const near = trns.filter((f) => {
      const t = nameStartMs(f);
      return t > 0 && t >= startMs - STARTUP_GRACE_SEC * 1000 && t <= startMs + 600_000;
    });
    if (near.length > 0) return newestFirst(near);
  }
  return newestFirst(trns);
}

/**
 * 挑出本次作业的 stdout。
 *
 * 【同一次实测的第二个坑】原来是 `entries.find(f => f.name.startsWith('stdout.'))`——
 * 取的是目录里的**第一条**，在这个目录里恰好是上一次 probe 作业的 `stdout.67305315`，
 * 于是报告里引用的读数来自另一个作业。现在先精确匹配 `stdout.<jobId>`，
 * 匹配不到再退到"最新的那条 stdout"（并让调用方知道没精确命中）。
 */
export function pickStdout(entries: RemoteEntry[], jobId: string): RemoteEntry | undefined {
  const exact = entries.find((f) => f.name === `stdout.${jobId}`);
  if (exact) return exact;
  return newestFirst(entries.filter((f) => /^stdout\.\d+$/.test(f.name)));
}

/**
 * OpenFOAM 求解器日志的文件名。渲染器保证是这个形状（见 `openfoam.ts` 的 `_slog`）。
 *
 * **必须排掉 `log.reconstructPar.<tag>`**：它由同一个 `$_tag` 拼出来，形状与求解器日志
 * 一模一样（`reconstructPar` 也全是 `[A-Za-z0-9_]`），而且它是求解器**之后**才写的、
 * mtime 永远更新——按"取最新"会稳稳挑中它，然后进度里一行 `Time = ` 都读不到。
 * 这个洞是写测试时抓到的（`test/watch-openfoam.test.mjs`），别把负向先行断言删了。
 */
export const SOLVER_LOG_RE = /^log\.(?!reconstructPar\.)[A-Za-z0-9_]+\.(fresh|restart)$/;

/**
 * 挑出本次作业的 OpenFOAM 求解器日志。
 *
 * 判据与 `.trn` 那条同源，但这里更硬一点：**工作目录/算例目录是所有作业共用的**，
 * 上一轮的 `log.interFoam.fresh` 会一直躺在那里，这一轮的续算写的是
 * `log.interFoam.restart`（渲染器 2026-09-17 才改成按分支命名；在那之前续算会**覆盖**
 * 新鲜那轮的日志）。所以：
 *   1. 只考虑 `log.<solver>.<fresh|restart>`——`log.blockMesh` / `log.reconstructPar.*`
 *      这些中间步骤的日志不在候选里（它们的名字长得像，但不会带 `.fresh` 后缀）；
 *   2. 有 `StartTime` 就只要改动时间不早于 `StartTime − 宽限` 的（同一目录里上一轮的日志
 *      一定比这早）；
 *   3. 在剩下的里取**最新**的——正在写的那个 mtime 一直在长。
 *
 * 调用方若已经从 stdout 里读出了准确的文件名（`日志 log.interFoam.restart`），
 * 应当直接用那个名字，别走这里：名字比 mtime 硬。
 */
export function pickSolverLog(
  entries: RemoteEntry[],
  window: { startMs?: number } = {},
): RemoteEntry | undefined {
  const logs = entries.filter((f) => SOLVER_LOG_RE.test(f.name));
  if (logs.length === 0) return undefined;
  const { startMs } = window;
  if (startMs !== undefined) {
    const fresh = logs.filter((f) => {
      const t = entryTimeMs(f);
      return t > 0 && t >= startMs - STARTUP_GRACE_SEC * 1000;
    });
    if (fresh.length > 0) return newestFirst(fresh);
  }
  return newestFirst(logs);
}

export async function watchJob(ep: Endpoints, jobId: string, o: WatchOpts = {}): Promise<WatchReport> {
  const now = Date.now();
  const detail: JobDetail = await getJob(ep, jobId);
  const state = (detail.jobState ?? detail.jobStatus ?? 'UNKNOWN').toUpperCase();

  const risks: string[] = [];
  const files: WatchReport['files'] = { errorLogs: [] };
  let kind: JobKind | null = null;
  /** 进度文本（Fluent：stdout / .trn；OpenFOAM：求解器日志尾页）。 */
  let text = '';
  let stdoutText = '';
  let endTime: number | null = null;

  // 工作目录：先看调度器给的那份，其次按家目录猜一个同名的也算不上可靠，所以只信调度器
  const workDir = detail.workDir;
  if (workDir) {
    // 必须列全：工作目录是所有作业共用的，某些作业会在里面堆上千个文件，
    // 单页 limit=1000 会把本作业那份 .trn 漏掉，然后报出"没有 Flow time"的假风险。
    const { entries } = await listDirComplete(ep, workDir);
    // 这个工作目录是所有作业共用的，所以必须用本作业的起止时刻把候选 .trn 卡在窗口里，
    // 否则"最新那份"很容易是别人的（28 核跑完、56 核 probe 一提交就发生过）。
    const initAttr = (detail.jobInitAttr ?? {}) as Record<string, unknown>;
    // 起止时刻**不在详情接口里**（实测 2026-09-14：详情返回的 jobInitAttr 整个缺省，
    // 只有 jobStatus/jobState/runTime/reason/workDir），它在**实时列表**的 jobStartTime 上。
    // 拿不到就退化成"取最新"，那时 watchJob 会因为没有 Flow time 行而报风险。
    let startMs = parsePlatformTime(initAttr.StartTime as string | undefined);
    if (startMs === null) {
      try {
        const js = await listJobs(ep, { limit: 25 });
        const item = js.list.find((x) => String(x.jobId) === String(jobId));
        startMs = parsePlatformTime(item?.jobStartTime);
      } catch {
        startMs = null;
      }
    }

    const out = pickStdout(entries, jobId);
    if (out) files.stdout = { name: out.name, size: Number(out.size) };
    // stdout 先读**头部**：文件名里带作业号，不存在"挑错文件"这回事，而且两类作业的
    // "我是谁、算例在哪"都写在开头（GATE-ENV OK / GATE-UNPACK OK / FRESH= / 日志名）。
    if (out && Number(out.size) > 0) {
      try {
        const r = await readRemoteText(ep, `${workDir}/${out.name}`, 1, 'UP');
        stdoutText = r.text ?? '';
      } catch {
        risks.push('读 stdout 失败（不影响判活，下面退回别的来源试一次）');
      }
    }

    const trn = pickTranscript(entries, { startMs: startMs ?? undefined });
    if (trn) files.trn = { name: trn.name, size: Number(trn.size) };
    files.errorLogs = entries
      .filter((f) => /^fluent-\d+-error\.log$/.test(f.name) && Number(f.size) > 0)
      .map((f) => ({ name: f.name, size: Number(f.size) }));

    // 类型判定：内容优先（stdout 里两类作业的指纹都很硬），内容认不出来才退回文件名。
    kind = detectJobKind(stdoutText);
    if (kind === null) {
      if (files.trn || files.errorLogs.length > 0) kind = 'fluent';
      else if (pickSolverLog(entries, { startMs: startMs ?? undefined })) kind = 'openfoam';
    }

    if (kind === 'openfoam') {
      // 算例目录：渲染器在 stdout 里明写 `GATE-UNPACK OK  <CASE 绝对路径>`，直接取用。
      // 取不到（旧渲染器/别的来源写的脚本）就假定算例就在 workDir 里。
      const caseDir = openfoamCaseDir(stdoutText) ?? workDir;
      let caseEntries: RemoteEntry[] = entries;
      if (caseDir !== workDir) {
        try {
          caseEntries = (await listDirComplete(ep, caseDir)).entries;
        } catch {
          risks.push(`列不出算例目录 ${caseDir}（stdout 里 GATE-UNPACK OK 给的路径），OpenFOAM 进度这次拿不到`);
          caseEntries = [];
        }
      }
      const want = openfoamLogName(stdoutText);
      const log = (want ? caseEntries.find((f) => f.name === want) : undefined)
        ?? pickSolverLog(caseEntries, { startMs: startMs ?? undefined });
      if (log) {
        files.openfoamLog = { name: log.name, size: Number(log.size), dir: caseDir };
        // 读**尾页**：OpenFOAM 每推进一步打一行 `Time = `，只有末尾那几行是"现在"。
        // （这与 Fluent 读 stdout 头部不矛盾：那边要的是"我是谁"，这边要的是"到哪了"。）
        // ⚠ 方向是 `'UP'`＝**尾部**、`'DOWN'`＝**头部**（平台侧参数名是 rollDirection）。
        // 这里我第一版抄了 Fluent 分支的 `'DOWN'`，于是读的是日志**开头**：
        // 进度永远停在重启时刻附近（实测 0.550217 而当时已经 0.55x），而且读进去的是
        // 启动横幅（顺带触发了下面那条"有致命行"的假警报）。2026-09-17 在真作业 67942379 上抓到。
        try {
          const r = await readRemoteText(ep, `${caseDir}/${log.name}`, 1, 'UP');
          text = r.text ?? '';
        } catch {
          risks.push(`读 OpenFOAM 求解器日志 ${log.name} 失败（不影响判活，但这次没有进度信息）`);
        }
      }
      // endTime：ETA 的靶子。渲染器会把模板里的 endTime 写进 controlDict（续算那轮是改写），
      // 所以这里读到的就是这一轮真正的目标时刻。读不到就不给 ETA——**不给假的**。
      try {
        const r = await readRemoteText(ep, `${caseDir}/system/controlDict`, 1, 'UP');
        endTime = parseEndTime(r.text ?? '');
      } catch {
        endTime = null;
      }
    } else {
      // Fluent（或还没认出类型）：沿用老判据——进度**优先**读 stdout.<jobId>，
      // 因为文件名里带作业号，不存在"挑错文件"这回事。实测 stdout 与
      // 当次 .trn 内容几乎逐字一致、同步增长，所以它是既可靠又无歧义的进度来源；
      // .trn 只在 stdout 缺失时兜底。
      text = stdoutText;
      if (!text && files.trn) {
        // 方向同 OpenFOAM 那条：`'UP'` 才是尾部。原来写的是 `'DOWN'`（＝头部），于是
        // "stdout 读不到就退回 .trn"这条兜底即使命中，读到的也是这份转录的**第一页**——
        // 步号停在最开始，越用越错。这是 2026-09-17 为 OpenFOAM 分支查方向语义时
        // 顺带发现的同一族错误（见上面 openfoam 分支的注释）。
        try {
          const r = await readRemoteText(ep, `${workDir}/${files.trn.name}`, 1, 'UP');
          text = r.text ?? '';
        } catch {
          risks.push('读 transcript 失败（不影响判活，但这次没有进度信息）');
        }
      }
    }
  } else {
    risks.push('调度器没给 workDir，无法查进度');
  }

  // 进度读数：Fluent 的步号/物理时间来自 `Flow time`，OpenFOAM 只有物理时间（`Time = `）。
  const flow = kind === 'openfoam' ? null : parseFlowTime(text);
  const ofTimes = kind === 'openfoam' ? parseOpenfoamTimes(text) : null;
  const flowTime = flow?.t ?? ofTimes?.last ?? null;
  const runTimeSec = hmsToSec(detail.runTime);
  const walltimeSec = hmsToSec((detail.raw?.data as Record<string, unknown> | undefined)?.walltimeReq as string | undefined);

  // 已跑多久：用 StartTime 现算，RunTime 当兜底。
  // 【实测·2026-09-14，别把这条写成"RunTime 是坏的"】当场对过一次：
  //   06:50:45Z 采样时 StartTime=14:47:13(北京)=06:47:13Z → 算出 3 分 32 秒，
  //   而同一份返回里的 RunTime=00:03:34，两者只差 2 秒。
  // 也就是说 RunTime 是可用的。选 StartTime 只是因为不依赖"平台多久刷一次这个字段"，
  // 长作业上更不容易慢慢漂。我先前一度以为它滞后好几分钟，那是我自己看错了钟。
  const data = (detail.raw?.data ?? {}) as Record<string, unknown>;
  const init = (data.jobInitAttr ?? {}) as Record<string, unknown>;
  const startMs = parsePlatformTime((init.StartTime ?? data.jobStartTime) as string | undefined);
  const elapsedFromStart = startMs === null ? null : Math.max(0, Math.round((now - startMs) / 1000));
  const elapsedSec = elapsedFromStart ?? runTimeSec;
  const walltimeLeftSec = elapsedSec !== null && walltimeSec !== null ? walltimeSec - elapsedSec : null;

  // 启动宽限："还没看到进度文件"与"没推进"两件事都用它。判不出已跑多久时**往报告的方向倒**
  // （`elapsedSec === null` 当作已过宽限）——宁可多说一句，也不要静默地把异常吞掉。
  const started = elapsedSec ?? 0;
  const pastGrace = elapsedSec === null || started > STARTUP_GRACE_SEC;
  const progressSource = files.openfoamLog?.name ?? files.trn?.name ?? files.stdout?.name ?? '进度文本';

  if (files.errorLogs.length) {
    risks.push(`${files.errorLogs.length} 个 rank 的错误日志非空：${files.errorLogs.map((e) => e.name).join(', ')}`);
  }
  // 读到了 .trn，却解析不出步号——**大概率是读到了别的作业的 transcript**
  // （工作目录是共用的，`.trn` 名字里没有作业号）。让它响，别让它静默变成"第  步"。
  if (files.trn && text && !flow && kind !== 'openfoam' && pastGrace) {
    risks.push(
      `读到了 ${files.trn.name} 但里面没有 "Flow time" 行——` +
        '这份可能不是本作业的 transcript（工作目录被共用时会这样），进度以此为准要打问号',
    );
  }
  // 认出了是 OpenFOAM，却一行 `Time = ` 都没读到：可能是日志刚建、页里还没有时间行，
  // 也可能是挑错了日志（同一算例目录里上一轮的 `log.<solver>.fresh` 还在）。
  if (kind === 'openfoam' && files.openfoamLog && text && !ofTimes && pastGrace) {
    risks.push(
      `读到了 ${files.openfoamLog.name} 的尾页，但里面没有 "Time = " 行——`
      + '这份可能不是本作业的日志（同一算例目录里上一轮的日志还在），进度以此为准要打问号',
    );
  }

  // 致命行。Fluent 的转录与 OpenFOAM 的求解器日志在这里是同一类判据，两边的指纹都认；
  // 判据在 `hasFatalLine()` 里（它要排掉 OpenFOAM 每次启动都会打的那行 FOAM_SIGFPE 横幅）。
  if (hasFatalLine(text)) {
    risks.push(`${progressSource} 里出现了 FATAL / FOAM FATAL / Error Object / Segmentation fault 一类致命行`);
  }

  const terminal = TERMINAL_OK.has(state) || TERMINAL_BAD.has(state);
  const healthy = !TERMINAL_BAD.has(state) && risks.length === 0;

  // ── 速率与 ETA：与上一次采样做差 ──
  const prev = loadSample(jobId);
  // 采样节流（见 MIN_RESAMPLE_SEC）：间隔太近就既不算速率、也不报"没推进"、
  // 也不覆盖基准点。不加这个，两个调用方几乎同时来问就会算出 0 步差值，
  // 报出"时间步没推进"这个假警报；服务形态（HTTP/MCP）一定会碰到。
  const decision = resampleDecision(prev?.at ?? null, now);
  const tooSoon = decision.tooSoon;
  let rate: WatchRate | null = null;
  let eta: WatchEta | null = null;
  const sample: WatchSample = {
    at: now,
    state,
    runTimeSec,
    step: flow?.step ?? null,
    flowTime,
    trnBytes: files.trn?.size ?? null,
    logBytes: files.openfoamLog?.size ?? null,
    kind,
    // 第一次采样时把步号记成基线；以后一律沿用第一次的基线，不要每次覆盖。
    baselineStep: prev?.baselineStep !== undefined ? prev.baselineStep : (flow?.step ?? null),
  };

  if (prev && !terminal && !tooSoon) {
    const dt = (now - prev.at) / 1000;
    const from = new Date(prev.at).toISOString();
    if (kind === 'openfoam') {
      // OpenFOAM：拿物理时间做差。判据与 Fluent 那条同构（都是"动了没有 + 字节长没长"），
      // 只是把"步号"换成"物理时间"。物理时间一步只推进几微秒，所以浮点比较必须严格
      // `> 0`（相等才算没动），不能引入容差——引入容差就等于把"停滞"判成"在跑"。
      const dSim = flowTime !== null && prev.flowTime !== null ? flowTime - prev.flowTime : 0;
      if (state === 'RUNNING' && dSim > 0 && dt > 0) {
        const secPerSimTime = dt / dSim;
        rate = {
          kind: 'simTime',
          secPerSimTime,
          simTimePerHour: 3600 / secPerSimTime,
          from,
          overSimTime: dSim,
        };
      } else if (state === 'RUNNING' && flowTime !== null && prev.flowTime !== null) {
        if (pastGrace) {
          const bytesMoved = (sample.logBytes ?? 0) - (prev.logBytes ?? 0);
          risks.push(bytesMoved === 0
            ? `物理时间没推进（停在 ${flowTime}），求解器日志也没长（已跑 ${Math.round(started / 60)} 分钟）。`
              + '注意日志是分块写盘的，只差一次采样还不能定罪，连看两次才算数'
            : `物理时间没推进（停在 ${flowTime}），但日志还在长：可能卡在某一步的迭代/时间步收敛里（自适应时间步调小属正常）`);
        }
      }
    } else {
      const dStep = sample.step !== null && prev.step !== null ? sample.step - prev.step : 0;
      if (state === 'RUNNING' && dStep > 0 && dt > 0) {
        const secPerStep = dt / dStep;
        rate = {
          kind: 'step',
          secPerStep,
          stepsPerHour: 3600 / secPerStep,
          from,
          overSteps: dStep,
        };
      } else if (state === 'RUNNING' && sample.step !== null && prev.step !== null) {
        // 有步号但没往前走的两种情况要分开看：
        //   a) 还在启动阶段（步号 == 基线，且启动开销还没过完）——正常，不报。
        //      从 dat 续算时一读进 data 就站在重启步上了，所以"有步号"≠"已开始推进"。
        //   b) 启动开销早该过完，却仍然停在基线/原地——那才值得看一眼。
        const movedPastBaseline = sample.baselineStep !== null
          && sample.step !== null
          && sample.step > sample.baselineStep;
        if (started < STARTUP_GRACE_SEC && !movedPastBaseline) {
          // 静默：宽限期内不动是正常的
        } else {
          const bytesMoved = (sample.trnBytes ?? 0) - (prev.trnBytes ?? 0);
          risks.push(bytesMoved === 0
            ? `时间步没推进，transcript 也没长（已跑 ${Math.round(started / 60)} 分钟，基线第 ${sample.baselineStep} 步，`
              + `现在第 ${sample.step} 步）。注意 transcript 是分块写盘的，只差一次采样还不能定罪，连看两次才算数`
            : '时间步没推进，但 transcript 还在长：可能卡在某一步的迭代里（迭代上限内属正常）');
        }
      }
    }
  }

  // 批内进度：以"第一次采样看到的步号"为本批起点。
  // 注意口径——如果你在本批已经跑了一阵之后才开始 watch，pct 是从那一刻算起的，不是从批首算起。
  // 想要精确的批内进度，就在提交后立刻 watch 一次（计划任务的做法就是先跑一次 --once 落基线）。
  let targetStep: number | null = null;
  let stepsDoneInBatch: number | null = null;
  if (kind !== 'openfoam' && o.steps !== undefined && sample.step !== null && sample.baselineStep !== null) {
    targetStep = sample.baselineStep + o.steps;
    stepsDoneInBatch = sample.step - sample.baselineStep;
  }
  if (rate && rate.kind === 'step' && targetStep !== null && sample.step !== null) {
    const stepsLeft = Math.max(0, targetStep - sample.step);
    const seconds = stepsLeft * rate.secPerStep;
    eta = {
      kind: 'step',
      stepsLeft,
      seconds,
      finishAt: new Date(now + seconds * 1000).toISOString(),
      fitsInWalltime: walltimeLeftSec === null ? null : seconds <= walltimeLeftSec,
    };
  } else if (rate && rate.kind === 'simTime' && endTime !== null && flowTime !== null) {
    // OpenFOAM 的靶子是 controlDict 的 endTime（渲染器写进去的那个）。
    const simTimeLeft = Math.max(0, endTime - flowTime);
    const seconds = simTimeLeft * rate.secPerSimTime;
    eta = {
      kind: 'simTime',
      simTimeLeft,
      endTime,
      seconds,
      finishAt: new Date(now + seconds * 1000).toISOString(),
      fitsInWalltime: walltimeLeftSec === null ? null : seconds <= walltimeLeftSec,
    };
  }
  if (eta && eta.fitsInWalltime === false && walltimeLeftSec !== null) {
    risks.push(
      `按当前速率还要 ${(eta.seconds / 3600).toFixed(1)} h，但墙钟只剩 ${(walltimeLeftSec / 3600).toFixed(1)} h：`
      + '这一批会被调度器砍掉。要么加 walltime，要么减小每批步数/目标时刻（restart 会从最后一次 save 接着跑）。',
    );
  }

  if (state === 'PENDING') {
    risks.push('还在排队（PENDING）；运行时长从 0 开始，进度无从谈起');
  }
  // "在跑但还没有进度文件"要**分类型**说，而且要给启动宽限——判据在 `missingProgressRisk()`。
  // 原判据只认 Fluent 的 `.trn`，喂给它一个 OpenFOAM 作业时会抱怨"没有 .trn"，
  // 而那是**假警报**（OpenFOAM 永远不会有 .trn）。这是 2026-09-17 要修的那条。
  if (state === 'RUNNING' && pastGrace) {
    const missing = (kind === 'fluent' && !files.trn)
      || (kind === 'openfoam' && !files.openfoamLog)
      || (kind === null && !files.trn && !files.openfoamLog);
    if (missing) risks.push(missingProgressRisk(kind));
  }
  if (TERMINAL_BAD.has(state)) {
    risks.push(`调度器终态 ${state}${detail.reason ? `（Reason: ${detail.reason}）` : ''}`);
  }

  const verdict = TERMINAL_OK.has(state)
    ? '已完成'
    : TERMINAL_BAD.has(state)
      ? `终态失败：${state}`
      : state === 'PENDING'
        ? '排队中'
        : state === 'RUNNING'
          ? (risks.length ? '在跑，但有需要看的风险' : '在跑，正常')
          : `状态 ${state}`;

  // 距上次采样太近时不落盘：保住那个还有意义的基准点。
  // 落盘是否真的成功由 saveSample 回报——`persisted` 以前只反映"我们打算写"，
  // 写失败（只读挂载）时它照样报 true，等于骗了下一次采样。
  const persisted = !o.noPersist && !tooSoon && saveSample(jobId, sample);

  return {
    schema: 'scnet-client/watch@2',
    jobId: String(jobId),
    sampledAt: new Date(now).toISOString(),
    state,
    kind,
    healthy: healthy && !TERMINAL_BAD.has(state),
    verdict,
    elapsedSec,
    runTimeSec,
    walltimeSec,
    walltimeLeftSec,
    nodes: detail.raw?.data ? (String((detail.raw.data as Record<string, unknown>).nodeUsed ?? '') || null) : null,
    exitCode: detail.exitCode ?? null,
    reason: detail.reason ?? null,
    progress: {
      step: sample.step,
      flowTime: sample.flowTime,
      targetStep,
      stepsDoneInBatch,
      pct: targetStep !== null && stepsDoneInBatch !== null && o.steps
        ? Math.max(0, Math.min(100, (100 * stepsDoneInBatch) / o.steps))
        : null,
    },
    rate,
    eta,
    sample: {
      persisted,
      sincePrevSec: decision.sincePrevSec,
      minGapSec: MIN_RESAMPLE_SEC,
      retryInSec: decision.retryInSec,
    },
    files,
    risks,
  };
}

/** 把物理时间印成人看的样子：0.55 / 0.0015 这种短数，别甩一串浮点尾巴。 */
function fmtSimTime(x: number): string {
  return String(Number(x.toPrecision(8)));
}

/** 人读的一版：分条短句，手机上也看得清（QQ 通道要求 markdown→自然语言）。 */
export function formatWatch(r: WatchReport): string {
  const hm = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  const L: string[] = [];
  L.push(`作业 ${r.jobId}：${r.verdict}`);
  L.push(`状态：${r.state}${r.healthy ? '（健康）' : '（有问题）'}${r.kind ? `，类型 ${r.kind}` : ''}`);
  if (r.elapsedSec !== null) {
    L.push(`已跑：${hm(r.elapsedSec)}${r.walltimeSec !== null ? `，墙钟上限 ${hm(r.walltimeSec)}，剩 ${hm(Math.max(0, r.walltimeLeftSec ?? 0))}` : ''}`);
  }
  if (r.nodes) L.push(`节点：${r.nodes}`);
  if (r.kind === 'openfoam') {
    // OpenFOAM 没有步号，进度就是"物理时间推到哪了"，来源必须写出来（同一算例目录里
    // 上一轮的日志还在，读到哪一份会直接改变这个数）。
    const src = r.files.openfoamLog ? `，取自 ${r.files.openfoamLog.name} 的尾页` : '';
    if (r.progress.flowTime !== null) {
      L.push(`进度：物理时间 ${fmtSimTime(r.progress.flowTime)}${src}`);
    } else if (r.state === 'RUNNING' || r.state === 'COMPLETED') {
      L.push(`进度：还没读到 "Time = " 行${src}`);
    }
  } else if (r.progress.step !== null) {
    const pct = r.progress.pct !== null ? `，本批已完成 ${r.progress.pct.toFixed(1)}%` : '';
    L.push(`进度：第 ${r.progress.step} 步（物理时间 ${r.progress.flowTime}s）${pct}`);
  }
  if (r.rate?.kind === 'step') {
    L.push(`速度：${r.rate.secPerStep.toFixed(1)} 秒/步（${r.rate.stepsPerHour.toFixed(1)} 步/小时，据最近 ${r.rate.overSteps} 步）`);
  } else if (r.rate?.kind === 'simTime') {
    L.push(
      `速度：${r.rate.secPerSimTime.toFixed(1)} 秒/单位物理时间`
      + `（每小时推进 ${fmtSimTime(r.rate.simTimePerHour)}，据最近 ${fmtSimTime(r.rate.overSimTime)} 的物理时间）`,
    );
  }
  if (r.eta) {
    const when = `约 ${new Date(r.eta.finishAt).toISOString().slice(5, 16).replace('T', ' ')} UTC`;
    if (r.eta.kind === 'step') {
      L.push(`预计完成：${hm(r.eta.seconds)} 之后（${when}），剩 ${r.eta.stepsLeft} 步`);
    } else {
      L.push(
        `预计完成：${hm(r.eta.seconds)} 之后（${when}），离 endTime ${fmtSimTime(r.eta.endTime)}`
        + ` 还差 ${fmtSimTime(r.eta.simTimeLeft)} 物理时间`,
      );
    }
    if (r.eta.fitsInWalltime === false) L.push('⚠️ 这批跑不完墙钟，会被砍');
  }
  for (const k of r.risks) L.push(`⚠️ ${k}`);
  return L.join('\n');
}
