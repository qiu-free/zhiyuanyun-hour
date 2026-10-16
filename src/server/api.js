/**
 * API 处理层
 *
 * 复用已有的核心模块，不重复实现业务逻辑：
 *   core/parseText.js  —— 任意文本抽取
 *   core/idcard.js     —— 身份证校验
 *   core/validate.js   —— 时长/重复等校验
 *   core/schedule.js   —— 时间锁排期
 *   core/paste.js      —— 粘贴文本生成
 *
 * 接口一览：
 *   POST /api/parse      文本 → 记录列表（含问题标记）
 *   POST /api/upload     xlsx → 记录列表
 *   POST /api/export/txt 记录列表 → 粘贴文本
 *   POST /api/export/xlsx 记录列表 → Excel
 *   POST /api/schedule   记录列表 → 排期
 */

import XLSX from 'xlsx';
import { parseText, guessGlobalRemark } from '../core/parseText.js';
import { validateIdCard, maskIdCard } from '../core/idcard.js';
import { parseHours, LIMITS } from '../core/validate.js';
import { splitBatches, waitHoursFor, hoursFromNowLabel, TIME_LOCK } from '../core/schedule.js';
import { comparePlans, buildMultiProjectBatches } from '../core/multiProject.js';
import { checkField, SEP } from '../core/paste.js';

const MAX_HOURS = LIMITS.MAX_HOURS_PER_ENTRY;

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
  let splitBatches = 1;
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
        splitBatches = r.batches;
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
    splitBatches,
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
// 路由
// ============================================================

export async function handleApi(pathname, method, bodyBuf, searchParams) {
  const parseJson = () => {
    if (!bodyBuf || !bodyBuf.length) return {};
    try {
      return JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  };

  // ---------- 文本解析 ----------
  if (pathname === '/api/parse' && method === 'POST') {
    const { text = '', reason = '' } = parseJson();
    if (typeof text !== 'string') throw new Error('text 必须是字符串');

    const parsed = parseText(text);
    const globalRemark = guessGlobalRemark(text);
    const fallback = String(reason).trim() || globalRemark;

    const records = parsed.records.map((r, i) =>
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

    return {
      data: {
        ok: true,
        records,
        skipped: parsed.skipped,
        warnings: parsed.warnings,
        // 哪些行没有换行、被自动拆成了几人
        splitLines: parsed.splitLines,
        guessedRemark: globalRemark,
        summary: summarize(records),
      },
    };
  }

  // ---------- Excel 上传 ----------
  if (pathname === '/api/upload' && method === 'POST') {
    const { filename = 'upload.xlsx', base64 = '', reason = '' } = parseJson();
    if (!base64) throw new Error('没有收到文件内容');

    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      throw new Error('文件内容解码失败');
    }
    if (!buf.length) throw new Error('文件是空的');

    // 用已有的 excel 读取逻辑
    const { readTableFromBuffer } = await import('../core/excelBuffer.js');
    const table = readTableFromBuffer(buf, { filename });

    const fallback = String(reason).trim();
    const records = table.rows.map((row, i) =>
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

    return {
      data: {
        ok: true,
        records,
        sheetName: table.sheetName,
        sheetNames: table.sheetNames,
        mapping: table.mapping,
        headers: table.headers,
        missingColumns: table.missing,
        summary: summarize(records),
      },
    };
  }

  // ---------- 导出 Excel ----------
  // 注：.txt 导出由前端用 Blob 本地生成，不需要后端接口（少一次往返）。
  // 这里只保留 Excel 导出，因为 xlsx 必须用后端库生成。
  if (pathname === '/api/export/xlsx' && method === 'POST') {
    const { records = [] } = parseJson();
    const list = records.filter((r) => r.usable);
    if (!list.length) throw new Error('没有可导出的记录');

    const aoa = [
      ['姓名', '身份证号', '志愿时长', '备注'],
      ...list.map((r) => [r.name, r.idCard, r.hours, r.remark]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // 身份证列设为文本，防止 Excel 转科学计数法
    for (let i = 0; i < list.length; i++) {
      const ref = XLSX.utils.encode_cell({ r: i + 1, c: 1 });
      if (ws[ref]) ws[ref].t = 's';
    }
    ws['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 10 }, { wch: 36 }];

    // 第二个表：带学号的核对表
    const audit = [
      ['序号', '姓名', '学号', '身份证号', '时长', '备注'],
      ...list.map((r, i) => [i + 1, r.name, r.studentId || '', r.idCard, r.hours, r.remark]),
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(audit);
    for (let i = 0; i < list.length; i++) {
      const ref = XLSX.utils.encode_cell({ r: i + 1, c: 3 });
      if (ws2[ref]) ws2[ref].t = 's';
    }
    ws2['!cols'] = [{ wch: 7 }, { wch: 14 }, { wch: 14 }, { wch: 24 }, { wch: 8 }, { wch: 36 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '录入模板');
    XLSX.utils.book_append_sheet(wb, ws2, '核对表');
    const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return {
      binary: true,
      buffer: out,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `志愿云录入模板-${ts}.xlsx`,
    };
  }

  // ---------- 排期 ----------
  if (pathname === '/api/schedule' && method === 'POST') {
    const { records = [], strategy = 'few' } = parseJson();
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
      data: {
        ok: true,
        strategy,
        groups,
        perPerson,
        maxBatches,
        finishHours,
        finishLabel: finishHours <= 0 ? '一次即可完成' : hoursFromNowLabel(finishHours),
        totalHours: Math.round(list.reduce((s, r) => s + r.hours, 0) * 10) / 10,
      },
    };
  }

  // ---------- 分批方案（时长超过单次上限时）----------
  if (pathname === '/api/batches' && method === 'POST') {
    const { records = [], strategy = 'few' } = parseJson();
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
      data: {
        ok: true,
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
      },
    };
  }

  // ---------- 多项目分流（用「换项目」绕过时间锁）----------
  if (pathname === '/api/multi-project' && method === 'POST') {
    const { records = [], projects } = parseJson();
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
      data: {
        ok: true,
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
      },
    };
  }

  // ---------- 健康检查 ----------
  if (pathname === '/api/health' && method === 'GET') {
    return { data: { ok: true, version: '1.2.0', maxHoursPerEntry: MAX_HOURS } };
  }

  return null;
}
