/**
 * Excel 读取自检
 *
 * 背景：这里曾经漏掉一个自检，导致一个真实 bug 溜到了用户手上 ——
 *   用户的表头是「身份证（记得开隐私）」，带了个括号说明。
 *   原来的列识别用「精确相等」，于是整列认不出来，
    *   界面上就成了「有身份证号但无法识别」。
 *
 * 教训：表头是人写的，会带各种注释。识别必须容忍这些写法。
 *
 * 用法：node scripts/selftest-excel.js
 */

import XLSX from 'xlsx';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectColumns, detectHeaderRow, readTable } from '../src/core/excel.js';

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`); }
}

console.log('=== 1. 带注释的表头必须认出来（真实 bug 回归）===');
{
  // 用户真实文件的表头
  const d = detectColumns(['姓名', '学号', '身份证（记得开隐私）', '志愿时长']);
  check(d.mapping.idCard === 2, `「身份证（记得开隐私）」→ 身份证列（实际 ${d.mapping.idCard}）`);
  check(d.mapping.name === 0, '「姓名」→ 姓名列');
  check(d.mapping.hours === 3, '「志愿时长」→ 时长列');
  check(d.missing.length === 0, '没有缺失的必需列');

  // 全角 / 半角括号都要认
  const d2 = detectColumns(['姓名', '身份证号码(18位)', '志愿时长（小时）']);
  check(d2.mapping.idCard === 1, '半角括号「身份证号码(18位)」');
  check(d2.mapping.hours === 2, '全角括号「志愿时长（小时）」');

  const d3 = detectColumns(['姓名（必填）', '身份证', '时长（小时）', '备注（可空）']);
  check(d3.mapping.name === 0, '「姓名（必填）」');
  check(d3.mapping.hours === 2, '「时长（小时）」');
  check(d3.mapping.remark === 3, '「备注（可空）」');
}

console.log('\n=== 2. 常见表头写法 ===');
{
  const cases = [
    [['姓名', '身份证号', '志愿时长'], '标准写法'],
    [['志愿者姓名', '公民身份号码', '荣誉时数值'], '志愿云导出风格'],
    [['学生姓名', '证件号码', '服务时长'], '学校表格风格'],
    [['name', 'id_card', 'hours'], '英文字段'],
    [['姓名', '学号', '身份证号', '时长', '备注'], '含学号与备注'],
    [['序号', '姓名', '学号', '身份证号', '志愿时长', '备注'], '含序号'],
    [['姓名', '证件号', '服务时间', '说明'], '别名写法'],
  ];
  for (const [headers, label] of cases) {
    const d = detectColumns(headers);
    check(d.missing.length === 0, `${label}：${headers.join(' | ')}`,
      d.missing.length ? `缺 ${d.missing.join(',')}` : '');
  }
}

console.log('\n=== 3. 一个字段只能占一列（不能重复指派）===');
{
  const d = detectColumns(['姓名', '身份证号', '时长', '身份证签发机关']);
  check(d.mapping.idCard === 1, '身份证列取得第一个匹配');
  check(d.mapping.hours === 2, '时长列正确');
  // 第 3 列不该被任何字段占用
  const usedIdx = Object.values(d.mapping);
  check(!usedIdx.includes(3), '「身份证签发机关」没被当成身份证列');
  check(d.extra.includes('身份证签发机关'), '它被列入「未识别列」');
}

console.log('\n=== 4. 别名长的优先（避免「号」抢先）===');
{
  const d = detectColumns(['姓名', '学号', '身份证号']);
  check(d.mapping.studentId === 1, '「学号」→ 学号列（没被身份证抢走）');
  check(d.mapping.idCard === 2, '「身份证号」→ 身份证列');
}

console.log('\n=== 5. 缺少必需列时必须报出来 ===');
{
  const d = detectColumns(['姓名', '学号', '时长']);
  check(d.missing.includes('idCard'), '缺身份证 → 记入 missing');
  check(!d.missing.includes('name'), '姓名不缺，不误报');

  const d2 = detectColumns(['序号', '备注']);
  check(d2.missing.length === 3, `三个必需列全缺（实际 ${d2.missing.join(',')}）`);
}

console.log('\n=== 6. 表头行探测（前面有标题/空行）===');
{
  const matrix = [
    ['2026 年秋季志愿服务时长补录表'],
    [],
    ['姓名', '学号', '身份证（记得开隐私）', '志愿时长'],
    ['张三', 2025000001, '110101200501010017', 8],
  ];
  const h = detectHeaderRow(matrix);
  check(h.index === 2, `表头在第 3 行（实际第 ${h.index + 1} 行）`);
  check(h.headers.includes('姓名'), '表头内容正确');
}

console.log('\n=== 7. 科学计数法必须被识别为「精度已丢失」===');
{
  // Excel 把 18 位身份证当数字时，会变成 1.1010120050101e+17
  const tmp = path.join(os.tmpdir(), `zy-test-${Date.now()}.xlsx`);
  const ws = XLSX.utils.aoa_to_sheet([
    ['姓名', '身份证号', '志愿时长'],
    ['张三', 1.1010120050101e17, 8],
  ]);
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, ws, 'Sheet1');
  XLSX.writeFile(wb2, tmp);

  const buf = fs.readFileSync(tmp);
  const t = readTable(tmp);
  const rec = t.rows[0];
  check(rec.idCardIssue, '标记了科学计数法问题', `实际: ${rec.idCardIssue}`);
  check(/科学计数法|精度/.test(rec.idCardIssue || ''), '提示里说明精度丢失');
  fs.unlinkSync(tmp);
}

console.log('\n=== 8. 真实 xlsx 往返（含带注释表头）===');
{
  const tmp = path.join(os.tmpdir(), `zy-test2-${Date.now()}.xlsx`);
  const ws = XLSX.utils.aoa_to_sheet([
    ['姓名', '学号', '身份证（记得开隐私）', '志愿时长'],
    ['测试甲', 2025000001, '110101200501010017', 8],
    ['测试乙', 2025000002, '110101200502020022', 12],
  ]);
  // 身份证列强制成文本，模拟"正确导出"的表格
  for (const r of [1, 2]) {
    const ref = XLSX.utils.encode_cell({ r, c: 2 });
    if (ws[ref]) { ws[ref].t = 's'; ws[ref].v = String(ws[ref].v); }
  }
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, ws, '名单');
  XLSX.writeFile(wb2, tmp);

  const t = readTable(tmp);
  check(t.rows.length === 2, `读到 2 行（实际 ${t.rows.length}）`);
  check(t.missing.length === 0, '列全认出来');
  check(t.rows[0].idCard === '110101200501010017', `身份证完整读出（${t.rows[0].idCard}）`);
  check(String(t.rows[0].hoursRaw) === '8', `时长读出（${t.rows[0].hoursRaw}）`);
  check(t.rows[0].name === '测试甲', '姓名读出');
  check(t.sheetName === '名单', '报告读的是哪个工作表');
  check(Array.isArray(t.sheetNames) && t.sheetNames.length === 1,
    '报告全部工作表名（api.js 依赖这个字段）');
  fs.unlinkSync(tmp);
}

console.log('\n=== 9. 多工作表：选有数据的那个 ===');
{
  const tmp = path.join(os.tmpdir(), `zy-test3-${Date.now()}.xlsx`);
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([[]]), '空的1');
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([
    ['姓名', '身份证号', '志愿时长'],
    ['测试丙', '110101200503030038', 8],
  ]), '名单');
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([[]]), '空的2');
  XLSX.writeFile(wb2, tmp);

  const t = readTable(tmp);
  check(t.sheetName === '名单', `选中「名单」工作表（实际 ${t.sheetName}）`);
  check(t.rows.length === 1, '读到 1 行');
  check(t.sheetNames.length === 3, '报告了全部工作表名');
  fs.unlinkSync(tmp);
}

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
