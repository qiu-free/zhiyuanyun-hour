/**
 * 志愿云时长录入助手 —— 本地 Web 服务
 *
 * 架构说明：
 *   后端用 Node 原生 http 模块，不引入 Express 等框架。
 *   理由：① 少一层依赖，沙箱里装包容易出问题 ② 接口就 5 个，用不上框架
 *
 * 安全设计：
 *   • 只监听 127.0.0.1，局域网内其他机器访问不到
 *   • 不登录、不联网、不碰志愿云平台
 *   • 所有处理都在本机内存里完成
 *
 * 启动：node src/server/server.js
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const CORE_DIR = path.resolve(__dirname, '..', 'core');
const ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * 静态文件映射。
 *
 * 为什么要有 /web 这一层前缀：
 *   网页现在是**纯前端**运行的（数据不离开浏览器），浏览器要能直接
 *   import core/*.js。这要求本地开发的 URL 布局与部署到 GitHub Pages
 *   之后的布局**完全一致**，否则会出现「本地能跑、线上不能用」。
 *
 * 两边统一的布局（scripts/build-site.js 产出同样的结构）：
 *   index.html   web/app.js  web/localApi.js  web/style.css
 *   core/*.js    vendor/xlsx.mjs
 */
function resolveStatic(rel) {
  if (rel.startsWith('/core/')) return path.join(CORE_DIR, rel.slice('/core/'.length));
  if (rel === '/vendor/xlsx.mjs') return path.join(ROOT_DIR, 'node_modules', 'xlsx', 'xlsx.mjs');
  if (rel === '/vendor/xlsx-default.js') return path.join(ROOT_DIR, 'src', 'vendor', 'xlsx-default.js');
  if (rel.startsWith('/web/')) return path.join(WEB_DIR, rel.slice('/web/'.length));
  return path.join(WEB_DIR, '.' + rel);
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5180);

/** 静态文件的 MIME 类型 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 读取请求体（限制大小，防内存爆） */
function readBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`请求体超过 ${Math.round(limitBytes / 1024 / 1024)}MB 限制`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 发送 JSON */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 静态文件服务（防目录穿越） */
function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 规范化并确保仍在允许的目录内
  const target = path.resolve(resolveStatic(rel));
  const allowed = [
    WEB_DIR,
    CORE_DIR,
    path.join(ROOT_DIR, 'node_modules', 'xlsx'),
    path.join(ROOT_DIR, 'src', 'vendor'),
  ];
  if (!allowed.some((dir) => target.startsWith(dir))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('禁止访问');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到该文件');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  // 只接受本机来源
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- API ----
  if (url.pathname.startsWith('/api/')) {
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
      const result = await handleApi(url.pathname, req.method, body, url.searchParams);
      if (result === null) {
        sendJson(res, 404, { ok: false, error: `未知接口：${url.pathname}` });
      } else if (result.binary) {
        // 二进制下载（如 xlsx）
        res.writeHead(result.status || 200, {
          'Content-Type': result.contentType,
          'Content-Disposition': result.filename
            ? `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`
            : undefined,
          'Content-Length': result.buffer.length,
          'Cache-Control': 'no-store',
        });
        res.end(result.buffer);
      } else {
        sendJson(res, result.status || 200, result.data ?? result);
      }
    } catch (e) {
      console.error('[API 错误]', e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ---- 静态 ----
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只支持 GET');
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  志愿云时长录入助手已启动');
  console.log('  ────────────────────────────────────────');
  console.log(`  打开浏览器访问：${url}`);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换一个端口：set PORT=5181 && node src/server/server.js`);
  } else {
    console.error('服务启动失败：', e.message);
  }
  process.exit(1);
});
