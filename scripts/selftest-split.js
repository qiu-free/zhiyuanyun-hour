/**
 * 「一行挤多人」拆分的自检
 *
 * 背景：从 Word / 微信复制时换行经常丢失。
 * 早期实现按行解析，导致「一行只出第一个人，其余被静默丢弃」——
 * 用户以为录完了，实际漏人。这个自检把该场景锁死。
 *
 * 用法：node scripts/selftest-split.js
 */

import { parseText } from '../src/core/parseText.js';
import { splitPeople, findAnchors, looksLikeIdCard } from '../src/core/splitPeople.js';

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`); }
}

// 虚构但格式合法的号码
const A = '110101200501010017';
const B = '110101200502020022';
const C = '110101200503030038';
const D = '110101200504040043';

/** 便捷断言：解析并返回精简结果 */
function people(text) {
  return parseText(text).records.map((r) => ({
    name: r.name, hours: r.hours, sid: r.studentId, id: r.idCard, remark: r.remark,
  }));
}

console.log('=== 1. 没有换行：必须全部识别，一个都不能少 ===');
{
  const r = people(`张三 ${A} 8 李四 ${B} 8 王五 ${C} 8`);
  check(r.length === 3, `3 人全部识别（实际 ${r.length}）`);
  check(r[0].name === '张三' && r[1].name === '李四' && r[2].name === '王五',
    '姓名与顺序正确', JSON.stringify(r.map((x) => x.name)));
  check(r[0].hours === 8 && r[1].hours === 8 && r[2].hours === 8, '时长正确');
  check(r[0].id === A && r[2].id === C, '身份证归属正确');
}

console.log('\n=== 2. 时长不能张冠李戴（最危险的情况）===');
{
  const r = people(`张三 ${A} 8 李四 ${B} 12`);
  check(r[0].hours === 8, `第1人时长 8（实际 ${r[0].hours}）`);
  check(r[1].hours === 12, `第2人时长 12（实际 ${r[1].hours}）`);
}
{
  const r = people(`张三 ${A} 33 李四 ${B} 5`);
  check(r[0].hours === 33 && r[1].hours === 5,
    '相差较大的时长也不会错配', JSON.stringify(r.map((x) => x.hours)));
}

console.log('\n=== 3. 「姓名 时长 身份证」顺序也要对 ===');
{
  const r = people(`张三 8 ${A} 李四 12 ${B}`);
  check(r.length === 2, `识别 2 人（实际 ${r.length}）`);
  check(r[0].name === '张三' && r[0].hours === 8, `第1人 张三/8（实际 ${r[0].name}/${r[0].hours}）`);
  check(r[1].name === '李四' && r[1].hours === 12, `第2人 李四/12（实际 ${r[1].name}/${r[1].hours}）`);
}

console.log('\n=== 4. 各种分隔符 ===');
{
  const r = people(`张三，${A}，8，李四，${B}，8`);
  check(r.length === 2 && r[0].name === '张三' && r[1].name === '李四', '中文逗号');
}
{
  const r = people(`张三|${A}|8|李四|${B}|8`);
  check(r.length === 2 && r[0].name === '张三', '竖线');
}
{
  const r = people(`张三,${A},8,李四,${B},8`);
  check(r.length === 2 && r[0].name === '张三', '英文逗号');
}
{
  const r = people(`张三;${A};8;李四;${B};8`);
  check(r.length === 2 && r[0].name === '张三', '分号');
}

console.log('\n=== 5. 额外数据不能干扰（"不只是原来那些数据"）===');
{
  const r = people(`张三 ${A} 8 数学学院 2023级 电话13800138000 李四 ${B} 8 统计学院`);
  check(r.length === 2, `仍然只出 2 人（实际 ${r.length}）`);
  check(r[0].name === '张三' && r[1].name === '李四', '姓名未被额外字段污染');
  check(r[0].hours === 8 && r[1].hours === 8, '时长未被额外字段污染');
  check(r[1].sid !== '13800138000', '电话号码没被当成学号');
}
{
  const r = people(`各位同学，现将补录名单公布如下 张三 ${A} 8 李四 ${B} 8 请大家核对，有问题联系我`);
  check(r.length === 2, '前后说明文字不影响识别');
  check(r[0].name === '张三' && r[1].name === '李四', '没把说明文字当姓名');
}
{
  const r = people(`1 张三 ${A} 8 2 李四 ${B} 12 3 王五 ${C} 5`);
  check(r.length === 3, '带序号的多人行（3）');
  check(r[0].hours === 8 && r[1].hours === 12 && r[2].hours === 5,
    '序号没被当时长', JSON.stringify(r.map((x) => x.hours)));
}

console.log('\n=== 6. 带学号 ===');
{
  const r = people(`张三 2023000001 ${A} 8 李四 2023000002 ${B} 8`);
  check(r[0].sid === '2023000001', `第1人学号（实际 ${r[0].sid}）`);
  check(r[1].sid === '2023000002', `第2人学号（实际 ${r[1].sid}）`);
  check(r[0].name === '张三' && r[1].name === '李四', '姓名没错位');
}

console.log('\n=== 7. 每人有备注 ===');
{
  const r = people(`张三 ${A} 8 备注：迎新 李四 ${B} 8 备注：清扫`);
  check(r[0].remark === '迎新', `第1人备注（实际 ${r[0].remark}）`);
  check(r[1].remark === '清扫', `第2人备注（实际 ${r[1].remark}）`);
}

console.log('\n=== 8. 混合：有的行有换行，有的没有 ===');
{
  const r = people(`张三 ${A} 8\n李四 ${B} 8 王五 ${C} 8\n赵六 ${D} 12`);
  check(r.length === 4, `共 4 人（实际 ${r.length}）`);
  check(r.map((x) => x.name).join() === '张三,李四,王五,赵六', '顺序正确', JSON.stringify(r.map((x) => x.name)));
  const p = parseText(`张三 ${A} 8\n李四 ${B} 8 王五 ${C} 8\n赵六 ${D} 12`);
  check(p.splitLines.length === 1 && p.splitLines[0].lineNo === 2, '只报告第 2 行发生了拆分');
}

console.log('\n=== 9. 表头/汇总行仍要跳过 ===');
{
  const p = parseText(`姓名 身份证 时长 备注\n张三 ${A} 8 备注：x`);
  check(p.skipped.length === 1 && p.skipped[0].lineNo === 1, '表头行被跳过');
  check(p.records.length === 1, '数据行正常解析');
}
for (const [line, label] of [
  ['合计 8 人', '合计行'],
  ['总计 12 人', '总计行'],
  ['共 8 人', '共...人行'],
  ['暑期迎新志愿服务名单', '标题行'],
  ['补录原因：暑期迎新志愿服务活动', '原因行'],
  ['', '空行'],
]) {
  const p = parseText(line);
  check(p.records.length === 0, `跳过「${label}」`);
}

console.log('\n=== 10. 缺身份证的行要明确报出来，不能静默丢弃 ===');
{
  const p = parseText('张三 8\n李四 12');
  check(p.records.length === 2, `2 条都保留（实际 ${p.records.length}）`);
  check(p.records.every((r) => r.issues.some((x) => x.includes('身份证'))),
    '都标记了「未找到身份证号」');
}

console.log('\n=== 11. 单个身份证不触发拆分（走原来的单行逻辑）===');
{
  const r = splitPeople(`姓名：张三 学号：2023000001 身份证：${A} 时长：8`);
  check(r === null, '单人行返回 null，交回单行解析');
  const p = people(`姓名：张三 学号：2023000001 身份证：${A} 时长：8`);
  check(p.length === 1 && p[0].name === '张三' && p[0].hours === 8, '单行解析仍然正确');
}

console.log('\n=== 12. 身份证识别要严：15 位学号不能被当身份证 ===');
{
  check(looksLikeIdCard(A), '18 位合法号 → 认可');
  check(!looksLikeIdCard('202300000123456'), '15 位学号（前两位 20 非省份码）→ 拒绝');
  check(!looksLikeIdCard('999999200501011234'), '非法省份码 → 拒绝');
  check(!looksLikeIdCard('110101209901011234'), '未来出生年份 → 拒绝');
  check(findAnchors(`张三 ${A} 李四 ${B}`).length === 2, '两个合法锚点');
  check(findAnchors(`张三 ${A} 李四 ${A}`).length === 1, '同一号码重复只算一人');
}

console.log('\n=== 13. 拆分结果必须带可核对信息 ===');
{
  const p = parseText(`张三 ${A} 8 李四 ${B} 12`);
  check(p.records.every((r) => r.sharedLine === true), '标记来自共享行');
  check(p.records[0].anchorCount === 2, '记录该行共几人');
  check(p.records[0].anchorIndex === 1 && p.records[1].anchorIndex === 2, '序号正确');
  check(p.records.every((r) => r.segment && r.segment.includes(r.idCard)),
    '每人都能还原出片段供核对');
  check(p.splitLines.length === 1 && p.splitLines[0].count === 2, '结构化报告拆分情况');
  check(!p.warnings.some((w) => w.includes('自动拆')),
    '拆分信息不重复出现在 warnings 里');
}

console.log('\n=== 14. 大量人员一行也要全出 ===');
{
  // 生成 12 个格式合法的虚构号码：
  //   6 位行政区划 + 8 位出生日期 + 3 位顺序 + 1 位校验 = 18 位
  const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const CH = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

  const valid = [];
  for (let i = 0; i < 12; i++) {
    const body17 =
      '110101' +
      '2005' +
      String((i % 12) + 1).padStart(2, '0') +
      String((i % 28) + 1).padStart(2, '0') +
      String(i + 1).padStart(3, '0');
    if (body17.length !== 17) throw new Error(`测试数据构造错误：body=${body17.length} 位`);
    let s = 0;
    for (let k = 0; k < 17; k++) s += Number(body17[k]) * WEIGHTS[k];
    valid.push(body17 + CH[s % 11]);
  }
  check(valid.every((x) => x.length === 18), '测试数据都是 18 位');

  // 姓名用纯汉字，避免数字混入姓名导致误判
  const line = valid.map((id, i) => `测试${CN[i]} ${id} ${i + 1}`).join(' ');
  const p = parseText(line);
  check(p.records.length === 12, `12 人全部识别（实际 ${p.records.length}）`);

  const names = p.records.map((r) => r.name);
  check(names[0] === '测试一' && names[11] === '测试十二', '姓名正确', JSON.stringify(names));

  const hours = p.records.map((r) => r.hours);
  check(hours.every((h, i) => h === i + 1), '每人时长正确', JSON.stringify(hours));
  check(p.records.every((r, i) => r.idCard === valid[i]), '身份证与顺序一一对应');
}

console.log('\n=== 15. 超过单次上限（50 小时）的时长不能被丢掉 ===');
{
  // 早期版本：>50 返回 ok:false，导致 80 小时被当成「缺少时长」丢弃，
  // 用户既看不到总数，也不知道要分两次录。这里锁住修复结果。
  const p = parseText(`张三 ${A} 80 备注：全年服务`);
  check(p.records.length === 1, '识别 1 条');
  check(p.records[0].hours === 80, `80 小时被保留（实际 ${p.records[0].hours}）`);
}
{
  const p = parseText(`张三 ${A} 8 李四 ${B} 120`);
  check(p.records.length === 2, '多人一行也保留超限时长');
  check(p.records[0].hours === 8, '第1人 8h');
  check(p.records[1].hours === 120, `第2人 120h（实际 ${p.records[1].hours}）`);
}
{
  // 带单位、带标签的写法
  const p = parseText(`张三 ${A} 80小时`);
  check(p.records[0]?.hours === 80, '80小时（带单位）');
  const p2 = parseText(`姓名：张三 身份证：${A} 时长：150`);
  check(p2.records[0]?.hours === 150, '时长：150（带标签）');
}
{
  // 4 位数不能被当时长（年份、编号）
  const p = parseText(`张三 ${A} 2025 备注：第七届`);
  const h = p.records[0]?.hours;
  check(h !== 2025, `4 位数没被当时长（实际 ${h}）`);
}

console.log('\n=== 16. 恰好边界：50 一次，51 两次 ===');
{
  const at50 = parseText(`张三 ${A} 50 备注：x`);
  check(at50.records[0].hours === 50, '50h 被完整保留');
  const at51 = parseText(`张三 ${A} 51 备注：x`);
  check(at51.records[0].hours === 51, '51h 被完整保留');
}

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
