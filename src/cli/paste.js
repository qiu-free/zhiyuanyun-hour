/**
 * CLI: 生成可直接粘贴到志愿云后台的批量录入文本
 *
 * 这是主路线。
 *
 * 用法：
 *   npm run paste -- --file data/volunteers.xlsx
 *   npm run paste -- --file data/volunteers.xlsx --fix       # 自动把备注里的逗号换掉
 *   npm run paste -- --file data/volunteers.xlsx --clip      # 顺便复制到剪贴板
 *
 * 输出格式（经确认）：
 *   姓名,身份证号,时长,备注
 *   张三,110101200501011239,8,2025年迎新志愿服务
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import 'dotenv/config';
import { readTable } from '../core/excel.js';
import { validateRows } from '../core/validate.js';
import { buildPasteText, summarize, SEP } from '../core/paste.js';
import { parseArgs, ensureOutDir, stamp, c, requireFile, printBanner } from './util.js';

/** 尝试把文本放进系统剪贴板；失败不影响主流程 */
function tryClipboard(text) {
  try {
    if (process.platform === 'win32') {
      // 用 PowerShell 的 Set-Clipboard。stdin 走文件重定向，避免管道受限。
      const tmp = path.join(ensureOutDir(), '.clipboard-tmp.txt');
      fs.writeFileSync(tmp, text, 'utf8');
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Set-Clipboard -Value ([IO.File]::ReadAllText('${tmp.replace(/'/g, "''")}'))`],
        { stdio: 'ignore', timeout: 15000 }
      );
      fs.rmSync(tmp, { force: true });
      return r.status === 0;
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('pbcopy', [], { input: text, timeout: 15000 });
      return r.status === 0;
    }
    const r = spawnSync('xclip', ['-selection', 'clipboard'], { input: text, timeout: 15000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs();
  const file = args.file || args.f;
  const autoFix = !!(args.fix || args['auto-fix']);
  const wantClip = !!(args.clip || args.clipboard);

  printBanner('志愿云 · 生成批量录入文本');

  if (!file) {
    console.log(c.yellow('用法：npm run paste -- --file <表格路径> [--reason 原因] [--fix] [--clip]'));
    console.log('');
    console.log('表格需要包含这些列（中文或英文表头均可）：');
    console.log('  姓名 | 学号 | 身份证号 | 志愿时长 | 备注');
    console.log('');
    console.log('说明：');
    console.log('  「备注」列可省略。省略时用 --reason 指定的值，');
    console.log('  未指定 --reason 则用 .env 的 ZY_DEFAULT_REASON。');
    console.log('');
    console.log('生成的文本格式：');
    console.log(c.dim('  姓名,身份证号,时长,备注'));
    console.log(c.dim('  张三,110101200501011239,8,2025年迎新志愿服务'));
    process.exit(1);
  }

  const table = readTable(requireFile(file), { sheet: args.sheet });
  const result = validateRows(table.rows);

  if (!result.valid.length) {
    console.error(c.red('没有校验通过的数据。请先运行 npm run validate 修正错误。'));
    process.exit(2);
  }

  if (result.invalid.length) {
    console.log(c.yellow(`注意：有 ${result.invalid.length} 行未通过校验，已排除。`));
    for (const r of result.invalid.slice(0, 10)) {
      console.log(c.dim(`  第${r.excelRow}行 ${r.name || '(无姓名)'}：${r.errors.join('；')}`));
    }
    if (result.invalid.length > 10) {
      console.log(c.dim(`  … 还有 ${result.invalid.length - 10} 行`));
    }
    console.log('');
  }

  // 补录原因：命令行 --reason 优先，其次 .env 的 ZY_DEFAULT_REASON。
  // 注意：这里没有内置默认值。两个都没提供时，缺备注的行会被判为「需报备」，
  // 而不是被程序悄悄填一个笼统的说法。
  const reasonFromUser =
    (typeof args.reason === 'string' && args.reason.trim()) ||
    (process.env.ZY_DEFAULT_REASON || '').trim() ||
    '';

  const built = buildPasteText(result.valid, { defaultReason: reasonFromUser, autoFix });

  // ---- 自动修复提示 ----
  if (built.fixed.length) {
    console.log(c.yellow(`已自动修正 ${built.fixed.length} 处备注中的分隔符问题：`));
    for (const f of built.fixed.slice(0, 10)) {
      console.log(`  第${f.excelRow}行 ${f.name}：`);
      console.log(c.dim(`    「${f.from}」`));
      console.log(c.green(`  → 「${f.to}」`));
    }
    if (built.fixed.length > 10) console.log(c.dim(`  … 还有 ${built.fixed.length - 10} 处`));
    console.log('');
  }

  // ---- 缺失信息：需要向发起人报备 ----
  // 这类不是「数据错误」，而是「我们不知道」，不能由程序代填。
  if (built.missing.length) {
    console.log(c.red(c.bold(`🚩 有 ${built.missing.length} 行缺少「补录原因」，需要向发起人报备：`)));
    console.log('');
    console.log(c.dim('  「补录原因」是系统必填项，且会写进志愿者的档案记录。'));
    console.log(c.dim('  程序不代为填写，请先向发起人确认后再补上。'));
    console.log('');
    console.log('  ' + '行号'.padEnd(8) + '姓名'.padEnd(12) + '学号'.padEnd(14) + '时长');
    console.log('  ' + '─'.repeat(46));
    for (const m of built.missing) {
      console.log(
        '  ' +
        String('第' + m.row.excelRow + '行').padEnd(8) +
        String(m.row.name || '(无姓名)').padEnd(12) +
        String(m.row.studentId || '—').padEnd(14) +
        String(m.row.hours ?? '—')
      );
    }
    console.log('');
    console.log(c.bold('  ✅ 请向发起人确认：'));
    console.log('     • 本次补录的原因 / 活动名称是什么？');
    console.log('     • 是否所有人员用同一个原因？还是因人而异？');
    console.log('');
    console.log(c.bold('  ✅ 拿到答复后，二选一：'));
    console.log('     1. 回表格里加一列「备注」，逐人填写，然后重新运行');
    console.log('     2. 若所有人原因相同，直接用参数指定：');
    console.log(c.dim(`        npm run paste -- --file "${file}" --reason "你们确认的原因"`));
    console.log('');
  }

  // ---- 数据错误：需要修正 ----
  if (built.blocked.length) {
    console.log(c.red(c.bold(`❌ 有 ${built.blocked.length} 行数据有问题（会破坏列结构）：`)));
    console.log('');
    for (const b of built.blocked) {
      console.log(`  ${c.yellow(`第${b.row.excelRow}行`)} ${b.row.name || '(无姓名)'}`);
      for (const p of b.problems) {
        console.log(`      ${c.red('•')} ${p.reason}`);
        if (p.fix) console.log(`        ${c.dim('建议：' + p.fix)}`);
      }
    }
    console.log('');
    console.log(c.bold('处理办法（二选一）：'));
    console.log('  1. 回表格里把备注中的英文逗号改成顿号「、」，重新运行');
    console.log('  2. 加 --fix 参数自动替换（会改动备注内容，请自行确认可接受）');
    console.log(c.dim(`      npm run paste -- --file "${file}" --fix`));
    console.log('');
  }

  if (!built.lines.length) {
    console.error(c.red('没有可输出的行。'));
    if (built.missing.length) {
      console.error(c.yellow(`原因：${built.missing.length} 行缺少「补录原因」，请先向发起人确认。`));
    }
    process.exit(built.missing.length ? 4 : 2);
  }

  // ---- 输出文件 ----
  const outDir = ensureOutDir();
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const ts = stamp();
  const txtPath = path.join(outDir, `${base}-${ts}-paste.txt`);
  fs.writeFileSync(txtPath, built.text, 'utf8');

  // 同时存一份带表头的对照表，方便人工核对
  const sum = summarize(built.lines.map((l) => l.row));
  const checkPath = path.join(outDir, `${base}-${ts}-核对表.md`);
  const md = [
    '# 批量录入核对表',
    '',
    `- 源文件：\`${file}\``,
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 人数：**${sum.count}**`,
    `- 合计时长：**${sum.totalHours} 小时**`,
    `- 分隔符：英文逗号 \`${SEP}\``,
    '',
    '## 将粘贴到后台的文本',
    '',
    '```',
    built.text,
    '```',
    '',
    '## 逐人明细（含学号，供学院内部核对）',
    '',
    '| # | 姓名 | 学号 | 身份证号 | 时长 | 备注 |',
    '|---|---|---|---|---|---|',
    ...built.lines.map((l, i) => {
      const r = l.row;
      // 备注：行里有就用行里的，否则用本次确认的原因
      const reason = String(r.remark ?? '').trim() || reasonFromUser;
      return `| ${i + 1} | ${r.name} | ${r.studentId || '—'} | ${r.idCardMasked || r.idCard} | ${r.hours} | ${reason} |`;
    }),
    '',
    '> 此文件含完整身份证号，属敏感数据，用完后请删除。',
  ].join('\n');
  fs.writeFileSync(checkPath, md, 'utf8');

  // ---- 控制台预览 ----
  console.log(c.bold('══ 待粘贴文本预览 ═══════════════════════════'));
  const preview = built.lines.slice(0, 8);
  for (const l of preview) {
    // 身份证打码显示，避免在终端里暴露完整号码
    const parts = l.text.split(SEP);
    const masked = [parts[0], (l.row.idCardMasked || parts[1]), parts[2], parts.slice(3).join(SEP)].join(SEP);
    console.log('  ' + masked);
  }
  if (built.lines.length > 8) {
    console.log(c.dim(`  … 还有 ${built.lines.length - 8} 行`));
  }
  console.log(c.bold('════════════════════════════════════════════'));
  console.log('');
  console.log(`  人数：${c.green(String(sum.count))}    合计时长：${c.green(String(sum.totalHours) + ' 小时')}`);
  console.log('');

  // ---- 剪贴板 ----
  // 安全设计：只要有人没进来（缺信息或有错误），就「不」自动复制。
  // 否则剪贴板里是残缺数据，用户可能粘贴后以为全部录完了。
  // 想处理部分数据的话，手动打开 txt 文件复制即可。
  const incomplete = built.blocked.length + built.missing.length;
  let copied = false;

  if (wantClip && incomplete) {
    console.log(c.yellow('⚠️  有人员未进入输出，为避免你粘贴到残缺数据，本次未复制到剪贴板。'));
    console.log(c.dim('   处理完上面报出的问题再运行；或手动打开下面的 txt 复制。'));
    console.log('');
  } else if (wantClip) {
    copied = tryClipboard(built.text);
    if (copied) {
      console.log(c.green('✅ 已复制到剪贴板，直接到后台粘贴即可。'));
    } else {
      console.log(c.yellow('⚠️  复制到剪贴板失败，请手动打开下面的文件复制。'));
    }
    console.log('');
  }

  console.log(`📄 粘贴文本：${c.bold(txtPath)}`);
  console.log(`📋 核对表　：${c.bold(checkPath)}`);
  console.log('');

  if (!copied) {
    console.log(c.bold('下一步：'));
    console.log(`  1. 用记事本打开 ${c.dim(txtPath)}（或直接在上面复制）`);
    console.log('  2. 全选 → 复制');
    console.log('  3. 粘贴到志愿云后台的批量录入框');
    console.log('  4. 用「核对表」核对人数和合计时长');
    console.log('');
    console.log(c.dim('  提示：以后加 --clip 可直接复制到剪贴板，省去开文件。'));
    console.log('');
  }

  // 有人未进入输出时用非零退出码，避免脚本或批处理把它当成完全成功。
  // 更要紧的是提醒用户：不要粘完就以为录完了。
  if (incomplete) {
    const parts = [];
    if (built.missing.length) parts.push(`${built.missing.length} 人缺「补录原因」（待报备）`);
    if (built.blocked.length) parts.push(`${built.blocked.length} 人数据有问题（待修正）`);
    console.log(
      c.red(
        `⚠️  本次只生成了 ${built.lines.length} 人，另有 ${parts.join('、')}。` +
        `请先处理，否则这些人不会录入。`
      )
    );
    console.log('');
    // 退出码：4 = 有待报备的缺失信息；3 = 有数据错误；两者都有取 4（更需要人工介入）
    process.exit(built.missing.length ? 4 : 3);
  }
}

main().catch((e) => {
  console.error(c.red(`\n出错：${e.message}`));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
