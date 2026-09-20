# nefx-scnet-sdk

曙光超算（国家超算互联网 SCNet）OpenAPI 2.0 客户端。把**已经跑通**的那条链路固化成一个可复用的小工具：

```
本地算例  →  分片上传  →  按 JSON 模板提交作业  →  轮询 / 取回结果
  ├─ Fluent：  .cas.h5 + journal
  └─ OpenFOAM：整个 case 目录（或 case.tar.gz），远端块网格→设场→分块→求解→重构
```

零运行时依赖。Node ≥ 23.6 直接跑 TypeScript（类型剥离），**没有构建步骤**。

覆盖范围：**只包含已在真实作业里跑通过的接口**。没实测过的能力不写进代码——模板 schema 里用
`evidence: untested` 标出来（`exclusive` / `ppn` / `gpus` / `dcus` 四个字段即是）。

> 几个**线格式**标识符以 `scnet-client/` 开头，它们是跨仓库契约、有测试钉着，不随包名变：
> `scnet-client/ops@1`、`scnet-client/watch@2`、`scnet-client/run-record@1`、
> `https://local/scnet-client/job.schema.json`。

## 凭据

一个 JSON 文件：

```json
// ~/.nefx/scnet/secret.json
{ "user": "…", "access_key": "…", "secret_key": "…" }
```

来源优先级（前一条齐全就不看后面的）：

1. 环境变量 `SCNET_USER` / `SCNET_ACCESS_KEY` / `SCNET_SECRET_KEY`——**三个齐全才生效**
2. `SCNET_SECRET_PATH` 指定的文件
3. `~/.nefx/scnet/secret.json`

凭据的值**永不经过 stdout**（实现见 `src/redact.ts`）。

## 快速上手

```bash
# 1) 先跑只读冒烟：认证 / 端点 / 文件 / 队列 / 作业列表 五条链路
npm run smoke

# 2) 看模板长什么样，照着改
node src/cli.ts init --out my-job.json
node src/cli.ts check my-job.json            # 离线校验（缺本地文件会报错）
node src/cli.ts preview my-job.json          # 离线打印将发出的提交体
node src/cli.ts run my-job.json --wait --download
```

## 命令一览

| 命令 | 联网 | 说明 |
| --- | --- | --- |
| `auth` | 是 | 认证，列出可用区域（token 已脱敏） |
| `probe` | 是 | 端点 / 调度器 ID / 队列 / 配额 / 已用机时 |
| `smoke` | 是，只读 | 五条链路冒烟。**不上传、不提交** |
| `ls [路径]` | 是 | 列远端目录（**列全**，不截断） |
| `quota [--user <名>]` | 是 | 共享存储配额与已用量（GB），一条记录一个挂载路径 |
| `jobs` `job <id>` | 是 | 作业列表 / 作业详情（读调度器 `JobState`） |
| `readfile --path <p>` | 是 | 读远端文本文件 |
| `put` / `get` / `mkdir` | 是 | 单文件上传 / 下载 / 建目录 |
| `init` / `schema` | 否 | 生成起步模板 / JSON Schema |
| `check <模板>` | 否 | 静态校验（`--lenient` 把"本地文件不存在"降成警告） |
| `preview <模板>` | 否（`--online` 才联网） | 打印上传清单、`GAP_WORK_DIR`、远端命令、提交体 |
| `run <模板>` | 是 | 建目录 → 上传 → 提交 →（`--wait`）→（`--download`）→ 落 `runs/` 记录 |
| `kill <id...>` | 是 | 取消作业，并**回查** `JobState` 确认 |
| `serve` | 是 | 本机 HTTP **只读**接口（默认 `127.0.0.1:8787`） |
| `mcp` | 是 | MCP **stdio** 服务端，给别的 agent / MCP 客户端调 |

`init` 只给 Fluent 起步模板。OpenFOAM 的起步模板在核心层（`get_job_template?kind=openfoam`），
所以 `init` 拿不到——CLI 里 `check` / `preview` 吃任意来源的模板（含 openfoam），
而取模板的 `get_job_template` 与渲染 shell 的 `render_job_command` 只在 HTTP / MCP 两个界面暴露。
两条腿都是**离线、不读凭据**的，从哪个界面拿都一样；
真提交只走 CLI 的 `run`——写操作不进那两个只读界面。

## 三个界面，一份判据

`serve` 和 `mcp` 暴露的是**同一批只读操作**，定义在 `src/core.ts` 的 `OPERATIONS` 表里。
CLI 是第三个壳。加一个界面不用改核心层，核心层加一个操作三个界面都能用。

### HTTP

```bash
npm run serve                                   # 起本机 HTTP
curl 'http://127.0.0.1:8787/ops'                # 操作清单
curl 'http://127.0.0.1:8787/op/list_jobs?limit=5'
curl 'http://127.0.0.1:8787/op/watch?id=67307512&steps=10000'
curl 'http://127.0.0.1:8787/op/watch?id=67307512&format=text'   # 人读短句
curl 'http://127.0.0.1:8787/op/get_job_template?kind=openfoam'  # 离线：取 OpenFOAM 起步模板 + 七道门
```

### MCP

DSH 的 `dsh-mcp-client` 配置片段：

```yaml
- id: mcp-scnet
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: scnet
    transport: stdio
    command: node
    args: ['<仓库根>/src/mcp.ts']
    cwd: '<仓库根>'
```

工具会以 `mcp__scnet__<name>` 出现，目前 11 个。**注意 token 成本**：工具描述每次请求都进提示词，
所以描述都压得很短。加工具等于给自己加税。

### 两条硬约束

1. **HTTP 只绑回环地址**，没有 `--allow-remote` 这种开关——进程内存里有一份有效的平台 token。
2. **两个界面都是只读的**，不含上传 / 提交 / 取消。写操作不可逆（取消一个算了几天的作业），
   不由一个没有认证的本机端口提供。

## watch 的返回形状

`watch` 认两类作业（看返回里的 `kind`）：Fluent 读 `.trn` / stdout 的
`Flow time = .., time step = ..`，OpenFOAM 读算例目录里 `log.<solver>.<fresh|restart>` 的
`Time = `、ETA 靶子取 `system/controlDict` 的 `endTime`。
`rate` / `eta` 因此是**判别联合**：Fluent 给「秒/步」，OpenFOAM 给「秒/单位物理时间」——
后者按物理时间推进，没有步号，`--steps` 对它无效。

## 模板

字段表在 `src/jobtemplate.ts` 的 `SPEC`，是**唯一事实来源**——校验、默认值、JSON Schema 全从它派生。
完整字段见 `templates/job.schema.json`（每个字段的 description 里带 `[evidence: verified|untested]`）。

```jsonc
{
  "name": "tps-steady-001",
  "queue": "xahcnormal",          // 西安集群实测可用；换集群先跑 `probe`
  "resources": { "nodes": 1, "cores": 8, "walltime": "02:00:00" },
  "inputs": [
    { "local": "case/1.cas.h5", "remoteDir": "~/runs/001" },
    { "local": "examples/solve.jou", "remoteDir": "~/runs/001" }
  ],
  "fluent": { "cores": 8, "journal": "solve.jou" },
  "outputs": [{ "remote": "1_out.dat.h5", "local": "results/1_out.dat.h5" }]
}
```

三个约定值得单独记住：

1. **远端路径用 `~` 开头**。`~/runs/001` 在认证后展开成真实家目录。写死 `/public/home/<用户名>`
   会被校验直接拦下来——尖括号进了远端 shell 就是重定向。
2. **`workDir` 默认等于第一个 `inputs[].remoteDir`**，也就是作业的 cwd 就是算例所在目录。
   两者不一致是"作业正常跑完但 Fluent 找不到 cas 文件"的头号原因。
3. **`outputs[].remote` 写相对路径**（相对 `workDir`），绝对路径原样用，`%j` 换成作业号。

### OpenFOAM 模板

命令来源是**四选一**（`fluent` / `openfoam` / `commandFile` / `command`），给两个就报错。
`openfoam` 那一组标了 `omitWhenAbsent`——**补默认值不许顶掉用户显式给的命令来源**。

```jsonc
{
  "name": "of-run-001",
  "queue": "xahcnormal",
  "resources": { "nodes": 1, "cores": 16, "walltime": "03:00:00" },
  "workDir": "~/runs/of-001",
  "inputs": [{ "local": "case/s1b-refined-v2212.tar.gz", "remoteDir": "~/runs/of-001" }],
  "openfoam": {
    "openfoamRoot": "/public/software/apps/OpenFOAM/v2212/hpcx-gcc-7.3.1/OpenFOAM-v2212",
    "moduleName": "OpenFOAM/v2212-hpcx-gcc-7.3.1",
    "solver": "interFoam",
    "cores": 16,                   // 与 resources.cores 不一致会告警
    "unpack": "s1b-refined-v2212.tar.gz",  // 算例以归档上到 workDir 时给归档名；先解包再判 GATE-UNPACK
    "expectCells": 31200,          // 给了才判 GATE-MESH；不给只打印实测值
    "endTime": "0.55",             // 给了才判末时刻；不给只判 FOAM FATAL 计数与 rc
    "reconstruct": true,           // reconstructPar -latestTime
    "reconstructAll": false        // true 则不给 -latestTime（重构全部时刻，慢）
  }
}
```

`prepare: true`（默认）才会在检测不到已有网格时跑 `blockMesh → checkMesh → setFields → decomposePar`；
检测到 `processor0/` 就自动走**续算分支**，跳过这四步——它们会覆盖已有结果。
续算判据**只看 `processor0/`**：光有 `constant/polyMesh/` 不算（那说明 `blockMesh` 跑过、但
`decomposePar` 没跑）。新鲜分支会先 `rm -rf 0 constant/polyMesh processor*` 清掉上一轮的残留，
只清"本该被重造"的，**归档与上传的输入一个不动**。
`launcherCandidates` 默认三个候选，`env` / `preCommands` / `extraSolveArgs` / `postCommands`
是四个逃生口（按顺序：环境 → 预命令 → 求解 → 后命令）。

**算例怎么上去**：两条路，选一条，别混。

| 你的 `inputs[].local` | 要不要 `unpack` |
| --- | --- |
| 一个归档（`*.tar.gz` / `*.tgz` / `*.tar` / `*.zip`） | **要给**，值就是归档名（相对 `workDir`，通常与 `inputs[].local` 的文件名一致）。渲染器先解包，再判 `GATE-UNPACK` |
| 算例的文件/目录本身（多个 `inputs[]`） | 不要给。渲染器直接判 `GATE-UNPACK` |

**为什么解包与校验必须绑在一起**：`tar -czf out.tar.gz -C <parent> <case>` 打包会把条目写成
`<case>/system/controlDict`，解包后算例落在**子目录**里而不在 `workDir`。`tar` 的 `rc` 是 0，
看起来完全正常——只有"解包之后回头验一次 `system/controlDict` 与 `0.orig/` 在不在"能抓住它。
所以这两半在渲染器里是一件事：给了 `unpack` 就一定跟着一次 GATE-UNPACK。

起步模板别手抄：`curl 'http://127.0.0.1:8787/op/get_job_template?kind=openfoam'`
（或 MCP 的 `get_job_template`），返回的 JSON 里 `template` 直接能改，
`gates` 是下面那张表的机器可读版。

### 七道门

渲染出的远端 shell 不只跑求解器，它在每个环节**自己判对错**，失败时打 `GATE-XXX FAIL`
并带一个专属退出码（20–36）。判据清单在 `src/openfoam.ts` 的 `OPENFOAM_GATES`，
与 `render_job_command` 的返回一起给出去。

| 门 | 判什么 | 为什么不能省 |
| --- | --- | --- |
| `GATE-ENV` | `interFoam -help` 真跑一次，rc 必须为 0 | `command -v` 只证明 PATH 里有它。`module load` 只挂了一半 `LD_LIBRARY_PATH`，缺 `lib/sys-openmpi` 时是 rc=127 + `libPstream.so` 找不到 |
| `GATE-UNPACK` | 给了 `unpack` 就先解包；然后 `system/controlDict` 与 `0.orig/` 都在 | 打包多一层 `<case>/` 前缀时，后面四道门会**一起**变红，而原因看不出来。**只解包不校验等于没做** |
| `GATE-MESH` | 打印 `checkMesh` 的 cells；给了 `expectCells` 才判 | 单元数是"网格生成走对了没有"的唯一硬数字 |
| `GATE-SETFIELDS` | 从 `system/setFieldsDict` 读出场清单，逐个判 `0/<field>` 与 `0.orig/<field>` **不同**（`cmp -s`）；另加一条"`0/` 里没有场变小" | `setFields` 失败时返回码仍可能是 0，而 `0/` 里留着模板文件。**判据必须从字典里读，不能写死场名** |
| `GATE-DECOMPOSE` | `processor*` 目录数 == `decomposeParDict` 的 `numberOfSubdomains` | 只传 `-subdomains` 改不了分区数；两者不一致时 `decomposePar` 会"成功"但分区数是错的 |
| `GATE-LAUNCHER` | 逐个试 `mpirun` 候选，`hostname` 行数 == np 才算通过 | `--bind-to core` 在不同节点命运不同，**必须现场选，不能照抄别的节点** |
| `GATE-SOLVER` | `FOAM FATAL\|sigFpe\|floating point exception` 计数 == 0 且 rc == 0（给了 `endTime` 再判末时刻） | 求解器遇到 alpha 越界 / FPE 可能打印 `FOAM FATAL` 后自行退出，而脚本层 rc 未必红 |

还有一条不在表里但同样硬：**末时刻必须在算例根目录**。并行算例的时刻写在 `processorN/` 里，
所以"根目录只有 `0/` 和 `0.orig/`"意味着 `reconstructPar` 没做或没做对，
而不是"算例没算"——这一步失败退出 36。

## 作为库用

```ts
import { ScnetClient } from './src/client.ts';

const c = new ScnetClient({ region: '0' });
const report = await c.run(template, { wait: true, download: true });
console.log(report.jobId, report.wait?.state);
```

`run()` 会在 `runs/<时间戳>-<作业名>/run.json` 落一份记录：模板 sha256、渲染出的命令、
上传清单（含每个文件的 sha256）、作业号、终态、取回清单。要回答"这个结果是怎么来的"不用靠记忆。

## 环境变量

只有四个，全都有默认值，不设也能跑：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `SCNET_USER` / `SCNET_ACCESS_KEY` / `SCNET_SECRET_KEY` | 无 | 凭据。**三个齐全才生效**，否则按上面「凭据」一节的顺序找文件 |
| `SCNET_SECRET_PATH` | 无 | 显式指定凭据文件路径（比默认位置优先） |
| `SCNET_STATE_DIR` | 凭据所在目录 | 可写状态目录：token 缓存 + `watch` 的进度基准点 |

`SCNET_STATE_DIR` 存在的唯一理由是**只读挂载**：容器里凭据目录挂成 `:ro`（凭据不该能被容器改写），
而上面两样都要写盘。不设它就会看到 `EROFS: read-only file system`。
一条设计纪律：写状态目录失败**不该让接口调用失败**（缓存只是加速手段），
所以两处写入都是 best-effort + stderr 各吼一次，`watch` 报告里的 `sample.persisted` 反映**实际**是否写成功。

## 容器

```bash
docker network create scnet-net
docker volume create scnet-state
docker run -d --name scnet-api --restart unless-stopped \
  --network scnet-net \
  -p 127.0.0.1:8787:8787 \
  -v scnet-state:/var/lib/scnet \
  -v "%USERPROFILE%\.nefx\scnet:/root/.nefx/scnet:ro" \
  -v "<你的算例目录>:/cases:ro" \
  nefx-scnet-sdk:0.1
```

容器买到的是**常驻**（`--restart unless-stopped` 就是现成的服务管家）和**整箱搬走**，
不是依赖隔离——这个项目零依赖，没什么可隔离的。两条必须守住的：

1. **`-p` 必须绑宿主回环**。容器内绑 `0.0.0.0` 是发布机制的要求（Docker 代理的是容器 IP，
   不是容器 loopback），安全性全在发布侧这一行。
2. **凭据只读挂载，绝不 `COPY` 进镜像**，也绝不用 `-e SCNET_ACCESS_KEY=...`——
   前者会留在可 `docker save` 导出的层里，后者会写进 `docker inspect`。

`mcp` 那条腿建议**不要**放进容器：`docker exec -i` 比直接 `node src/mcp.ts` 多一层，
且会把 Docker Desktop 变成 MCP 的硬依赖。容器只跑 `serve`。

## 目录

```
src/           auth / api / upload / jobtemplate / openfoam / jobs / client / cli / redact
src/openfoam.ts OpenFOAM 远端 shell 渲染器：七道门的判据清单 + 环境装配 + 续算分支
src/core.ts    核心层：一组只读操作，CLI / HTTP / MCP 三个界面共用这一份判据
src/serve.ts   本机 HTTP 只读接口（只绑回环）
src/mcp.ts     MCP stdio 服务端（零依赖手写 JSON-RPC）
templates/     job.schema.json（生成物）、fluent-batch.job.json、openfoam-interfoam.job.json
examples/      solve.jou（一个可直接用的 Fluent 批处理 journal）
tools/         rehearse-openfoam.sh：用 stub 顶替求解器，把渲染结果在本地真跑一遍
test/          离线测试，不联网、不需要凭据
Dockerfile     只把 serve 装进去；运行配方写在文件头注释里
```

## 开发

```bash
npm test            # 离线测试
npm run lint:parse  # 逐文件语法检查（node --check，等价于"类型剥离后能解析"）
npm run schema      # 改了 SPEC 之后重新生成 JSON Schema
npm run smoke       # 五条只读链路冒烟（要凭据、要联网）
```

想拿到完整类型检查，需要自己装 TypeScript（本项目刻意不引入任何依赖）：

```bash
npm i -D typescript && npx tsc --noEmit
```

`tools/rehearse-openfoam.sh` 用一组 stub 顶替 `blockMesh` / `checkMesh` / `setFields` /
`decomposePar` / `interFoam` / `reconstructPar` / `mpirun` / `module`，把**渲染器原样产出的 shell
逐行真跑**，五个场景：新鲜全绿、`setFields` 空转（负对照，必须红在 `GATE-SETFIELDS`）、续算全绿、
续算但求解器从 0 重算（负对照，必须红在 `GATE-RESTART`）、不打启动横幅且从 0 重算
（负对照，考 `GATE-RESTART` 的兜底判据）。它证明不了"簇上能算"，但能证明
"这段 shell 在算例结构正确时全绿、结构错误时红在对的地方"——**改了任何一道判据都该跑它**。

在 Windows 上要跑它，用 Git Bash 的绝对路径（PATH 上的 `bash` 通常是 WSL 那个，没有 `cygpath`，
会以 `REHEARSE-ABORT: 需要 cygpath` 退出 2；这个 abort 是刻意的，脚本宁可拒绝跑也不猜路径）：

```bash
& "C:\Program Files\Git\bin\bash.exe" tools/rehearse-openfoam.sh
```

## 许可

MIT，见 `LICENSE`。这个包只覆盖**已在真实作业里跑通过的接口**，没实测过的能力宁可标
`evidence: untested` 也不写进代码——它能省掉你的试错，但省不掉你自己的验证。
