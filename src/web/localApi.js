/**
 * 浏览器端接口实现（纯前端）
 *
 * 为什么需要这个文件：
 *   网站要部署成**静态站点**（GitHub Pages），没有服务端。
 *   所以所有计算必须在浏览器里完成。
 *
 * 这带来一个重要的性质：**使用者的身份证号不会离开自己的浏览器**。
 *   没有网络请求、没有服务器、没有日志。
 *   别人打开网页也照样是自己的数据自己算。
 *
 * 这里不重复实现业务逻辑 —— 全部调用 core/pipeline.js，
 * 和服务端 server/api.js 用的是同一份代码。
 */

import { readTableFromBuffer, buildRecordsWorkbook } from '../core/excelBuffer.js';
import {
  parseTextResult,
  tableToRecords,
  scheduleResult,
  batchesResult,
  multiProjectResult,
} from '../core/pipeline.js';

/** base64 → Uint8Array（不依赖 Buffer，浏览器没有） */
function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/^data:[^;]+;base64,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 与 server/api.js 的 handleApi 一一对应，但完全在本地算。
 *
 * @param {string} pathname 例如 '/api/parse'
 * @param {object} payload
 * @returns {Promise<object>} 与后端 data 字段同构
 */
export async function localApi(pathname, payload = {}) {
  // 故意让出一次事件循环：保持与 HTTP 版本一致的异步语义，
  // 避免调用方在「同步返回」和「异步返回」之间踩坑。
  await Promise.resolve();

  switch (pathname) {
    case '/api/health':
      return { ok: true, version: '1.3.0-static', maxHoursPerEntry: 50 };

    case '/api/parse': {
      const { text = '', reason = '' } = payload;
      return { ok: true, ...parseTextResult({ text, reason }) };
    }

    case '/api/upload': {
      const { base64 = '', reason = '' } = payload;
      if (!base64) throw new Error('没有收到文件内容');
      const bytes = base64ToBytes(base64);
      if (!bytes.length) throw new Error('文件是空的');
      const table = readTableFromBuffer(bytes, { filename: payload.filename });
      return { ok: true, ...tableToRecords({ table, reason }) };
    }

    case '/api/schedule': {
      const { records = [], strategy = 'few' } = payload;
      return { ok: true, ...scheduleResult({ records, strategy }) };
    }

    case '/api/batches': {
      const { records = [], strategy = 'few' } = payload;
      return { ok: true, ...batchesResult({ records, strategy }) };
    }

    case '/api/multi-project': {
      const { records = [], projects } = payload;
      return { ok: true, ...multiProjectResult({ records, projects }) };
    }

    default:
      throw new Error(`未知接口：${pathname}`);
  }
}

/**
 * 生成 Excel（浏览器直接下载，不发请求）
 * @returns {Blob}
 */
export function exportXlsxBlob(records) {
  const list = records.filter((r) => r.usable);
  if (!list.length) throw new Error('没有可导出的记录');
  const bytes = buildRecordsWorkbook(records);
  return new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** 读本地文件为 base64（浏览器 File 对象） */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.onload = () => {
      const s = String(fr.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.readAsDataURL(file);
  });
}
