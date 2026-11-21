-- 答题卡按科目分组：给 exam_image 增加 subject 列
ALTER TABLE exam_image ADD COLUMN subject TEXT NOT NULL DEFAULT '';
