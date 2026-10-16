/**
 * 本地预览构建产物（dist/）
 *
 * 为什么需要：`npm run web` 提供的是 src/ 里的文件，
 * 而 GitHub Pages 上跑的是 dist/ 里的产物。
 * 两者布局虽然刻意做成一致，但「一致」这件事本身需要验证 ——
 * 这个脚本就是用来验证产物的，避免推到线上才发现路径不对。
 *
 * 用法：
 *   node scripts/build-site.js     # 先构建
 *   node scripts/preview-site.js   # 再预览
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

if (!fs.existsSync(DIST)) {
  console.error('找不到 dist/，请先执行：node scripts/build-site.js');
  process.exit(1);
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5181);   // 与主服务错开，可同时开

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.resolve(DIST, '.' + rel);
  // 防目录穿越
  if (!target.startsWith(DIST)) {
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
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  静态站点预览（构建产物）');
  console.log('  ────────────────────────────────────────');
  console.log(`  打开浏览器访问：http://${HOST}:${PORT}`);
  console.log('');
  console.log('  这是 dist/ 里的产物，与 GitHub Pages 上跑的是同一份。');
  console.log('  按 Ctrl+C 停止。');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换一个：set PORT=5182 && node scripts/preview-site.js`);
  } else {
    console.error(e.message);
  }
  process.exit(1);
});
