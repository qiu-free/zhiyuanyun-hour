/**
 * 身份证号校验（中国大陆居民身份证）
 *
 * 支持：
 *  - 18 位（含校验位，用 GB 11643-1999 的 ISO 7064:1983 MOD 11-2 算法）
 *  - 15 位（老式，无校验位，只能做格式与出生日期合理性校验）
 *
 * 为什么需要这个：志愿云靠「姓名 + 身份证号」定位志愿者。
 * 号码错一位 → 匹配不到人，或者匹配到同名同姓的另一个人，
 * 那就会把时长录到别人头上，属于事故。所以必须在提交前拦住。
 */

// 加权因子与校验码映射表（GB 11643-1999）
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

// 省级行政区代码（前两位）
const PROVINCE_CODES = new Set([
  '11', '12', '13', '14', '15', // 华北
  '21', '22', '23',             // 东北
  '31', '32', '33', '34', '35', '36', '37', // 华东
  '41', '42', '43', '44', '45', '46', // 华中华南
  '50', '51', '52', '53', '54', // 西南
  '61', '62', '63', '64', '65', // 西北
  '71', '81', '82',             // 台湾/香港/澳门
  '91',                         // 国外
]);

/**
 * 归一化身份证号：去掉空格、全角转半角、X 转大写。
 * Excel 里身份证号常被存成数字，15 位还好，18 位会变科学计数法，
 * 那种情况在读取阶段就要处理（见 excel.js）。
 */
export function normalizeIdCard(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // 全角数字/字母 → 半角
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[\uFF21-\uFF3A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 去掉所有内部空白
  s = s.replace(/\s+/g, '');
  return s.toUpperCase();
}

/** 解析出生日期，返回 {year, month, day} 或 null */
function parseBirth(id) {
  let y, m, d;
  if (id.length === 18) {
    y = Number(id.slice(6, 10));
    m = Number(id.slice(10, 12));
    d = Number(id.slice(12, 14));
  } else if (id.length === 15) {
    y = Number('19' + id.slice(6, 8));
    m = Number(id.slice(8, 10));
    d = Number(id.slice(10, 12));
  } else {
    return null;
  }
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return { year: y, month: m, day: d };
}

/** 校验出生日期是否为真实存在的日期 */
function isValidDate({ year, month, day }) {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // 用 Date 反查，避免手写闰年逻辑出错
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * 完整校验身份证号。
 * @returns {{ok: boolean, level: 'ok'|'warn'|'error', reason?: string, info?: object}}
 */
export function validateIdCard(raw) {
  const id = normalizeIdCard(raw);

  if (!id) {
    return { ok: false, level: 'error', reason: '身份证号为空' };
  }
  if (!/^\d{15}$|^\d{17}[\dX]$/.test(id)) {
    return {
      ok: false,
      level: 'error',
      reason: `格式不对（应为 15 位或 18 位，当前 ${id.length} 位）`,
    };
  }

  const province = id.slice(0, 2);
  if (!PROVINCE_CODES.has(province)) {
    return { ok: false, level: 'error', reason: `省级行政区代码无效（${province}）` };
  }

  const birth = parseBirth(id);
  if (!birth) {
    return { ok: false, level: 'error', reason: '出生日期段无法解析' };
  }
  if (!isValidDate(birth)) {
    return {
      ok: false,
      level: 'error',
      reason: `出生日期不存在（${birth.year}-${birth.month}-${birth.day}）`,
    };
  }

  const now = new Date();
  const age = now.getUTCFullYear() - birth.year;
  if (age < 0) {
    return { ok: false, level: 'error', reason: '出生日期在未来' };
  }
  if (age > 120) {
    return { ok: false, level: 'error', reason: `年龄异常（${age} 岁）` };
  }

  // 15 位没有校验位，只能到这里
  if (id.length === 15) {
    return {
      ok: true,
      level: 'warn',
      reason: '15 位老式号码，无校验位，建议改用 18 位',
      info: { birth, age, gender: Number(id[14]) % 2 === 1 ? '男' : '女', format: 15 },
    };
  }

  // 18 位校验位
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += Number(id[i]) * WEIGHTS[i];
  }
  const expected = CHECK_CODES[sum % 11];
  if (id[17] !== expected) {
    return {
      ok: false,
      level: 'error',
      reason: `校验位错误（末位应为 ${expected}，实际为 ${id[17]}）`,
    };
  }

  return {
    ok: true,
    level: 'ok',
    info: {
      birth,
      age,
      gender: Number(id[16]) % 2 === 1 ? '男' : '女',
      format: 18,
    },
  };
}

/** 从身份证号提取出生日期字符串 YYYY-MM-DD，失败返回空串 */
export function birthFromIdCard(raw) {
  const r = validateIdCard(raw);
  if (!r.ok || !r.info) return '';
  const { year, month, day } = r.info.birth;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 脱敏显示：保留前 6 位和后 4 位，例如 110101********1234 */
export function maskIdCard(raw) {
  const id = normalizeIdCard(raw);
  if (id.length < 10) return id ? '***' : '';
  return id.slice(0, 6) + '*'.repeat(id.length - 10) + id.slice(-4);
}
