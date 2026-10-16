/**
 * 多项目分流：用「换项目」绕过时间锁
 *
 * 背景（用户实测确认）：
 *   时间锁是「同一人在同一项目」的限制。所以把同一个人的时长拆到
 *   两个不同项目里，两个项目**互不等待**，可以同一天录完。
 *   志愿者的总时长 = 各项目之和，会正常累计。
 *
 * 举例（总时长 120 小时）：
 *   只用 1 个项目 → 50h 等 5 天 → 50h 等 5 天 → 20h     共 10 天
 *   分到 3 个项目 → 50h + 50h + 20h，全都在今天         当天完成
 *
 * 核心规律：**每个项目最多录 50 小时，所以每 50 小时需要一个项目。**
 *   ceil(T / 50) = 需要的项目数，这样能全部当天录完。
 *
 * 重要限定：
 *   1. 「换项目」不是无成本的 —— 你得**真的有**那么多项目可用，
 *      而且志愿者的档案里会分散在多条项目记录里。
 *      所以这里只**算给你看**，不替你决定。
 *   2. 项目必须有真实依据（真实活动）。本模块不生成、不虚构项目名。
 */

import { MAX_PER_ENTRY, hoursFromNowLabel } from './schedule.js';

/**
 * 只用一个项目时，需要多少批、多久
 * @param {number} total 总时长
 */
export function singleProjectPlan(total) {
  const batches = [];
  let remain = Math.round(total * 10) / 10;
  let waited = 0;

  while (remain > 0.001) {
    const take = Math.round(Math.min(MAX_PER_ENTRY, remain) * 10) / 10;
    batches.push({ hours: take, atHour: waited });
    remain = Math.round((remain - take) * 10) / 10;
    if (remain > 0.001) waited += waitFor(take);
  }

  return {
    batches,
    projectCount: 1,
    finishHour: Math.max(0, ...batches.map((b) => b.atHour)),
    batchCount: batches.length,
  };
}

/** 单批时长 → 等待小时（与 schedule.js 保持一致） */
function waitFor(hours) {
  const table = [
    { max: 10, wait: 24 },
    { max: 20, wait: 48 },
    { max: 30, wait: 72 },
    { max: 40, wait: 96 },
    { max: 50, wait: 120 },
  ];
  for (const t of table) if (hours <= t.max) return t.wait;
  return 120;
}

/**
 * 把总时长尽量均分到 n 个项目（每个都不超 50），实现当天录完。
 *
 * 为什么要均分而不是「每个塞满 50，最后一个装剩下的」：
 *   均分后每份更小，万一某个项目当天录不了，还有调整余地；
 *   而且看起来更自然（不会一个项目 50、另一个项目 2）。
 *   但若 T 不是 n 的整数倍，无法完全均分，就取最接近的分配。
 *
 * @param {number} total
 * @param {number} n 项目数
 * @returns {{parts:number[], ok:boolean, reason?:string}}
 */
export function splitAcrossProjects(total, n) {
  const T = Math.round(total * 10) / 10;
  if (!Number.isInteger(n) || n < 1) {
    return { parts: [], ok: false, reason: '项目数必须是正整数' };
  }

  const base = Math.floor((T / n) * 10) / 10;
  const parts = new Array(n).fill(base);

  // 余数补到前面几个项目，保证总和精确
  let diff = Math.round((T - base * n) * 10) / 10;
  let i = 0;
  while (diff > 0.001 && i < n) {
    const add = Math.min(0.1, Math.round(diff * 10) / 10);
    parts[i] = Math.round((parts[i] + add) * 10) / 10;
    diff = Math.round((diff - add) * 10) / 10;
    i++;
  }

  const maxPart = Math.max(...parts);
  if (maxPart > MAX_PER_ENTRY) {
    return {
      parts,
      ok: false,
      reason: `${n} 个项目不够分：平均每份 ${base}h，仍超过单次上限 ${MAX_PER_ENTRY}h`,
    };
  }
  return { parts, ok: true };
}

/**
 * 混合策略：同时用「多个项目」和「等待」，让完成时间最短。
 *
 * 为什么需要它：
 *   早期实现把「原地分批」和「换项目分流」当成二选一，于是当项目数
 *   不够时直接退回单项目 —— 这是次优解。
 *
 *   例：120 小时，手上有 2 个项目。
 *     只用 1 个项目        → 50 等5天 50 等5天 20       共 10 天
 *     强行均分到 2 个项目  → 60 + 60，每份超 50，不可行
 *     混合（最优）        → P1 录 50，P2 录 50（当天录完 100）
 *                          等 5 天后 P1 再录 20        共 5 天
 *
 * 算法：每次挑「最早能录」的那个项目，尽量录满 50。
 *   这是贪心，但对本题是准确的：项目之间只差解锁时间，
 *   优先用空着的项目永远不会比等一个空闲项目更差。
 *
 * @param {number} total 总时长
 * @param {number} projectCount 可用项目数
 * @returns {{steps:Array, finishHour:number, projectCount:number}}
 *   steps: [{project, hours, atHour}]，按时间先后
 */
export function hybridPlan(total, projectCount) {
  const T = Math.round(Number(total) * 10) / 10;
  const P = Math.max(1, Math.floor(projectCount) || 1);

  if (!(T > 0)) {
    return { steps: [], finishHour: 0, projectCount: P };
  }

  const free = new Array(P).fill(0);   // 每个项目的下次可录时刻
  const steps = [];
  let remain = T;

  while (remain > 0.001) {
    // 挑最早能录的项目（并列时取编号靠前的，保证结果稳定）
    let pi = 0;
    for (let i = 1; i < P; i++) if (free[i] < free[pi]) pi = i;

    const atHour = free[pi];
    const take = Math.round(Math.min(MAX_PER_ENTRY, remain) * 10) / 10;

    steps.push({ project: pi + 1, hours: take, atHour });
    free[pi] = atHour + waitFor(take);
    remain = Math.round((remain - take) * 10) / 10;
  }

  return {
    steps,
    // 最后一批录完不再等待
    finishHour: Math.max(0, ...steps.map((s) => s.atHour)),
    projectCount: P,
  };
}

/**
 * 让总时长全部录完所需的最少项目数（假设不等）。
 * 规律：每 50 小时需要一个项目。
 */
export function minProjectsForSameDay(total) {
  const T = Math.max(0, Math.round(total * 10) / 10);
  if (T <= MAX_PER_ENTRY) return 1;
  return Math.ceil(T / MAX_PER_ENTRY);
}

/**
 * 给出某个人的方案对比。
 *
 * 三个层次（都要算出来，用户自己权衡）：
 *   1. single  —— 只用 1 个项目，纯等待
 *   2. ideal   —— 项目足够多，当天全部录完所需
 *   3. actual  —— 你实际有几个项目，混合「换项目 + 等待」的最优安排
 *
 * 早期版本只有 1 和 2，项目不够时直接退回 1（次优）。
 * 现在 3 才是给你用的方案。
 *
 * @param {number} total 总时长
 * @param {number} [availableProjects] 你实际有几个项目可用（可选）
 */
export function comparePlans(total, availableProjects) {
  const T = Math.round(total * 10) / 10;

  const single = singleProjectPlan(T);
  const need = minProjectsForSameDay(T);
  const available = Number.isInteger(availableProjects) && availableProjects >= 1
    ? availableProjects
    : null;
  const enough = available === null ? null : available >= need;

  // 理想：项目足够，当天录完
  const idealParts = need > 1 ? splitAcrossProjects(T, need) : { parts: [T], ok: true };

  // 实际：用你手上的项目数做混合排期
  const useP = available === null ? need : available;
  const hybrid = hybridPlan(T, useP);
  const canSameDay = hybrid.finishHour === 0;

  // 每个项目分到多少（把 hybrid 的多次录入按项目归并）
  const perProject = [];
  for (let i = 1; i <= useP; i++) {
    const mine = hybrid.steps.filter((s) => s.project === i);
    if (!mine.length) continue;
    perProject.push({
      project: i,
      totalHours: Math.round(mine.reduce((s, x) => s + x.hours, 0) * 10) / 10,
      times: mine.map((s) => s.hours),
      firstAtHour: Math.min(...mine.map((s) => s.atHour)),
      lastAtHour: Math.max(...mine.map((s) => s.atHour)),
      // 需要分多次录的项目（第一次录完要等）
      multiRound: mine.length > 1,
    });
  }

  return {
    total: T,

    // 方案一：只用 1 个项目
    single: {
      ...single,
      finishLabel: hoursFromNowLabel(single.finishHour),
    },

    // 方案二：理想情况（项目管够）
    multi: {
      projectCount: need,
      parts: idealParts.parts,
      ok: idealParts.ok,
      reason: idealParts.reason,
      finishHour: 0,
      finishLabel: '当天可录完',
    },

    // 方案三：实际可用项目数下的最优混合安排
    actual: {
      projectCount: useP,
      perProject,
      steps: hybrid.steps,
      finishHour: hybrid.finishHour,
      finishLabel: hoursFromNowLabel(hybrid.finishHour),
      canSameDay,
      // 相比只用 1 个项目省了多少
      savedHours: single.finishHour - hybrid.finishHour,
      savedLabel: hoursFromNowLabel(Math.max(0, single.finishHour - hybrid.finishHour)),
    },

    usedProjects: useP,
    enoughProjects: enough,
    canFinishSameDay: canSameDay,
    // 兼容旧字段
    savedHours: single.finishHour - hybrid.finishHour,
    savedLabel: hoursFromNowLabel(Math.max(0, single.finishHour - hybrid.finishHour)),
    fallback: null,
  };
}

/**
 * 把一批人按「多项目分流」排出直接可粘贴的文本。
 *
 * 关键设计：
 *   1. **只拆分确实需要拆分的人**（时长 > 50）。
 *      8 小时的人被拆成 2.7+2.7+2.6 毫无意义，只会让档案多出废记录。
 *   2. **用混合策略排期**：既有多个项目、又接受等待，
 *      能做多少当天录就做多少，剩下的排到解锁之后。
 *      项目不够时**不会硬塞**（那会生成超 50 的无效数据）。
 *
 * @param {Array<{name,idCard,hours,remark}>} people
 * @param {number} projectCount 可用项目数
 * @returns {{groups: Array, rounds: Array, ok: boolean, problems: string[]}}
 */
export function buildMultiProjectBatches(people, projectCount) {
  const problems = [];

  if (!Number.isInteger(projectCount) || projectCount < 1) {
    return { groups: [], rounds: [], ok: false, problems: ['项目数必须是正整数'], perPerson: [] };
  }

  const perPerson = people.map((p) => {
    const T = Math.round(Number(p.hours) * 10) / 10;

    // 不超限 → 原样放第 1 个项目，不拆分
    if (T <= MAX_PER_ENTRY) {
      return {
        ...p, hours: T, split: false,
        steps: [{ project: 1, hours: T, atHour: 0 }],
        finishHour: 0,
      };
    }

    // 超限 → 混合排期（能分几个项目就分几个，不够的等）
    const h = hybridPlan(T, projectCount);
    return {
      ...p, hours: T, split: true,
      steps: h.steps,
      finishHour: h.finishHour,
    };
  });

  // ---------- 按时间轮次组织（用户按轮次操作）----------
  // 每个人在自己的第 k 次录入时，对应某个项目的某一次
  const maxSteps = Math.max(...perPerson.map((p) => p.steps.length), 0);
  const rounds = [];

  for (let k = 0; k < maxSteps; k++) {
    const items = [];
    for (const p of perPerson) {
      if (!p.steps[k]) continue;
      const s = p.steps[k];
      items.push({
        name: p.name, idCard: p.idCard, hours: s.hours, remark: p.remark,
        project: s.project, atHour: s.atHour,
        stepNo: k + 1, stepCount: p.steps.length,
        fromSplit: p.split,
      });
    }
    if (!items.length) continue;

    const earliest = Math.min(...items.map((x) => x.atHour));
    rounds.push({
      round: k + 1,
      earliest,
      earliestLabel: hoursFromNowLabel(earliest),
      // 这一轮涉及哪些项目
      projects: [...new Set(items.map((x) => x.project))].sort((a, b) => a - b),
      items,
      hours: Math.round(items.reduce((s, x) => s + x.hours, 0) * 10) / 10,
    });
  }

  // 每个项目一份完整文本（用户实际是「打开某个项目 → 贴它的内容」）
  const groups = [];
  for (let i = 1; i <= projectCount; i++) {
    const items = [];
    for (const p of perPerson) {
      const mine = p.steps.filter((s) => s.project === i);
      if (!mine.length) continue;
      // 同一人在同一项目里有多次录入（说明该人在这里要分两次）
      for (const s of mine) {
        items.push({
          name: p.name, idCard: p.idCard, hours: s.hours, remark: p.remark,
          splitAcrossProjects: p.split,
          partOfProject: mine.length > 1,
          partNo: mine.indexOf(s) + 1,
          partCount: mine.length,
          atHour: s.atHour,
        });
      }
    }
    if (!items.length) continue;
    groups.push({
      group: i,
      label: `项目 ${i}`,
      items,
      hours: Math.round(items.reduce((s, x) => s + x.hours, 0) * 10) / 10,
      // 该项目是否要分多次录（同一个人在这里录两回）
      multiRound: items.some((x) => x.partOfProject),
      text: items.map((x) => [x.name, x.idCard, x.hours, x.remark].join(',')).join('\n'),
    });
  }

  const finishHour = Math.max(0, ...perPerson.map((p) => p.finishHour || 0));

  return {
    groups,
    rounds,
    ok: problems.length === 0,
    problems,
    perPerson,
    finishHour,
    finishLabel: hoursFromNowLabel(finishHour),
  };
}
