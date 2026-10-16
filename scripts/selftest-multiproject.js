/**
 * 多项目分流自检
 *
 * 背景（用户实测确认）：
 *   时间锁是「同一人在同一项目」的限制。把同一个人的时长拆到两个
 *   不同项目里，两边互不等待，可以同一天录完；志愿者总时长正常累计。
 *
 * 这个模块最容易错的地方：
 *   1. 把没超限的人也拆散（8 小时拆成 2.7 + 2.7 + 2.6 —— 毫无意义）
 *   2. 拆分后时长不守恒（50 + 30 ≠ 80）
 *   3. 单批超过 50
 * 本自检把这三条全部锁住。
 *
 * 用法：node scripts/selftest-multiproject.js
 */

import {
  comparePlans,
  minProjectsForSameDay,
  splitAcrossProjects,
  buildMultiProjectBatches,
  singleProjectPlan,
} from '../src/core/multiProject.js';

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`); }
}

const sum = (arr) => Math.round(arr.reduce((s, x) => s + x, 0) * 10) / 10;

console.log('=== 1. 最少项目数：每 50 小时需要一个项目 ===');
{
  const cases = [
    [8, 1], [50, 1], [50.5, 2], [51, 2], [80, 2], [100, 2],
    [100.5, 3], [120, 3], [150, 3], [200, 4], [250, 5], [300, 6],
  ];
  for (const [T, expect] of cases) {
    const got = minProjectsForSameDay(T);
    check(got === expect, `${T}h → ${expect} 个项目（实际 ${got}）`);
  }
}

console.log('\n=== 2. 均分：总和必须守恒，且每份不超 50 ===');
{
  const cases = [[80, 2], [100, 2], [120, 3], [150, 3], [121, 3], [80, 3], [7, 3], [1, 2]];
  for (const [T, n] of cases) {
    const r = splitAcrossProjects(T, n);
    if (!r.ok) {
      // 分不了也要说清楚原因
      check(T / n > 50, `${T}h/${n} 个 → 拒绝并说明原因`, r.reason);
      continue;
    }
    check(sum(r.parts) === T, `${T}h / ${n} 个 → 总和守恒（${sum(r.parts)}）`);
    check(Math.max(...r.parts) <= 50, `${T}h / ${n} 个 → 每份不超 50（最大 ${Math.max(...r.parts)}）`);
    check(r.parts.length === n, `${T}h / ${n} 个 → 份数为 ${n}`);
  }
}

console.log('\n=== 3. 均分要尽量均匀（不能一堆 50 加一个零头）===');
{
  const r = splitAcrossProjects(120, 3);
  check(sum(r.parts) === 120, '120h/3 → 守恒');
  check(Math.max(...r.parts) - Math.min(...r.parts) <= 0.2,
    `120h/3 → 各份接近（${r.parts.join(', ')}）`);
  const r2 = splitAcrossProjects(80, 2);
  check(r2.parts.every((x) => Math.abs(x - 40) < 0.01), `80h/2 → 各 40（${r2.parts.join(', ')}）`);
}

console.log('\n=== 4. 单项目方案：分批与等待时间 ===');
{
  const p = singleProjectPlan(120);
  check(p.batchCount === 3, `120h → 3 批（实际 ${p.batchCount}）`);
  check(p.batches.map((b) => b.hours).join() === '50,50,20', '50 + 50 + 20');
  check(p.finishHour === 240, `需等 240 小时（实际 ${p.finishHour}）`);

  const p2 = singleProjectPlan(80);
  check(p2.finishHour === 120, `80h → 等 120 小时（实际 ${p2.finishHour}）`);

  const p3 = singleProjectPlan(50);
  check(p3.finishHour === 0, '50h → 不用等');
  check(p3.batchCount === 1, '50h → 1 批');
}

console.log('\n=== 5. 方案对比：分流到底省多少 ===');
{
  const cases = [
    [50, 0],    // 不用分流
    [80, 120],
    [100, 120],
    [120, 240],
    [200, 360],
  ];
  for (const [T, saved] of cases) {
    const c = comparePlans(T);
    check(c.savedHours === saved, `${T}h → 省 ${saved} 小时（实际 ${c.savedHours}）`);
  }

  // 分流后必然是当天
  const c = comparePlans(120);
  check(c.multi.finishHour === 0, '分流后当天即可');
  check(c.multi.projectCount === 3, '120h 需要 3 个项目');
  check(sum(c.multi.parts) === 120, '分流后总和守恒');
}

console.log('\n=== 6. 「有几个项目可用」的判断 ===');
{
  let c = comparePlans(120, 3);
  check(c.enoughProjects === true, '有 3 个项目够用');
  check(c.canFinishSameDay === true, '够用 → 能当天录完');
  check(c.actual.finishHour === 0, '3 个项目 → 实际方案也是当天');

  c = comparePlans(120, 2);
  check(c.enoughProjects === false, '只有 2 个项目不够当天录完');
  check(c.canFinishSameDay === false, '不够 → 不能当天全录完');
  // 但混合策略仍然显著优于只用 1 个项目
  check(c.actual.finishHour === 120, `2 个项目 → 5 天完成（实际 ${c.actual.finishHour}h）`);
  check(c.single.finishHour === 240, '单项目要 10 天');
  check(c.actual.savedHours === 120, `仍省下 5 天（实际 ${c.actual.savedHours}h）`);

  c = comparePlans(120);
  check(c.enoughProjects === null, '不传项目数时不做判断');
  check(c.canFinishSameDay === true, '不传项目数时按理想情况，可当天');
}

console.log('\n=== 6b. 混合策略：换项目 + 等待，同时用 ===');
{
  // 这是本模块最关键的一处修正。
  // 早期实现把两者当二选一：项目不够就完全放弃分流，退回单项目。
  // 正确做法是「能分流多少分多少，剩下的等」。
  const cases = [
    // [总时长, 项目数, 期望完成小时]
    [120, 1, 240],   // 只有 1 个项目 → 只能等，10 天
    [120, 2, 120],   // 2 个项目 → 当天录 100，等 5 天录 20 → 5 天
    [120, 3, 0],     // 3 个项目 → 当天全录完
    [120, 4, 0],     // 更多项目不会更好
    [80, 1, 120],    // 80h 1 个项目 → 等 5 天
    [80, 2, 0],      // 80h 2 个项目 → 当天
    // 200h + 2 个项目：当天 P1/P2 各 50（共100），
    // 等 120h 后再各 50（共200）→ 5 天完成（不是 10 天）
    [200, 2, 120],
    [200, 3, 120],   // 当天 150，等 5 天 50
    [200, 4, 0],     // 200h 4 个项目 → 当天
    [50, 1, 0],      // 不超限，不用等
  ];
  for (const [T, P, expect] of cases) {
    const c = comparePlans(T, P);
    check(c.actual.finishHour === expect,
      `${T}h + ${P} 个项目 → ${expect}h 完成（实际 ${c.actual.finishHour}h）`);
  }

  // 每一步都不能超过 50
  for (const [T, P] of [[120, 2], [200, 2], [200, 3], [333, 2]]) {
    const c = comparePlans(T, P);
    check(c.actual.steps.every((s) => s.hours > 0 && s.hours <= 50),
      `${T}h/${P}个 → 每步 ≤50（${c.actual.steps.map((s) => s.hours).join(',')}）`);
    // 守恒
    const s = Math.round(c.actual.steps.reduce((a, b) => a + b.hours, 0) * 10) / 10;
    check(s === Math.round(T * 10) / 10, `${T}h/${P}个 → 步骤之和守恒（${s}）`);
  }

  // 项目越多，完成时间不能变长（单调性）
  let prev = Infinity;
  for (let P = 1; P <= 5; P++) {
    const h = comparePlans(200, P).actual.finishHour;
    check(h <= prev, `200h：${P} 个项目(${h}h) 不慢于 ${P - 1} 个(${prev}h)`);
    prev = h;
  }
}

console.log('\n=== 6c. 项目不够时绝不能生成超 50 的数据 ===');
{
  // 危险场景：120h 按 2 个项目均分会得到 [60,60]，每份超 50 必然失败
  const b = buildMultiProjectBatches(
    [{ name: '张三', idCard: '110101200501010017', hours: 120, remark: 'x' }], 2
  );
  const allHours = b.perPerson.flatMap((p) => p.steps.map((s) => s.hours));
  check(allHours.every((h) => h <= 50), `没有任何一步超 50（${allHours.join(', ')}）`);
  check(Math.round(allHours.reduce((a, c) => a + c, 0) * 10) / 10 === 120, '仍然守恒');
  check(b.finishHour === 120, '混合方案 5 天完成');

  // 分组文本里也不能有超 50 的行
  for (const g of b.groups) {
    check(g.items.every((x) => x.hours > 0 && x.hours <= 50), `第${g.group}组无超 50 项`);
  }

  // 非法项目数
  const b3 = buildMultiProjectBatches([{ name: 'x', hours: 120, idCard: '1', remark: '' }], 0);
  check(b3.ok === false, '项目数 0 → 直接失败');
}

console.log('\n=== 7. 只拆需要拆的人（关键）===');
{
  const people = [
    { name: '张三', idCard: '110101200501010017', hours: 120, remark: '支教' },
    { name: '李四', idCard: '110101200502020022', hours: 8, remark: '迎新' },
    { name: '王五', idCard: '110101200503030038', hours: 50, remark: '清扫' },
  ];
  const b = buildMultiProjectBatches(people, 3);

  const byName = Object.fromEntries(b.perPerson.map((p) => [p.name, p]));

  check(byName['张三'].split === true, '张三（120h）被拆分');
  // 贪心会尽量填满每个项目：50 + 50 + 20（而不是均分 40+40+40）
  // 贪心更优 —— 项目 1 里张三只录一次，不用等
  check(byName['张三'].steps.map((s) => s.hours).join() === '50,50,20',
    `张三 50+50+20（实际 ${byName['张三'].steps.map((s) => s.hours).join()}）`);
  check(byName['张三'].steps.every((s) => s.atHour === 0), '3 个项目够用时张三当天全录完');

  check(byName['李四'].split === false, '李四（8h）不拆分');
  check(byName['李四'].steps.length === 1 && byName['李四'].steps[0].hours === 8,
    '李四保持 8h 一条');

  check(byName['王五'].split === false, '王五（正好 50h）不拆分');
  check(byName['王五'].steps.length === 1 && byName['王五'].steps[0].hours === 50,
    '王五保持 50h 一条');

  // 守恒
  for (const p of b.perPerson) {
    const s = Math.round(p.steps.reduce((a, c) => a + c.hours, 0) * 10) / 10;
    check(s === p.hours, `${p.name} 守恒（${s} = ${p.hours}）`);
  }

  // 每步不超 50
  for (const p of b.perPerson) {
    check(p.steps.every((s) => s.hours <= 50), `${p.name} 每步不超 50`);
  }

  // 不超限的人只在项目 1
  check(byName['李四'].steps[0].project === 1, '李四只出现在项目 1');
  check(byName['王五'].steps[0].project === 1, '王五只出现在项目 1');
}

console.log('\n=== 8. 分组的粘贴文本 ===');
{
  const people = [
    { name: '张三', idCard: '110101200501010017', hours: 120, remark: '支教' },
    { name: '李四', idCard: '110101200502020022', hours: 8, remark: '迎新' },
  ];
  // 用 3 个项目：贪心填满 → 张三 50(P1) + 50(P2) + 20(P3)，李四 8 全在 P1
  const b = buildMultiProjectBatches(people, 3);

  check(b.groups.length === 3, `共 3 组（实际 ${b.groups.length}）`);
  check(b.groups[0].items.length === 2, '第 1 组 2 项（张三50 + 李四8）');
  check(b.groups[1].items.length === 1, '第 2 组只有张三');
  check(b.groups[1].items[0].name === '张三', '第 2 组是张三');

  for (const g of b.groups) {
    const lines = g.text.split('\n');
    check(lines.length === g.items.length, `第${g.group}组文本行数 = 项数`);
    check(lines.every((l) => l.split(',').length === 4), `第${g.group}组每行 4 列`);
    check(g.items.every((x) => x.hours > 0), `第${g.group}组没有 0 小时的项`);
    check(sum(g.items.map((x) => x.hours)) === g.hours, `第${g.group}组时长自洽`);
  }

  // 所有人所有组加起来 = 原始总时长
  const all = b.groups.flatMap((g) => g.items.map((x) => x.hours));
  check(sum(all) === 128, `全部相加 128h（实际 ${sum(all)}）`);

  // 贪心填满时，每个项目里同一人只录一次 → 都不需要"分多次"
  check(b.groups.every((g) => g.multiRound === false),
    '项目足够时不出现「同一项目内多次录入」');

  // 轮次视图：3 个项目都在第 1 轮（当天）
  check(b.rounds.length === 3, `3 个轮次（实际 ${b.rounds.length}）`);
  check(b.rounds[0].earliestLabel === '现在', '第 1 轮现在就能录');
  for (const r of b.rounds) {
    check(r.earliest === 0, `第${r.round}轮都在当天（实际 ${r.earliest}h）`);
    check(r.items.every((x) => x.hours <= 50), `第${r.round}轮每项 ≤50`);
    check(r.projects.length >= 1, `第${r.round}轮标明了涉及的项目`);
  }

  // 完成时间：3 个项目够用 → 当天
  check(b.finishHour === 0, `全部录完当天（实际 ${b.finishHour}h）`);

  // 换成 2 个项目：就会出现"同一项目内等第二轮"
  const b2 = buildMultiProjectBatches(people, 2);
  check(b2.finishHour === 120, `2 个项目时 5 天完成（实际 ${b2.finishHour}h）`);
  const p1 = b2.groups.find((g) => g.group === 1);
  const zhangInP1 = p1.items.filter((x) => x.name === '张三');
  check(zhangInP1.length === 2, '2 个项目时张三在项目 1 里要录两次');
  check(zhangInP1[1].atHour === 120, `第二次排在 120h 后（实际 ${zhangInP1[1].atHour}）`);
  check(p1.multiRound === true, '项目 1 标记「需分多次」');
}

console.log('\n=== 9. 分组标签不能冒充项目名 ===');
{
  const b = buildMultiProjectBatches(
    [{ name: '张三', idCard: '110101200501010017', hours: 120, remark: 'x' }], 3
  );
  // 只是编号，不能是"某某活动"这种看起来像真实项目名的东西
  check(b.groups.every((g) => /^项目 \d+$/.test(g.label)),
    '标签形如「项目 N」（纯编号，不冒充真实项目名）',
    b.groups.map((g) => g.label).join(', '));
}

console.log('\n=== 10. 边界与异常 ===');
{
  const r = splitAcrossProjects(80, 0);
  check(r.ok === false, '项目数 0 → 拒绝');
  const r2 = splitAcrossProjects(80, -1);
  check(r2.ok === false, '负数 → 拒绝');
  const r3 = splitAcrossProjects(80, 1.5);
  check(r3.ok === false, '非整数 → 拒绝');

  // 项目太少时明确说不够
  const r4 = splitAcrossProjects(200, 2);
  check(r4.ok === false, '200h 分 2 个 → 拒绝（每份 100 > 50）');
  check(/不够分|超过/.test(r4.reason || ''), '拒绝时说明原因', r4.reason);

  // 0 小时
  const r5 = splitAcrossProjects(0, 2);
  check(r5.ok === true && sum(r5.parts) === 0, '0 小时不报错');

  // 小数
  const r6 = splitAcrossProjects(7.5, 2);
  check(r6.ok === true && sum(r6.parts) === 7.5, '小数守恒');

  const b = buildMultiProjectBatches([], 3);
  check(b.groups.length === 0, '空名单 → 无分组');
}

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
