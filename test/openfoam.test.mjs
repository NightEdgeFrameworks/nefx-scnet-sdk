/**
 * OpenFOAM 作业模板：渲染器 + 三个只读操作。
 *
 * 这里锁的不是"代码能跑"，而是**产物契约**：
 * 七道门在渲染结果里必须出现、必须按顺序、必须在正确的分支里（新鲜 vs 续算）。
 * 这些门是从 2026-09-17 簇上真跑通的三个作业里抄出来的，
 * 改动它们等于放松"跑完了吗"的判据——所以每一次松动都该在这里红一次。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commandSourceOf,
  jsonSchema,
  openfoamCaseTemplate,
  renderCommand,
  starterTemplate,
  validateTemplate,
} from '../src/jobtemplate.ts';
import { OPENFOAM_GATES, renderOpenfoamCommand } from '../src/openfoam.ts';
import { OPERATIONS } from '../src/core.ts';

/** 一份最小可用的 OpenFOAM 模板 */
function ofBase(extra = {}) {
  return {
    name: 'of-test-001',
    queue: 'xahcnormal',
    resources: { nodes: 1, cores: 8, walltime: '02:00:00' },
    inputs: [{ local: 'case/a.tar.gz', remoteDir: '~/runs/of-001' }],
    openfoam: { solver: 'interFoam', expectCells: 14832, endTime: '1', ...extra },
  };
}

const render = (raw) => renderCommand(validateTemplate(raw).template);

// ── 模板与默认值 ────────────────────────────────────────────────────────────

test('openfoam 起步模板本身是合法的，且命令来源判为 openfoam', () => {
  const t = openfoamCaseTemplate();
  const { errors } = validateTemplate(t);
  assert.deepEqual(errors, []);
  assert.equal(commandSourceOf(t), 'openfoam');
  assert.equal(t.openfoam.solver, 'interFoam');
});

test('openfoam 与 fluent 同时给要报错（第四个来源不放松互斥）', () => {
  const raw = { ...ofBase(), fluent: { journal: 'solve.jou' } };
  assert.match(validateTemplate(raw).errors.join('\n'), /只能给一个/);
});

test('omitted 的 openfoam 组不该被补出来（沿用 fluent 那次的教训）', () => {
  const raw = ofBase();
  delete raw.openfoam;
  raw.command = 'echo hi';
  const { template } = validateTemplate(raw);
  assert.equal(template.openfoam, undefined);
  assert.equal(commandSourceOf(template), 'command');
});

test('openfoam.cores 默认跟随 resources.cores，不一致时告警', () => {
  const t = validateTemplate(ofBase()).template;
  assert.equal(t.openfoam.cores, 8);

  const r = validateTemplate(ofBase({ cores: 4 }));
  assert.equal(r.template.openfoam.cores, 4);
  assert.match(r.warnings.join('\n'), /openfoam\.cores=4 与 resources\.cores=8 不一致/);
});

test('不给 expectCells / endTime 要留痕：那两道门会静默降级', () => {
  const raw = ofBase();
  delete raw.openfoam.expectCells;
  delete raw.openfoam.endTime;
  const { warnings } = validateTemplate(raw);
  assert.match(warnings.join('\n'), /expectCells 未给/);
  assert.match(warnings.join('\n'), /endTime 未给/);
});

test('launcherCandidates 为空是硬错误（GATE-LAUNCHER 必然失败）', () => {
  const { errors } = validateTemplate(ofBase({ launcherCandidates: [] }));
  assert.match(errors.join('\n'), /launcherCandidates 不能为空/);
});

test('JSON Schema 的命令来源是四选一', () => {
  const s = jsonSchema();
  const oneOf = s.allOf[0].oneOf;
  assert.equal(oneOf.length, 4);
  const required = oneOf.map((b) => b.required[0]).sort();
  assert.deepEqual(required, ['command', 'commandFile', 'fluent', 'openfoam']);
  // fluent 起步模板仍然合法（没有把老路径弄坏）
  assert.deepEqual(validateTemplate(starterTemplate()).errors, []);
});

// ── 渲染：环境装配 ─────────────────────────────────────────────────────────

test('环境装配必须 source etc/bashrc 且补 sys-openmpi（module load 只给一半）', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /module load OpenFOAM\/v2212-hpcx-gcc-7\.3\.1/);
  assert.match(cmd, /\. "\$APPS\/etc\/bashrc"/);
  assert.match(cmd, /FOAM_LIBBIN="\$LIBROOT\/\$FOAM_MPI"/);
  assert.match(cmd, /LD_LIBRARY_PATH="\$FOAM_LIBBIN:\$LIBROOT:\$LD_LIBRARY_PATH"/);
  // GATE-ENV 的判据是真跑一次，不是 command -v（注释里提到它是为了解释为什么不用它）
  assert.match(cmd, /if ! "interFoam" -help >\/dev\/null 2>&1/);
  assert.doesNotMatch(cmd, /^\s*(if\s+)?command -v/m);
});

test('不能用 set -e：bashrc 与 grep 的"合法非零返回"会让脚本静默死掉（2026-09-17 job 67915092 实测）', () => {
  const cmd = render(ofBase());
  // 反面：一个裸的 set -e 都不许有
  assert.doesNotMatch(cmd, /^\s*set -e\s*$/m, 'set -e 会把 grep 没匹配到（rc=1）当成致命错误');
  assert.match(cmd, /^set \+e$/m, '要显式 set +e：判据看产物，不看返回码');
  // source bashrc 在非交互 shell 里返回非零是常态——手写脚本当年就是为这个写 set +e 的
  assert.match(cmd, /\. "\$APPS\/etc\/bashrc" >\/dev\/null 2>&1 \|\| true/);
  // 每一道门的失败判据仍然是显式的（set +e 不放松判据）
  for (const g of ['GATE-ENV', 'GATE-UNPACK', 'GATE-MESH', 'GATE-SETFIELDS', 'GATE-DECOMPOSE', 'GATE-LAUNCHER', 'GATE-SOLVER']) {
    assert.ok(cmd.includes(`${g} FAIL`), `${g} 必须有显式的 FAIL 分支`);
  }
});

test('会把进 shell 的名字类字段过白名单：带元字符直接拒绝，不给拼进命令的机会', () => {
  const spec = validateTemplate(ofBase()).template.openfoam;
  for (const [field, value] of [
    ['solver', 'interFoam"; rm -rf /tmp/x; echo "'],
    ['solver', 'interFoam; rm -rf /'],
    ['solver', '$(whoami)'],
    ['openfoamRoot', '/public/apps/$(id)'],
    ['moduleName', 'OpenFOAM/v2212 && echo pwned'],
  ]) {
    assert.throws(
      () => renderOpenfoamCommand({ ...spec, [field]: value }),
      /含非法字符/,
      `${field}=${value} 应该被拒`,
    );
  }
  // 合法值要放行，而且进命令行时是带引号的
  const ok = renderOpenfoamCommand(spec);
  assert.match(ok, /if ! "interFoam" -help/);
  assert.match(ok, /\$LAUNCH -np 8 "interFoam" -parallel/);
});

// ── 渲染：七道门 ───────────────────────────────────────────────────────────

test('门清单是 7 条、id 都以 GATE- 开头、且每条都有判据与理由', () => {
  assert.equal(OPENFOAM_GATES.length, 7);
  const ids = OPENFOAM_GATES.map((g) => g.id);
  assert.deepEqual(ids, [
    'GATE-ENV',
    'GATE-UNPACK',
    'GATE-MESH',
    'GATE-SETFIELDS',
    'GATE-DECOMPOSE',
    'GATE-LAUNCHER',
    'GATE-SOLVER',
  ]);
  for (const g of OPENFOAM_GATES) {
    assert.ok(g.judge.length > 0, `${g.id} 缺判据`);
    assert.ok(g.why.length > 0, `${g.id} 缺理由`);
  }
});

test('渲染结果里七道门都在，且顺序是"数据先落地、再建网格、再分区、再跑"', () => {
  const cmd = render(ofBase());
  const at = (id) => cmd.indexOf(id + ' ');
  const order = [
    'GATE-ENV',
    'GATE-UNPACK',
    'GATE-MESH',
    'GATE-SETFIELDS',
    'GATE-DECOMPOSE',
    'GATE-LAUNCHER',
    'GATE-SOLVER',
  ];
  let last = -1;
  for (const id of order) {
    const i = at(id);
    assert.ok(i > last, `${id} 缺失或顺序不对`);
    last = i;
  }
});

test('GATE-MESH 只在给了 expectCells 时判定；没给就只打印', () => {
  const withExp = render(ofBase());
  assert.match(withExp, /GATE-MESH FAIL: cells=\$_cells 期望 14832/);

  const raw = ofBase();
  delete raw.openfoam.expectCells;
  assert.doesNotMatch(render(raw), /GATE-MESH FAIL/);
  assert.match(render(raw), /GATE-MESH OK/);
});

test('GATE-UNPACK 在算例根落地那一刻判 system/controlDict 与 0.orig', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /if \[ ! -f system\/controlDict \] \|\| \[ ! -d 0\.orig \]/);
  assert.match(cmd, /ls -a "\$CASE"\]|ls -a "\$CASE"/);
});

test('不给 unpack 时渲染结果里没有解包动作（阴性对照：别把解包当成默认行为）', () => {
  const cmd = render(ofBase());
  assert.ok(!cmd.includes('tar -xzf'), '没给 unpack 就不该出现 tar');
  assert.ok(!cmd.includes('_ar='), '没给 unpack 就不该出现归档变量');
});

test('给了 unpack 就先解包再判 GATE-UNPACK，两者顺序不许颠倒', () => {
  const cmd = render(ofBase({ unpack: 's1b-refined-v2212.tar.gz' }));
  const iTar = cmd.indexOf('tar -xzf "$_ar"');
  const iUnpack = cmd.indexOf('GATE-UNPACK FAIL: $CASE 里没有');
  assert.ok(iTar > 0, '要有解包动作');
  assert.ok(iUnpack > 0, '要有落地校验');
  assert.ok(iTar < iUnpack, '解包必须在"算例有没有落地"的判据之前——否则门永远判不出 tar 带前缀那一类错');
  assert.match(cmd, /_ar="\$PWD\/s1b-refined-v2212\.tar\.gz"/);
  assert.match(cmd, /GATE-UNPACK FAIL: 归档不存在/);
  // 后缀不认识时不能静默跳过
  assert.match(cmd, /不认识的归档后缀/);
  assert.match(cmd, /\*\.tar\.gz\|\*\.tgz\)/);
});

test('unpack 里的归档名同样过白名单，不给拼进 shell 的机会', () => {
  assert.throws(
    () => render(ofBase({ unpack: 'case.tar.gz; rm -rf ~' })),
    /openfoam\.unpack 含非法字符/,
  );
  assert.throws(
    () => render(ofBase({ unpack: '$(whoami).tar.gz' })),
    /openfoam\.unpack 含非法字符/,
  );
});

test('GATE-DECOMPOSE 比较的是 processor 目录数与 decomposeParDict，不是进程数', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /_want=\$\(grep -oE 'numberOfSubdomains\[\[:space:\]\]\+\[0-9\]\+' system\/decomposeParDict/);
  assert.match(cmd, /_got=\$\(ls -d processor\* 2>\/dev\/null \| wc -l\)/);
  assert.match(cmd, /GATE-DECOMPOSE FAIL: processor 目录 \$_got 个/);
});

test('GATE-LAUNCHER 按候选顺序取第一个回行数等于核数的形式', () => {
  const cmd = render(ofBase({ launcherCandidates: ['mpirun --bind-to core', 'mpirun --bind-to none --oversubscribe'] }));
  const i1 = cmd.indexOf('mpirun --bind-to core -np 8 hostname');
  const i2 = cmd.indexOf('mpirun --bind-to none --oversubscribe -np 8 hostname');
  assert.ok(i1 > 0 && i2 > i1, '候选顺序必须按数组顺序探测');
  assert.match(cmd, /if \[ "\$_n" = "8" \]; then LAUNCH="mpirun --bind-to core"/);
});

test('GATE-SOLVER 判日志内容：FOAM FATAL 计数 + 末时刻 + rc，三者都要', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /grep -cE 'FOAM FATAL\|sigFpe\|floating point exception'/);
  assert.match(cmd, /_last=\$\(grep -hE '\^Time = ' "\$_slog"/);
  assert.match(cmd, /if \[ "\$_fatal" != "0" \]/);
  assert.match(cmd, /末时刻 \$_last != endTime \$_want_t/);
});

// ── 渲染：求解器日志按分支命名 ──────────────────────────────────────────────
//
// 2026-09-17 通读代码时抓到：日志名写死 `log.<solver>.fresh`，两条分支共用。
// 后果两条：①续算那轮的日志也叫 .fresh（名字撒谎）；②更要命——**续算会覆盖掉
// 新鲜那一轮的日志**，而那是唯一一份"新鲜分支真跑过"的原始证据（实测 160 MB）。

test('求解器日志名带分支后缀（$_tag），续算不覆盖新鲜那一轮', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /_tag=fresh/);
  assert.match(cmd, /_tag=restart/);
  assert.match(cmd, /_slog="log\.interFoam\.\$_tag"/);
  // 求解器与重构都写 "$_slog" / '"log.reconstructPar.$_tag"'，不再写死裸名
  assert.match(cmd, /> "\$_slog" 2>&1/);
  assert.match(cmd, /log\.reconstructPar\.\$_tag/);
  assert.doesNotMatch(cmd, /log\.interFoam\.fresh/);
});

// ── 渲染：GATE-RESTART —— 续算必须真的从断点起算 ────────────────────────────
//
// 这是这一轮最要紧的一条。只证明"FRESH=0、没重建网格"是**不够的**：
// startFrom 没改成 latestTime 时，求解器照样安安静静从 0 重算一遍，
// 产物看起来完全正常（末时刻还是 endTime），没有任何一道门会红。
//
// ★判据必须落在**启动横幅** `Create mesh for time = <T>` 上，不能用"第一个 `Time = `"。
//   2026-09-17 job 67942379 实测：一次**成功**的续算（0.55 -> 0.6、rc=0、无 FOAM FATAL）
//   被第一版判据（`_first != _resume`）判成 FAIL(37)——因为 `Time::operator++` 先推进
//   时间再打印，健康续算的首个 Time 是 `_resume + Δt`（0.550004 ≠ 0.55），
//   那个判据对每一次成功续算都必然报红。下面最后两条断言就是钉死这个回归的。

test('GATE-RESTART：续算的起算时刻（启动横幅）必须等于 processor0 的最新时刻', () => {
  const cmd = render(ofBase());
  // 断点从现场读：processor0 里最新的时刻目录
  assert.match(cmd, /_resume=\$\(ls -d processor0\/\[0-9\]\*/);
  // 主判据：启动横幅里的起算时刻
  assert.match(cmd, /_start=\$\(grep -m1 -E '\^Create mesh for time = ' "\$_slog"/);
  assert.match(cmd, /if \[ "\$_start" != "\$_resume" \]/);
  assert.match(cmd, /GATE-RESTART FAIL: 启动横幅 Create mesh for time = \$_start/);
  // 兜底判据：横幅认不出时，用**数值**比较首个 Time 与断点
  assert.match(cmd, /elif awk -v a="\$_first" -v b="\$_resume" 'BEGIN\{exit !\(\(a\+0\) > \(b\+0\)\)\}'/);
  assert.match(cmd, /GATE-RESTART OK/);
  // ★回归锁：不许再用"首个 Time 字符串等于断点"当判据（那对成功续算恒假红）
  assert.doesNotMatch(cmd, /\[ "\$_first" != "\$_resume" \]/);
  // 门只在续算分支生效，新鲜分支不该被它拦住
  const gate = cmd.indexOf('# GATE-RESTART');
  assert.ok(gate > 0);
  assert.match(cmd.slice(gate, gate + 260), /if \[ "\$FRESH" = "0" \]/);
});

test('GATE-SOLVER 打出首末两个时刻，不只有末时刻', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /Time \$_first -> \$_last/);
  assert.match(cmd, /GATE-SOLVER OK {2}Time \$_first -> \$_last/);
});

// ── 渲染：openfoam.endTime 同时写进 controlDict ─────────────────────────────
//
// endTime 不只是判据，它是"这一轮必须达到的时刻"。算例归档里写 0.55、而这一轮声明
// 0.60 时（续算必然如此），不对齐 controlDict 就会让 GATE-SOLVER 报
// "末时刻 != endTime"——现场看起来像算例算错了，没人会想到是两边口径没对上。

test('endTime 是纯数字时写进 controlDict（先存原值再 sed，并回显前后）', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /_et_before=\$\(grep -E '\^ \*endTime' system\/controlDict/);
  assert.match(cmd, /sed -i 's\/\^ \*endTime\.\*\/endTime +[0-9.]+;\/' system\/controlDict/);
  assert.match(cmd, /controlDict endTime: \$_et_before -> /);
});

test('endTime 不是纯数字时不碰 controlDict（sed 的替换文本不能带任意字符）', () => {
  const t = ofBase();
  t.openfoam.endTime = '0.55; rm -rf ~';
  const cmd = render(t);
  assert.doesNotMatch(cmd, /sed -i 's\/\^ \*endTime/);
  assert.match(cmd, /不是纯数字，不写进 controlDict/);
});

// ── 渲染：GATE-SETFIELDS 的场清单来自算例字典 ──────────────────────────────
//
// 这一节是 2026-09-17 job 67915259 换来的。当时渲染器要求 `0/` 下**每个**场
// 都比 `0.orig/` 大且含 `nonuniform`，而本算例的 `setFieldsDict` 只点名 `alpha.water`——
// 门在 `p_rgh` 上报 FAIL 并退出，作业 15 秒就死，而算例本身完全正常。
// 教训：**"该改哪些场"的真值在字典里，任何写死场名的判据都是假红制造机。**

test('GATE-SETFIELDS 的场清单从 system/setFieldsDict 里读，不在渲染器里写死', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /_wantf=\$\(sed .*system\/setFieldsDict/);
  assert.match(cmd, /vol\[A-Za-z\]\+FieldValue/);
  // 逐字节比较才是"改了没有"的判据（大小相等也可能内容不同）
  assert.match(cmd, /cmp -s "\$_f" "\$_o"/);
  assert.match(cmd, /setFields 没生效/);
  // 字典解析不出场名 = 判不了，按失败处理，不许静默通过
  assert.match(cmd, /解析不出任何 vol\*FieldValue/);
});

test('GATE-SETFIELDS 不再要求"0/ 下每个场都变大且含 nonuniform"', () => {
  const cmd = render(ofBase());
  assert.doesNotMatch(cmd, /没变大 \(/);
  assert.doesNotMatch(cmd, /不含 nonuniform/);
  // 但"0/ 里没有场变小"这条探针要留着：截断/残留模板靠它发现
  assert.match(cmd, /像被截断或写了模板/);
});

test('GATE-LAUNCHER 之前先按 cgroup 放宽 CPU 掩码', () => {
  const cmd = render(ofBase());
  const aff = cmd.indexOf('cpuset.cpus.effective');
  const launch = cmd.indexOf('GATE-LAUNCHER');
  assert.ok(aff > 0, '缺放宽掩码那一段');
  assert.ok(aff < launch, '放宽掩码必须在测 launcher 之前——批处理步可能只绑 1 个核');
  assert.match(cmd, /taskset -pc "\$_cpus" \$\$/);
});

// ── 渲染：新鲜 vs 续算 ─────────────────────────────────────────────────────

test('续算判据只看 processor0；光有 constant/polyMesh 不算可续算', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /if \[ -d processor0 \]; then FRESH=0; fi/);
  // 曾经多算一条 `|| [ -d constant/polyMesh ]`，后果很具体：上一轮死在建网格与分区之间时，
  // 残留的 polyMesh 会让下一轮判成续算、跳过 decomposePar，求解器在没有 processor* 时起来。
  // 2026-09-17 job 67915259 的现场正好落在那个状态（blockMesh 成功、decomposePar 没跑）。
  assert.doesNotMatch(cmd, /constant\/polyMesh \]; then FRESH=0/);
  // 新鲜分支必须先清掉上一轮残留的可再生状态（0/ constant/polyMesh processor*）
  assert.match(cmd, /rm -rf 0 constant\/polyMesh processor\*/);
  // 续算的第二半：必须把 controlDict 的 startFrom 改成 latestTime。
  // 算例归档里写的是 `startFrom startTime; startTime 0;`——不改这一行，求解器会从 t=0
  // 把磁盘上已有的时刻全部重算一遍，看起来"在续算"，其实白烧一轮机时。
  assert.match(cmd, /sed -i 's\/\^ \*startFrom\.\*\/startFrom       latestTime;\/' system\/controlDict/);
  const restartAt = cmd.indexOf('续算：跳过建网格与分区');
  const sedAt = cmd.indexOf('startFrom       latestTime;');
  assert.ok(restartAt > 0 && sedAt > restartAt, 'startFrom 改写必须落在续算分支里');
  // 建网格的那些命令必须在 FRESH=1 分支里（在 `if [ "$FRESH" = "1" ]` 之后）
  const freshAt = cmd.indexOf('if [ "$FRESH" = "1" ]');
  const blockAt = cmd.indexOf('blockMesh > log.blockMesh');
  const elseAt = cmd.indexOf('else\n  _tag=restart');
  assert.ok(freshAt > 0 && blockAt > freshAt && elseAt > blockAt);
  // 否则分支里明确说跳过
  assert.match(cmd, /续算：跳过建网格与分区/);
});

test('prepare=false 时不渲染建网格那一段，但仍然渲染四道后面的门', () => {
  const cmd = render(ofBase({ prepare: false }));
  assert.doesNotMatch(cmd, /blockMesh > log\.blockMesh/);
  assert.doesNotMatch(cmd, /setFields > log\.setFields/);
  assert.match(cmd, /GATE-LAUNCHER/);
  assert.match(cmd, /GATE-SOLVER/);
});

// ── 渲染：重构 ─────────────────────────────────────────────────────────────

test('reconstruct 默认带 -latestTime，reconstructAll 才去掉', () => {
  assert.match(render(ofBase()), /reconstructPar -latestTime > "log\.reconstructPar\.\$_tag"/);
  assert.match(render(ofBase({ reconstructAll: true })), /reconstructPar > "log\.reconstructPar\.\$_tag"/);
});

test('重构后的判据是"根目录必须有末时刻"——并行时刻写在 processorN/ 里', () => {
  const cmd = render(ofBase());
  assert.match(cmd, /grep -v '\\\.orig\$' \| grep -qx "\$_last"/);
  assert.match(cmd, /FAIL reconstructPar: 根目录没有末时刻/);
});

test('reconstruct=false 时整段不出现', () => {
  const cmd = render(ofBase({ reconstruct: false }));
  assert.doesNotMatch(cmd, /reconstructPar/);
});

test('额外命令按 env → pre → extraSolveArgs → post 的位置各就各位', () => {
  const cmd = render(
    ofBase({
      env: ['FOAM_SIGFPE=false'],
      preCommands: ['echo PRE'],
      extraSolveArgs: ['-subCycling'],
      postCommands: ['echo POST'],
    }),
  );
  const iEnv = cmd.indexOf('export FOAM_SIGFPE=false');
  const iPre = cmd.indexOf('echo PRE');
  const iSolve = cmd.indexOf('"interFoam" -parallel -subCycling');
  const iPost = cmd.indexOf('echo POST');
  assert.ok(iEnv > 0 && iPre > iEnv && iSolve > iPre && iPost > iSolve, '四者顺序不对');
});

// ── 三个只读操作（webapi 与 MCP 共用的同一批） ──────────────────────────────

const op = (name) => {
  const found = OPERATIONS.find((o) => o.name === name);
  assert.ok(found, `操作 ${name} 不存在`);
  return found;
};

test('四个模板操作都注册在 OPERATIONS 里，且都是离线可用的', async () => {
  for (const name of ['get_job_template', 'check_job_template', 'render_job_command', 'preview_job_template']) {
    const o = op(name);
    assert.ok(o.description.length > 0);
    assert.equal(o.inputSchema.type, 'object');
    assert.equal(typeof o.handler, 'function');
  }
});

test('get_job_template?kind=openfoam 返回模板与七道门的清单', async () => {
  const r = await op('get_job_template').handler({ kind: 'openfoam' });
  assert.equal(r.schema, 'scnet-client/ops@1');
  assert.equal(r.kind, 'openfoam');
  assert.equal(r.template.openfoam.solver, 'interFoam');
  assert.equal(r.gates.length, 7);
});

test('get_job_template 默认 fluent，且不返回 gates', async () => {
  const r = await op('get_job_template').handler({});
  assert.equal(r.kind, 'fluent');
  assert.ok(r.template.fluent);
  assert.equal(r.gates, undefined);
});

test('check_job_template 接受 JSON 文本，也接受对象', async () => {
  const bad = { ...ofBase(), fluent: { journal: 'x.jou' } };
  const asText = await op('check_job_template').handler({ template: JSON.stringify(bad) });
  const asObject = await op('check_job_template').handler({ template: bad });
  assert.equal(asText.ok, false);
  assert.equal(asObject.ok, false);
  assert.match(asText.errors.join('\n'), /只能给一个/);
  assert.equal(asText.commandSource, undefined === asText.commandSource ? undefined : asText.commandSource);
});

test('check_job_template 的 template 参数坏掉时报清楚，不静默变成空模板', async () => {
  await assert.rejects(() => op('check_job_template').handler({ template: '{not json' }), /不是合法 JSON/);
  await assert.rejects(() => op('check_job_template').handler({}), /缺少参数 template/);
});

test('render_job_command 返回来源与 shell 全文；openfoam 时附门清单', async () => {
  const r = await op('render_job_command').handler({ template: JSON.stringify(ofBase()) });
  assert.equal(r.source, 'openfoam');
  assert.match(r.command, /GATE-SOLVER OK/);
  assert.equal(r.gates.length, 7);

  const f = await op('render_job_command').handler({ template: JSON.stringify(starterTemplate()) });
  assert.equal(f.source, 'fluent');
  assert.equal(f.gates, undefined);
});

test('render_job_command 在校验不过时抛错，不吐半成品', async () => {
  await assert.rejects(
    () => op('render_job_command').handler({ template: JSON.stringify({ name: 'x', queue: 'q', resources: { cores: 0 } }) }),
    /模板校验未通过/,
  );
});

test('preview_job_template 给出上传清单、workDir、提交体，并标明哪些字段还是占位', async () => {
  const r = await op('preview_job_template').handler({ template: JSON.stringify(ofBase()) });
  assert.equal(r.workDir, '$HOME/runs/of-001');
  assert.deepEqual(r.uploads, [{ local: 'case/a.tar.gz', remoteDir: '$HOME/runs/of-001' }]);
  assert.equal(r.placeholders.home, true);
  assert.equal(r.placeholders.jobManagerId, true);
  assert.match(r.remoteCommand, /interFoam -parallel/);
  assert.ok(r.submitBody.mapAppJobInfo);

  const real = await op('preview_job_template').handler({
    template: JSON.stringify(ofBase()),
    home: '/work/home/demo-user',
    jobManagerId: 'jm-1',
    userName: 'demo-user',
  });
  assert.equal(real.workDir, '/work/home/demo-user/runs/of-001');
  assert.equal(real.placeholders.home, false);
  assert.equal(real.placeholders.jobManagerId, false);
});
