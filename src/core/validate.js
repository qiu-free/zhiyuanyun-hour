/**
 * 数据校验引擎
 *
 * 目标：在碰平台之前，把所有会导致「录错人」「录错时长」「提交失败」的问题全部拦下来。
 * 这一步的产出是给人看的报告，所以文案必须具体、可操作。
 */

import { validateIdCard, maskIdCard, birthFromIdCard } from './idcard.js';

export const LIMITS = {
  MAX_HOURS_PER_ENTRY: 50,
  NAME_MAX_LEN: 30,
  REASON_MAX_LEN: 200,
};

/** 解析时长，返回 {ok, value, reason} */
export function parseHours(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: '时长为空' };
  let s = String(raw).trim();
  if (!s) return { ok: false, reason: '时长为空' };

  // 全角数字 → 半角
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 去掉「小时/h/时」等单位后缀
  s = s.replace(/(小时|个小时|小时数|h|H|时|hrs?)\s*$/g, '').trim();

  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, reason: `无法解析为数字：「${raw}」` };
  }

  const value = Number(s);
  if (!Number.isFinite(value)) return { ok: false, reason: `不是有效数字：「${raw}」` };
  if (value <= 0) return { ok: false, reason: `时长必须大于 0（当前 ${value}）` };

  // 超过单次上限：这不是「数据错误」，而是「一次录不完」。
  // 必须保留数值 —— 早期版本在这里返回 ok:false，导致 80 小时被
  // 当成「缺少时长」丢掉，用户既看不到总数，也不知道要分两次录。
  if (value > LIMITS.MAX_HOURS_PER_ENTRY) {
    const rounded = Math.round(value * 10) / 10;
    const batches = Math.ceil(rounded / LIMITS.MAX_HOURS_PER_ENTRY);
    return {
      ok: true,
      value: rounded,
      overLimit: true,
      batches,
      warning:
        `共 ${rounded} 小时，超过单次上限 ${LIMITS.MAX_HOURS_PER_ENTRY} 小时，` +
        `需分 ${batches} 次录入`,
    };
  }

  // 保留一位小数，符合系统 0.5 小时最小粒度习惯
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded - value) > 1e-9) {
    return {
      ok: true,
      value: rounded,
      warning: `时长 ${value} 已按 0.1 小时取整为 ${rounded}`,
    };
  }
  return { ok: true, value: rounded };
}

/**
 * 全量校验
 * @param {Array} rows readTable 的输出
 * @returns {{valid: Array, invalid: Array, warnings: Array, stats: object}}
 */
export function validateRows(rows) {
  const valid = [];
  const invalid = [];
  const warnings = [];

  // 重复检测索引
  const byIdCard = new Map(); // 证件号 → [行]
  const byName = new Map();   // 姓名 → [行]

  for (const row of rows) {
    const errors = [];
    const warns = [];

    // ---------- 姓名 ----------
    let name = String(row.name ?? '').trim();
    if (!name) {
      errors.push('姓名为空');
    } else {
      // 去掉姓名中间的空格（「张 三」→「张三」）
      const compact = name.replace(/\s+/g, '');
      if (compact !== name) {
        warns.push(`姓名中的空格已移除：「${name}」→「${compact}」`);
        name = compact;
      }
      if (name.length > LIMITS.NAME_MAX_LEN) {
        errors.push(`姓名过长（${name.length} 字）`);
      }
      if (/[\d]/.test(name)) {
        errors.push(`姓名中含数字：「${name}」`);
      }
      // 少数民族姓名可能含「·」，属于正常
      if (!/^[\u4e00-\u9fa5·a-zA-Z\u00b7\s]+$/.test(name)) {
        warns.push(`姓名含非常规字符，请人工确认：「${name}」`);
      }
    }

    // ---------- 身份证号 ----------
    const idRes = validateIdCard(row.idCard);
    if (row.idCardIssue) {
      errors.push(row.idCardIssue);
    }
    if (!idRes.ok) {
      errors.push(`身份证号：${idRes.reason}`);
    } else if (idRes.level === 'warn') {
      warns.push(`身份证号：${idRes.reason}`);
    }

    // ---------- 时长 ----------
    const hoursRes = parseHours(row.hoursRaw);
    if (!hoursRes.ok) {
      errors.push(hoursRes.reason);
    } else if (hoursRes.warning) {
      warns.push(hoursRes.warning);
    }
    // 超过单次上限：合法数据，但一次录不完，需要分批
    const needsSplit = hoursRes.ok && hoursRes.overLimit === true;

    // ---------- 备注 / 补录原因 ----------
    const remark = String(row.remark ?? '').trim();
    if (remark.length > LIMITS.REASON_MAX_LEN) {
      errors.push(`备注过长（${remark.length} 字，上限 ${LIMITS.REASON_MAX_LEN}）`);
    }

    // ---------- 学号（不提交，仅供核对） ----------
    const studentId = String(row.studentId ?? '').trim();
    if (!studentId) {
      warns.push('学号为空中（不影响系统录入，但不利于学院内部核对）');
    }

    const enriched = {
      ...row,
      name,
      studentId,
      remark,
      hours: hoursRes.ok ? hoursRes.value : null,
      // 需要分多次录入（时长超过单次上限）
      needsSplit,
      splitBatches: needsSplit ? hoursRes.batches : 1,
      birth: idRes.ok ? birthFromIdCard(row.idCard) : '',
      idCardMasked: maskIdCard(row.idCard),
      errors,
      warnings: warns,
    };

    if (errors.length === 0) {
      valid.push(enriched);
    } else {
      invalid.push(enriched);
    }

    // 建立索引（用原始值建，便于发现完全重复）
    if (row.idCard) {
      if (!byIdCard.has(row.idCard)) byIdCard.set(row.idCard, []);
      byIdCard.get(row.idCard).push(enriched);
    }
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(enriched);
    }
  }

  // ---------- 重复检测 ----------
  // (a) 同一身份证号出现多次 → 一定是重复行
  for (const [idCard, list] of byIdCard) {
    if (list.length > 1) {
      const rowsText = list.map((r) => `第${r.excelRow}行`).join('、');
      for (const r of list) {
        r.errors.push(`身份证号 ${maskIdCard(idCard)} 重复出现（${rowsText}）`);
      }
      warnings.push({
        level: 'error',
        kind: 'duplicate-idcard',
        message: `身份证号 ${maskIdCard(idCard)} 在 ${rowsText} 重复出现，同一人同一项目只需录一次`,
      });
    }
  }

  // (b) 同姓名但不同身份证号 → 重名，必须用证件号区分，不能靠姓名匹配
  for (const [name, list] of byName) {
    const distinctIds = new Set(list.map((r) => r.idCard).filter(Boolean));
    if (list.length > 1 && distinctIds.size > 1) {
      const rowsText = list.map((r) => `第${r.excelRow}行(${r.idCardMasked})`).join('、');
      for (const r of list) {
        r.warnings.push(`存在同名志愿者（${rowsText}），已按身份证号区分，请确认无误`);
      }
      warnings.push({
        level: 'warn',
        kind: 'duplicate-name',
        message: `姓名「${name}」对应 ${distinctIds.size} 个不同身份证号（${rowsText}）`,
      });
    }
  }

  // 重复标记过的行，若原本在 valid 里，需要移到 invalid
  const movedToInvalid = [];
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].errors.length > 0) {
      movedToInvalid.push(valid[i]);
      valid.splice(i, 1);
    }
  }
  invalid.push(...movedToInvalid);

  // 稳定排序，便于对照 Excel
  valid.sort((a, b) => a.excelRow - b.excelRow);
  invalid.sort((a, b) => a.excelRow - b.excelRow);

  const totalHours = valid.reduce((s, r) => s + (r.hours || 0), 0);

  return {
    valid,
    invalid,
    warnings,
    stats: {
      total: rows.length,
      validCount: valid.length,
      invalidCount: invalid.length,
      totalHours: Math.round(totalHours * 10) / 10,
      // 超过单次上限、需要分多次录入的人数（这些是合法数据，不是错误）
      needsSplitCount: valid.filter((r) => r.needsSplit).length,
    },
  };
}

/** 生成 Markdown 报告 */
export function renderReport(result, meta = {}) {
  const { valid, invalid, warnings, stats } = result;
  const L = [];

  L.push('# 数据校验报告');
  L.push('');
  if (meta.file) L.push(`- 源文件：\`${meta.file}\``);
  if (meta.sheet) L.push(`- 工作表：\`${meta.sheet}\``);
  L.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push('');

  L.push('## 总览');
  L.push('');
  L.push('| 项目 | 数值 |');
  L.push('|---|---|');
  L.push(`| 总行数 | ${stats.total} |`);
  L.push(`| ✅ 校验通过 | ${stats.validCount} |`);
  L.push(`| ❌ 存在问题 | ${stats.invalidCount} |`);
  L.push(`| 合计时长 | ${stats.totalHours} 小时 |`);
  L.push('');

  if (stats.invalidCount > 0) {
    L.push(`> **有 ${stats.invalidCount} 行未通过校验，请不要提交，先修正数据。**`);
    L.push('');
  } else if (stats.validCount > 0) {
    L.push('> ✅ 全部通过校验，可以进入下一步。');
    L.push('');
  }

  if (invalid.length) {
    L.push('## ❌ 需要修复的行');
    L.push('');
    L.push('| Excel 行号 | 姓名 | 学号 | 身份证号 | 时长 | 问题 |');
    L.push('|---|---|---|---|---|---|');
    for (const r of invalid) {
      const errs = r.errors.join('；');
      L.push(
        `| ${r.excelRow} | ${r.name || '—'} | ${r.studentId || '—'} | ` +
        `${r.idCardMasked || '—'} | ${r.hoursRaw || '—'} | ${errs} |`
      );
    }
    L.push('');
  }

  if (valid.length) {
    L.push('## ✅ 校验通过的行');
    L.push('');
    L.push('| Excel 行号 | 姓名 | 学号 | 身份证号 | 时长 | 备注 |');
    L.push('|---|---|---|---|---|---|');
    for (const r of valid) {
      L.push(
        `| ${r.excelRow} | ${r.name} | ${r.studentId || '—'} | ` +
        `${r.idCardMasked} | ${r.hours} | ${(r.remark || '').slice(0, 40) || '—'} |`
      );
    }
    L.push('');
  }

  const rowWarns = [...valid, ...invalid].filter((r) => r.warnings.length);
  if (rowWarns.length || warnings.length) {
    L.push('## ⚠️ 提示（不影响提交，但建议确认）');
    L.push('');
    const seen = new Set();
    for (const w of warnings) {
      if (seen.has(w.message)) continue;
      seen.add(w.message);
      L.push(`- ${w.level === 'error' ? '❌' : '⚠️'} ${w.message}`);
    }
    for (const r of rowWarns) {
      for (const w of r.warnings) {
        const line = `第${r.excelRow}行 ${r.name}：${w}`;
        if (seen.has(line)) continue;
        seen.add(line);
        L.push(`- ${line}`);
      }
    }
    L.push('');
  }

  return L.join('\n');
}
