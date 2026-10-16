/**
 * xlsx 的默认导出垫片
 *
 * 为什么需要这个文件：
 *   项目里的代码统一写成 `import XLSX from 'xlsx'`（默认导入）。
 *   这在 Node 下没问题 —— Node 解析到 node_modules/xlsx/xlsx.js（CommonJS），
 *   CJS 互操作会自动补一个 default。
 *
 *   但浏览器里没有 CommonJS。index.html 的 importmap 把 'xlsx' 指向了
 *   vendor/xlsx.mjs（SheetJS 官方 ESM 版），而这个文件**只有具名导出，
 *   没有 default**。于是浏览器报：
 *     The requested module 'xlsx' does not provide an export named 'default'
 *   结果本地实现整个加载失败。
 *
 *   这个垫片把具名导出收进命名空间对象再作为 default 抛出，
 *   于是 `import XLSX from 'xlsx'` 在浏览器里也能拿到完整的模块对象
 *   （XLSX.utils / XLSX.read / XLSX.write 都在）。
 *
 * Node 端不经过这里，仍然直接用 CJS 版本。
 */
import * as XLSX from './xlsx.mjs';

export default XLSX;
