/**
 * 作业模板：类型定义、校验、默认值、JSON Schema、GAP_* 映射。
 *
 * 设计原则（重要，别改）：
 *   字段表 SPEC 是**唯一事实来源**，校验 / 默认值 / JSON Schema 三者都从它派生。
 *   以前吃过"三处各写一遍、后来对不上"的亏，所以这里只允许加 SPEC 条目。
 *
 * evidence 字段的语义：
 *   'verified' —— 2026-09-14 的真实作业里用过这个字段（有一份跑通的算例作证）
 *   'untested' —— 接口接受这个字段，但我没用过；报错时优先怀疑它
 *   这个区分是刻意保留的：不要因为"文档里写了"就把它标成 verified。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// ── 字段表 ──────────────────────────────────────────────────────────────────

import { renderOpenfoamCommand, type OpenfoamSpec } from './openfoam.ts';

/**
 * `openfoam` 组的类型在 `./openfoam.ts` 里定义并在这里转出去，让调用方只需 import 本模块。
 * 依赖是单向的：本文件 → openfoam.ts（那边不反向 import 本文件，避免运行时环）。
 */
export type { OpenfoamSpec };

export type FieldType = 'string' | 'number' | 'boolean' | 'stringArray' | 'object' | 'objectArray';

export interface FieldSpec {
  type: FieldType;
  doc: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  evidence?: 'verified' | 'untested';
  fields?: Record<string, FieldSpec>;
  /**
   * 用户没写这一组时，**不要**把它的子字段默认值补出来。
   *
   * 只有"这一组本身就是一种选择"时才加这个标记。`fluent` 就是这种情况：
   * 它和 `command` / `commandFile` 三选一，如果缺省也被补出一个 fluent 组，
   * 那么 `renderCommand()` 会以为用户选了 Fluent，把 command 顶掉——
   * 2026-09-14 实测踩过：模板里只写了 command，实际提交上去的却是
   * `"$_fluent" 3ddp ... -i solve.jou`，作业因为找不到 solve.jou 而 exit 1。
   */
  omitWhenAbsent?: boolean;
}

export const SPEC: Record<string, FieldSpec> = {
  $schema: { type: 'string', doc: '指向 templates/job.schema.json，给编辑器补全用，可删' },
  name: {
    type: 'string',
    required: true,
    doc: '作业名（GAP_JOB_NAME）。会出现在作业列表里，建议带算例标识与序号',
    evidence: 'verified',
  },
  notes: { type: 'string', doc: '给自己看的备注，不会提交到平台' },

  region: {
    type: 'string',
    doc: '目标计算区域：序号（0,1,…）或 clusterName。留空＝第 0 个可用区域',
  },
  jobManagerId: {
    type: 'string',
    default: '',
    doc: '集群调度器 ID（strJobManagerID）。留空＝自动从 /openapi/v2/cluster 获取。注意它不是 clusterId',
    evidence: 'verified',
  },
  queue: {
    type: 'string',
    default: 'xahcnormal',
    doc: '队列名（GAP_QUEUE）。默认值在西安集群实测可用'
      + '——用错队列是最常见的失败原因，换集群前先跑 `scnet probe` 看可用队列',
    evidence: 'verified',
  },

  resources: {
    type: 'object',
    doc: '资源申请',
    fields: {
      nodes: { type: 'number', default: 1, doc: '节点数（GAP_NNODE）。单节点无需 -cnf', evidence: 'verified' },
      cores: {
        type: 'number',
        default: 4,
        doc: '总核数（GAP_NPROC）。实测单节点 28 核跑通过；不设 GAP_NODE_STRING 时按整节点分配',
        evidence: 'verified',
      },
      walltime: {
        type: 'string',
        default: '02:00:00',
        doc: '墙钟上限 HH:MM:SS（GAP_WALL_TIME）。实测 02:00:00 可提交',
        evidence: 'verified',
      },
      exclusive: { type: 'boolean', default: false, doc: '独占节点（GAP_EXCLUSIVE）', evidence: 'untested' },
      ppn: { type: 'number', doc: '每节点进程数（GAP_PPN）', evidence: 'untested' },
      gpus: { type: 'number', doc: 'GPU 数（GAP_NGPU）', evidence: 'untested' },
      dcus: { type: 'number', doc: 'DCU 数（GAP_NDCU）', evidence: 'untested' },
      nodeString: {
        type: 'string',
        default: '',
        doc: '指定节点列表（GAP_NODE_STRING）。给了它就不要再给 nodes：两者互斥，另一个必须留空',
        evidence: 'verified',
      },
    },
  },

  workDir: {
    type: 'string',
    default: '',
    doc: '远端工作目录（GAP_WORK_DIR）。留空＝取第一个 inputs[].remoteDir；'
      + '再没有就是远端家目录。开头的 ~ 会展开成家目录',
    evidence: 'verified',
  },

  inputs: {
    type: 'objectArray',
    doc: '要上传到远端的文件。上传目标目录若不存在，提交前会尝试创建',
    fields: {
      local: { type: 'string', required: true, doc: '本地路径' },
      remoteDir: {
        type: 'string',
        required: true,
        doc: '远端目录。开头的 ~ 展开成家目录（如 ~/runs/001）；不建议写死 /public/home/<用户名>',
      },
      chunkMiB: { type: 'number', default: 8, doc: '单片大小 MiB，覆盖 upload.chunkMiB' },
      cover: { type: 'string', default: 'cover', enum: ['cover', 'uncover'], doc: '同名文件是否覆盖' },
      skipIfSameSize: {
        type: 'boolean',
        default: true,
        doc: '远端已有同名且字节数相同的文件就跳过上传（省时间；大文件重传代价很高）',
      },
    },
  },

  fluent: {
    type: 'object',
    omitWhenAbsent: true,
    doc: 'Fluent 批量任务：由这些参数生成命令行（与 command / commandFile 三选一）',
    fields: {
      installCandidates: {
        type: 'stringArray',
        default: ['$HOME/apprepo/fluent/2023r1-xian', '$HOME/apprepro/fluent/2023r1-xian', '$HOME/appre*/fluent/2023r1-xian'],
        doc: 'FLUENT_ROOT 候选目录，按顺序探测。注意第三项是 shell 通配符，'
          + '脚本里必须不加引号展开——这是之前"fluent binary not found"的直接教训',
        evidence: 'verified',
      },
      binRelPath: {
        type: 'string',
        default: 'app/v231/fluent/bin/fluent',
        doc: '可执行文件相对 FLUENT_ROOT 的路径（2023R1 实测值）',
        evidence: 'verified',
      },
      dimension: { type: 'string', default: '3ddp', doc: '维度与精度，如 3ddp / 3d / 2ddp', evidence: 'verified' },
      mpi: { type: 'string', default: 'intel', doc: '-mpi= 的值', evidence: 'verified' },
      cores: { type: 'number', default: 0, doc: '-t 的值。0＝跟随 resources.cores', evidence: 'verified' },
      journal: { type: 'string', default: 'solve.jou', doc: '-i 的 journal 文件名（相对工作目录）', evidence: 'verified' },
      extraArgs: { type: 'stringArray', default: [], doc: '追加到命令行末尾的参数' },
      env: { type: 'stringArray', default: [], doc: '额外的 export 行，形如 "ANSYSLMD_LICENSE_FILE=..."' },
      preCommands: { type: 'stringArray', default: [], doc: '启动 Fluent 之前要跑的命令' },
      postCommands: { type: 'stringArray', default: [], doc: 'Fluent 退出之后要跑的命令' },
    },
  },

  openfoam: {
    type: 'object',
    omitWhenAbsent: true,
    doc: 'OpenFOAM 求解任务：由这些参数生成远端 shell（含七道门）。与 fluent / command / commandFile 四选一',
    fields: {
      openfoamRoot: {
        type: 'string',
        default: '/public/software/apps/OpenFOAM/v2212/hpcx-gcc-7.3.1/OpenFOAM-v2212',
        doc: 'OpenFOAM 安装前缀（$WM_PROJECT_DIR）。默认值是西安集群 v2212 实测路径',
        evidence: 'verified',
      },
      moduleName: {
        type: 'string',
        default: 'OpenFOAM/v2212-hpcx-gcc-7.3.1',
        doc: 'module load 的名字。注意它只挂了一半 LD_LIBRARY_PATH，'
          + '缺 lib/sys-openmpi ⇒ 渲染器会再 source $APPS/etc/bashrc 补齐，别删那一步',
        evidence: 'verified',
      },
      platform: {
        type: 'string',
        default: 'linux64GccDPInt32Opt',
        doc: 'platforms/<platform> 的目录名，用来定位 lib 与 bin',
        evidence: 'verified',
      },
      solver: { type: 'string', default: 'interFoam', doc: '求解器名（多相 VOF 用 interFoam）', evidence: 'verified' },
      caseSubdir: {
        type: 'string',
        default: '.',
        doc: '算例相对 workDir 的子目录。留 "." 表示 workDir 本身就是算例根',
      },
      unpack: {
        type: 'string',
        doc: '算例以归档形式上到 workDir 时给归档名（相对 workDir，如 s1b-refined-v2212.tar.gz）。'
          + '渲染器会先解包再判 GATE-UNPACK——解包与校验是一件事的两半，'
          + '只解包不校验就会漏掉"tar 多带一层 <case>/ 前缀"那一类错。支持 .tar.gz/.tgz/.tar/.zip',
        evidence: 'untested',
      },
      cores: {
        type: 'number',
        default: 0,
        doc: 'MPI 进程数。0＝跟随 resources.cores。'
          + '注意它只决定 -np，分区数是 decomposeParDict 里的 numberOfSubdomains（GATE-DECOMPOSE 会查两者是否一致）',
        evidence: 'verified',
      },
      launcherCandidates: {
        type: 'stringArray',
        default: ['mpirun --bind-to core', 'mpirun', 'mpirun --bind-to none --oversubscribe'],
        doc: '按顺序真跑 hostname 冒烟，取第一个回行数等于核数的。'
          + '顺序不能省：--bind-to core 在 i02r2n07 上 rc=0，在 b01r2n01 上必须退到 --oversubscribe',
        evidence: 'verified',
      },
      prepare: {
        type: 'boolean',
        default: true,
        doc: '新鲜算例时跑 blockMesh/checkMesh/setFields/decomposePar。'
          + '检测到已有网格或 processor* 时自动跳过（重跑会覆盖已有结果）',
        evidence: 'verified',
      },
      expectCells: {
        type: 'number',
        doc: 'checkMesh 的 cells 必须等于它。给了才有 GATE-MESH 的硬数字（s1b=31200、s2=14832）',
        evidence: 'verified',
      },
      endTime: {
        type: 'string',
        doc: '期望末时刻（字符串比较，与日志里 `Time = ` 的值逐字相同）。给了才有 GATE-SOLVER 的时刻判据',
        evidence: 'verified',
      },
      reconstruct: {
        type: 'boolean',
        default: true,
        doc: '求解后 reconstructPar，把串行场写回算例根。'
          + '并行算例的时刻只写在 processorN/ 里，不重构的话根目录看起来"没算过"',
        evidence: 'verified',
      },
      reconstructAll: {
        type: 'boolean',
        default: false,
        doc: 'true＝重构全部时刻（不带 -latestTime），代价高但能拿时间序列。'
          + '实测作业只用过 -latestTime，这一支没在真实作业里跑过',
        evidence: 'untested',
      },
      env: { type: 'stringArray', default: [], doc: '额外的 export 行，形如 "FOAM_SIGFPE=false"' },
      preCommands: { type: 'stringArray', default: [], doc: '环境装配之后、求解之前要跑的命令' },
      extraSolveArgs: { type: 'stringArray', default: [], doc: '追加到求解器命令行末尾的参数' },
      postCommands: { type: 'stringArray', default: [], doc: 'reconstructPar 之后要跑的命令' },
    },
  },

  commandFile: {
    type: 'string',
    doc: '本地脚本路径；脚本**内容**会内联进 GAP_CMD_FILE 交给远端执行（这是实测通过的路径）',
    evidence: 'verified',
  },
  command: { type: 'string', doc: '直接给的 shell 命令（多行用 \\n）', evidence: 'verified' },

  upload: {
    type: 'object',
    doc: '上传行为',
    fields: {
      chunkMiB: { type: 'number', default: 8, doc: '分片大小 MiB', evidence: 'verified' },
      retries: { type: 'number', default: 3, doc: '单片重试次数', evidence: 'verified' },
      cover: { type: 'string', default: 'cover', enum: ['cover', 'uncover'], doc: '同名是否覆盖' },
      verifySize: { type: 'boolean', default: true, doc: '上传后按字节数粗校验一遍' },
    },
  },

  outputs: {
    type: 'objectArray',
    doc: '作业结束后要取回的文件',
    fields: {
      remote: {
        type: 'string',
        required: true,
        doc: '远端路径。以 / 开头＝绝对路径；否则按 workDir 解析（作业的工作目录）。'
          + '%j 替换成作业号，开头的 ~ 展开成家目录',
      },
      local: { type: 'string', required: true, doc: '本地保存路径' },
      required: { type: 'boolean', default: false, doc: '取不到时是否算失败' },
    },
  },

  stdout: { type: 'string', default: 'stdout.%j', doc: '标准输出文件名，%j=作业号', evidence: 'verified' },
  stderr: { type: 'string', default: 'stderr.%j', doc: '标准错误文件名', evidence: 'verified' },
};

// ── 模板类型 ────────────────────────────────────────────────────────────────

export interface FluentSpec {
  installCandidates: string[];
  binRelPath: string;
  dimension: string;
  mpi: string;
  cores: number;
  journal: string;
  extraArgs: string[];
  env: string[];
  preCommands: string[];
  postCommands: string[];
}

export interface JobTemplate {
  $schema?: string;
  name: string;
  notes?: string;
  region?: string;
  jobManagerId: string;
  queue: string;
  resources: {
    nodes: number;
    cores: number;
    walltime: string;
    exclusive: boolean;
    ppn?: number;
    gpus?: number;
    dcus?: number;
    nodeString: string;
  };
  workDir: string;
  inputs: Array<{
    local: string;
    remoteDir: string;
    chunkMiB: number;
    cover: 'cover' | 'uncover';
    skipIfSameSize: boolean;
  }>;
  fluent?: FluentSpec;
  openfoam?: OpenfoamSpec;
  commandFile?: string;
  command?: string;
  upload: { chunkMiB: number; retries: number; cover: 'cover' | 'uncover'; verifySize: boolean };
  outputs: Array<{ remote: string; local: string; required: boolean }>;
  stdout: string;
  stderr: string;
}

// ── 校验 + 默认值 ───────────────────────────────────────────────────────────

export interface ValidateResult {
  template: JobTemplate;
  errors: string[];
  warnings: string[];
}

function typeOk(t: FieldType, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'stringArray':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'object':
      return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    case 'objectArray':
      return Array.isArray(v) && v.every((x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x));
  }
}

function checkGroup(
  raw: Record<string, unknown>,
  spec: Record<string, FieldSpec>,
  path: string,
  errors: string[],
  out: Record<string, unknown>,
): void {
  for (const key of Object.keys(raw)) {
    if (!(key in spec)) {
      errors.push(`未知字段 ${path}${key}（拼错字段名会被静默忽略，所以这里直接报错）`);
    }
  }
  for (const [key, s] of Object.entries(spec)) {
    const full = `${path}${key}`;
    const has = Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== null && raw[key] !== undefined;
    if (!has) {
      if (s.required) errors.push(`缺必填字段 ${full}`);
      if (s.omitWhenAbsent) {
        // 见 FieldSpec.omitWhenAbsent 的注释：这一组本身就是"一种选择"，
        // 补出默认值等于替用户选了它。
        continue;
      }
      if (s.default !== undefined) {
        out[key] = structuredClone(s.default);
      } else if (s.type === 'object' && s.fields) {
        // 整组省略时也要把子字段的默认值补出来，否则调用方拿到 undefined 会崩。
        const sub: Record<string, unknown> = {};
        checkGroup({}, s.fields, `${full}.`, errors, sub);
        out[key] = sub;
      } else if (s.type === 'objectArray') {
        out[key] = [];
      }
      continue;
    }
    const v = raw[key];
    if (!typeOk(s.type, v)) {
      errors.push(`${full} 类型不对：期望 ${s.type}，实际 ${Array.isArray(v) ? 'array' : typeof v}`);
      continue;
    }
    if (s.enum && !s.enum.includes(v as string)) {
      errors.push(`${full} 只能是 ${s.enum.join(' | ')}，实际 "${String(v)}"`);
      continue;
    }
    if (s.type === 'object' && s.fields) {
      const sub: Record<string, unknown> = {};
      checkGroup(v as Record<string, unknown>, s.fields, `${full}.`, errors, sub);
      out[key] = sub;
    } else if (s.type === 'objectArray' && s.fields) {
      out[key] = (v as Array<Record<string, unknown>>).map((item, i) => {
        const sub: Record<string, unknown> = {};
        checkGroup(item, s.fields!, `${full}[${i}].`, errors, sub);
        return sub;
      });
    } else {
      out[key] = v;
    }
  }
}

export interface ValidateOptions {
  /**
   * 检查 inputs[].local 与 commandFile 是否真的存在。
   *   true    —— 不存在就报错（提交前的最后一道闸，run/submit 用这个）
   *   'warn'  —— 不存在只告警（模板还没配好本地算例时用，check --lenient）
   *   false   —— 不检查（离线单测用）
   */
  checkFiles?: boolean | 'warn';
  fileExists?: (p: string) => boolean;
  /**
   * 本集群实际可用的队列名（`check --online` 时从平台拉）。
   * 队列名拼错在离线阶段查不出来，只会在**提交时**失败——而那时文件已经传上去了。
   */
  knownQueues?: string[];
  /**
   * 模板文件所在目录。相对路径的 inputs[].local / commandFile 先按它解析，再退回当前工作目录。
   *
   * 为什么要有这个：模板里写 `case/1.cas.h5` 是**相对模板自己**的意思，而进程的 cwd 是
   * 调用者所在的地方。2026-09-14 实测踩过：模板和同目录下的 payload 一起放进临时目录、
   * 从别处调 check，结果报 `inputs[0].local 不存在`——文件明明就在模板旁边。
   * 不传这个参数时行为与以前完全一致（只按 cwd 解析）。
   */
  baseDir?: string;
}

/** `<user>` 这类尖括号占位符没换掉的话，远端 shell 会把它当成重定向。 */
const PLACEHOLDER = /[<>]/;

/**
 * 归一化：小写 + 去掉一切非字母数字。
 * `xahc-normal-typo` 与 `xahcnormal` 的差别正好只有分隔符，不归一化就永远匹配不上
 * ——这是 2026-09-14 单测抓到的一个真缺陷（原来的包含判断对分隔符无能为力）。
 */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** 编辑距离（只做很短的两个串，O(nm) 够用）。 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * 在候选名里找"用户大概想写的那个"。
 * 两级判据：先看归一化后的互相包含（处理 `xahc-normal-typo` 这类只差分隔符的），
 * 再看编辑距离（处理 `xahcnromal` 这类真拼错）。都找不到就返回空数组，不要硬凑。
 */
export function nearestNames(given: string, candidates: string[], limit = 3): string[] {
  const g = norm(given);
  if (!g) return [];
  const byContain = candidates.filter((c) => {
    const n = norm(c);
    return n.length > 0 && (n.includes(g) || g.includes(n));
  });
  if (byContain.length) return byContain.slice(0, limit);
  const tol = Math.max(2, Math.floor(g.length / 3));
  return candidates
    .map((c) => ({ c, d: editDistance(g, norm(c)) }))
    .filter((x) => x.d <= tol)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * 把远端路径里的 `~` 展开成家目录。
 * 之所以要这个：家目录里带的是 SCNet 用户名，写死在模板里既容易写错又会随账号变化；
 * 而端点在认证之后就知道了，所以让运行时来补。
 */
export function expandHome(p: string, home: string): string {
  if (!p) return p;
  const h = home.replace(/\/$/, '');
  return p === '~' ? h : p.startsWith('~/') ? h + p.slice(1) : p;
}

/**
 * 作业的远端工作目录（GAP_WORK_DIR）解析结果，`~` 已展开。
 * 优先级：模板里显式给的 workDir → 第一个上传目录 → 远端家目录。
 */
export function workDirOf(t: JobTemplate, home: string): string {
  const raw = t.workDir && t.workDir.length ? t.workDir : t.inputs.length ? t.inputs[0]!.remoteDir : home;
  return expandHome(raw, home).replace(/\/$/, '');
}

/**
 * `outputs[].remote` 的最终远端路径。
 * 绝对路径原样用；相对路径按作业的工作目录解析——
 * 因为远端作业的 cwd 就是那里，Fluent 写出来的文件也在那里。
 */
export function resolveOutputPath(
  remote: string,
  t: JobTemplate,
  ctx: { home: string; jobId?: string | number },
): string {
  const expanded = expandHome(remote, ctx.home);
  const p = expanded.startsWith('/') ? expanded : `${workDirOf(t, ctx.home)}/${expanded.replace(/^\.\//, '')}`;
  return ctx.jobId === undefined ? p : p.replace(/%j/g, String(ctx.jobId));
}

/**
 * 解析本地相对路径：模板所在目录优先，当前工作目录兜底。
 *
 * 顺序是刻意的。模板里写 `case/1.cas.h5`，用户的意思是"模板旁边的 case/"；
 * 但如果按模板目录找不到而按 cwd 找得到，也认（保持老行为，别把已经能跑的用法弄坏）。
 * 两边都不存在时保留原样，让报错里显示用户自己写的那个路径，并附上找过的另一个位置。
 */
function resolveLocal(
  p: string,
  baseDir: string | undefined,
  exists: (x: string) => boolean,
): { path: string; note: string } {
  if (!p || !baseDir || isAbsolute(p)) return { path: p, note: '' };
  const alt = resolve(baseDir, p);
  if (exists(alt)) return { path: alt, note: '' };
  if (exists(p)) return { path: p, note: '' };
  return { path: p, note: `（也按模板所在目录找过：${alt}）` };
}

export function validateTemplate(raw: unknown, opts: ValidateOptions = {}): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { template: {} as JobTemplate, errors: ['模板根节点必须是一个 JSON 对象'], warnings };
  }
  const out: Record<string, unknown> = {};
  checkGroup(raw as Record<string, unknown>, SPEC, '', errors, out);

  // 判断"用户到底给没给"必须看原始输入的键，不能看补完默认值之后的对象——
  // 否则被补出来的空 fluent 组会被误判成"提供了 fluent 命令来源"。
  const provided = new Set(Object.keys(raw as Record<string, unknown>));
  const isGiven = (k: string) =>
    provided.has(k) && (raw as Record<string, unknown>)[k] !== undefined && (raw as Record<string, unknown>)[k] !== '';

  // 命令来源四选一（openfoam 与 fluent 是同一个位置的两个选项）
  const sources = ['fluent', 'openfoam', 'commandFile', 'command'].filter(isGiven);
  if (sources.length === 0) {
    errors.push('必须给出 fluent / openfoam / commandFile / command 之一（决定远端到底跑什么）');
  } else if (sources.length > 1) {
    errors.push(`fluent / openfoam / commandFile / command 只能给一个，现在给了：${sources.join(', ')}`);
  }

  const t = out as unknown as JobTemplate;

  // 已经报过错的字段就不要再往下推语义检查 —— 一个笔误会串出三四条互相矛盾的消息，
  // 而其中有些还是"fluent.cores=4 与 undefined 不一致"这种由报错本身造出来的假象。
  const broken = (frag: string) => errors.some((e) => e.includes(frag));
  const coresOk = Boolean(t.resources) && !broken('resources.cores')
    && Number.isInteger(t.resources.cores) && t.resources.cores >= 1;

  // nodes 与 nodeString 互斥
  if (t.resources?.nodeString && t.resources.nodeString.length > 0 && t.resources.nodes !== 1) {
    warnings.push('同时给了 resources.nodes 和 resources.nodeString；平台要求二者互斥，nodeString 生效时 nodes 应留 1');
  }

  // walltime 格式
  if (t.resources && !broken('resources.walltime') && !/^\d{1,3}:\d{2}:\d{2}$/.test(t.resources.walltime)) {
    errors.push(`resources.walltime 格式应为 HH:MM:SS，实际 "${t.resources.walltime}"`);
  }
  if (t.resources && !broken('resources.cores') && !coresOk) {
    errors.push(`resources.cores 应为 >=1 的整数，实际 ${t.resources.cores}`);
  }

  // 队列名：只有联网拿到真实队列表时才判得了
  if (opts.knownQueues?.length && !opts.knownQueues.includes(t.queue)) {
    const near = nearestNames(t.queue, opts.knownQueues);
    errors.push(
      `queue="${t.queue}" 不在本集群的可用队列里。可用：${opts.knownQueues.join(' / ')}`
        + (near.length ? `（你是不是想写 ${near.join(' / ')}？）` : ''),
    );
  }

  // Fluent 核数跟随（只在 resources.cores 本身站得住时才比）
  if (t.fluent && (t.fluent.cores === 0 || t.fluent.cores === undefined)) {
    t.fluent.cores = coresOk ? t.resources!.cores : 4;
  }
  if (t.fluent && coresOk && t.fluent.cores !== t.resources!.cores) {
    warnings.push(
      `fluent.cores=${t.fluent.cores} 与 resources.cores=${t.resources!.cores} 不一致：`
        + `申请了 ${t.resources!.cores} 核但 Fluent 只用 ${t.fluent.cores} 核（-t 只决定 MPI rank 数）`,
    );
  }

  // OpenFOAM 核数跟随（与 fluent 同一条规矩）
  if (t.openfoam && (t.openfoam.cores === 0 || t.openfoam.cores === undefined)) {
    t.openfoam.cores = coresOk ? t.resources!.cores : 4;
  }
  if (t.openfoam && coresOk && t.openfoam.cores !== t.resources!.cores) {
    warnings.push(
      `openfoam.cores=${t.openfoam.cores} 与 resources.cores=${t.resources!.cores} 不一致：`
        + `申请了 ${t.resources!.cores} 核但 -np 只用 ${t.openfoam.cores}`
        + `（分区数另由 decomposeParDict 的 numberOfSubdomains 决定，GATE-DECOMPOSE 会查）`,
    );
  }
  // 没给这两个字段时两道门只打印数字、不做判定。GATE-MESH/GATE-SOLVER 是"跑完了吗"的主要判据，
  // 静默降级比报错更危险，所以降级必须留痕。
  if (t.openfoam && t.openfoam.expectCells === undefined) {
    warnings.push('openfoam.expectCells 未给：GATE-MESH 只打印 checkMesh 的 cells，不判对错');
  }
  if (t.openfoam && t.openfoam.endTime === undefined) {
    warnings.push('openfoam.endTime 未给：GATE-SOLVER 不判末时刻，只判 FOAM FATAL 计数与返回码');
  }
  if (t.openfoam && (!Array.isArray(t.openfoam.launcherCandidates) || t.openfoam.launcherCandidates.length === 0)) {
    errors.push('openfoam.launcherCandidates 不能为空：至少给一个 mpirun 形式，否则 GATE-LAUNCHER 必然失败');
  }

  // 远端工作目录默认＝第一个上传目录。
  // 这两者不一致是"作业正常跑完但 Fluent 找不到 cas 文件"的头号原因：
  // journal 里写的是相对文件名，而远端进程的 cwd 是 GAP_WORK_DIR。
  if (t.workDir === '' && t.inputs.length > 0) {
    t.workDir = t.inputs[0]!.remoteDir;
  }
  const remoteDirs = [...new Set(t.inputs.map((i) => i.remoteDir))];
  if (remoteDirs.length > 1) {
    warnings.push(
      `inputs 里有 ${remoteDirs.length} 个不同的 remoteDir（${remoteDirs.join(' / ')}）：`
        + `远端工作目录按 "${t.workDir}" 算，相对路径的输入在别的目录里不会被 Fluent 看到`,
    );
  } else if (remoteDirs.length === 1 && t.workDir !== '' && remoteDirs[0] !== t.workDir) {
    warnings.push(
      `workDir="${t.workDir}" 与上传目录 "${remoteDirs[0]}" 不同：`
        + '确认 journal 里引用算例用的是绝对路径，否则远端会找不到文件',
    );
  }

  // 尖括号占位符：不拦的话会一路进到远端 shell，被当成重定向，报出来的错很难对上原因
  const placeholderSpots = [
    ...t.inputs.map((i, idx) => [`inputs[${idx}].remoteDir`, i.remoteDir] as const),
    ['workDir', t.workDir] as const,
    ...t.outputs.map((o, idx) => [`outputs[${idx}].remote`, o.remote] as const),
  ];
  for (const [where, val] of placeholderSpots) {
    if (val && PLACEHOLDER.test(val)) {
      errors.push(`${where} 里还有占位符："${val}" —— 换成 ~ 开头的相对家目录路径（如 ~/runs/001）或真实绝对路径`);
    }
  }

  // 本地路径：先把相对路径按"模板所在目录优先、当前工作目录兜底"解析出来，
  // 并把解析结果写回模板——否则校验通过、上传时却按另一个路径去找文件。
  const exists = opts.fileExists ?? ((p: string) => existsSync(p));
  const local = (p: string) => resolveLocal(p, opts.baseDir, exists);
  if (opts.checkFiles) {
    const sink = opts.checkFiles === 'warn' ? warnings : errors;
    for (const [i, inp] of (t.inputs ?? []).entries()) {
      const r = local(inp.local);
      inp.local = r.path;
      if (!exists(r.path)) sink.push(`inputs[${i}].local 不存在：${r.path}${r.note}`);
    }
    if (t.commandFile) {
      const r = local(t.commandFile);
      t.commandFile = r.path;
      if (!exists(r.path)) sink.push(`commandFile 不存在：${r.path}${r.note}`);
    }
  }

  return { template: t, errors, warnings };
}

// ── 命令行渲染 ──────────────────────────────────────────────────────────────

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/** 由 fluent 段生成远端要执行的 shell（含 FLUENT_ROOT 探测）。 */
export function renderFluentCommand(f: FluentSpec): string {
  const lines: string[] = [];
  lines.push('set -e');
  lines.push('_root=""; _fluent=""');
  // 候选目录故意不加引号：第三项依赖 shell 通配符展开
  lines.push(`for _d in ${f.installCandidates.join(' ')}; do`);
  lines.push(`  if [ -x "$_d/${f.binRelPath}" ]; then _root="$_d"; _fluent="$_d/${f.binRelPath}"; break; fi`);
  lines.push('done');
  lines.push('if [ -z "$_fluent" ]; then echo "FATAL: fluent binary not found (检查 installCandidates)"; exit 42; fi');
  lines.push('export FLUENT_ROOT="$_root"');
  lines.push('echo "FLUENT_ROOT=$FLUENT_ROOT"');
  lines.push('echo "FLUENT=$_fluent"');
  for (const e of f.env) lines.push(`export ${e}`);
  for (const c of f.preCommands) lines.push(c);
  const args = [f.dimension, '-g', `-mpi=${f.mpi}`, `-t${f.cores}`, '-i', f.journal, ...f.extraArgs];
  lines.push(`"$_fluent" ${args.join(' ')}`);
  lines.push('_rc=$?');
  for (const c of f.postCommands) lines.push(c);
  lines.push('exit $_rc');
  return lines.join('\n');
}

/**
 * 这份模板用的是哪种命令来源。
 *
 * 必须由**模板里实际存在的字段**来判，不能靠"谁先被补出默认值"——
 * 2026-09-14 实测事故：模板只写了 `command`，但校验阶段把 `fluent` 组的默认值也补了出来，
 * 于是 renderCommand 选了 Fluent，真正提交上去的是
 * `"$_fluent" 3ddp -g -mpi=intel -t1 -i solve.jou`，作业 42 秒后 FAILED（ExitCode 1）。
 * 现在 fluent 组在用户没写时不再被补出来（SPEC.fluent.omitWhenAbsent），这里也显式判一次。
 */
export type CommandSource = 'fluent' | 'openfoam' | 'commandFile' | 'command' | 'none';

export function commandSourceOf(t: JobTemplate): CommandSource {
  if (t.fluent) return 'fluent';
  if (t.openfoam) return 'openfoam';
  if (t.commandFile) return 'commandFile';
  if (t.command !== undefined && t.command !== '') return 'command';
  return 'none';
}

export function renderCommand(t: JobTemplate): string {
  switch (commandSourceOf(t)) {
    case 'fluent':
      return renderFluentCommand(t.fluent!);
    case 'openfoam':
      return renderOpenfoamCommand(t.openfoam!);
    case 'commandFile':
      // 内联脚本内容——实测通过的路径：把脚本正文塞进 GAP_CMD_FILE
      return readFileSync(t.commandFile!, 'utf8').replace(/\r\n/g, '\n');
    case 'command':
      return t.command!;
    default:
      return '';
  }
}

// ── 提交体 ──────────────────────────────────────────────────────────────────

export interface SubmitBody {
  strJobManagerID: string;
  mapAppJobInfo: Record<string, string>;
}

export function toSubmitBody(
  t: JobTemplate,
  ctx: { home: string; jobManagerId: string; userName: string },
): SubmitBody {
  const home = workDirOf(t, ctx.home);
  const r = t.resources;
  return {
    strJobManagerID: String(t.jobManagerId && t.jobManagerId.length ? t.jobManagerId : ctx.jobManagerId),
    mapAppJobInfo: {
      GAP_CMD_FILE: renderCommand(t),
      GAP_NNODE: String(r.nodes),
      GAP_NODE_STRING: r.nodeString ?? '',
      GAP_SUBMIT_TYPE: 'cmd',
      GAP_JOB_NAME: t.name,
      GAP_WORK_DIR: home,
      GAP_QUEUE: t.queue,
      GAP_NPROC: String(r.cores),
      GAP_PPN: r.ppn === undefined ? '' : String(r.ppn),
      GAP_NGPU: r.gpus === undefined ? '' : String(r.gpus),
      GAP_NDCU: r.dcus === undefined ? '' : String(r.dcus),
      GAP_WALL_TIME: r.walltime,
      GAP_EXCLUSIVE: r.exclusive ? 'true' : '',
      GAP_APPNAME: 'BASE',
      GAP_MULTI_SUB: '',
      GAP_STD_OUT_FILE: `${home}/${t.stdout}`,
      GAP_STD_ERR_FILE: `${home}/${t.stderr}`,
      GAP_SCHEDULER_OPT_WEB: '',
    },
  };
}

// ── JSON Schema（由 SPEC 派生，不手写）──────────────────────────────────────

function specToSchema(spec: Record<string, FieldSpec>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, s] of Object.entries(spec)) {
    if (s.required) required.push(key);
    const prop: Record<string, unknown> = {
      description: `${s.doc}${s.evidence ? `\n[evidence: ${s.evidence}]` : ''}`,
    };
    switch (s.type) {
      case 'string':
        prop.type = 'string';
        break;
      case 'number':
        prop.type = 'number';
        break;
      case 'boolean':
        prop.type = 'boolean';
        break;
      case 'stringArray':
        prop.type = 'array';
        prop.items = { type: 'string' };
        break;
      case 'object':
        Object.assign(prop, specToSchema(s.fields ?? {}));
        break;
      case 'objectArray':
        prop.type = 'array';
        prop.items = { type: 'object', ...specToSchema(s.fields ?? {}) };
        break;
    }
    if (s.enum) prop.enum = s.enum;
    if (s.default !== undefined) prop.default = s.default;
    properties[key] = prop;
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), ...extra };
}

export function jsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://local/scnet-client/job.schema.json',
    title: 'SCNet 作业模板',
    description:
      '由 src/jobtemplate.ts 的 SPEC 自动生成，请勿手改。重新生成：node src/cli.ts schema --out templates/job.schema.json',
    ...specToSchema(SPEC),
    additionalProperties: false,
    allOf: [
      {
        // 命令来源四选一，用 oneOf 表达。每支都要"必须有自己 + 不能有另外三个"，
        // 漏掉任何一个 not 分支都会让两个来源同时合法。
        oneOf: [
          { required: ['fluent'], not: { anyOf: [{ required: ['openfoam'] }, { required: ['command'] }, { required: ['commandFile'] }] } },
          { required: ['openfoam'], not: { anyOf: [{ required: ['fluent'] }, { required: ['command'] }, { required: ['commandFile'] }] } },
          { required: ['commandFile'], not: { anyOf: [{ required: ['fluent'] }, { required: ['openfoam'] }, { required: ['command'] }] } },
          { required: ['command'], not: { anyOf: [{ required: ['fluent'] }, { required: ['openfoam'] }, { required: ['commandFile'] }] } },
        ],
      },
    ],
  };
}

/** `scnet init` 用的起步模板。所有远端路径都用 ~ 开头，不写死用户名。 */
export function starterTemplate(name = 'my-run-001'): JobTemplate {
  const raw = {
    $schema: './templates/job.schema.json',
    name,
    notes: '把 inputs[].local 指向你自己的算例；远端路径用 ~ 开头表示家目录',
    region: '0',
    queue: 'xahcnormal',
    resources: { nodes: 1, cores: 8, walltime: '02:00:00' },
    inputs: [
      { local: 'case/1.cas.h5', remoteDir: '~/runs/001' },
      { local: 'case/solve.jou', remoteDir: '~/runs/001' },
    ],
    fluent: { journal: 'solve.jou' },
    upload: { chunkMiB: 8, retries: 3 },
    outputs: [{ remote: '1_out.dat.h5', local: 'results/1_out.dat.h5' }],
  };
  return validateTemplate(raw).template;
}

/**
 * OpenFOAM 起步模板（`scnet init --kind openfoam` / `get_job_template?kind=openfoam`）。
 *
 * 默认值是 2026-09-17 在西安集群**真跑通**的那一组：
 * s1b-refined 31200 单元 16 核到 `t=0.55`、s2-sector 14832 单元 8 核到 `t=1`。
 * `expectCells` 与 `endTime` 故意留空——它们是算例专属的硬数字，替用户猜等于把门变成摆设。
 */
export function openfoamCaseTemplate(name = 'of-run-001'): JobTemplate {
  const raw = {
    $schema: './templates/job.schema.json',
    name,
    notes: 'OpenFOAM 求解。算例以 tar 上到 workDir，渲染器先解包（openfoam.unpack）再校验算例根',
    region: '0',
    queue: 'xahcnormal',
    resources: { nodes: 1, cores: 16, walltime: '03:00:00' },
    inputs: [{ local: 'case/s1b-refined-v2212.tar.gz', remoteDir: '~/runs/of-001' }],
    openfoam: {
      solver: 'interFoam',
      cores: 0,
      // 归档名要和 inputs[].local 的文件名一致（解包发生在 workDir，也就是 remoteDir）
      unpack: 's1b-refined-v2212.tar.gz',
      // 这两项必须由使用者按算例填，渲染器只负责在跑完后断言
      // expectCells: 31200,
      // endTime: '0.55',
    },
    upload: { chunkMiB: 8, retries: 3 },
    outputs: [
      { remote: 'log.interFoam.fresh', local: 'results/log.interFoam.fresh' },
      { remote: 'log.checkMesh', local: 'results/log.checkMesh' },
    ],
  };
  return validateTemplate(raw).template;
}
