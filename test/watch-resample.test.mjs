/**
 * 采样节流的判据。
 *
 * 为什么单独测它：这是"服务形态"暴露出来的一个真问题——`watch` 每次调用都会落一个
 * 采样点，而速率靠前后两点做差。两个调用方几乎同时来问，就会算出 0 步的差值，
 * 进而报出「时间步没推进」这个**假警报**。判据本身必须能被离线验证，
 * 不能靠"实际跑一次看看"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_RESAMPLE_SEC, resampleDecision } from '../src/watch.ts';

test('第一次采样（没有前一次）不节流', () => {
  const d = resampleDecision(null, 1_000_000);
  assert.equal(d.tooSoon, false);
  assert.equal(d.sincePrevSec, null);
  assert.equal(d.retryInSec, null);
});

test('间隔不足时判为 tooSoon，并给出还要等多久', () => {
  const now = 1_000_000;
  const d = resampleDecision(now - 3_000, now); // 3 秒前采过
  assert.equal(d.tooSoon, true);
  assert.equal(d.sincePrevSec, 3);
  assert.equal(d.retryInSec, MIN_RESAMPLE_SEC - 3);
});

test('刚好卡在阈值上不算 tooSoon（边界是闭区间，别差一秒反复抖）', () => {
  const now = 1_000_000;
  assert.equal(resampleDecision(now - MIN_RESAMPLE_SEC * 1000, now).tooSoon, false);
  assert.equal(resampleDecision(now - MIN_RESAMPLE_SEC * 1000 + 1, now).tooSoon, true);
});

test('间隔够了就正常采样', () => {
  const now = 1_000_000;
  const d = resampleDecision(now - 120_000, now);
  assert.equal(d.tooSoon, false);
  assert.equal(d.sincePrevSec, 120);
  assert.equal(d.retryInSec, null);
});

test('默认阈值是 30 秒：够长到不容易误判，够短到一轮计划任务能出结果', () => {
  assert.equal(MIN_RESAMPLE_SEC, 30);
});
