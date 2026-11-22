/**
 * 内嵌的建库脚本 + 自动补列（由 _build/embed-schema.mjs 从 install.sql 生成，勿手改）。
 *
 * 目的：让"只粘贴 worker.js"也能跑起来 ——
 *   1. 首次请求时把 install.sql 里的 CREATE TABLE IF NOT EXISTS 全部执行一遍（已存在则跳过）
 *   2. 检查三处后期新增的列，缺了就用 ALTER 补上（SQLite 没有 ADD COLUMN IF NOT EXISTS）
 * 因此：全新库、只跑过老版 schema 的库、跑过部分迁移的库，三种都能自动修好。
 */

export const SCHEMA_SQL = "-- ============================================================================\n-- 慧学星成绩单监控 · 一键建库脚本（install.sql）\n--\n-- 用法：D1 控制台 → 粘贴本文件全文 → 点 Run 右边小箭头 ▾ →「Run all in sequence」\n--\n--   · 全新数据库：跑这一份就够了（等价于原来的 schema.sql + migrate-003~007）\n--   · 已经部署过旧版：**不要**跑这个文件（表已存在，CREATE 会跳过、但缺的新列加不上），\n--     请按顺序跑 migrations/ 里的升级脚本\n--   · 本文件全部是 CREATE TABLE IF NOT EXISTS，重复执行不会报错、不会丢数据\n-- ============================================================================\n\n-- 慧学星成绩单监控 —— D1 (SQLite) 表结构\n-- 应用方式：wrangler d1 execute hxxai_report_watch --remote --file=./schema.sql\n\n-- 上游登录态（cookie jar）。只有一行，id 恒为 1。\nCREATE TABLE IF NOT EXISTS session (\n  id             INTEGER PRIMARY KEY CHECK (id = 1),\n  cookies        TEXT    NOT NULL,          -- JSON: [{name,value,domain,path,expires}]\n  updated_at     TEXT    NOT NULL,          -- ISO8601 UTC\n  login_ok       INTEGER NOT NULL DEFAULT 0,\n  login_msg      TEXT\n);\n\n-- 每份成绩单的最近一次已知状态（变更判定的基准）\nCREATE TABLE IF NOT EXISTS exam_snapshot (\n  exam_key       TEXT    PRIMARY KEY,       -- 上游 examId 的字符串形式\n  exam_id        TEXT    NOT NULL,\n  exam_type_id   TEXT,\n  subject_name   TEXT,\n  score_text     TEXT,                      -- 原样保留（'88' / '88.5' / NULL）\n  score_num      REAL,                      -- 归一化数值，用于比较\n  raw_json       TEXT    NOT NULL,          -- 上游原始条目，字段以后再变也不丢信息\n  first_seen_at  TEXT    NOT NULL,\n  last_seen_at   TEXT    NOT NULL,\n  last_change_at TEXT\n);\n\nCREATE INDEX IF NOT EXISTS idx_snapshot_last_seen ON exam_snapshot (last_seen_at DESC);\n\n-- 成绩发布行为事件（唯一需要长期保留的\"记录\"）\nCREATE TABLE IF NOT EXISTS events (\n  id           INTEGER PRIMARY KEY AUTOINCREMENT,\n  kind         TEXT    NOT NULL,            -- new_report | score_change | score_filled | score_cleared\n  exam_key     TEXT    NOT NULL,\n  exam_id      TEXT    NOT NULL,\n  exam_type_id TEXT,\n  subject_name TEXT,\n  old_score    TEXT,\n  new_score    TEXT,\n  delta        REAL,\n  detected_at  TEXT    NOT NULL,            -- ISO8601 UTC，落盘用 UTC\n  raw_json     TEXT    NOT NULL,\n  account_id   INTEGER NOT NULL DEFAULT 0    -- 第二阶段：数据归属账号\n);\n\nCREATE INDEX IF NOT EXISTS idx_events_detected ON events (detected_at DESC);\nCREATE INDEX IF NOT EXISTS idx_events_exam ON events (exam_key, detected_at DESC);\n\n-- 每次轮询的运行记录（可观测性：判断\"到底有没有在跑\"）\nCREATE TABLE IF NOT EXISTS poll_runs (\n  id             INTEGER PRIMARY KEY AUTOINCREMENT,\n  started_at     TEXT    NOT NULL,\n  finished_at    TEXT,\n  status         TEXT    NOT NULL,          -- ok | changed | baseline | auth_failed | upstream_error | parse_error | internal_error\n  http_status    INTEGER,\n  exams_seen     INTEGER NOT NULL DEFAULT 0,\n  events_created INTEGER NOT NULL DEFAULT 0,\n  relogin        INTEGER NOT NULL DEFAULT 0,\n  duration_ms    INTEGER,\n  message        TEXT,\n  account_id     INTEGER NOT NULL DEFAULT 0   -- 第二阶段：数据归属账号\n);\n\nCREATE INDEX IF NOT EXISTS idx_runs_started ON poll_runs (started_at DESC);\n\n-- 管理端登录失败限流（按 IP）\nCREATE TABLE IF NOT EXISTS login_attempts (\n  ip           TEXT    PRIMARY KEY,\n  count        INTEGER NOT NULL,\n  window_start TEXT    NOT NULL,\n  blocked_until TEXT\n);\n\n-- 多科考试的次级科目分数（每轮轮询一并抓取，不需要打开界面才去取）\nCREATE TABLE IF NOT EXISTS exam_subject (\n  exam_key   TEXT NOT NULL,\n  subject    TEXT NOT NULL,\n  score      TEXT,\n  full       REAL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (exam_key, subject)\n);\n\nCREATE INDEX IF NOT EXISTS idx_subject_exam ON exam_subject (exam_key);\n\n-- 试卷信息（每轮轮询一并抓取，界面不现取）\nCREATE TABLE IF NOT EXISTS exam_meta (\n  exam_key   TEXT PRIMARY KEY,\n  payload    TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\n\n-- 答题卡/试卷扫描件（轮询时从答题卡页解析图片地址，图片本身按需经 Worker 代理取）\nCREATE TABLE IF NOT EXISTS exam_image (\n  exam_key   TEXT NOT NULL,\n  subject    TEXT NOT NULL DEFAULT '',\n  url        TEXT NOT NULL,\n  idx        INTEGER NOT NULL DEFAULT 0,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (exam_key, url)\n);\n\n-- ---------------------------------------------------------------------------\n-- 多账号（原 migrate-007-accounts.sql 并入）\n-- ---------------------------------------------------------------------------\n\nCREATE TABLE IF NOT EXISTS account (\n  id            INTEGER PRIMARY KEY AUTOINCREMENT,\n  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- 登录名（大小写不敏感）\n  pwd_salt      TEXT    NOT NULL,                        -- base64url 随机盐\n  pwd_hash      TEXT    NOT NULL,                        -- base64url PBKDF2-SHA256（10 万次）\n  pwd_iter      INTEGER NOT NULL DEFAULT 100000,         -- Workers 的 PBKDF2 上限就是 100000\n  upstream_user TEXT,                                    -- 该账号自己的慧学星账号（手机号）\n  upstream_seal TEXT,                                    -- 慧学星密码：AES-GCM 封存\n  created_at    TEXT    NOT NULL,\n  updated_at    TEXT    NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS account_session (\n  account_id INTEGER PRIMARY KEY,\n  cookies    TEXT    NOT NULL,\n  updated_at TEXT    NOT NULL,\n  login_ok   INTEGER NOT NULL DEFAULT 0,\n  login_msg  TEXT\n);\n\nCREATE TABLE IF NOT EXISTS app_meta (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n";

// 后期新增的列（老库需要补）
const LATE_COLUMNS = [
  { table: 'exam_image', column: 'subject', type: "TEXT NOT NULL DEFAULT ''" },
  { table: 'events', column: 'account_id', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'poll_runs', column: 'account_id', type: 'INTEGER NOT NULL DEFAULT 0' },
];

function statements(sqlText) {
  // 去掉整行注释后按分号切分；本项目的建表脚本里没有含分号的字符串
  const clean = sqlText
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
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
