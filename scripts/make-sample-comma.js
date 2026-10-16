/**
 * 生成「备注含分隔符」的测试样例
 *
 * 用途：验证工具能否拦住「备注里有英文逗号」这个会导致列错位的坑。
 * 运行：node scripts/make-sample-comma.js
 */

import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

function makeIdCard(provinceCode, birth, seq3) {
  const body = provinceCode + birth + seq3;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(body[i]) * WEIGHTS[i];
  return body + CHECK_CODES[sum % 11];
}

const rows = [
  // 正常，备注无逗号
  ['张三', '20230101', makeIdCard('110101', '20050101', '123'), 8, '2025年迎新志愿服务'],
  // ⚠️ 备注含英文逗号 —— 会被切成多列
  ['李四', '20230102', makeIdCard('130102', '20050315', '234'), 12.5, '迎新,社区清扫'],
  // ⚠️ 备注含英文逗号（多个）
  ['王五', '20230103', makeIdCard('310104', '20040720', '345'), 6, '支教,敬老院,图书馆'],
  // 正常，备注用中文顿号（安全）
  ['赵六', '20230104', makeIdCard('440105', '20050910', '456'), 5, '支教、敬老院'],
  // ⚠️ 备注含换行
  ['钱七', '20230105', makeIdCard('320106', '20050208', '567'), 4, '第一行\n第二行'],
];

const aoa = [
  ['姓名', '学号', '身份证号', '志愿时长', '备注'],
  ...rows,
];

const ws = XLSX.utils.aoa_to_sheet(aoa);
for (let r = 0; r < aoa.length; r++) {
  const ref = XLSX.utils.encode_cell({ r, c: 2 });
  if (ws[ref]) ws[ref].t = 's';
}
ws['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 22 }, { wch: 10 }, { wch: 30 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

const outDir = path.resolve('data');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'sample-comma.xlsx');
XLSX.writeFile(wb, out);
console.log(`已生成：${out}`);
console.log(`共 ${rows.length} 行，其中 3 行备注含英文逗号/换行，用于验证拦截逻辑。`);
