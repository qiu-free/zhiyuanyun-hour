/**
 * 往返一致性自检（round-trip）
 *
 * 这是防「列错位」的最强保证：
 *   原始表格 → 生成粘贴文本 → 按后台的解析方式反解 → 必须与原始数据完全一致
 *
 * 如果任何一列偏移、被截断、或多出字段，这里就会报错。
 *
 * 运行：node scripts/selftest-paste.js
 */

import { buildPasteText, renderLine, checkField, autoFixRemark, SEP } from '../src/core/paste.js';

let failures = 0;
let checks = 0;

function ok(label) {
  checks++;
  console.log(`  ✓ ${label}`);
}
function bad(label, detail) {
  checks++;
  failures++;
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}
function assert(cond, label, detail) {
  cond ? ok(label) : bad(label, detail);
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  assert(same, label, same ? '' : `期望 ${JSON.stringify(b)}\n      实际 ${JSON.stringify(a)}`);
}

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
function makeId(prov, birth, seq) {
  const body = prov + birth + seq;
  let s = 0;
  for (let i = 0; i < 17; i++) s += Number(body[i]) * WEIGHTS[i];
  return body + CHECK_CODES[s % 11];
}

// ============ 1. 分隔符常量 ============
console.log('=== 1. 分隔符必须是英文逗号 ===');
eq(SEP, ',', 'SEP 常量为英文逗号');
assert(SEP.charCodeAt(0) === 0x2c, 'SEP 码点为 0x2C');

// ============ 2. 往返一致性 ============
console.log('\n=== 2. 往返一致性（生成 → 反解 → 比对）===');

const source = [
  { excelRow: 2, name: '张三', studentId: '20230101', idCard: makeId('110101', '20050101', '123'), hours: 8, remark: '2025年迎新志愿服务' },
  { excelRow: 3, name: '李四', studentId: '20230102', idCard: makeId('130102', '20050315', '234'), hours: 12.5, remark: '社区环境卫生清扫' },
  { excelRow: 4, name: '王五', studentId: '20230103', idCard: makeId('310104', '20040720', '345'), hours: 45, remark: '暑期支教（累计）' },
  { excelRow: 5, name: '赵六', studentId: '20230104', idCard: makeId('440105', '20050910', '456'), hours: 0.5, remark: '短时服务' },
  // 少数民族姓名（含间隔号）
  { excelRow: 6, name: '阿依古丽·买买提', studentId: '20230105', idCard: makeId('650106', '20051212', '678'), hours: 3, remark: '民族团结活动' },
  // 姓名含括号
  { excelRow: 7, name: '欧阳（小）明', studentId: '20230106', idCard: makeId('360107', '20060101', '789'), hours: 6, remark: '图书馆服务' },
];

const built = buildPasteText(source, { defaultReason: '测试用技能原因' });

eq(built.blocked.length, 0, `无行被拦下（实际 ${built.blocked.length}）`);
eq(built.lines.length, source.length, `行数一致（${source.length}）`);

// 模拟后台解析：按换行切行，按英文逗号切列
const parsed = built.text.split('\n').map((line) => line.split(SEP));

eq(parsed.length, source.length, '解析后行数一致');

let allMatch = true;
for (let i = 0; i < source.length; i++) {
  const src = source[i];
  const cols = parsed[i];
  if (cols.length !== 4) {
    allMatch = false;
    bad(`第${i + 1}行列数应为 4，实际 ${cols.length}`, JSON.stringify(cols));
    continue;
  }
  const expected = [src.name, src.idCard, String(src.hours), src.remark];
  if (JSON.stringify(cols) !== JSON.stringify(expected)) {
    allMatch = false;
    bad(`第${i + 1}行数据不匹配`, `期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(cols)}`);
  }
}
if (allMatch) ok(`全部 ${source.length} 行往返一致，无列偏移`);

// 逐字段抽查（含非 ASCII 姓名）
// 注意索引：parsed 与 source 同为 0-based
//   index 4 = 阿依古丽·买买提
//   index 5 = 欧阳（小）明
const rowMinority = parsed[4];
eq(rowMinority[0], '阿依古丽·买买提', '含间隔号的姓名正确');
eq(rowMinority[1], source[4].idCard, '身份证号正确');
eq(rowMinority[2], '3', '时长正确');
eq(rowMinority[3], '民族团结活动', '备注正确');

const rowParen = parsed[5];
eq(rowParen[0], '欧阳（小）明', '含全角括号的姓名正确');
eq(rowParen[3], '图书馆服务', '备注正确');

// 时长格式
eq(parsed[3][2], '0.5', '小数时长 0.5 正确');
eq(parsed[2][2], '45', '整数时长 45 中间无小数点');

// ============ 3. 危险字符检测 ============
console.log('\n=== 3. 危险字符必须被拦下 ===');

const dangerous = [
  ['备注含英文逗号', { name: 'A', idCard: makeId('110101', '20050101', '123'), hours: 5, remark: '迎新,社区' }],
  ['备注含换行', { name: 'B', idCard: makeId('110101', '20050101', '124'), hours: 5, remark: '第一行\n第二行' }],
  ['备注含制表符', { name: 'C', idCard: makeId('110101', '20050101', '125'), hours: 5, remark: 'a\tb' }],
  ['姓名含逗号', { name: 'D,E', idCard: makeId('110101', '20050101', '126'), hours: 5, remark: '正常' }],
];

for (const [label, row] of dangerous) {
  const r = renderLine(row, { defaultReason: '测试' });
  assert(!r.ok, `${label} → 被拦下`);
}

// 时长带单位必须被拦下
const badHours = renderLine({ name: 'E', idCard: makeId('110101', '20050101', '127'), hours: '5小时', remark: 'x' }, {});
assert(!badHours.ok, '时长带单位「5小时」→ 被拦下');

// ---- 备注缺失的处理（核心规则）----
// 规则：备注是系统必填项。缺失时「不猜、不填默认值」，而是判为需报备。
// 只有调用方明确传入一个已确认的原因时才使用它。

// 1) 备注为空 且 未传 defaultReason → 必须被拦下（判为缺失）
const noRemarkNoDefault = renderLine(
  { name: 'F', idCard: makeId('110101', '20050101', '128'), hours: 5, remark: '' },
  {}
);
assert(!noRemarkNoDefault.ok, '备注为空且未提供原因 → 被拦下');
assert(
  noRemarkNoDefault.problems.some((p) => p.missing),
  '该问题被标记为「缺失(missing)」而非普通错误'
);
assert(
  noRemarkNoDefault.problems.some((p) => p.field === '备注'),
  '问题定位到「备注」字段'
);

// 2) 备注为空 但 显式传入已确认的原因 → 允许使用
const noRemarkWithDefault = renderLine(
  { name: 'F', idCard: makeId('110101', '20050101', '128'), hours: 5, remark: '' },
  { defaultReason: '已确认的原因' }
);
eq(
  noRemarkWithDefault.text,
  `F,${makeId('110101', '20050101', '128')},5,已确认的原因`,
  '显式传入原因时，用它填充'
);
assert(noRemarkWithDefault.ok, '显式传入原因后可以通过');

// 3) 备注列完全不存在（表格无该列）→ 无原因时同样拦下
const noRemarkColumn = renderLine(
  { name: 'H', idCard: makeId('110101', '20050101', '130'), hours: 5 },
  {}
);
assert(!noRemarkColumn.ok, '表格完全没有备注列且无原因 → 被拦下');

// 4) buildPasteText 应把这类行归入 missing，而不是 blocked
const missBuild = buildPasteText(
  [
    { excelRow: 2, name: 'A', idCard: makeId('110101', '20050101', '131'), hours: 5, remark: '' },
    { excelRow: 3, name: 'B', idCard: makeId('110101', '20050101', '132'), hours: 5, remark: '有备注' },
  ],
  {}
);
eq(missBuild.missing.length, 1, '缺备注的行归入 missing');
eq(missBuild.blocked.length, 0, '缺备注不算数据错误');
eq(missBuild.lines.length, 1, '只有有备注的那行进入输出');
eq(missBuild.text, `B,${makeId('110101', '20050101', '132')},5,有备注`, '输出内容正确');

// ============ 4. 自动修复 ============
console.log('\n=== 4. 自动修复（--fix）===');
eq(autoFixRemark('迎新,社区'), '迎新、社区', '英文逗号 → 顿号');
eq(autoFixRemark('a,b,c'), 'a、b、c', '多个英文逗号');
eq(autoFixRemark('第一行\n第二行'), '第一行 第二行', '换行 → 空格');
eq(autoFixRemark('a\tb'), 'a b', '制表符 → 空格');
eq(autoFixRemark('支教、敬老院'), '支教、敬老院', '中文顿号不受影响');

const fixedBuild = buildPasteText(
  [{ excelRow: 2, name: 'G', idCard: makeId('110101', '20050101', '129'), hours: 5, remark: '迎新,社区' }],
  { defaultReason: '测试', autoFix: true }
);
eq(fixedBuild.blocked.length, 0, '--fix 后无行被拦下');
eq(fixedBuild.fixed.length, 1, '记录了 1 处修复');
eq(fixedBuild.text, `G,${makeId('110101', '20050101', '129')},5,迎新、社区`, '修复后的文本正确');

// ============ 5. 无 BOM / 无 CR ============
console.log('\n=== 5. 文本纯净性 ===');
const t = built.text;
assert(!t.includes('\r'), '不含回车符 CR（避免 Windows 换行干扰）');
assert(!t.startsWith('\uFEFF'), '不含 BOM');
assert(!t.includes('\t'), '不含制表符');
assert(t.split('\n').every((l) => l.split(SEP).length === 4), '每行都是 4 列');
assert(!t.endsWith('\n'), '末尾无多余换行');

// ============ 6. checkField 单元 ============
console.log('\n=== 6. checkField 单元 ===');
assert(checkField('正常文本', 'X').ok, '普通文本通过');
assert(!checkField('含,逗号', 'X').ok, '逗号被检出');
assert(!checkField('含\r\n', 'X').ok, 'CRLF 被检出');
assert(checkField('', 'X').ok, '空串通过');

// ============ 汇总 ============
console.log('');
console.log(`共 ${checks} 项检查`);
if (failures) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ 全部通过');
