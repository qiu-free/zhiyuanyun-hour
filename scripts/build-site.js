/**
 * 构建静态网站（用于 GitHub Pages）
 *
 * 产物目录 dist/，结构与本地 `npm run web` 提供的布局**完全一致**：
 *
 *   dist/
 *     index.html          ← src/web/index.html
 *     web/app.js          ← src/web/app.js
 *     web/localApi.js     ← src/web/localApi.js
 *     web/style.css       ← src/web/style.css
 *     core/*.js           ← src/core/*.js
 *     vendor/xlsx.mjs     ← node_modules/xlsx/xlsx.mjs
 *     .nojekyll           ← 让 GitHub Pages 不做 Jekyll 处理
 *
 * 两边一致很重要：不一致就会出现「本地能跑、线上不能用」。
 * 这个脚本会在结束时自检 —— 逐个确认 index.html 引用的文件都存在。
 *
 * 用法：node scripts/build-site.js
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');

/** 目录复制（只复制 .js，避免把测试文件带进去） */
function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      n += copyDir(src, dst, filter);
    } else if (filter(e.name)) {
      fs.copyFileSync(src, dst);
      n++;
    }
  }
  return n;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

console.log('构建静态网站…\n');

// ---------- 1. 清空 dist ----------
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ---------- 2. 网页文件 ----------
let n = 0;
n += copyDir(path.join(ROOT, 'src', 'web'), path.join(DIST, 'web'), (name) =>
  name.endsWith('.js') || name.endsWith('.css')
);
copyFile(path.join(ROOT, 'src', 'web', 'index.html'), path.join(DIST, 'index.html'));
console.log(`  web/           ${n} 个文件`);

// ---------- 3. 核心逻辑（浏览器直接 import） ----------
// excel.js 是 Node 专用（读写本地文件，顶层 import node:path），
// 浏览器加载会直接报错。它只被 CLI 使用，网页端不需要。
const NODE_ONLY = new Set(['excel.js']);

const coreN = copyDir(path.join(ROOT, 'src', 'core'), path.join(DIST, 'core'), (name) =>
  name.endsWith('.js') && !NODE_ONLY.has(name)
);
console.log(`  core/          ${coreN} 个文件（排除 ${[...NODE_ONLY].join('、')}）`);

// 关键校验：产物里任何一个 core 模块都不能依赖 node: 内置模块，
// 否则浏览器加载时才报错 —— 那时候已经上线了。
console.log('\n自检：core 模块是否浏览器可用…');
let nodeDeps = 0;
for (const f of fs.readdirSync(path.join(DIST, 'core'))) {
  const src = fs.readFileSync(path.join(DIST, 'core', f), 'utf8');
  const hits = [...src.matchAll(/from\s+['"](node:[^'"]+)['"]/g)].map((m) => m[1]);
  if (hits.length) {
    nodeDeps++;
    console.log(`  ✗ core/${f} → ${hits.join(', ')}`);
  }
}
if (!nodeDeps) console.log(`  ✓ ${coreN} 个模块都不依赖 node: 内置模块`);

// ---------- 4. 第三方库 ----------
const xlsxSrc = path.join(ROOT, 'node_modules', 'xlsx', 'xlsx.mjs');
if (!fs.existsSync(xlsxSrc)) {
  console.error('\n✗ 找不到 node_modules/xlsx/xlsx.mjs');
  console.error('  先执行 npm install');
  process.exit(1);
}
copyFile(xlsxSrc, path.join(DIST, 'vendor', 'xlsx.mjs'));
const xlsxKb = Math.round(fs.statSync(xlsxSrc).size / 1024);
console.log(`  vendor/xlsx.mjs  ${xlsxKb} KB`);

// ---------- 5. GitHub Pages：不要跑 Jekyll ----------
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
console.log('  .nojekyll');

// ---------- 6. 不要把敏感文件带进来 ----------
const forbidden = ['data', 'output', '.env', 'privacy-blacklist.local.json', 'node_modules'];
for (const f of forbidden) {
  if (fs.existsSync(path.join(DIST, f))) {
    console.error(`\n✗ dist/ 里出现了不该有的 ${f}`);
    process.exit(1);
  }
}

// ---------- 7. 自检：index.html 引用的文件是否都存在 ----------
console.log('\n自检：index.html 引用的资源…');
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const refs = [
  ...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g),
].map((m) => m[1]);
refs.push('./vendor/xlsx.mjs');   // 来自 importmap

let bad = 0;
for (const ref of refs) {
  const p = path.join(DIST, ref);
  const ok = fs.existsSync(p);
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${ref}`);
}

// ---------- 8. 自检：模块的 import 链是否都能解析 ----------
console.log('\n自检：模块 import 链…');
const seen = new Set();
const queue = [path.join(DIST, 'web', 'app.js'), path.join(DIST, 'web', 'localApi.js')];
let importsChecked = 0;
let importsBad = 0;

while (queue.length) {
  const f = queue.pop();
  if (seen.has(f) || !fs.existsSync(f)) continue;
  seen.add(f);
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]|import\(['"](\.[^'"]+)['"]\)/g)) {
    const spec = m[1] || m[2];
    importsChecked++;
    let target = path.resolve(path.dirname(f), spec);
    const cands = [target, target + '.js', target + '.mjs'];
    const hit = cands.find((c) => fs.existsSync(c));
    if (!hit) {
      importsBad++;
      console.log(`  ✗ ${path.relative(DIST, f)} → ${spec}`);
    } else if (hit.endsWith('.js') || hit.endsWith('.mjs')) {
      queue.push(hit);
    }
  }
}
console.log(`  检查 ${importsChecked} 个相对 import，失败 ${importsBad} 个`);

if (bad || importsBad || nodeDeps) {
  console.error('\n✗ 构建自检未通过');
  process.exit(1);
}

// ---------- 9. 汇总 ----------
let total = 0;
let bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { total++; bytes += fs.statSync(p).size; }
  }
})(DIST);

console.log(`\n✓ 构建完成：${total} 个文件，${Math.round(bytes / 1024)} KB`);
console.log(`  产物目录：${path.relative(ROOT, DIST)}/`);
console.log('\n本地预览：node scripts/preview-site.js');
