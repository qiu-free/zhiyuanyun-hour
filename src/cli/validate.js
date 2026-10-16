/**
 * CLI: 校验表格
 *
 * 用法：
 *   npm run validate -- --file data/volunteers.xlsx
 *   npm run validate -- --file data/volunteers.xlsx --sheet Sheet1
 */

import fs from 'node:fs';
import path from 'node:path';
import { readTable } from '../core/excel.js';
import { validateRows, renderReport } from '../core/validate.js';
import { parseArgs, ensureOutDir, stamp, c, requireFile, printBanner } from './util.js';

async function main() {
  const args = parseArgs();
  const file = args.file || args.f;

  printBanner('志愿云 · 数据校验');

  if (!file) {
    console.log(c.yellow('用法：npm run validate -- --file <表格路径>'));
    console.log('');
    console.log('示例：');
    console.log('  npm run validate -- --file data/volunteers.xlsx');
    console.log('');
    console.log('表格需要包含这些列（中文或英文表头均可）：');
    console.log('  姓名 | 学号 | 身份证号 | 志愿时长 | 备注');
    process.exit(1);
  }

  const abs = requireFile(file);

  let table;
  try {
    table = readTable(abs, { sheet: args.sheet });
  } catch (e) {
    console.error(c.red(`读取表格失败：${e.message}`));
    process.exit(1);
  }

  console.log(`源文件：${c.dim(abs)}`);
  console.log(`工作表：${c.dim(table.sheetName)}`);
  if (table.headerRowDetected !== null && table.headerRowDetected > 0) {
    console.log(
      c.dim(`（已自动跳过前 ${table.headerRowDetected} 行，在第 ${table.headerRow + 1} 行识别到表头）`)
    );
  }
  console.log(`识别到的列：`);
  for (const [field, idx] of Object.entries(table.mapping)) {
    console.log(`  ${c.green('✓')} ${field.padEnd(10)} → ${table.headers[idx]}`);
  }
  if (table.missing?.length) {
    console.log('');
    console.log(c.red(`✗ 缺少必需列：${table.missing.join('、')}`));
    console.log(c.dim(`  实际表头：${table.headers.join(' | ')}`));
    process.exit(1);
  }
  if (table.extra?.length) {
    console.log(c.dim(`  （未识别的列将原样保留：${table.extra.join('、')}）`));
  }
  console.log('');
  console.log(`共读取 ${table.rows.length} 行数据，开始校验…`);
  console.log('');

  const result = validateRows(table.rows);
  const report = renderReport(result, { file: abs, sheet: table.sheetName });

  const outDir = ensureOutDir();
  const ts = stamp();
  const base = path.basename(abs).replace(/\.[^.]+$/, '');
  const reportPath = path.join(outDir, `${base}-${ts}-report.md`);
  fs.writeFileSync(reportPath, report, 'utf8');

  // ---- 控制台摘要 ----
  const { stats } = result;
  console.log(c.bold('── 校验结果 ──────────────────────────────'));
  console.log(`  总行数      ${stats.total}`);
  console.log(`  ${c.green('通过')}        ${c.green(String(stats.validCount))}`);
  console.log(
    `  ${stats.invalidCount ? c.red('有问题') : '有问题'}      ` +
    `${stats.invalidCount ? c.red(String(stats.invalidCount)) : '0'}`
  );
  console.log(`  合计时长    ${stats.totalHours} 小时`);
  console.log(c.bold('──────────────────────────────────────────'));
  console.log('');

  if (result.invalid.length) {
    console.log(c.red(c.bold('❌ 需要修复的行：')));
    console.log('');
    for (const r of result.invalid.slice(0, 30)) {
      console.log(
        `  ${c.yellow(`第${r.excelRow}行`)} ${r.name || '(无姓名)'} ` +
        `${c.dim(r.idCardMasked || '')}`
      );
      for (const e of r.errors) console.log(`      ${c.red('•')} ${e}`);
    }
    if (result.invalid.length > 30) {
      console.log(c.dim(`  … 还有 ${result.invalid.length - 30} 行，详见报告文件`));
    }
    console.log('');
  }

  if (result.warnings?.length) {
    const uniq = [...new Set(result.warnings.map((w) => w.message))];
    console.log(c.yellow('⚠️  提示：'));
    for (const w of uniq.slice(0, 15)) console.log(`  • ${w}`);
    if (uniq.length > 15) console.log(c.dim(`  … 还有 ${uniq.length - 15} 条`));
    console.log('');
  }

  console.log(`📄 完整报告：${c.bold(reportPath)}`);
  console.log('');

  if (stats.invalidCount > 0) {
    console.log(c.red('存在未通过校验的行，请先修正后再进行录入。'));
    process.exit(2);
  }

  console.log(c.green('✅ 全部通过校验。下一步：'));
  console.log(c.dim(`   npm run paste -- --file ${file} --clip`));
  console.log(c.dim('   然后到志愿云后台「批量录入」处粘贴（本工具不会替你提交）'));
  console.log('');
}

main().catch((e) => {
  console.error(c.red(`\n出错：${e.message}`));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
