// 长任务监控里"挑哪份文件"的两条判据。
//
// 这两个坑都是 2026-09-14 在真实作业上踩出来的，而且都是**静默**的：
// 挑错 transcript 会报"作业卡住了"（其实在跑，会诱使人 kill 健康作业）；
// 挑错 stdout 会让报告引用另一个作业的读数。所以各钉一条测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickStdout, pickTranscript } from '../src/watch.ts';

const E = (name, size, lastModifiedTime) => ({ name, size, lastModifiedTime });

test('pickTranscript：挑最新改动的那份，不是最大的那份', () => {
  // 真实目录的样子：早先跑完的 842 KB 大文件 + 本次作业正在长的 139 KB 小文件
  const entries = [
    E('fluent-20260914-113510-5468.trn', 6161, '2026-09-14 11:35:55'),
    E('fluent-20260914-114138-20446.trn', 842423, '2026-09-14 12:35:33'),
    E('fluent-20260914-144722-13778.trn', 139605, '2026-09-14 14:56:41'),
    E('stdout.67305475', 140527, '2026-09-14 14:56:41'),
    E('phase1-timing.jou', 1134, '2026-09-14 14:44:25'),
  ];
  assert.equal(pickTranscript(entries).name, 'fluent-20260914-144722-13778.trn');
});

test('pickTranscript：没有 mtime 时退到文件名里的时间戳', () => {
  const entries = [
    E('fluent-20260914-114138-20446.trn', 842423),
    E('fluent-20260914-144722-13778.trn', 139605),
  ];
  assert.equal(pickTranscript(entries).name, 'fluent-20260914-144722-13778.trn');
});

test('pickTranscript：目录里没有 .trn 时返回 undefined，不要瞎猜', () => {
  assert.equal(pickTranscript([E('stdout.1', 10), E('solve.jou', 20)]), undefined);
});

test('pickTranscript：工作目录被共用时，必须排除别的作业的 .trn（第二次踩的坑）', () => {
  // 28 核作业 14:47:39 开跑（Fluent 14:47:22 起）；56 核 probe 14:59:19 提交，
  // 它的 .trn 名字更晚、mtime 也更新，但里面没有 Flow time 行。
  const entries = [
    E('fluent-20260914-113510-5468.trn', 6161, '2026-09-14 11:35:55'),
    E('fluent-20260914-114138-20446.trn', 842423, '2026-09-14 12:35:33'),
    E('fluent-20260914-144722-13778.trn', 176713, '2026-09-14 14:59:11'),
    E('fluent-20260914-145942-1958.trn', 6200, '2026-09-14 15:00:30'),
    E('fluent-20260914-150102-77.trn', 900, '2026-09-14 15:00:41'),
  ];
  const startMs = Date.parse('2026-09-14T14:47:39+08:00');
  assert.equal(
    pickTranscript(entries, { startMs }).name,
    'fluent-20260914-144722-13778.trn',
  );
  // 只给 StartTime 就够——不用 EndTime，因为"下一个作业紧接着提交"会把 EndTime 窗口糊掉
});

test('pickStdout：必须命中本次作业号，不能拿目录里第一条', () => {
  const entries = [
    E('stdout.67305315', 7891, '2026-09-14 14:46:51'),
    E('stdout.67305475', 140527, '2026-09-14 14:56:41'),
  ];
  assert.equal(pickStdout(entries, '67305475').name, 'stdout.67305475');
});

test('pickStdout：本次作业的 stdout 还没出现时，退到最新的那条而不是第一条', () => {
  const entries = [
    E('stdout.67305315', 7891, '2026-09-14 14:46:51'),
    E('stdout.67305999', 20, '2026-09-14 15:01:00'),
  ];
  assert.equal(pickStdout(entries, '67305475').name, 'stdout.67305999');
});
