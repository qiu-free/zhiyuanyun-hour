/**
 * 从内存中的二进制内容读取表格（网页上传 / 浏览器解析都用这个）
 *
 * 与 core/excel.js 的 readTable 逻辑一致，区别只在于数据来源是
 * 内存里的字节，而不是文件路径 —— 网页上传时文件不会落盘。
 *
 * 浏览器兼容：
 *   - 不 import excel.js（那个文件需要 node:path）
 *   - XLSX.read 用 type:'array'，Node 的 Buffer 本身就是 Uint8Array，两边通用
 */

import XLSX from 'xlsx';
import {
  detectColumns,
  detectHeaderRow,
  pickSheet,
  sheetToMatrix,
} from './excelColumns.js';
import { normalizeIdCard } from './idcard.js';

/**
 * @param {Uint8Array|ArrayBuffer|Buffer} bytes 文件内容
 * @param {{filename?: string, sheet?: string, headerRow?: number}} opts
 */
export function readTableFromBuffer(bytes, opts = {}) {
  const wb = XLSX.read(bytes, {
    // 'array' 同时接受 Uint8Array / ArrayBuffer；
    // Node 的 Buffer 是 Uint8Array 的子类，所以服务端也走这条
    type: 'array',
    cellText: true,
    cellDates: false,
    raw: false,
  });

  const sheetNames = wb.SheetNames;
  if (!sheetNames.length) throw new Error('这个文件里没有工作表');

  // 用 pickSheet 而不是 SheetNames[0]：
  // 真实表格常把第一页做成封面/说明，数据在第二页。
  // 原来固定取第一页，遇到封面页会「什么都读不到」，而用户明明看到表里有数据。
  const sheetName = pickSheet(wb, opts.sheet);
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`找不到工作表：${sheetName}`);

  const matrix = sheetToMatrix(ws);
  if (!matrix.length) throw new Error('工作表是空的');

  // 表头行：显式指定优先，否则自动探测
  const detected = opts.headerRow === undefined ? detectHeaderRow(matrix) : null;
  const headerRow = opts.headerRow ?? detected.index;
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

    const idCardRaw = get('idCard');
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

/**
 * 生成 xlsx 的字节（浏览器下载 / 服务端响应都用这个）
 *
 * 不依赖 node:fs —— 只产出 Uint8Array，由调用方决定怎么落地。
 *
 * @param {{records: Array}} opts
 * @returns {Uint8Array}
 */
export function buildRecordsWorkbook(records) {
  const list = records.filter((r) => r.usable);

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
  // type:'array' 返回 Uint8Array，浏览器和 Node 都能用
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}
