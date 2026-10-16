/**
 * 生成「志愿者荣誉时数导入模板」
 *
 * 这是本工具最稳的一条路线：
 * 系统自带批量导入功能，只要把表格整理成官方模板格式，
 * 就能在后台一次性上传，不需要模拟点击。
 *
 * 官方模板列（经华侨大学团委公开文件确认）：
 *   序号 | 姓名* | 身份证号码* | 荣誉时数值*（单位：小时） | 补录原因*
 * 带 * 为必填。
 *
 * 用法：
 *   npm run template -- --file data/volunteers.xlsx
 *   npm run template -- --file data/volunteers.xlsx --out output/导入表.xlsx
 */

import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { readTable } from '../core/excel.js';
import { validateRows } from '../core/validate.js';
import { parseArgs, ensureOutDir, stamp, c, requireFile, printBanner } from './util.js';

async function main() {
  const args = parseArgs();
  const file = args.file || args.f;

  printBanner('志愿云 · 生成批量导入模板');

  if (!file) {
    console.log(c.yellow('用法：npm run template -- --file <表格路径>'));
    process.exit(1);
  }

  const table = readTable(requireFile(file), { sheet: args.sheet });
  const result = validateRows(table.rows);

  if (!result.valid.length) {
    console.error(c.red('没有校验通过的数据。请先运行 npm run validate 修正错误。'));
    process.exit(2);
  }

  const defaultReason = process.env.ZY_DEFAULT_REASON || '学院统一补录';

  // ---- 构造官方模板 ----
  // 注意：模板要求「荣誉时数值」为纯数字，且不能超过单次上限
  const overLimit = result.valid.filter((r) => r.hours > 50);
  const rows = result.valid.map((r, i) => [
    i + 1,                       // 序号
    r.name,                      // 姓名*
    r.idCard,                    // 身份证号码*（完整号码，导入需要）
    r.hours,                     // 荣誉时数值*（数字）
    r.remark || defaultReason,   // 补录原因*
  ]);

  const header = ['序号', '姓名', '身份证号码', '荣誉时数值', '补录原因'];
  const aoa = [
    ['志愿者荣誉时数导入模板'],
    ['导入说明：带*的单元格必填；身份证号码需完整填写；荣誉时数值请直接填数字（单位：小时）'],
    [],
    header,
    ...rows,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // 身份证列强制文本格式，防止 Excel 转成科学计数法
  for (let r = 0; r < aoa.length; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: 2 });
    if (ws[ref] && typeof ws[ref].v === 'string') ws[ref].t = 's';
  }
  ws['!cols'] = [{ wch: 8 }, { wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 36 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '荣誉时数导入');

  // ---- 另存一份「学院对账表」（含学号，用于内部核对）----
  const auditAoa = [
    ['学院内部对账表（此表不用于导入，仅供核对）'],
    [],
    ['序号', '姓名', '学号', '身份证号', '时长', '备注', '出生日期'],
    ...result.valid.map((r, i) => [
      i + 1, r.name, r.studentId, r.idCard, r.hours, r.remark || defaultReason, r.birth,
    ]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(auditAoa);
  for (let r = 0; r < auditAoa.length; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: 3 });
    if (ws2[ref] && typeof ws2[ref].v === 'string') ws2[ref].t = 's';
  }
  ws2['!cols'] = [{ wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 8 }, { wch: 30 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws2, '学院对账表');

  // ---- 输出 ----
  const outDir = ensureOutDir();
  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(outDir, `导入模板-${stamp()}.xlsx`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  XLSX.writeFile(wb, outPath);

  console.log(`已生成导入模板：${c.bold(outPath)}`);
  console.log('');
  console.log(`  有效数据：${c.green(String(result.valid.length))} 条`);
  console.log(`  合计时长：${result.valid.reduce((s, r) => s + r.hours, 0).toFixed(1)} 小时`);
  console.log('');

  if (overLimit.length) {
    console.log(c.yellow(`⚠️  有 ${overLimit.length} 人的时长超过单次上限 50 小时：`));
    for (const r of overLimit) {
      console.log(`    ${r.name}：${r.hours}h → 需拆成 ${Math.ceil(r.hours / 50)} 次导入`);
    }
    console.log(c.dim('   （系统限制单次最多 50 小时，请分批导入）'));
    console.log('');
  }

  console.log(c.bold('下一步：'));
  console.log('  1. 打开志愿云后台 → 进入对应志愿项目 → 找到「录入时长 / 批量导入」入口');
  console.log('  2. 上传刚生成的 xlsx（注意用「荣誉时数导入」那个工作表）');
  console.log('  3. 确认导入结果，与「学院对账表」核对人数和时长');
  console.log('');
  console.log(c.dim('  说明：本文件含完整身份证号，属于敏感数据，用完后请及时删除。'));
  console.log('');
}

main().catch((e) => {
  console.error(c.red(`\n出错：${e.message}`));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
