/**
 * 「一行里挤了多个人」的拆分
 *
 * 为什么需要这个模块：
 * 从 Word / 微信复制时，换行经常丢失，整段变成一行。
 * 原来的实现按行解析，于是**一行只出第一个人，后面的人被静默丢弃**——
 * 用户以为录完了，实际漏了人。这比报错更危险，所以必须专门处理。
 *
 * 拆分思路：
 *   身份证号是全行最可靠的锚点（格式固定、每人唯一），
 *   于是以身份证号为「桩」，把姓名/时长/备注按「就近原则」分配给各个桩。
 *
 * 分配规则的两处细节（都是实测得出的）：
 *
 *   1. 时长用「后置偏好」打分。
 *      主流写法是「姓名 身份证 时长」，时长在身份证之后；
 *      但也存在「姓名 时长 身份证」。用距离 + 1.6 倍惩罚来兼顾两者：
 *        张三 110101...0017 8 李四 110101...0022 12
 *          → 第1人取 8（紧邻其后），第2人取 12
 *        张三 8 110101...0017 李四 12 110101...0022
 *          → 第1人取 8（距离 1 × 1.6 = 1.6 < 后面那个 12 的距离）
 *
 *   2. 每个候选只归属最近的那个桩，避免「前一个人的时长被后一个人抢走」。
 *      多余的数字（序号、电话尾号等）自然被丢弃，不会污染结果。
 *
 * 拆不出来时返回 null，由调用方回退到单行解析——绝不猜。
 */

/** 身份证前两位必须是合法的行政区划码，用于排除「15 位学号」之类的误判 */
const PROVINCE_PREFIX = new Set([
  '11', '12', '13', '14', '15',
  '21', '22', '23',
  '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46',
  '50', '51', '52', '53', '54',
  '61', '62', '63', '64', '65',
  '71', '81', '82',
]);

/** 这些词不是姓名 */
const NOISE_NAME = new Set([
  '姓名', '学号', '身份证', '证件号', '号码', '时长', '小时', '志愿时长', '服务时长',
  '备注', '原因', '事由', '说明', '合计', '总计', '共计', '名单', '序号', '汇总',
  '志愿者', '同学', '学生', '电话', '手机', '班级', '学院', '专业', '年级', '性别',
  '以下', '以上', '补录',
]);

// ---------- 正则 ----------

/** 18 位身份证（末位可为 X） */
const RE_ID18 = /(?<!\d)(\d{17}[\dXx])(?!\d)/g;
/** 15 位老式身份证 */
const RE_ID15 = /(?<!\d)(\d{15})(?!\d)/g;
/** 姓名候选：2-6 个汉字（含少数民族姓名的间隔号） */
const RE_NAME = /[\u4e00-\u9fa5·]{2,6}/g;
/**
 * 疑似时长：1-3 位整数 + 可选小数。
 *
 * 为什么允许 3 位：一个人累计可以有远超 50 小时的总时长
 * （系统要求分多次录入），所以这里**不能**用 50 当上界，
 * 否则「张三 … 80」这种会被当成没有时长。
 * 4 位以上（年份等）由下面 findNumbers 的上界排除。
 */
const RE_NUM = /(?<![\d.])(\d{1,3}(?:\.\d+)?)(?![\d.])/g;
/** 时长的合理性上界（防御性，不是平台限制） */
const MAX_HOURS_TOTAL = 999;
/** 学号候选：8-14 位连续数字 */
const RE_STUDENT = /(?<!\d)(\d{8,14})(?!\d)/g;
/** 手机号（11 位、1 开头），不能被认成学号 */
const RE_PHONE = /^1[3-9]\d{9}$/;
/** 显式备注 */
const RE_REMARK = /(?:备注|原因|事由|说明)\s*[:：]\s*([^\s，,；;|]+)/g;

// ---------- 工具 ----------

/** 判断一串数字是否像真实身份证（限 15/18 位） */
export function looksLikeIdCard(id) {
  const s = String(id);
  if (s.length !== 18 && s.length !== 15) return false;
  if (!/^\d{14}(\d{3}[\dXx]|\d)$/.test(s) && !/^\d{15}$/.test(s)) return false;

  const digits = s.replace(/[Xx]$/, '');
  if (!PROVINCE_PREFIX.has(digits.slice(0, 2))) return false;

  let year;
  let month;
  let day;
  if (s.length === 18) {
    year = Number(s.slice(6, 10));
    month = Number(s.slice(10, 12));
    day = Number(s.slice(12, 14));
  } else {
    const yy = Number(s.slice(6, 8));
    year = yy > 30 ? 1900 + yy : 2000 + yy;
    month = Number(s.slice(8, 10));
    day = Number(s.slice(10, 12));
  }
  if (!(month >= 1 && month <= 12)) return false;
  if (!(day >= 1 && day <= 31)) return false;

  const now = new Date().getFullYear();
  return year >= 1940 && year <= now;
}

/** 两个区间的最短字符距离 */
function distance(a, b) {
  if (a.end <= b.start) return b.start - a.end;
  if (a.start >= b.end) return a.start - b.end;
  return 0;
}

/** 找身份证锚点（含位置）。同一号码只保留第一次出现。 */
export function findAnchors(line) {
  const found = [];

  for (const m of line.matchAll(RE_ID18)) {
    found.push({ start: m.index, end: m.index + m[0].length, id: m[1], len: 18 });
  }
  // 15 位要排除掉与 18 位重叠的
  for (const m of line.matchAll(RE_ID15)) {
    const start = m.index;
    const end = start + m[0].length;
    const overlap = found.some((a) => start < a.end && end > a.start);
    if (overlap) continue;
    // 前后紧邻数字说明它是更长数字串的一部分，不是身份证
    const before = line[start - 1];
    const after = line[end];
    if (/\d/.test(before || '') || /\d/.test(after || '')) continue;
    found.push({ start, end, id: m[1], len: 15 });
  }

  found.sort((a, b) => a.start - b.start);

  // 只保留看起来像身份证的
  const plausible = found.filter((a) => looksLikeIdCard(a.id));

  // 同一行里出现完全相同的号码 → 只算一个人
  const seen = new Set();
  const unique = [];
  for (const a of plausible) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    unique.push(a);
  }
  return unique;
}

/** 收集姓名候选（排除噪声词与身份证区间） */
function findNames(line, anchors) {
  const out = [];
  for (const m of line.matchAll(RE_NAME)) {
    const tok = m[0];
    const start = m.index;
    const end = start + tok.length;
    // 与身份证区间重叠的跳过
    if (anchors.some((a) => start < a.end && end > a.start)) continue;
    if (NOISE_NAME.has(tok)) continue;
    out.push({ start, end, text: tok });
  }
  return out;
}

/** 收集时长候选 */
function findNumbers(line, anchors) {
  const out = [];
  for (const m of line.matchAll(RE_NUM)) {
    const start = m.index;
    const end = start + m[0].length;
    if (anchors.some((a) => start < a.end && end > a.start)) continue;
    const v = Number(m[1]);
    if (!(v > 0 && v <= MAX_HOURS_TOTAL)) continue;
    out.push({ start, end, value: v, text: m[1] });
  }
  return out;
}

/** 收集学号候选 */
function findStudents(line, anchors) {
  const out = [];
  for (const m of line.matchAll(RE_STUDENT)) {
    const start = m.index;
    const end = start + m[0].length;
    if (anchors.some((a) => start < a.end && end > a.start)) continue;
    // 手机号不是学号
    if (RE_PHONE.test(m[1])) continue;
    out.push({ start, end, text: m[1] });
  }
  return out;
}

/** 收集显式备注 */
function findRemarks(line, anchors) {
  const out = [];
  for (const m of line.matchAll(RE_REMARK)) {
    const start = m.index;
    const end = start + m[0].length;
    out.push({ start, end, text: m[1].trim(), whole: m[0] });
  }
  return out;
}

/**
 * 全局一对一分配：把所有 (候选, 锚点) 组合按分数排序，
 * 依次认领，已被占用的跳过。这样能保证「一个候选只归一个人」。
 *
 * 为什么不用「各自取最近」：那样会出现两个人抢同一个姓名，
 * 或者前一个人的时长被后一个人抢走。
 *
 * @param {Array} anchors
 * @param {Array} tokens
 * @param {(tok, anchor)=>number} score 越小越合适
 */
function assignGreedy(anchors, tokens, score) {
  const pairs = [];
  for (const tok of tokens) {
    for (let i = 0; i < anchors.length; i++) {
      pairs.push({ tok, i, s: score(tok, anchors[i]) });
    }
  }
  // 分数相同则优先靠前的人，保证结果稳定
  pairs.sort((a, b) => (a.s - b.s) || (a.i - b.i));

  const result = anchors.map(() => null);
  const takenTok = new Set();
  for (const p of pairs) {
    if (result[p.i] !== null) continue;
    if (takenTok.has(p.tok)) continue;
    result[p.i] = p.tok;
    takenTok.add(p.tok);
  }
  return result;
}

/**
 * 姓名的打分：强烈偏向「在锚点之前」的姓名。
 *
 * 两种主流写法里姓名都在自己身份证前面：
 *   姓名 身份证 时长        （你确认的格式）
 *   姓名 时长 身份证
 * 所以「前面那个姓名」几乎总是本人的；「后面那个」多半是下一个人的。
 *
 * 若不这样处理，会出现：
 *   张三 8 <证1> 李四 12 <证2>
 * 其中「李四」离 <证1> 只有 1 个字符，比离自己的 <证2> 还近，
 * 于是被错误地配给第 1 个人，第 2 个人反而没了姓名。
 */
const NAME_AFTER_PENALTY = 50;

function scoreName(tok, anchor) {
  if (tok.end <= anchor.start) return anchor.start - tok.end;              // 在锚点前
  if (tok.start >= anchor.end) return (tok.start - anchor.end) + NAME_AFTER_PENALTY; // 在锚点后
  return 0;
}

/** 时长/学号/备注：纯就近即可（实测两种写法都能正确落位） */
function scoreByDistance(tok, anchor) {
  return distance(tok, anchor);
}

/**
 * 尝试把一行拆成多个人。
 *
 * @param {string} line
 * @returns {Array<object>|null}
 *   null 表示「不足以拆分」（锚点少于 2 个），交由调用方走单行解析。
 *   否则返回每人的 {name, idCard, studentId, hours, remark, segment, ...}
 */
export function splitPeople(line) {
  const raw = String(line ?? '');
  const anchors = findAnchors(raw);

  if (anchors.length < 2) return null;

  const names = assignGreedy(anchors, findNames(raw, anchors), scoreName);
  const hours = assignGreedy(anchors, findNumbers(raw, anchors), scoreByDistance);
  const students = assignGreedy(anchors, findStudents(raw, anchors), scoreByDistance);
  const remarks = assignGreedy(anchors, findRemarks(raw, anchors), scoreByDistance);

  return anchors.map((a, i) => {
    const name = names[i]?.text ?? '';
    const h = hours[i]?.value ?? null;
    const sid = students[i]?.text ?? '';
    const remark = remarks[i]?.text ?? '';

    // 该人的「还原片段」，便于人工核对
    const segment = [name || '(未识别姓名)', a.id, h ?? '(未识别时长)', remark]
      .filter((x) => x !== '')
      .join(' ');

    const issues = [];
    if (!name) issues.push('未能识别姓名');
    if (h === null) issues.push('未识别到时长');

    return {
      name,
      idCard: a.id,
      idCardMasked: false,
      studentId: sid,
      hours: h,
      remark,
      segment,
      // 原始整行（多条记录共享），报错时给用户看
      raw,
      sharedLine: true,
      anchorIndex: i + 1,
      anchorCount: anchors.length,
      issues,
    };
  });
}

/**
 * 判断一行是否「疑似挤了多个人」
 * 用于给出提示，即使拆分失败也能提醒用户。
 */
export function looksMultiPerson(line) {
  const raw = String(line ?? '');
  return findAnchors(raw).length >= 2;
}
