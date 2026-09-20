/**
 * 离线测试：只测纯函数（签名、脱敏、模板校验、命令行渲染、GAP_* 映射、Schema 派生）。
 * 不联网、不需要凭据。跑法：npm test
 *
 * 注意：本文件是 .mjs（不经类型剥离），所以里面不能写 TS 语法。
 * 被测模块是 .ts，Node 24 会自动剥类型，可以直接 import。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sign, resolveSecretPath, resolveStateDir, DEFAULT_DIR } from '../src/auth.ts';
import { mask, redact, ScnetError } from '../src/redact.ts';
import { hmsToSec, parseFlowTime, parsePlatformTime } from '../src/watch.ts';
import { platformErrorIn, listQuery, nextListLimit, isTruncated, normalizeQuota, quotaPath } from '../src/api.ts';
import { ScnetClient } from '../src/client.ts';
import { parseJobDetail } from '../src/jobs.ts';
import {
  SPEC,
  commandSourceOf,
  expandHome,
  jsonSchema,
  nearestNames,
  renderCommand,
  renderFluentCommand,
  resolveOutputPath,
  starterTemplate,
  toSubmitBody,
  validateTemplate,
  workDirOf,
} from '../src/jobtemplate.ts';

// ── 签名 ────────────────────────────────────────────────────────────────────

test('sign：payload 的三个键必须是字典序 accessKey < timestamp < user', () => {
  const ak = 'AK1';
  const ts = '1700000000';
  const user = 'u1';
  const expected = createHmac('sha256', 'SK1')
    .update(`{"accessKey":"${ak}","timestamp":"${ts}","user":"${user}"}`, 'utf8')
    .digest('hex');
  assert.equal(sign('SK1', ak, ts, user), expected);
  // 换 SK 一定变；同输入一定不变
  assert.notEqual(sign('SK2', ak, ts, user), expected);
  assert.equal(sign('SK1', ak, ts, user), sign('SK1', ak, ts, user));
  assert.match(sign('SK1', ak, ts, user), /^[0-9a-f]{64}$/);
});

// ── 脱敏 ────────────────────────────────────────────────────────────────────

test('redact：按 key 名拦截 token / secret / signature', () => {
  const out = redact({
    token: 'abcdefghijklmnop',
    secret_key: 'x'.repeat(32),
    signature: 'y'.repeat(64),
    GAP_QUEUE: 'xahcnormal',
  });
  assert.equal(out.GAP_QUEUE, 'xahcnormal', '普通字段不能被误伤');
  assert.doesNotMatch(out.token, /abcdefghijklmnop/);
  assert.doesNotMatch(out.secret_key, /xxxx/);
  assert.doesNotMatch(out.signature, /yyyy/);
});

test('redact：长字符串即使 key 名正常也会被当作疑似 token 掩掉', () => {
  const out = redact({ foo: 'A'.repeat(50) });
  // mask 保留前 3 位与后 2 位，中间用 … 代替，并标注原长度
  assert.equal(out.foo, 'AAA…AA[50]');
  assert.ok(!out.foo.includes('A'.repeat(20)), '不能把原值整段漏出去');
  // URL 不能误伤
  const url = 'https://example.com/' + 'a'.repeat(60);
  const out2 = redact({ url });
  assert.equal(out2.url, url);
});

test('mask：短值一律 ***，不泄漏长度', () => {
  assert.equal(mask('short'), '***');
  assert.equal(mask(undefined), '<redacted>');
});

// ── 模板校验 ────────────────────────────────────────────────────────────────

const base = () => ({
  name: 't1',
  queue: 'xahcnormal',
  resources: { nodes: 1, cores: 8, walltime: '02:00:00' },
  inputs: [],
  fluent: { journal: 'solve.jou' },
  outputs: [],
});

test('默认值被补齐', () => {
  const { template, errors } = validateTemplate(base());
  assert.deepEqual(errors, []);
  assert.equal(template.resources.nodes, 1);
  assert.equal(template.stdout, 'stdout.%j');
  assert.equal(template.upload.chunkMiB, 8);
  assert.equal(template.resources.nodeString, '');
  assert.equal(template.fluent.installCandidates.length, 3);
});

test('未知字段直接报错（拼错会被静默忽略，这是最贵的失败模式）', () => {
  const { errors } = validateTemplate({ ...base(), resourses: { cores: 8 } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /未知字段 resourses/);
});

test('嵌套对象里的未知字段也报错', () => {
  const b = base();
  b.resources = { ...b.resources, cpus: 8 };
  assert.match(validateTemplate(b).errors.join('\n'), /未知字段 resources\.cpus/);
});

test('命令来源四选一：都不给 / 给两个都报错', () => {
  const none = base();
  delete none.fluent;
  assert.match(validateTemplate(none).errors.join('\n'), /必须给出 fluent \/ openfoam \/ commandFile \/ command/);

  const two = { ...base(), command: 'echo hi' };
  assert.match(validateTemplate(two).errors.join('\n'), /只能给一个/);

  // openfoam 是第四个来源，同样受互斥约束
  const ofAndFluent = { ...base(), openfoam: { solver: 'interFoam' } };
  assert.match(validateTemplate(ofAndFluent).errors.join('\n'), /只能给一个.*openfoam/s);
});

test('walltime 格式与 cores 下限', () => {
  const b = base();
  b.resources = { ...b.resources, walltime: '2h', cores: 0 };
  const { errors } = validateTemplate(b);
  assert.match(errors.join('\n'), /walltime 格式/);
  assert.match(errors.join('\n'), /cores 应为 >=1/);
});

test('fluent.cores 默认跟随 resources.cores，不一致时告警', () => {
  const a = validateTemplate(base()).template;
  assert.equal(a.fluent.cores, 8);

  const b = base();
  b.fluent = { journal: 'solve.jou', cores: 4 };
  const r = validateTemplate(b);
  assert.equal(r.template.fluent.cores, 4);
  assert.match(r.warnings.join('\n'), /不一致/);
});

test('类型不符报错而不是静默转换', () => {
  const b = base();
  b.resources = { ...b.resources, cores: '8' };
  assert.match(validateTemplate(b).errors.join('\n'), /resources\.cores 类型不对/);
});

test('enum 受控', () => {
  const b = base();
  b.upload = { cover: 'overwrite' };
  assert.match(validateTemplate(b).errors.join('\n'), /upload\.cover 只能是/);
});

test('checkFiles 会检查本地文件是否存在', () => {
  const b = base();
  b.inputs = [{ local: '不存在.cas.h5', remoteDir: '/public/home/x/r1' }];
  const withCheck = validateTemplate(b, { checkFiles: true, fileExists: () => false });
  assert.match(withCheck.errors.join('\n'), /inputs\[0\]\.local 不存在/);
  const without = validateTemplate(b, { checkFiles: false });
  assert.doesNotMatch(without.errors.join('\n'), /不存在/);
});

test("checkFiles='warn' 把缺文件降成警告（check --lenient 用这条）", () => {
  const b = base();
  b.inputs = [{ local: '不存在.cas.h5', remoteDir: '/public/home/x/r1' }];
  const r = validateTemplate(b, { checkFiles: 'warn', fileExists: () => false });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join('\n'), /inputs\[0\]\.local 不存在/);
});

// ── ~ 展开与 workDir 默认值 ─────────────────────────────────────────────────

test('expandHome：~ 与 ~/x 展开，别的一律不动', () => {
  assert.equal(expandHome('~', '/public/home/u1'), '/public/home/u1');
  assert.equal(expandHome('~/runs/001', '/public/home/u1'), '/public/home/u1/runs/001');
  assert.equal(expandHome('/abs/path', '/public/home/u1'), '/abs/path');
  assert.equal(expandHome('', '/public/home/u1'), '');
});

test('workDir 默认取第一个上传目录（不一致是"跑完却找不到 cas 文件"的头号原因）', () => {
  const b = base();
  b.inputs = [{ local: 'a.cas.h5', remoteDir: '~/runs/001' }];
  const t = validateTemplate(b).template;
  assert.equal(t.workDir, '~/runs/001');
  assert.equal(workDirOf(t, '/public/home/u1'), '/public/home/u1/runs/001');
  // GAP_WORK_DIR 里绝不能留着未展开的 ~，远端 shell 不认
  const m = toSubmitBody(t, { home: '/public/home/u1', jobManagerId: '1', userName: 'u1' }).mapAppJobInfo;
  assert.equal(m.GAP_WORK_DIR, '/public/home/u1/runs/001');
  assert.equal(m.GAP_STD_OUT_FILE, '/public/home/u1/runs/001/stdout.%j');
});

test('workDir 显式给了就用显式的，不再被第一个上传目录覆盖', () => {
  const b = { ...base(), workDir: '~/w' };
  b.inputs = [{ local: 'a.cas.h5', remoteDir: '~/runs/001' }];
  const r = validateTemplate(b);
  assert.equal(r.template.workDir, '~/w');
  // 上传目录与工作目录不同要告警（journal 用绝对路径才安全）
  assert.match(r.warnings.join('\n'), /与上传目录/);
});

test('多个 remoteDir 会告警', () => {
  const b = base();
  b.inputs = [
    { local: 'a', remoteDir: '~/r1' },
    { local: 'b', remoteDir: '~/r2' },
  ];
  assert.match(validateTemplate(b).warnings.join('\n'), /不同的 remoteDir/);
});

test('resolveOutputPath：相对按 workDir，绝对原样，%j 可替换', () => {
  const b = base();
  b.inputs = [{ local: 'a.cas.h5', remoteDir: '~/runs/001' }];
  b.outputs = [
    { remote: '1_out.dat.h5', local: 'results/x.h5' },
    { remote: '~/logs/o.%j', local: 'results/o.%j' },
    { remote: '/scratch/abs.%j', local: 'results/abs' },
  ];
  const t = validateTemplate(b).template;
  const home = '/public/home/u1';
  assert.equal(resolveOutputPath('1_out.dat.h5', t, { home }), '/public/home/u1/runs/001/1_out.dat.h5');
  assert.equal(resolveOutputPath('~/logs/o.%j', t, { home, jobId: 42 }), '/public/home/u1/logs/o.42');
  assert.equal(resolveOutputPath('/scratch/abs.%j', t, { home, jobId: 42 }), '/scratch/abs.42');
});

test('尖括号占位符直接报错（远端 shell 会把它当重定向，错得很难对上原因）', () => {
  const b = base();
  b.inputs = [{ local: 'a', remoteDir: '/public/home/<user>/runs/001' }];
  const r = validateTemplate(b);
  assert.match(r.errors.join('\n'), /还有占位符/);
  assert.match(r.errors.join('\n'), /inputs\[0\]\.remoteDir/);
});

test('starterTemplate 不含尖括号占位符，且 workDir 落在 ~/runs/001', () => {
  const t = starterTemplate('x');
  const raw = JSON.parse(JSON.stringify(t));
  assert.equal(validateTemplate(raw).errors.length, 0);
  assert.equal(t.workDir, '~/runs/001');
  assert.ok(!JSON.stringify(t).includes('<'), '起步模板里不该再有 <占位符>');
});

// ── 队列名校验（check --online 用）─────────────────────────────────────────

test('knownQueues：拼错的 queue 要报错，并给出可用列表和相近名提示', () => {
  const b = { ...base(), queue: 'xahc-normal-typo' };
  const r = validateTemplate(b, { knownQueues: ['xahdnormal', 'xahcnormal'] });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /不在本集群的可用队列里/);
  assert.match(r.errors[0], /xahdnormal \/ xahcnormal/);
  assert.match(r.errors[0], /你是不是想写 xahcnormal/);
});

test('knownQueues：正确的 queue 不报错；不给 knownQueues 时不判（离线也能用）', () => {
  const b = { ...base(), queue: 'xahcnormal' };
  assert.deepEqual(validateTemplate(b, { knownQueues: ['xahcnormal'] }).errors, []);
  assert.deepEqual(validateTemplate(b).errors, [], '离线不给队列表时不该凭空报错');
});

// ── 报错不要串成一片 ────────────────────────────────────────────────────────

test('cores 类型写错时只报一条，不再串出"应为 >=1 的整数"和假的 fluent 不一致告警', () => {
  const b = base();
  b.resources = { nodes: 1, cores: '8', walltime: '02:00:00' };
  const r = validateTemplate(b);
  const coreErrs = r.errors.filter((e) => e.includes('resources.cores'));
  assert.equal(coreErrs.length, 1, `cores 只该报一条，实际：${JSON.stringify(coreErrs)}`);
  assert.match(coreErrs[0], /类型不对/);
  assert.doesNotMatch(r.warnings.join('\n'), /不一致/, '不该由报错本身造出"fluent.cores 不一致"的假象');
});

// ── Fluent 命令行 ───────────────────────────────────────────────────────────

test('renderFluentCommand：探测循环 + 通配符不引用 + 找不到就 exit 42', () => {
  const { template } = validateTemplate(base());
  const cmd = renderCommand(template);
  assert.match(cmd, /for _d in \$HOME\/apprepo\/fluent\/2023r1-xian/);
  // 第三项必须是未加引号的通配符，否则 shell 不会展开
  assert.match(cmd, /\$HOME\/appre\*\/fluent\/2023r1-xian/);
  assert.doesNotMatch(cmd, /"\$HOME\/appre\*/);
  assert.match(cmd, /exit 42/);
  assert.match(cmd, /export FLUENT_ROOT="\$_root"/);
  assert.match(cmd, /-g /, '-g 必须带上（无 DISPLAY 时没有它会失败）');
  assert.match(cmd, /-t8 /);
  assert.match(cmd, /-i solve\.jou/);
});

test('renderFluentCommand：extraArgs / env / pre / post 都被带上', () => {
  const cmd = renderFluentCommand({
    installCandidates: ['$HOME/x'],
    binRelPath: 'app/v231/fluent/bin/fluent',
    dimension: '3ddp',
    mpi: 'intel',
    cores: 28,
    journal: 'j.jou',
    extraArgs: ['-driver', 'null'],
    env: ['LIC=1'],
    preCommands: ['echo pre'],
    postCommands: ['echo post'],
  });
  assert.match(cmd, /export LIC=1/);
  assert.match(cmd, /echo pre/);
  assert.match(cmd, /-t28 -i j\.jou -driver null/);
  assert.match(cmd, /echo post/);
});

// ── GAP_* 映射 ──────────────────────────────────────────────────────────────

test('toSubmitBody：字段映射与 %j 输出名', () => {
  const { template } = validateTemplate(base());
  const body = toSubmitBody(template, { home: '/public/home/h', jobManagerId: '1657258990', userName: 'h' });
  assert.equal(body.strJobManagerID, '1657258990');
  const m = body.mapAppJobInfo;
  assert.equal(m.GAP_QUEUE, 'xahcnormal');
  assert.equal(m.GAP_NPROC, '8');
  assert.equal(m.GAP_NNODE, '1');
  assert.equal(m.GAP_NODE_STRING, '', '给了 nodes 时 nodeString 必须为空');
  assert.equal(m.GAP_WORK_DIR, '/public/home/h');
  assert.equal(m.GAP_STD_OUT_FILE, '/public/home/h/stdout.%j');
  assert.equal(m.GAP_APPNAME, 'BASE');
  assert.equal(m.GAP_SUBMIT_TYPE, 'cmd');
  assert.ok(m.GAP_CMD_FILE.includes('FLUENT_ROOT'));
});

test('toSubmitBody：模板里给了 jobManagerId 就用模板的', () => {
  const b = base();
  b.jobManagerId = '999';
  const { template } = validateTemplate(b);
  assert.equal(toSubmitBody(template, { home: '/h', jobManagerId: '111', userName: 'u' }).strJobManagerID, '999');
});

test('toSubmitBody：workDir 覆盖家目录，末尾斜杠被去掉', () => {
  const b = { ...base(), workDir: '/public/home/h/run1/' };
  const { template } = validateTemplate(b);
  const m = toSubmitBody(template, { home: '/h', jobManagerId: '1', userName: 'u' }).mapAppJobInfo;
  assert.equal(m.GAP_WORK_DIR, '/public/home/h/run1');
  assert.equal(m.GAP_STD_OUT_FILE, '/public/home/h/run1/stdout.%j');
});

test('untested 字段留空时不能塞进请求体', () => {
  const { template } = validateTemplate(base());
  const m = toSubmitBody(template, { home: '/h', jobManagerId: '1', userName: 'u' }).mapAppJobInfo;
  assert.equal(m.GAP_PPN, '');
  assert.equal(m.GAP_NGPU, '');
  assert.equal(m.GAP_NDCU, '');
  assert.equal(m.GAP_EXCLUSIVE, '');
});

// ── JSON Schema ─────────────────────────────────────────────────────────────

test('jsonSchema 由 SPEC 派生，字段与默认值一致', () => {
  const s = jsonSchema();
  assert.equal(s.type, 'object');
  assert.deepEqual(s.required, ['name']);
  assert.equal(s.properties.resources.properties.cores.default, SPEC.resources.fields.cores.default);
  assert.equal(s.properties.queue.default, 'xahcnormal');
  assert.equal(s.additionalProperties, false);
  // evidence 标注要带进 description，方便在编辑器里一眼看到哪些没实测
  assert.match(s.properties.resources.properties.gpus.description, /evidence: untested/);
  assert.match(s.properties.resources.properties.cores.description, /evidence: verified/);
});

test('starterTemplate 自己能通过校验', () => {
  const t = starterTemplate('x');
  const r = validateTemplate(JSON.parse(JSON.stringify(t)));
  assert.deepEqual(r.errors, []);
});

// ── 错误类型 ────────────────────────────────────────────────────────────────

test('ScnetError 能带上下文', () => {
  const e = new ScnetError('boom', { token: 'z'.repeat(40) });
  assert.equal(e.name, 'ScnetError');
  assert.equal(e.message, 'boom');
});

// ── 回归：默认值不许顶掉用户显式给的东西（2026-09-14 实测事故）────────────
// 事故现场：模板只写了 command，校验阶段把 fluent 组的默认值补齐，
// renderCommand 于是选了 Fluent，提交上去的是
//   "$_fluent" 3ddp -g -mpi=intel -t1 -i solve.jou
// 作业 42 秒后 FAILED（ExitCode 1），因为工作目录里根本没有 solve.jou。

test('只给 command 时绝不会被补出来的 fluent 组顶掉（这是真出过的事故）', () => {
  const raw = {
    name: 'cmd-only',
    queue: 'xahcnormal',
    resources: { nodes: 1, cores: 1, walltime: '00:05:00' },
    inputs: [],
    command: 'echo hello > result.txt',
    outputs: [],
  };
  const { template, errors } = validateTemplate(raw);
  assert.deepEqual(errors, []);
  assert.equal(template.fluent, undefined, 'fluent 组在用户没写时不该被补出来');
  assert.equal(commandSourceOf(template), 'command');
  assert.equal(renderCommand(template), 'echo hello > result.txt');
  const m = toSubmitBody(template, { home: '/h', jobManagerId: '1', userName: 'u' }).mapAppJobInfo;
  assert.equal(m.GAP_CMD_FILE, 'echo hello > result.txt');
  assert.doesNotMatch(m.GAP_CMD_FILE, /_fluent|3ddp/, '提交体里不该出现 Fluent 命令行');
});

test('显式给了 fluent 就还是 fluent（默认值改动的反向保证）', () => {
  const { template } = validateTemplate(base());
  assert.equal(commandSourceOf(template), 'fluent');
  assert.match(renderCommand(template), /FLUENT_ROOT/);
});

test('commandFile / 三者都不给时 commandSourceOf 的取值', () => {
  const none = base();
  delete none.fluent;
  assert.equal(commandSourceOf(validateTemplate(none).template), 'none');

  const b = base();
  delete b.fluent;
  b.commandFile = 'no-such-script.sh';
  assert.equal(commandSourceOf(validateTemplate(b).template), 'commandFile');
});

// ── 队列名的"你是不是想写…" ─────────────────────────────────────────────────

test('nearestNames：只差分隔符/大小写也能认出来（归一化）', () => {
  const qs = ['xahdnormal', 'xahcnormal'];
  // 归一化后 'xahcnormaltypo'.includes('xahcnormal') —— 旧实现用的原样包含判断做不到这一点
  assert.deepEqual(nearestNames('xahc-normal-typo', qs), ['xahcnormal']);
  assert.deepEqual(nearestNames('XAHC_NORMAL', qs), ['xahcnormal']);
});

test('nearestNames：真拼错时用编辑距离兜底，差太远就干脆不提', () => {
  // xahcnromal 是 r/o 写反了：到 xahcnormal 距离 2、到 xahdnormal 距离 3，两个都在容差内，
  // 所以两个都该列出来，但**最接近的必须排第一**。
  assert.equal(nearestNames('xahcnromal', ['xahdnormal', 'xahcnormal'])[0], 'xahcnormal');
  assert.deepEqual(nearestNames('totally-different-queue', ['xahdnormal', 'xahcnormal']), []);
});

// ── 本地相对路径按模板目录解析 ─────────────────────────────────────────────

test('inputs[].local 先按模板所在目录解析，再退回当前工作目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scnet-tpl-'));
  mkdirSync(join(dir, 'case'));
  writeFileSync(join(dir, 'case', '1.cas.h5'), 'x');
  const raw = () => ({
    name: 'rel',
    queue: 'xahcnormal',
    resources: { nodes: 1, cores: 1, walltime: '00:05:00' },
    inputs: [{ local: 'case/1.cas.h5', remoteDir: '~/runs/001' }],
    command: 'true',
    outputs: [],
  });

  // 不给 baseDir：相对 cwd 解析，临时目录里的文件当然找不到
  const noBase = validateTemplate(raw(), { checkFiles: true, fileExists: (p) => p === join(dir, 'case', '1.cas.h5') });
  assert.match(noBase.errors.join('\n'), /inputs\[0\]\.local 不存在/);

  // 给了 baseDir：解析成模板旁边的那个文件，并且**写回**模板（上传要用同一个路径）
  const withBase = validateTemplate(raw(), {
    checkFiles: true,
    fileExists: (p) => p === join(dir, 'case', '1.cas.h5'),
    baseDir: dir,
  });
  assert.deepEqual(withBase.errors, []);
  assert.equal(withBase.template.inputs[0].local, join(dir, 'case', '1.cas.h5'));
});

// ── 作业详情解析（真实返回结构，2026-09-14 与 scontrol 对照过）──────────────

test('parseJobDetail：外层的空 exitCode 不许挡住调度器层真正的退出码', () => {
  // 这是 /openapi/v2/jobs/<id> 的真实形状（字段序敏感的那部分原样保留）：
  // data.exitCode 是**空字符串**，真正的值在 data.jobInitAttr.ExitCode = "0:0"。
  // 按 key 名找到第一个就返回的写法会取到空串，CLI 于是打印 "ExitCode = "（空白），
  // 而空白看起来跟"不知道"一模一样——作业失败后第一件事就是看这一行。
  const resp = {
    httpStatus: 200,
    code: '0',
    msg: 'success',
    data: {
      jobName: 'scnet-selfcheck-cmd',
      queue: 'xahcnormal',
      exitCode: '',
      jobRunTime: '00:00:03',
      workDir: '/work/home/u/runs/selfcheck',
      jobInitAttr: {
        JobName: 'scnet-selfcheck-cmd',
        JobState: 'COMPLETED',
        ExitCode: '0:0',
        Reason: 'None',
        WorkDir: '/work/home/u/runs/selfcheck',
        NumCPUs: 1,
        NumNodes: 1,
      },
    },
  };
  const d = parseJobDetail(resp);
  assert.equal(d.found, true);
  assert.equal(d.exitCode, '0:0');
  assert.equal(d.jobState, 'COMPLETED');
  assert.equal(d.reason, 'None');
  assert.equal(d.runTime, '00:00:03');
  assert.equal(d.workDir, '/work/home/u/runs/selfcheck');
});

test('parseJobDetail：作业不存在时 found=false（code=0 + data=null 是陷阱）', () => {
  const d = parseJobDetail({ httpStatus: 200, code: '0', msg: 'success', data: null });
  assert.equal(d.found, false);
  assert.equal(d.jobState, undefined, '不能把"不存在"当成"状态还没出来"');
});


test('watch：平台时间戳必须按北京时区解析（不带时区时差 8 小时）', () => {
  // 实测原文形如 "2026-09-14T14:47:13"，表示北京时间，等于 06:47:13Z。
  // 直接 Date.parse 会按本机时区解释，换一台 UTC 机器就整体错 8 小时。
  assert.equal(parsePlatformTime('2026-09-14T14:47:13'), Date.parse('2026-09-14T06:47:13Z'));
  assert.equal(parsePlatformTime('2026-09-14 14:47:13'), Date.parse('2026-09-14T06:47:13Z'));
  // 已经带时区的就不要再加偏移
  assert.equal(parsePlatformTime('2026-09-14T06:47:13Z'), Date.parse('2026-09-14T06:47:13Z'));
  assert.equal(parsePlatformTime(''), null);
  assert.equal(parsePlatformTime(undefined), null);
  assert.equal(parsePlatformTime('不是时间'), null);
});

test('watch：从 transcript 里认出"已完成到第几步"', () => {
  const txt = [
    '  217935  1.3e-04  0:00:00   20',
    'Flow time = 2.928s, time step = 7867',
    'Flow time = 2.9775s, time step = 7966',
    'Random trailing garbage',
  ].join('\n');
  assert.deepEqual(parseFlowTime(txt), { t: 2.9775, step: 7966 });
  assert.equal(parseFlowTime('没有任何 Flow time'), null);
});

test('watch：墙钟字符串换算', () => {
  assert.equal(hmsToSec('01:00:00'), 3600);
  assert.equal(hmsToSec('00:03:34'), 214);
  assert.equal(hmsToSec('1:02:03'), 3723);
  assert.equal(hmsToSec('bad'), null);
  assert.equal(hmsToSec(undefined), null);
});


test('quotaPath：必须是官方文档里的 parastor 资源段（猜错路径会 404）', () => {
  // 2026-09-15 实测：官方文档「查询共享存储配额及使用量」写的是
  //   {hpcUrls}/hpc/openapi/v2/parastor/quota/usernames/{username}
  // 我们先前猜的 /userquota/users/{u} 与 /file/quota 全部 404/1001，
  // 于是错记成"平台没有配额接口"。这条测试钉住正确路径，防止有人"顺手改回去"。
  assert.equal(quotaPath('demo-user'), '/openapi/v2/parastor/quota/usernames/demo-user');
  assert.equal(quotaPath('a b'), '/openapi/v2/parastor/quota/usernames/a%20b', '用户名要转义');
  assert.match(quotaPath('x'), /^\/openapi\/v2\/parastor\/quota\/usernames\//);
  assert.doesNotMatch(quotaPath('x'), /userquota/, '旧的猜测路径不许复活');
});

test('normalizeQuota：单位是 GB，缺字段给 null，超额如实报 >100%', () => {
  // 实测返回（家目录）：[{"quotaId":101072,"username":"","path":"/work/home/demo-user","threshold":300,"usage":61.6}]
  const real = normalizeQuota([
    { quotaId: 101072, username: '', path: '/work/home/demo-user', threshold: 300, usage: 61.6 },
  ]);
  assert.equal(real.length, 1);
  assert.equal(real[0].path, '/work/home/demo-user');
  assert.equal(real[0].thresholdGB, 300);
  assert.equal(real[0].usageGB, 61.6);
  assert.ok(Math.abs(real[0].freeGB - 238.4) < 1e-9, '剩余 = 配额 - 已用');
  assert.ok(Math.abs(real[0].percentUsed - 20.533333333333335) < 1e-9);

  // 字符串数字也要认（平台有的接口回字符串）
  assert.equal(normalizeQuota([{ path: '/x', threshold: '10', usage: '5' }])[0].freeGB, 5);

  // 缺字段 → null，**不许补 0**：0 和"平台没说"是两件事
  const partial = normalizeQuota([{ path: '/x', usage: 5 }])[0];
  assert.equal(partial.thresholdGB, null);
  assert.equal(partial.freeGB, null);
  assert.equal(partial.percentUsed, null, '分母未知时百分比必须是 null，不能是 Infinity');

  // 配额为 0 也不能算出 Infinity
  const zero = normalizeQuota([{ path: '/x', threshold: 0, usage: 5 }])[0];
  assert.equal(zero.percentUsed, null);
  assert.equal(zero.freeGB, -5, '配额 0 但已用 5 ⇒ 剩余 -5，如实报负数');

  // 超额要如实（平台允许超配额写），不许夹成 100
  const over = normalizeQuota([{ path: '/x', threshold: 100, usage: 250 }])[0];
  assert.equal(over.percentUsed, 250);

  // 非数组 / 脏数据不炸
  assert.deepEqual(normalizeQuota(null), []);
  assert.deepEqual(normalizeQuota({ threshold: 1 }), [], '对象不是数组 ⇒ 空，别当单条处理');
  assert.deepEqual(normalizeQuota([null, 42, 'x']), [], '非对象的行直接跳过');
});

test('listDir 的 URL 必须带 limit：不带时平台只回 10 条（2026-09-14 实测）', () => {  // 这一条是防回归的：file/list 不带分页参数时 fileList 恒为 10 条，真数在 data.total 里，
  // 而 pageNum / pageSize / pageIndex / currentPage / size 全都被忽略，只有 limit/offset 进入 URL。
  // 症状是上传校验报"远端文件不存在"，其实文件好好地在那儿。
  assert.match(listQuery('/a/b c'), /\?path=%2Fa%2Fb%20c&limit=\d+&offset=0$/);
  assert.match(listQuery('/x', 5, 10), /&limit=5&offset=10$/);
});

test('isTruncated：判截断只能拿 total 跟"拿到的条数"比，不能把目录数再加一遍', () => {
  // 2026-09-15 实测：total 就是 fileList 的条数，而 fileList **里也有目录**；
  // 同时 children（dirs）不受 limit 截断影响，恒为该目录全部子目录。
  // 所以老判据 total > files.length + dirs.length 会把目录数两遍 —— 偏松、会漏报截断。
  // 下面的数字全是家目录上的实测值：total=99、children=14。
  assert.equal(isTruncated(99, 90), true, 'limit=90 时少 9 条，必须判截断');
  assert.equal(isTruncated(99, 99), false, '一页拿全');
  assert.equal(isTruncated(99, 100), false, '拿到的比 total 还多（理论上不该发生）也不算截断');
  assert.equal(isTruncated(Number.NaN, 0), false, 'total 不是数字时不敢乱判');
  // 阴性对照：把老公式算一遍，证明它在这个真实目录上确实漏报（99 > 90+14 为假）
  const total = 99;
  const got = 90;
  const dirsNotPageLimited = 14;
  assert.equal(total > got + dirsNotPageLimited, false, '老判据在这里返回"没截断"——这就是那个 bug');
  assert.equal(isTruncated(total, got), true, '新判据必须抓住它');
});

test('nextListLimit：不够就翻倍要，够了返回 null，超过安全上限也要收手', () => {
  assert.equal(nextListLimit(10, 10), null, '刚好拿全');
  assert.equal(nextListLimit(9, 10), null, '拿多了也当拿全');
  assert.equal(nextListLimit(5214, 1000), 5214 * 2 + 100, '欠账时给 total*2+100');
  assert.equal(nextListLimit(32, 10), 164, 'job_example 的真实数字');
  assert.equal(nextListLimit(Number.NaN, 0), null, 'total 无效就不敢再问');
  assert.equal(nextListLimit(3_000_000, 1), null, '超过 LIST_LIMIT_CEILING 就收手，别把 URL 拼到荒唐长度');
  // 阴性对照：正常量级不许被上限拦住，否则大目录会永远拿不全。
  // 注意 1_000_000 这个数**正好会被拦**（2_000_100 > 2_000_000）——边界是"要到的值"不是"total"。
  assert.equal(nextListLimit(900_000, 1), 1_800_100, '九十万条仍在安全区内');
  assert.equal(nextListLimit(1_000_000, 1), null, '要到 2_000_100 就超限了，宁可报 truncated 也不拼一个荒唐的 URL');
});

test('preview：手写的模板（缺 fluent 的默认子字段）不许崩', () => {
  // 实测踩过：preview 以前直接拿原始对象去 renderCommand，而手写模板不会带全
  // env / extraArgs / preCommands，于是 `for (const e of f.env)` 抛
  // TypeError: f.env is not iterable —— 同一个模板交给 run() 却能正常提交。
  // 现在 preview 内部也先走 validateTemplate。
  const tpl = mkdtempSync(join(tmpdir(), 'scnet-prev-'));
  const jou = join(tpl, 'solve.jou');
  writeFileSync(jou, '/exit\nyes\n');
  const c = new ScnetClient({ region: '0' });
  const pv = c.preview({
    name: 'preview-handwritten',
    resources: { cores: 8 },
    workDir: '~/runs/prev',
    inputs: [{ local: jou, remoteDir: '~/runs/prev' }],
    fluent: { journal: 'solve.jou' }, // 故意只给这一个字段
  });
  assert.match(pv.command, /-t8 -i solve\.jou$/m);
  assert.equal(pv.workDir, '$HOME/runs/prev');
});


test('platformErrorIn：认出平台的错误信封，不误伤正常 JSON 文件', () => {
  // 实测原文（57 B），HTTP 200、content-length 与它一致，字节校验拦不住
  const real = '{"code":"911020","data":null,"msg":"File does not exist"}';
  assert.equal(platformErrorIn(real), 'File does not exist');
  assert.equal(platformErrorIn(Buffer.from(real, 'utf8')), 'File does not exist');

  // 正常成功的返回、以及看起来像 JSON 但其实是用户数据的情况都不能误报
  assert.equal(platformErrorIn('{"code":"0","data":{"a":1},"msg":"success"}'), null);
  assert.equal(platformErrorIn('{"temperature":300,"pressure":101325}'), null);
  assert.equal(platformErrorIn('{"code":"911020","data":null', ), null, '截断的 JSON 不算数');
  assert.equal(platformErrorIn('not json at all'), null);
});

test('resolveSecretPath / resolveStateDir：凭据与状态目录怎么选', () => {
  // 没有显式指定（本机默认、也是外面 clone 下来的默认）：只有默认位置一个答案
  const none = resolveSecretPath({ explicit: undefined });
  assert.equal(none.path, join(DEFAULT_DIR, 'secret.json'));
  assert.equal(none.dir, DEFAULT_DIR);

  // 不变量：dir 就是 path 的父目录（状态目录靠它定位）
  assert.equal(join(none.dir, 'secret.json'), none.path);

  // 显式指定压过一切，状态目录也跟着它走
  const explicit = join('some', 'dir', 'mine.json');
  const forced = resolveSecretPath({ explicit });
  assert.equal(forced.path, explicit);
  assert.equal(forced.dir, join('some', 'dir'));

  // 状态目录：显式 > 凭据所在目录
  assert.equal(
    resolveStateDir({ explicit: join('var', 'lib', 'scnet'), secretDir: DEFAULT_DIR }),
    join('var', 'lib', 'scnet'),
  );
  assert.equal(resolveStateDir({ explicit: undefined, secretDir: forced.dir }), join('some', 'dir'));
  assert.equal(resolveStateDir({ explicit: undefined, secretDir: DEFAULT_DIR }), DEFAULT_DIR);
});

