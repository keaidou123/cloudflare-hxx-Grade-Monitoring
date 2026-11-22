// 把 install.sql 内嵌进 src/schema.js，供 Worker 首次请求时自动建表。
// 改完 install.sql 记得重新运行：node _build/embed-schema.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const sql = readFileSync(new URL('../install.sql', import.meta.url), 'utf8');
const src = `/**
 * 内嵌的建库脚本 + 自动补列（由 _build/embed-schema.mjs 从 install.sql 生成，勿手改）。
 *
 * 目的：让"只粘贴 worker.js"也能跑起来 ——
 *   1. 首次请求时把 install.sql 里的 CREATE TABLE IF NOT EXISTS 全部执行一遍（已存在则跳过）
 *   2. 检查三处后期新增的列，缺了就用 ALTER 补上（SQLite 没有 ADD COLUMN IF NOT EXISTS）
 * 因此：全新库、只跑过老版 schema 的库、跑过部分迁移的库，三种都能自动修好。
 */

export const SCHEMA_SQL = ${JSON.stringify(sql)};

// 后期新增的列（老库需要补）
const LATE_COLUMNS = [
  { table: 'exam_image', column: 'subject', type: "TEXT NOT NULL DEFAULT ''" },
  { table: 'events', column: 'account_id', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'poll_runs', column: 'account_id', type: 'INTEGER NOT NULL DEFAULT 0' },
];

function statements(sqlText) {
  // 去掉整行注释后按分号切分；本项目的建表脚本里没有含分号的字符串
  const clean = sqlText
    .split('\\n')
    .filter((line) => !/^\\s*--/.test(line))
    .join('\\n');
  return clean.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

async function hasColumn(db, table, column) {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('" + table + "') WHERE name = '" + column + "'").first();
    return !!(row && Number(row.n) > 0);
  } catch {
    return false;
  }
}

/**
 * 幂等的建库 / 升级。任何一步失败都不抛出，避免把整个请求打死。
 * @returns {{created: number, altered: string[]}}
 */
export async function ensureSchema(db) {
  const out = { created: 0, altered: [] };
  for (const stmt of statements(SCHEMA_SQL)) {
    try { await db.prepare(stmt).run(); out.created += 1; } catch { /* 已存在 / 不支持则跳过 */ }
  }
  for (const c of LATE_COLUMNS) {
    if (await hasColumn(db, c.table, c.column)) continue;
    try {
      await db.prepare('ALTER TABLE ' + c.table + ' ADD COLUMN ' + c.column + ' ' + c.type).run();
      out.altered.push(c.table + '.' + c.column);
    } catch { /* 并发下可能已被别的实例补上 */ }
  }
  try {
    await db.prepare("INSERT INTO app_meta (key, value) VALUES ('schema_checked_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(new Date().toISOString()).run();
  } catch { /* app_meta 不存在也不影响 */ }
  return out;
}
`;
writeFileSync(new URL('../src/schema.js', import.meta.url), src, 'utf8');
console.log('src/schema.js 已由 install.sql 生成（' + sql.length + ' 字符）');
