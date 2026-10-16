/**
 * 批量粘贴文本生成
 *
 * 这是当前的主路线。
 *
 * 平台后台的「批量导入」不是上传文件，而是一个文本框：
 * 你把数据按行粘进去，系统解析后批量录入时长。
 *
 * 经用户确认的格式：
 *   每人一行，英文逗号分隔，四列依次为：
 *     姓名,身份证号,时长,备注
 *
 *   张三,110101200501011239,8,2025年迎新志愿服务
 *   李四,130102200503152342,12.5,社区环境卫生清扫
 *
 * ⚠️ 最大的风险：备注里如果含英文逗号，会把这一行切成 5 段以上，
 *    导致后面的列错位（时长被当备注、备注被当下一列），
 *    轻则导入失败，重则把时长录到错误的人或错误的数值上。
 *    所以这里必须检测并给出明确处理，绝不静默放过。
 */

/** 列分隔符 */
export const SEP = ',';

/**
 * 检测一个字段是否含分隔符或其他会破坏行结构的内容。
 * @returns {{ok:boolean, reason?:string, fix?:string}}
 */
export function checkField(value, fieldName) {
  const v = String(value ?? '');

  if (v.includes(SEP)) {
    return {
      ok: false,
      reason: `${fieldName}中含英文逗号：${v}`,
      fix: '把逗号换成顿号「、」或分号「;」，例如「迎新,社区」→「迎新、社区」',
    };
  }
  if (v.includes('\n') || v.includes('\r')) {
    return {
      ok: false,
      reason: `${fieldName}中含换行符`,
      fix: '把换行去掉，改成空格或顿号',
    };
  }
  if (v.includes('\t')) {
    return {
      ok: false,
      reason: `${fieldName}中含制表符`,
      fix: '把制表符换成空格',
    };
  }
  return { ok: true };
}

/**
 * 把一行数据渲染成粘贴文本。
 *
 * 关于「备注 / 补录原因」：
 * 这是系统必填项，也是要写进志愿者档案的正式记录。
 * 本模块**不会**用任何默认值去填补缺失的备注 —— 缺失就是缺失，
 * 由调用方（CLI）停下来向发起人报告，而不是猜测。
 * 只有调用方明确传入一个已获确认的原因时，才会用它。
 *
 * @returns {{text:string, ok:boolean, problems:Array}}
 */
export function renderLine(row, opts = {}) {
  // 注意：没有默认值。未提供就是空字符串，会在下面被判为缺失。
  const { defaultReason = '' } = opts;
  const problems = [];

  const name = String(row.name ?? '').trim();
  const idCard = String(row.idCard ?? '').trim();
  const hours = row.hours;

  // 备注优先级：表格里的值 > 调用方明确传入的确认值 > 空（判为缺失）
  const rowRemark = String(row.remark ?? '').trim();
  const fallback = String(defaultReason ?? '').trim();
  const remark = rowRemark || fallback;

  // 逐字段检测
  for (const [val, label] of [
    [name, '姓名'],
    [idCard, '身份证号'],
    [remark, '备注'],
  ]) {
    const r = checkField(val, label);
    if (!r.ok) problems.push({ field: label, ...r });
  }

  // 备注缺失 —— 必须报备，不能猜
  if (!remark) {
    problems.push({
      field: '备注',
      ok: false,
      missing: true,
      reason: '缺少「补录原因」（系统必填）',
      fix: '请向发起人确认本次补录原因，再回填表格或用 --reason 指定',
    });
  }

  // 时长必须是纯数字，不能带单位、不能有逗号
  const hoursStr = String(hours ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(hoursStr)) {
    problems.push({
      field: '时长',
      ok: false,
      reason: `时长不是纯数字：${hoursStr}`,
      fix: '去掉「小时」等单位，只保留数字',
    });
  }

  const text = [name, idCard, hoursStr, remark].join(SEP);

  return { text, ok: problems.length === 0, problems };
}

/**
 * 先把备注里的英文逗号自动替换掉（可选自动修复）。
 * 只在用户明确同意时使用，避免擅自改动数据。
 */
export function autoFixRemark(remark) {
  return String(remark ?? '')
    .replace(/,/g, '、')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\t/g, ' ')
    .trim();
}

/**
 * 生成完整的粘贴文本。
 *
 * 拦截分两类，分别返回：
 *   blocked  —— 数据有问题（含分隔符、格式错），需要修正
 *   missing  —— 缺少必填信息（目前只有备注），需要向发起人报备
 *
 * 两类都不会进入输出文本。没有默默填充这回事。
 *
 * @param {Array} rows 校验通过的人员
 * @param {{defaultReason?:string, autoFix?:boolean}} opts
 * @returns {{text:string, lines:Array, blocked:Array, missing:Array, fixed:Array}}
 */
export function buildPasteText(rows, opts = {}) {
  // 注意：defaultReason 没有默认值。
  // 只有调用方（经用户 --reason 明确指定或 .env 配置）才会传进来。
  const { defaultReason = '', autoFix = false } = opts;

  const lines = [];
  const blocked = [];
  const missing = [];
  const fixed = [];

  for (const row of rows) {
    let r = row;

    if (autoFix) {
      const originalRemark = String(row.remark ?? '').trim();
      if (originalRemark) {
        const fixedRemark = autoFixRemark(originalRemark);
        if (fixedRemark !== originalRemark) {
          r = { ...row, remark: fixedRemark };
          fixed.push({
            name: row.name,
            excelRow: row.excelRow,
            from: originalRemark,
            to: fixedRemark,
          });
        }
      }
    }

    const rendered = renderLine(r, { defaultReason });

    if (rendered.ok) {
      lines.push({ ...rendered, row: r });
      continue;
    }

    // 拆分：是「缺信息」还是「数据有错」
    const isMissing = rendered.problems.some((p) => p.missing);
    const otherProblems = rendered.problems.filter((p) => !p.missing);

    if (isMissing && otherProblems.length === 0) {
      // 纯粹缺备注 —— 需要报备，不是数据错误
      missing.push({
        row,
        field: '备注',
        note: rendered.problems.find((p) => p.missing)?.fix || '',
      });
    } else {
      blocked.push({
        row,
        problems: otherProblems.length ? otherProblems : rendered.problems,
        text: rendered.text,
      });
    }
  }

  return {
    text: lines.map((l) => l.text).join('\n'),
    lines,
    blocked,
    missing,
    fixed,
  };
}

/** 生成核对用汇总信息 */
export function summarize(rows) {
  const total = rows.reduce((s, r) => s + (r.hours || 0), 0);
  return {
    count: rows.length,
    totalHours: Math.round(total * 10) / 10,
  };
}
