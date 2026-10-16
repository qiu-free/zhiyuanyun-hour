/**
 * HTTP 接口层
 *
 * 这一层**只做 HTTP 相关的事**（读请求体、拼响应、处理二进制），
 * 业务逻辑全部在 core/pipeline.js 里 —— 那份逻辑浏览器也在用。
 *
 * 这样做的原因：
 *   静态网站（GitHub Pages）没有服务端，浏览器必须自己算。
 *   如果业务逻辑写在这里，浏览器就用不了，只能把使用者的身份证号
 *   发到服务器 —— 这是要避免的。
 *
 * 接口一览：
 *   GET  /api/health      健康检查
 *   POST /api/parse       文本 → 记录列表（含问题标记）
 *   POST /api/upload      xlsx → 记录列表
 *   POST /api/export/xlsx 记录列表 → Excel
 *   POST /api/schedule    记录列表 → 排期
 *   POST /api/batches     记录列表 → 分批方案
 *   POST /api/multi-project 记录列表 → 多项目分流方案
 */

import { readTableFromBuffer, buildRecordsWorkbook } from '../core/excelBuffer.js';
import {
  normalizeRecord,
  summarize,
  renderLine,
  parseTextResult,
  tableToRecords,
  scheduleResult,
  batchesResult,
  multiProjectResult,
  MAX_HOURS,
} from '../core/pipeline.js';

// 转发导出：原来从 api.js 引这几个函数的地方（如 selftest-web.js）不受影响
export { normalizeRecord, summarize, renderLine, MAX_HOURS };

export async function handleApi(pathname, method, bodyBuf, searchParams) {
  const parseJson = () => {
    if (!bodyBuf || !bodyBuf.length) return {};
    try {
      return JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  };

  // ---------- 健康检查 ----------
  if (pathname === '/api/health' && method === 'GET') {
    return { data: { ok: true, version: '1.3.0', maxHoursPerEntry: MAX_HOURS } };
  }

  // ---------- 文本解析 ----------
  if (pathname === '/api/parse' && method === 'POST') {
    const { text = '', reason = '' } = parseJson();
    return { data: { ok: true, ...parseTextResult({ text, reason }) } };
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

    const table = readTableFromBuffer(buf, { filename });
    return { data: { ok: true, ...tableToRecords({ table, reason }) } };
  }

  // ---------- 导出 Excel ----------
  // 注：.txt 导出由前端用 Blob 本地生成，不需要后端接口（少一次往返）。
  if (pathname === '/api/export/xlsx' && method === 'POST') {
    const { records = [] } = parseJson();
    const list = records.filter((r) => r.usable);
    if (!list.length) throw new Error('没有可导出的记录');

    // 生成逻辑在 core/excelBuffer.js，浏览器端用的是同一个函数
    const out = buildRecordsWorkbook(records);
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return {
      binary: true,
      buffer: Buffer.from(out),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `志愿云录入模板-${ts}.xlsx`,
    };
  }

  // ---------- 排期 ----------
  if (pathname === '/api/schedule' && method === 'POST') {
    const { records = [], strategy = 'few' } = parseJson();
    return { data: { ok: true, ...scheduleResult({ records, strategy }) } };
  }

  // ---------- 分批方案 ----------
  if (pathname === '/api/batches' && method === 'POST') {
    const { records = [], strategy = 'few' } = parseJson();
    return { data: { ok: true, ...batchesResult({ records, strategy }) } };
  }

  // ---------- 多项目分流 ----------
  if (pathname === '/api/multi-project' && method === 'POST') {
    const { records = [], projects } = parseJson();
    return { data: { ok: true, ...multiProjectResult({ records, projects }) } };
  }

  return null;
}
