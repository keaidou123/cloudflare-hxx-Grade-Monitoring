-- ============================================================================
-- 慧学星成绩单监控 · 一键建库脚本（install.sql）
--
-- 用法：D1 控制台 → 粘贴本文件全文 → 点 Run 右边小箭头 ▾ →「Run all in sequence」
--
--   · 全新数据库：跑这一份就够了（等价于原来的 schema.sql + migrate-003~007）
--   · 已经部署过旧版：**不要**跑这个文件（表已存在，CREATE 会跳过、但缺的新列加不上），
--     请按顺序跑 migrations/ 里的升级脚本
--   · 本文件全部是 CREATE TABLE IF NOT EXISTS，重复执行不会报错、不会丢数据
-- ============================================================================

-- 慧学星成绩单监控 —— D1 (SQLite) 表结构
-- 应用方式：wrangler d1 execute hxxai_report_watch --remote --file=./schema.sql

-- 上游登录态（cookie jar）。只有一行，id 恒为 1。
CREATE TABLE IF NOT EXISTS session (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  cookies        TEXT    NOT NULL,          -- JSON: [{name,value,domain,path,expires}]
  updated_at     TEXT    NOT NULL,          -- ISO8601 UTC
  login_ok       INTEGER NOT NULL DEFAULT 0,
  login_msg      TEXT
);

-- 每份成绩单的最近一次已知状态（变更判定的基准）
CREATE TABLE IF NOT EXISTS exam_snapshot (
  exam_key       TEXT    PRIMARY KEY,       -- 上游 examId 的字符串形式
  exam_id        TEXT    NOT NULL,
  exam_type_id   TEXT,
  subject_name   TEXT,
  score_text     TEXT,                      -- 原样保留（'88' / '88.5' / NULL）
  score_num      REAL,                      -- 归一化数值，用于比较
  raw_json       TEXT    NOT NULL,          -- 上游原始条目，字段以后再变也不丢信息
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  last_change_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshot_last_seen ON exam_snapshot (last_seen_at DESC);

-- 成绩发布行为事件（唯一需要长期保留的"记录"）
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,            -- new_report | score_change | score_filled | score_cleared
  exam_key     TEXT    NOT NULL,
  exam_id      TEXT    NOT NULL,
  exam_type_id TEXT,
  subject_name TEXT,
  old_score    TEXT,
  new_score    TEXT,
  delta        REAL,
  detected_at  TEXT    NOT NULL,            -- ISO8601 UTC，落盘用 UTC
  raw_json     TEXT    NOT NULL,
  account_id   INTEGER NOT NULL DEFAULT 0    -- 第二阶段：数据归属账号
);

CREATE INDEX IF NOT EXISTS idx_events_detected ON events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_exam ON events (exam_key, detected_at DESC);

-- 每次轮询的运行记录（可观测性：判断"到底有没有在跑"）
CREATE TABLE IF NOT EXISTS poll_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT    NOT NULL,
  finished_at    TEXT,
  status         TEXT    NOT NULL,          -- ok | changed | baseline | auth_failed | upstream_error | parse_error | internal_error
  http_status    INTEGER,
  exams_seen     INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  relogin        INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  message        TEXT,
  account_id     INTEGER NOT NULL DEFAULT 0   -- 第二阶段：数据归属账号
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON poll_runs (started_at DESC);

-- 管理端登录失败限流（按 IP）
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start TEXT    NOT NULL,
  blocked_until TEXT
);

-- 多科考试的次级科目分数（每轮轮询一并抓取，不需要打开界面才去取）
CREATE TABLE IF NOT EXISTS exam_subject (
  exam_key   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  score      TEXT,
  full       REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (exam_key, subject)
);

CREATE INDEX IF NOT EXISTS idx_subject_exam ON exam_subject (exam_key);

-- 试卷信息（每轮轮询一并抓取，界面不现取）
CREATE TABLE IF NOT EXISTS exam_meta (
  exam_key   TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 答题卡/试卷扫描件（轮询时从答题卡页解析图片地址，图片本身按需经 Worker 代理取）
CREATE TABLE IF NOT EXISTS exam_image (
  exam_key   TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL,
  idx        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (exam_key, url)
);

-- ---------------------------------------------------------------------------
-- 多账号（原 migrate-007-accounts.sql 并入）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- 登录名（大小写不敏感）
  pwd_salt      TEXT    NOT NULL,                        -- base64url 随机盐
  pwd_hash      TEXT    NOT NULL,                        -- base64url PBKDF2-SHA256（10 万次）
  pwd_iter      INTEGER NOT NULL DEFAULT 100000,         -- Workers 的 PBKDF2 上限就是 100000
  upstream_user TEXT,                                    -- 该账号自己的慧学星账号（手机号）
  upstream_seal TEXT,                                    -- 慧学星密码：AES-GCM 封存
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS account_session (
  account_id INTEGER PRIMARY KEY,
  cookies    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  login_ok   INTEGER NOT NULL DEFAULT 0,
  login_msg  TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
