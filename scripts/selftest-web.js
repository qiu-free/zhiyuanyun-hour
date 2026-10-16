/**
 * Web API 自检（用 Node 直接请求，排除 PowerShell 编码干扰）
 * 用法：先启动 server，再运行 node scripts/selftest-web.js
 */

const BASE = process.env.BASE || 'http://127.0.0.1:5180';

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`); }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return { status: res.status, data: await res.json() };
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), ct };
}

const SAMPLE = `暑期迎新志愿服务名单
补录原因：暑期迎新志愿服务活动

张三 2025213817 110101200501010017 8
李四，2024213884，110101200502020022，8小时
姓名：王五 学号：2025213761 身份证：110101200503030038 时长：8
赵六|2024213879|110101200504040043|8
孙八 2023213829 110101200505050059 12.5小时
合计 5 人`;

console.log('=== 1. 健康检查 ===');
{
  const r = await (await fetch(BASE + '/api/health')).json();
  check(r.ok === true, '服务可用');
  check(r.maxHoursPerEntry === 50, '单次上限 50');
}

console.log('\n=== 2. 文本解析（混合格式）===');
let parsed;
{
  const r = await post('/api/parse', { text: SAMPLE });
  check(r.status === 200, 'HTTP 200');
  parsed = r.data;
  check(parsed.records.length === 5, `识别 5 条（实际 ${parsed.records.length}）`);

  const names = parsed.records.map((x) => x.name);
  check(JSON.stringify(names) === JSON.stringify(['张三', '李四', '王五', '赵六', '孙八']),
    '姓名全部正确', JSON.stringify(names));

  const hours = parsed.records.map((x) => x.hours);
  check(JSON.stringify(hours) === JSON.stringify([8, 8, 8, 8, 12.5]),
    '时长全部正确', JSON.stringify(hours));

  check(parsed.records.every((x) => /^\d{18}$/.test(x.idCard)), '身份证全部 18 位');
  check(parsed.records.every((x) => x.remark === '暑期迎新志愿服务活动'), '备注来自文本的自带原因');
  check(parsed.records.every((x) => x.usable), '全部可用');
  check(parsed.skipped.length === 3, `跳过 3 行（实际 ${parsed.skipped.length}）`);
  check(parsed.summary.usableCount === 5, '统计可用 5');
  check(parsed.summary.totalHours === 44.5, `合计 44.5 小时（实际 ${parsed.summary.totalHours}）`);
}

console.log('\n=== 3. 缺原因时应标记 missing ===');
{
  const r = await post('/api/parse', { text: '张三 110101200501010017 8' });
  check(r.data.records[0].status === 'missing', '状态为 missing');
  check(r.data.records[0].usable === false, '不可用');
  check(r.data.summary.missing === 1, '统计 missing=1');
}

console.log('\n=== 4. 指定原因后可用 ===');
{
  const r = await post('/api/parse', { text: '张三 110101200501010017 8', reason: '测试活动' });
  check(r.data.records[0].usable === true, '变得可用');
  check(r.data.records[0].remark === '测试活动', '原因写入备注');
}

console.log('\n=== 5. 错误数据应被标出 ===');
{
  const r = await post('/api/parse', {
    text: `甲某 110101200501010010 8 备注：ok
乙某 110101200501010017 8 备注：含,逗号`,
    reason: '',
  });
  const recs = r.data.records;
  check(recs[0].status === 'error', '身份证校验位错 → error');
  check(recs[0].problems.some((p) => p.message.includes('校验位')), '提示校验位错误');
  check(recs[1].status === 'error', '备注含逗号 → error');
  check(recs[1].problems.some((p) => p.message.includes('逗号')), '提示逗号问题');
}

console.log('\n=== 5b. warn 必须独立成档，不能降级为 ok ===');
{
  // 15 位老身份证会触发 warn
  const r = await post('/api/parse', {
    text: `赵某 110101850101123 8 备注：测试`,
  });
  const rec = r.data.records[0];
  check(rec.problems.some((p) => p.level === 'warn'), '确实产生了 warn');
  check(rec.status === 'warn', `status 应为 warn（实际 ${rec.status}）`);
  check(rec.usable === true, 'warn 的行仍可导出');
  check(r.data.summary.warn === 1, '统计里 warn 计数为 1');
  check(r.data.summary.ok === 0, 'warn 不计入 ok');
  check(r.data.summary.usableCount === 1, 'warn 计入可用总数');
}

console.log('\n=== 6. 粘贴文本格式（前端用同样规则本地生成）===');
{
  // 后端已不提供 /api/export/txt（前端用 Blob 本地生成，少一次往返）。
  // 这里直接按前端同样的拼装规则验证格式。
  const lines = parsed.records.map((r) => [r.name, r.idCard, r.hours, r.remark].join(','));
  const text = lines.join('\n');
  check(lines.length === 5, '5 行');
  check(lines.every((l) => l.split(',').length === 4), '每行 4 列');
  check(lines[0].startsWith('张三,'), '首行以姓名开头');
  check(!text.includes('\r'), '无 CR');
  check(!text.startsWith('\uFEFF'), '无 BOM');
  // 与后端 renderLine 输出保持一致
  const { renderLine } = await import('../src/server/api.js');
  check(renderLine(parsed.records[0]) === lines[0], '与后端 renderLine 规则一致');
}

console.log('\n=== 7. 导出 Excel ===');
{
  const r = await post('/api/export/xlsx', { records: parsed.records });
  check(r.status === 200, 'HTTP 200');
  check(r.buffer && r.buffer.length > 1000, `返回 ${r.buffer?.length} 字节`);
  check(r.buffer[0] === 0x50 && r.buffer[1] === 0x4b, '是合法 xlsx（PK 头）');
  check(/spreadsheetml/.test(r.ct), 'Content-Type 正确');
}

console.log('\n=== 8. 排期 ===');
{
  const recs = [
    { name: '甲', hours: 8, usable: true },
    { name: '乙', hours: 45, usable: true },
    { name: '丙', hours: 80, usable: true },
  ];
  const r = await post('/api/schedule', { records: recs, strategy: 'few' });
  check(r.data.ok === true, '排期成功');
  check(r.data.perPerson.find((p) => p.name === '丙').batchCount === 2, '80h 分 2 批');
  check(r.data.perPerson.find((p) => p.name === '甲').batchCount === 1, '8h 一次录完');
  check(r.data.groups.length >= 1, `共 ${r.data.groups.length} 批`);
  check(typeof r.data.finishLabel === 'string', '有完成时间说明');
}

console.log('\n=== 9. 超过单次上限（50 小时）的处理 ===');
{
  // 早期版本把 >50 当 error 并丢掉时长，用户看不到总数也不知道要分两次录
  const r = await post('/api/parse', {
    text: `张三 110101200501010017 80 备注：全年服务\n李四 110101200502020022 8 备注：迎新`,
    reason: '',
  });
  const [zhang, li] = r.data.records;

  check(zhang.status === 'split', `80h → split（实际 ${zhang.status}）`);
  check(zhang.hours === 80, `80h 被保留（实际 ${zhang.hours}）`);
  check(zhang.usable === true, 'split 的行仍可用');
  check(zhang.needsSplit === true, '标记 needsSplit');
  check(zhang.splitBatches === 2, '需分 2 次');

  check(li.status === 'ok' && li.needsSplit === false, '8h 不受影响');
  check(r.data.summary.totalHours === 88, `合计 88h（实际 ${r.data.summary.totalHours}）`);
  check(r.data.summary.oneShotCount === 1, '可一次录完 1 人');
  check(r.data.summary.needsSplitCount === 1, '需分批 1 人');
  check(r.data.summary.split === 1, '统计里 split=1');
}

console.log('\n=== 10. 分批方案接口 /api/batches ===');
{
  const text = `张三 110101200501010017 80 备注：全年服务
李四 110101200502020022 8 备注：迎新
王五 110101200503030038 120 备注：支教`;
  const parsed = await post('/api/parse', { text, reason: '' });

  const b = await post('/api/batches', { records: parsed.data.records, strategy: 'few' });
  check(b.data.ok === true, '接口成功');
  check(b.data.maxPerEntry === 50, '单次上限 50');
  check(b.data.rounds.length === 3, `共 3 轮（实际 ${b.data.rounds.length}）`);

  // 第 1 轮：一次性的人 + 超限人的第一批
  const r1 = b.data.rounds[0];
  check(r1.items.length === 3, `第1轮 3 人（实际 ${r1.items.length}）`);
  check(r1.earliest === 0, '第1轮现在就能录');
  check(r1.items.find((x) => x.name === '李四').hours === 8, '李四 8h 在第1轮');
  check(r1.items.find((x) => x.name === '张三').hours === 50, '张三第1轮录 50h');
  check(r1.items.find((x) => x.name === '王五').hours === 50, '王五第1轮录 50h');

  // 第 2 轮
  const r2 = b.data.rounds[1];
  check(r2.items.length === 2, `第2轮 2 人（实际 ${r2.items.length}）`);
  check(r2.earliest === 120, `第2轮要等 120 小时（实际 ${r2.earliest}）`);
  check(r2.items.find((x) => x.name === '张三').hours === 30, '张三第2轮录 30h');

  // 第 3 轮
  const r3 = b.data.rounds[2];
  check(r3.items.length === 1, '第3轮只有王五');
  check(r3.items[0].hours === 20, '王五第3轮录 20h');
  check(r3.earliest === 240, `第3轮要等 240 小时（实际 ${r3.earliest}）`);

  // 每轮的粘贴文本必须格式正确
  for (const round of b.data.rounds) {
    const lines = round.text.split('\n');
    check(lines.length === round.items.length,
      `第${round.round}轮文本行数与人数一致`);
    check(lines.every((l) => l.split(',').length === 4),
      `第${round.round}轮每行 4 列`);
  }

  // 每人总时长必须守恒（分批求和 = 原始时长）
  for (const p of b.data.plans) {
    const sum = Math.round(p.batches.reduce((s, x) => s + x.hours, 0) * 10) / 10;
    check(sum === p.totalHours, `${p.name} 分批之和 ${sum} = 总时长 ${p.totalHours}`);
    check(p.batches.every((x) => x.hours <= 50), `${p.name} 每批都不超 50`);
  }

  check(b.data.finishLabel.includes('天'), `有可读完成时间（${b.data.finishLabel}）`);
}

console.log('\n=== 11. 没有超限人员时 /api/batches 应明确报错 ===');
{
  const r = await post('/api/batches', {
    records: [{ name: '张三', hours: 8, usable: true, needsSplit: false, remark: 'x', idCard: '110101200501010017' }],
  });
  check(r.status !== 200 || r.data.ok === false, '不返回成功结果');
  check(/不需要分批|没有超/.test(r.data.error || ''), `错误信息说明原因（${r.data.error}）`);
}

console.log('\n=== 12. 多项目分流接口 /api/multi-project ===');
{
  const text = `张三 110101200501010017 120 备注：支教
李四 110101200502020022 8 备注：迎新
王五 110101200503030038 50 备注：清扫`;
  const parsed = await post('/api/parse', { text, reason: '' });
  const m = await post('/api/multi-project', { records: parsed.data.records });

  check(m.data.ok === true, '接口成功');
  check(m.data.maxPerEntry === 50, '单次上限 50');
  check(m.data.neededProjects === 3, `需要 3 个项目（实际 ${m.data.neededProjects}）`);

  // 只对超限的人做对比
  check(m.data.compare.length === 1, `只对 1 人做对比（实际 ${m.data.compare.length}）`);
  const c = m.data.compare[0];
  check(c.name === '张三', '对比对象是张三');
  check(c.single.finishHours === 240, `单项目要等 240h（实际 ${c.single.finishHours}）`);
  check(c.multi.projectCount === 3, '分流需 3 个项目');
  check(c.multi.finishHours === 0, `分流后当天完成（实际 ${c.multi.finishHours}）`);
  check(c.savedHours === 240, `省 240 小时（实际 ${c.savedHours}）`);
  check(c.canFinishSameDay === true, '项目够用时 canFinishSameDay=true');
  check(Math.round(c.multi.parts.reduce((s, x) => s + x, 0) * 10) / 10 === 120, '分流后总和守恒');

  // 分组
  check(m.data.groups.length === 3, `3 个分组（实际 ${m.data.groups.length}）`);
  check(m.data.groups[0].items.length === 3, '第1组 3 人（含不超限的两人）');
  check(m.data.groups[1].items.length === 1, '第2组只有张三');

  // 不超限的人不能被拆散
  const li = m.data.perPerson.find((p) => p.name === '李四');
  check(li.split === false, '李四未被拆分');
  check(li.parts.length === 1 && li.parts[0].hours === 8,
    `李四仍是 8h 一条（实际 ${JSON.stringify(li.parts)}）`);
  const wang = m.data.perPerson.find((p) => p.name === '王五');
  check(wang.split === false, '王五（正好 50h）未被拆分');
  check(wang.parts.length === 1 && wang.parts[0].hours === 50, '王五保持 50h 一条');

  // 每人守恒（parts 现在是 {project, hours, atHour}）
  for (const p of m.data.perPerson) {
    const s = Math.round(p.parts.reduce((a, b) => a + b.hours, 0) * 10) / 10;
    check(s === p.totalHours, `${p.name} 守恒（${s} = ${p.totalHours}）`);
    check(p.parts.every((x) => x.hours > 0 && x.hours <= 50),
      `${p.name} 每步都在 1~50`);
    check(p.parts.every((x) => x.project >= 1 && x.project <= m.data.usedProjects),
      `${p.name} 的项目编号合法`);
    check(p.parts.every((x) => x.atHour >= 0), `${p.name} 的时间点非负`);
  }

  // 3 个项目够用 → 全部当天，无需等待
  check(m.data.finishHours === 0, `3 个项目时当天完成（实际 ${m.data.finishHours}）`);
  check(m.data.finishLabel === '现在', `完成标签为「现在」（实际 ${m.data.finishLabel}）`);
  check(m.data.rounds.length >= 1, '有轮次视图');
  check(m.data.rounds[0].projects.length >= 1, '轮次标明了涉及的项目');

  // 每行 4 列
  for (const g of m.data.groups) {
    check(g.text.split('\n').every((l) => l.split(',').length === 4), `第${g.group}组每行 4 列`);
  }

  // 必须提醒项目名要真实
  check(/真实|不能虚构/.test(m.data.notice || ''), '提示了项目名必须真实存在');

  // 指定项目数不够时：用混合策略（换项目 + 等待），不生成超 50 的数据
  const m2 = await post('/api/multi-project', { records: parsed.data.records, projects: 2 });
  check(m2.data.usedProjects === 2, '可指定项目数（2 个）');
  check(m2.data.projectsShort === true, '明确标记「项目不够当天录完」');
  // 2 个项目时：当天各录 50，等 5 天后再录 —— 5 天完成（而非单项目的 10 天）
  check(m2.data.finishHours === 120, `2 个项目时 5 天完成（实际 ${m2.data.finishHours}h）`);

  const zhang2 = m2.data.perPerson.find((p) => p.name === '张三');
  check(zhang2.parts.every((x) => x.hours <= 50),
    `没有任何一步超 50（${zhang2.parts.map((x) => x.hours).join(', ')}）`);
  const sum2 = Math.round(zhang2.parts.reduce((a, b) => a + b.hours, 0) * 10) / 10;
  check(sum2 === 120, `2 个项目下仍守恒（${sum2}）`);
  check(zhang2.parts.some((x) => x.atHour === 0), '有当天就能录的部分');
  check(zhang2.parts.some((x) => x.atHour > 0), '也有需要等的部分');

  // 所有分组里的时长都必须在合法范围
  for (const g of m2.data.groups) {
    check(g.items.every((x) => x.hours > 0 && x.hours <= 50),
      `第${g.group}组时长都在 1~50 之间`);
  }

  // 项目够用时不报 problems，且当天完成
  const m3 = await post('/api/multi-project', { records: parsed.data.records, projects: 3 });
  check(m3.data.projectsShort === false, '项目够用 → projectsShort=false');
  check(m3.data.problems.length === 0, '项目够用 → 没有 problems');
  check(m3.data.finishHours === 0, '项目够用 → 当天完成');
}

console.log('\n=== 13. 没人超限时 /api/multi-project 应明确报错 ===');
{
  const r = await post('/api/multi-project', {
    records: [{ name: '张三', hours: 8, usable: true, needsSplit: false, remark: 'x', idCard: '110101200501010017' }],
  });
  check(r.status !== 200 || r.data.ok === false, '不返回成功结果');
  check(/不需要换项目|没有超过/.test(r.data.error || ''), `说明原因（${r.data.error}）`);
}

console.log('\n=== 14. 安全：目录穿越应被拒 ===');
{
  const res = await fetch(BASE + '/../package.json');
  const txt = await res.text();
  check(res.status === 404 || res.status === 403 || !txt.includes('"name"'), '无法读取上级文件');
}

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
