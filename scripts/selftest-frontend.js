/**
 * 前端逻辑代码级验证（无需浏览器）
 *
 * 背景：Chromium 在本沙箱内无法启动（crashpad 需要 OpenProcess 权限，被沙箱拒绝），
 * 所以无法截图验证界面。这里改用「在 Node 里执行前端关键纯函数」的方式验证逻辑。
 *
 * 做法：
 *   1. 从 app.js 里摘出 checkRecord 等纯函数（不依赖 DOM）
 *   2. 在 Node 里跑，验证校验规则与后端一致
 *   3. 另外静态检查 DOM 绑定是否与 HTML 的 id 对得上
 *
 * 用法：node scripts/selftest-frontend.js
 */

import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`); }
}

const webDir = path.resolve('src/web');
const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');

console.log('=== 1. HTML / JS / CSS 之间的引用一致性 ===');

// JS 里 $(...) 选到的所有 id
const jsIds = new Set();
for (const m of js.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)) jsIds.add(m[1]);
// HTML 里定义的所有 id
const htmlIds = new Set();
for (const m of html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)) htmlIds.add(m[1]);

const missingInHtml = [...jsIds].filter((id) => !htmlIds.has(id));
check(missingInHtml.length === 0,
  `JS 引用的 ${jsIds.size} 个 id 都存在于 HTML`,
  missingInHtml.length ? `HTML 里找不到：${missingInHtml.join(', ')}` : '');

console.log('\n=== 2. HTML 结构完整性 ===');
check(/<html/.test(html) && /<\/html>/.test(html), '有完整 html 标签');
check(/<style|style\.css/.test(html), '引用了样式');
check(html.includes('/app.js'), '引用了脚本');
check(html.includes('charset="UTF-8"'), '声明了 UTF-8');
check(!/undefined|NaN/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'HTML 里没有 undefined/NaN 残留');

// 标签配对（粗检关键标签）
for (const tag of ['div', 'section', 'table', 'tbody', 'thead', 'button', 'textarea', 'details']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  check(open === close, `<${tag}> 标签配对（${open} 开 / ${close} 闭）`);
}

console.log('\n=== 3. CSS 关键类是否都被定义 ===');
const cssClasses = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) cssClasses.add(m[1]);
// HTML 里用到的 class
const htmlClasses = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) htmlClasses.add(c);
}
const undef = [...htmlClasses].filter((c) => !cssClasses.has(c));
check(undef.length === 0,
  `HTML 用到的 ${htmlClasses.size} 个 class 都有样式`,
  undef.length ? `缺样式：${undef.join(', ')}` : '');

// JS 动态生成的 class 也要有样式
for (const cls of ['pill-split', 'row-split', 'msg-split', 'chip', 'notice-needsplit', 'batch-text']) {
  check(cssClasses.has(cls), `动态生成的 .${cls} 有样式`);
}

console.log('\n=== 4. 前端校验函数 checkRecord（与后端规则一致）===');

// 把 checkRecord 从 app.js 里抽出来在 Node 跑。
// 注意：它依赖 MAX_PER_ENTRY 常量，必须一并注入，否则会 ReferenceError。
const fnMatch = js.match(/function checkRecord\(rec\)\s*\{[\s\S]*?\n\}/);
check(!!fnMatch, '能提取 checkRecord 函数');
const constMatch = js.match(/const MAX_PER_ENTRY = (\d+)/);
check(!!constMatch, '能读到 MAX_PER_ENTRY 常量');
const maxPerEntry = constMatch ? Number(constMatch[1]) : 50;
check(maxPerEntry === 50, `单次上限为 50（实际 ${maxPerEntry}）`);

if (fnMatch) {
  const checkRecord = new Function('rec', 'MAX_PER_ENTRY', `
    ${fnMatch[0]}
    return checkRecord(rec);
  `);
  const check1 = (rec) => checkRecord(rec, maxPerEntry);

  // 正常
  let r = check1({ name: '张三', idCard: '110101200501010017', hours: 8, remark: '活动' });
  check(r.status === 'ok' && r.usable, '正常记录 → ok');

  // 缺姓名
  r = check1({ name: '', idCard: '110101200501010017', hours: 8, remark: '活动' });
  check(r.status === 'error', '缺姓名 → error');

  // 缺身份证
  r = check1({ name: '张三', idCard: '', hours: 8, remark: '活动' });
  check(r.status === 'error', '缺身份证 → error');

  // 打码身份证
  r = check1({ name: '张三', idCard: '500113********1234', hours: 8, remark: '活动' });
  check(r.status === 'error', '打码身份证 → error');
  check(r.problems.some((p) => p.message.includes('打码')), '提示打码');

  // 校验位错
  r = check1({ name: '张三', idCard: '110101200501010010', hours: 8, remark: '活动' });
  check(r.status === 'error', '校验位错 → error');
  check(r.problems.some((p) => p.message.includes('校验位')), '提示校验位');

  // 时长超 50：不是 error，而是 split（能录，但要分多次）
  r = check1({ name: '张三', idCard: '110101200501010017', hours: 80, remark: '活动' });
  check(r.status === 'split', `时长 80 → split（实际 ${r.status}）`);
  check(r.usable === true, '超限仍可导出（会分批）');
  check(r.needsSplit === true, '标记 needsSplit');
  check(r.splitBatches === 2, `80h 分 2 次（实际 ${r.splitBatches}）`);
  check(r.problems.some((p) => p.message.includes('50')), '提示单次上限');

  // 边界：50 不分批，51 要分批
  r = check1({ name: '张三', idCard: '110101200501010017', hours: 50, remark: '活动' });
  check(r.status === 'ok' && r.needsSplit === false, '正好 50 → ok，不分批');
  r = check1({ name: '张三', idCard: '110101200501010017', hours: 51, remark: '活动' });
  check(r.status === 'split' && r.splitBatches === 2, '51 → split，分 2 次');
  r = check1({ name: '张三', idCard: '110101200501010017', hours: 120, remark: '活动' });
  check(r.splitBatches === 3, `120h 分 3 次（实际 ${r.splitBatches}）`);

  // 时长非正
  r = check1({ name: '张三', idCard: '110101200501010017', hours: 0, remark: '活动' });
  check(r.status === 'error', '时长 0 → error');

  // 缺备注 → missing（不是 error）
  r = check1({ name: '张三', idCard: '110101200501010017', hours: 8, remark: '' });
  check(r.status === 'missing', '缺备注 → missing');
  check(r.problems.some((p) => p.level === 'missing'), '标记为 missing 级别');

  // 备注含逗号
  r = check1({ name: '张三', idCard: '110101200501010017', hours: 8, remark: 'a,b' });
  check(r.status === 'error', '备注含逗号 → error');

  // 15 位身份证（老式，应通过格式检查）
  r = check1({ name: '张三', idCard: '110101850101123', hours: 8, remark: '活动' });
  check(r.status === 'ok', '15 位身份证 → ok');
}

console.log('\n=== 4b. 五级状态的优先级（不能与 error 混淆）===');
{
  // warn  由后端产生（15 位身份证、时长取整）→ 能导出，建议确认
  // split 由 >50 小时产生 → 能导出，但要分多次
  // 两者都绝不能显示成红色错误。
  const statusOf = (problems) => {
    const hasError = problems.some((x) => x.level === 'error');
    const hasMissing = problems.some((x) => x.level === 'missing');
    const hasSplit = problems.some((x) => x.level === 'split');
    const hasWarn = problems.some((x) => x.level === 'warn');
    return {
      status: hasError ? 'error'
        : hasMissing ? 'missing'
          : hasSplit ? 'split'
            : hasWarn ? 'warn' : 'ok',
      usable: !hasError && !hasMissing,
    };
  };

  let s = statusOf([{ level: 'warn', field: 'idCard' }]);
  check(s.status === 'warn', '只有 warn → status=warn');
  check(s.usable === true, '只有 warn → 仍可导出');

  s = statusOf([{ level: 'split', field: 'hours' }]);
  check(s.status === 'split', '只有 split → status=split');
  check(s.usable === true, '只有 split → 仍可导出');

  s = statusOf([{ level: 'warn' }, { level: 'split' }]);
  check(s.status === 'split', 'warn + split → split 优先');

  s = statusOf([{ level: 'warn' }, { level: 'error' }]);
  check(s.status === 'error', 'warn + error → error 优先');

  s = statusOf([{ level: 'warn' }, { level: 'missing' }]);
  check(s.status === 'missing', 'warn + missing → missing 优先');

  s = statusOf([{ level: 'split' }, { level: 'missing' }]);
  check(s.status === 'missing', 'split + missing → missing 优先');

  // 源码层面：STATUS_META 必须为五种状态都定义好，否则表格渲染 undefined
  const metaSrc = js.match(/const STATUS_META = \{[\s\S]*?\n\};/);
  check(!!metaSrc, 'STATUS_META 已定义');
  if (metaSrc) {
    for (const k of ['ok', 'warn', 'split', 'missing', 'error']) {
      check(metaSrc[0].includes(`${k}:`), `STATUS_META 含 ${k}`);
    }
    check(/warn:\s*\{[^}]*pill-warn/.test(metaSrc[0]), 'warn → pill-warn');
    check(/warn:\s*\{[^}]*row-warn/.test(metaSrc[0]), 'warn → row-warn');
    check(/split:\s*\{[^}]*pill-split/.test(metaSrc[0]), 'split → pill-split');
    check(/split:\s*\{[^}]*row-split/.test(metaSrc[0]), 'split → row-split');
  }

  // 红框只能给 error / missing
  check(/p\.level === 'error' \|\| p\.level === 'missing'/.test(js),
    '红框只标注 error/missing');
  check(!/new Set\(r\.problems\.map\(\(p\) => p\.field\)\)/.test(js),
    '旧的「所有问题都算错误字段」写法已移除');

  // 前端状态机必须与上面测的规则一致
  check(/hasError \? 'error'/.test(js) && /hasMissing \? 'missing'/.test(js)
    && /hasSplit \? 'split'/.test(js) && /hasWarn \? 'warn' : 'ok'/.test(js),
    'checkRecord 的优先级顺序正确');
}

console.log('\n=== 4c. 时长分批逻辑（前端也要算对）===');
{
  // 抽取前端的 splitHours / waitAfter，与后端规则比对
  const fnSplit = js.match(/function splitHours\(total\)\s*\{[\s\S]*?\n\}/);
  const fnWait = js.match(/function waitAfter\(hours\)\s*\{[\s\S]*?\n\}/);
  check(!!fnSplit, '能提取 splitHours');
  check(!!fnWait, '能提取 waitAfter');

  if (fnSplit && fnWait) {
    const tlMatch = js.match(/const TIME_LOCK = \[[\s\S]*?\n\];/);
    check(!!tlMatch, '能提取 TIME_LOCK');

    const scope = new Function('total', 'hours', `
      const MAX_PER_ENTRY = ${maxPerEntry};
      ${tlMatch ? tlMatch[0] : ''}
      ${fnWait[0]}
      ${fnSplit[0]}
      return { splitHours, waitAfter };
    `);
    const { splitHours, waitAfter } = scope();

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check(same(splitHours(50), [50]), '50 → [50]');
    check(same(splitHours(51), [50, 1]), '51 → [50, 1]');
    check(same(splitHours(80), [50, 30]), '80 → [50, 30]');
    check(same(splitHours(100), [50, 50]), '100 → [50, 50]');
    check(same(splitHours(120), [50, 50, 20]), '120 → [50, 50, 20]');
    check(same(splitHours(8), [8]), '8 → [8]');

    // 等待时间表
    check(waitAfter(8) === 24, '录 8h → 等 24h');
    check(waitAfter(10) === 24, '录 10h → 等 24h（含边界）');
    check(waitAfter(15) === 48, '录 15h → 等 48h');
    check(waitAfter(25) === 72, '录 25h → 等 72h');
    check(waitAfter(35) === 96, '录 35h → 等 96h');
    check(waitAfter(50) === 120, '录 50h → 等 120h');
  }
}

console.log('\n=== 5. 关键交互都在 ===');
check(js.includes("addEventListener('click'"), '有点击事件绑定');
check(js.includes("addEventListener('input'"), '有输入事件绑定（实时校验）');
check(js.includes('data-del'), '有删除行功能');
check(js.includes('/api/parse'), '调用解析接口');
check(js.includes('/api/upload'), '调用上传接口');
check(js.includes('/api/export/xlsx'), '调用 Excel 导出接口');
// .txt 下载在前端用 Blob 本地生成，不走后端接口 —— 检查这一点
check(js.includes('downloadText') && js.includes('new Blob'), '.txt 由前端本地生成下载');
check(!js.includes('/api/export/txt'), '未调用不存在的 /api/export/txt（应由前端生成）');
check(js.includes('/api/schedule'), '调用排期接口');
check(js.includes('navigator.clipboard'), '有一键复制');
// 复制要多层兜底：navigator.clipboard 在非安全上下文 / 未聚焦时会抛错，
// 缺了 execCommand 这一层，用户看到的就是「点了没复制」
check(js.includes('execCommand'), '复制有 execCommand 兜底');
check(js.includes('isSecureContext'), '只在安全上下文用剪贴板 API');
check(js.includes('copyToClipboard'), '复制逻辑已抽成独立函数');
// 处理完自动复制：这个工具的出口就是把文本贴到志愿云后台
check(/doCopy\(\{\s*silent:\s*true\s*\}\)/.test(js), '处理完成后自动复制到剪贴板');
check(js.includes('FileReader'), '有文件读取');
check(js.includes('renderBatchPanel'), '有分批面板渲染');
check(js.includes('renderMultiPanel'), '有换项目分流面板渲染');
check(js.includes('btn-rules'), '有「看录入规则」入口');
check(js.includes('btn-batch'), '有「生成分批录入文本」入口');
check(js.includes('btn-multi'), '有「换项目分流」入口');

console.log('\n=== 5b. 撤回与重置（上传后能退回）===');
{
  // 「取消选中的文件」
  check(js.includes('function clearFile'), '有 clearFile 函数');
  check(js.includes("$('#file-clear')"), '绑定了「取消选择」按钮');
  check(html.includes('id="file-clear"'), 'HTML 里有「取消选择」按钮');
  check(/file-clear[\s\S]{0,300}?clearFile\(\)/.test(js), '点击「取消选择」会调用 clearFile');
  // 必须清掉 input.value，否则再选同一个文件不会触发 change
  check(/clearFile[\s\S]*?fileInput\.value\s*=\s*''/.test(js.replace(/function clearFile[\s\S]*?\n\}/, (m) => m))
    || /fileInput\.value\s*=\s*''/.test(js),
    'clearFile 会清空 input.value（否则重选同一文件无效）');
  // 取消按钮不能冒泡到拖拽区，否则又弹出选择框
  check(/file-clear[\s\S]{0,200}?stopPropagation/.test(js), '取消按钮阻止冒泡');

  // 「清空全部」
  check(js.includes('function') && /\$\('#btn-reset'\)/.test(js), '绑定了「清空全部」按钮');
  check(html.includes('id="btn-reset"'), 'HTML 里有「清空全部」按钮');
  // 有数据时必须二次确认，不能一键清掉用户手改的内容
  check(/btn-reset[\s\S]{0,500}?askConfirm\(/.test(js), '「清空全部」有二次确认');
  // 关键：不能用 window.confirm —— 嵌入页面里它会直接返回 false，
  // 表现成「点了没反应」（用户报的正是这个）
  check(js.includes('function askConfirm'), '自己实现了页内确认框');
  {
    // 剥掉注释再判断，否则「为什么不用 window.confirm」这类说明会误报
    const noComment = js
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    check(!/window\s*\.\s*confirm\s*\(/.test(noComment),
      '代码里没有调用 window.confirm（只允许出现在注释里）');
  }
  check(html.includes('id="confirm"'), 'HTML 里有确认框容器');
  check(html.includes('id="confirm-ok"') && html.includes('id="confirm-cancel"'),
    '确认框有确定/取消按钮');
  check(/state\.records = \[\]/.test(js), '会清空 records');
  check(/\$\('#reason-input'\)\.value = ''/.test(js), '会清空补录原因输入框');
  check(/\$\('#text-input'\)\.value = ''/.test(js), '会清空文本输入框');
  check(/btn-reset[\s\S]{0,900}?clearFile\(\)/.test(js), '会同时取消已选文件');
}

console.log('\n=== 6. 安全相关 ===');
check(!/eval\s*\(/.test(js), 'JS 里没有 eval');
check(js.includes('esc('), '输出经过转义（防 XSS）');

// 后端安全
const serverJs = fs.readFileSync(path.resolve('src/server/server.js'), 'utf8');
check(serverJs.includes("'127.0.0.1'") || serverJs.includes('"127.0.0.1"'), '服务只监听本机');
// 静态文件用「白名单目录」判断，而不是只比对单一目录 ——
// 因为现在还要放行 /core 和 /vendor。行为测试在 selftest-web.js 第 14 节。
check(
  /allowed\s*=\s*\[/.test(serverJs) && /allowed\.some\(/.test(serverJs) && /startsWith\(dir\)/.test(serverJs),
  '静态服务防目录穿越（白名单目录）'
);
check(!/path\.join\([^)]*req\.url/.test(serverJs), '不直接拼接用户输入的路径');
check(serverJs.includes('limitBytes'), '请求体有大小限制');

console.log('');
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
