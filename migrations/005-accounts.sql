-- 第二阶段：多账号。只做「加表 / 加列」，不 DROP、不改既有列。
-- 隔离方式：所有考试相关表的主键（exam_key）加上 "<accountId>|" 前缀，
-- 因此既有表结构与索引全部沿用，无需重建。

CREATE TABLE IF NOT EXISTS account (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- 登录名（大小写不敏感）
  pwd_salt      TEXT    NOT NULL,                        -- base64url 随机盐
  pwd_hash      TEXT    NOT NULL,                        -- base64url PBKDF2-SHA256 结果
  pwd_iter      INTEGER NOT NULL DEFAULT 150000,
  upstream_user TEXT,                                    -- 该账号自己的慧学星账号（手机号）
  upstream_seal TEXT,                                    -- 慧学星密码：AES-GCM 封存，密钥由 SESSION_SECRET 派生
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- 上游登录态（cookie jar）从全局单行改为按账号一行
CREATE TABLE IF NOT EXISTS account_session (
  account_id INTEGER PRIMARY KEY,
  cookies    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  login_ok   INTEGER NOT NULL DEFAULT 0,
  login_msg  TEXT
);

-- 事件与巡检记录保留全量、按账号标注
ALTER TABLE events     ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE poll_runs  ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0;

-- 迁移标记：一次性把既有数据认领给「原 admin 账号」
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
