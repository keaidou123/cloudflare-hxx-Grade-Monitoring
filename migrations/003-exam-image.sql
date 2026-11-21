-- 已有部署的增量迁移：在 D1 Studio 里全选后执行

-- 答题卡/试卷扫描件（轮询时从答题卡页解析图片地址，图片本身按需经 Worker 代理取）
CREATE TABLE IF NOT EXISTS exam_image (
  exam_key   TEXT NOT NULL,
  url        TEXT NOT NULL,
  idx        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (exam_key, url)
);
