/**
 * 时间锁与批次拆分逻辑的自检
 * 运行：node scripts/selftest-schedule.js
 */

import { splitBatches, totalElapsedHours, waitHoursFor } from '../src/core/schedule.js';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      期望 ${e}\n      实际 ${a}`}`);
}

console.log('=== 时间锁函数（对照系统规则）===');
const lockCases = [
  [5, 24], [10, 24],
  [10.1, 48], [20, 48],
  [20.1, 72], [30, 72],
  [30.1, 96], [40, 96],
  [40.1, 120], [50, 120],
];
for (const [h, expect] of lockCases) {
  const got = waitHoursFor(h);
  const ok = got === expect;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${h}h -> ${got}h（期望 ${expect}h）`);
}

console.log('\n=== 批次拆分 ===');
check('8h fast -> 1批', splitBatches(8, 'fast').map((b) => b.hours), [8]);
check('25h fast -> 10/10/5', splitBatches(25, 'fast').map((b) => b.hours), [10, 10, 5]);
check('25h few -> 25', splitBatches(25, 'few').map((b) => b.hours), [25]);
check('80h few -> 50/30', splitBatches(80, 'few').map((b) => b.hours), [50, 30]);
check('50h fast -> 5批x10', splitBatches(50, 'fast').map((b) => b.hours), [10, 10, 10, 10, 10]);
check('0h -> 空', splitBatches(0, 'fast'), []);
check('负数 -> 空', splitBatches(-5, 'fast'), []);

console.log('\n=== 批次守恒（拆分后总和必须等于原值）===');
for (const h of [0.5, 1, 7.5, 10, 12.5, 33.3, 50, 50.1, 80, 123.4]) {
  for (const s of ['fast', 'few']) {
    const sum = splitBatches(h, s).reduce((a, b) => a + b.hours, 0);
    const rounded = Math.round(sum * 10) / 10;
    const ok = Math.abs(rounded - h) < 0.05;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${h}h ${s} 拆分合计 ${rounded}h`);
  }
}

console.log('\n=== 策略对比：单批越大，等待耗时越短 ===');
console.log('  总时长 | fast(批数/耗时) | few(批数/耗时) | 更快');
for (const h of [8, 12, 25, 45, 50, 80, 120]) {
  const f = splitBatches(h, 'fast').length;
  const fb = totalElapsedHours(h, 'fast');
  const w = splitBatches(h, 'few').length;
  const wb = totalElapsedHours(h, 'few');
  const win = fb < wb ? 'fast' : wb < fb ? 'few' : '相同';
  console.log(`  ${String(h).padStart(6)}h | ${String(f).padStart(2)}批/${String(fb).padStart(3)}h | ${String(w).padStart(2)}批/${String(wb).padStart(3)}h | ${win}`);
}

console.log('');
if (failures) {
  console.log(`✗ 有 ${failures} 项未通过`);
  process.exit(1);
}
console.log('✓ 全部通过');
