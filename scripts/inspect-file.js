/**
 * 表格结构探查（用于人工确认表头识别是否正确）
 *
 * 安全：身份证号一律打码后输出，避免敏感信息落到终端/日志。
 *
 * 用法：node scripts/inspect-file.js "<文件路径>"
 */

import XLSX from 'xlsx';
import path from 'node:path';
import { normalizeIdCard } from '../src/core/idcard.js';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/inspect-file.js "<文件路径>"');
  process.exit(1);
}

const abs = path.resolve(file);
const wb = XLSX.readFile(abs, { cellText: true, cellDates: false, raw: false });

console.log(`文件：${abs}`);
console.log(`工作表数量：${wb.SheetNames.length}`);
console.log(`工作表列表：${wb.SheetNames.map((s) => `「${s}」`).join('、')}`);
console.log('');

/** 看起来像身份证号就打个码 */
function maskIfId(v) {
  const s = String(v ?? '');
  if (/^\d{17}[\dXx]$/.test(s) || /^\d{15}$/.test(s)) {
    return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);
  }
  if (/\d{10,}/.test(s)) {
    return s.replace(/(\d{4})\d{6,}(\d{4})/, '$1******$2');
  }
  return s;
}

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
  console.log('═'.repeat(70));
  console.log(`工作表「${name}」  共 ${matrix.length} 行`);
  if (ws['!ref']) console.log(`数据范围：${ws['!ref']}`);
  if (ws['!merges']?.length) console.log(`合并单元格：${ws['!merges'].length} 处`);
  console.log('═'.repeat(70));

  const show = Math.min(matrix.length, 12);
  for (let i = 0; i < show; i++) {
    const cells = (matrix[i] || []).map((c) => maskIfId(String(c ?? '').trim()));
    console.log(`  [行${i + 1}] (${cells.length}列) ${JSON.stringify(cells)}`);
  }
  if (matrix.length > show) {
    console.log(`  … 还有 ${matrix.length - show} 行（下面只显示最后 3 行）`);
    for (let i = Math.max(show, matrix.length - 3); i < matrix.length; i++) {
      const cells = (matrix[i] || []).map((c) => maskIfId(String(c ?? '').trim()));
      console.log(`  [行${i + 1}] (${cells.length}列) ${JSON.stringify(cells)}`);
    }
  }
  console.log('');
}
