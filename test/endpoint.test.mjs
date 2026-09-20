// 只读探测端点的"拿没拿到"判据。
//
// 背景：`userlimits` / `userusedtime` / `userquota` 在本账号上整片 404，
// 而 `getJson()` 把 404 的正文原样返回。第一版 `probe` 直接 show() 正文，
// 于是 404 的错误信封被当成数据打印出来——"失败长得像成功"。
// `unavailableReason()` 把这条判据抽成纯函数，这里钉住它的四种情形。
import test from 'node:test';
import assert from 'node:assert/strict';

import { unavailableReason } from '../src/api.ts';

test('HTTP 404 的正文算"不可用"，并带上 msg', () => {
  const why = unavailableReason({
    httpStatus: 404,
    code: '404',
    data: null,
    msg: 'Not Found',
  });
  assert.ok(why !== null);
  assert.match(why, /HTTP 404/);
  assert.match(why, /Not Found/);
});

test('HTTP 200 但平台 code 非 0 也算"不可用"（静默失败的常见形态）', () => {
  const why = unavailableReason({ httpStatus: 200, code: '911020', data: null, msg: 'File does not exist' });
  assert.ok(why !== null);
  assert.match(why, /911020/);
});

test('code=0 但 data 为 null 算"不可用"（不存在时平台就是这样回的）', () => {
  const why = unavailableReason({ httpStatus: 200, code: '0', data: null, msg: 'success' });
  assert.equal(why, 'data 为空');
});

test('code=0 且有 data 才算拿到内容', () => {
  assert.equal(unavailableReason({ httpStatus: 200, code: '0', data: [{ queueName: 'xahcnormal' }] }), null);
});

test('没有 code 字段但有 data（非平台信封）也算拿到内容，不要误判', () => {
  assert.equal(unavailableReason({ httpStatus: 200, rows: [1, 2, 3] }), null);
});
