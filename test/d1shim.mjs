// 把 node:sqlite 包成 Cloudflare D1 的调用形状，用来在本地真跑一遍 Worker 的 SQL。
// D1 本身就是 SQLite，所以这里的语义与线上一致（差别只在远程副本与延迟）。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createD1(...schemaPaths) {
  const db = new DatabaseSync(':memory:');
  for (const p of schemaPaths.flat()) db.exec(readFileSync(p, 'utf8'));

  function statement(sql, args) {
    return {
      bind: (...more) => statement(sql, args.concat(more)),
      first: () => {
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      all: () => ({ results: db.prepare(sql).all(...args), success: true }),
      run: () => {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
  }

  return {
    prepare: (sql) => statement(sql, []),
    // D1 的 batch：顺序执行，返回每组结果
    batch: (list) => list.map((st) => st.run()),
    close: () => db.close(),
  };
}
