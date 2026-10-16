/**
 * 段落文本解析自检
 * 用法：node scripts/selftest-parseText.js
 */

import { parseText, parseLine } from '../src/core/parseText.js';

let pass = 0, fail = 0;

function t(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

// 用合法的测试号码（构造，非真实公民）
const ID1 = '110101200501010017';
const ID2 = '110101200502020022';

console.log('=== 各种常见格式 ===');

// 1. 空格分隔
let r = parseLine(`张三 2025213817 ${ID1} 8`);
t('空格分隔 → 姓名', r.name, '张三');
t('空格分隔 → 身份证', r.idCard, ID1);
t('空格分隔 → 学号', r.studentId, '2025213817');
t('空格分隔 → 时长', r.hours, 8);

// 2. 中文逗号
r = parseLine(`李四，2024213884，${ID2}，8小时`);
t('中文逗号 → 姓名', r.name, '李四');
t('中文逗号 → 时长(带单位)', r.hours, 8);
t('中文逗号 → 学号', r.studentId, '2024213884');

// 3. 带标签
r = parseLine(`姓名：王五 学号：2025213761 身份证：${ID1} 时长：8小时`);
t('带标签 → 姓名', r.name, '王五');
t('带标签 → 时长', r.hours, 8);

// 4. 带备注
r = parseLine(`赵六 2024213879 ${ID2} 8 备注：迎新志愿服务`);
t('带备注 → 姓名', r.name, '赵六');
t('带备注 → 备注', r.remark, '迎新志愿服务');
t('带备注 → 时长', r.hours, 8);

// 5. 时长在前
r = parseLine(`8h 钱七 ${ID1}`);
t('时长在前 → 姓名', r.name, '钱七');
t('时长在前 → 时长', r.hours, 8);

// 6. 小数时长
r = parseLine(`孙八 2023213829 ${ID2} 12.5小时`);
t('小数时长', r.hours, 12.5);

// 7. 打码身份证
r = parseLine(`周九 2024213790 500113********9196 8`);
t('打码 → 标记 masked', r.idCardMasked, true);
t('打码 → 有 issue', r.issues.some((x) => x.includes('打码')), true);

// 8. 竖线分隔
r = parseLine(`吴十|2025213935|${ID1}|8|暑期迎新`);
t('竖线分隔 → 姓名', r.name, '吴十');
t('竖线分隔 → 时长', r.hours, 8);

// 9. 无单位裸数字
r = parseLine(`郑十一 2025213856 ${ID2} 12`);
t('裸数字时长', r.hours, 12);

// 10. 身份证带 X
const IDX = '11010120050101001X';
r = parseLine(`测试 2025000001 ${IDX} 6`);
t('身份证末位X', r.idCard, IDX);

console.log('\n=== 整段文本 ===');
const block = `志愿时长补录名单
补录原因：暑期迎新志愿服务活动

张三 2025213817 ${ID1} 8
李四，2024213884，${ID2}，8小时
姓名：王五 学号：2025213761 身份证：${ID1} 时长：8

合计：3人`;

const p = parseText(block);
t('识别出 3 条记录', p.records.length, 3);
t('跳过标题/说明/合计行', p.skipped.length, 3);
t('第1条姓名', p.records[0].name, '张三');
t('第2条时长', p.records[1].hours, 8);
t('第3条姓名', p.records[2].name, '王五');

console.log('');
console.log('=== 无标签备注（第 4 列直接是备注）===');
{
  // 用户真实格式：姓名 <TAB> 身份证 <TAB> 1小时 <TAB> 说明文字
  // 早期只认「备注：xxx」，导致这类备注被整段丢掉 ——
  // 备注是系统必填，一丢就全部变成「待报备」，什么都复制不出来。
  const RM = '2025.12.9下午3：00到4：00在学校进行“三清”志愿服务活动';

  let x = parseLine(`测试甲\t${ID1}\t1小时\t${RM}`);
  t('制表符 → 备注', x.remark, RM);
  t('制表符 → 备注来源', x.remarkSource, 'positional');
  t('制表符 → 姓名', x.name, '测试甲');
  t('制表符 → 时长', x.hours, 1);

  x = parseLine(`测试甲 ${ID1} 1小时 ${RM}`);
  t('空格 → 备注', x.remark, RM);

  // 时长是裸数字，备注里有「3：00」「4：00」和日期 ——
  // 不把日期时间挖掉的话，会看到 1、3、4 三个数字而报「无法确定」
  x = parseLine(`测试甲\t${ID1}\t1\t${RM}`);
  t('裸数时长 + 含时间备注 → 时长', x.hours, 1);
  t('裸数时长 + 含时间备注 → 备注', x.remark, RM);

  x = parseLine(`测试甲,${ID1},1,${RM}`);
  t('逗号 → 时长', x.hours, 1);
  t('逗号 → 备注', x.remark, RM);

  // 带标签的仍然优先
  x = parseLine(`测试甲 ${ID1} 1小时 备注：${RM}`);
  t('带标签 → 来源', x.remarkSource, 'labeled');
  t('带标签 → 备注', x.remark, RM);

  // 没有备注时不能凭空造一个
  x = parseLine(`测试甲\t${ID1}\t1小时`);
  t('没有备注 → 保持为空', x.remark, '');

  // 标签残渣不能当备注（值被吃掉后只剩「姓名： 学号：」这类壳）
  x = parseLine(`姓名：王五 学号：2025213761 身份证：${ID1} 时长：8`);
  t('标签残渣 → 不当作备注', x.remark, '');

  // 纯数字残留也不能当备注
  x = parseLine(`测试甲\t${ID1}\t1小时\t123`);
  t('纯数字残留 → 不当作备注', x.remark, '');

  // 备注里的年份必须保留（不能因为挖时间而改坏原文）
  x = parseLine(`测试甲 ${ID1} 8 2025年参加迎新活动`);
  t('备注原文不被改写', x.remark, '2025年参加迎新活动');
  t('含年份备注 → 时长', x.hours, 8);
}

console.log('');
console.log('=== 位数不对的身份证 ===');
{
  const RM = '参加活动';
  // 19 位：多打了一位，很常见
  let x = parseLine(`测试乙\t1101012005010100170\t1小时\t${RM}`);
  t('19 位 → 不当作身份证', x.idCard, '');
  t('19 位 → 提示具体位数', /19 位/.test(x.issues.join(' ')), true);
  // 关键：那串数字不能被漏进备注里，否则用户会看到备注是一串号码
  t('19 位 → 不污染备注', x.remark, RM);
  t('19 位 → 姓名仍正确', x.name, '测试乙');
  t('19 位 → 时长仍正确', x.hours, 1);

  // 正常 18 位不受影响
  x = parseLine(`测试甲\t${ID1}\t1小时\t${RM}`);
  t('18 位 → 正常识别', x.idCard, ID1);
  t('18 位 → 无误报', x.issues, []);

  // 15 位老身份证仍走原逻辑
  x = parseLine(`测试甲\t110101200501010\t1小时\t${RM}`);
  t('15 位 → 仍识别为身份证', x.idCard.length, 15);
}

console.log('\n=== 抽取结果预览 ===');
for (const rec of p.records) {
  console.log(`  行${rec.lineNo}: 姓名=${rec.name} 证=${rec.idCard} 学时=${rec.hours} 学号=${rec.studentId}`);
}

console.log('');
console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
