import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExamTitle, resolveExamDate, isMultiSubject, summarizeDetail, keyNames } from '../src/format.js';

// 真实列表截图里的样子：[周考] 高一数学周测1106 / 118.0 分 / 2026-11-06
// 用户给的真实报文片段（2026-11-21）：
//   "examName":"2026级高一10月月考"  "examId":372948  "subjectName":"多科"  "examYear":"2026"  "typeName":"月考"
const realMulti = { examId: 372948, examName: '2026级高一10月月考', subjectName: '多科', examYear: '2026', typeName: '月考' };
const mathItem = {
  examId: 9001, examTypeId: 1, subjectName: '数学',
  typeName: '周考', examName: '高一数学周测1106',
  examTime: '2026-11-06 08:00:00', studentScore: 118,
};

test('resolveExamTitle 用 [typeName] examName 拼出站点上的显示名', () => {
  assert.equal(resolveExamTitle(realMulti), '[月考] 2026级高一10月月考');
  assert.equal(resolveExamTitle(mathItem), '[周考] 高一数学周测1106');
});

test('resolveExamTitle 只有 examName 时不加方括号', () => {
  assert.equal(resolveExamTitle({ examId: 1, examName: '2026级高一10月月考' }), '2026级高一10月月考');
});

test('resolveExamTitle examName 自带方括号时不重复加前缀', () => {
  assert.equal(resolveExamTitle({ examId: 1, examName: '[周考] 高一数学周测1106', typeName: '周考' }), '[周考] 高一数学周测1106');
});

test('resolveExamTitle 没有候选键时用启发式挑最长的考试名', () => {
  const raw = { examId: 1, examTypeId: 1, subjectName: '数学', examTypeName: '周考', mystery: '[周考] 高一数学周测1106' };
  assert.equal(resolveExamTitle(raw), '[周考] 高一数学周测1106');
});

test('resolveExamTitle 绝不把 id 当标题', () => {
  const raw = { examId: 1234567890123, examTypeId: 2, subjectName: '多科' };
  assert.equal(resolveExamTitle(raw), null);
});

test('resolveExamDate 命中日期键', () => {
  assert.equal(resolveExamDate(mathItem), '2026-11-06');
});

test('resolveExamDate 从任意字段里认出日期，但不会被 examId 这种大整数骗到', () => {
  assert.equal(resolveExamDate({ examId: 1700000000000, whatever: '2026-10-13 09:30' }), '2026-10-13');
  assert.equal(resolveExamDate({ examId: 1700000000000 }), null);
});

test('isMultiSubject 认 subjectName=多科，也认 dataParent 多科结构', () => {
  assert.equal(isMultiSubject({ subjectName: '多科' }), true);
  assert.equal(isMultiSubject({ subjectName: '数学' }), false);
  assert.equal(isMultiSubject({ subjectName: 'X', dataParent: [{ a: 1 }, { b: 2 }] }), true);
});

test('summarizeDetail 归一化各科分数', () => {
  const res = summarizeDetail({
    examReportList: [
      { subjectName: '语文', studentScore: 98, fullScore: 120 },
      { courseName: '数学', score: 105 },
    ],
  });
  assert.equal(res.normalized, true);
  assert.equal(res.rows.length, 2);
  assert.deepEqual(res.rows[0], { subject: '语文', score: '98', full: 120 });
  assert.equal(res.rows[1].subject, '数学');
  assert.equal(res.rows[1].score, '105');
});

test('summarizeDetail 解析不出时 normalized=false，让界面回退到原始 JSON', () => {
  const res = summarizeDetail({ examReportList: [{ foo: 1 }, { bar: 2 }] });
  assert.equal(res.normalized, false);
  assert.equal(res.rows.length, 0);
});

test('summarizeDetail 容忍空数据', () => {
  assert.equal(summarizeDetail(null).normalized, false);
  assert.equal(summarizeDetail({}).normalized, false);
});

test('keyNames 汇总键名，供"原始字段"面板显示', () => {
  const keys = keyNames([{ a: 1, b: 2 }, { b: 3, c: 4 }]);
  assert.deepEqual(keys.sort(), ['a', 'b', 'c']);
});
