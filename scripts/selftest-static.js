/**
 * 静态站点（纯前端）自检
 *
 * 为什么需要：网站要部署到 GitHub Pages，没有服务端。
 * 所有计算必须在浏览器里完成，所以必须验证：
 *   1. localApi 在「没有 Node / 没有 DOM 的浏览器式环境」里能加载
 *   2. 本地算出的结果和服务端 /api/parse 完全一致（两边共用 pipeline.js）
 *   3. 浏览器端读 xlsx、写 xlsx 都能用
 *   4. 导出的 Excel 里身份证仍是文本（不会被转成科学计数法）
 *
 * 用法：node scripts/selftest-static.js
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import XLSX from 'xlsx';

let pass = 0, fail = 0;
function check(ok, label, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}

const { localApi, exportXlsxBlob } = await import('../src/web/localApi.js');
const { parseTextResult } = await import('../src/core/pipeline.js');

// ============================================================
console.log('=== 1. 依赖浏览器全局变量吗 ===');
{
  // localApi 在模块顶层不应该碰 window / document / FileReader
  const src = fs.readFileSync(path.resolve('src/web/localApi.js'), 'utf8');
  const topLevel = src.split('export ')[0];
  check(!/\bwindow\./.test(topLevel), '模块顶层不访问 window');
  check(!/\bdocument\./.test(topLevel), '模块顶层不访问 document');
  // atob 和 Blob 是 Node 18+ 和所有浏览器都有的
  check(typeof atob === 'function', '运行环境有 atob（base64 解码用）');
  check(typeof Blob === 'function', '运行环境有 Blob（下载用）');
}

// ============================================================
console.log('\n=== 2. 本地实现与服务端结果一致 ===');
{
  const text = [
    '张三 2025213817 110101200501010017 8',
    '李四，2024213884，110101200502020022，8小时',
    '姓名：王五 学号：2025213761 身份证：110101200503030038 时长：8',
    '赵六|2024213879|110101200504040043|8',
    '孙八 2023213829 110101200505050059 12.5小时',
    '合计 5 人',
    '',
    // 超限的人：验证分流/排期也能在本地算
    '周九 110101200506060064 120小时 2025年迎新志愿服务',
  ].join('\n');
  const reason = '暑期迎新志愿服务活动';

  const local = await localApi('/api/parse', { text, reason });
  const server = { ok: true, ...parseTextResult({ text, reason }) };

  check(JSON.stringify(local.records) === JSON.stringify(server.records),
    '记录逐字段一致', `本地 ${local.records.length} 条 / 服务端 ${server.records.length} 条`);
  check(JSON.stringify(local.summary) === JSON.stringify(server.summary), '统计一致');
  check(JSON.stringify(local.skipped) === JSON.stringify(server.skipped), '跳过行一致');
  check(local.records.length === 6, `识别 6 条（实际 ${local.records.length}）`);
  check(local.records.filter((r) => r.usable).length === 6, '全部可用');
  check(local.records.some((r) => r.needsSplit), '识别出需要分批的人（120 小时）');
}

// ============================================================
console.log('\n=== 3. 浏览器端读 xlsx ===');
{
  // 造一个「第一页是封面、第二页才是数据」的表，验证 pickSheet 生效
  const wb = XLSX.utils.book_new();
  const cover = XLSX.utils.aoa_to_sheet([['2026 年志愿服务时长补录表'], ['制表人：某某']]);
  const data = XLSX.utils.aoa_to_sheet([
    ['姓名', '学号', '身份证（记得开隐私）', '志愿时长', '备注'],
    ['张三', '2025213817', '110101200501010017', '8', '暑期迎新志愿服务活动'],
    ['李四', '2024213884', '110101200502020022', '12.5', '社区清扫'],
  ]);
  XLSX.utils.book_append_sheet(wb, cover, '封面');
  XLSX.utils.book_append_sheet(wb, data, '名单');

  const tmp = path.join(os.tmpdir(), `zy-static-${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tmp);

  const bytes = fs.readFileSync(tmp);
  const base64 = Buffer.from(bytes).toString('base64');
  const r = await localApi('/api/upload', { filename: 'x.xlsx', base64, reason: '' });

  check(r.records.length === 2, `读到 2 条（实际 ${r.records.length}）`);
  check(r.sheetName === '名单', `自动跳过封面页，读到「名单」（实际 ${r.sheetName}）`);
  check(r.mapping && r.mapping.idCard === 2, '认出带注释的身份证列');
  check((r.missingColumns || []).length === 0, '没有缺失的必需列');
  check(r.records[0].idCard === '110101200501010017', '身份证保持文本，没有变科学计数法');
  check(r.records.every((x) => x.usable), '两条都可用');

  fs.unlinkSync(tmp);
}

// ============================================================
console.log('\n=== 4. 浏览器端写 xlsx ===');
{
  const records = [
    { name: '张三', idCard: '110101200501010017', hours: 8, remark: '暑期迎新', studentId: '2025213817', usable: true },
    { name: '李四', idCard: '110101200502020022', hours: 12.5, remark: '社区清扫', studentId: '2024213884', usable: true },
  ];
  const blob = exportXlsxBlob(records);
  check(blob instanceof Blob, '返回 Blob（浏览器可直接下载）');
  check(blob.type.includes('spreadsheetml'), 'Blob 的 MIME 类型正确');

  const buf = Buffer.from(await blob.arrayBuffer());
  check(buf.length > 1000, `产出的 xlsx 有内容（${buf.length} 字节）`);

  // 回读验证：身份证必须是文本，且内容一致
  const wb = XLSX.read(buf, { type: 'buffer' });
  check(wb.SheetNames.includes('录入模板'), '有「录入模板」工作表');
  check(wb.SheetNames.includes('核对表'), '有「核对表」工作表');

  const ws = wb.Sheets['录入模板'];
  const cell = ws['B2'];
  check(cell && cell.t === 's', '身份证单元格类型是字符串（防止科学计数法）');
  check(String(cell.v) === '110101200501010017', `身份证内容完整（${cell && cell.v}）`);

  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
  check(aoa[0].join(',') === '姓名,身份证号,志愿时长,备注', '表头正确');
  check(aoa.length === 3, `2 条数据 + 1 行表头（实际 ${aoa.length} 行）`);
}

// ============================================================
console.log('\n=== 5. 排期 / 分批 / 分流也能在本地算 ===');
{
  const text = '周九 110101200506060064 120小时 暑期迎新志愿服务活动';
  const { records } = await localApi('/api/parse', { text, reason: '' });

  const sch = await localApi('/api/schedule', { records, strategy: 'few' });
  check(sch.groups.length === 3, `120 小时分 3 批（实际 ${sch.groups.length}）`);
  check(sch.finishHours === 240, `单项目总等待 240 小时（实际 ${sch.finishHours}）`);

  const mul = await localApi('/api/multi-project', { records, projects: 2 });
  check(mul.neededProjects === 3, `需要 3 个项目当天录完（实际 ${mul.neededProjects}）`);
  check(mul.groups.length >= 1, '给出了分组');
  check(mul.perPerson[0].parts.length === 3, '每人拆成 3 段');
  for (const p of mul.perPerson[0].parts) {
    check(p.hours <= 50, `每段不超过 50 小时（${p.hours}）`);
  }
}

// ============================================================
console.log('\n=== 6. 未知接口要报错而不是静默返回 ===');
{
  let threw = false;
  try { await localApi('/api/nope', {}); } catch { threw = true; }
  check(threw, '未知接口抛错');
}

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
