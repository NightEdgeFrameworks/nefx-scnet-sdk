/**
 * 客户端入口：把认证 / 端点 / 上传 / 提交 / 等待 / 取回串成一条链。
 *
 * 用法（库）：
 *   import { ScnetClient } from './src/client.ts';
 *   const c = new ScnetClient({ region: '0' });
 *   await c.run(template, { wait: true, download: true });
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { authenticate, pickRegion, type Region } from './auth.ts';
import { downloadFile, dirExists, listDirComplete, makeDir, resolveEndpoints, type Endpoints } from './api.ts';
import { uploadFile, type UploadResult } from './upload.ts';
import { toSubmitBody, validateTemplate, renderCommand, commandSourceOf, expandHome, resolveOutputPath, workDirOf, type JobTemplate, type ValidateOptions } from './jobtemplate.ts';
import { cancelJobs, getJob, listJobs, submitJob, waitForJob, type WaitResult } from './jobs.ts';
import { die, show } from './redact.ts';

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export interface RunOptions {
  /** 上传（默认 true） */
  upload?: boolean;
  /** 提交（默认 true） */
  submit?: boolean;
  /** 轮询到终态（默认 false——长作业不该阻塞调用方） */
  wait?: boolean;
  /** 终态后取回 outputs（默认 false） */
  download?: boolean;
  /** 轮询间隔 ms（wait 时） */
  intervalMs?: number;
  /** 记录目录（默认 ./runs） */
  recordDir?: string;
  jobNameSuffix?: string;
  /**
   * 模板文件所在目录。相对路径的 inputs[].local / commandFile 先按它解析。
   * CLI 会自动传；库调用方从内存里构造模板时可以不管。
   */
  baseDir?: string;
  log?: (msg: string) => void;
}

export interface RunReport {
  name: string;
  jobId?: string;
  recordPath?: string;
  uploads: Array<{ local: string; remotePath: string; bytes: number; sha256: string; skipped?: boolean }>;
  wait?: WaitResult;
  downloads: Array<{ remote: string; local: string; bytes: number }>;
}

export class ScnetClient {
  #eps?: Endpoints;
  #regionSelector?: string;
  #allRegions?: Region[];

  constructor(opts: { region?: string } = {}) {
    this.#regionSelector = opts.region;
  }

  /** 认证并按需解析端点（结果缓存在实例上）。 */
  async endpoints(force = false): Promise<Endpoints> {
    if (this.#eps && !force) return this.#eps;
    const data = await authenticate(force);
    this.#allRegions = data;
    const reg = pickRegion(data, this.#regionSelector);
    this.#eps = await resolveEndpoints(reg);
    return this.#eps;
  }

  get regions(): Region[] {
    return this.#allRegions ?? [];
  }

  async list(remotePath?: string) {
    const ep = await this.endpoints();
    return listDirComplete(ep, remotePath ?? ep.home);
  }

  /**
   * 尽力确保远端目录存在。返回"现在到底存不存在"，**不抛异常**。
   *
   * 实测（2026-09-14）三条结论，合起来决定了这个函数的形状：
   *   1. `file/exist` 端点不可用（GET 恒 `1001 未知异常`），存在性只能靠 `file/list`。
   *   2. `folder-create` 对本账号同样恒返回 `1001 未知异常`——换 body 形态、换 method 都一样。
   *      它**不能**当成硬依赖，否则整个 run 会死在一个跟真正任务无关的调用上。
   *   3. **上传统分会自动建目录**：往一个不存在的远端目录里传文件，成功后 list 里就有了。
   *
   * 所以这里的策略是：能建就建，建不了就算了——真正的失败会在上传或提交时暴露，
   * 而且那时的报错跟用户真正关心的事直接相关。
   */
  async ensureRemoteDir(dir: string): Promise<boolean> {
    const ep = await this.endpoints();
    if (await dirExists(ep, dir)) return true;
    // makeDir 返回结果而不抛异常（见 api.ts 的注释）：这里是"预期内的失败"，
    // 不要让它往 stdout 打一整块 code=1001，那会把一次正常的 run 弄得像出事了。
    await makeDir(ep, dir);
    return dirExists(ep, dir);
  }

  /**
   * 提交前预览：默认不联网，只把要发出去的 body 和远端路径算出来。
   *
   * 【2026-09-14 实测踩到的坑】这里必须先走一遍 validateTemplate。
   * 手写的模板不会带全 fluent 组的所有字段（env / extraArgs / preCommands / …）；
   * 以前 preview 直接拿原始对象去 renderCommand，于是 `for (const e of f.env)` 抛
   * `TypeError: f.env is not iterable` —— 而同一个模板交给 run() 是能正常提交的，
   * 因为 run() 会先校验并补默认值。预览在提交前崩掉、真提交反而没事，这个不对称
   * 会让人以为是模板写错了。现在两边走同一条路：先校验补齐，再渲染。
   */
  preview(
    rawTemplate: unknown,
    ep?: Endpoints,
    baseDir?: string,
  ): {
    body: ReturnType<typeof toSubmitBody>;
    command: string;
    workDir: string;
    outputs: Array<{ remote: string; local: string }>;
  } {
    // checkFiles: false —— 预览不该依赖本地文件在不在（那是 check --lenient 的事）
    const { template: tpl, errors } = validateTemplate(rawTemplate, { checkFiles: false, baseDir });
    if (errors.length) {
      for (const e of errors) console.error('  ✗ ' + e);
      die(`模板校验不通过（${errors.length} 个错误）`);
    }
    const home = ep?.home ?? '$HOME';
    const jobId = '%j';
    return {
      body: toSubmitBody(tpl, {
        home,
        jobManagerId: ep?.jobManagerId ?? '<认证后自动获取>',
        userName: ep?.userName ?? '<认证后自动获取>',
      }),
      command: renderCommand(tpl),
      workDir: workDirOf(tpl, home),
      outputs: tpl.outputs.map((o) => ({
        remote: resolveOutputPath(o.remote, tpl, { home, jobId }),
        local: o.local.replace(/%j/g, jobId),
      })),
    };
  }

  /** 一站式：建目录 → 上传 → 提交 →（可选）等待 →（可选）取回 → 落运行记录。 */
  async run(rawTemplate: unknown, o: RunOptions = {}): Promise<RunReport> {
    const log = o.log ?? ((m: string) => console.log(m));
    const vopts: ValidateOptions = {
      checkFiles: true,
      fileExists: (p) => existsSync(p),
      baseDir: o.baseDir,
    };
    const { template, errors, warnings } = validateTemplate(rawTemplate, vopts);
    if (errors.length) {
      for (const e of errors) console.error('  ✗ ' + e);
      die(`模板校验不通过（${errors.length} 个错误）`);
    }
    for (const w of warnings) console.warn('  ! ' + w);

    const ep = await this.endpoints();
    const report: RunReport = { name: template.name, uploads: [], downloads: [] };
    const t0 = Date.now();

    // 1) 远端目录
    const dirs = [...new Set(template.inputs.map((i) => expandHome(i.remoteDir, ep.home)))];
    for (const d of dirs) {
      log(`· 确认远端目录 ${d}`);
      if (!(await this.ensureRemoteDir(d))) {
        log(`  ! ${d} 现在还不存在，且 folder-create 用不了（实测恒返回 1001）；`
          + '上传会自动建目录，所以先继续——若真建不出来，会在上传时报错');
      }
    }

    // 2) 上传
    if (o.upload !== false) {
      for (const inp of template.inputs) {
        const remoteDir = expandHome(inp.remoteDir, ep.home);
        const size = statSync(inp.local).size;
        const localSha = sha256(readFileSync(inp.local));
        const remoteName = inp.local.split(/[\\/]/).pop() as string;
        if (inp.skipIfSameSize) {
          const { entries } = await listDirComplete(ep, remoteDir);
          const hit = entries.find((f) => f.name === remoteName);
          if (hit && Number(hit.size) === size) {
            log(`· 跳过 ${remoteName}（远端已有同尺寸文件 ${size} B）`);
            report.uploads.push({
              local: inp.local,
              remotePath: `${remoteDir}/${remoteName}`,
              bytes: size,
              sha256: localSha,
              skipped: true,
            });
            continue;
          }
        }
        log(`· 上传 ${remoteName}  ${(size / 1048576).toFixed(1)} MiB`);
        const r: UploadResult = await uploadFile(ep, {
          file: inp.local,
          remoteDir,
          chunkSize: (inp.chunkMiB || template.upload.chunkMiB) * 1048576,
          cover: inp.cover ?? template.upload.cover,
          retries: template.upload.retries,
          onProgress: (p) => {
            const pct = ((100 * p.sentBytes) / (p.totalBytes || 1)).toFixed(1);
            log(`    [${p.chunk}/${p.totalChunks}] ${pct}%  ${(p.bytesPerSec / 1048576).toFixed(2)} MiB/s`);
          },
        });
        if (template.upload.verifySize) {
          const { entries } = await listDirComplete(ep, remoteDir);
          const hit = entries.find((f) => f.name === remoteName);
          if (!hit || Number(hit.size) !== size) {
            die(`上传校验失败：远端 ${remoteName} 大小 ${hit?.size ?? '不存在'}，本地 ${size}`);
          }
        }
        report.uploads.push({
          local: inp.local,
          remotePath: r.remotePath,
          bytes: r.bytes,
          sha256: localSha,
        });
      }
    }

    // 3) 提交
    if (o.submit === false) {
      log('· 按 --no-submit 跳过提交');
      report.recordPath = writeRecord(o, report, template, t0);
      return report;
    }
    const body = toSubmitBody(template, {
      home: ep.home,
      jobManagerId: ep.jobManagerId,
      userName: ep.userName,
    });
    log(`· 提交作业 "${body.mapAppJobInfo.GAP_JOB_NAME}"  queue=${body.mapAppJobInfo.GAP_QUEUE}  `
      + `cores=${body.mapAppJobInfo.GAP_NPROC}  walltime=${body.mapAppJobInfo.GAP_WALL_TIME}`);
    const jobId = await submitJob(ep, body);
    report.jobId = jobId;
    log(`  → jobId = ${jobId}`);

    // 4) 等待
    if (o.wait) {
      log('· 轮询作业状态（判据用调度器 JobState，jobStatus=statC 分不出完成/取消）');
      const w = await waitForJob(ep, jobId, {
        intervalMs: o.intervalMs ?? 15000,
        onTick: (d, el) =>
          log(`    ${(el / 1000).toFixed(0)}s  jobStatus=${d.jobStatus ?? '?'}  JobState=${d.jobState ?? '?'}`),
      });
      report.wait = w;
      log(`  → 终态 ${w.state}（${w.polls} 次轮询，${(w.elapsedMs / 1000).toFixed(0)}s）`);
    }

    // 5) 取回
    if (o.download && template.outputs.length) {
      for (const out of template.outputs) {
        const remote = resolveOutputPath(out.remote, template, { home: ep.home, jobId });
        const local = out.local.replace(/%j/g, jobId);
        mkdirSync(dirname(local), { recursive: true });
        try {
          const r = await downloadFile(ep, remote, local, (got, total) => {
            if (total) log(`    ${((100 * got) / total).toFixed(1)}%`);
          });
          report.downloads.push({ remote, local, bytes: r.bytes });
          log(`· 取回 ${remote} → ${local}  ${r.bytes} B`);
        } catch (e) {
          if (out.required) throw e;
          log(`· 跳过（非必需）${remote}：${(e as Error).message}`);
        }
      }
    }

    report.recordPath = writeRecord(o, report, template, t0);
    return report;
  }

  async jobs(o: Parameters<typeof listJobs>[1] = {}) {
    return listJobs(await this.endpoints(), o);
  }
  async job(id: string | number) {
    return getJob(await this.endpoints(), id);
  }
  async kill(ids: Array<string | number>) {
    return cancelJobs(await this.endpoints(), ids);
  }
  async status(id: string | number) {
    const ep = await this.endpoints();
    const d = await getJob(ep, id);
    return { ...d, cancelled: (d.jobState ?? '').toUpperCase() === 'CANCELLED' };
  }
}

/**
 * 运行记录：每个 run 一个目录，写 run.json。
 * 这是"产物契约"的最小实现——参数、代码版本哈希、上传清单、作业号、终态、取回清单全在里面，
 * 以后要回答"这个结果是怎么来的"不用靠记忆。
 */
function writeRecord(o: RunOptions, report: RunReport, tpl: JobTemplate, t0: number): string {
  const base = o.recordDir ?? 'runs';
  // 14 位 = YYYYMMDDhhmmss。以前写成 slice(0,15)，多切了一个毫秒分隔点，
  // 于是目录名长成 "20260914062132.-agent-selftest" 这种带一个孤零零 '.' 的样子。
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = join(base, `${stamp}-${tpl.name}${o.jobNameSuffix ?? ''}`);
  mkdirSync(dir, { recursive: true });
  const rec = {
    schema: 'scnet-client/run-record@1',
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    jobId: report.jobId ?? null,
    templateSha256: sha256(JSON.stringify(tpl)),
    template: tpl,
    command: renderCommand(tpl),
    commandSource: commandSourceOf(tpl),
    uploads: report.uploads,
    terminal: report.wait ? { state: report.wait.state, polls: report.wait.polls } : null,
    jobDetail: report.wait?.detail.raw ?? null,
    downloads: report.downloads,
    notes: [
      'judgement: 终态判据只用调度器 JobState；jobStatus=statC 无法区分完成与取消',
      'verify: 上传后用远端 size 粗校验；下载前先列父目录确认存在，落盘前再嗅一次平台错误信封',
      'commandSource: 这份作业的实际命令来源；fluent 组只有在模板里确实写了才会被选中',
    ],
  };
  const p = join(dir, 'run.json');
  writeFileSync(p, JSON.stringify(rec, null, 2));
  return p;
}

export { show };
