#!/bin/bash
# ============================================================================
#  rehearse-openfoam.sh —— 把 renderOpenfoamCommand() 的产物在**本地**跑一遍
#
#  为什么要有它：这份渲染器长期挂着一句"从未被当作真实作业提交过"。
#  但"提交一次"是昂贵且不可重复的验证——2026-09-17 为此花掉两个真作业，
#  其中一个死在一个**判据自己写错**的地方（GATE-SETFIELDS 要求 0/ 下每个场都变大，
#  而算例的 setFieldsDict 只点名 alpha.water）。
#
#  这个脚本用一组 stub 顶替 OpenFOAM 的可执行文件，把**渲染器原样产出的 shell
#  逐行真跑**：七道门的顺序、分支、退出码、以及"判据会不会假红"全都能离线看到。
#  它证明不了"簇上能算"，但能证明"这段 shell 在算例结构正确时会全绿、在算例结构
#  错误时会红在对的地方"——这正是每次改判据时最容易搞坏的东西。
#
#  跑法（Windows 上用 Git Bash）：
#      bash tools/rehearse-openfoam.sh
#  依赖：bash / tar / awk / seq / node。不需要 OpenFOAM，不需要网络，不碰超算。
#
#  五个场景：
#    A 新鲜全绿      —— 期望七道门全 OK、rc=0
#    B setFields 空转 —— 负对照：期望 GATE-SETFIELDS 红，且理由说的是"逐字节相同"
#    C 续算分支      —— 期望跳过建网格四步，只走 LAUNCHER/RESTART/SOLVER，
#                       且求解器**启动横幅**里的起算时刻 == processor0 最新时刻（0.55 → 0.60）
#    D 续算假绿      —— 负对照：一个"没把 startFrom 当回事"的求解器（永远从 0 开始），
#                       期望 GATE-RESTART 咬住它（rc=37）
#    E 无横幅假绿    —— 负对照：D 的变体，日志里没有 `Create mesh` 横幅，
#                       期望兜底判据（数值比较首个 Time）咬住它（rc=37）
#
#  ⚠️ 2026-09-17 的教训：这个脚本一个版本曾经**全绿**，而真作业红在 GATE-RESTART。
#  原因是 stub 的 interFoam 把 `Time = $resume` 当第一个 Time 打出来——那是**我当时的
#  错误理解**，真 OpenFOAM 不会那样（`Time::operator++` 先推进时间再打印，健康续算的
#  首个 Time 是 `resume + Δt`；启动横幅 `Create mesh for time = <T>` 才是起算时刻，
#  见本机 v2212 日志第 25 行）。**stub 只能验证"我以为求解器怎么行为"，验证不了真实行为**——
#  写 stub 时必须照着真日志的字面输出抄，抄错就等于给自己发了一张假绿卡。
# ============================================================================
set +e

HERE="$(cd "$(dirname "$0")" && pwd)"
CLIENT="$(cd "$HERE/.." && pwd)"
TARBALL="$CLIENT/../D260914-scnet-automation/openfoam-cases/dist-v2212/s1b-refined-v2212.tar.gz"
TPL="$CLIENT/out/of-verify-s1b.job.json"

die() { echo "REHEARSE-ABORT: $*"; exit 2; }
[ -f "$TARBALL" ] || die "找不到算例归档：$TARBALL"
[ -f "$TPL" ]     || die "找不到验证模板：$TPL（它放在 gitignore 的 out/ 下）"
command -v cygpath >/dev/null 2>&1 || die "需要 cygpath（Git Bash 自带）"

WORK="$CLIENT/out/rehearse"
STUBS="$WORK/stubs"
rm -rf "$WORK"
mkdir -p "$STUBS"

APPS="$WORK/apps/OpenFOAM-v2212"
mkdir -p "$APPS/etc" "$APPS/platforms/linux64GccDPInt32Opt/bin" "$APPS/platforms/linux64GccDPInt32Opt/lib"
: > "$APPS/etc/bashrc"          # git bash 里没有真 bashrc；渲染器对它加了 `|| true`

# ── stub：顶替 OpenFOAM 的可执行文件 ────────────────────────────────────────

cat > "$STUBS/module" <<'EOF'
#!/bin/bash
exit 0
EOF

cat > "$STUBS/taskset" <<'EOF'
#!/bin/bash
echo "pid $$'s current affinity list: 0-15"
exit 0
EOF

cat > "$STUBS/mpirun" <<'EOF'
#!/bin/bash
# 真 mpirun 会把命令行里剩下的部分跑起来；这个 stub 必须照做，
# 否则 `mpirun -np N interFoam -parallel > log...` 只产出 hostname 行，
# GATE-SOLVER 会红在"末时刻为空"上——那是 stub 的错，不是渲染器的错。
np=1
rest=()
while [ $# -gt 0 ]; do
  case "$1" in
    -np) shift; np="$1" ;;
    --bind-to) shift ;;
    -*) ;;
    *) rest+=("$1") ;;
  esac
  shift
done
if [ "${rest[0]}" = "hostname" ]; then
  i=0
  while [ "$i" -lt "$np" ]; do echo "rehearse-node$i"; i=$((i+1)); done
  exit 0
fi
exec "${rest[@]}"
EOF

cat > "$STUBS/blockMesh" <<'EOF'
#!/bin/bash
mkdir -p constant/polyMesh
echo "Creating mesh for blockMeshDict"
echo "  nCells: 31200"
exit 0
EOF

cat > "$STUBS/checkMesh" <<'EOF'
#!/bin/bash
echo "Create time"
echo "    cells:           31200"
echo "    faces:           91000"
echo "Mesh OK."
exit 0
EOF

# setFields：忠实缩影——**只改字典里点名的那些场**。
# 本算例的 system/setFieldsDict 只点名 alpha.water（全域 1、轴上圆柱 0），
# 所以 stub 也只写 alpha.water：p_rgh/U 保持与 0.orig 逐字节相同。
# 这一点是刻意的：渲染器第一版要求"每个场都变大"，在这个 stub 下必然假红。
cat > "$STUBS/setFields" <<'EOF'
#!/bin/bash
N=31200
awk -v N="$N" '
  /^internalField/ {
    print "internalField   nonuniform List<scalar>";
    print N;
    print "(";
    for (i = 0; i < N; i++) print "1";
    print ")";
    print ";";
    next
  }
  { print }
' 0.orig/alpha.water > 0/alpha.water
echo "Setting volume field default values"
echo "    - set internal values of volScalarField: alpha.water = 1"
echo "    Adding cells with centres within cylinder, radius = 0.0025"
echo "    Selected 5200/31200 cells"
echo "End"
exit 0
EOF

cat > "$STUBS/decomposePar" <<'EOF'
#!/bin/bash
want=$(grep -oE 'numberOfSubdomains[[:space:]]+[0-9]+' system/decomposeParDict | grep -oE '[0-9]+' | head -1)
[ -n "$want" ] || want=2
i=0
while [ "$i" -lt "$want" ]; do
  mkdir -p "processor$i/0" "processor$i/constant"
  for f in 0/*; do [ -f "$f" ] && cp "$f" "processor$i/0/$(basename "$f")"; done
  cp -r constant/polyMesh "processor$i/constant/" 2>/dev/null
  i=$((i+1))
done
echo "Processor $want:  Decomposing mesh"
exit 0
EOF

cat > "$STUBS/interFoam" <<'EOF'
#!/bin/bash
for a in "$@"; do [ "$a" = "-help" ] && exit 0; done
# 写 **stdout**，不写某个写死的文件名：日志叫什么由渲染器决定（`log.<solver>.<分支>`），
# stub 跟着走。第一版写死 `log.interFoam.fresh`，渲染器一改命名 stub 就不对了。
#
# ★输出必须**逐字照着真 v2212 interFoam 的日志抄**，顺序也不能改：
#   ① `Create mesh for time = <起算时刻>` —— 起步之前打的，说的是"从哪个时刻读的网格"。
#      本机 v2212 同算例日志实测在第 25 行（`Create mesh for time = 0`）。
#   ② 之后的 `Time = ` 是**迈出一步之后**的时刻（`Time::operator++` 先推进再打印），
#      所以健康续算的第一个 Time 是 起算时刻 + Δt，**永远不等于**起算时刻。
#      2026-09-17 job 67942379 实测：断点 0.55，首个 Time = 0.550004。
#   第一版 stub 少了①、且把②写成了 `Time = $resume`：它验证的是我当时的错误理解，
#   于是 GATE-RESTART 那条假红判据在排练里全绿、在真作业上红掉。
want=$(grep -E '^ *endTime' system/controlDict 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -1)
resume=$(ls -d processor0/[0-9]* 2>/dev/null | sed 's|.*/||' | sort -g | tail -1)
[ -n "$resume" ] || resume=0
echo "Create mesh for time = $resume"
if [ -n "$resume" ] && [ "$resume" != "0" ]; then
  # 续算：从断点迈出第一步（+4e-6，量级与真作业的 5.1e-6 同阶），然后往 want 推进
  first=$(awk -v a="$resume" 'BEGIN{printf "%.6f", a+0.000004}')
  echo "Time = $first"
  last="$resume"
  if [ "$want" != "$resume" ]; then echo "Time = $want"; last="$want"; fi
  echo "  （续算：起算 $resume，首个 Time=$first，末时刻 $last）"
else
  last=""
  for t in 0.05 0.15 0.25 0.35 0.45 0.55; do echo "Time = $t"; last="$t"; done
fi
echo "Courant Number mean: 0.02 max: 0.31"
echo "End"
# 并行时刻写在 processorN/ 里，不在算例根——这正是 GATE-SOLVER 要区分的那件事
[ -n "$last" ] && for d in processor*; do [ -d "$d" ] && mkdir -p "$d/$last"; done
exit 0
EOF

cat > "$STUBS/reconstructPar" <<'EOF'
#!/bin/bash
# 重构"最新时刻"——同样从 processor0 现场读，不写死 0.55
last=$(ls -d processor0/[0-9]* 2>/dev/null | sed 's|.*/||' | sort -g | tail -1)
[ -n "$last" ] || { echo "no processor0 times"; exit 1; }
mkdir -p "$last"
for f in "processor0/$last"/*; do [ -f "$f" ] && cp "$f" "$last/"; done
echo "Reconstructing fields at $last"
exit 0
EOF

chmod +x "$STUBS"/*
# 负对照用的 setFields：空转（rc=0，但什么都不写）
mkdir -p "$WORK/stubs-noop"
for f in "$STUBS"/*; do ln -s "$f" "$WORK/stubs-noop/$(basename "$f")" 2>/dev/null || cp "$f" "$WORK/stubs-noop/"; done
rm -f "$WORK/stubs-noop/setFields"
cat > "$WORK/stubs-noop/setFields" <<'EOF'
#!/bin/bash
echo "Setting volume field default values"
echo "End"
exit 0
EOF
chmod +x "$WORK/stubs-noop"/*

# 负对照用的求解器：**故意忽略 processor0 的断点**，永远从 0 开始跑。
# 这正是 `startFrom latestTime` 没生效时求解器的样子——从 0 安静地重算一遍，
# 末时刻照样能走到 endTime，产物看起来完全正常。GATE-RESTART 必须咬住它。
# 横幅也照真求解器打：`Create mesh for time = 0`（从 0 读的网格），
# 所以主判据（横幅 == 断点）应当红。
mkdir -p "$WORK/stubs-noresume"
for f in "$STUBS"/*; do ln -s "$f" "$WORK/stubs-noresume/$(basename "$f")" 2>/dev/null || cp "$f" "$WORK/stubs-noresume/"; done
rm -f "$WORK/stubs-noresume/interFoam"
cat > "$WORK/stubs-noresume/interFoam" <<'EOF'
#!/bin/bash
for a in "$@"; do [ "$a" = "-help" ] && exit 0; done
want=$(grep -E '^ *endTime' system/controlDict 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -1)
echo "Create mesh for time = 0"
echo "Time = 0.000004"
last=""
for t in 0.05 0.15 0.25 0.35 0.45 0.55; do echo "Time = $t"; last="$t"; done
[ -n "$want" ] && { echo "Time = $want"; last="$want"; }
echo "End"
[ -n "$last" ] && for d in processor*; do [ -d "$d" ] && mkdir -p "$d/$last"; done
exit 0
EOF
chmod +x "$WORK/stubs-noresume"/*

# 负对照 E：横幅认不出来时的兜底判据也得咬得住。
# 这一版求解器**不打** `Create mesh for time = ` 横幅（模拟换求解器/换版本），
# 但同样从 0 起算。主判据拿不到 _start，必须由兜底判据（首个 Time 数值 ≤ 断点）咬住。
mkdir -p "$WORK/stubs-nobanner"
for f in "$STUBS"/*; do ln -s "$f" "$WORK/stubs-nobanner/$(basename "$f")" 2>/dev/null || cp "$f" "$WORK/stubs-nobanner/"; done
rm -f "$WORK/stubs-nobanner/interFoam"
cat > "$WORK/stubs-nobanner/interFoam" <<'EOF'
#!/bin/bash
for a in "$@"; do [ "$a" = "-help" ] && exit 0; done
want=$(grep -E '^ *endTime' system/controlDict 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -1)
echo "Time = 0.000004"
last=""
for t in 0.05 0.15 0.25 0.35 0.45 0.55; do echo "Time = $t"; last="$t"; done
[ -n "$want" ] && { echo "Time = $want"; last="$want"; }
echo "End"
[ -n "$last" ] && for d in processor*; do [ -d "$d" ] && mkdir -p "$d/$last"; done
exit 0
EOF
chmod +x "$WORK/stubs-nobanner"/*

# ── 用真模板渲染出 run.sh（只换掉跟本机无关的三个环境字段） ─────────────────

WINWORK="$(cygpath -m "$WORK")"

# 渲染脚本落成一个 .mjs 再跑：`node --input-type=module -e` 里 import 绝对路径
# 在 Windows 上会被当成 URL scheme（`c:`）而报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
#
# openfoamRoot 要过 safeToken 白名单（只允许字母数字与 _ . + / -）——**这是对的**，
# 集群上本来就没有盘符。而 msys 会把 `/c/...` 形式的**参数**偷偷转回 `C:/...` 再交给
# 原生 node.exe（自动 POSIX→Windows 路径转换），所以这个值不能当参数传进来：
# 让脚本自己从自身位置推出 `/c/.../out/rehearse` 形式。
cat > "$WORK/render.mjs" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTemplate, renderCommand } from '../../src/jobtemplate.ts';

const [tplPath, outPath, endTime] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const posixHere = here.replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const raw = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
raw.openfoam = Object.assign({}, raw.openfoam, {
  openfoamRoot: posixHere + '/apps/OpenFOAM-v2212',
  moduleName: 'OpenFOAM/rehearsal',
  platform: 'linux64GccDPInt32Opt',
});
// 场景 C 需要"续算到更晚的时刻"才能验 GATE-RESTART 与 endTime 对齐；
// 续算到与算例同一个 endTime 时求解器一上来就停，验不出"是不是从 0 重算"。
if (endTime) raw.openfoam.endTime = endTime;
const { errors, template } = validateTemplate(raw);
if (errors.length) { console.error('VALIDATE-FAIL: ' + errors.join(' | ')); process.exit(3); }
fs.writeFileSync(outPath, renderCommand(template) + '\n');
console.log('  run.sh 已渲染（openfoam 来源，七道门）' + (endTime ? '  endTime=' + endTime : ''));
EOF

node "$WINWORK/render.mjs" "$(cygpath -m "$TPL")" "$WINWORK/run.sh" || die "渲染失败"
# 续算场景用 endTime 0.60：算例归档里是 0.55，所以这一轮要"从 0.55 续到 0.60"。
# 这正是真作业那一轮的形状，也是唯一能验出"startFrom 没生效"的形状。
node "$WINWORK/render.mjs" "$(cygpath -m "$TPL")" "$WINWORK/run-restart.sh" 0.60 || die "渲染失败（续算脚本）"

# ── 跑一个场景 ──────────────────────────────────────────────────────────────

# run_case <名字> <算例目录名> <stub 目录> <期望 rc> <期望出现> <期望不出现> [脚本名]
# 目录已存在时**复用**（场景 C 就是靠这个看到"上一轮留下的 processor0"）
run_case() {
  local name="$1" dirname="$2" stubdir="$3" want_rc="$4" want_re="$5" deny_re="$6" script="${7:-run.sh}"
  local dir="$WORK/$dirname"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    cp "$TARBALL" "$dir/"
  fi
  local out="$WORK/$name.out"
  ( cd "$dir" && PATH="$stubdir:$PATH" bash "$WINWORK/$script" ) > "$out" 2>&1
  local rc=$?
  echo "── 场景 $name ──────────────────────────────────────────"
  grep -E 'GATE-|FAIL|解包完成|FRESH=|ALL SETUP' "$out" | sed 's/^/    /'
  echo "    rc=$rc（期望 $want_rc）"
  local bad=0
  if [ "$rc" != "$want_rc" ]; then echo "    ✗ rc 不符"; bad=1; fi
  # `-e` 是必须的：期望串可能以 `-` 开头（`--- blockMesh`），不加会被 grep 当成选项
  if [ -n "$want_re" ] && ! grep -qE -e "$want_re" "$out"; then echo "    ✗ 没看到期望的输出 /$want_re/"; bad=1; fi
  if [ -n "$deny_re" ] && grep -qE -e "$deny_re" "$out"; then echo "    ✗ 出现了不该出现的输出 /$deny_re/"; bad=1; fi
  [ "$bad" = 0 ] && echo "    ✓ 通过"
  return "$bad"
}

FAILED=0
run_case "A-fresh"   "case-fresh" "$STUBS"           0  'GATE-SOLVER OK'                  'GATE-[A-Z]* FAIL' || FAILED=1
run_case "B-noop"    "case-noop"  "$WORK/stubs-noop" 28 '逐字节相同（setFields 没生效）'   ''                 || FAILED=1
# 场景 C **复用** A 的目录：此时 processor0 已存在 → 应走续算分支，跳过建网格四步。
# 否认的是 `--- blockMesh` 这个**步骤横幅**，不是 "blockMesh" 这个词——
# FRESH=0 那行的解释文字里本来就打着 blockMesh，第一版把它当成失败信号了。
#
# 用的是 run-restart.sh（endTime 0.60）。这一条很关键：**续算到与算例同一个 endTime 时，
# 求解器一上来就停**，末时刻两种走法都一样，根本验不出"是不是从 0 重算"。要让它真的往前走
# 0.55 → 0.60，GATE-RESTART 才有分辨力。
run_case "C-restart" "case-fresh" "$STUBS"           0  'GATE-RESTART OK'                 '--- blockMesh' 'run-restart.sh' || FAILED=1

# ── 场景 C 的附加断言：光看 rc=0 与门全绿还不够 ─────────────────────────────
COUT="$WORK/C-restart.out"

# ① 续算分支必须把 controlDict 的 startFrom 改成 latestTime
if grep -qE '^ *startFrom +latestTime' "$WORK/case-fresh/system/controlDict"; then
  echo "    ✓ 续算分支把 controlDict 的 startFrom 改成了 latestTime"
else
  echo "    ✗ 续算分支没有改 startFrom —— 会从 t=0 重跑（最贵的一类假续算）"
  FAILED=1
fi

# ② endTime 必须被写进 controlDict：算例归档里是 0.55，这一轮声明的是 0.60，
#    两边不一致时 GATE-SOLVER 的"末时刻 != endTime"必然假红，而现场像算例算错了。
if grep -qE '^ *endTime +0\.60' "$WORK/case-fresh/system/controlDict"; then
  echo "    ✓ controlDict 的 endTime 被对齐到声明的 0.60"
else
  echo "    ✗ controlDict 的 endTime 没对齐（$(grep -E '^ *endTime' "$WORK/case-fresh/system/controlDict")）"
  FAILED=1
fi

# ③ 求解器的起算时刻必须是 processor0 的最新时刻（= 断点 0.55），不是 0。
#    注意首个 `Time = ` 是**迈出第一步之后**的时刻（0.55 + Δt），不是起算时刻本身——
#    这行断言跟着 stub 的忠实行为走；GATE-RESTART 的判据不在这上面（见 ⑥）。
if grep -qE 'Time 0\.5500[0-9]+ -> 0\.60' "$COUT"; then
  echo "    ✓ GATE-SOLVER 打出 Time 0.5500xx -> 0.60（首个 Time 是断点迈出一步之后，不是 0）"
else
  echo "    ✗ 没看到 Time 0.5500xx -> 0.60（$(grep -E 'Time .* ->' "$COUT" || echo '没打出首末时刻')）"
  FAILED=1
fi

# ⑥ GATE-RESTART 必须报出**起算时刻 0.55**（来自启动横幅），而不是首个 Time
if grep -qE 'GATE-RESTART OK  起算时刻 0\.55 = ' "$COUT"; then
  echo "    ✓ GATE-RESTART 用启动横幅判出起算时刻 0.55 = processor0 最新时刻"
else
  echo "    ✗ GATE-RESTART 没报出起算时刻 0.55（$(grep -E 'GATE-RESTART' "$COUT" || echo '没有 GATE-RESTART 行')）"
  FAILED=1
fi

# ④ 续算不能覆盖新鲜那一轮的日志（那 160 MB 是"新鲜分支真跑过"的唯一原始证据）
if [ -f "$WORK/case-fresh/log.interFoam.fresh" ] && [ -f "$WORK/case-fresh/log.interFoam.restart" ]; then
  echo "    ✓ 两轮日志并存：log.interFoam.fresh 与 log.interFoam.restart 没有被互相覆盖"
else
  echo "    ✗ 日志名没有按分支区分（fresh=$([ -f "$WORK/case-fresh/log.interFoam.fresh" ] && echo 有 || echo 无)"
  echo "      restart=$([ -f "$WORK/case-fresh/log.interFoam.restart" ] && echo 有 || echo 无)）"
  FAILED=1
fi

# ⑤ 重构出的末时刻目录也要是新一轮的 0.60
if [ -d "$WORK/case-fresh/0.60" ]; then
  echo "    ✓ reconstructPar 写出了新一轮的 0.60/"
else
  echo "    ✗ 算例根没有 0.60/（重构没跟上新的 endTime）"
  FAILED=1
fi

# ── 场景 D：GATE-RESTART 的负对照 ──────────────────────────────────────────
# 判据写对了还不够，得证明它还**咬得住**。D 用的 stub 故意忽略 processor0 的断点、
# 永远从 0 开始跑——这正是 `startFrom latestTime` 没生效时求解器的样子：安静地从 0
# 重算一遍，末时刻照样走到 endTime，产物看起来完全正常。
# 期望：FRESH=0、没有 `--- blockMesh`，但**必须**红在 GATE-RESTART（rc=37）。
run_case "D-noresume" "case-fresh" "$WORK/stubs-noresume" 37 'GATE-RESTART FAIL: 启动横幅 Create mesh for time = 0' '' 'run-restart.sh' || FAILED=1

# ── 场景 E：兜底判据的负对照 ────────────────────────────────────────────────
# 主判据认的是启动横幅；换了求解器/版本而横幅变了时，兜底判据（首个 Time 数值比较）
# 必须顶上来，而且**同样咬得住**"从 0 重算"。E 的 stub 不打横幅、也从 0 起算。
run_case "E-nobanner" "case-fresh" "$WORK/stubs-nobanner" 37 'GATE-RESTART FAIL: 日志里既没有 Create mesh 横幅' '' 'run-restart.sh' || FAILED=1

echo
if [ "$FAILED" = 0 ]; then
  echo "REHEARSE-OK  五个场景都符合预期（产物在 $WORK/）"
else
  echo "REHEARSE-FAIL  见上面带 ✗ 的行"
fi
exit "$FAILED"
