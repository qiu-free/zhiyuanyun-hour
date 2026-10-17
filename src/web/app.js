/**
 * 志愿云时长录入助手 —— 前端逻辑
 *
 * 无框架，原生 JS。状态集中在 state 里，改动后调用 render* 重绘。
 * 所有校验都在前端也做一遍（后端已做），这样编辑时能立刻给反馈。
 */

'use strict';

/** 系统单次录入上限（与后端 LIMITS.MAX_HOURS_PER_ENTRY 保持一致） */
const MAX_PER_ENTRY = 50;

/**
 * 系统时间锁：单次录入时长 → 下次可录入需等待的小时数
 * 与后端 src/core/schedule.js 的 TIME_LOCK 一致。
 */
const TIME_LOCK = [
  { maxHours: 10, waitHours: 24 },
  { maxHours: 20, waitHours: 48 },
  { maxHours: 30, waitHours: 72 },
  { maxHours: 40, waitHours: 96 },
  { maxHours: 50, waitHours: 120 },
];

// ============================================================
// 状态
// ============================================================
const state = {
  records: [],        // 当前记录（用户可编辑）
  skipped: [],        // 被跳过的行
  warnings: [],       // 解析阶段的提示
  splitLines: [],     // 没有换行、被自动拆分的行
  summary: null,
  guessedRemark: '',
  sourceLabel: '',    // 数据来源说明（文本 / 文件名）
  headers: null,      // Excel 的原始表头
  mapping: null,      // 列识别结果（字段 → 列号）
  missingColumns: [], // 没认出来的必需列
  sheetName: null,    // 读取的工作表名
  schedule: null,
};

// ============================================================
// 工具
// ============================================================
const $ = (sel) => document.querySelector(sel);

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

/**
 * 页内确认框，返回 Promise<boolean>。
 *
 * 为什么不用 window.confirm：
 *   原生确认框在被嵌入的页面（iframe / webview / 某些浏览器设置）里
 *   会**直接返回 false 而不弹窗**。用户看到的现象就是「点了清空没反应」——
 *   实际的 bug 报告正是这个。自己画一个就不受宿主环境影响。
 */
function askConfirm(message, { okText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const box = $('#confirm');
    const ok = $('#confirm-ok');
    const cancel = $('#confirm-cancel');

    $('#confirm-msg').textContent = message;
    ok.textContent = okText;
    cancel.textContent = cancelText;
    ok.className = 'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-primary');

    box.classList.remove('hidden');
    ok.focus();

    const done = (v) => {
      box.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

/**
 * 取浏览器端实现（core/pipeline.js 的浏览器包装）。
 *
 * 为什么用动态 import：
 *   app.js 保持**普通脚本**（不是 ES module），因为自检脚本用
 *   vm.runInContext 直接执行它，模块语法在那里跑不了。
 *   动态 import() 在普通脚本里也能用，所以两边都满足。
 *
 * 拿到之后，所有计算都在本地完成 —— 静态站点没有服务端，
 * 数据（含身份证号）不会离开使用者的浏览器。
 */
let _localApi = null;
let _localApiFailed = false;
async function getLocalApi() {
  if (_localApi || _localApiFailed) return _localApi;
  try {
    _localApi = await import('./localApi.js');
  } catch (e) {
    // 例如宿主禁止动态 import，或文件缺失；退回 HTTP 方式
    _localApiFailed = true;
    console.warn('本地实现不可用，退回接口方式：', e && e.message);
  }
  return _localApi;
}

async function api(path, payload) {
  const local = await getLocalApi();
  if (local) return local.localApi(path, payload);

  // ---- 兜底：走 HTTP（本地服务或自建后端）----
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, error: '服务器返回了无法解析的内容' }));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 身份证打码显示 */
function maskId(id) {
  const s = String(id || '');
  if (s.length < 10) return s;
  if (/\*/.test(s)) return s;
  return s.slice(0, 6) + '*'.repeat(s.length - 10) + s.slice(-4);
}

/** 「还要等 N 小时」→ 可读文字 */
function hrsLabel(h) {
  if (h <= 0) return '现在';
  if (h < 24) return `${h} 小时后`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r === 0 ? `${d} 天后` : `${d} 天 ${r} 小时后`;
}

/** 把总时长按单次上限切分（与后端 splitBatches 的 few 策略一致） */
function splitHours(total) {
  const out = [];
  let remain = Math.round(Number(total) * 10) / 10;
  while (remain > 0) {
    const take = Math.round(Math.min(MAX_PER_ENTRY, remain) * 10) / 10;
    remain = Math.round((remain - take) * 10) / 10;
    out.push(take);
  }
  return out;
}

/** 单批时长 → 需要等待多少小时（与后端 waitHoursFor 一致） */
function waitAfter(hours) {
  const t = TIME_LOCK.find((x) => hours <= x.maxHours);
  return t ? t.waitHours : 120;
}

// ============================================================
// 标签页
// ============================================================
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#pane-${tab.dataset.tab}`).classList.add('active');
  });
});

// ============================================================
// 文件上传
// ============================================================
const dropzone = $('#dropzone');
const fileInput = $('#file-input');
let pendingFile = null;

$('#pick-file').addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', (e) => {
  if (e.target.id !== 'pick-file') fileInput.click();
});

['dragenter', 'dragover'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
  });
});

dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) setFile(f);
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) setFile(f);
});

// 「取消选择」：选错文件时可以退回未选择状态
$('#file-clear')?.addEventListener('click', (e) => {
  e.stopPropagation();   // 别让点击冒泡到拖拽区，否则又弹出选择框
  clearFile();
});

function setFile(f) {
  const ok = /\.(xlsx|xls|csv)$/i.test(f.name);
  if (!ok) {
    toast('只支持 .xlsx / .xls / .csv 文件');
    return;
  }
  pendingFile = f;
  $('#file-info').textContent = `已选择：${f.name}　(${(f.size / 1024).toFixed(1)} KB)`;
  // 选好文件后出现「取消选择」，否则用户选错了只能重新选，没法退回空状态
  $('#file-clear')?.classList.remove('hidden');
}

/** 清空已选文件，回到「未选择」状态 */
function clearFile() {
  pendingFile = null;
  // 必须同时清掉 input 的 value，否则再选同一个文件不会触发 change 事件
  if (fileInput) fileInput.value = '';
  $('#file-info').textContent = '还没有选择文件';
  $('#file-clear')?.classList.add('hidden');
  toast('已取消选择');
}

// ============================================================
// 主流程：处理
// ============================================================
$('#btn-parse').addEventListener('click', async () => {
  const btn = $('#btn-parse');
  const reason = $('#reason-input').value.trim();
  const activeTab = document.querySelector('.tab.active').dataset.tab;

  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = '处理中…';

  try {
    let data;
    if (activeTab === 'file') {
      if (!pendingFile) {
        toast('请先选择一个 Excel 文件');
        return;
      }
      const base64 = await fileToBase64(pendingFile);
      data = await api('/api/upload', {
        filename: pendingFile.name,
        base64,
        reason,
      });
      state.sourceLabel = pendingFile.name;
    } else {
      const text = $('#text-input').value;
      if (!text.trim()) {
        toast('请先粘贴名单文本');
        return;
      }
      data = await api('/api/parse', { text, reason });
      state.sourceLabel = '粘贴的文本';
    }

    state.records = data.records || [];
    state.skipped = data.skipped || [];
    state.warnings = data.warnings || [];
    state.splitLines = data.splitLines || [];
    // 重复检测结果：后端（core/pipeline.js）算好并挂在记录上，
    // 这里只负责展示。重复的行已经被标成不可用，不会进粘贴文本。
    state.duplicates = data.duplicates || [];
    state.sameNameWarnings = data.sameNameWarnings || [];
    state.summary = data.summary || null;
    state.guessedRemark = data.guessedRemark || '';
    state.schedule = null;
    // 记下 Excel 的列识别结果，供界面展示（认错列时用户能看出来）
    state.headers = data.headers || null;
    state.mapping = data.mapping || null;
    state.missingColumns = data.missingColumns || [];
    state.sheetName = data.sheetName || null;

    if (!state.records.length) {
      toast('没能从内容里提取到任何记录');
      return;
    }

    // 发生过自动拆分时明确告诉用户（避免"以为只处理了一部分"或"没注意漏人"）
    if (state.splitLines.length) {
      const people = state.splitLines.reduce((s, x) => s + x.count, 0);
      toast(`有 ${state.splitLines.length} 行没有换行，已自动拆成 ${people} 人`, 3600);
    }

    // 有重复的人：这条必须让用户看见，否则不知不觉就少录了一个人
    // （重复行被排除，看起来"处理成功"，但实际可用条数比预期少）
    if (state.duplicates.length) {
      const names = state.duplicates.map((d) => d.name || `第${d.lineNo}行`).join('、');
      toast(`⚠️ 发现 ${state.duplicates.length} 条重复（${names}），已自动排除`, 5200);
    } else if (state.sameNameWarnings.length) {
      toast(`有 ${state.sameNameWarnings.length} 个重名的情况，请看下方提醒`, 4200);
    }

    // 若文本里自带「补录原因」且用户没填，自动带入
    if (!reason && state.guessedRemark) {
      $('#reason-input').value = state.guessedRemark;
    }

    $('#sec-input').classList.add('hidden');
    $('#sec-result').classList.remove('hidden');
    $('#sec-schedule').classList.add('hidden');

    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // 处理完自动复制到剪贴板。
    // 这个工具的出口就是「把文本贴到志愿云后台」，所以直接放好剪贴板，
    // 省掉一次点击。注意必须在 renderAll() 之后 —— 兜底路径要选中页面上的元素。
    // 顺带一个好处：点击「开始处理」本身就是用户手势，
    // 剪贴板 API 需要的手势授权此时仍然有效。
    if (state.records.some((r) => r.usable)) {
      await doCopy({ silent: true });
    }
  } catch (e) {
    toast(e.message, 3600);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '开始处理';
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

// ============================================================
// 渲染
// ============================================================

/** 前端即时校验（与后端规则一致，用于编辑时反馈） */
function checkRecord(rec) {
  const problems = [];

  const name = String(rec.name || '').trim();
  if (!name) problems.push({ field: 'name', level: 'error', message: '姓名为空' });

  const id = String(rec.idCard || '').trim();
  if (!id) {
    problems.push({ field: 'idCard', level: 'error', message: '缺少身份证号' });
  } else if (/\*/.test(id)) {
    problems.push({ field: 'idCard', level: 'error', message: '身份证号被打码' });
  } else if (!/^\d{15}$|^\d{17}[\dXx]$/.test(id)) {
    problems.push({ field: 'idCard', level: 'error', message: `格式不对（${id.length} 位）` });
  } else {
    // 校验位（18 位）
    if (id.length === 18) {
      const W = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
      const C = ['1','0','X','9','8','7','6','5','4','3','2'];
      let sum = 0;
      for (let i = 0; i < 17; i++) sum += Number(id[i]) * W[i];
      const exp = C[sum % 11];
      if (id[17].toUpperCase() !== exp) {
        problems.push({ field: 'idCard', level: 'error', message: `校验位错误（应为 ${exp}）` });
      }
    }
  }

  // ---------- 重复 ----------
  // 这一项由后端（core/pipeline.js 的 markDuplicates）算出来并挂在记录上。
  // 前端重算状态时必须原样保留，否则 renderAll() 一跑就把重复标记冲掉了，
  // 重复的人会重新变成「可用」，粘到后台就给同一人录两次时长。
  if (rec.duplicateOf !== null && rec.duplicateOf !== undefined) {
    problems.push({
      field: 'idCard',
      level: 'error',
      message: rec.duplicateKind === 'exact'
        ? `与第 ${rec.duplicateOf} 行完全相同，重复录入会让时长翻倍`
        : `与第 ${rec.duplicateOf} 行是同一人（身份证号相同），重复录入会让时长翻倍`,
    });
  }

  const h = rec.hours;
  if (h === null || h === undefined || h === '') {
    problems.push({ field: 'hours', level: 'error', message: '缺少时长' });
  } else {
    const n = Number(h);
    if (!Number.isFinite(n) || n <= 0) {
      problems.push({ field: 'hours', level: 'error', message: '时长必须是正数' });
    } else if (n > MAX_PER_ENTRY) {
      // 超过单次上限不是数据错误，是「一次录不完」。
      // 数值保留，标成 split，让用户知道要分几次。
      const batches = Math.ceil(n / MAX_PER_ENTRY);
      problems.push({
        field: 'hours',
        level: 'split',
        message: `共 ${n} 小时，超过单次上限 ${MAX_PER_ENTRY} 小时，需分 ${batches} 次录入`,
      });
    }
  }

  const rk = String(rec.remark || '').trim();
  if (!rk) {
    problems.push({ field: 'remark', level: 'missing', message: '缺少补录原因（需向发起人确认）' });
  } else if (rk.includes(',')) {
    problems.push({ field: 'remark', level: 'error', message: '备注含英文逗号，会破坏列结构' });
  }

  const hasError = problems.some((p) => p.level === 'error');
  const hasMissing = problems.some((p) => p.level === 'missing');
  const hasSplit = problems.some((p) => p.level === 'split');
  const hasWarn = problems.some((p) => p.level === 'warn');

  return {
    problems,
    // 五级状态：error > missing > split > warn > ok
    // warn  = 能导出，但建议确认
    // split = 能导出，但一次录不完，需分多次
    // 两者都不能和 error 混为一谈，否则用户会以为整行不可用。
    status: hasError ? 'error'
      : hasMissing ? 'missing'
        : hasSplit ? 'split'
          : hasWarn ? 'warn' : 'ok',
    usable: !hasError && !hasMissing,
    needsSplit: hasSplit,
    splitBatches: hasSplit
      ? Math.ceil(Number(rec.hours) / MAX_PER_ENTRY)
      : 1,
  };
}

function renderAll() {
  // 重算每条的状态
  state.records.forEach((r) => {
    const c = checkRecord(r);
    r.problems = c.problems;
    r.status = c.status;
    r.usable = c.usable;
    r.needsSplit = c.needsSplit;
    r.splitBatches = c.splitBatches;
  });
  renderStats();
  renderNotices();
  renderTable();
  renderSkipped();
  renderOutput();
  renderBatchPanel();
  renderMultiPanel();
}

function renderStats() {
  const rs = state.records;
  const ok = rs.filter((r) => r.status === 'ok').length;
  const err = rs.filter((r) => r.status === 'error').length;
  const miss = rs.filter((r) => r.status === 'missing').length;
  const warn = rs.filter((r) => r.status === 'warn').length;
  const split = rs.filter((r) => r.status === 'split').length;
  const totalHours = rs.filter((r) => r.usable).reduce((s, r) => s + (Number(r.hours) || 0), 0);

  // 一次性可录：可用且不超单次上限
  const oneShot = rs.filter((r) => r.usable && !r.needsSplit);
  const oneShotHours = Math.round(oneShot.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 10) / 10;

  // 待处理 = 需要用户做事的条数（改数据的 + 去问发起人的）
  const pending = err + miss;
  const allGood = pending === 0 && rs.length > 0;

  // 两层视觉权重：第一层「能用几条 / 要处理几条」最大，
  // 第二层是辅助数字，压小、不带彩色。
  $('#stats').innerHTML = `
    <div class="stat stat-lead ${allGood ? 'ok' : ''}">
      <div class="n">${ok + warn + split}</div>
      <div class="l">可以录入</div>
    </div>
    <div class="stat stat-lead ${pending ? 'err' : ''}">
      <div class="n">${pending}</div>
      <div class="l">需要处理</div>
    </div>
    <div class="stat-mini">
      <div class="n">${rs.length}</div><div class="l">识别记录</div>
    </div>
    <div class="stat-mini">
      <div class="n">${totalHours}</div><div class="l">合计小时</div>
    </div>
    <div class="stat-mini ${oneShot.length ? '' : 'warn'}">
      <div class="n">${oneShot.length}</div><div class="l">可一次录完</div>
    </div>
    ${split ? `<div class="stat-mini split"><div class="n">${split}</div><div class="l">需分批</div></div>` : ''}
    ${warn ? `<div class="stat-mini warn"><div class="n">${warn}</div><div class="l">可确认提示</div></div>` : ''}
    ${miss ? `<div class="stat-mini warn"><div class="n">${miss}</div><div class="l">待报备</div></div>` : ''}
    ${err ? `<div class="stat-mini err"><div class="n">${err}</div><div class="l">数据有错</div></div>` : ''}
  `;
}

function renderNotices() {
  const box = $('#notices');
  const parts = [];

  const errs = state.records.filter((r) => r.status === 'error');
  const misses = state.records.filter((r) => r.status === 'missing');
  const warns = state.records.filter((r) => r.status === 'warn');
  const splits = state.records.filter((r) => r.status === 'split');

  /** 人名列最多 3 个，剩下的说「等 N 人」 */
  const nameBrief = (list) => {
    const head = list.slice(0, 3).map((r) => r.name || '(无姓名)').join('、');
    return list.length > 3 ? `${esc(head)} 等 ${list.length} 人` : esc(head);
  };

  // 提示条只讲「结论 + 该做什么」，不复制表格内容

  // 列识别结果：Excel 来源时展示，让"认错列"一眼可见
  // （表头写成「身份证（记得开隐私）」这类带注释的，以前会整列认不出来）
  if (state.headers) {
    const FIELD_CN = {
      name: '姓名', studentId: '学号', idCard: '身份证号',
      hours: '志愿时长', remark: '备注', seq: '序号',
    };
    const mapped = Object.entries(state.mapping || {})
      .filter(([, idx]) => idx !== undefined && idx !== null)
      .map(([field, idx]) => {
        const h = String(state.headers[idx] ?? '').trim();
        return `<li><strong>${FIELD_CN[field] || field}</strong> ← 第 ${idx + 1} 列「${esc(h)}」</li>`;
      }).join('');

    const missing = state.missingColumns || [];
    const extra = (state.headers || [])
      .map((h, i) => ({ h, i }))
      .filter(({ i }) => !Object.values(state.mapping || {}).includes(i))
      .map(({ h }) => String(h ?? '').trim())
      .filter(Boolean);

    if (missing.length) {
      parts.push(`
        <div class="notice notice-error">
          <h4>❌ 没能认出这些必需的列：${missing.map((f) => FIELD_CN[f] || f).join('、')}</h4>
          <p>读到的表头是：${(state.headers || []).map((h) => `「${esc(String(h))}」`).join('　')}</p>
          <p><strong>怎么办：</strong>把表头改成工具认得的写法再试一次。
             常见写法：<code>姓名</code>、<code>身份证号</code>、<code>志愿时长</code>。</p>
          <p class="notice-sub">带括号说明也可以（如「身份证（备注）」），
             但列名里必须含有上面这些词。</p>
        </div>`);
    } else {
      parts.push(`
        <div class="notice notice-cols">
          <h4>📋 列识别结果（请核对）</h4>
          <ul class="col-list">${mapped}</ul>
          ${extra.length ? `<p class="notice-sub">忽略的列：${extra.map((h) => `「${esc(h)}」`).join('　')}</p>` : ''}
        </div>`);
    }
  }

  // 自动拆分提示：这是用户最需要知道的一件事——
  // 他的文本本来没有换行，程序替他拆了，必须让他核对拆得对不对。
  if (state.splitLines.length) {
    const people = state.splitLines.reduce((s, x) => s + x.count, 0);
    const lines = state.splitLines.map((x) => `第 ${x.lineNo} 行 → ${x.count} 人`).join('；');
    parts.push(`
      <div class="notice notice-split">
        <h4>✂️ 检测到 ${state.splitLines.length} 行没有换行，已自动拆成 ${people} 人</h4>
        <p>${esc(lines)}</p>
        <p><strong>请核对下表人名和时长是否对应正确</strong>——
           拆分靠身份证号定位，如果原文没有分隔清楚，可能配错。改完再导出。</p>
      </div>`);
  }

  // 重复的人：这是最需要拦住的一类问题。
  // 同一身份证号录两次，后台不会报错，但那个人的时长会凭空翻倍，
  // 而且录进去之后改起来很麻烦。所以放在最前面、用红色。
  if (state.duplicates && state.duplicates.length) {
    const rows = state.duplicates
      .map((d) => `第 ${d.lineNo} 行「${d.name || '（无姓名）'}」与第 ${d.firstLineNo ?? '?'} 行重复`)
      .join('；');
    parts.push(`
      <div class="notice notice-error">
        <h4>⛔ 检测到 ${state.duplicates.length} 条重复的人</h4>
        <p>${esc(rows)}</p>
        <p><strong>这些行已自动排除</strong>，不会出现在导出的粘贴文本里 ——
           否则同一个人会被录两次，时长直接翻倍。</p>
        <p class="notice-sub">处理办法：回到上表删掉多余的那一行（点右侧「删除」），
           或者在原始表格/文本里删掉后再处理一次。保留的那一份默认是第一次出现的。</p>
      </div>`);
  }

  // 同名但不同身份证号：不是错误，但很容易录错人，提醒核对
  if (state.sameNameWarnings && state.sameNameWarnings.length) {
    const rows = state.sameNameWarnings
      .map((w) => `「${w.name}」对应 ${w.count} 个不同身份证号（${w.rows}）`)
      .join('；');
    parts.push(`
      <div class="notice notice-warn">
        <h4>👥 有同名志愿者</h4>
        <p>${esc(rows)}</p>
        <p>系统按「姓名 + 身份证号」匹配人，同名不会串号。</p>
        <p class="notice-sub">但这几行请核对一遍：确认每个人配的身份证号是对的，
           别把 A 的时长记到同名的 B 头上。</p>
      </div>`);
  }

  if (misses.length) {
    parts.push(`
      <div class="notice notice-missing">
        <h4>🚩 ${misses.length} 条缺「补录原因」，需要问发起人</h4>
        <p><strong>去问：</strong>本次补录的原因（活动名称）是什么？所有人是否相同？</p>
        <p><strong>然后：</strong>在上方「统一补录原因」里填（所有人同一个），或到下表逐条补。</p>
        <p class="notice-sub">涉及 ${nameBrief(misses)}。程序不会替你编一个原因。</p>
      </div>`);
  }

  // 超过单次上限：不是错误，但要讲清楚「一次录不完、要分几次、要等多久」
  if (splits.length) {
    const maxBatches = Math.max(...splits.map((r) => r.needsSplit ? r.splitBatches : 1));
    const rows = splits.map((r) => {
      const total = Number(r.hours) || 0;
      const batches = Math.ceil(total / MAX_PER_ENTRY);
      const parts = [];
      let remain = total;
      for (let i = 0; i < batches; i++) {
        const take = Math.round(Math.min(MAX_PER_ENTRY, remain) * 10) / 10;
        remain = Math.round((remain - take) * 10) / 10;
        parts.push(take);
      }
      const waits = parts.slice(0, -1).map((h) => {
        const t = TIME_LOCK.find((x) => h <= x.maxHours);
        return t ? t.waitHours : 120;
      });
      const totalWait = waits.reduce((s, x) => s + x, 0);
      return `<tr>
        <td>${esc(r.name)}</td>
        <td>${total} 小时</td>
        <td>${batches} 次</td>
        <td>${parts.map((x) => x + 'h').join(' + ')}</td>
        <td>${totalWait ? hrsLabel(totalWait) : '—'}</td>
      </tr>`;
    }).join('');

    // 需要的项目数（当天全录完）
    const needP = Math.max(...splits.map((r) => Math.ceil(Number(r.hours) / MAX_PER_ENTRY)));
    // 如果只用 1 个项目，最多要等多久
    const maxWait = Math.max(...splits.map((r) => {
      const p = splitHours(r.hours);
      return p.slice(0, -1).reduce((s, h) => s + waitAfter(h), 0);
    }));

    parts.push(`
      <div class="notice notice-needsplit">
        <h4>⏳ ${splits.length} 人的时长超过 ${MAX_PER_ENTRY} 小时，一次录不完</h4>
        <p>系统单次最多录 ${MAX_PER_ENTRY} 小时，这是<strong>每人每次</strong>的硬限制，
           跟你有多少项目无关。这些人要<strong>分几次</strong>录入。</p>
        <table class="lock-table mini-table">
          <thead><tr><th>姓名</th><th>总时长</th><th>需录</th><th>各次时长</th><th>只用 1 个项目要等</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p>两种做法（可以同时用）：</p>
        <ul class="notice-list">
          <li><strong>换项目</strong>：用 <strong>${needP} 个项目</strong>就能全部<strong>当天录完</strong>，
              不用等。点「生成分批录入文本」上方的「换项目分流」。</li>
          <li><strong>原地等</strong>：留在同一个项目分次录，最多要等 <strong>${maxWait ? hrsLabel(maxWait) : '0'}</strong>。
              点下方「生成分批录入文本」按轮次操作。</li>
        </ul>
      </div>`);
  }

  if (errs.length) {
    const list = errs.slice(0, 5).map((r) =>
      `<li>${esc(r.name || '(无姓名)')}：${esc(r.problems.filter((p) => p.level === 'error').map((p) => p.message).join('；'))}</li>`
    ).join('');
    parts.push(`
      <div class="notice notice-error">
        <h4>❌ ${errs.length} 条数据有错，需修改</h4>
        <ul>${list}</ul>
        ${errs.length > 5 ? `<p>… 还有 ${errs.length - 5} 条，见下表</p>` : ''}
        <p><strong>然后：</strong>直接在下面表格里点那一格改。</p>
      </div>`);
  }

  if (warns.length) {
    parts.push(`
      <div class="notice notice-warn">
        <h4>💡 ${warns.length} 条可以录入，但有提示</h4>
        <p>这些行<strong>能正常导出</strong>，只是建议你确认一下（见下表对应格下方的小字）。</p>
      </div>`);
  }

  if (!errs.length && !misses.length) {
    const total = Math.round(state.records.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 10) / 10;
    parts.push(`
      <div class="notice notice-ok">
        <h4>✅ 全部通过检查，可以导出粘贴</h4>
        <p>共 ${state.records.length} 人，合计 ${total} 小时。点下方「复制粘贴文本」即可。</p>
      </div>`);
  }

  box.innerHTML = parts.join('');
}

/** 状态 → 标签与说明（集中定义，保证各处一致） */
const STATUS_META = {
  ok:      { pill: '可用',   cls: 'pill-ok',      row: '' },
  warn:    { pill: '待确认', cls: 'pill-warn',    row: 'row-warn' },
  split:   { pill: '需分批', cls: 'pill-split',   row: 'row-split' },
  missing: { pill: '待报备', cls: 'pill-missing', row: 'row-missing' },
  error:   { pill: '有问题', cls: 'pill-error',   row: 'row-error' },
};

/** 把一条问题渲染成消息元素；level 决定颜色 */
function msgHtml(p) {
  const cls = p.level === 'missing' ? 'msg msg-missing'
    : p.level === 'split' ? 'msg msg-split'
      : p.level === 'warn' ? 'msg msg-warn'
        : 'msg';
  // warn / split 加前缀，与 error 的措辞区分开
  const prefix = p.level === 'warn' ? '提示：' : p.level === 'split' ? '注意：' : '';
  return `<div class="${cls}">${esc(prefix + p.message)}</div>`;
}

function renderTable() {
  const tbody = $('#result-body');

  // 空表状态（P2-18）：删空后不该只剩一个空表头
  if (!state.records.length) {
    tbody.innerHTML = '';
    $('.table-wrap').innerHTML =
      '<div class="empty-state">表格已清空。<br>点右上「重新输入」回到第一步，或直接刷新页面。</div>';
    return;
  }

  tbody.innerHTML = state.records.map((r, i) => {
    const meta = STATUS_META[r.status] || STATUS_META.ok;

    // 关键：只对 error / missing 加红框。
    // warn 的行是「能导出，但建议确认」，画红框会让人以为不能用。
    const markFields = new Set(
      r.problems.filter((p) => p.level === 'error' || p.level === 'missing').map((p) => p.field)
    );
    const invalid = (f) => (markFields.has(f) ? 'invalid' : '');

    // 问题消息挂到对应字段列下方（P0-3），不再全挤在备注列
    const msgsIn = (field) =>
      r.problems.filter((p) => p.field === field).map(msgHtml).join('');

    return `
      <tr class="${meta.row}">
        <td class="rowno">${r.edited ? '<span class="edited-dot" title="你改过这条">·</span>' : ''}${r.lineNo ?? i + 1}</td>
        <td>
          <input data-i="${i}" data-f="name" value="${esc(r.name)}" class="${invalid('name')}">
          ${msgsIn('name')}
        </td>
        <td>
          <input data-i="${i}" data-f="idCard" value="${esc(r.idCard)}"
                 class="mono ${invalid('idCard')}" title="${esc(maskId(r.idCard))}">
          ${msgsIn('idCard')}
        </td>
        <td>
          <input data-i="${i}" data-f="hours" value="${esc(r.hours ?? '')}"
                 class="${invalid('hours')}">
          ${msgsIn('hours')}
        </td>
        <td>
          <input data-i="${i}" data-f="remark" value="${esc(r.remark)}" class="${invalid('remark')}">
          ${msgsIn('remark')}
        </td>
        <td><span class="pill ${meta.cls}">${meta.pill}</span></td>
        <td><button class="btn-del" data-del="${i}" title="删除这条" aria-label="删除 ${esc(r.name)}">✕</button></td>
      </tr>`;
  }).join('');

  // 编辑
  tbody.querySelectorAll('input[data-f]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const i = Number(e.target.dataset.i);
      const f = e.target.dataset.f;
      state.records[i][f] = e.target.value;
      // 标记「用户改过」，方便中途打断后分辨哪些是原始数据
      if (!state.records[i].edited) {
        state.records[i].edited = true;
        const noCell = tbody.children[i]?.children[0];
        if (noCell && !noCell.querySelector('.edited-dot')) {
          noCell.insertAdjacentHTML('afterbegin', '<span class="edited-dot" title="你改过这条">·</span>');
        }
      }
      // 轻量重绘：只更新统计、提示、输出，不重建表格以免打断输入
      state.records.forEach((r) => {
        const c = checkRecord(r);
        r.problems = c.problems; r.status = c.status; r.usable = c.usable;
        r.needsSplit = c.needsSplit; r.splitBatches = c.splitBatches;
      });
      renderStats();
      renderOutput();
      renderNotices();
      updateRowVisual(i);
    });
  });

  // 删除
  tbody.querySelectorAll('button[data-del]').forEach((b) => {
    b.addEventListener('click', (e) => {
      const i = Number(e.currentTarget.dataset.del);
      state.records.splice(i, 1);
      renderAll();
      toast('已删除该条');
    });
  });
}

/** 只更新某一行的状态样式，避免重建整表打断输入 */
function updateRowVisual(i) {
  const tr = $('#result-body').children[i];
  if (!tr) return;
  const r = state.records[i];
  const meta = STATUS_META[r.status] || STATUS_META.ok;

  tr.className = meta.row;

  // 状态标签
  const pillCell = tr.children[5];
  pillCell.innerHTML = `<span class="pill ${meta.cls}">${meta.pill}</span>`;

  // 问题消息按字段挂回对应列
  const CELL = { name: 1, idCard: 2, hours: 3, remark: 4 };
  for (const idx of Object.values(CELL)) {
    tr.children[idx]?.querySelectorAll('.msg').forEach((m) => m.remove());
  }
  for (const p of r.problems) {
    const idx = CELL[p.field];
    if (idx === undefined) continue;
    const d = document.createElement('div');
    d.className = 'msg' + (p.level === 'missing' ? ' msg-missing'
      : p.level === 'split' ? ' msg-split'
        : p.level === 'warn' ? ' msg-warn' : '');
    const prefix = p.level === 'warn' ? '提示：' : p.level === 'split' ? '注意：' : '';
    d.textContent = prefix + p.message;
    tr.children[idx].appendChild(d);
  }

  // 红框只给 error / missing —— warn / split 的行仍然可以导出
  const markFields = new Set(
    r.problems.filter((p) => p.level === 'error' || p.level === 'missing').map((p) => p.field)
  );
  tr.querySelectorAll('input[data-f]').forEach((inp) => {
    inp.classList.toggle('invalid', markFields.has(inp.dataset.f));
  });
}

function renderSkipped() {
  const box = $('#skipped-box');
  if (!state.skipped.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('#skipped-summary').textContent = `已跳过的行（${state.skipped.length}）— 点开查看`;
  $('#skipped-list').innerHTML = state.skipped.map((s) =>
    `<li>第 ${s.lineNo} 行：<code>${esc(s.line)}</code> — ${esc(s.reason)}</li>`
  ).join('');
}

/**
 * 可「一次性」导出的记录。
 *
 * 超过单次上限的人（needsSplit）要排除在外：
 * 他们的时长没法一条粘完，硬导出会让后台拒绝或录错。
 * 这些人由「需分批」面板按批次分别生成文本。
 */
function usableRecords() {
  return state.records.filter((r) => r.usable && !r.needsSplit);
}

/** 时长超过单次上限、需要分多次录入的人 */
function splitRecords() {
  return state.records.filter((r) => r.usable && r.needsSplit);
}

function renderOutput() {
  const list = usableRecords();
  const splits = splitRecords();

  if (!list.length && !splits.length) {
    $('#output-text').textContent = '（暂无可导出的记录）';
    $('#output-meta').textContent = '';
    return;
  }

  if (!list.length) {
    $('#output-text').textContent =
      '（没有「一次就能录完」的人）\n\n' +
      `有 ${splits.length} 人的时长超过 ${MAX_PER_ENTRY} 小时，请点上方「生成分批录入文本」。`;
    $('#output-meta').textContent = `0 人　另有 ${splits.length} 人需分批`;
    return;
  }

  const text = list.map((r) => [r.name, r.idCard, r.hours, r.remark].join(',')).join('\n');
  $('#output-text').textContent = text;
  const total = Math.round(list.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 10) / 10;

  let meta = `${list.length} 人　${total} 小时`;
  if (splits.length) meta += `　（另有 ${splits.length} 人需分批，未包含在此处）`;
  $('#output-meta').textContent = meta;
}

// ============================================================
// 导出
// ============================================================

/** 当前可导出的文本（编辑器、导出、复制共用同一份拼装逻辑） */
function outputText() {
  return usableRecords()
    .map((r) => [r.name, r.idCard, r.hours, r.remark].join(','))
    .join('\n');
}

/**
 * 把文本放进剪贴板。返回 true 表示真的复制成功了。
 *
 * 为什么要分三层：
 *   navigator.clipboard 要求「安全上下文 + 页面已聚焦」。
 *   在 file:// 、局域网 IP、或焦点不在页面时它会直接抛错。
 *   原来只试这一种，失败就退化成「帮你选中，自己按 Ctrl+C」，
 *   用户看到的现象就是「点了没复制」。
 *
 *   第二层 execCommand('copy') 虽已废弃，但在上述场景下往往仍可用，
 *   所以保留作兜底。
 */
async function copyToClipboard(text) {
  // 第一层：现代剪贴板 API
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 继续尝试下一层 */
    }
  }

  // 第二层：临时 textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 只读 + 移出视口：避免页面跳动和移动端弹出键盘
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    /* 落到第三层 */
  }

  return false;
}

/** 复制都失败时：帮用户选中某段文本，提示按 Ctrl+C */
function selectNode(node) {
  if (!node) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch {
    /* 选中失败不致命，用户仍可手动拖选 */
  }
}

async function doCopy(opts = {}) {
  const list = usableRecords();
  if (!list.length) {
    if (!opts.silent) toast('没有可复制的记录');
    return false;
  }

  if (await copyToClipboard(outputText())) {
    toast(`已复制 ${list.length} 条到剪贴板，去志愿云后台直接粘贴`);
    return true;
  }

  selectNode($('#output-text'));
  toast('浏览器不允许自动复制，已帮你选中，按 Ctrl+C 即可', 3600);
  return false;
}

/**
 * 复制页面上某个元素里的文本（分批面板、换项目面板的「复制」按钮都用它）。
 *
 * 为什么要统一走这里：这两个面板原来各自直接调 navigator.clipboard，
 * 没有 execCommand 兜底，也没有「失败就帮你选中」的退路 ——
 * 复制失败时只弹一句提示，用户什么也拿不到，看起来就是按钮坏了。
 *
 * @param {Element} el    要复制的元素
 * @param {string}  label 提示里用的名称，如「项目 2」「第 1 轮」
 * @param {string}  unit  数量单位，如「项」「人」
 */
async function copyFromElement(el, label, unit) {
  if (!el) return false;
  const text = el.textContent || '';
  if (!text.trim()) {
    toast('这里没有可复制的内容');
    return false;
  }

  const count = text.trim().split('\n').length;
  if (await copyToClipboard(text)) {
    toast(`已复制${label}的内容（${count} ${unit}）`);
    return true;
  }

  // 兜底：把这一块选中，用户按 Ctrl+C 就行
  selectNode(el);
  toast(`浏览器不允许自动复制，已帮你选中${label}，按 Ctrl+C 即可`, 3800);
  return false;
}

// 顶部与底部两个复制按钮共用同一逻辑
['#btn-copy', '#btn-copy-top'].forEach((sel) => {
  const el = $(sel);
  if (el) el.addEventListener('click', () => doCopy());
});

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#btn-txt').addEventListener('click', () => {
  const list = usableRecords();
  if (!list.length) return toast('没有可导出的记录');
  downloadText(`志愿云录入模板-${stamp()}.txt`, outputText());
  toast('已下载 .txt');
});

$('#btn-xlsx').addEventListener('click', async () => {
  const list = usableRecords();
  if (!list.length) return toast('没有可导出的记录');
  try {
    let blob;
    const local = await getLocalApi();
    if (local) {
      // 静态站点：本地生成，不发请求
      blob = local.exportXlsxBlob(list);
    } else {
      const res = await fetch('/api/export/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: list }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      blob = await res.blob();
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `志愿云录入模板-${stamp()}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已下载 Excel');
  } catch (e) {
    toast('导出失败：' + e.message, 3200);
  }
});

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ============================================================
// 换项目分流（用「换个项目录」绕过时间锁）
// ============================================================

/**
 * 混合排期：既有 P 个项目、又接受等待，让完成时间最短。
 *
 * 为什么不是简单的「均分」：
 *   均分只适合「项目刚好够」的情况。项目不够时均分会算出超 50 的值
 *   （120h 分 2 个 → 60+60），粘进后台必然失败。
 *
 *   正确做法是贪心：每次挑「最早能录」的项目，尽量录满 50。
 *   例 120h + 2 个项目 → P1 录 50、P2 录 50（当天共 100），
 *   等 120h 后 P1 再录 20 → 5 天完成（均分则做不到，只能等 10 天）。
 *
 * @param {number} total 总时长
 * @param {number} P 可用项目数
 * @returns {Array<{project:number, hours:number, atHour:number}>}
 */
function hybridSteps(total, P) {
  const steps = [];
  const free = new Array(Math.max(1, P)).fill(0);
  let remain = Math.round(Number(total) * 10) / 10;

  while (remain > 0.001) {
    // 挑最早能录的项目（并列时取编号靠前的，保证结果稳定）
    let pi = 0;
    for (let i = 1; i < free.length; i++) if (free[i] < free[pi]) pi = i;

    const atHour = free[pi];
    const take = Math.round(Math.min(MAX_PER_ENTRY, remain) * 10) / 10;

    steps.push({ project: pi + 1, hours: take, atHour });
    free[pi] = atHour + waitAfter(take);
    remain = Math.round((remain - take) * 10) / 10;
  }
  return steps;
}

/** 某个时长在 P 个项目下的完成时刻（小时） */
function hybridFinish(total, P) {
  const steps = hybridSteps(total, P);
  return steps.length ? Math.max(...steps.map((s) => s.atHour)) : 0;
}

/** 渲染分流面板（无超限人员时隐藏） */
function renderMultiPanel() {
  const box = $('#multi-panel');
  if (!box) return;

  const splits = splitRecords();
  if (!splits.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  // 每人算两套方案：只用 1 个项目 vs 用 P 个项目
  const rows = splits.map((r) => {
    const T = Number(r.hours) || 0;
    const single = splitHours(T);
    const singleWait = single.slice(0, -1).reduce((s, h) => s + waitAfter(h), 0);
    // 当天全部录完所需的项目数
    const need = Math.ceil(T / MAX_PER_ENTRY);
    return { r, T, single, singleWait, need };
  }).sort((a, b) => b.T - a.T);

  const needProjects = Math.max(...rows.map((x) => x.need));
  const maxWait = Math.max(...rows.map((x) => x.singleWait));

  box.innerHTML = `
    <div class="card-head">
      <span class="step">5</span>
      <h2>换项目分流</h2>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="btn-close-multi">关闭</button>
    </div>
    <p class="hint">
      时间锁是<strong>同一人在同一项目</strong>的限制。把时长分到不同项目，
      两边<strong>互不等待</strong>，所以只要有足够项目，就能
      <strong>全部当天录完</strong>。志愿者总时长照常累计。
    </p>
    <div class="multi-config">
      <label for="proj-count">
        你有几个项目可用：
        <input type="number" id="proj-count" min="1" max="20" value="${needProjects}">
      </label>
      <button type="button" class="btn btn-sm" id="btn-enough">我项目足够</button>
      <span class="hint-tight">
        全部当天录完需要 <strong>${needProjects}</strong> 个。填少一点也行 ——
        工具会把剩下的排到解锁之后。
      </span>
    </div>
    <div id="multi-body"></div>
  `;
  box.classList.remove('hidden');

  /** 按用户选的项目数重算主体 */
  function renderBody(projectCount) {
    const body = box.querySelector('#multi-body');
    const P = Math.max(1, Math.min(20, Math.floor(projectCount) || 1));
    const out = [];

    const detail = rows.map((x) => {
      const finish = hybridFinish(x.T, P);
      const steps = hybridSteps(x.T, P);
      return { ...x, steps, finish, saved: x.singleWait - finish };
    });

    out.push(`
      <h4 class="sub-title">效果对比</h4>
      <table class="lock-table">
        <thead><tr>
          <th>姓名</th><th>总时长</th>
          <th>只用 1 个项目</th>
          <th>用 ${P} 个项目</th>
          <th>省下</th>
        </tr></thead>
        <tbody>
          ${detail.map((x) => `
            <tr>
              <td>${esc(x.r.name)}</td>
              <td>${x.T}h</td>
              <td>${x.single.length} 次，等 ${x.singleWait ? hrsLabel(x.singleWait) : '—'}</td>
              <td>${x.steps.length} 次 → <strong>${x.finish ? hrsLabel(x.finish) : '当天录完'}</strong></td>
              <td class="save">${x.saved > 0 ? hrsLabel(x.saved) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `);

    const maxFinish = Math.max(...detail.map((x) => x.finish));
    const totalOps = detail.reduce((s, x) => s + x.steps.length, 0);
    const sameDay = maxFinish === 0;

    // 「全部当天」时给明确的结论 —— 用户最关心能不能今天搞定
    if (sameDay) {
      out.push(`
        <div class="notice notice-sameday">
          <h4>✅ 全部可以在今天录完</h4>
          <p>用 <strong>${P} 个项目</strong>，共 <strong>${totalOps} 次提交</strong>
             （每个项目的文本在下面）。</p>
          <p class="notice-sub">
            注意：<strong>「当天完成」不等于「一次粘贴」</strong>。
            单次上限 ${MAX_PER_ENTRY} 小时是每人每次的硬限制，
            跟项目多少无关 —— ${detail.filter((x) => x.steps.length > 1)
              .map((x) => `${esc(x.r.name)}要提交 ${x.steps.length} 次`)
              .join('、') || '本批每人只需 1 次'}。
          </p>
        </div>
      `);
    } else {
      out.push(`
        <p class="hint">
          整批预计 <strong>${hrsLabel(maxFinish)}</strong>。
          ${maxWait > maxFinish
            ? `比只用 1 个项目（${hrsLabel(maxWait)}）快 <strong>${hrsLabel(maxWait - maxFinish)}</strong>。`
            : ''}
          想更快就把上面的项目数调大。
        </p>
      `);
    }

    out.push(`<h4 class="sub-title">每个项目要贴的内容</h4>`);
    out.push(`
      <p class="hint">
        「项目 1 / 2 / 3」只是编号，<strong>项目名必须是真实存在的活动</strong>——
        工具不知道你有什么项目，这里不替你编。
      </p>
    `);

    for (const g of buildMultiGroups(P)) {
      out.push(`
        <div class="batch">
          <div class="batch-head">
            ${esc(g.label)}
            <span class="batch-when">${g.items.length} 项　·　合计 ${g.hours}h${g.multiRound ? '　·　⚠ 有人要在这录两次' : ''}</span>
          </div>
          <div class="batch-text">
            <div class="batch-text-head">
              <strong>复制这一组</strong>
              <button class="btn btn-sm" data-copy-group="${g.group}">复制</button>
            </div>
            <pre data-group-text="${g.group}">${esc(g.text)}</pre>
          </div>
        </div>
      `);
    }

    const rounds = buildMultiRounds(P);
    if (rounds.length > 1 || rounds.some((r) => r.earliest > 0)) {
      out.push(`<h4 class="sub-title">操作顺序</h4>`);
      out.push(`
        <table class="lock-table">
          <thead><tr><th>时间</th><th>录谁、录多少</th><th>涉及项目</th></tr></thead>
          <tbody>
            ${rounds.map((r) => `
              <tr>
                <td>${esc(r.earliestLabel)}</td>
                <td>${r.items.map((x) => `${esc(x.name)} ${x.hours}h`).join('、')}</td>
                <td>${r.projects.map((p) => '项目 ' + p).join('、')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <p class="hint">
          同一天的几轮可以一起做。「等 N 天」的那一轮要等系统解锁后再录。
        </p>
      `);
    }

    // 代价提醒：项目足够时不再啰嗦"项目不够"，但合规那一条始终保留
    out.push(`
      <div class="notice notice-tradeoff" style="margin-top:var(--sp-5)">
        <h4>⚠️ 换项目前请想清楚这两点</h4>
        <p><strong>1. 志愿者的记录会分散。</strong>
           同一个人会在 ${P} 个项目里各有一条记录，
           他查看自己的服务记录时会看到多条，而不是一条总计。</p>
        <p><strong>2. 项目属性会影响时长归集。</strong>
           如果学院对「什么算志愿服务」有要求，拆分可能让某些时长
           落在不太合适的项目名下。<strong>建议先问一下发起人。</strong></p>
        ${sameDay ? '' : `
          <p class="notice-sub">
            另外：当前只填了 ${P} 个项目，所以还剩一部分要等系统解锁。
            项目够多的话可以全部当天完成。
          </p>`}
      </div>
    `);

    body.innerHTML = out.join('');

    body.querySelectorAll('[data-copy-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.copyGroup;
        const el = body.querySelector(`[data-group-text="${n}"]`);
        // 复用统一的复制逻辑（三层兜底 + 失败时帮你选中），
        // 不要在这里直接调 navigator.clipboard —— 那会漏掉兜底，
        // 失败后只弹个提示、什么都不复制，用户会以为按钮坏了。
        copyFromElement(el, `「项目 ${n}」`, '项');
      });
    });
  }

  const input = box.querySelector('#proj-count');
  input?.addEventListener('input', () => renderBody(Number(input.value) || needProjects));

  /** 「我项目足够」：一键设为全部当天完成所需的项目数 */
  box.querySelector('#btn-enough')?.addEventListener('click', () => {
    if (input) input.value = needProjects;
    renderBody(needProjects);
    toast(`已按「项目足够」设为 ${needProjects} 个，全部当天录完`);
  });

  renderBody(needProjects);

  box.querySelector('#btn-close-multi')?.addEventListener('click', () => {
    box.classList.add('hidden');
  });
}

/**
 * 组装多项目分组（与后端 buildMultiProjectBatches 同规则）。
 * 关键：只有超限的人参与分流，没超的保持原样放第 1 个项目。
 */
function buildMultiGroups(P) {
  const usable = state.records.filter((r) => r.usable);
  const stepsOf = new Map();

  for (const r of usable) {
    const T = Number(r.hours) || 0;
    stepsOf.set(r, T <= MAX_PER_ENTRY
      ? [{ project: 1, hours: T, atHour: 0 }]
      : hybridSteps(T, P));
  }

  const groups = [];
  for (let i = 1; i <= P; i++) {
    const items = [];
    for (const r of usable) {
      const mine = stepsOf.get(r).filter((s) => s.project === i);
      for (let k = 0; k < mine.length; k++) {
        items.push({
          name: r.name, idCard: r.idCard, hours: mine[k].hours, remark: r.remark,
          partOfProject: mine.length > 1,
          partNo: k + 1,
          atHour: mine[k].atHour,
        });
      }
    }
    if (!items.length) continue;
    groups.push({
      group: i,
      label: `项目 ${i}`,
      items,
      hours: Math.round(items.reduce((s, x) => s + x.hours, 0) * 10) / 10,
      multiRound: items.some((x) => x.partOfProject),
      text: items.map((x) => [x.name, x.idCard, x.hours, x.remark].join(',')).join('\n'),
    });
  }
  return groups;
}

/** 按时间组织操作顺序（同一天的算一轮） */
function buildMultiRounds(P) {
  const usable = state.records.filter((r) => r.usable);
  const plan = usable.map((r) => {
    const T = Number(r.hours) || 0;
    return {
      r,
      steps: T <= MAX_PER_ENTRY ? [{ project: 1, hours: T, atHour: 0 }] : hybridSteps(T, P),
    };
  });

  const maxSteps = Math.max(...plan.map((p) => p.steps.length), 0);
  const rounds = [];
  for (let k = 0; k < maxSteps; k++) {
    const items = [];
    for (const p of plan) {
      if (!p.steps[k]) continue;
      items.push({
        name: p.r.name, hours: p.steps[k].hours,
        project: p.steps[k].project, atHour: p.steps[k].atHour,
      });
    }
    if (!items.length) continue;
    const earliest = Math.min(...items.map((x) => x.atHour));
    rounds.push({
      round: k + 1,
      earliest,
      earliestLabel: hrsLabel(earliest),
      projects: [...new Set(items.map((x) => x.project))].sort((a, b) => a - b),
      items,
    });
  }
  return rounds;
}

// ============================================================
// 分批录入（时长超过单次上限时）
// ============================================================

/** 组装每一轮的粘贴文本：第 1 轮带上「一次就能录完」的人 */
function buildRounds() {
  const oneShot = usableRecords();
  const splits = splitRecords();

  const plans = splits.map((r) => ({
    rec: r,
    parts: splitHours(r.hours),
  }));

  const maxRounds = plans.reduce((m, p) => Math.max(m, p.parts.length), 0);
  const rounds = [];

  for (let i = 0; i < maxRounds; i++) {
    const items = [];

    if (i === 0) {
      for (const r of oneShot) {
        items.push({
          name: r.name, idCard: r.idCard, hours: r.hours, remark: r.remark,
          fromSplit: false, earliest: 0,
        });
      }
    }

    for (const p of plans) {
      if (i >= p.parts.length) continue;
      let earliest = 0;
      for (let k = 0; k < i; k++) earliest += waitAfter(p.parts[k]);
      items.push({
        name: p.rec.name, idCard: p.rec.idCard, hours: p.parts[i], remark: p.rec.remark,
        fromSplit: true, totalHours: p.rec.hours,
        batchNo: i + 1, batchCount: p.parts.length, earliest,
      });
    }

    if (!items.length) continue;
    const earliest = Math.min(...items.map((x) => x.earliest));
    rounds.push({
      round: i + 1,
      earliest,
      earliestLabel: hrsLabel(earliest),
      items,
      text: items.map((x) => [x.name, x.idCard, x.hours, x.remark].join(',')).join('\n'),
      hours: Math.round(items.reduce((s, x) => s + Number(x.hours), 0) * 10) / 10,
    });
  }

  return rounds;
}

/** 渲染分批面板（无超限人员时隐藏） */
function renderBatchPanel() {
  const box = $('#batch-panel');
  if (!box) return;

  const splits = splitRecords();
  if (!splits.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  const rounds = buildRounds();
  const finishWait = Math.max(...splits.map((r) => {
    const p = splitHours(r.hours);
    return p.slice(0, -1).reduce((s, h) => s + waitAfter(h), 0);
  }));

  const html = [];

  html.push(`
    <div class="card-head">
      <span class="step">5</span>
      <h2>分批录入</h2>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="btn-close-batch">关闭</button>
    </div>
    <p class="hint">
      系统单次最多录 <strong>${MAX_PER_ENTRY} 小时</strong>，且同一人同一项目录完后
      需要等一段时间才能再录。下面是按此规则算出的批次——
      <strong>每轮复制各自的文本，粘完再录下一轮</strong>。
      预计全部录完约需 <strong>${finishWait ? hrsLabel(finishWait) : '当场即可'}</strong>。
    </p>
  `);

  for (const r of rounds) {
    const splitItems = r.items.filter((x) => x.fromSplit);
    const oneShotItems = r.items.filter((x) => !x.fromSplit);

    const detail = [
      ...oneShotItems.map((x) => `<span class="chip ok">${esc(x.name)} · ${x.hours}h</span>`),
      ...splitItems.map((x) => `<span class="chip split">${esc(x.name)} · 第${x.batchNo}/${x.batchCount}次 · ${x.hours}h</span>`),
    ].join('');

    html.push(`
      <div class="batch">
        <div class="batch-head">
          第 ${r.round} 轮
          <span class="batch-when">${esc(r.earliestLabel)}可以录　·　${r.items.length} 人　·　合计 ${r.hours}h</span>
        </div>
        <div class="batch-items">${detail}</div>
        <div class="batch-text">
          <div class="batch-text-head">
            <strong>这一轮的粘贴文本</strong>
            <button class="btn btn-sm" data-copy-round="${r.round}">复制这一轮</button>
          </div>
          <pre data-round-text="${r.round}">${esc(r.text)}</pre>
        </div>
      </div>
    `);
  }

  html.push(`
    <div class="notice notice-ok" style="margin-top:var(--sp-4)">
      <h4>💡 为什么不能一次全录</h4>
      <p>不是我们不想，是系统限制：单次上限 ${MAX_PER_ENTRY} 小时，
         且录入后同一人要等系统解锁。等待时间只影响<b>同一人在同一项目</b>再次录入，
         不同人之间互不影响。</p>
    </div>
  `);

  box.innerHTML = html.join('');
  box.classList.remove('hidden');

  // 逐轮复制
  box.querySelectorAll('[data-copy-round]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = btn.dataset.copyRound;
      const el = box.querySelector(`[data-round-text="${n}"]`);
      // 同上：走统一的 copyFromElement，别直接调剪贴板 API
      copyFromElement(el, `第 ${n} 轮`, '人');
    });
  });

  box.querySelector('#btn-close-batch')?.addEventListener('click', () => {
    box.classList.add('hidden');
  });
}

// ============================================================
// 排期
// ============================================================
$('#btn-schedule').addEventListener('click', () => loadSchedule());

/** 「换项目分流」 */
$('#btn-multi')?.addEventListener('click', () => {
  const splits = splitRecords();
  if (!splits.length) {
    return toast(`没有超过 ${MAX_PER_ENTRY} 小时的人，不需要分流`);
  }
  renderMultiPanel();
  const box = $('#multi-panel');
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/** 「生成分批录入文本」 */
$('#btn-batch').addEventListener('click', () => {
  const splits = splitRecords();
  if (!splits.length) {
    return toast(`没有超过 ${MAX_PER_ENTRY} 小时的人，不需要分批`);
  }
  renderBatchPanel();
  const box = $('#batch-panel');
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/** 「看录入规则」 */
$('#btn-rules').addEventListener('click', () => {
  const box = $('#rules-box');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) {
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
document.querySelectorAll('input[name="strategy"]').forEach((r) => {
  r.addEventListener('change', () => loadSchedule(r.value));
});
$('#btn-close-schedule').addEventListener('click', () => {
  $('#sec-schedule').classList.add('hidden');
});

async function loadSchedule(forceStrategy) {
  const list = usableRecords();
  if (!list.length) return toast('没有可用于排期的记录');

  const strategy = forceStrategy
    || document.querySelector('input[name="strategy"]:checked').value;

  try {
    const data = await api('/api/schedule', { records: list, strategy });
    state.schedule = data;
    $('#sec-schedule').classList.remove('hidden');
    renderSchedule(data);
    $('#sec-schedule').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast('排期失败：' + e.message, 3200);
  }
}

function renderSchedule(d) {
  const parts = [];

  parts.push(`
    <div class="stats stats-tight">
      <div class="stat-mini"><div class="n">${d.totalHours}</div><div class="l">合计小时</div></div>
      <div class="stat-mini"><div class="n">${d.groups.length}</div><div class="l">需分批次</div></div>
      <div class="stat-mini"><div class="n">${esc(d.finishLabel)}</div><div class="l">全部完成</div></div>
    </div>
  `);

  if (d.groups.length <= 1) {
    parts.push(`
      <div class="notice notice-ok">
        <h4>✅ 全部可以一次录完</h4>
        <p>所有人的时长都在 50 小时以内，不存在分批问题。录入后如需再次录入，注意系统的等待时间（见下方表格）。</p>
      </div>`);
  }

  for (const g of d.groups) {
    const chips = g.items
      .map((it) => `<span>${esc(it.name)} · ${it.hours}h</span>`)
      .join('');
    parts.push(`
      <div class="batch">
        <div class="batch-head">
          第 ${g.batch} 批
          <span class="batch-when">最早 ${esc(g.earliestLabel)}　·　${g.items.length} 人</span>
        </div>
        <div class="batch-items">${chips}</div>
      </div>`);
  }

  // 需要分批的人
  const multi = d.perPerson.filter((p) => p.batchCount > 1);
  if (multi.length) {
    parts.push(`
      <h3 class="sub-title">需要分批录入的人</h3>
      <table class="lock-table">
        <thead><tr><th>姓名</th><th>总时长</th><th>需分</th><th>各批时长</th><th>完成耗时</th></tr></thead>
        <tbody>
          ${multi.map((p) => `
            <tr>
              <td>${esc(p.name)}</td>
              <td>${p.hours}h</td>
              <td>${p.batchCount} 批</td>
              <td>${p.batches.map((b) => b.hours + 'h').join(' / ')}</td>
              <td>${esc(p.elapsedLabel)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`);
  }

  // 时间锁速查表
  parts.push(`
    <h3 class="sub-title">系统时间锁速查</h3>
    <table class="lock-table">
      <thead><tr><th>单次录入时长</th><th>下次可录入需等待</th></tr></thead>
      <tbody>
        <tr><td>≤ 10 小时</td><td>24 小时</td></tr>
        <tr><td>10 ~ 20 小时</td><td>48 小时</td></tr>
        <tr><td>20 ~ 30 小时</td><td>72 小时</td></tr>
        <tr><td>30 ~ 40 小时</td><td>96 小时</td></tr>
        <tr><td>40 ~ 50 小时</td><td>120 小时</td></tr>
      </tbody>
    </table>
    <p class="hint hint-tight">
      注：单次最多 50 小时。等待时间只影响「同一人在同一项目再次录入」。
    </p>
  `);

  $('#schedule-body').innerHTML = parts.join('');
}

// ============================================================
// 返回 / 重置
// ============================================================
$('#btn-back').addEventListener('click', () => {
  $('#sec-result').classList.add('hidden');
  $('#sec-schedule').classList.add('hidden');
  $('#batch-panel')?.classList.add('hidden');
  $('#multi-panel')?.classList.add('hidden');
  $('#rules-box')?.classList.add('hidden');
  $('#sec-input').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/** 清空全部状态，回到最初的空白界面 */
$('#btn-reset')?.addEventListener('click', async () => {
  const n = state.records.length;
  const msg = n
    ? `确定要清空吗？现在有 ${n} 条记录、以及你填的补录原因，都会被清除。`
    : '确定要清空当前内容吗？';

  // 有数据时要求确认 —— 用户手改过的东西不能一键就没了。
  // 用页内确认框，不用 window.confirm（后者在嵌入页面里会直接返回 false）
  if (n && !(await askConfirm(msg, { okText: '清空', danger: true }))) return;

  state.records = [];
  state.skipped = [];
  state.warnings = [];
  state.splitLines = [];
  state.duplicates = [];
  state.sameNameWarnings = [];
  state.summary = null;
  state.guessedRemark = '';
  state.sourceLabel = '';
  state.schedule = null;
  state.headers = null;
  state.mapping = null;
  state.missingColumns = [];
  state.sheetName = null;

  $('#text-input').value = '';
  $('#reason-input').value = '';
  clearFile();

  $('#sec-result').classList.add('hidden');
  $('#sec-schedule').classList.add('hidden');
  $('#batch-panel')?.classList.add('hidden');
  $('#multi-panel')?.classList.add('hidden');
  $('#rules-box')?.classList.add('hidden');
  $('#sec-input').classList.remove('hidden');

  toast('已清空');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
