/**
 * 从任意文本中抽取志愿者信息
 *
 * 目标：你贴一段随便什么格式的文本（聊天记录、微信群复制、手打的），
 * 我把它抽成 {姓名, 身份证号, 时长, 备注} 四要素，再输出成可粘贴的模板。
 *
 * 设计原则（重要）：
 *
 * 1. 只做能确定性判断的抽取。身份证号有强格式（18位/15位 + 校验位），
 *    时长有明确模式（数字+小时单位），这两项可靠。
 *
 * 2. 姓名最不可靠 —— 任意文本里什么词都可能是姓名。
 *    所以姓名采取「排除法 + 位置启发」：
 *      排除身份证号、学号、时长、单位、标点；
 *      剩下的中文串优先取靠前的短串。
 *    抽不准时**宁可报错让人工确认**，绝不瞎猜。
 *
 * 3. 每个结果都带「来源片段」，便于人工核对。
 */

import { normalizeIdCard, validateIdCard } from './idcard.js';
import { splitPeople } from './splitPeople.js';

/**
 * 时长：数字 + 可选单位
 *
 * 这里有两个必须避开的坑（都是实测踩出来的）：
 *
 * 坑1：单位里若含单字「时」，会把「身份证：<18位号> 时长：8小时」中的
 *      「<号> 时」误匹配成"18位号是时长"，因为它允许数字与单位之间有空格。
 *      对策：单字「时」「h」必须紧贴数字（不允许空格），多字单位才允许空格。
 *
 * 坑2：「时长」「小时数」这类标签词本身含单位字，会干扰匹配。
 *      对策：捕获组里限制数字长度（时长不可能超过 2 位整数），
 *      并要求数字前后不是其他数字（用 (?<![\d.]) / (?![\d.]) 保证边界）。
 */
const HOURS_PATTERN =
  /(?<![\d.])(\d{1,2}(?:\.\d+)?)(?:\s*(?:小时|个小时|个钟头|钟头|hrs?|hours?)|(?:小时|时|h|H))\s*(?![\d])/;
/** 裸数字（可能被当时长，但需要上下文判断，风险高） */
const BARE_NUMBER = /^\d+(?:\.\d+)?$/;

/** 身份证号候选：18位（含X）或15位纯数字 */
const ID_18 = /\b(\d{17}[\dXx])\b/;
const ID_15 = /\b(\d{15})\b/;
/** 打码后的身份证：保留了前6后4 */
const ID_MASKED = /\b(\d{6}\*{4,}\d{3}[\dXx])\b/;

/** 学号：连续 8-14 位纯数字，且不像身份证 */
const STUDENT_ID = /\b(\d{8,14})\b/;

/**
 * 单人时长的上限（用于抽取时的合理性判断）。
 *
 * 注意：这**不是**平台的单次 50 小时上限。
 * 一个人在一个项目里累计可以有远超 50 小时的总时长，
 * 只是系统要求分多次录入。所以这里必须放行 >50 的数值，
 * 否则 80 小时会被当成「没有时长」直接丢掉。
 * 999 只是一个防御性上界，避免把年份、门牌号之类误当时长。
 */
const MAX_HOURS_TOTAL = 999;

/** 常见的中文姓名分隔与噪声 */
const NOISE_WORDS = [
  '身份证', '身份证号', '证件号', '学号', '姓名', '志愿时长', '时长', '服务时长',
  '小时', '备注', '原因', '合计', '总计', '共', '以下', '名单', '序号', '汇总',
  '志愿者', '同学', '学生', '电话', '手机', '班级', '学院', '专业', '备注：',
];

/** 从一行里剥掉所有已被识别的字段，剩下的当作姓名候选 */
function extractNameCandidate(line, consumed) {
  let rest = consumed ? blankRanges(line, consumed) : line;

  // 移除噪声词
  for (const w of NOISE_WORDS) {
    rest = rest.split(w).join(' ');
  }
  // 移除常见标点与分隔符
  rest = rest
    .replace(/[，,、;；:：|/\\()（）\[\]【】<>《》"'`~!@#$%^&*_+=?？。.．\-—\s]+/g, ' ')
    .trim();

  // 去掉纯数字残留
  rest = rest.replace(/\b\d+(?:\.\d+)?\b/g, ' ').replace(/\s+/g, ' ').trim();

  // 取候选：优先 2-5 个汉字的串
  const tokens = rest.split(/\s+/).filter(Boolean);
  const cn = tokens.filter((t) => /^[\u4e00-\u9fa5·]{2,6}$/.test(t));
  if (cn.length) return cn[0];

  // 兜底：从整块里找第一个 2-5 汉字串
  const m = rest.match(/[\u4e00-\u9fa5·]{2,5}/);
  return m ? m[0] : '';
}

/**
 * 行里是否含人名（排除噪声词）
 *
 * 用于区分「表头行」和「缺身份证的数据行」：
 *   姓名 身份证 时长        → 无数字、无人名 → 表头，跳过
 *   合计 8 人                → 「合计」是噪声词 → 表头，跳过
 *   张三 8                   → 有人名有数字 → 数据行，应报「缺身份证」
 */
function containsPersonName(line) {
  const stripped = line.replace(/[，,、;；:：|/\\()（）\[\]【】<>《》\s]+/g, ' ');
  for (const m of stripped.matchAll(/[\u4e00-\u9fa5·]{2,6}/g)) {
    const tok = m[0];
    // 整词是噪声词，或完全包含在某个噪声词里，都算噪声
    if (NOISE_WORDS.some((w) => tok === w || w.includes(tok))) continue;
    return true;
  }
  return false;
}

/**
 * 把若干「已识别区间」替换成等长空格。
 *
 * 为什么按区间而不是按字符串替换：
 *   字符串替换（split/join）会删掉**所有**出现。
 *   时长是 `1` 时，`2025.12.9` 里的 `1` 也会被删掉，备注就毁了。
 *   所以必须记住每个字段在原文里的确切位置，只挖那一段。
 *
 * 用空格而不是删掉，是为了保持下标不变，后面的正则还能用原始下标。
 */
function blankRanges(s, ranges) {
  if (!ranges || !ranges.length) return s;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.start >= s.length) continue;   // 重叠或越界，跳过
    out += s.slice(pos, r.start);
    out += ' '.repeat(Math.min(r.end, s.length) - r.start);
    pos = Math.min(r.end, s.length);
  }
  out += s.slice(pos);
  return out;
}

/**
 * 把日期、时间里的数字挖掉，避免它们被误当成志愿时长。
 *
 * 用户的备注里经常有「2025.12.9下午3：00到4：00在学校…」这类内容。
 * 如果不挖掉，找时长时就会同时看到 1、3、4 三个数字，
 * 程序只能报「无法确定」，可人一眼就知道时长是 1。
 *
 * 注意不要误伤「1小时」：这里只处理「3：00」这种冒号时间、
 * 「3点」这种钟点，以及完整的年月日。
 *
 * 替换成等长空格（不是删掉），这样下标仍然对得上原文。
 */
function maskDatesAndTimes(s) {
  const blank = (str, re) => str.replace(re, (mm) => ' '.repeat(mm.length));
  let out = String(s ?? '');
  // 时间：3：00、3:00:00
  out = blank(out, /\d{1,2}\s*[：:]\s*\d{2}(?:\s*[：:]\s*\d{2})?/g);
  // 钟点：3点、3点半
  out = blank(out, /\d{1,2}\s*点(?:半|\d{1,2}\s*分)?/g);
  // 日期：2025.12.9、2025-12-09、2025/12/9、2025年12月9日
  out = blank(out, /\d{4}\s*[.\-/年]\s*\d{1,2}\s*[.\-/月]\s*\d{1,2}\s*日?/g);
  out = blank(out, /\d{1,2}\s*月\s*\d{1,2}\s*日/g);
  // 单独的年份：2025
  out = blank(out, /(?<![\d.])(19|20)\d{2}(?![\d.])/g);
  return out;
}

/** 字段标签词：这些词只是「姓名：」「学号：」这类前缀，本身不是内容 */
const LABEL_WORDS = [
  '志愿者姓名', '学生姓名', '姓名', '名字',
  '学生学号', '学号', '学籍号',
  '身份证号码', '身份证号', '身份证', '证件号码', '证件号', '公民身份号码',
  '志愿时长', '服务时长', '服务时间', '时长', '小时数',
  '备注', '原因', '事由', '说明',
  '序号', '编号',
];

/**
 * 判断「剩下的文本」能不能当备注。
 *
 * 要谨慎：这一段是位置推断出来的，不能把表格里的杂音当备注。
 * 典型反例：一行写成「姓名：王五 学号：xx 身份证：xx 时长：8」时，
 * 值都被吃掉了，剩下的是「姓名： 学号： 身份证」这堆标签 ——
 * 它看起来像文字，其实什么内容都没有，不能当备注。
 */
function cleanLeftoverAsRemark(text) {
  const t = String(text ?? '')
    // 去掉分隔符与残留标点
    .replace(/[\t\r\n]/g, ' ')
    .replace(/^[\s,，、;；|:：/\\-]+/, '')
    .replace(/[\s,，、;；|:：/\\-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!t) return '';
  // 纯数字/纯小数点是时长或学号，不是备注
  if (/^[\d.\s]+$/.test(t)) return '';
  // 太短的多半是残留，不足以当说明
  if (t.length < 2) return '';
  // 只是噪声词
  if (NOISE_WORDS.includes(t)) return '';

  // 只由标签和分隔符组成 → 没有实际内容，不算备注
  // （注意：这里只在「判定」时把标签去掉，不改动原文，
  //   否则会把「因故原因说明」这类真备注里的字误删）
  let residue = t;
  for (const w of LABEL_WORDS) residue = residue.split(w).join(' ');
  residue = residue.replace(/[\s,，、;；|:：/\\\-]+/g, '').trim();
  if (!residue) return '';
  // 去掉标签后只剩一两个字，基本是残渣
  if (residue.length < 2) return '';

  return t;
}

/**
 * 解析单行文本
 * @returns {{
 *   name:string, idCard:string, idCardMasked:boolean, studentId:string,
 *   hours:number|null, remark:string, raw:string,
 *   confident:boolean, issues:string[]
 * }}
 */
export function parseLine(rawLine) {
  const raw = String(rawLine ?? '').trim();
  const issues = [];
  /**
   * 已识别字段在原文里的区间 [{start, end}]。
   * 用区间而不是字符串，是因为字符串替换会误删同样内容的其它位置
   * （时长 `1` 会把 `2025.12.9` 里的 `1` 一起删掉）。
   */
  const consumed = [];
  const eat = (match, group = 0) => {
    if (!match) return;
    consumed.push({ start: match.index, end: match.index + match[group].length });
  };

  let idCard = '';
  let idCardMasked = false;
  let studentId = '';
  let hours = null;
  let remark = '';

  // ---------- 1. 身份证号 ----------
  let m = raw.match(ID_18);
  if (m) {
    idCard = normalizeIdCard(m[1]);
    eat(m);
  } else {
    m = raw.match(ID_MASKED);
    if (m) {
      // 打码的不能用，只标记出来
      idCardMasked = true;
      eat(m);
      issues.push('身份证号被打码，需要补全真实号码');
    } else {
      // 15 位要小心：学号也可能是 8-14 位，15 位整串更像老身份证
      m = raw.match(ID_15);
      if (m) {
        // 排除它同时是更长数字串一部分的情况
        const idx = m.index;
        const before = raw[idx - 1];
        const after = raw[idx + m[0].length];
        if (!/\d/.test(before || '') && !/\d/.test(after || '')) {
          idCard = normalizeIdCard(m[1]);
          eat(m);
        }
      } else {
        // 完全没匹配上：看看是不是「位数不对」的长号码（多一位/少一位很常见）。
        // 必须把它吃掉，否则它会漏进备注里 —— 用户会看到备注变成一串身份证号。
        const long = raw.match(/(?<!\d)(\d{16,20}[Xx]?)(?![\dXx])/);
        if (long) {
          eat(long);
          const n = long[1].replace(/[Xx]$/, '').length;
          issues.push(`身份证号位数不对：读到 ${n} 位，应为 18 位`);
        }
      }
    }
  }

  // ---------- 2. 时长（带单位：8小时 / 8h）----------
  m = raw.match(HOURS_PATTERN);
  if (m) {
    hours = Number(m[1]);
    eat(m);
  }

  // ---------- 3. 学号（在身份证之后找，避免误吞） ----------
  for (const sm of raw.matchAll(new RegExp(STUDENT_ID.source, 'g'))) {
    const v = sm[1];
    if (idCard && idCard.includes(v)) continue;
    if (hours !== null && String(hours) === v) continue;
    // 落在已识别区间里的跳过
    if (consumed.some((c) => sm.index >= c.start && sm.index < c.end)) continue;
    if (v.length >= 8 && v.length <= 14) {
      studentId = v;
      eat(sm);
      break;
    }
  }

  // ---------- 4. 时长兜底：没有单位时，找"孤立的小数字" ----------
  if (hours === null) {
    // 关键：先把已识别的身份证/学号「挖掉」（替换成空格，下标不变），
    // 否则会从身份证号内部抠出数字段当时长。
    let working = blankRanges(raw, consumed);
    // 再把任何长度 >= 8 的连续数字串整段挖掉（身份证/学号残留）
    working = working.replace(/\b\d{8,}\b/g, (mm) => ' '.repeat(mm.length));
    // 再把日期、时间里的数字挖掉，否则备注里的「3：00」会被当成候选时长
    working = maskDatesAndTimes(working);

    // 优先看带标签的：时长：8 / 时长 80
    const labeled = working.match(/(?:时长|小时数|服务时长)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)/);
    if (labeled) {
      const v = Number(labeled[1]);
      if (v > 0 && v <= MAX_HOURS_TOTAL) {
        hours = v;
        eat({ index: labeled.index, 0: labeled[0] });
      }
    } else {
      // 允许 1-3 位整数：4 位及以上多是年份，不该被当时长
      const found = [...working.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d+)?)(?![\d.])/g)]
        .filter((x) => {
          const n = Number(x[1]);
          return n > 0 && n <= MAX_HOURS_TOTAL;
        });
      const uniq = [...new Set(found.map((x) => x[1]))];
      if (uniq.length === 1) {
        hours = Number(uniq[0]);
        // 取第一个匹配的位置（值相同，位置也确定）
        eat(found[0]);
      } else if (uniq.length > 1) {
        issues.push(`发现多个可能的时长数字（${uniq.join('、')}），无法确定，需人工指定`);
      } else {
        issues.push('未找到时长');
      }
    }
  }

  // ---------- 5. 姓名 ----------
  // 注意顺序：姓名必须在备注之前提出来。
  // 因为「无标签备注」是靠「扣掉已识别字段后剩下的文本」来定位的，
  // 如果姓名还没扣掉，姓名自己就会变成备注。
  const name = extractNameCandidate(raw, consumed);
  if (!name) issues.push('未能识别姓名');

  // ---------- 6. 备注 ----------
  // 两种写法都要支持：
  //   a) 带标签：「备注：xxx」「原因：xxx」
  //   b) 不带标签：表格里第 4 列就是备注（用户真实格式）
  let remarkSource = '';
  const rm = raw.match(/(?:备注|原因|事由|说明)\s*[:：]\s*(.+)$/);
  if (rm) {
    remark = rm[1].trim();
    remarkSource = 'labeled';
  } else {
    // 无标签：把身份证、时长、学号、姓名都挖掉，剩下的就是备注
    let leftover = blankRanges(raw, consumed);
    if (name) {
      // 姓名可能出现在任意位置，逐个挖掉
      let from = 0;
      while (true) {
        const i = leftover.indexOf(name, from);
        if (i === -1) break;
        leftover = leftover.slice(0, i) + ' '.repeat(name.length) + leftover.slice(i + name.length);
        from = i + name.length;
      }
    }
    const cleaned = cleanLeftoverAsRemark(leftover);
    if (cleaned) {
      remark = cleaned;
      remarkSource = 'positional';
    }
  }

  // ---------- 7. 身份证校验 ----------
  if (idCard) {
    const v = validateIdCard(idCard);
    if (!v.ok) issues.push(`身份证校验失败：${v.reason}`);
  } else if (!idCardMasked && !issues.some((s) => /身份证号位数不对/.test(s))) {
    // 位数不对的情况步骤 1 已经报过，这里不要重复
    issues.push('未找到身份证号');
  }

  return {
    name,
    idCard,
    idCardMasked,
    studentId,
    hours,
    remark,
    remarkSource,
    raw,
    confident: issues.length === 0,
    issues,
  };
}

/**
 * 解析整段文本
 *
 * 会自动跳过表头行、标题行、空行、纯说明行。
 * 会尝试把「一行挤了多个人」的文本拆开（Word/微信复制常丢换行）。
 *
 * @param {string} text
 * @returns {{records:Array, skipped:Array, warnings:Array, splitLines:Array}}
 */
export function parseText(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim());

  const records = [];
  const skipped = [];
  const warnings = [];
  const splitLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // ---------- 优先：一行多人 ----------
    // 从 Word / 微信复制时换行常丢失，若不处理会「只出第一个人」，
    // 后面的人被静默丢弃——用户以为录完了，实际漏人。
    const people = splitPeople(line);
    if (people && people.length >= 2) {
      for (const p of people) {
        p.lineNo = i + 1;
        records.push(p);
      }
      splitLines.push({ line, lineNo: i + 1, count: people.length });
      continue;
    }

    // 疑似多人但拆不出来：要明确告知，不能默默只留一个
    const rawIdCount = [...line.matchAll(/(?<!\d)\d{17}[\dXx](?!\d)/g)].length;
    if (rawIdCount >= 2) {
      warnings.push(
        `第 ${i + 1} 行出现 ${rawIdCount} 个 18 位号码，但都不像合法身份证，` +
        `未做拆分，请检查这行`
      );
    }

    // 跳过明显的表头/标题行：不含身份证也没有时长的短行
    const hasId = ID_18.test(line) || ID_15.test(line) || ID_MASKED.test(line);
    const hasHours = HOURS_PATTERN.test(line);

    // 「有人名 + 有数字」即使没身份证，也是数据行（只是缺了身份证），
    // 不能当成表头跳过——否则用户以为处理完了，实际整行被吞掉。
    const looksLikeData = hasId || hasHours || (/\d/.test(line) && containsPersonName(line));

    if (!looksLikeData) {
      // 可能是表头，也可能是一行纯说明
      skipped.push({ line, lineNo: i + 1, reason: '既无身份证号也无时长，判定为表头或说明行' });
      continue;
    }

    const rec = parseLine(line);
    rec.lineNo = i + 1;
    records.push(rec);
  }

  // 归纳警告
  // 注意：自动拆分的信息放在 splitLines 里结构化返回，
  // 不再重复塞进 warnings —— 否则界面/命令行会显示两遍同样的话。
  const noHours = records.filter((r) => r.hours === null);
  if (noHours.length) {
    warnings.push(`${noHours.length} 人没识别出时长`);
  }
  const masked = records.filter((r) => r.idCardMasked);
  if (masked.length) {
    warnings.push(`${masked.length} 人的身份证被打码，无法使用`);
  }

  return { records, skipped, warnings, splitLines };
}

/** 从整段文本里，尝试找出一个统一备注（比如开头写的"补录原因：xx"） */
export function guessGlobalRemark(text) {
  const m = String(text ?? '').match(/(?:补录原因|统一原因|事由|原因)\s*[:：]\s*(.+)/);
  return m ? m[1].trim() : '';
}
