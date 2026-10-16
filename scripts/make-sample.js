/**
 * 生成测试样例表格（脱敏数据）
 *
 * ⚠️ 这里的身份证号是用校验算法「构造」出来的合法号码，对应的是随机出生日期，
 * 不对应任何真实公民。仅用于测试程序逻辑。
 */

import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/** 由前 17 位 + 出生日期凑出一个校验位合法的号码（仅测试用） */
function makeIdCard(provinceCode, birth, seq3) {
  const body = provinceCode + birth + seq3;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(body[i]) * WEIGHTS[i];
  return body + CHECK_CODES[sum % 11];
}

const rows = [
  // 正常数据
  ['张三', '20230101', makeIdCard('110101', '20050101', '123'), 8, '2025年迎新志愿服务'],
  ['李四', '20230102', makeIdCard('130102', '20050315', '234'), 12.5, '社区环境卫生清扫'],
  ['王五', '20230103', makeIdCard('310104', '20040720', '345'), 45, '暑期支教（累计）'],
  ['赵六', '20230104', makeIdCard('440105', '20050910', '456'), 30, '图书馆志愿服务'],

  // 需要分批（超过单次上限 50）
  ['钱七', '20230105', makeIdCard('320106', '20050208', '567'), 80, '全年志愿服务累计'],

  // 重名（不同身份证）—— 用于验证重名检测
  ['孙八', '20230106', makeIdCard('510107', '20051212', '678'), 6, '敬老院服务'],
  ['孙八', '20230107', makeIdCard('510107', '20060101', '789'), 7.5, '敬老院服务（另一位同学）'],

  // 身份证校验位错误
  ['周九', '20230108', makeIdCard('370108', '20050404', '890').slice(0, 17) + '0', 10, '测试错误证件号'],

  // 时长格式带单位
  ['吴十', '20230109', makeIdCard('420109', '20050707', '901'), '15小时', '带单位的时长'],

  // 姓名为空
  ['', '20230110', makeIdCard('610110', '20050808', '012'), 5, '缺姓名'],

  // 时长为空
  ['郑十一', '20230111', makeIdCard('210111', '20050909', '123'), '', '缺时长'],

  // 重复行（与张三完全相同）
  ['张三', '20230101', makeIdCard('110101', '20050101', '123'), 8, '重复行测试'],

  // 姓名含空格
  ['冯 十二', '20230112', makeIdCard('500112', '20051010', '234'), 4, '姓名带空格'],

  // 15 位老式号码
  ['陈十三', '20230113', '110101850101123', 3, '老式15位号码'],
];

const header = ['姓名', '学号', '身份证号', '志愿时长', '备注'];

const aoa = [
  ['志愿者志愿服务时长补录表'],
  [],
  header,
  ...rows,
];

const ws = XLSX.utils.aoa_to_sheet(aoa);
// 身份证列设为文本格式，避免被当成数字
for (let r = 0; r < aoa.length; r++) {
  const cell = XLSX.utils.encode_cell({ r, c: 2 });
  if (ws[cell]) ws[cell].t = 's';
}
ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 10 }, { wch: 30 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '志愿者时长');

const outDir = path.resolve('data');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'sample-volunteers.xlsx');
XLSX.writeFile(wb, out);
console.log(`已生成测试样例：${out}`);
console.log(`共 ${rows.length} 行，其中包含多种故意制造的错误，用于验证校验逻辑。`);
