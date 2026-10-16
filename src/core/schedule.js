/**
 * 时间锁排期计算
 *
 * 系统规则（2020-07 调整后）：
 *   首次录入 ≤10h   → 24h 后才能再录
 *   10h < x ≤ 20h   → 48h
 *   20h < x ≤ 30h   → 72h
 *   30h < x ≤ 40h   → 96h
 *   40h < x ≤ 50h   → 120h
 *
 * 关键结论（经自检脚本验证，见 scripts/selftest-schedule.js）：
 *
 *   「耗时」只统计批次之间的等待时间，最后一批录完不再等待。
 *   因此：
 *     - 若总时长 ≤ 50h，'few' 策略可以一次录完，等待为 0，必然最优。
 *     - 即使总时长 > 50h（如 120h），'few' 通常仍更优：
 *         120h: fast = 12批/264h  vs  few = 3批/240h
 *
 *   所以默认策略是 'few'（每批尽量大），而不是直觉上的「小步快跑」。
 *   注意：这里只优化「等待时间」，不优化「批次数量」。
 *   如果你更在意操作次数，可用 'fast'。
 */

export const TIME_LOCK = [
  { maxHours: 10, waitHours: 24 },
  { maxHours: 20, waitHours: 48 },
  { maxHours: 30, waitHours: 72 },
  { maxHours: 40, waitHours: 96 },
  { maxHours: 50, waitHours: 120 },
];

export const MAX_PER_ENTRY = 50;

/** 给定本次录入时长，返回需等待多少小时才能再次录入 */
export function waitHoursFor(hours) {
  for (const t of TIME_LOCK) {
    if (hours <= t.maxHours) return t.waitHours;
  }
  return 120;
}

/**
 * 把总时长拆成若干批次。
 *
 * @param {number} totalHours 该志愿者要录入的总时长
 * @param {'fast'|'few'} strategy
 *   few  = 每批尽量大（默认）。总时长 ≤50h 时可一次录完，等待为 0，等待耗时最短
 *   fast = 每批 ≤10h，锁定期最短，但批次多；仅在「不希望单批时长过大」时使用
 * @returns {Array<{batch: number, hours: number, waitAfter: number}>}
 */
export function splitBatches(totalHours, strategy = 'few') {
  const batches = [];
  let remaining = Math.round(totalHours * 10) / 10;

  if (remaining <= 0) return batches;

  let n = 1;
  while (remaining > 0) {
    let take;
    if (strategy === 'fast') {
      // 每批最多 10 小时（锁 24h，最短）
      take = Math.min(10, remaining);
    } else {
      // 每批尽量填满到 50
      take = Math.min(MAX_PER_ENTRY, remaining);
    }
    take = Math.round(take * 10) / 10;
    remaining = Math.round((remaining - take) * 10) / 10;
    batches.push({
      batch: n++,
      hours: take,
      waitAfter: remaining > 0 ? waitHoursFor(take) : 0,
    });
  }

  return batches;
}

/** 计算某策略下，单人从今天开始录完需要多少小时（墙上时间） */
export function totalElapsedHours(totalHours, strategy) {
  const batches = splitBatches(totalHours, strategy);
  // 最后一批录完不需要再等
  return batches.reduce((s, b) => s + b.waitAfter, 0);
}

/**
 * 为一批志愿者生成整体排期。
 * 假设同一批次内所有人可以同一天录（因为时间锁是「每人每项目」独立的，互不影响）。
 *
 * @param {Array<{name:string, hours:number, excelRow:number}>} people
 * @returns {{batches: Array, perPerson: Array, strategy: string, finishHours: number}}
 */
export function buildSchedule(people, strategy = 'few') {
  const perPerson = people.map((p) => {
    const batches = splitBatches(p.hours, strategy);
    return {
      ...p,
      batches,
      batchCount: batches.length,
      elapsed: batches.reduce((s, b) => s + b.waitAfter, 0),
    };
  });

  const maxBatches = perPerson.reduce((m, p) => Math.max(m, p.batchCount), 0);
  const batches = [];

  for (let i = 0; i < maxBatches; i++) {
    const batchNo = i + 1;
    const items = [];
    // 累计到第 i 批时，已经过去多少小时
    let offset = 0;

    for (const p of perPerson) {
      if (i < p.batches.length) {
        // 计算该人第 i 批实际发生时间：前面批次等待之和
        let elapsed = 0;
        for (let k = 0; k < i; k++) elapsed += p.batches[k].waitAfter;
        items.push({
          name: p.name,
          excelRow: p.excelRow,
          hours: p.batches[i].hours,
          earliest: elapsed,
        });
      }
    }

    if (items.length) {
      batches.push({
        batch: batchNo,
        earliestHours: Math.min(...items.map((x) => x.earliest)),
        items,
      });
    }
  }

  const finishHours = perPerson.reduce((m, p) => Math.max(m, p.elapsed), 0);

  return { batches, perPerson, strategy, finishHours };
}

/** 把「距今天 N 小时」渲染成可读时间 */
export function hoursFromNowLabel(h) {
  if (h <= 0) return '现在';
  if (h < 24) return `${h} 小时后`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r === 0 ? `${d} 天后` : `${d} 天 ${r} 小时后`;
}

/** 生成排期 Markdown */
export function renderSchedule(schedule) {
  const { batches, perPerson, strategy, finishHours } = schedule;
  const L = [];

  L.push('# 录入排期建议');
  L.push('');
  L.push(`- 策略：**${strategy === 'few' ? '每批尽量大（默认，等待耗时最短）' : '每批 ≤10 小时（批次多，锁定期短）'}**`);
  L.push(`- 预计全部录完：**${hoursFromNowLabel(finishHours)}**`);
  L.push(`- 总批次数：**${batches.length}**`);
  L.push('');
  L.push('> 说明：「完成耗时」只统计批次之间的等待时间（最后一批录完不再等待）。');
  L.push('> 单批越大，越可能一次录完，等待为 0，因此「每批尽量大」通常更快。');
  L.push('');

  // 策略对比：基于本批最长时长的那个人
  const maxP = perPerson.reduce((a, b) => (b.hours > (a?.hours ?? 0) ? b : a), null);
  if (maxP) {
    const fastBatches = splitBatches(maxP.hours, 'fast');
    const fewBatches = splitBatches(maxP.hours, 'few');
    const fastH = fastBatches.reduce((s, b) => s + b.waitAfter, 0);
    const fewH = fewBatches.reduce((s, b) => s + b.waitAfter, 0);

    L.push(`## 策略对比（以本批时长最长者「${maxP.name}」${maxP.hours}h 为例）`);
    L.push('');
    L.push('| 策略 | 批次 | 各批时长 | 完成耗时 |');
    L.push('|---|---|---|---|');
    L.push(
      `| 每批尽量大 | ${fewBatches.length} 批 | ${fewBatches.map((b) => b.hours + 'h').join(' / ')} | ${hoursFromNowLabel(fewH)} |`
    );
    L.push(
      `| 每批 ≤10h | ${fastBatches.length} 批 | ${fastBatches.map((b) => b.hours + 'h').join(' / ')} | ${hoursFromNowLabel(fastH)} |`
    );
    L.push('');
    L.push(
      fewH <= fastH
        ? `> 本批数据下，**每批尽量大**更快（${hoursFromNowLabel(fewH)} vs ${hoursFromNowLabel(fastH)}）。`
        : `> 本批数据下，**每批 ≤10h** 更快（${hoursFromNowLabel(fastH)} vs ${hoursFromNowLabel(fewH)}）。`
    );
    L.push('');
  }

  L.push('## 各批次明细');
  L.push('');
  for (const b of batches) {
    L.push(`### 第 ${b.batch} 批（最早 ${hoursFromNowLabel(b.earliestHours)}）`);
    L.push('');
    L.push('| 姓名 | Excel 行号 | 本次录入 |');
    L.push('|---|---|---|');
    for (const it of b.items) {
      L.push(`| ${it.name} | ${it.excelRow} | ${it.hours} 小时 |`);
    }
    L.push('');
  }

  // 需要跨天的人单独提示
  const multi = perPerson.filter((p) => p.batchCount > 1);
  if (multi.length) {
    L.push('## ⚠️ 需要分批录入的志愿者');
    L.push('');
    L.push('| 姓名 | 时长 | 需分 | 完成耗时 |');
    L.push('|---|---|---|---|');
    for (const p of multi.sort((a, b) => b.hours - a.hours)) {
      L.push(`| ${p.name} | ${p.hours}h | ${p.batchCount} 批 | ${hoursFromNowLabel(p.elapsed)} |`);
    }
    L.push('');
    L.push('> 这些人受系统时间锁限制，无法一次录完，请按上方批次执行。');
    L.push('');
  }

  const single = perPerson.filter((p) => p.batchCount === 1);
  if (single.length) {
    L.push(`## ✅ 可一次录完（${single.length} 人）`);
    L.push('');
    L.push(single.map((p) => `${p.name}(${p.hours}h)`).join('、'));
    L.push('');
  }

  return L.join('\n');
}
