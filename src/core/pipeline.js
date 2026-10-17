/**
 * 业务流水线（纯逻辑，Node 与浏览器共用）
 *
 * 为什么单独一层：
 *   原来这些逻辑写在 server/api.js 里，浏览器用不了，
 *   于是前端只能通过 HTTP 向后端要结果 —— 这意味着
 *   使用者的身份证号要发到服务器。
 *
 *   抽到这里之后，两边共用同一份实现：
 *     • server/api.js    —— 包一层 HTTP（CLI / 测试用）
 *     • web/localApi.js  —— 直接在浏览器里算（静态网站用）
 *   纯静态站点因此可以做到「数据不离开浏览器」。
 *
 * 这一层不碰 HTTP、不碰文件系统、不碰 Buffer，只接收普通对象。
 */

import { parseText, guessGlobalRemark } from './parseText.js';
import { validateIdCard, maskIdCard } from './idcard.js';
import { parseHours, LIMITS } from './validate.js';
import { splitBatches, waitHoursFor, hoursFromNowLabel, TIME_LOCK } from './schedule.js';
import { comparePlans, buildMultiProjectBatches } from './multiProject.js';
import { checkField, SEP } from './paste.js';

export const MAX_HOURS = LIMITS.MAX_HOURS_PER_ENTRY;

/**
 * 把一条原始输入行统一成标准记录，并附上问题标记。
 *
 * @param {object} raw  {name, idCard, hours, remark, lineNo, rawText}
 * @param {string} fallbackReason 统一补录原因
 * @returns {object} 带 problems 的记录
 */
export function normalizeRecord(raw, fallbackReason = '') {
  const problems = [];

  const name = String(raw.name ?? '').trim();
  const idCard = String(raw.idCard ?? '').trim();
  const remark = String(raw.remark ?? '').trim() || String(fallbackReason ?? '').trim();
  // 解析阶段的提示：身份证「位数不对」这类具体原因比笼统的
  // 「缺少身份证号」有用得多（用户一眼就知道是多了还是少了一位）
  const parseIssues = Array.isArray(raw.issues) ? raw.issues : [];

  // ---------- 姓名 ----------
  if (!name) {
    problems.push({ field: 'name', level: 'error', message: '姓名为空' });
  } else if (name.length > 30) {
    problems.push({ field: 'name', level: 'error', message: `姓名过长（${name.length} 字）` });
  }

  // ---------- 身份证 ----------
  if (!idCard) {
    // 优先用解析阶段给出的具体原因
    const specific = parseIssues.find((s) => /身份证号位数不对/.test(s));
    problems.push({
      field: 'idCard',
      level: 'error',
      message: specific || '缺少身份证号',
    });
  } else if (/\*/.test(idCard)) {
    problems.push({ field: 'idCard', level: 'error', message: '身份证号被打码，需要真实号码' });
  } else {
    const v = validateIdCard(idCard);
    if (!v.ok) {
      problems.push({ field: 'idCard', level: 'error', message: v.reason });
    } else if (v.level === 'warn') {
      problems.push({ field: 'idCard', level: 'warn', message: v.reason });
    }
  }

  // ---------- 时长 ----------
  let hours = raw.hours;
  let needsSplit = false;
  let splitBatchesCount = 1;
  if (hours === null || hours === undefined || hours === '') {
    problems.push({ field: 'hours', level: 'error', message: '缺少时长' });
    hours = null;
  } else {
    const r = parseHours(hours);
    if (!r.ok) {
      problems.push({ field: 'hours', level: 'error', message: r.reason });
      hours = null;
    } else {
      hours = r.value;
      if (r.overLimit) {
        // 超过单次上限不是数据错误，是「一次录不完」。
        // 数值必须保留，否则用户看不到总数、也不知道要分几次。
        needsSplit = true;
        splitBatchesCount = r.batches;
        problems.push({
          field: 'hours',
          level: 'split',
          message: r.warning,
        });
      } else if (r.warning) {
        problems.push({ field: 'hours', level: 'warn', message: r.warning });
      }
    }
  }

  // ---------- 备注 / 补录原因 ----------
  if (!remark) {
    problems.push({
      field: 'remark',
      level: 'missing',
      message: '缺少「补录原因」（系统必填，需向发起人确认）',
    });
  } else {
    const chk = checkField(remark, '备注');
    if (!chk.ok) {
      problems.push({ field: 'remark', level: 'error', message: chk.reason, fix: chk.fix });
    }
  }

  const hasError = problems.some((p) => p.level === 'error');
  const hasMissing = problems.some((p) => p.level === 'missing');
  const hasWarn = problems.some((p) => p.level === 'warn');
  const hasSplit = problems.some((p) => p.level === 'split');

  return {
    id: raw.id ?? null,
    lineNo: raw.lineNo ?? null,
    rawText: raw.rawText ?? '',
    name,
    idCard,
    idCardMasked: idCard ? maskIdCard(idCard) : '',
    hours,
    remark,
    studentId: String(raw.studentId ?? '').trim(),
    // 一行挤多人时：这一条是从哪一行拆出来的、还原片段是什么
    segment: raw.segment ?? '',
    sharedLine: raw.sharedLine === true,
    anchorIndex: raw.anchorIndex ?? null,
    anchorCount: raw.anchorCount ?? null,
    // 时长超过单次上限，需要分多次录入
    needsSplit,
    splitBatches: splitBatchesCount,
    problems,
    // 五级状态，必须与前端 app.js 的 STATUS_META 一致：
    // error > missing > split > warn > ok
    status: hasError ? 'error'
      : hasMissing ? 'missing'
        : hasSplit ? 'split'
          : hasWarn ? 'warn' : 'ok',
    // 只有 error / missing 才不可用；
    // split 是合法数据，只是不能一次录完；warn 仍可导出
    usable: !hasError && !hasMissing,
  };
}

/** 给一批记录算统计 */
export function summarize(records) {
  const usable = records.filter((r) => r.usable);
  const total = usable.reduce((s, r) => s + (r.hours || 0), 0);
  const counts = { total: records.length, ok: 0, warn: 0, split: 0, error: 0, missing: 0 };
  for (const r of records) counts[r.status] = (counts[r.status] || 0) + 1;

  // 超过单次上限的人：给出分批方案，并算出总等待时间
  const needSplit = usable
    .filter((r) => r.needsSplit)
    .map((r) => {
      const batches = splitBatches(r.hours, 'few');
      return {
        name: r.name,
        hours: r.hours,
        batches: batches.map((b) => ({ hours: b.hours, waitAfter: b.waitAfter })),
        batchCount: batches.length,
        // 最后一批录完不再等待
        elapsed: batches.reduce((s, b) => s + b.waitAfter, 0),
        elapsedLabel: hoursFromNowLabel(batches.reduce((s, b) => s + b.waitAfter, 0)),
      };
    })
    .sort((a, b) => b.hours - a.hours);

  // 单次就能录完的人（这些才是「现在能一次粘贴掉」的）
  const oneShot = usable.filter((r) => !r.needsSplit);

  return {
    ...counts,
    usableCount: usable.length,
    // 可直接一次性录入的人数与时长
    oneShotCount: oneShot.length,
    oneShotHours: Math.round(oneShot.reduce((s, r) => s + (r.hours || 0), 0) * 10) / 10,
    totalHours: Math.round(total * 10) / 10,
    needSplit,
    needsSplitCount: needSplit.length,
    lockNote: needSplit.length
      ? `${needSplit.length} 人超过 50 小时，需分 ${Math.max(...needSplit.map((x) => x.batchCount))} 次录入`
      : '全部可一次录完',
  };
}

/** 记录 → 粘贴文本行（前端也用同样规则，保持一致） */
export function renderLine(rec) {
  return [rec.name, rec.idCard, String(rec.hours), rec.remark].join(SEP);
}

// ============================================================
// 各接口的纯逻辑实现
// ============================================================

/**
 * 找出重复的人。
 *
 * 为什么必须在「出粘贴文本之前」拦住：
 *   同一个身份证号在一份名单里出现两次，粘到后台就会给同一人录两次时长。
 *   这不会报错——后台会照单全收，结果是这个人的时长凭空翻倍，
 *   而且录进去之后改起来很麻烦。所以宁可拦下来让用户确认。
 *
 * 只把「后出现的那些」标成不可用，第一份保留可用：
 *   · 用户大多是想录一次，第一份通常是对的
 *   · 全部标红会让人以为整批都不能用
 *   · 界面上会明确指出「与第 X 行重复」，用户自己删掉多余那行即可
 *
 * @param {Array} records normalizeRecord 产出的记录
 * @returns {{records: Array, duplicates: Array}}
 */
export function markDuplicates(records) {
  /** 身份证号 → 第一次出现的记录 */
  const seenIdCard = new Map();
  /** 姓名 → 出现过的记录（用于同名不同证的重名提醒） */
  const byName = new Map();
  /** 完全相同的行（姓名+证号+时长+备注）→ 高度可疑 */
  const seenExact = new Map();

  const duplicates = [];

  for (const r of records) {
    // ---------- 同一身份证号出现多次 ----------
    if (r.idCard && !/\*/.test(r.idCard)) {
      const first = seenIdCard.get(r.idCard);
      if (first) {
        // 附到记录上，界面可以标红并说明和哪一行重了
        r.duplicateOf = first.lineNo ?? null;
        r.duplicateKind = 'idCard';
        r.problems.push({
          field: 'idCard',
          level: 'error',
          message: `与第 ${first.lineNo ?? '?'} 行是同一人（身份证号相同），重复录入会让时长翻倍`,
        });
        // 重新计算状态：重复属于 error，必须不可用
        r.status = 'error';
        r.usable = false;
        duplicates.push({
          kind: 'idCard',
          idCard: r.idCard,
          name: r.name,
          lineNo: r.lineNo,
          firstLineNo: first.lineNo ?? null,
        });
      } else {
        seenIdCard.set(r.idCard, r);
      }
    }

    // ---------- 姓名的重名情况（不同身份证号）----------
    if (r.name) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }

    // ---------- 完全相同的行 ----------
    // 姓名+证号+时长+备注全一样，基本是复制粘贴时重复了。
    // 证号相同的上面已经处理过，这里主要防「同一人同一条录了两遍」被当成两条不同数据。
    if (r.name && r.idCard && r.hours !== null && r.hours !== undefined) {
      const key = [r.name, r.idCard, r.hours, r.remark].join('\u0001');
      const first = seenExact.get(key);
      if (first && !r.duplicateOf) {
        r.duplicateOf = first.lineNo ?? null;
        r.duplicateKind = 'exact';
        r.problems.push({
          field: 'name',
          level: 'error',
          message: `与第 ${first.lineNo ?? '?'} 行完全相同（姓名、证号、时长、备注都一样）`,
        });
        r.status = 'error';
        r.usable = false;
        duplicates.push({
          kind: 'exact',
          name: r.name,
          idCard: r.idCard,
          lineNo: r.lineNo,
          firstLineNo: first.lineNo ?? null,
        });
      } else if (!first) {
        seenExact.set(key, r);
      }
    }
  }

  // ---------- 同名但不同证号：不是错误，但要提醒 ----------
  // 重名很常见（尤其同名同姓的同学），靠姓名匹配会录错人，
  // 所以这里只提醒「确认是靠身份证号区分的」，不拦。
  const sameNameWarnings = [];
  for (const [name, list] of byName) {
    const distinctIds = new Set(list.map((r) => r.idCard).filter((v) => v && !/\*/.test(v)));
    if (distinctIds.size > 1) {
      const rows = list.map((r) => `第 ${r.lineNo ?? '?'} 行（${r.idCardMasked || '无证号'}）`).join('、');
      for (const r of list) {
        if (r.usable) {
          r.problems.push({
            field: 'name',
            level: 'warn',
            message: `姓名「${name}」对应 ${distinctIds.size} 个不同身份证号（${rows}），已按证号区分，请确认`,
          });
          if (r.status === 'ok') r.status = 'warn';
        }
      }
      sameNameWarnings.push({
        name,
        count: distinctIds.size,
        rows,
        message: `姓名「${name}」对应 ${distinctIds.size} 个不同身份证号，请确认不是录错人`,
      });
    }
  }

  return { records, duplicates, sameNameWarnings };
}

/**
 * 把重复检测应用到结果上，并刷新汇总。
 * parseTextResult / tableToRecords 都走这里，保证两条入口行为一致。
 */
function applyDuplicates(records) {
  const { duplicates, sameNameWarnings } = markDuplicates(records);
  return { records, duplicates, sameNameWarnings, summary: summarize(records) };
}

/** 文本 → 记录列表 */
export function parseTextResult({ text = '', reason = '' } = {}) {
  if (typeof text !== 'string') throw new Error('text 必须是字符串');

  const parsed = parseText(text);
  const globalRemark = guessGlobalRemark(text);
  const fallback = String(reason).trim() || globalRemark;

  const raw = parsed.records.map((r, i) =>
    normalizeRecord(
      {
        id: `r${i}`,
        lineNo: r.lineNo,
        rawText: r.raw,
        name: r.name,
        idCard: r.idCard,
        hours: r.hours,
        remark: r.remark,
        studentId: r.studentId,
        // 解析阶段的提示（如身份证位数不对），供 normalizeRecord 给出更准确的原因
        issues: r.issues,
        // 「一行挤多人」时携带的信息，供界面提示与核对
        segment: r.segment,
        sharedLine: r.sharedLine,
        anchorIndex: r.anchorIndex,
        anchorCount: r.anchorCount,
      },
      fallback
    )
  );

  const applied = applyDuplicates(raw);

  return {
    records: applied.records,
    skipped: parsed.skipped,
    warnings: parsed.warnings,
    // 哪些行没有换行、被自动拆成了几人
    splitLines: parsed.splitLines,
    guessedRemark: globalRemark,
    duplicates: applied.duplicates,
    sameNameWarnings: applied.sameNameWarnings,
    summary: applied.summary,
  };
}

/** 已解析的表格 → 记录列表（readTable / readTableFromBuffer 的输出都能用） */
export function tableToRecords({ table, reason = '' } = {}) {
  const fallback = String(reason).trim();
  const raw = table.rows.map((row, i) =>
    normalizeRecord(
      {
        id: `r${i}`,
        lineNo: row.excelRow,
        rawText: table.headers.map((h, ci) => `${h}=${row._cells?.[ci] ?? ''}`).join(' | '),
        name: row.name,
        idCard: row.idCard,
        hours: row.hoursRaw,
        remark: row.remark,
        studentId: row.studentId,
      },
      fallback
    )
  );

  const applied = applyDuplicates(raw);

  return {
    records: applied.records,
    sheetName: table.sheetName,
    sheetNames: table.sheetNames,
    mapping: table.mapping,
    headers: table.headers,
    missingColumns: table.missing,
    duplicates: applied.duplicates,
    sameNameWarnings: applied.sameNameWarnings,
    summary: applied.summary,
  };
}

/** 记录 → 排期 */
export function scheduleResult({ records = [], strategy = 'few' } = {}) {
  const list = records.filter((r) => r.usable);
  if (!list.length) throw new Error('没有可用于排期的记录');

  const perPerson = list.map((r) => {
    const batches = splitBatches(r.hours, strategy);
    const elapsed = batches.reduce((s, b) => s + b.waitAfter, 0);
    return {
      name: r.name,
      hours: r.hours,
      batches,
      batchCount: batches.length,
      elapsed,
      elapsedLabel: hoursFromNowLabel(elapsed),
      firstLock: waitHoursFor(Math.min(r.hours, MAX_HOURS)),
    };
  });

  // 按批次分组
  const maxBatches = perPerson.reduce((m, p) => Math.max(m, p.batchCount), 0);
  const groups = [];
  for (let i = 0; i < maxBatches; i++) {
    const items = [];
    for (const p of perPerson) {
      if (i < p.batches.length) {
        let elapsed = 0;
        for (let k = 0; k < i; k++) elapsed += p.batches[k].waitAfter;
        items.push({ name: p.name, hours: p.batches[i].hours, earliest: elapsed });
      }
    }
    if (items.length) {
      const earliest = Math.min(...items.map((x) => x.earliest));
      groups.push({
        batch: i + 1,
        earliest,
        earliestLabel: earliest <= 0 ? '现在' : hoursFromNowLabel(earliest),
        items,
      });
    }
  }

  const finishHours = perPerson.reduce((m, p) => Math.max(m, p.elapsed), 0);

  return {
    strategy,
    groups,
    perPerson,
    maxBatches,
    finishHours,
    finishLabel: finishHours <= 0 ? '一次即可完成' : hoursFromNowLabel(finishHours),
    totalHours: Math.round(list.reduce((s, r) => s + r.hours, 0) * 10) / 10,
  };
}

/** 记录 → 分批方案（时长超过单次上限时） */
export function batchesResult({ records = [], strategy = 'few' } = {}) {
  const usable = records.filter((r) => r.usable);
  if (!usable.length) throw new Error('没有可用的记录');

  const oneShot = usable.filter((r) => !r.needsSplit);
  const splitOnes = usable.filter((r) => r.needsSplit);

  if (!splitOnes.length) {
    throw new Error('没有超过单次上限的人员，不需要分批');
  }

  // 每人的批次表
  const plans = splitOnes.map((r) => {
    const batches = splitBatches(r.hours, strategy);
    return { rec: r, batches, batchCount: batches.length };
  });

  const maxRounds = Math.max(...plans.map((p) => p.batchCount));
  const rounds = [];

  for (let i = 0; i < maxRounds; i++) {
    const items = [];

    // 第 1 轮：加上「一次就能录完」的人（时间锁是每人独立的，互不影响）
    if (i === 0) {
      for (const r of oneShot) {
        items.push({
          name: r.name,
          idCard: r.idCard,
          hours: r.hours,
          remark: r.remark,
          fromSplit: false,
          earliest: 0,
        });
      }
    }

    for (const p of plans) {
      if (i >= p.batches.length) continue;
      // 到第 i 轮时，这个人已经等了前面所有批次的等待时间
      let earliest = 0;
      for (let k = 0; k < i; k++) earliest += p.batches[k].waitAfter;
      items.push({
        name: p.rec.name,
        idCard: p.rec.idCard,
        hours: p.batches[i].hours,
        remark: p.rec.remark,
        fromSplit: true,
        totalHours: p.rec.hours,
        batchNo: i + 1,
        batchCount: p.batchCount,
        earliest,
      });
    }

    if (!items.length) continue;

    const earliest = Math.min(...items.map((x) => x.earliest));
    rounds.push({
      round: i + 1,
      earliest,
      earliestLabel: earliest <= 0 ? '现在' : hoursFromNowLabel(earliest),
      items,
      // 这一轮可以直接粘贴的文本
      text: items.map((x) => [x.name, x.idCard, x.hours, x.remark].join(SEP)).join('\n'),
      hours: Math.round(items.reduce((s, x) => s + Number(x.hours), 0) * 10) / 10,
    });
  }

  const finishHours = Math.max(
    ...plans.map((p) => p.batches.reduce((s, b) => s + b.waitAfter, 0))
  );

  return {
    strategy,
    rounds,
    plans: plans.map((p) => ({
      name: p.rec.name,
      totalHours: p.rec.hours,
      batchCount: p.batchCount,
      batches: p.batches,
      elapsed: p.batches.reduce((s, b) => s + b.waitAfter, 0),
      elapsedLabel: hoursFromNowLabel(p.batches.reduce((s, b) => s + b.waitAfter, 0)),
    })),
    finishHours,
    finishLabel: hoursFromNowLabel(finishHours),
    maxPerEntry: MAX_HOURS,
    timeLock: TIME_LOCK,
  };
}

/** 记录 → 多项目分流方案 */
export function multiProjectResult({ records = [], projects } = {}) {
  const usable = records.filter((r) => r.usable);
  if (!usable.length) throw new Error('没有可用的记录');

  const over = usable.filter((r) => r.needsSplit || Number(r.hours) > MAX_HOURS);
  if (!over.length) {
    throw new Error(`没有超过 ${MAX_HOURS} 小时的人员，不需要换项目分流`);
  }

  // 每个人算两套方案：留在单项目（要等）vs 分流到多项目（当天）
  // 传 projects 让 comparePlans 知道用户实际有几个项目可用
  const compare = over
    .map((r) => {
      const c = comparePlans(r.hours, Number.isInteger(projects) && projects >= 1 ? projects : undefined);
      return {
        name: r.name,
        idCard: r.idCard,
        remark: r.remark,
        totalHours: r.hours,
        single: {
          batches: c.single.batches,
          batchCount: c.single.batchCount,
          finishHours: c.single.finishHour,
          finishLabel: c.single.finishLabel,
        },
        multi: {
          projectCount: c.multi.projectCount,
          parts: c.multi.parts,
          ok: c.multi.ok,
          reason: c.multi.reason,
          finishHours: c.multi.finishHour,
          finishLabel: c.multi.finishLabel,
        },
        // 实际可用项目数下的最优混合安排
        actual: {
          projectCount: c.actual.projectCount,
          perProject: c.actual.perProject,
          steps: c.actual.steps,
          finishHour: c.actual.finishHour,
          finishLabel: c.actual.finishLabel,
          canSameDay: c.actual.canSameDay,
          savedHours: c.actual.savedHours,
          savedLabel: c.actual.savedLabel,
        },
        usedProjects: c.usedProjects,
        canFinishSameDay: c.canFinishSameDay,
        savedHours: c.savedHours,
        savedLabel: c.savedLabel,
        enoughProjects: c.enoughProjects,
      };
    })
    .sort((a, b) => b.totalHours - a.totalHours);

  // 整批需要几个项目才能当天录完
  const maxNeeded = Math.max(...compare.map((x) => x.multi.projectCount));
  // 项目够用就用够用的数；不够则按用户说的来，混合排期会自动补上等待
  const useProjects = Number.isInteger(projects) && projects >= 1
    ? projects
    : maxNeeded;

  const built = buildMultiProjectBatches(usable, Math.max(1, useProjects));

  return {
    maxPerEntry: MAX_HOURS,
    // 只对超限的人做分流说明
    compare,
    neededProjects: maxNeeded,
    usedProjects: Math.max(1, useProjects),
    // 项目数不够（会用「换项目 + 等待」的混合方案，不是不能做）
    projectsShort: maxNeeded > Math.max(1, useProjects),
    groups: built.groups,
    // 按时间轮次的操作顺序
    rounds: built.rounds,
    finishHours: built.finishHour,
    finishLabel: built.finishLabel,
    perPerson: built.perPerson.map((p) => ({
      name: p.name,
      totalHours: p.hours,
      split: p.split,
      parts: p.steps.map((s) => ({ project: s.project, hours: s.hours, atHour: s.atHour })),
    })),
    problems: built.problems,
    // 明确提醒：项目必须真实存在
    notice: '「项目 N」只是占位编号。每一组要贴到不同的真实项目里，' +
      '项目名必须是你实际有的活动，不能虚构。',
  };
}
