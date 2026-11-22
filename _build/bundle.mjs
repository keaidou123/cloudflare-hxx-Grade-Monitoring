// 把 src/ 里的多文件打成**单文件** dist/worker.js。
// 用途：Cloudflare 网页版编辑器（Quick Edit）只接受一个文件，多文件项目必须先打平。
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const dropImports = (s) => s.split('\n').filter((l) => !/^import\s/.test(l)).join('\n');
const dropExports = (s) => s.replace(/^export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '');
const exportedNames = (s) => [...s.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);

// store.js / accounts.js 在入口里是 import * as xxx，单文件下用 IIFE 还原成同名对象
function namespaceBlock(file, varName) {
  const src = read(file);
  const names = exportedNames(src);
  if (names.length === 0) throw new Error(file + ' 没解析出导出名，bundle 中止');
  return '// ---- ' + file + '（以 ' + varName + '.* 形式暴露，与多文件版本保持同名调用）----\n' +
    'const ' + varName + ' = (function () {\n' + dropExports(dropImports(src)) + '\nreturn { ' + names.join(', ') + ' };\n})();\n';
}
const storeBlock = namespaceBlock('store.js', 'store');
const accountsBlock = namespaceBlock('accounts.js', 'accounts');

// 顺序无关（模块间只通过函数调用互相关联），但**必须列全**：
// 漏一个模块，单文件产物会在运行时才报 "xxx is not defined"（多文件版本却是好的）。
const ORDER = ['diff.js', 'format.js', 'auth.js', 'hxxai.js', 'schema.js', 'scope.js', 'pages.js', 'adminHtml.js'];
const SPECIAL = ['index.js', 'store.js', 'accounts.js'];
const present = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'));
const missing = present.filter((f) => !ORDER.includes(f) && !SPECIAL.includes(f));
if (missing.length) throw new Error('这些模块没被放进单文件产物，请加进 ORDER: ' + missing.join(', '));
const absent = ORDER.filter((f) => !present.includes(f));
if (absent.length) throw new Error('ORDER 里列了不存在的模块: ' + absent.join(', '));

const blocks = ORDER.map(
  (f) => '// ---- ' + f + ' ----\n' + dropExports(dropImports(read(f))) + '\n'
);

// 入口最后：它的 export default 必须保留（Workers 靠它拿到 fetch/scheduled）
const entry = '// ---- index.js ----\n' + dropImports(read('index.js')) + '\n';

const header =
  '// @ts-nocheck —— 这是构建产物，给 Cloudflare 编辑器的类型推断关掉，避免无意义的红字\n' +
  '/* 慧学星成绩单监控 —— 单文件构建产物（由 _build/bundle.mjs 生成，勿手改）\n' +
  '   源文件在 src/，改了源文件请重新运行：node _build/bundle.mjs \n' +
  '   生成时间: ' + new Date().toISOString() + ' */\n\n';

const code = header + blocks.join('\n') + storeBlock + '\n' + accountsBlock + '\n' + entry;
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/worker.js', import.meta.url), code, 'utf8');
console.log('dist/worker.js written:', code.length, 'chars, store/accounts 导出已打平');
