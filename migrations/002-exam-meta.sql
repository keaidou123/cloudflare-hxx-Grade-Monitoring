-- 已有部署的增量迁移：在 D1 Studio 里全选后执行

-- 试卷信息（每轮轮询一并抓取，界面不现取）
CREATE TABLE IF NOT EXISTS exam_meta (
  exam_key   TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
