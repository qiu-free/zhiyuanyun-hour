/**
 * 表格读取与字段映射
 *
 * 实战中最容易踩的坑：Excel 把 18 位身份证号当成数字，
 * 显示成 1.10101E+17，读出来精度就丢了。
 * 所以这里对身份证列做特殊处理：优先读单元格原始文本。
 */

import XLSX from 'xlsx';
import path from 'node:path';
import { normalizeIdCard } from './idcard.js';

/**
 * 表头别名表：支持中文表头，兼容英文表头。
 * 每行第一个是标准字段名，后面是可能出现的写法。
 */
const HEADER_ALIASES = {
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
function normHeader(h) {
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
function looksLikeScientific(v) {
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
 */
function sheetToMatrix(ws) {
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
 * 规则：显式指定就用指定的；否则用第一个「有内容」的表。
 */
function pickSheet(wb, want) {
  if (want) {
    if (!wb.Sheets[want]) throw new Error(`找不到工作表：${want}`);
    return want;
  }
  for (const name of wb.SheetNames) {
    const m = sheetToMatrix(wb.Sheets[name]);
    if (m.some((row) => row.some((c) => String(c ?? '').trim() !== ''))) return name;
  }
  // 全空：退回第一个，让上层给出「没有数据」的提示
  return wb.SheetNames[0];
}

/**
 * 读取表格文件（.xlsx / .xls / .csv），返回 { rows, headers, mapping, missing, extra, sheetName }
 *
 * @param {string} filePath
 * @param {{sheet?: string, headerRow?: number}} opts
 */
export function readTable(filePath, opts = {}) {
  const abs = path.resolve(filePath);
  const wb = XLSX.readFile(abs, {
    // 关键：cellText 让文本单元格保留原始字符串，cellDates 关闭以免日期被转换
    cellText: true,
    cellDates: false,
    raw: false,
  });

  const sheetName = pickSheet(wb, opts.sheet);
  if (!sheetName) throw new Error('表格中没有工作表');
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`找不到工作表：${sheetName}`);

  const matrix = sheetToMatrix(ws);

  // 表头行：显式指定优先，否则自动探测
  const detected = opts.headerRow === undefined ? detectHeaderRow(matrix) : null;
  const headerRow = opts.headerRow ?? detected.index;
  const headers = (matrix[headerRow] || []).map((h) => String(h ?? '').trim());

  const { mapping, missing, extra } = detectColumns(headers);

  const rows = [];
  for (let r = headerRow + 1; r < matrix.length; r++) {
    const raw = matrix[r] || [];
    // 跳过完全空行
    if (raw.every((c) => String(c ?? '').trim() === '')) continue;

    const get = (field) => {
      const i = mapping[field];
      if (i === undefined) return '';
      return String(raw[i] ?? '').trim();
    };

    // 身份证列特殊处理：检测科学计数法
    let idCardRaw = get('idCard');
    let idCardIssue = '';
    if (looksLikeScientific(idCardRaw) && /[eE]/.test(idCardRaw)) {
      idCardIssue = 'Excel 把身份证号转成了科学计数法，精度已丢失，请在 Excel 中把该列设为「文本」后重新导出';
    }
    const idCard = normalizeIdCard(idCardRaw);

    rows.push({
      excelRow: r + 1, // 1-based，方便用户回 Excel 定位
      seq: get('seq'),
      name: get('name'),
      studentId: get('studentId'),
      idCard,
      idCardRaw,
      idCardIssue,
      hoursRaw: get('hours'),
      remark: get('remark'),
      _cells: raw,
    });
  }

  return {
    rows, headers, mapping, missing, extra, sheetName,
    // 全部工作表名：界面要告诉用户「读的是哪一页、还有哪几页」，
    // 之前 api.js 引用了这个字段但它从没被返回过（一直是 undefined）
    sheetNames: wb.SheetNames,
    filePath: abs,
    headerRow,                                   // 实际使用的表头行（0-based）
    headerRowDetected: detected ? detected.index : null, // 自动探测到的行，显式指定时为 null
  };
}

/** 把行数据导出为干净的 xlsx（仅用于输出，不含敏感原表） */
export function writeTable(outPath, headers, rows) {
  const aoa = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'data');
  XLSX.writeFile(wb, outPath);
  return outPath;
}
