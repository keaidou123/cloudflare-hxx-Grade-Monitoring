-- 已有部署的增量迁移：在 D1 Studio 里全选后执行

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
