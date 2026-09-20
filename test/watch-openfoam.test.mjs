// `watch` 对 OpenFOAM 作业的判据。
//
// 【为什么有这个文件】`watchJob` 的进度判据是从 Fluent 的 `.trn` 长出来的，喂给它一个
// OpenFOAM 作业时会报"工作目录里还没有 .trn"——**假警报**（OpenFOAM 永远不会有 .trn），
// 而假警报的代价是"狼来了"：真出事时没人看。2026-09-17 补上 OpenFOAM 分支，这里钉住它。
//
// 两份夹具都是**真实文本**：`OF_STDOUT` 逐字抄自作业 67916044 的 stdout.67916044
// （注意它是**旧渲染器**的产物：没有 `日志 <_slog>` 那行，求解器只报 `last Time = `，
// 所以解析器必须新旧两种都认）；日志尾页按 OpenFOAM 实际输出形状写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SOLVER_LOG_RE,
  detectJobKind,
  formatWatch,
  hasFatalLine,
  missingProgressRisk,
  openfoamCaseDir,
  openfoamLogName,
  parseEndTime,
  parseOpenfoamTimes,
  pickSolverLog,
} from '../src/watch.ts';

/** 作业 67916044（s1b-refined，16 核，b03r4n14）的 stdout 全文。 */
const OF_STDOUT = `The start time is: 2026-09-17 06:36:56 

My job ID is: 67916044 

The total cores is: 16 

The hosts is: 

b03r4n14:16 


GATE-ENV OK  WM_PROJECT_VERSION=v2212  16 cores  job=67916044
  解包完成：/work/home/demo-user/runs/of-verify-s1b/s1b-refined-v2212.tar.gz → /work/home/demo-user/runs/of-verify-s1b
GATE-UNPACK OK  /work/home/demo-user/runs/of-verify-s1b/.
  endTime endTime         0.55;
  FRESH=1 (0=检测到已有网格/分区，走续算分支，不重跑 blockMesh/decomposePar)
--- blockMesh
--- checkMesh
  checkMesh cells=31200
GATE-MESH OK  cells=31200
--- setFields
    alpha.water: 0.orig=1586B -> 0/251049B  nonuniform=1
GATE-SETFIELDS OK  字典点名的场都已生效，且 0/ 无场变小
--- decomposePar -force -subdomains=16
GATE-DECOMPOSE OK  processor dirs=16/16
  nproc=16  affinity=pid 12312's current affinity list: 0-4,12,13,16-20,24-27
GATE-LAUNCHER OK  [mpirun --bind-to none --oversubscribe] hostlines=16
--- interFoam -parallel  (np=16)
  interFoam rc=0  last Time = 0.55  FOAM FATAL/sigFpe = 0
GATE-SOLVER OK  last Time = 0.55
--- reconstructPar -latestTime (串行场写回算例根)
  serial time dirs: 0 0.55 
=== OPENFOAM RUN END  rc=0 ===`;

/** 续算那一轮的 stdout（**新渲染器**形状：带 `日志 <_slog>`，末行是 `Time a -> b`）。 */
const OF_STDOUT_RESTART = `GATE-ENV OK  WM_PROJECT_VERSION=v2212  16 cores  job=67999999
GATE-UNPACK OK  /work/home/u/runs/of-verify-s1b/.
  FRESH=0 (0=检测到已有网格/分区，走续算分支，不重跑 blockMesh/decomposePar)
    processor0 里的最新时刻 0.55（求解器必须从这里起算）
    controlDict: startFrom       latestTime;
--- interFoam -parallel  (np=16)  日志 log.interFoam.restart
  interFoam rc=0  Time 0.550004 -> 0.6  FOAM FATAL/sigFpe = 0
GATE-RESTART OK  起算时刻 0.55 = processor0 最新时刻（确认续算；首个 Time=0.550004 是它迈出第一步之后）
GATE-SOLVER OK  Time 0.550004 -> 0.6`;

/** OpenFOAM 求解器的 stdout 形状（被我方重定向进 log.<solver>.<tag>）。 */
const OF_LOG_TAIL = `Courant Number mean: 0.0321 max: 0.488
Interface Courant Number mean: 0.0005 max: 0.1102
deltaT = 4.5025e-06
Time = 0.54995

PIMPLE: iteration 1
smoothSolver:  Solving for alpha.water, Initial residual = 3.1e-05, Final residual = 1.2e-09, No Iterations 2
time step continuity errors : sum local = 7.4e-12, global = -3.0e-13, cumulative = 1.0e-05
ExecutionTime = 6048 s  ClockTime = 6052 s

Time = 0.55

PIMPLE: iteration 1
smoothSolver:  Solving for alpha.water, Initial residual = 8.7e-06, Final residual = 2.2e-10, No Iterations 2
Courant Number mean: 0.0322 max: 0.4901
deltaT = 4.4998e-06
ExecutionTime = 6052 s  ClockTime = 6056 s

End`;

const E = (name, size, lastModifiedTime) => ({ name, size, lastModifiedTime });

// ── 认类型 ────────────────────────────────────────────────────────────────

test('detectJobKind：真实 OpenFOAM 作业的 stdout 认成 openfoam（旧渲染器产物也认）', () => {
  assert.equal(detectJobKind(OF_STDOUT), 'openfoam');
  assert.equal(detectJobKind(OF_STDOUT_RESTART), 'openfoam');
});

test('detectJobKind：求解器日志尾页（只有 Time = 行）认成 openfoam', () => {
  assert.equal(detectJobKind(OF_LOG_TAIL), 'openfoam');
});

test('detectJobKind：Fluent 的转录认成 fluent', () => {
  const trn = '> solve\n Flow time = 2.93s, time step = 7871\n';
  assert.equal(detectJobKind(trn), 'fluent');
});

test('detectJobKind：认不出来就返回 null，不要瞎猜（空文本、平台横幅）', () => {
  assert.equal(detectJobKind(''), null);
  assert.equal(detectJobKind('The start time is: 2026-09-17 06:36:56\nMy job ID is: 1\n'), null);
});

test('detectJobKind：两种指纹同时出现时先认 Fluent（它的锚点最专一）', () => {
  // OpenFOAM 的锚点宽（一行 `Time = 0.5`），Fluent 的窄（`Flow time = ..s, time step = ..`）。
  // 顺序反了的话，一份恰好也打了 `Time = ` 的 Fluent 转录会被判成 OpenFOAM。
  const both = ' Time = 1.0\n Flow time = 2.93s, time step = 7871\n';
  assert.equal(detectJobKind(both), 'fluent');
});

// ── 解析 ──────────────────────────────────────────────────────────────────

test('parseOpenfoamTimes：取到末行 Time 与页内行数', () => {
  const t = parseOpenfoamTimes(OF_LOG_TAIL);
  assert.equal(t.last, 0.55);
  assert.equal(t.count, 2);
  // first/last 是**这一页**的首末，不是全程首末——尾页读到 0.54995 是正常的
  assert.equal(t.first, 0.54995);
});

test('parseOpenfoamTimes：不把 ExecutionTime / ClockTime / deltaT / Courant 当成时间行', () => {
  const t = parseOpenfoamTimes(OF_LOG_TAIL);
  assert.equal(t.count, 2, '那一页里只有两行以 "Time = " 开头');
});

test('parseOpenfoamTimes：一页里没有时间行时返回 null（旧日志、别人的日志都长这样）', () => {
  assert.equal(parseOpenfoamTimes('Build  : v2212\nExec   : interFoam -parallel\nDate   : Sep 17 2026\n'), null);
});

test('parseOpenfoamTimes：容忍行尾空白与科学计数法', () => {
  assert.equal(parseOpenfoamTimes('Time = 1e-05  \n').last, 0.00001);
});

test('parseEndTime：从 controlDict 文本里读 endTime（纯数字才算）', () => {
  assert.equal(parseEndTime('startTime       0;\nendTime         0.6;\ndeltaT          1e-06;\n'), 0.6);
  assert.equal(parseEndTime('\tendTime   0.55 ;\n'), 0.55);
});

test('parseEndTime：不是纯数字就不当数用（字典里允许 #calc / 变量），也不瞎猜', () => {
  assert.equal(parseEndTime('endTime         #calc "$t0 + 0.05";\n'), null);
  assert.equal(parseEndTime('endTime         $endTime2;\n'), null);
  assert.equal(parseEndTime('startTime 0;\n'), null);
  assert.equal(parseEndTime(''), null);
});

test('openfoamCaseDir：从 stdout 的 GATE-UNPACK OK 取算例绝对路径，并剥掉末尾的 /.', () => {
  assert.equal(openfoamCaseDir(OF_STDOUT), '/work/home/demo-user/runs/of-verify-s1b');
});

test('openfoamCaseDir：出现多次时取最后一次（后面那次才是当前算例）', () => {
  const t = 'GATE-UNPACK OK  /a/old\n...\nGATE-UNPACK OK  /b/new\n';
  assert.equal(openfoamCaseDir(t), '/b/new');
});

test('openfoamCaseDir：没有那一行就返回 null，调用方退到 workDir', () => {
  assert.equal(openfoamCaseDir('FRESH=1\n'), null);
});

test('openfoamLogName：新渲染器明写了日志名，直接用那个名字', () => {
  assert.equal(openfoamLogName(OF_STDOUT_RESTART), 'log.interFoam.restart');
});

test('openfoamLogName：旧渲染器没有这一行 → null（退到按名字+时间窗挑）', () => {
  assert.equal(openfoamLogName(OF_STDOUT), null);
});

test('openfoamLogName：只认求解器日志的形状，别把重构日志当进度', () => {
  // 重构那行的名字不带 .fresh/.restart，白名单直接拒掉
  assert.equal(openfoamLogName('--- reconstructPar (串行场写回算例根)\n'), null);
});

test('SOLVER_LOG_RE：只放行 log.<solver>.fresh / .restart', () => {
  assert.ok(SOLVER_LOG_RE.test('log.interFoam.fresh'));
  assert.ok(SOLVER_LOG_RE.test('log.interFoam.restart'));
  assert.ok(SOLVER_LOG_RE.test('log.rhoPimpleFoam.restart'));
  for (const name of ['log.blockMesh', 'log.checkMesh', 'log.setFields', 'log.decomposePar', 'log.reconstructPar.fresh', 'log.interFoam', 'interFoam.log.fresh']) {
    assert.equal(SOLVER_LOG_RE.test(name), false, `${name} 不该被当成求解器日志`);
  }
});

test('pickSolverLog：同一算例目录里取最新改动的那份', () => {
  const entries = [
    E('log.blockMesh', 3068, '2026-09-17 06:37:02'),
    E('log.interFoam.fresh', 167772160, '2026-09-17 08:16:00'),
    E('log.interFoam.restart', 1024, '2026-09-17 08:20:00'),
    E('log.reconstructPar.fresh', 1609, '2026-09-17 08:16:10'),
  ];
  assert.equal(pickSolverLog(entries).name, 'log.interFoam.restart');
});

test('pickSolverLog：算例目录被共用时，上一轮那份日志必须被时间窗排掉', () => {
  // 上一轮（67916044）06:36 起跑、08:16 结束；这一轮 08:19 提交。
  // 上一轮那份 160 MB 的 fresh 又大又"新"（08:16），光看大小/新旧都会挑错它。
  const entries = [
    E('log.interFoam.fresh', 167772160, '2026-09-17 08:16:00'),
    E('log.interFoam.restart', 2048, '2026-09-17 08:22:00'),
  ];
  const startMs = Date.parse('2026-09-17T08:19:00+08:00');
  assert.equal(pickSolverLog(entries, { startMs }).name, 'log.interFoam.restart');
  // 没有时间信息时退化成"取最新"，这是弱判据——但至少不是"取最大"
  assert.equal(pickSolverLog(entries).name, 'log.interFoam.restart');
});

test('pickSolverLog：一个候选都没有时返回 undefined，不要瞎猜', () => {
  assert.equal(pickSolverLog([E('log.blockMesh', 10, '2026-09-17 06:37:02')]), undefined);
  assert.equal(pickSolverLog([]), undefined);
});

// ── 报告文案（假警报的回归锁）─────────────────────────────────────────────

test('missingProgressRisk：OpenFOAM 作业的文案里**不许**出现 .trn', () => {
  const s = missingProgressRisk('openfoam');
  assert.doesNotMatch(s, /\.trn/);
  assert.match(s, /log\.<solver>/);
});

test('missingProgressRisk：Fluent 作业照旧提 .trn；认不出类型时两边都提', () => {
  assert.match(missingProgressRisk('fluent'), /\.trn/);
  assert.match(missingProgressRisk('fluent'), /Fluent/);
  const unknown = missingProgressRisk(null);
  assert.match(unknown, /\.trn/);
  assert.match(unknown, /log\.<solver>/);
});

/** 一份最小的、形状正确的 OpenFOAM 报告。 */
function ofReport(over = {}) {
  return {
    schema: 'scnet-client/watch@2',
    jobId: '67999999',
    sampledAt: '2026-09-17T08:30:00.000Z',
    state: 'RUNNING',
    kind: 'openfoam',
    healthy: true,
    verdict: '在跑，正常',
    elapsedSec: 660,
    runTimeSec: 660,
    walltimeSec: 7200,
    walltimeLeftSec: 6540,
    nodes: 'b03r4n14',
    exitCode: null,
    reason: null,
    progress: { step: null, flowTime: 0.5512, targetStep: null, stepsDoneInBatch: null, pct: null },
    rate: { kind: 'simTime', secPerSimTime: 20.3, simTimePerHour: 177.3, from: '2026-09-17T08:20:00.000Z', overSimTime: 0.0012 },
    eta: {
      kind: 'simTime',
      simTimeLeft: 0.0488,
      endTime: 0.6,
      seconds: 0.99,
      finishAt: '2026-09-17T08:30:01.000Z',
      fitsInWalltime: true,
    },
    files: {
      errorLogs: [],
      openfoamLog: { name: 'log.interFoam.restart', size: 2048, dir: '/work/home/u/runs/of-verify-s1b' },
      stdout: { name: 'stdout.67999999', size: 1200 },
    },
    risks: [],
    sample: { persisted: true, sincePrevSec: 600, minGapSec: 30, retryInSec: null },
    ...over,
  };
}

test('formatWatch：OpenFOAM 报告按"物理时间"呈现，不许出现步号或 .trn', () => {
  const s = formatWatch(ofReport());
  assert.match(s, /类型 openfoam/);
  assert.match(s, /进度：物理时间 0\.5512/);
  assert.match(s, /取自 log\.interFoam\.restart/);
  assert.match(s, /秒\/单位物理时间/);
  assert.match(s, /离 endTime 0\.6 还差 0\.0488/);
  assert.doesNotMatch(s, /第 \d+ 步/);
  assert.doesNotMatch(s, /秒\/步/);
  assert.doesNotMatch(s, /\.trn/);
});

test('formatWatch：Fluent 报告照旧按"步"呈现（这次改动不能把它带坏）', () => {
  const s = formatWatch(ofReport({
    kind: 'fluent',
    progress: { step: 8000, flowTime: 2.93, targetStep: 9000, stepsDoneInBatch: 1000, pct: 10 },
    rate: { kind: 'step', secPerStep: 12.5, stepsPerHour: 288, from: '2026-09-17T08:20:00.000Z', overSteps: 48 },
    eta: { kind: 'step', stepsLeft: 1000, seconds: 12500, finishAt: '2026-09-17T11:58:20.000Z', fitsInWalltime: true },
    files: { errorLogs: [], trn: { name: 'fluent-20260917-082000-77.trn', size: 1000 } },
  }));
  assert.match(s, /进度：第 8000 步（物理时间 2\.93s）/);
  assert.match(s, /本批已完成 10\.0%/);
  assert.match(s, /12\.5 秒\/步/);
  assert.match(s, /剩 1000 步/);
});

test('formatWatch：OpenFOAM 作业还没读到 Time 行时，说的话与 .trn 无关', () => {
  const s = formatWatch(ofReport({
    progress: { step: null, flowTime: null, targetStep: null, stepsDoneInBatch: null, pct: null },
    rate: null,
    eta: null,
    files: { errorLogs: [] },
  }));
  assert.match(s, /还没读到 "Time = " 行/);
  assert.doesNotMatch(s, /\.trn/);
});

// ── 致命行：不许把 OpenFOAM 的启动横幅当事故 ──────────────────────────────

test('hasFatalLine：OpenFOAM 每次正常启动都会打的 FOAM_SIGFPE 横幅不算致命', () => {
  // 两行都是真实存在的写法：v2212 实测是 trapFpe 那句（作业 67942379 的日志第 27 行）
  const v2212 = 'trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE).\nTime = 0.55\n';
  const other = 'sigFpe : Enabling floating point exception trapping (FOAM_SIGFPE).\nTime = 0.55\n';
  assert.equal(hasFatalLine(v2212), false);
  assert.equal(hasFatalLine(other), false);
});

test('hasFatalLine：真出事还是认得出（FOAM FATAL / sigHandler 栈帧 / 段错误 / core dumped）', () => {
  assert.equal(hasFatalLine('--> FOAM FATAL ERROR: \n    Cannot find file "0.60/U"\n'), true);
  assert.equal(hasFatalLine('[0] #6  Foam::sigFpe::sigHandler(int) at ??:?\n'), true);
  assert.equal(hasFatalLine('Segmentation fault (core dumped)\n'), true);
  assert.equal(hasFatalLine('Floating point exception (core dumped)\n'), true);
});

test('hasFatalLine：Fluent 那侧的指纹也不能丢（Error Object / FATAL）', () => {
  assert.equal(hasFatalLine('Error: FATAL: something bad\n'), true);
  assert.equal(hasFatalLine('Error Object: #f\n'), true);
  assert.equal(hasFatalLine(' Flow time = 1.0s, time step = 10\n'), false);
});

test('源级回归锁：读进度必须读**尾部**（UP），不许再出现 DOWN', () => {
  // 为什么用源码断言：方向写反是**静默**的——纯函数测试碰不到它，离线测试也碰不到，
  // 只有真作业才暴露（2026-09-17 实测：进度停在 0.550217，而当时求解器已经到 0.55x）。
  // 平台侧参数名是 rollDirection，`'UP'`＝尾部、`'DOWN'`＝头部（文档 + 实测量过两次）。
  const src = readFileSync(new URL('../src/watch.ts', import.meta.url), 'utf8');
  // 只看代码行：注释里**必须**能写这件事（那正是交接时最值钱的一段），
  // 但代码里不许再出现 'DOWN'。剥注释只按行首，够用且不会误伤。
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const calls = [...code.matchAll(/readRemoteText\(([^;]*?)\);/gs)].map((m) => m[1].replace(/\s+/g, ' '));
  assert.ok(calls.length >= 4, `应当能找到全部 readRemoteText 调用，实际 ${calls.length} 处`);
  for (const c of calls) {
    assert.match(c, /, 'UP'\)?$/, `每一处 readRemoteText 都要读尾部（UP）：${c}`);
  }
  assert.doesNotMatch(code, /'DOWN'/);
});
