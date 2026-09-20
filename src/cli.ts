#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   node src/cli.ts <命令> [参数]
 *
 * 命令一览：
 *   只读 / 诊断
 *     auth                       认证，列出可用区域（token 脱敏）
 *     probe                      端点、集群调度器、队列、配额
 *     smoke                      一次只读冒烟：auth + 端点 + 队列 + 作业列表（不提交不上传）
 *     ls [远端路径]               列目录（列全，不截断）
 *     quota [--user <名>]        共享存储配额与已用量（GB）
 *     jobs                       实时作业列表
 *     job <id>                   作业详情（含调度器 JobState）
 *     readfile --path <p>        读远端文本文件一页
 *   文件
 *     put --file <本地> --dir <远端目录>
 *     get --path <远端> --out <本地>
 *   作业模板
 *     init [--out <文件>]         生成起步模板
 *     schema [--out <文件>]       输出 JSON Schema
 *     check <模板> [--lenient]    只校验，不联网
 *     preview <模板> [--online]   校验 + 打印将发出的 body 与命令行（默认不联网）
 *     run <模板> [--wait] [--download] [--no-upload]
 *   作业控制
 *     watch <id> [--steps N]          健康 / 进度 / ETA
 *     kill <id...>
 *   界面（同一批只读操作，见 core.ts）
 *     serve [--port 8787] [--host 127.0.0.1]   本机 HTTP（只读）
 *     mcp                                      MCP stdio 服务端（只读）
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { authenticate, pickRegion, usableRegions } from './auth.ts';
import { downloadFile, fetchQuota, listDirComplete, makeDir, readRemoteText, resolveEndpoints, unavailableReason } from './api.ts';
import { watchJob, formatWatch } from './watch.ts';
import { uploadFile } from './upload.ts';
import { ScnetClient } from './client.ts';
import { OPERATIONS } from './core.ts';
import { expandHome, jsonSchema, renderCommand, starterTemplate, validateTemplate } from './jobtemplate.ts';
import { listQueueNames } from './jobs.ts';
import { getJson } from './auth.ts';
import { DEFAULT_PORT, startServer } from './serve.ts';
import { serveStdio } from './mcp.ts';
import { ScnetError, die, redact, show } from './redact.ts';

// ── 极简参数解析：--key value / --flag / 位置参数 ───────────────────────────
interface Args {
  flags: Record<string, string | boolean>;
  pos: string[];
}
function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) flags[k] = true;
      else {
        flags[k] = nxt;
        i++;
      }
    } else pos.push(a);
  }
  return { flags, pos };
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
const num = (v: string | boolean | undefined, d: number): number => {
  const s = str(v);
  return s === undefined ? d : Number(s);
};

function loadTemplate(path: string): unknown {
  if (!existsSync(path)) die(`模板文件不存在：${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (e) {
    die(`模板不是合法 JSON：${(e as Error).message}`);
  }
}

/**
 * 打印一个"只读探测"端点的结果，但要**先把"拿没拿到"和"拿到了什么"分开**。
 *
 * 起因（2026-09-14 实测）：`userlimits` / `userusedtime` / `userquota` 三个端点在本账号上
 * 整片 404，而 `getJson()` 会把 404 的正文原样返回。原来的 `show(label, body)` 于是把
 * `{"code":"404",...}` 当数据打出来——读的人（尤其是不看 HTTP 状态码的 agent）会以为
 * 那几个接口是有内容的。这类"看着像成功"的输出是这个项目里最贵的一类坑。
 * 判据本身是纯函数 `unavailableReason()`，有单测；这里只负责排版。
 */
function showEndpoint(label: string, body: Record<string, unknown>): void {
  const why = unavailableReason(body);
  if (why) {
    console.log(`\n=== ${label} ===\n  ✗ 本账号不可用（${why}）——没有内容可看，不是空数据`);
    return;
  }
  show(label, body);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const { flags, pos } = parseArgs(argv.slice(1));

async function main(): Promise<void> {
  const client = new ScnetClient({ region: str(flags.region) });

  switch (cmd) {
    case 'auth': {
      const data = await authenticate(true);
      show('认证成功 — 凭据有效（token 已脱敏）', data);
      console.log(`\n字段：${data[0] ? Object.keys(data[0]).join(', ') : '(无)'}`);
      console.log('\n提示：clusterId=0 是平台自身 token（ac），不能用来跑作业或传文件。');
      return;
    }

    case 'probe': {
      const data = await authenticate();
      const list = usableRegions(data);
      console.log(`可用区域数：${list.length}`);
      for (let i = 0; i < list.length; i++) {
        const reg = list[i]!;
        console.log(`\n############ 区域[${i}] ${reg.clusterName} (clusterId=${reg.clusterId}) ############`);
        if (String(reg.clusterId) === '0') {
          console.log('  → 平台自身 token（ac），跳过作业/文件接口');
          continue;
        }
        const ep = await resolveEndpoints(reg);
        const T = { token: reg.token };
        show('端点', { HPC: ep.HPC, EFILE: ep.EFILE, ESH: ep.ESH, home: ep.home, userName: ep.userName });
        const q = await getJson(
          `${ep.HPC}/openapi/v2/queuenames/users/${ep.userName}?strJobManagerID=${ep.jobManagerId}`,
          T,
        );
        show('可访问队列', q);
        for (const [label, p] of [
          ['用户资源限制', `/openapi/v2/userlimits/users/${ep.userName}`],
          ['已用机时', `/openapi/v2/userusedtime/users/${ep.userName}`],
          ['存储配额', `/openapi/v2/userquota/users/${ep.userName}`],
        ]) {
          // 这三个接口在实测账号上整片 404。原来把 404 的正文
          // 当数据打印出来，读的人（尤其是 agent）会以为拿到了内容。
          // 现在按 HTTP 状态 / 平台 code / data 三选一判"拿没拿到"，拿不到就只说拿不到。
          showEndpoint(label, await getJson(`${ep.HPC}${p}`, T));
        }
      }
      return;
    }

    case 'smoke': {
      // 只读，不提交不上传。用来验证"搬迁后的客户端没走样"。
      const data = await authenticate(true);
      const list = usableRegions(data);
      console.log(`\n[1/5] 认证 OK，可用区域 ${list.length} 个`);
      const ep = await client.endpoints();
      console.log(`[2/5] 端点 OK  HPC=${ep.HPC}`);
      console.log(`      EFILE=${ep.EFILE}`);
      console.log(`      home=${ep.home}  user=${ep.userName}  jobManagerId=${ep.jobManagerId}`);
      const { dirs, files } = await client.list();
      console.log(`[3/5] 文件接口 OK  家目录 ${dirs.length} 个目录 / ${files.length} 个文件`);
      const q = await getJson(
        `${ep.HPC}/openapi/v2/queuenames/users/${ep.userName}?strJobManagerID=${ep.jobManagerId}`,
        { token: ep.region.token },
      );
      const qnames = JSON.stringify(redact(q)).match(/"queueName":"([^"]+)"/g) ?? [];
      console.log(`[4/5] 队列接口 OK  解析到 ${qnames.length} 个队列名`);
      const js = await client.jobs({ limit: 5 });
      console.log(`[5/5] 作业列表 OK  total=${js.total ?? '?'}  返回 ${js.list.length} 条`);
      for (const j of js.list) {
        console.log(`      ${j.jobId} ${j.jobStatus} ${j.jobName}`);
      }
      console.log('\n冒烟通过：认证 / 端点 / 文件 / 队列 / 作业列表 五条链路都通。');
      console.log('注意：本次**没有**上传文件、没有提交作业。');
      return;
    }

    case 'ls': {
      const ep = await client.endpoints();
      const p = pos[0] === undefined ? ep.home : expandHome(pos[0], ep.home);
      const r = await listDirComplete(ep, p);
      if (!r.exists) die(`远端目录不存在：${p}（平台 code=${r.code} ${r.msg}）`);
      // 目录名取自 children（**不受 limit 截断影响**，恒为该目录的全部子目录）；
      // 文件取自 fileList 里 isDirectory !== true 的那些 —— fileList 本身也含目录，
      // 以前两处都打一遍，于是每个目录在 ls 里出现两次。
      const fileEntries = r.entries.filter((e) => e.isDirectory !== true);
      console.log(`\n=== ${p} ===`);
      for (const d of r.dirs) console.log(`  [DIR] ${d}`);
      for (const f of fileEntries) {
        const link = f.isSymbolicLink === true ? ' ->' : '';
        console.log(`  ${f.name}${link}  ${f.size} B  ${f.permission ?? ''}  ${f.owner ?? ''}  ${f.lastModifiedTime ?? ''}`);
      }
      if (!r.dirs.length && !fileEntries.length) console.log('  (空目录)');
      // 平台自报 total，我们这页可能没列全（历史上不带 limit 时恒回 10 条）。
      // 不把这件事说出来，调用方会把"没列出来"误读成"不存在"。
      console.log(`  —— 共 ${r.total} 项，列出 ${r.dirs.length} 个目录 + ${fileEntries.length} 个文件`
        + `${r.truncated ? '（**没列全**）' : ''}`
        + (r.calls > 1 ? `，limit 加到 ${r.limitUsed} 才问全` : ''));
      return;
    }

    case 'quota': {
      const ep = await client.endpoints();
      const r = await fetchQuota(ep, str(flags.user));
      if (!r.ok) die(`配额接口不可用：${r.reason ?? `code=${r.code} ${r.msg}`}`);
      if (!r.entries.length) {
        console.log('平台返回了成功但没有配额记录（该账号可能没有独立配额）。');
        return;
      }
      console.log(`\n=== 共享存储配额（${str(flags.user) ?? ep.userName}，单位 GB）===`);
      for (const e of r.entries) {
        const pct = e.percentUsed === null ? '?' : e.percentUsed.toFixed(1) + '%';
        const bar = e.percentUsed === null ? '' : ' ' + '#'.repeat(Math.min(20, Math.round(e.percentUsed / 5))) +
          (e.percentUsed > 100 ? ' ⚠ 已超额' : '');
        console.log(`  ${e.path}`);
        console.log(`    已用 ${e.usageGB ?? '?'} / 配额 ${e.thresholdGB ?? '?'} GB  （${pct}）`
          + `  剩余 ${e.freeGB === null ? '?' : e.freeGB.toFixed(1)} GB${bar}`);
      }
      return;
    }

    case 'put': {
      const file = str(flags.file);
      const dirArg = str(flags.dir);
      if (!file || !dirArg) die('用法：put --file <本地路径> --dir <远端目录> [--chunk 8] [--cover cover]');
      if (!existsSync(file)) die(`本地文件不存在：${file}`);
      const ep = await client.endpoints();
      const dir = expandHome(dirArg, ep.home);
      const name = basename(file);
      const size = statSync(file).size;
      console.log(`上传 ${name}  ${(size / 1048576).toFixed(1)} MiB -> ${dir}`);
      await client.ensureRemoteDir(dir);
      const r = await uploadFile(ep, {
        file,
        remoteDir: dir,
        chunkSize: num(flags.chunk, 8) * 1048576,
        cover: str(flags.cover) === 'uncover' ? 'uncover' : 'cover',
        onProgress: (p) =>
          console.log(
            `  [${p.chunk}/${p.totalChunks}] ${(((100 * p.sentBytes) / p.totalBytes) || 0).toFixed(1)}%  `
              + `${(p.bytesPerSec / 1048576).toFixed(2)} MiB/s`,
          ),
      });
      console.log(`完成 ${r.remotePath}  ${r.bytes} B / ${r.chunks} 片 / ${(r.elapsedMs / 1000).toFixed(1)}s`);
      return;
    }

    case 'get': {
      const remoteArg = str(flags.path);
      const out = str(flags.out);
      if (!remoteArg || !out) die('用法：get --path <远端文件> --out <本地路径>');
      const ep = await client.endpoints();
      const remote = expandHome(remoteArg, ep.home);
      mkdirSync(dirname(out), { recursive: true });
      const r = await downloadFile(ep, remote, out, (got, total) => {
        if (total) console.log(`  ${((100 * got) / total).toFixed(1)}%`);
      });
      console.log(`完成 ${out}  ${r.bytes} B（服务端声明 ${r.total} B）`);
      return;
    }

    case 'init': {
      const out = str(flags.out) ?? 'job.json';
      writeFileSync(out, JSON.stringify(starterTemplate(), null, 2) + '\n');
      console.log(`已写出起步模板：${out}`);
      console.log('下一步：把 inputs[].local 改成你自己的算例路径，然后');
      console.log(`  node src/cli.ts check ${out}`);
      return;
    }

    case 'schema': {
      const out = str(flags.out);
      const s = JSON.stringify(jsonSchema(), null, 2) + '\n';
      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, s);
        console.log(`已写出 JSON Schema：${out}`);
      } else {
        console.log(s);
      }
      return;
    }

    case 'check': {
      const p = pos[0];
      if (!p) die('用法：check <模板.json> [--lenient] [--online]');
      const lenient = flags.lenient === true;
      const online = flags.online === true;
      // 队列名只有联网才判得了。凭据没配好也不该让离线校验整个失败，所以这里容错。
      let knownQueues: string[] | undefined;
      if (online) {
        try {
          knownQueues = await listQueueNames(await client.endpoints());
        } catch (e) {
          console.log(`  ! 拿不到队列列表（${(e as Error).message}），跳过队列名校验`);
        }
      }
      const { template, errors, warnings } = validateTemplate(loadTemplate(p), {
        checkFiles: lenient ? 'warn' : true,
        fileExists: (f) => existsSync(f),
        // 相对路径按模板所在目录解析——模板和它引用的算例通常放在一起
        baseDir: dirname(p),
        knownQueues,
      });
      for (const w of warnings) console.log('  ! ' + w);
      for (const e of errors) console.log('  ✗ ' + e);
      if (errors.length) {
        console.log(`\n校验失败：${errors.length} 个错误；${warnings.length} 个警告`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n校验通过（${warnings.length} 个警告）`);
      console.log(`作业名 ${template.name}  queue=${template.queue}  cores=${template.resources.cores}  `
        + `walltime=${template.resources.walltime}  inputs=${template.inputs.length}`);
      console.log(`workDir = ${template.workDir || '(未指定：取第一个上传目录；都没有才用家目录)'}`);
      if (knownQueues?.length) console.log(`队列已核对（本集群可用：${knownQueues.join(' / ')}）`);
      console.log('\n远端将执行：\n' + renderCommand(template));
      return;
    }

    case 'preview': {
      const p = pos[0];
      if (!p) die('用法：preview <模板.json> [--online] [--lenient]');
      const lenient = flags.lenient === true;
      const online = flags.online === true;
      const { template, errors, warnings } = validateTemplate(loadTemplate(p), {
        checkFiles: lenient ? 'warn' : true,
        fileExists: (f) => existsSync(f),
        baseDir: dirname(p),
      });
      for (const w of warnings) console.log('  ! ' + w);
      for (const e of errors) console.log('  ✗ ' + e);
      if (errors.length) {
        console.log(`\n校验失败：${errors.length} 个错误（--lenient 可以把"本地文件不存在"降成警告）`);
        process.exitCode = 1;
        return;
      }
      // 只有加了 --online 才会认证；默认这条路完全不联网。
      const pv = client.preview(template, online ? await client.endpoints() : undefined);
      const home = online ? (await client.endpoints()).home : '$HOME';

      console.log('\n=== 上传 ===');
      for (const i of template.inputs) {
        // --lenient 下本地文件可能真的不存在，不能让它把整个 preview 打断
        let human = '大小未知';
        try {
          const b = statSync(i.local).size;
          human = b >= 1048576 ? `${(b / 1048576).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`;
        } catch {
          human = '本地文件不存在';
        }
        console.log(`  ${i.local}  ->  ${expandHome(i.remoteDir, home)}/${basename(i.local)}`
          + `   ${human}   片=${i.chunkMiB} MiB`);
      }
      console.log(`\n=== 作业工作目录（GAP_WORK_DIR）===\n  ${pv.workDir}`);
      console.log('\n=== 远端将执行的命令（GAP_CMD_FILE）===\n' + pv.command);
      if (pv.outputs.length) {
        console.log('\n=== 结束后取回 ===');
        for (const o of pv.outputs) console.log(`  ${o.remote}  ->  ${o.local}`);
      }
      console.log('\n=== 提交体（脱敏后）===\n' + JSON.stringify(redact(pv.body), null, 2));
      console.log(online
        ? '\n（--online：以上用了真实家目录与调度器 ID）'
        : '\n本次没有联网。加 --online 可以用真实家目录 / 调度器 ID 再算一遍。');
      return;
    }

    case 'submit':
    case 'run': {
      const p = pos[0];
      if (!p) die(`用法：${cmd} <模板.json> [--wait] [--download] [--no-upload] [--interval 15]`);
      const report = await client.run(loadTemplate(p), {
        upload: flags['no-upload'] !== true,
        wait: flags.wait === true,
        download: flags.download === true,
        intervalMs: num(flags.interval, 15) * 1000,
        recordDir: str(flags['record-dir']),
        jobNameSuffix: str(flags.suffix) ?? '',
        baseDir: dirname(p),
      });
      console.log(`\n运行记录：${report.recordPath}`);
      if (report.jobId) console.log(`作业号：${report.jobId}`);
      if (report.wait) console.log(`终态：${report.wait.state}`);
      return;
    }

    case 'jobs': {
      const js = await client.jobs({
        limit: num(flags.limit, 25),
        name: str(flags.name),
        stat: str(flags.stat),
        queue: str(flags.queue),
      });
      console.log(`\n=== 实时作业列表  total=${js.total ?? '?'} ===`);
      for (const j of js.list) {
        console.log(
          `  ${String(j.jobId).padEnd(10)} ${String(j.jobStatus).padEnd(7)} ${String(j.jobName).padEnd(24)} `
            + `q=${String(j.queue).padEnd(12)} node=${String(j.nodeUsed ?? '-').padEnd(11)} `
            + `${j.procNumUsed}c  ${j.jobRunTime ?? ''}`,
        );
      }
      if (!js.list.length) console.log(JSON.stringify(redact(js.raw), null, 2));
      console.log('\n提醒：作业结束后只在实时列表里保留约 5 分钟（文档口径，未实测）。');
      return;
    }

    case 'job': {
      const id = pos[0];
      if (!id) die('用法：job <jobId>');
      const d = await client.job(id);
      if (!d.found) {
        // 实测：作业不存在时平台返回 code=0 + data=null。不判这个就会把"不存在"
        // 当成"状态还没出来"，在轮询里空转到超时。
        console.log(JSON.stringify(redact(d.raw), null, 2));
        die(`作业 ${id} 不存在（或已从实时列表里清除，实测只保留约 5 分钟）`);
      }
      console.log(`\n=== 作业 ${id} ===`);
      console.log(`jobStatus = ${d.jobStatus ?? '?'}   (statC 分不出完成/取消)`);
      console.log(`JobState  = ${d.jobState ?? '?'}   <- 只有这个能判终态`);
      console.log(`ExitCode  = ${d.exitCode ?? '?'}   (调度器层 jobInitAttr 的值，如 "0:0")`);
      console.log(`RunTime   = ${d.runTime ?? '?'}`);
      // Reason 是失败时最有用的一行：实测 FAILED 时它是 NonZeroExitCode，
      // 而平台自己那层什么也不说。WorkDir 用来核对"作业到底在哪个目录里跑的"。
      console.log(`Reason    = ${d.reason ?? '?'}   <- 失败时先看这个`);
      console.log(`WorkDir   = ${d.workDir ?? '?'}`);
      console.log('\n原始返回（脱敏）：');
      console.log(JSON.stringify(redact(d.raw), null, 2));
      return;
    }

    case 'watch': {
      const id = pos[0];
      if (!id) die(`用法：${cmd} watch <jobId> [--steps N] [--json] [--interval 秒] [--rounds 次数]`);
      const ep = await client.endpoints();
      // --steps：本批从当前步再往前推多少步。给了才算得出 ETA。
      const steps = flags.steps === undefined ? undefined : num(flags.steps, 0);
      const rounds = Math.max(1, num(flags.rounds, 1));
      const intervalMs = Math.max(5, num(flags.interval, 60)) * 1000;
      for (let i = 0; i < rounds; i++) {
        // 注意：速率靠"上一次采样"做差，所以采样点会落盘（<状态目录>/watch/<jobId>.json）。
        // 计划任务每次都是新进程，正是靠这个文件才能算出秒/步。
        const r = await watchJob(ep, String(id), { steps });
        if (flags.json === true) {
          console.log(JSON.stringify(r, null, 2));
        } else {
          if (rounds > 1) console.log(`--- 第 ${i + 1}/${rounds} 次采样 ---`);
          console.log(formatWatch(r));
        }
        if (r.risks.length && flags.strict === true) process.exitCode = 1;
        if (i < rounds - 1) await new Promise((r2) => setTimeout(r2, intervalMs));
      }
      return;
    }

    case 'kill': {
      if (!pos.length) die('用法：kill <jobId> [<jobId>...]');
      const ep = await client.endpoints();
      console.log(`取消作业：${pos.join(', ')}`);
      const r = await client.kill(pos);
      show('取消请求返回', r);
      console.log('\n回查 JobState（返回 code=0 不等于真的取消了）：');
      for (const id of pos) {
        const d = await client.job(id);
        console.log(`  ${id}  jobStatus=${d.jobStatus ?? '?'}  JobState=${d.jobState ?? '?'}  ExitCode=${d.exitCode ?? '?'}`);
      }
      return;
    }

    case 'readfile': {
      const pathArg = str(flags.path);
      if (!pathArg) die('用法：readfile --path <远端绝对路径> [--page 1] [--dir UP|DOWN]');
      const ep = await client.endpoints();
      const path = expandHome(pathArg, ep.home);
      // 平台读不存在的文件会返回空正文 + code=0，看起来跟"空文件"一模一样。
      // 所以先列父目录确认它真的在。
      const slash = path.lastIndexOf('/');
      const { entries, exists } = await listDirComplete(ep, slash > 0 ? path.slice(0, slash) : '/');
      if (!exists || !entries.some((f) => f.name === path.slice(slash + 1))) {
        die(`远端文件不存在：${path}`);
      }
      const r = await readRemoteText(ep, path, num(flags.page, 1), str(flags.dir) === 'DOWN' ? 'DOWN' : 'UP');
      console.log(`\n=== ${path} ===\n${r.text}`);
      console.log(`\n[总行数 ${r.totalLines ?? '?'}，页数 ${r.totalPages ?? '?'}]`);
      return;
    }

    case 'mkdir': {
      const arg = pos[0] ?? str(flags.path);
      if (!arg) die('用法：mkdir <远端目录>');
      const ep = await client.endpoints();
      const p = expandHome(arg, ep.home);
      if (await client.ensureRemoteDir(p)) {
        console.log(`已确保存在 ${p}`);
      } else {
        console.log(`! 无法创建 ${p}（folder-create 实测恒返回 1001 未知异常）。`);
        console.log('  上传文件时平台会自动建目录，所以通常不需要手动建——直接 put 试试。');
        process.exitCode = 1;
      }
      return;
    }

    case 'serve': {
      // 本机只读 HTTP。**只绑回环**——见 src/serve.ts 顶部第 1 条。
      const h = await startServer({ port: num(flags.port, DEFAULT_PORT), host: str(flags.host) });
      console.log(`SCNet 只读接口已启动：${h.url}`);
      console.log(`  操作清单  ${h.url}/ops`);
      console.log(`  例        ${h.url}/op/watch?id=<jobId>&steps=10000`);
      console.log(`  ${OPERATIONS.length} 个只读操作；不含上传/提交/取消。Ctrl+C 结束。`);
      return;
    }

    case 'mcp': {
      // MCP stdio：**stdout 从此是协议通道**，不许再打印任何东西（见 src/mcp.ts 顶部）。
      serveStdio();
      return;
    }

    default:
      console.log(
        [
          'SCNet（曙光超算）OpenAPI 客户端',
          '',
          '只读/诊断：',
          '  auth                          认证，列区域（token 脱敏）',
          '  probe                         端点 / 集群调度器 / 队列 / 配额',
          '  smoke                         只读冒烟（不动数据）',
          '  ls [路径]                     列远端目录',
          '  jobs [--limit N] [--name X]   实时作业列表',
          '  job <id>                      作业详情（读调度器 JobState）',
          '  readfile --path <p>           读远端文本文件',
          '',
          '文件：',
          '  put --file <本地> --dir <远端目录>',
          '  get --path <远端> --out <本地>',
          '  mkdir <远端目录>',
          '',
          '作业模板：',
          '  init [--out job.json]         生成起步模板',
          '  schema [--out file]           输出 JSON Schema',
          '  check <模板> [--lenient]      只校验（离线）',
          '  preview <模板> [--online]     打印将发出的 body（离线；--online 才联网）',
          '  run <模板> [--wait] [--download] [--no-upload]',
          '',
          '作业控制：',
          '  watch <id> [--steps N] [--json]',
          '                                健康 / 进度 / ETA（读 .trn；速率靠前后两次采样做差，采样点落盘）',
          '  kill <id...>                  取消（会回查 JobState 确认）',
          '',
          '界面（同一批只读操作，见 src/core.ts）：',
          '  serve [--port 8787] [--host 127.0.0.1]',
          '                                本机 HTTP 只读接口；**只绑回环**，不含写操作',
          '  mcp                           MCP stdio 服务端，给别的 agent / MCP 客户端调',
          '',
          '凭据：~/.nefx/scnet/secret.json（或用 SCNET_SECRET_PATH 指别处），或 SCNET_USER / SCNET_ACCESS_KEY / SCNET_SECRET_KEY',
        ].join('\n'),
      );
      if (cmd) process.exitCode = 1;
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof ScnetError) {
    console.error('ERROR: ' + e.message);
  } else {
    console.error('ERROR: ' + (e as Error).message);
  }
  process.exitCode = 1;
}
