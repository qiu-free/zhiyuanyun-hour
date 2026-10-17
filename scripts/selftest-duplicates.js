/**
 * 重复检测自检
 *
 * 为什么单独一个文件：这是最容易造成「静默录错」的一类问题。
 * 同一个身份证号在一份名单里出现两次，后台不会报错，会照单全收，
 * 那个人的时长就凭空翻倍了 —— 而且录进去之后改起来很麻烦。
 *
 * 覆盖两种入口：
 *   1. 文本 → 记录（粘贴名单）
 *   2. 表格 → 记录（上传 Excel）
 * 以及两种重复：
 *   A. 同一身份证号出现多次（不管姓名写没写对）
 *   B. 姓名+证号+时长+备注完全相同
 *
 * 用法：node scripts/selftest-duplicates.js
 */

import XLSX from 'xlsx';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parseTextResult, tableToRecords, summarize } from '../src/core/pipeline.js';
import { readTableFromBuffer } from '../src/core/excelBuffer.js';

let pass = 0, fail = 0;
function check(ok, label, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}

const ID1 = '110101200501010017';
const ID2 = '110101200502020022';
const ID3 = '110101200503030038';
const ID4 = '110101200504040043';

// ============================================================
console.log('=== 1. 文本里同一个人出现两次 ===');
{
  const r = parseTextResult({
    text: [
      `张三 ${ID1} 8 暑期迎新`,
      `李四 ${ID2} 12.5 社区清扫`,
      `张三 ${ID1} 8 暑期迎新`,     // 完全重复
    ].join('\n'),
    reason: '',
  });

  check(r.records.length === 3, `识别 3 条（实际 ${r.records.length}）`);
  check(r.duplicates.length === 1, `报出 1 条重复（实际 ${r.duplicates.length}）`);
  check(r.summary.usableCount === 2, `可用只剩 2 条（实际 ${r.summary.usableCount}）`);

  const dup = r.records[2];
  check(dup.status === 'error', '重复那行状态是 error');
  check(dup.usable === false, '重复那行不可用（不会进粘贴文本）');
  check(dup.duplicateOf === 1, `指明与第 1 行重复（实际 ${dup.duplicateOf}）`);
  check(/重复录入会让时长翻倍/.test(dup.problems.map((p) => p.message).join('')),
    '提示里说明了后果（时长翻倍）');

  // 第一次出现的那份必须保留可用，否则用户不知道留哪条
  check(r.records[0].usable === true, '第一次出现的保留可用');
  check(r.records[0].duplicateOf === undefined, '第一次出现的不带重复标记');

  // 总时长不能把重复的算进去
  check(r.summary.totalHours === 20.5, `合计时长不含重复项（8+12.5=20.5，实际 ${r.summary.totalHours}）`);
}

// ============================================================
console.log('\n=== 2. 同一人不同时长（也不该重复录）===');
{
  const r = parseTextResult({
    text: [
      `张三 ${ID1} 8 暑期迎新`,
      `张三 ${ID1} 6 另一个活动`,
    ].join('\n'),
    reason: '',
  });
  check(r.duplicates.length === 1, '报出重复');
  check(r.summary.usableCount === 1, `可用 1 条（实际 ${r.summary.usableCount}）`);
  check(r.summary.totalHours === 8, `合计只算第一次的 8 小时（实际 ${r.summary.totalHours}）`);
}

// ============================================================
console.log('\n=== 3. 姓名写错但证号相同（仍算重复）===');
{
  // 现实里常有：同一个人两行，其中一行姓名打错别字。
  // 靠姓名查不出来，必须靠证号。
  const r = parseTextResult({
    text: [
      `张三 ${ID1} 8 暑期迎新`,
      `张叁 ${ID1} 8 暑期迎新`,
    ].join('\n'),
    reason: '',
  });
  check(r.duplicates.length === 1, '姓名不同、证号相同 → 仍判为重复');
  check(r.duplicates[0].kind === 'idCard', '判定依据是身份证号');
}

// ============================================================
console.log('\n=== 4. 同名但不同人（不该误判）===');
{
  const r = parseTextResult({
    text: [
      `王伟 ${ID1} 8 暑期迎新`,
      `王伟 ${ID2} 10 社区清扫`,
    ].join('\n'),
    reason: '',
  });
  check(r.duplicates.length === 0, '不判为重复（是两个人）');
  check(r.summary.usableCount === 2, '两条都可用');
  check(r.sameNameWarnings.length === 1, '但给出同名提醒');
  check(r.sameNameWarnings[0].name === '王伟', '提醒里点名了');
  check(r.sameNameWarnings[0].count === 2, '说明有 2 个不同证号');
  // 同名只是提醒，不能拦
  check(r.records.every((x) => x.usable), '同名不拦截，仍可导出');
  check(r.records.every((x) => x.status === 'warn' || x.status === 'ok'),
    '状态是 warn/ok，不是 error');
}

// ============================================================
console.log('\n=== 5. 同一个人重复两次（多次重复）===');
{
  // 注意：姓名必须是 2~4 个汉字。单字名（如「甲」）会被解析器判为
  // 「姓名为空」——这是刻意的：单字中文更像噪声而不是人名。
  const r = parseTextResult({
    text: [
      `测试甲 ${ID1} 8 暑期迎新`,
      `测试甲 ${ID1} 8 暑期迎新`,
      `测试甲 ${ID1} 8 暑期迎新`,
    ].join('\n'),
    reason: '',
  });
  check(r.duplicates.length === 2, `3 行同样的只留 1 行，报 2 条重复（实际 ${r.duplicates.length}）`);
  check(r.summary.usableCount === 1, `可用 1 条（实际 ${r.summary.usableCount}）`);
  check(r.summary.totalHours === 8, `合计 8 小时（实际 ${r.summary.totalHours}）`);
}

// ============================================================
console.log('\n=== 6. 不重复的名单不该被误伤 ===');
{
  const r = parseTextResult({
    text: [
      `测试甲 ${ID1} 8 暑期迎新`,
      `测试乙 ${ID2} 8 社区清扫`,
      `测试丙 ${ID3} 8 支教活动`,
      `测试丁 ${ID4} 8 图书馆服务`,
    ].join('\n'),
    reason: '',
  });
  check(r.duplicates.length === 0, '没有重复');
  check(r.sameNameWarnings.length === 0, '没有重名');
  check(r.summary.usableCount === 4, `4 条全部可用（实际 ${r.summary.usableCount}）`);
  check(r.summary.totalHours === 32, `合计 32 小时（实际 ${r.summary.totalHours}）`);
  check(r.records.every((x) => x.status === 'ok'), '全部 ok');
}

// ============================================================
console.log('\n=== 7. 打码的证号不参与重复判定 ===');
{
  // 打码的证号（含 *）无法唯一标识一个人，拿它判重会误伤。
  const r = parseTextResult({
    text: [
      `测试甲 110101********0017 8 x`,
      `测试乙 110101********0017 8 y`,
    ].join('\n'),
    reason: '',
  });
  check(!r.duplicates.some((d) => /\*/.test(d.idCard || '')), '打码的证号不参与重复判定');
}

// ============================================================
console.log('\n=== 8. Excel 里同一个人出现两次 ===');
{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['姓名', '身份证号', '志愿时长', '备注'],
    ['测试甲', ID1, '8', '暑期迎新'],
    ['测试乙', ID2, '12.5', '社区清扫'],
    ['测试甲', ID1, '8', '暑期迎新'],   // 表格里重复
  ]);
  XLSX.utils.book_append_sheet(wb, ws, '名单');

  const tmp = path.join(os.tmpdir(), `zy-dup-${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tmp);
  const table = readTableFromBuffer(fs.readFileSync(tmp), {});
  fs.unlinkSync(tmp);

  const r = tableToRecords({ table, reason: '' });
  check(r.records.length === 3, `读到 3 条（实际 ${r.records.length}）`);
  check(r.duplicates.length === 1, `报出 1 条重复（实际 ${r.duplicates.length}）`);
  check(r.summary.usableCount === 2, `可用 2 条（实际 ${r.summary.usableCount}）`);
  check(r.summary.totalHours === 20.5, `合计 20.5 小时（实际 ${r.summary.totalHours}）`);
  // 行号要是 Excel 的真实行号，用户才能回去删
  check(r.duplicates[0].lineNo === 4, `重复行指向 Excel 第 4 行（实际 ${r.duplicates[0].lineNo}）`);
  check(r.duplicates[0].firstLineNo === 2, `原始行指向第 2 行（实际 ${r.duplicates[0].firstLineNo}）`);
}

// ============================================================
console.log('\n=== 9. 文本入口和表格入口行为一致 ===');
{
  // 同样的数据，一个走文本、一个走表格，判重结果必须一致。
  // 否则用户换个上传方式就漏掉重复了。
  const textRes = parseTextResult({
    text: [`测试甲 ${ID1} 8 暑期迎新`, `测试甲 ${ID1} 8 暑期迎新`].join('\n'),
    reason: '',
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['姓名', '身份证号', '志愿时长', '备注'],
    ['测试甲', ID1, '8', '暑期迎新'],
    ['测试甲', ID1, '8', '暑期迎新'],
  ]), 'S');
  const tmp = path.join(os.tmpdir(), `zy-dup2-${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tmp);
  const tableRes = tableToRecords({
    table: readTableFromBuffer(fs.readFileSync(tmp), {}),
    reason: '',
  });
  fs.unlinkSync(tmp);

  check(textRes.duplicates.length === tableRes.duplicates.length,
    `文本与表格报的重复数一致（${textRes.duplicates.length} / ${tableRes.duplicates.length}）`);
  check(textRes.summary.usableCount === tableRes.summary.usableCount,
    `可用条数一致（${textRes.summary.usableCount} / ${tableRes.summary.usableCount}）`);
}

// ============================================================
console.log('\n=== 10. 汇总里的 lockNote 等字段没被破坏 ===');
{
  const r = parseTextResult({
    text: `测试甲 ${ID1} 120 暑期迎新`,
    reason: '',
  });
  check(r.summary && typeof r.summary.lockNote === 'string', 'summary 结构完整');
  check(typeof r.summary.oneShotCount === 'number', 'oneShotCount 存在');
  check(summarize(r.records).totalHours === r.summary.totalHours, 'summarize 可直接重算');
  check(r.summary.needsSplitCount === 1, '120 小时被识别为需分批');
}

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
