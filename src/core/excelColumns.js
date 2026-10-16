/**
 * 表格列识别（纯函数，不依赖 Node）
 *
 * 从这里拆出来的原因：
 *   原来这些函数放在 excel.js 里，而 excel.js 顶层 import 了 node:path
 *   （读本地文件用）。浏览器版要复用列识别逻辑，就会连带把 node:path
 *   拖进来，直接报错。
 *   所以把「不碰文件系统」的部分单独放这里，Node 和浏览器都能用。
 *
 * excel.js 会重新导出这里的 detectColumns / detectHeaderRow，
 * 所以原有的 import 写法不受影响。
 */

import XLSX from 'xlsx';

/**
 * 表头别名表：支持中文表头，兼容英文表头。
 * 每行第一个是标准字段名，后面是可能出现的写法。
 */
export const HEADER_ALIASES = {
  name: ['姓名', '名字', '志愿者姓名', '学生姓名', 'name', 'volunteer_name'],
  studentId: ['学号', '学生学号', '学籍号', 'student_id', 'studentid', 'stu_no', 'sno'],
  idCard: [
    '身份证号', '身份证号码', '身份证', '证件号码', '证件号',
    '公民身份号码', 'id_card', 'idcard', 'id_no', 'idno', 'cert_no', 'sfzh',
  ],
  hours: [
    '志愿时长', '服务时长', '时长', '荣誉时数值', '志愿时长(小时)',
    '志愿时长（小时）', '小时数', '服务时间', 'hours', 'hour', 'duration',
  ],
  remark: ['备注', '补录原因', '说明', '事由', '原因', 'remark', 'note', 'comment', 'reason'],
  seq: ['序号', '编号', 'no', 'seq', 'index', '#'],
};

/**
 * 把表头文本归一化后用于匹配。
 *
 * 关键：去掉括号里的补充说明。
 * 真实表格里表头常写成「身份证（记得开隐私）」「姓名(必填)」
 * 「志愿时长（小时）」，如果不剥掉括号内容，精确匹配就会失败，
 * 导致整列认不出来 —— 用户的文件正是这种情况。
 */
export function normHeader(h) {
  return String(h ?? '')
    .trim()
    // 剥掉中英文括号及其内容
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/[:：*＊、,，.。/\\|]/g, '')
    .toLowerCase();
}

/**
 * 根据实际表头，推断每个标准字段对应哪一列。
 *
 * 两轮匹配：
 *   1. 归一化后精确相等（最可靠）
 *   2. 归一化后「包含」某个别名，取最长的那个
 *      —— 处理「身份证号码（18位）」这类带前后缀的写法
 * 第二轮是兜底，因为「包含」比「相等」更容易误判，所以放在后面。
 *
 * @returns {{mapping: object, unmapped: string[], missing: string[], extra: string[]}}
 */
export function detectColumns(headers) {
  const mapping = {};
  const used = new Set();
  const norm = headers.map(normHeader);

  // ---------- 第一轮：精确匹配 ----------
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasSet = new Set(aliases.map(normHeader));
    const idx = norm.findIndex((h, i) => !used.has(i) && h && aliasSet.has(h));
    if (idx !== -1) {
      mapping[field] = idx;
      used.add(idx);
    }
  }

  // ---------- 第二轮：包含匹配（按别名长度从长到短，避免「号」抢先） ----------
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (mapping[field] !== undefined) continue;

    const sorted = [...aliases].map(normHeader).filter(Boolean).sort((a, b) => b.length - a.length);
    let best = -1;
    let bestLen = 0;

    for (let i = 0; i < norm.length; i++) {
      if (used.has(i) || !norm[i]) continue;
      for (const a of sorted) {
        // 别名要够长才敢用包含匹配（避免「号」「时」这种单字误判）
        if (a.length < 2) continue;
        if (norm[i].includes(a) && a.length > bestLen) {
          best = i;
          bestLen = a.length;
        }
      }
    }
    if (best !== -1) {
      mapping[field] = best;
      used.add(best);
    }
  }

  // 未识别的列原样保留，避免丢信息
  const extra = headers
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => !used.has(i))
    .map(({ h }) => String(h ?? '').trim())
    .filter(Boolean);

  const missing = ['name', 'idCard', 'hours'].filter((f) => mapping[f] === undefined);

  return { mapping, missing, extra };
}

/**
 * 判断一个值是否像被 Excel 破坏过的身份证号（科学计数法）。
 */
export function looksLikeScientific(v) {
  return typeof v === 'number' || /^\d+(\.\d+)?[eE][+-]?\d+$/.test(String(v ?? '').trim());
}

/**
 * 自动探测表头所在行。
 *
 * 为什么需要：真实表格往往长这样：
 *   第1行  志愿者志愿服务时长补录表      ← 标题
 *   第2行  （空行）
 *   第3行  姓名 | 学号 | 身份证号 | ...  ← 真正的表头
 *
 * 如果硬编码第 1 行，就会把标题当表头，导致「缺少必需列」。
 * 这里扫描前若干行，选出「命中已知列名最多」的一行作为表头。
 *
 * @returns {{index: number, score: number, headers: string[]}}
 */
export function detectHeaderRow(matrix, maxScan = 15) {
  const allAliases = new Set(
    Object.values(HEADER_ALIASES).flat().map(normHeader)
  );
  // 必需字段的别名单独收集，命中它们权重更高
  const requiredAliases = new Set(
    ['name', 'idCard', 'hours']
      .flatMap((f) => HEADER_ALIASES[f])
      .map(normHeader)
  );

  let best = { index: 0, score: -1, headers: [] };

  for (let r = 0; r < Math.min(maxScan, matrix.length); r++) {
    const cells = (matrix[r] || []).map((c) => String(c ?? '').trim());
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length < 2) continue; // 标题行通常只有 1 个非空单元格

    let score = 0;
    let requiredHits = 0;
    for (const cell of cells) {
      const n = normHeader(cell);
      if (!n) continue;
      if (allAliases.has(n)) score += 1;
      if (requiredAliases.has(n)) requiredHits += 1;
    }
    // 必需字段命中是强信号，给高权重
    score += requiredHits * 3;

    if (score > best.score) {
      best = { index: r, score, headers: cells };
    }
    // 已经命中全部 3 个必需字段，可以直接停
    if (requiredHits >= 3) break;
  }

  return best;
}

/**
 * 读一个工作表，转成二维数组（保留原始文本）。
 * 只用 XLSX.utils，不碰文件系统，浏览器也能跑。
 */
export function sheetToMatrix(ws) {
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
}

/**
 * 选一个有数据的工作表。
 *
 * 为什么不能直接用第一个：真实表格常把第一页做成封面或说明，
 * 数据在第二页。原来固定读 SheetNames[0]，遇到封面页就会
 * 「什么都读不到」，而用户明明看到表里有数据。
 *
 * 判定顺序：
 *   1. 显式指定就用指定的
 *   2. 第一个「能识别出表头」的表（跳过封面 / 说明页）
 *   3. 都没有表头时，退回第一个「有内容」的表
 *   4. 全空：退回第一张，让上层给出「没有数据」的提示
 *
 * 注意第 2 步不能简化成「有内容的第一个表」：
 * 封面页往往写着「XX 补录表」「制表人：某某」，是有内容的，
 * 但它没有列名。只看「有没有内容」会误选封面。
 */
export function pickSheet(wb, want) {
  if (want) {
    if (!wb.Sheets[want]) throw new Error(`找不到工作表：${want}`);
    return want;
  }

  let firstWithContent = null;

  for (const name of wb.SheetNames) {
    const m = sheetToMatrix(wb.Sheets[name]);
    const hasContent = m.some((row) => row.some((c) => String(c ?? '').trim() !== ''));
    if (!hasContent) continue;
    if (firstWithContent === null) firstWithContent = name;

    // 能命中列名的才算数据页。阈值取 4：
    // 命中一个必需字段（1 + 3）就够，避免把恰好含「姓名」二字的说明页漏掉。
    const detected = detectHeaderRow(m);
    if (detected.score >= 4) return name;
  }

  return firstWithContent ?? wb.SheetNames[0];
}
