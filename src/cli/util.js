/**
 * 通用 CLI 工具函数
 */

import fs from 'node:fs';
import path from 'node:path';

/** 极简参数解析：--key value / --flag */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

/** 确保输出目录存在 */
export function ensureOutDir(sub = '') {
  const dir = path.resolve('output', sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 输出文件名（不含扩展名）的时间戳 */
export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 彩色输出（无依赖） */
export const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** 找不到文件时给出友好提示 */
export function requireFile(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `找不到文件：${abs}\n` +
      `请把表格放到 data/ 目录，或用 --file 指定路径。`
    );
  }
  return abs;
}

export function printBanner(title) {
  console.log('');
  console.log(c.bold(c.blue('═'.repeat(60))));
  console.log(c.bold(c.blue(`  ${title}`)));
  console.log(c.bold(c.blue('═'.repeat(60))));
  console.log('');
}
