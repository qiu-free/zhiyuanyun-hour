/**
 * 隐私检查：扫描项目里是否残留真实个人信息
 *
 * 为什么需要：曾经为了"测试真实感"，把用户表格里的真实姓名和身份证号
 * 当成了示例数据，散落到界面示例、测试脚本和文档里。本脚本长期防止回归。
 *
 * 设计要点：
 *   1. **真实值只存 SHA-256 哈希**，仓库里不出现任何明文 PII。
 *      这样即使仓库泄漏，也不会连带泄漏姓名和证号。
 *   2. 姓名按「中文词元」扫描后比对哈希 —— 不依赖字面量出现的位置。
 *   3. 身份证按 **15~20 位** 扫描（不只是 18 位）。
 *      真实数据常见的错误是多一位或少一位（例如 4203222 200511172410
 *      多打了个 2 变成 19 位），只查 18 位会漏掉。
 *
 * 用法：node scripts/check-privacy.js
 *   发现即退出码 1（挂在 npm test 里）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------- 真实名单黑名单（只存哈希，且放在本地不入库的文件里）----------
//
// 为什么不写在仓库里：姓名哈希虽然不可逆，但中文姓名空间有限，
// 公开一份「N 个姓名 + M 个证号」的哈希表，等于公开一份可被暴力破解的名单。
// 所以数据放在 privacy-blacklist.local.json（已在 .gitignore 里），
// 仓库只保留检查机制。
//
// 没有这个文件时：结构性检查（15~20 位长号码）照常生效，
// 只是不做「已知名单」比对，并明确提示。
const LOCAL_BLACKLIST = path.join(process.cwd(), 'privacy-blacklist.local.json');
let REAL_NAME_HASHES = new Set();
let REAL_ID_HASHES = new Set();
let blacklistState = 'missing';

try {
  if (fs.existsSync(LOCAL_BLACKLIST)) {
    const j = JSON.parse(fs.readFileSync(LOCAL_BLACKLIST, 'utf8'));
    REAL_NAME_HASHES = new Set(j.names || []);
    REAL_ID_HASHES = new Set(j.ids || []);
    blacklistState = 'loaded';
  }
} catch (e) {
  blacklistState = `broken: ${e.message}`;
}

// 允许出现的虚构值（白名单，避免自己报自己）
const FAKE_IDS = new Set([
  // 界面示例（scripts/make-fake-ids.js 生成）
  '110101200501010017', '110101200502020022', '110101200503030038',
  '110101200504040043', '110101200505050059', '110101200506060064',
  '110101200507070075', '110101200508080081', '110101200509090097',
  '110101200510100103',
  // 早期样例数据（scripts/make-sample.js 用校验算法生成）
  '110101200501011239', '130102200503152342', '31010420040720345X',
  '440105200509104562', '320106200502085679', '51010720051212678X',
  '510107200601017892', '420109200507079019', '610110200508080127',
  '210111200509091233', '500112200510102345', '110101850101123',
  // 自检里用来测「位数不对」的 19 位构造值（假数据）
  '1101012005010100170',
  // selftest-split.js 用来测「非法身份证」的构造值（假数据）
  '202300000123456',        // 15 位：测「15 位可能被当老身份证」
  '999999200501011234',     // 区划码 999999 非法
  '110101209901011234',     // 出生年份 2099 不合理
]);

/** 检查时按前缀豁免的号码段（示例专用） */
function isFakeRange(id) {
  // 110101 = 北京东城（公开行政区划码），配合示例专用出生年份
  return /^11010120(0[1-9]|1[0-2])/.test(id) || /^13010220/.test(id);
}

// dist 是构建产物（xlsx 库里有大量形似身份证的数字串，会误报）；
// 它由 src/ 生成，源头干净即可，所以不扫。
const SKIP_DIRS = ['node_modules', '.pnpm', '.playwright', '.git', 'output', 'dist'];
const TEXT_EXT = ['.md', '.js', '.mjs', '.html', '.css', '.json', '.txt', '.yml', '.yaml'];

/** 递归收集待检查文件 */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (TEXT_EXT.includes(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

const root = process.cwd();
const files = collect(root).filter((f) => path.basename(f) !== 'privacy-blacklist.local.json');
const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');

let issues = 0;

console.log(`扫描 ${files.length} 个文件…`);
if (blacklistState === 'loaded') {
  console.log(`（已知名单：${REAL_NAME_HASHES.size} 个姓名哈希、${REAL_ID_HASHES.size} 个证号哈希）`);
} else if (blacklistState === 'missing') {
  console.log('（注意：本地没有 privacy-blacklist.local.json，本次只做结构性检查）');
} else {
  console.log(`⚠️  本地黑名单读取失败：${blacklistState}`);
}
console.log('');

// ---------- 1. 真实姓名（按词元比对哈希）----------
const nameHits = [];
for (const f of files) {
  const text = read(f);
  // 中文姓名一般是 2-4 字；放宽到 2-6 以免漏掉复姓或带点的名字
  for (const m of text.matchAll(/[\u4e00-\u9fa5·]{2,6}/g)) {
    if (REAL_NAME_HASHES.has(sha256(m[0]))) {
      nameHits.push({ file: rel(f), token: m[0] });
    }
  }
}
if (nameHits.length) {
  console.log(`❌ 发现 ${nameHits.length} 处已知的真实姓名：`);
  for (const h of nameHits.slice(0, 20)) console.log(`   ${h.file}  →  ${h.token}`);
  if (nameHits.length > 20) console.log(`   … 还有 ${nameHits.length - 20} 处`);
  issues += nameHits.length;
} else {
  console.log('✓ 没有已知的真实姓名');
}

// ---------- 2. 真实身份证（精确 + 15~20 位结构性检查）----------
const idHits = [];
const suspect = [];
for (const f of files) {
  const text = read(f);
  // 15~20 位：真实数据常见的错误是多一位/少一位，只查 18 位会漏
  for (const m of text.matchAll(/(?<![\d])(\d{15,20}[Xx]?)(?![\dXx])/g)) {
    const raw = m[0];
    const up = raw.toUpperCase();
    if (REAL_ID_HASHES.has(sha256(raw)) || REAL_ID_HASHES.has(sha256(up))) {
      idHits.push({ file: rel(f) });
      continue;
    }
    if (FAKE_IDS.has(up)) continue;
    if (isFakeRange(up)) continue;
    // 排除明显是代码常量的场景
    const line = text.slice(Math.max(0, m.index - 60), m.index + 30).replace(/\n/g, ' ');
    if (/WEIGHTS|CHECK_CODES/.test(line)) continue;
    suspect.push({ file: rel(f), masked: `${raw.slice(0, 4)}****${raw.slice(-2)}`, n: raw.length });
  }
}
if (idHits.length) {
  console.log(`\n❌ 发现 ${idHits.length} 处已知的真实身份证号：`);
  for (const h of idHits.slice(0, 20)) console.log(`   ${h.file}`);
  if (idHits.length > 20) console.log(`   … 还有 ${idHits.length - 20} 处`);
  issues += idHits.length;
} else {
  console.log('✓ 没有已知的真实身份证号');
}

// 结构性可疑：位数对不上、又不在白名单里的号码
if (suspect.length) {
  console.log(`\n⚠️  发现 ${suspect.length} 处「不在白名单」的 15~20 位号码，请人工确认：`);
  for (const s of suspect.slice(0, 20)) {
    console.log(`   ${s.file}  ${s.masked}（${s.n} 位）`);
  }
  if (suspect.length > 20) console.log(`   … 还有 ${suspect.length - 20} 处`);
  issues += suspect.length;
} else {
  console.log('✓ 没有可疑的长号码');
}

console.log('');
if (issues) {
  console.log(`✗ 发现 ${issues} 处疑似真实个人信息，必须清理。`);
  console.log('  替换成虚构值（scripts/make-fake-ids.js 可生成合法但虚构的号码）。');
  process.exit(1);
}
console.log('✓ 隐私检查通过');
