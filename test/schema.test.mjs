import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createD1 } from './d1shim.mjs';
import { ensureSchema } from '../src/schema.js';

const SCHEMA_OLD = fileURLToPath(new URL('../schema.sql', import.meta.url));
const MIG = (() => {
  const a = fileURLToPath(new URL('../migrate-007-accounts.sql', import.meta.url));
  const b = fileURLToPath(new URL('../migrations/005-accounts.sql', import.meta.url));
  return existsSync(a) ? a : b;
})();

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().results.map((r) => r.name).sort();
// 注意：pragma_table_info(?) 不接受绑定参数，必须把表名拼进 SQL
const cols = (db, t) => {
  if (!/^[a-z_]+$/.test(t)) throw new Error('非法表名: ' + t);
  return db.prepare("SELECT name FROM pragma_table_info('" + t + "')").all().results.map((r) => r.name);
};

test('全新空库：ensureSchema 一次性建出全部表（不需要手工跑 SQL）', async (t) => {
  const db = createD1();               // 一个什么都没有的库
  t.after(() => db.close());
  const r = await ensureSchema(db);
  const ts = tables(db);
  assert.equal(ts.length, 11, '应有 11 张表，实际=' + ts.join(','));
  for (const n of ['account', 'account_session', 'app_meta', 'exam_snapshot', 'exam_meta', 'exam_image', 'events', 'poll_runs', 'exam_subject', 'login_attempts', 'session']) {
    assert.ok(ts.includes(n), '缺表 ' + n);
  }
  assert.ok(cols(db, 'events').includes('account_id'));
  assert.ok(cols(db, 'poll_runs').includes('account_id'));
  assert.ok(cols(db, 'exam_image').includes('subject'));
  assert.ok(Array.isArray(r.altered));
});

test('老库（只跑过 schema.sql）：自动补出 account 系列表与 account_id 列', async (t) => {
  const db = createD1(SCHEMA_OLD);      // 第一阶段的老结构
  t.after(() => db.close());
  assert.ok(!tables(db).includes('account'), '前置：老库没有 account 表');
  assert.ok(!cols(db, 'events').includes('account_id'), '前置：老库没有 account_id');

  const r = await ensureSchema(db);
  assert.ok(tables(db).includes('account'));
  assert.ok(tables(db).includes('account_session'));
  assert.ok(cols(db, 'events').includes('account_id'));
  assert.ok(cols(db, 'poll_runs').includes('account_id'));
  assert.ok(r.altered.includes('events.account_id'), '应记录补了 events.account_id');
});

test('保证幂等：连续跑三次都不报错，且第二次起没有新补列', async (t) => {
  const db = createD1(SCHEMA_OLD, MIG);  // 已经升级过的库
  t.after(() => db.close());
  const r1 = await ensureSchema(db);
  const r2 = await ensureSchema(db);
  const r3 = await ensureSchema(db);
  assert.deepEqual(r1.altered, [], '都已存在，不该再补列');
  assert.deepEqual(r2.altered, []);
  assert.deepEqual(r3.altered, []);
  const meta = db.prepare("SELECT value FROM app_meta WHERE key='schema_checked_at'").first();
  assert.ok(meta && meta.value, '应写入自检时间');
});
