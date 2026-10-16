/**
 * 表格文件读取（Node 专用）
 *
 * 为什么和 excelColumns.js 分开：
 *   本文件需要 node:path，浏览器里加载不了；
 *   而列识别、表头探测这些纯逻辑两边都要用。
 *   所以纯逻辑放 excelColumns.js，本文件只管读写文件。
 *
 * 实战中最容易踩的坑：Excel 把 18 位身份证号当成数字，
 * 显示成 1.10101E+17，读出来精度就丢了。
 * 所以这里对身份证列做特殊处理：优先读单元格原始文本。
 */

import XLSX from 'xlsx';
import path from 'node:path';
import { normalizeIdCard } from './idcard.js';
import {
  detectColumns,
  detectHeaderRow,
  pickSheet,
  sheetToMatrix,
  looksLikeScientific,
} from './excelColumns.js';

// 转发导出：原来写 `import { detectColumns } from './excel.js'` 的地方不受影响
export { detectColumns, detectHeaderRow, pickSheet, sheetToMatrix };


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
