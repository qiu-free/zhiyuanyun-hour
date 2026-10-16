/**
 * CLI: 生成录入排期
 *
 * 用法：
 *   npm run schedule -- --file data/volunteers.xlsx
 *   npm run schedule -- --file data/volunteers.xlsx --strategy few
 */

import fs from 'node:fs';
import path from 'node:path';
import { readTable } from '../core/excel.js';
import { validateRows } from '../core/validate.js';
import { buildSchedule, renderSchedule } from '../core/schedule.js';
import { parseArgs, ensureOutDir, stamp, c, requireFile, printBanner } from './util.js';

async function main() {
  const args = parseArgs();
  const file = args.file || args.f;
  // 默认 few（每批尽量大）：等待耗时最短，详见 core/schedule.js 的说明
  const strategy = args.strategy === 'fast' ? 'fast' : 'few';

  printBanner('志愿云 · 录入排期');

  if (!file) {
    console.log(c.yellow('用法：npm run schedule -- --file <表格路径> [--strategy fast|few]'));
    process.exit(1);
  }

  const table = readTable(requireFile(file), { sheet: args.sheet });
  const result = validateRows(table.rows);

  if (result.valid.length === 0) {
    console.log(c.red('没有校验通过的数据，无法生成排期。请先运行 npm run validate。'));
    process.exit(2);
  }

  if (result.invalid.length) {
    console.log(
      c.yellow(`注意：有 ${result.invalid.length} 行未通过校验，排期只包含通过的 ${result.valid.length} 人。`)
    );
    console.log('');
  }

  const schedule = buildSchedule(result.valid, strategy);
  const md = renderSchedule(schedule);

  const outDir = ensureOutDir();
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const outPath = path.join(outDir, `${base}-${stamp()}-schedule.md`);
  fs.writeFileSync(outPath, md, 'utf8');

  // 控制台展示（截取核心部分）
  console.log(c.bold(`策略：${strategy === 'few' ? '每批尽量大（默认，等待耗时最短）' : '每批 ≤10h（批次多）'}`));
  console.log(`总批次：${c.bold(String(schedule.batches.length))}`);
  console.log('');

  for (const b of schedule.batches) {
    const label = b.earliestHours <= 0 ? '现在' :
      b.earliestHours < 24 ? `${b.earliestHours}h 后` :
      `${Math.floor(b.earliestHours / 24)} 天后`;
    console.log(c.bold(c.blue(`第 ${b.batch} 批（最早 ${label}）— ${b.items.length} 人`)));
    for (const it of b.items) {
      console.log(`    ${it.name.padEnd(10, '　')} ${String(it.hours).padStart(5)}h`);
    }
    console.log('');
  }

  const multi = schedule.perPerson.filter((p) => p.batchCount > 1);
  if (multi.length) {
    console.log(c.yellow(`⚠️  ${multi.length} 人受时间锁限制需要分批：`));
    for (const p of multi.sort((a, b) => b.hours - a.hours)) {
      console.log(`    ${p.name.padEnd(10, '　')} ${p.hours}h → ${p.batchCount} 批`);
    }
    console.log('');
  }

  console.log(`📄 完整排期：${c.bold(outPath)}`);
  console.log('');
}

main().catch((e) => {
  console.error(c.red(`\n出错：${e.message}`));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
