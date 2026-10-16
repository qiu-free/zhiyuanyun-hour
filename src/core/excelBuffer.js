/**
 * 从内存中的 Buffer 读取表格（用于网页上传场景）
 *
 * 与 core/excel.js 的 readTable 逻辑一致，区别只在于数据来源是 Buffer
 * 而不是文件路径 —— 网页上传时文件不会落盘。
 */

import XLSX from 'xlsx';
import { detectColumns, detectHeaderRow } from './excel.js';
import { normalizeIdCard } from './idcard.js';

/**
 * @param {Buffer} buffer 文件内容
 * @param {{filename?: string, sheet?: string}} opts
 */
export function readTableFromBuffer(buffer, opts = {}) {
  const wb = XLSX.read(buffer, {
    type: 'buffer',
    cellText: true,
    cellDates: false,
    raw: false,
  });

  const sheetNames = wb.SheetNames;
  if (!sheetNames.length) throw new Error('这个文件里没有工作表');

  const sheetName = opts.sheet || sheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`找不到工作表：${sheetName}`);

  const matrix = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  if (!matrix.length) throw new Error('工作表是空的');

  const detected = detectHeaderRow(matrix);
  const headerRow = detected.index;
  const headers = (matrix[headerRow] || []).map((h) => String(h ?? '').trim());

  const { mapping, missing, extra } = detectColumns(headers);

  const rows = [];
  for (let r = headerRow + 1; r < matrix.length; r++) {
    const raw = matrix[r] || [];
    if (raw.every((c) => String(c ?? '').trim() === '')) continue;

    const get = (field) => {
      const i = mapping[field];
      if (i === undefined) return '';
      return String(raw[i] ?? '').trim();
    };

    let idCardRaw = get('idCard');
    let idCardIssue = '';
    // Excel 把 18 位身份证存成数字时会变成科学计数法，精度已丢
    if (/[eE]/.test(idCardRaw) && /^[\d.]+e[+-]?\d+$/i.test(idCardRaw)) {
      idCardIssue = 'Excel 把身份证号转成了科学计数法，精度已丢失，请把该列设为「文本」后重新导出';
    }

    rows.push({
      excelRow: r + 1,
      seq: get('seq'),
      name: get('name'),
      studentId: get('studentId'),
      idCard: normalizeIdCard(idCardRaw),
      idCardRaw,
      idCardIssue,
      hoursRaw: get('hours'),
      remark: get('remark'),
      _cells: raw,
    });
  }

  return {
    rows,
    headers,
    mapping,
    missing,
    extra,
    sheetName,
    sheetNames,
    headerRow,
  };
}
