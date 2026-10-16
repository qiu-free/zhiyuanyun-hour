/**
 * 无浏览器环境下的前端页面加载自检
 *
 * 背景：本沙箱内 Chromium 无法启动（crashpad 需要 OpenProcess 权限）。
 * 但「页面能不能正常加载执行」仍然可以验证：
 *   1. 用极简 DOM 桩件（stub）模拟浏览器环境
 *   2. 把 app.js 真正执行一遍
 *   3. 观察是否抛异常、关键函数是否就绪
 *
 * 这能抓到：语法错误、初始化时访问不存在的元素、
 * 顶层代码逻辑错误等「一打开就白屏」的问题。
 *
 * 用法：node scripts/selftest-pageload.js
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`); }
}

const html = fs.readFileSync(path.resolve('src/web/index.html'), 'utf8');
const js = fs.readFileSync(path.resolve('src/web/app.js'), 'utf8');

// ---------- 从 HTML 抽出所有 id 和 tag，构建最小 DOM ----------
const ids = [...html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);

/** 极简元素桩件 */
function makeEl(id = '', tag = 'div') {
  const el = {
    _id: id,
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    dataset: {},
    style: {},
    children: [],
    files: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { on ? this._s.add(c) : this._s.delete(c); } },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return makeEl(); },
    querySelectorAll() { return []; },
    appendChild() {},
    insertAdjacentHTML() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    click() {},
    focus() {},
    scrollIntoView() {},
    insertBefore() {},
  };
  return el;
}

/**
 * 让「先写 innerHTML、再 querySelector 进去」这种两步渲染也能工作。
 *
 * 真实浏览器里 innerHTML 会生成子元素；桩件默认不会，导致
 * renderMultiPanel 里的 box.querySelector('#multi-body') 拿到空对象，
 * 后续内容写进了不存在的节点 —— 测试就会看到"面板是空的"。
 *
 * 这里做最小实现：innerHTML 写入时，把其中出现的 id 注册成子元素，
 * 并让 querySelector('#x') 能找到它。
 */
function attachInnerHtml(el) {
  el._children = new Map();

  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(v) {
      el._html = String(v);
      el._children = new Map();
      // 注册 innerHTML 里所有 id="..."
      for (const m of el._html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)) {
        const child = makeEl(m[1]);
        attachInnerHtml(child);
        el._children.set(m[1], child);
        // 让测试能通过 elMap 拿到它们
        if (!elMap.has(m[1])) elMap.set(m[1], child);
      }
    },
    configurable: true,
  });

  el.querySelector = (sel) => {
    const m = /^#([a-zA-Z0-9_-]+)$/.exec(sel);
    if (m) return el._children.get(m[1]) || elMap.get(m[1]) || makeEl();
    return makeEl();
  };
  el.querySelectorAll = (sel) => {
    // 「复制」按钮这类：按 data-* 属性找
    const dm = /^\[data-([a-z-]+)\]$/.exec(sel);
    if (dm && el._html) {
      const attr = dm[1];
      const found = [];
      const re = new RegExp(`data-${attr}="([^"]*)"`, 'g');
      for (const m of el._html.matchAll(re)) {
        const b = makeEl('', 'button');
        b.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[1];
        attachInnerHtml(b);
        found.push(b);
      }
      return found;
    }
    return [];
  };
  return el;
}

const elMap = new Map();
for (const id of ids) {
  const el = makeEl(id, 'div');
  attachInnerHtml(el);
  elMap.set(id, el);
}

// 修正几个特定元素的 tag（影响 select 逻辑）
if (elMap.has('text-input')) elMap.get('text-input').tagName = 'TEXTAREA';
if (elMap.has('reason-input')) elMap.get('reason-input').tagName = 'INPUT';

const documentStub = {
  querySelector(sel) {
    const m = /^#([a-zA-Z0-9_-]+)$/.exec(sel);
    if (m) return elMap.get(m[1]) || null;
    // 类选择器：返回桩件
    return makeEl('', 'div');
  },
  querySelectorAll(sel) {
    // .tab / input[name=...] 这类，返回空数组即可（顶层代码会 forEach）
    return [];
  },
  createElement(tag) { return makeEl('', tag); },
  createRange() { return { selectNodeContents() {}, }; },
  getElementById(id) { return elMap.get(id) || null; },
  addEventListener() {},
  body: makeEl('body', 'body'),
};

const windowStub = {
  addEventListener() {},
  getSelection() { return { removeAllRanges() {}, addRange() {} }; },
  scrollTo() {},
  location: { href: 'http://127.0.0.1:5180/' },
};

const sandbox = {
  document: documentStub,
  window: windowStub,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }), blob: async () => new Blob() }),
  FileReader: class { readAsDataURL() {} },
  Blob: class { constructor() {} },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  setTimeout, clearTimeout, console,
  Number, String, Boolean, Array, Object, JSON, Math, Date, RegExp, Set, Map, Promise, Error,
};
sandbox.globalThis = sandbox;

console.log('=== 1. 页面加载模拟（执行 app.js）===');

let loadError = null;
try {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js, ctx, { filename: 'app.js' });
  check(true, 'app.js 在模拟 DOM 中执行完毕，无异常抛出');
} catch (e) {
  loadError = e;
  check(false, 'app.js 执行抛出异常（真实浏览器会白屏）', `${e.name}: ${e.message}`);
}

/** 每个测试用一个全新的沙箱上下文（同一个 ctx 重复 run 会因 const 重声明报错） */
function freshCtx() {
  const sb = { ...sandbox };
  const ctx = vm.createContext(sb);
  vm.runInContext(js, ctx, { filename: 'app.js' });
  return ctx;
}

console.log('\n=== 2. 关键函数是否就绪 ===');
if (!loadError) {
  const ctx = freshCtx();
  for (const fn of ['checkRecord', 'renderAll', 'renderTable', 'renderStats', 'renderNotices',
                    'renderOutput', 'renderSkipped', 'renderSchedule', 'updateRowVisual', 'doCopy']) {
    // 函数声明在 vm 上下文里是全局的；若取不到，退回到源码检查
    const inCtx = typeof ctx[fn] === 'function';
    const inSrc = new RegExp(`function\\s+${fn}\\b`).test(js);
    check(inCtx || inSrc, `${fn} 已定义`);
  }
}

console.log('\n=== 3. 初始化不访问空元素 ===');
// 逐个检查顶层（非函数内）的 $('#x') 调用
{
  const topLevel = js.split('\n').filter((l) => !/^\s/.test(l) && /\$\('#/.test(l));
  const bad = [];
  for (const line of topLevel) {
    for (const m of line.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)) {
      if (!elMap.has(m[1])) bad.push(m[1]);
    }
  }
  check(bad.length === 0, `顶层代码引用的元素都存在`, bad.length ? `找不到：${bad.join(', ')}` : '');
}

console.log('\n=== 4. 空数据时不崩 ===');
if (!loadError) {
  const ctx = freshCtx();
  try {
    // state 是模块级 const，不挂在全局；用 runInContext 在同作用域里操作
    vm.runInContext(`
      state.records = [];
      state.skipped = [];
      renderStats();
      renderNotices();
      renderOutput();
      renderSkipped();
    `, ctx, { filename: 'empty-data.js' });
    check(true, '空记录时各渲染函数不抛异常');
  } catch (e) {
    check(false, '空记录时渲染抛异常', `${e.name}: ${e.message}`);
  }
}

console.log('\n=== 4b. 带「超限/待报备/错误」混合数据时渲染不崩 ===');
if (!loadError) {
  const ctx = freshCtx();
  try {
    // 覆盖全部五种状态，尤其 split（>50 小时）这条新路径
    vm.runInContext(`
      state.records = [
        { name:'甲某', idCard:'110101200501010017', hours:8,  remark:'活动', problems:[], status:'ok',      usable:true,  needsSplit:false, splitBatches:1, lineNo:1 },
        { name:'乙某', idCard:'110101200502020022', hours:80, remark:'活动', problems:[{field:'hours',level:'split',message:'共 80 小时，超过单次上限 50 小时，需分 2 次录入'}], status:'split', usable:true, needsSplit:true, splitBatches:2, lineNo:2 },
        { name:'丙某', idCard:'110101200503030038', hours:120,remark:'活动', problems:[{field:'hours',level:'split',message:'共 120 小时，超过单次上限 50 小时，需分 3 次录入'}], status:'split', usable:true, needsSplit:true, splitBatches:3, lineNo:3 },
        { name:'丁某', idCard:'110101850101123', hours:8, remark:'活动', problems:[{field:'idCard',level:'warn',message:'15 位老式号码'}], status:'warn', usable:true, needsSplit:false, splitBatches:1, lineNo:4 },
        { name:'戊某', idCard:'110101200504040043', hours:8, remark:'', problems:[{field:'remark',level:'missing',message:'缺少补录原因'}], status:'missing', usable:false, needsSplit:false, splitBatches:1, lineNo:5 },
        { name:'己某', idCard:'', hours:8, remark:'活动', problems:[{field:'idCard',level:'error',message:'缺少身份证号'}], status:'error', usable:false, needsSplit:false, splitBatches:1, lineNo:6 },
      ];
      state.skipped = [];
      state.splitLines = [];
      renderAll();
    `, ctx, { filename: 'mixed.js' });
    check(true, '六条混合数据 renderAll 无异常');

    const statsHtml = elMap.get('stats').innerHTML;
    check(statsHtml.includes('需分批'), '统计卡出现「需分批」');
    check(statsHtml.includes('可一次录完'), '统计卡出现「可一次录完」');

    const noticesHtml = elMap.get('notices').innerHTML;
    check(noticesHtml.includes('一次录不完'), '提示条说明了「一次录不完」');
    // 分批明细渲染成「50h + 30h」这种形式
    check(noticesHtml.includes('50h + 30h'), '提示条列出具体分批（80 → 50h + 30h）');
    check(noticesHtml.includes('50h + 50h + 20h'), '120 的分批正确（50h + 50h + 20h）');
    check(noticesHtml.includes('5 天后'), '80h 的完成耗时标为 5 天后');
    check(noticesHtml.includes('10 天后'), '120h 的完成耗时标为 10 天后');

    const batchHtml = elMap.get('batch-panel').innerHTML;
    check(batchHtml.includes('分批录入'), '分批面板已渲染');
    check(batchHtml.includes('第 1 轮'), '有第 1 轮');
    check(batchHtml.includes('第 2 轮'), '有第 2 轮');
    check(batchHtml.includes('第 3 轮'), '有第 3 轮（120h 需要）');
    check(batchHtml.includes('这一轮的粘贴文本'), '每轮都给了粘贴文本');
    check(batchHtml.includes('复制这一轮'), '每轮都有复制按钮');
    check(!/undefined/.test(batchHtml), '分批面板里没有 undefined');

    // 换项目分流面板
    // 注意：这个面板分两步渲染（先写外层，再往 #multi-body 里写内容），
    // 所以内容要在 #multi-body 上取，而不是 #multi-panel。
    const multiOuter = elMap.get('multi-panel').innerHTML;
    const multiBody = elMap.get('multi-body');
    const multiHtml = multiOuter + (multiBody ? multiBody.innerHTML : '');

    check(multiOuter.includes('换项目分流'), '分流面板已渲染');
    check(!!multiBody, '分流面板内容区已创建');
    check(multiHtml.includes('效果对比'), '有效果对比表');
    check(multiHtml.includes('项目 1'), '有「项目 1」分组');
    check(multiHtml.includes('项目 3'), '有「项目 3」分组（120h 需要 3 个）');
    check(multiHtml.includes('复制'), '每组有复制按钮');
    check(!/undefined|NaN/.test(multiHtml), '分流面板里没有 undefined/NaN');
    // 必须写明代价，不能只讲好处
    check(/想清楚|代价|注意/.test(multiHtml), '明确说明了换项目的代价');
    check(multiHtml.includes('真实'), '提醒项目必须真实存在');
    check(multiHtml.includes('分散'), '提醒志愿者记录会分散');
    check(multiHtml.includes('发起人'), '提醒先问发起人（合规相关）');
    // 项目数可调
    check(multiHtml.includes('proj-count'), '有「几个项目可用」的输入框');
    check(multiHtml.includes('项目足够'), '有「我项目足够」的快捷按钮');
    // 「项目足够」时必须说清"当天 ≠ 一次粘贴"，否则用户会一次粘 120h 被拒
    check(/不等于|不等于「一次粘贴」|一次粘贴/.test(multiHtml),
      '澄清了「当天录完 ≠ 一次粘贴」');

    // 分流后每份不能超 50：逐行解析
    const pres = [...multiHtml.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    const allHours = [];
    for (const p of pres) {
      for (const line of p.split('\n')) {
        const cols = line.split(',');
        if (cols.length === 4) allHours.push(Number(cols[2]));
      }
    }
    check(allHours.length > 0, `解析到 ${allHours.length} 条分流记录`);
    check(allHours.every((h) => h > 0 && h <= 50),
      `分流后每份时长都在 1~50（${allHours.join(',')}）`);

    // 不超限的人不能被拆到多个项目
    check(/李四[^\n]*\n[\s\S]*?项目 2[\s\S]*?张三/.test(multiHtml)
      || !/项目 2[\s\S]*?李四/.test(multiHtml),
      '未超限的人（李四 8h）只出现在第 1 组');

    // 主导出不应包含超限的人（他们不能一条粘完）
    const outText = elMap.get('output-text').textContent;
    check(outText.includes('甲某'), '主导出含一次性能录的人');
    check(!outText.includes('乙某'), '主导出排除 80h 的人');
    check(!outText.includes('丙某'), '主导出排除 120h 的人');
  } catch (e) {
    check(false, '混合数据渲染抛异常', `${e.name}: ${e.message}`);
  }
}

console.log('\n=== 5. HTML 输出转义（防 XSS）===');
{
  const ctx = freshCtx();
  const evil = '<img src=x onerror=alert(1)>';
  try {
    vm.runInContext(`
      state.records = [{
        lineNo: 1, name: ${JSON.stringify(evil)}, idCard: '110101200501010017',
        hours: 8, remark: '正常', problems: [], status: 'ok', usable: true,
      }];
      renderTable();
    `, ctx, { filename: 'xss.js' });
    const out = elMap.get('result-body').innerHTML;
    check(!out.includes('<img src=x'), '恶意姓名被转义（未原样输出 <img>）', out.slice(0, 200));
    check(out.includes('&lt;img'), '可确认转义成了 &lt;img&gt;');
  } catch (e) {
    check(false, 'renderTable 抛异常', `${e.name}: ${e.message}`);
  }
}

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
