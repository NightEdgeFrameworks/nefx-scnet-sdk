/**
 * OpenFOAM 远端命令渲染 —— 作业模板的第四个命令来源（与 fluent / commandFile / command 四选一）。
 *
 * 为什么单独一个文件：`jobtemplate.ts` 的 `SPEC` 是**字段**的唯一事实来源（AGENTS 第 1 条），
 * 而这里只负责把 `openfoam` 那一组**渲染成远端 shell**。两者职责不同，文件也就分开；
 * 依赖是单向的：`jobtemplate.ts` → 这里。
 *
 * ── 这份渲染器的来源 ────────────────────────────────────────────────────────
 * 逐行抄自 2026-09-17 在曙光西安**真跑通**的三个脚本
 * （`D260914-scnet-automation/openfoam-cases/v2212-{s1b,s2,postprocess}.sh`）：

 *   作业 67825003  s1b-refined 16 核 到 Time=0.55（=endTime） 四道门全绿
 *   作业 67825012  s2-sector    8 核 到 Time=1   （=endTime） 四道门全绿
 *   作业 67852103  后处理 1 核，全时刻 reconstructPar
 *
 * ⚠ **尚未验证的一件事**：上面三个作业跑的是**手写脚本**，不是这份渲染器产出的文本。
 * 也就是说"这套门的语义"是实测过的，"这份渲染器吐出的字节与手写脚本等价"**没有实测过**。
 * 真要提交前先用 `scnet preview` 把渲染结果打出来与手写脚本逐行比一遍，
 * 再决定是否直接 `run`。这条不许在文档里被说成"已验证"。
 *
 * ── 七道门各自的判据（也是本模块对外的产物契约）────────────────────────────
 * 判据一律落在**产物**上，不看脚本返回码——平台和 shell 都可能 `rc=0` 而内容错：
 *   解包回来但算例落在子目录里、并行算例的时刻写在 `processorN/` 而根目录只有初始条件，
 *   这两种都让"rc=0"看起来完全正常。
 */

/** 门清单。`preview` 与文档从这里取，避免"三处各写一遍"。 */
export const OPENFOAM_GATES: Array<{ id: string; judge: string; why: string }> = [
  {
    id: 'GATE-ENV',
    judge: '求解器真跑一次（`<solver> -help` 返回 0）',
    why: '`command -v interFoam` 是弱判据：只证明 PATH 里有它，不证明能加载库。'
      + '簇上 module load 只挂了一半 LD_LIBRARY_PATH，漏了 lib/sys-openmpi ⇒ 每个可执行 rc=127',
  },
  {
    id: 'GATE-UNPACK',
    judge: '给了 `unpack` 就先解包，然后 `system/controlDict` 与 `0.orig` 都在才算过',
    why: '打包时多一层 <case>/ 前缀、解包又不校验，会让后面四道门一起变红，'
      + '日志看起来像"算例本身有病"。门要覆盖到数据第一次落地那一刻。'
      + '**解包与校验是一件事的两半，只做一半就等于没做**',
  },
  {
    id: 'GATE-MESH',
    judge: '`checkMesh` 的 `cells=` 等于 `expectCells`（给了才判）',
    why: '单元数是网格生成是否走对的唯一硬数字。31200 / 14832 各对应一个已知算例',
  },
  {
    id: 'GATE-SETFIELDS',
    judge: '`system/setFieldsDict` 里点名的每个场，在 `0/` 下都与 `0.orig/` **不同**；且 `0/` 里没有任何场比 `0.orig/` 小',
    why: 'setFields 失败时返回码仍可能是 0，而 `0/` 里留着模板文件——"到底改了没有"要用逐字节比较判。'
      + '**该改哪些场的真值在字典里，不能在渲染器里写死**：本算例的字典只点名 `alpha.water`，'
      + '而渲染器第一版要求 `0/` 下**每个**场都变大且含 `nonuniform`，`p_rgh`/`U` 永远不可能满足，'
      + '真提交必然假红（2026-09-17 job 67915259 实测：`p_rgh 没变大 (1408 -> 1408)`）',
  },
  {
    id: 'GATE-DECOMPOSE',
    judge: '`processor*` 目录数等于 `decomposeParDict` 的 `numberOfSubdomains`',
    why: '两者不一致时 decomposePar 会成功但分区数是错的（例如 dict 写 16 而只传了 8 个进程）',
  },
  {
    id: 'GATE-LAUNCHER',
    judge: '`mpirun <候选> -np <cores> hostname` 返回 0，且 hostname 行数等于 cores',
    why: '`--bind-to core` 在不同节点命运不同：有的节点 rc=0，有的必须 `--bind-to none --oversubscribe`。'
      + '照抄别的节点选出来的 launcher 无效，且绑定与否会让两次墙钟不可比',
  },
  {
    id: 'GATE-SOLVER',
    judge: '日志末行 `Time =` 等于 `endTime`（给了才判），且 `FOAM FATAL|sigFpe` 计数为 0',
    why: '求解器遇到 alpha 越界/FPE 可能打印 FOAM FATAL 后自行退出，脚本层 rc 未必红',
  },
];

/**
 * `openfoam` 组的字段形状。
 *
 * 类型定义放在这里而不是 `jobtemplate.ts`：那边只从 `SPEC` 派生，不重复描述。
 */
export interface OpenfoamSpec {
  openfoamRoot: string;
  moduleName: string;
  platform: string;
  solver: string;
  caseSubdir: string;
  /** 算例以归档形式上到 workDir 时，给归档名（相对 workDir）。给了就先解包再判 GATE-UNPACK。 */
  unpack?: string;
  cores: number;
  launcherCandidates: string[];
  prepare: boolean;
  expectCells?: number;
  endTime?: string;
  reconstruct: boolean;
  reconstructAll: boolean;
  env: string[];
  preCommands: string[];
  extraSolveArgs: string[];
  postCommands: string[];
}

const sh = (s: string) => `"${String(s).replace(/"/g, '\\"')}"`;

/**
 * 路径/名字类字段的白名单校验。
 *
 * 为什么要有这个：`solver`、`openfoamRoot`、`platform` 这些会被拼进**远端 shell**，
 * 而且 `solver` 还会进日志文件名（`log.<solver>.fresh`）。不校验的话一个引号就能改写命令。
 * 白名单比转义更硬——这些字段本来就不该出现空白、引号、`$`、`;`、反引号。
 *
 * **不适用于 `launcherCandidates`**：那是有意为之的 shell 片段（`mpirun --bind-to core`），
 * 只能由可信来源填写。它进渲染结果时是**不引号**拼接的，这是它的用法本身。
 */
const TOKEN_OK = /^\/?[A-Za-z0-9_][A-Za-z0-9_.+/-]*$/;

function safeToken(v: string, field: string): string {
  if (typeof v !== 'string' || !TOKEN_OK.test(v)) {
    throw new Error(
      `openfoam.${field} 含非法字符：${JSON.stringify(v)}（只允许字母数字与 _ . + / -，且不以 / 之外的特殊字符开头）`,
    );
  }
  return v;
}


/**
 * 由 `openfoam` 段生成远端要执行的 shell。
 *
 * 结构（顺序不许改，每一步都是前面某一步的判据）：
 *   环境装配 → GATE-ENV → 进算例目录 → GATE-UNPACK → 重启检测
 *   → 新鲜时：GATE-MESH / setFields / GATE-SETFIELDS / decomposePar / GATE-DECOMPOSE
 *   → GATE-LAUNCHER 选 launcher → 求解 → GATE-SOLVER → reconstructPar
 */
export function renderOpenfoamCommand(o: OpenfoamSpec): string {
  const L: string[] = [];
  // 这几个字段会进远端 shell 与日志文件名，先过白名单——白名单比事后转义更硬。
  const solver = safeToken(o.solver, 'solver');
  safeToken(o.openfoamRoot, 'openfoamRoot');
  safeToken(o.moduleName, 'moduleName');
  safeToken(o.platform, 'platform');
  const np = Math.max(1, Math.floor(o.cores || 1));
  const caseDir = o.caseSubdir && o.caseSubdir !== '.' ? o.caseSubdir : '.';

  // 不用 `set -e`：这一整套判据是**看产物**，不是看返回码，而 `set -e` 会把
  // "合法且预期" 的非零返回也当致命错误静默终止脚本。2026-09-17 实测踩到的正是这个：
  // 平台把命令文件**内联**进 slurm 脚本（`# MARK_CMD` 之后），只有 `set -e` 时
  // `. "$APPS/etc/bashrc" >/dev/null 2>&1` 的非零返回让作业在**任何一行输出之前**退出——
  // stdout 里只剩平台横幅，看起来像"命令没被执行"。手写脚本当年写的是 `set +e`，就是这个原因。
  // 同类地雷：`$(grep -oE ...)` 在**没匹配到**时 rc=1，"没匹配"在这里是合法状态。
  // 所以每一步的失败判据都必须显式写出来（下面每一道门都是这么做的）。
  L.push('set +e');
  L.push('');
  L.push('# ── 环境装配（source etc/bashrc 是必须的，module load 只挂了一半 LD_LIBRARY_PATH）');
  L.push(`APPS=${sh(o.openfoamRoot)}`);
  L.push('if [ ! -d "$APPS" ]; then echo "GATE-ENV FAIL: openfoamRoot 不存在: $APPS"; exit 20; fi');
  L.push(`module load ${o.moduleName} >/dev/null 2>&1 || true`);
  L.push('export WM_PROJECT_DIR="$APPS"');
  L.push('export FOAM_INST_DIR="$(dirname "$APPS")"');
  // `|| true` 是必须的：这份 bashrc 在非交互 shell 里最后一条命令的返回码不为 0 是常态
  // （手写脚本的注释里写着同一件事）。加了它，`set +e` 之上再少一个静默退出的机会。
  L.push('. "$APPS/etc/bashrc" >/dev/null 2>&1 || true');
  L.push(`LIBROOT="$(dirname "$APPS")/$(basename "$APPS")/platforms/${o.platform}/lib"`);
  L.push('export FOAM_MPI="${FOAM_MPI:-sys-openmpi}"');
  L.push('export FOAM_LIBBIN="$LIBROOT/$FOAM_MPI"');
  L.push(`export FOAM_APPBIN="$APPS/platforms/${o.platform}/bin"`);
  L.push('export LD_LIBRARY_PATH="$FOAM_LIBBIN:$LIBROOT:$LD_LIBRARY_PATH"');
  L.push('export PATH="$FOAM_APPBIN:$APPS/bin:$PATH"');
  for (const e of o.env) L.push(`export ${e}`);
  L.push('# GATE-ENV：真跑一次。command -v 只证明 PATH 里有它，不证明能加载 libPstream.so');
  L.push(`if ! ${sh(solver)} -help >/dev/null 2>&1; then`);
  L.push(`  echo "GATE-ENV FAIL: ${solver} -help 非 0（缺 libPstream.so？看 openfoamRoot/platform 与 moduleName）"; exit 21`);
  L.push('fi');
  L.push('echo "GATE-ENV OK  WM_PROJECT_VERSION=$WM_PROJECT_VERSION  $(nproc) cores  job=${SLURM_JOB_ID:-?}"');
  for (const c of o.preCommands) L.push(c);

  L.push('');
  // 解包必须在 CASE 检查**之前**：算例是以一个归档上来的，解包完才算"数据落地"。
  // 这两半合起来才叫 GATE-UNPACK——只解包不校验，就漏掉了 <case>/ 前缀那一类错。
  if (o.unpack) {
    const archive = safeToken(o.unpack, 'unpack');
    L.push('# GATE-UNPACK 前半：算例是归档上来的，先解到当前目录（workDir）');
    L.push(`_ar="$PWD/${archive}"`);
    L.push(`if [ ! -f "$_ar" ]; then echo "GATE-UNPACK FAIL: 归档不存在: $_ar（上传清单里有没有它？）"; ls -a "$PWD"; exit 22; fi`);
    L.push('case "$_ar" in');
    L.push('  *.tar.gz|*.tgz) tar -xzf "$_ar" || { echo "GATE-UNPACK FAIL: tar -xzf 失败: $_ar"; exit 22; } ;;');
    L.push('  *.tar)          tar -xf  "$_ar" || { echo "GATE-UNPACK FAIL: tar -xf 失败: $_ar"; exit 22; } ;;');
    L.push('  *.zip)          unzip -q -o "$_ar" || { echo "GATE-UNPACK FAIL: unzip 失败: $_ar"; exit 22; } ;;');
    L.push(`  *) echo "GATE-UNPACK FAIL: 不认识的归档后缀: $_ar（要 .tar.gz/.tgz/.tar/.zip）"; exit 22 ;;`);
    L.push('esac');
    L.push('echo "  解包完成：$_ar → $PWD"');
  }
  L.push(`CASE="$PWD/${caseDir}"`);
  L.push('[ -d "$CASE" ] || { echo "GATE-UNPACK FAIL: 算例目录不存在: $CASE"; exit 22; }');
  L.push('cd "$CASE"');
  L.push('# GATE-UNPACK：数据第一次落地的门。缺了它，下游四道门会一起变红而原因看不出来');
  L.push('if [ ! -f system/controlDict ] || [ ! -d 0.orig ]; then');
  L.push('  echo "GATE-UNPACK FAIL: $CASE 里没有 system/controlDict 或 0.orig，实际内容："; ls -a "$CASE"; exit 23');
  L.push('fi');
  L.push('echo "GATE-UNPACK OK  $CASE"');
  L.push('echo "  归档里的 endTime: $(grep -E "^ *endTime" system/controlDict || echo "?")"');

  // openfoam.endTime 不只是"判据"，它是这一轮**必须达到的时刻**（GATE-SOLVER 拿它判末时刻）。
  // 而算例归档里的 controlDict 可能与它不同——续算时**必然**不同：归档写着 `endTime 0.55`，
  // 而续算这一轮的目标是 0.60。不把模板值写进 controlDict，GATE-SOLVER 必然报
  // "末时刻 != endTime"，而现场看起来像"算例算错了"，没人会想到是两边口径没对齐。
  // 只在字面量是纯数字时改：sed 的替换文本不能带任意字符（要改就得先过这一关）。
  if (o.endTime !== undefined) {
    if (/^[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/.test(o.endTime)) {
      L.push('# openfoam.endTime 是这一轮的目标时刻，写进 controlDict（否则末时刻判据必然假红）');
      L.push("_et_before=$(grep -E '^ *endTime' system/controlDict || true)");
      L.push(`sed -i 's/^ *endTime.*/endTime         ${o.endTime};/' system/controlDict`);
      L.push(`echo "  controlDict endTime: $_et_before -> $(grep -E '^ *endTime' system/controlDict)"`);
    } else {
      L.push(`# openfoam.endTime = ${o.endTime} 不是纯数字，不写进 controlDict（只当 GATE-SOLVER 的判据）`);
    }
  }

  // 重启检测。判据是**只有** `processor0`：续算必须有分解后的时刻目录，光有网格不够。
  // 曾把 `constant/polyMesh` 也算作"可续算"，那是错的——上一轮若死在建网格与分区之间
  // （2026-09-17 job 67915259 就是：blockMesh 成功、setFields 判失败、decomposePar 没跑），
  // 残留的 polyMesh 会让下一轮判成续算、跳过 decomposePar，求解器在没有 processor* 的
  // 情况下起来，报出来的错与真因无关。手写脚本当年用的也是 `[ -d processor0 ]` 一条。
  L.push('FRESH=1');
  L.push('if [ -d processor0 ]; then FRESH=0; fi');
  L.push('echo "  FRESH=$FRESH (0=检测到已有网格/分区，走续算分支，不重跑 blockMesh/decomposePar)"');
  L.push('if [ "$FRESH" = "1" ]; then');
  // 求解器日志按分支命名。不这么做有两个后果：①文件名撒谎（续算那轮的日志也叫 .fresh）；
  // ②**续算会覆盖掉新鲜那一轮的日志**——那是唯一一份"新鲜分支真跑过"的证据
  //（job 67916044 的 log.interFoam.fresh 有 160 MB），被悄悄盖掉就再也拿不回来了。
  L.push('  _tag=fresh');
  if (o.prepare) {
    // 新鲜分支先清掉上一轮可能残留的 OpenFOAM 状态。只清"本该被这一轮重造"的东西，
    // 上传的输入与归档（可能就在当前目录）一个都不动——这比手写脚本的 `rm -rf $ROOT` 保守。
    L.push('  # 清掉上一轮残留的 OpenFOAM 状态（归档与上传的输入不动）：半截的 0/ 与 processor*');
    L.push('  # 会让本轮读到脏状态，而它们本来就要被 blockMesh/setFields/decomposePar 重造。');
    L.push('  rm -rf 0 constant/polyMesh processor*');
    L.push('  echo "--- blockMesh"; blockMesh > log.blockMesh 2>&1 || { echo "FAIL blockMesh"; tail -30 log.blockMesh; exit 24; }');
    L.push('  echo "--- checkMesh"; checkMesh > log.checkMesh 2>&1 || { echo "FAIL checkMesh"; tail -30 log.checkMesh; exit 25; }');
    L.push(`  _cells=$(grep -oE 'cells:[[:space:]]*[0-9]+' log.checkMesh | head -1 | grep -oE '[0-9]+')`);
    L.push('  echo "  checkMesh cells=$_cells"');
    if (o.expectCells !== undefined) {
      L.push(`  if [ "$_cells" != "${o.expectCells}" ]; then`);
      L.push(`    echo "GATE-MESH FAIL: cells=$_cells 期望 ${o.expectCells}"; exit 26`);
      L.push('  fi');
    }
    L.push('  echo "GATE-MESH OK  cells=$_cells"');
    L.push('  if [ -d 0.orig ]; then rm -rf 0; cp -r 0.orig 0; fi');
    L.push('  echo "--- setFields"; setFields > log.setFields 2>&1 || { echo "FAIL setFields"; tail -30 log.setFields; exit 27; }');
    L.push('  # GATE-SETFIELDS：判据**从 system/setFieldsDict 里读**——"该改哪些场"的真值在字典里，');
    L.push('  # 不在渲染器里。写死场名/要求"每个场都变大"会让本算例假红（2026-09-17 job 67915259 实测）。');
    L.push(`  _wantf=$(sed 's|//.*||' system/setFieldsDict 2>/dev/null | grep -oE 'vol[A-Za-z]+FieldValue[[:space:]]+[A-Za-z0-9_.]+' | awk '{print $2}' | sort -u)`);
    L.push('  if [ -z "$_wantf" ]; then echo "GATE-SETFIELDS FAIL: 从 system/setFieldsDict 解析不出任何 vol*FieldValue（字典为空或写法不认识），判不了"; exit 28; fi');
    L.push('  for _b in $_wantf; do');
    L.push('    _f="0/$_b"; _o="0.orig/$_b"');
    L.push('    if [ ! -f "$_f" ]; then echo "GATE-SETFIELDS FAIL: 字典点名 $_b，但 0/$_b 不存在"; exit 28; fi');
    L.push('    if [ -f "$_o" ] && cmp -s "$_f" "$_o"; then echo "GATE-SETFIELDS FAIL: 字典点名 $_b，但 0/$_b 与 0.orig/$_b 逐字节相同（setFields 没生效）"; exit 28; fi');
    L.push(`    echo "    $_b: 0.orig=$(stat -c%s "$_o" 2>/dev/null || echo -)B -> 0/$(stat -c%s "$_f")B  nonuniform=$(grep -ac nonuniform "$_f" 2>/dev/null || true)"`);
    L.push('  done');
    L.push('  # 截断/残留模板的探针：0/ 里任何场都不许比 0.orig/ 小');
    L.push('  for _f in 0/*; do');
    L.push('    [ -f "$_f" ] || continue; _b=$(basename "$_f"); _o="0.orig/$_b"');
    L.push('    [ -f "$_o" ] || continue');
    L.push('    _sn=$(stat -c%s "$_f"); _so=$(stat -c%s "$_o")');
    L.push('    if [ "$_sn" -lt "$_so" ]; then echo "GATE-SETFIELDS FAIL: $_b 比 0.orig 小（$_so -> $_sn），像被截断或写了模板"; exit 28; fi');
    L.push('  done');
    L.push('  echo "GATE-SETFIELDS OK  字典点名的场都已生效，且 0/ 无场变小"');
    L.push(`  echo "--- decomposePar -force -subdomains=${np}"`);
    L.push('  # 注意：只传进程数改不了分区数，numberOfSubdomains 在 decomposeParDict 里。下一道门专门查这个');
    L.push(`  decomposePar -force > log.decomposePar 2>&1 || { echo "FAIL decomposePar"; tail -30 log.decomposePar; exit 29; }`);
    L.push(`  _want=$(grep -oE 'numberOfSubdomains[[:space:]]+[0-9]+' system/decomposeParDict | grep -oE '[0-9]+' | head -1)`);
    L.push('  _got=$(ls -d processor* 2>/dev/null | wc -l)');
    L.push(`  if [ -n "$_want" ] && [ "$_want" != "$_got" ]; then`);
    L.push(`    echo "GATE-DECOMPOSE FAIL: processor 目录 $_got 个，decomposeParDict 要 $_want 个"; exit 30`);
    L.push('  fi');
    L.push('  echo "GATE-DECOMPOSE OK  processor dirs=$_got/$_want"');
  } else {
    L.push('  echo "openfoam.prepare=false：跳过 blockMesh/checkMesh/setFields/decomposePar"');
  }
  L.push('else');
  L.push('  _tag=restart');
  L.push('  echo "  续算：跳过建网格与分区（它们会覆盖已有结果）"');
  // 续算的起点：processor0 里最新的时刻目录。求解器起来后日志里第一个 `Time = ` 必须等于它——
  // 这一条是 GATE-RESTART 的判据（见下）。只打"FRESH=0、没重建网格"是不够的。
  L.push('  _resume=$(ls -d processor0/[0-9]* 2>/dev/null | sed \'s|.*/||\' | sort -g | tail -1)');
  L.push('  echo "    processor0 里的最新时刻 $_resume（求解器必须从这里起算）"');
  // 续算的第二半：必须把 `startFrom` 改成 `latestTime`。算例归档里写的是
  // `startFrom startTime; startTime 0;`，不改这一行的话求解器会从 t=0 重跑，
  // 把磁盘上已有的几十个时刻**全部重算一遍**——看起来"在续算"，其实白烧一轮机时。
  // 手写脚本当年就是 `sed -i 's/^startFrom.*/startFrom latestTime;/'`，我抄漏了。
  L.push('  # 续算必须让 controlDict 从最新时刻起算，否则等于从 0 重跑');
  L.push(`  sed -i 's/^ *startFrom.*/startFrom       latestTime;/' system/controlDict`);
  L.push('  echo "    controlDict: $(grep -E \'^ *startFrom\' system/controlDict)"');
  L.push('fi');

  // GATE-LAUNCHER。逐个候选真跑一次 hostname 冒烟，回行数必须等于核数——
  // 只看返回码不够：槽位映射失败时有的 mpirun 仍回 0 而少回几行。
  L.push('');
  // 平台按 `#SBATCH -n N` 批量起（N 个任务 × 1 CPU），批处理步本身可能只绑 1 个核；
  // mpirun 继承这个掩码后只看到 1 个 cpu，`--bind-to core` 会拒绝 N 个 rank——
  // 于是三个候选全挂，报"没有可用 launcher"，而真因是 CPU 掩码。手写脚本先按 cgroup 的
  // 有效 cpuset 放宽了一次；放宽不了也无妨，下面的候选循环会自己挑。
  L.push('# 先按 cgroup 的有效 cpuset 放宽 CPU 掩码（批处理步可能只绑 1 个核）');
  L.push('_cpus=$(cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null || true)');
  L.push('[ -n "$_cpus" ] || _cpus=$(cat /sys/fs/cgroup/cpuset/cpuset.effective_cpus 2>/dev/null || true)');
  L.push('[ -n "$_cpus" ] && taskset -pc "$_cpus" $$ >/dev/null 2>&1');
  L.push('echo "  nproc=$(nproc)  affinity=$(taskset -pc $$ 2>&1)"');
  L.push('# GATE-LAUNCHER：绑定核在不同节点命运不同，必须现场选，不能照抄别的节点');
  L.push('LAUNCH=""');
  for (const cand of o.launcherCandidates) {
    L.push(`if [ -z "$LAUNCH" ]; then`);
    L.push(`  _n=$(${cand} -np ${np} hostname 2>/dev/null | wc -l || true)`);
    L.push(`  if [ "$_n" = "${np}" ]; then LAUNCH=${sh(cand)}; echo "GATE-LAUNCHER OK  [${cand}] hostlines=$_n"; fi`);
    L.push('fi');
  }
  L.push('if [ -z "$LAUNCH" ]; then echo "GATE-LAUNCHER FAIL: 所有候选都不行（见 openfoam.launcherCandidates）"; exit 31; fi');

  L.push('');
  // 日志名带分支后缀（$_tag）——见上面 `_tag=fresh/restart` 那段：不带后缀时续算会**覆盖**
  // 新鲜那一轮的求解器日志，而那是唯一一份"新鲜分支真跑过"的原始证据（实测 160 MB）。
  L.push('_slog="log.' + solver + '.$_tag"');
  L.push(`echo "--- ${solver} -parallel  (np=${np})  日志 $_slog"`);
  L.push(`$LAUNCH -np ${np} ${sh(solver)} -parallel ${o.extraSolveArgs.join(' ')} > "$_slog" 2>&1`);
  L.push('_rc=$?');

  // GATE-SOLVER。判据是日志内容而不是 _rc。
  // 首末两个时刻都要打：只有一个末时刻时，"续算是不是真的从断点起算"根本看不出来
  // ——startFrom 没生效的话，从 0 重算到同一个 endTime，末时刻一模一样。
  L.push('# GATE-SOLVER：判据落在日志内容上，不看返回码');
  L.push(`_fatal=$(grep -cE 'FOAM FATAL|sigFpe|floating point exception' "$_slog" || true)`);
  L.push(`_first=$(grep -hE '^Time = ' "$_slog" | head -1 | awk '{print $3}')`);
  L.push(`_last=$(grep -hE '^Time = ' "$_slog" | tail -1 | awk '{print $3}')`);
  L.push(`echo "  ${solver} rc=$_rc  Time $_first -> $_last  FOAM FATAL/sigFpe = $_fatal"`);
  L.push('if [ "$_fatal" != "0" ]; then echo "GATE-SOLVER FAIL: 日志里有 $_fatal 条 FOAM FATAL/sigFpe"; exit 32; fi');
  L.push('if [ "$_rc" != "0" ]; then echo "GATE-SOLVER FAIL: 求解器 rc=$_rc"; exit 33; fi');
  // GATE-RESTART：续算分支必须**真的**从 processor0 的最新时刻起算。
  // 只证明"FRESH=0、没重建网格"是不够的：startFrom 没改成 latestTime 时，求解器照样安安静静
  // 从 0 重算一遍，产物看起来完全正常（末时刻还是 endTime），**没有任何一道门会红**。
  //
  // 判据用求解器的**启动横幅** `Create mesh for time = <T>`：它在迈出第一步之前就打出来，
  // 直接说明"从哪个时刻读的网格"（2026-09-17 用本机 v2212 同算例日志核对：interFoam 第 25 行）。
  //
  // ★第一版判据是"日志里第一个 `Time = ` 必须等于 `_resume`"，那是**结构性假红**：
  //   OpenFOAM 的 `Time::operator++` 先推进时间、再打印，所以健康续算的第一个 Time 是
  //   `_resume + Δt`，永远不等于 `_resume`。2026-09-17 job 67942379 是一次**成功**的续算
  //   （0.55 -> 0.6、rc=0、无 FOAM FATAL），却被这条判成 FAIL(37)，白烧 12 分钟机时。
  //   排练脚本当时也没抓住它——因为 stub 是照我那个错理解写的（它把 `Time = $resume`
  //   当第一个 Time 打出来）。stub 只能验证"我以为求解器怎么行为"，验证不了真实行为。
  //
  // 兜底（横幅认不出时，例如换了求解器或版本）：用**数值**比较 `_first > _resume`——
  // 从 0 重算时 _first ≈ 1e-5，远小于 `_resume`。两处都不用字符串相等。
  L.push('# GATE-RESTART：续算的起算时刻必须等于 processor0 的最新时刻');
  L.push('_start=$(grep -m1 -E \'^Create mesh for time = \' "$_slog" | sed \'s/.*= *//\')');
  L.push('if [ "$FRESH" = "0" ]; then');
  L.push('  if [ -n "$_start" ]; then');
  L.push('    if [ "$_start" != "$_resume" ]; then');
  L.push('      echo "GATE-RESTART FAIL: 启动横幅 Create mesh for time = $_start，processor0 最新时刻是 $_resume —— 不是从断点起算（startFrom latestTime 没生效？）"; exit 37');
  L.push('    fi');
  L.push('    echo "GATE-RESTART OK  起算时刻 $_start = processor0 最新时刻（确认续算；首个 Time=$_first 是它迈出第一步之后）"');
  L.push('  elif awk -v a="$_first" -v b="$_resume" \'BEGIN{exit !((a+0) > (b+0))}\'; then');
  L.push('    echo "GATE-RESTART OK（兜底判据）日志里没有 Create mesh 横幅，但首个 Time=$_first > processor0 最新时刻 $_resume"');
  L.push('  else');
  L.push('    echo "GATE-RESTART FAIL: 日志里既没有 Create mesh 横幅，首个 Time=$_first 也不大于 processor0 最新时刻 $_resume —— 判不出这是续算"; exit 37');
  L.push('  fi');
  L.push('fi');
  if (o.endTime !== undefined) {
    L.push(`_want_t=${sh(o.endTime)}`);
    L.push('if [ "$_last" != "$_want_t" ]; then echo "GATE-SOLVER FAIL: 末时刻 $_last != endTime $_want_t"; exit 34; fi');
  }
  L.push('echo "GATE-SOLVER OK  Time $_first -> $_last"');

  if (o.reconstruct) {
    L.push('');
    const flag = o.reconstructAll ? '' : '-latestTime ';
    L.push(`echo "--- reconstructPar ${flag}(串行场写回算例根)"`);
    // 同样带 $_tag：不带的话续算会把新鲜那轮的重构日志一起盖掉
    L.push(`reconstructPar ${flag}> "log.reconstructPar.$_tag" 2>&1 || { echo "FAIL reconstructPar"; tail -30 "log.reconstructPar.$_tag"; exit 35; }`);
    L.push('echo "  serial time dirs: $(ls -d [0-9]* 2>/dev/null | grep -v "\\.orig$" | tr "\\n" " ")"');
    L.push('# 判据：根目录必须出现末时刻。并行算例的时刻写在 processorN/ 里，');
    L.push('# 所以"根目录只有 0/ 和 0.orig/"意味着重构没做或没做对，而不是算例没算');
    L.push(`if ! ls -d [0-9]* 2>/dev/null | grep -v '\\.orig$' | grep -qx "$_last"; then`);
    L.push('  echo "FAIL reconstructPar: 根目录没有末时刻 $_last"; exit 36');
    L.push('fi');
  }
  for (const c of o.postCommands) L.push(c);
  L.push('echo "=== OPENFOAM RUN END  rc=$_rc ==="');
  L.push('exit $_rc');
  return L.join('\n');
}
