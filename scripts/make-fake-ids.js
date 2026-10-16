/**
 * 生成合法但虚构的示例身份证号
 *
 * 用途：界面示例、文档、测试数据。这些号码用校验算法反推末位，
 * 格式完全合法（能通过工具的校验），但**不对应任何真实公民**。
 *
 * 用法：node scripts/make-fake-ids.js
 */

import { validateIdCard } from '../src/core/idcard.js';

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/** 用前 17 位算出正确的校验位 */
function complete(body17) {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(body17[i]) * WEIGHTS[i];
  return body17 + CHECK[sum % 11];
}

// 用「示例专用」的行政区划与日期，且刻意避开真实组合
// 110101 = 北京东城，是公开的行政区划码；日期用 2005 年，
// 姓名为「张三/李四/王五」这类虚构占位名。
const bodies = [
  '110101' + '20050101' + '001',   // 张三
  '110101' + '20050202' + '002',   // 李四
  '110101' + '20050303' + '003',   // 王五
  '110101' + '20050404' + '004',   // 赵六
  '110101' + '20050505' + '005',   // 钱七
];

console.log('生成的虚构示例号码（全部格式合法）：\n');
for (const b of bodies) {
  const id = complete(b);
  const v = validateIdCard(id);
  console.log(`  ${id}   ${v.ok ? '✓ 合法' : '✗ ' + v.reason}   出生 ${v.info?.birth.year}-${String(v.info?.birth.month).padStart(2,'0')}-${String(v.info?.birth.day).padStart(2,'0')}`);
}
