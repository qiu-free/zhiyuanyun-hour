/**
 * CLI: 把任意文本转成志愿云批量录入模板
 *
 * 输入：任意文本（聊天记录、微信复制、手打的名单）
 * 输出：英文逗号分隔的粘贴文本（姓名,身份证号,时长,备注）
 *
 * 用法：
 *   node src/cli/fromtext.js --text "张三 110101200501010017 8"
 *   node src/cli/fromtext.js --file data/名单.txt --clip
 *   type 名单.txt | node src/cli/fromtext.js --stdin
 *   node src/cli/fromtext.js --file 名单.txt --reason "暑期迎新志愿服务活动"
 *
 * 设计原则：
 *   • 完全本地，不登录、不联网、不碰平台
 *   • 抽不准就报出来让人确认，绝不猜
 *   • 缺备注就报备，不代填
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseText, guessGlobalRemark } from '../core/parseText.js';
import { validateIdCard, maskIdCard } from '../core/idcard.js';
import { checkField, SEP } from '../core/paste.js';
import { parseArgs, ensureOutDir, stamp, c, printBanner } from './util.js';

const MAX_HOURS = 50;

/** 读取输入文本：--text / --file / --stdin */
function readInput(args) {
  if (typeof args.text === 'string') return { text: args.text, src: '命令行 --text' };

  if (typeof args.file === 'string') {
    const abs = path.resolve(args.file);
    if (!fs.existsSync(abs)) {
      throw new Error(`找不到文件：${abs}`);
    }
    return { text: fs.readFileSync(abs, 'utf8'), src: abs };
  }

  if (args.stdin || args['-']) {
    try {
      return { text: fs.readFileSync(0, 'utf8'), src: '标准输入' };
    } catch {
      throw new Error('无法读取标准输入');
    }
  }

  return null;
}

/** 尝试放入剪贴板 */
function tryClipboard(text) {
  try {
    if (process.platform === 'win32') {
      const tmp = path.join(ensureOutDir(), '.clip.txt');
      fs.writeFileSync(tmp, text, 'utf8');
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command',
         `Set-Clipboard -Value ([IO.File]::ReadAllText('${tmp.replace(/'/g, "''")}'))`],
        { stdio: 'ignore', timeout: 15000 }
      );
      fs.rmSync(tmp, { force: true });
      return r.status === 0;
    }
    if (process.platform === 'darwin') {
      return spawnSync('pbcopy', [], { input: text, timeout: 15000 }).status === 0;
    }
    return spawnSync('xclip', ['-selection', 'clipboard'], { input: text, timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs();
  printBanner('任意文本 → 志愿云录入模板');

  const input = readInput(args);
  if (!input) {
    console.log(c.yellow('把名单文本给我，我返回可直接粘贴的模板。'));
    console.log('');
    console.log('三种输入方式：');
    console.log(c.dim('  1. 直接给文本'));
    console.log(c.dim('     node src/cli/fromtext.js --text "张三 110101200501010017 8"'));
    console.log(c.dim('  2. 给一个 txt 文件'));
    console.log(c.dim('     node src/cli/fromtext.js --file data/名单.txt --clip'));
    console.log(c.dim('  3. 从管道读'));
    console.log(c.dim('     type 名单.txt | node src/cli/fromtext.js --stdin'));
    console.log('');
    console.log('可选参数：');
    console.log(c.dim('  --reason "活动名称"   统一补录原因（缺备注时必填）'));
    console.log(c.dim('  --clip                结果直接进剪贴板'));
    console.log('');
    console.log('输入文本可以是任意格式，例如：');
    console.log(c.dim('     张三 2025213817 110101200501010017 8'));
    console.log(c.dim('     李四，2024213884，110101200502020022，8小时'));
    console.log(c.dim('     姓名：王五 学号：2025213761 身份证：110101200501010017 时长：8'));
    process.exit(1);
  }

  console.log(`输入来源：${c.dim(input.src)}`);
  console.log('');

  // ---------- 解析 ----------
  const parsed = parseText(input.text);
  const globalRemark = guessGlobalRemark(input.text);

  if (!parsed.records.length) {
    console.error(c.red('没能从文本里提取到任何记录。'));
    console.log('');
    console.log(c.dim('已跳过的行：'));
    for (const s of parsed.skipped.slice(0, 10)) {
      console.log(c.dim(`  第${s.lineNo}行：${s.line}   （${s.reason}）`));
    }
    console.log('');
    console.log('请确认文本里包含身份证号（18位或15位）。');
    process.exit(2);
  }

  console.log(`识别到 ${c.bold(String(parsed.records.length))} 条记录，开始检查…`);
  console.log('');

  // 自动拆分提示：文本没有换行时程序替用户拆了，必须让他知道并核对
  if (parsed.splitLines?.length) {
    const people = parsed.splitLines.reduce((s, x) => s + x.count, 0);
    console.log(c.yellow(
      `✂️  有 ${parsed.splitLines.length} 行没有换行，已自动拆成 ${people} 人：`
    ));
    for (const s of parsed.splitLines) {
      console.log(c.dim(`     第 ${s.lineNo} 行 → ${s.count} 人`));
    }
    console.log(c.yellow('    请核对下表人名与时长是否对应正确。'));
    console.log('');
  }
  for (const w of parsed.warnings || []) {
    console.log(c.dim(`   ⚠ ${w}`));
  }
  if (parsed.warnings?.length) console.log('');

  // ---------- 逐条检查 ----------
  // 原因优先级：--reason > 文本里的「补录原因：」 > 各行的「备注：」> 空（判缺失）
  const reasonFromUser =
    (typeof args.reason === 'string' && args.reason.trim()) ||
    globalRemark ||
    '';

  const good = [];       // 可用
  const needsInfo = [];  // 缺信息，需报备
  const bad = [];        // 数据有错

  for (const rec of parsed.records) {
    const problems = [];

    // 姓名
    if (!rec.name) {
      problems.push({ field: '姓名', reason: '未识别到姓名', fatal: true });
    }

    // 身份证
    if (rec.idCardMasked) {
      problems.push({ field: '身份证号', reason: '号码被打码，需要真实号码', fatal: true });
    } else if (!rec.idCard) {
      problems.push({ field: '身份证号', reason: '未找到身份证号', fatal: true });
    } else {
      const v = validateIdCard(rec.idCard);
      if (!v.ok) problems.push({ field: '身份证号', reason: v.reason, fatal: true });
      else if (v.level === 'warn') problems.push({ field: '身份证号', reason: v.reason, fatal: false });
    }

    // 时长
    if (rec.hours === null || rec.hours === undefined) {
      problems.push({ field: '时长', reason: '未识别到时长', fatal: true });
    } else if (!(rec.hours > 0) || rec.hours > MAX_HOURS) {
      problems.push({
        field: '时长',
        reason: `${rec.hours} 超出范围（须 0~${MAX_HOURS}）`,
        fatal: true,
      });
    }

    // 备注
    const remark = String(rec.remark || '').trim() || reasonFromUser;
    if (!remark) {
      problems.push({
        field: '备注',
        reason: '缺少「补录原因」（系统必填）',
        missing: true,
      });
    } else {
      const chk = checkField(remark, '备注');
      if (!chk.ok) problems.push({ field: '备注', reason: chk.reason, fix: chk.fix, fatal: true });
    }

    const fatal = problems.filter((p) => p.fatal);
    const missing = problems.filter((p) => p.missing);
    const soft = problems.filter((p) => !p.fatal && !p.missing && !p.missing);

    if (fatal.length) {
      bad.push({ rec, problems: fatal });
    } else if (missing.length) {
      needsInfo.push({ rec, problems: missing });
    } else {
      good.push({ rec, remark, warnings: soft });
    }
  }

  // ---------- 数据错误 ----------
  if (bad.length) {
    console.log(c.red(c.bold(`❌ ${bad.length} 条数据有问题：`)));
    console.log('');
    for (const b of bad) {
      console.log(`  ${c.yellow(`第${b.rec.lineNo}行`)} ${b.rec.name || '(无姓名)'}`);
      console.log(c.dim(`     原文：${b.rec.raw}`));
      for (const p of b.problems) {
        console.log(`     ${c.red('•')} ${p.field}：${p.reason}`);
        if (p.fix) console.log(c.dim(`       建议：${p.fix}`));
      }
    }
    console.log('');
  }

  // ---------- 缺信息，需报备 ----------
  if (needsInfo.length) {
    console.log(c.red(c.bold(`🚩 ${needsInfo.length} 条缺少「补录原因」，需要向发起人报备：`)));
    console.log('');
    console.log(c.dim('  「补录原因」是系统必填项，会写进志愿者档案。程序不代为填写。'));
    console.log('');
    console.log('  ' + '行号'.padEnd(8) + '姓名'.padEnd(12) + '时长');
    console.log('  ' + '─'.repeat(34));
    for (const n of needsInfo) {
      console.log(
        '  ' +
        String('第' + n.rec.lineNo + '行').padEnd(8) +
        String(n.rec.name || '(无姓名)').padEnd(12) +
        String(n.rec.hours ?? '—')
      );
    }
    console.log('');
    console.log(c.bold('  ✅ 请向发起人确认后，二选一：'));
    console.log('     1. 在文本里加一行「补录原因：xxx」，或给某些行写「备注：xxx」');
    console.log('     2. 所有人原因相同时，加参数：');
    console.log(c.dim('        --reason "你们确认的原因"'));
    console.log('');
  }

  if (!good.length) {
    console.error(c.red('没有可输出的记录。'));
    process.exit(bad.length ? 2 : (needsInfo.length ? 4 : 2));
  }

  // ---------- 生成模板 ----------
  const lines = [];
  for (const g of good) {
    const r = g.rec;
    lines.push([r.name, r.idCard, String(r.hours), g.remark].join(SEP));
  }
  const text = lines.join('\n');

  const outDir = ensureOutDir();
  const ts = stamp();
  const base = input.src === '标准输入' || input.src.startsWith('命令行')
    ? 'fromtext'
    : path.basename(input.src).replace(/\.[^.]+$/, '');
  const txtPath = path.join(outDir, `${base}-${ts}-模板.txt`);
  fs.writeFileSync(txtPath, text, 'utf8');

  // ---------- 核对表 ----------
  const checkPath = path.join(outDir, `${base}-${ts}-核对表.md`);
  const totalHours = good.reduce((s, g) => s + g.rec.hours, 0);
  const md = [
    '# 志愿云录入模板（由文本生成）',
    '',
    `- 输入来源：\`${input.src}\``,
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 识别记录：${parsed.records.length} 条`,
    `- 可用记录：**${good.length}** 条`,
    `- 合计时长：**${Math.round(totalHours * 10) / 10} 小时**`,
    `- 分隔符：英文逗号 \`,\``,
    '',
    '## 可直接粘贴到后台的文本',
    '',
    '```',
    text,
    '```',
    '',
    '## 逐条明细（用于核对）',
    '',
    '| # | 姓名 | 身份证号 | 时长 | 备注 | 原行号 |',
    '|---|---|---|---|---|---|',
    ...good.map((g, i) =>
      `| ${i + 1} | ${g.rec.name} | ${maskIdCard(g.rec.idCard)} | ${g.rec.hours} | ${g.remark} | ${g.rec.lineNo} |`
    ),
  ];

  if (parsed.skipped.length) {
    md.push('', '## 已跳过的行（未参与生成）', '');
    for (const s of parsed.skipped) {
      md.push(`- 第${s.lineNo}行：\`${s.line}\` — ${s.reason}`);
    }
  }
  if (bad.length || needsInfo.length) {
    md.push('', '## 未能生成的行', '');
    for (const b of bad) {
      md.push(`- 第${b.rec.lineNo}行 \`${b.rec.raw}\` — ${b.problems.map((p) => p.field + ':' + p.reason).join('；')}`);
    }
    for (const n of needsInfo) {
      md.push(`- 第${n.rec.lineNo}行 \`${n.rec.raw}\` — 缺补录原因`);
    }
  }
  md.push('', '> 此文件含身份证号（核对表中已打码），属敏感数据，用完请删除。');

  fs.writeFileSync(checkPath, md.join('\n'), 'utf8');

  // ---------- 输出 ----------
  console.log(c.bold('══ 模板预览 ═══════════════════════════════'));
  for (const g of good.slice(0, 8)) {
    const r = g.rec;
    console.log('  ' + [r.name, maskIdCard(r.idCard), r.hours, g.remark].join(SEP));
  }
  if (good.length > 8) console.log(c.dim(`  … 还有 ${good.length - 8} 条`));
  console.log(c.bold('══════════════════════════════════════════'));
  console.log('');
  console.log(`  可用：${c.green(String(good.length))} 条    合计：${c.green(String(Math.round(totalHours * 10) / 10) + ' 小时')}`);
  console.log('');

  // ---------- 剪贴板（有未完成项时不复制）----------
  const incomplete = bad.length + needsInfo.length;
  let copied = false;
  if (args.clip && incomplete) {
    console.log(c.yellow('⚠️  有记录未生成，为避免你粘贴到残缺数据，本次未复制到剪贴板。'));
    console.log('');
  } else if (args.clip) {
    copied = tryClipboard(text);
    console.log(copied
      ? c.green('✅ 已复制到剪贴板，直接到后台粘贴即可。')
      : c.yellow('⚠️  复制剪贴板失败，请手动打开下面的文件。'));
    console.log('');
  }

  console.log(`📄 模板　：${c.bold(txtPath)}`);
  console.log(`📋 核对表：${c.bold(checkPath)}`);
  console.log('');

  if (incomplete) {
    console.log(c.red(
      `⚠️  共 ${parsed.records.length} 条，只生成了 ${good.length} 条；` +
      `另有 ${bad.length ? bad.length + ' 条数据有误' : ''}` +
      `${bad.length && needsInfo.length ? '、' : ''}` +
      `${needsInfo.length ? needsInfo.length + ' 条缺补录原因（待报备）' : ''}。`
    ));
    console.log('');
    process.exit(bad.length ? 2 : 4);
  }
}

main().catch((e) => {
  console.error(c.red(`\n出错：${e.message}`));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
