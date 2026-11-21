import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScore, scoreText, examKeyOf, normalizeItem, diffExams } from '../src/diff.js';

test('normalizeScore 处理数字、字符串与空值', () => {
  assert.equal(normalizeScore(88), 88);
  assert.equal(normalizeScore('88.5'), 88.5);
  assert.equal(normalizeScore(' 90 '), 90);
  assert.equal(normalizeScore(null), null);
  assert.equal(normalizeScore(''), null);
  assert.equal(normalizeScore('缺考'), null);
});

test('scoreText 保留原样，空串归一为 null', () => {
  assert.equal(scoreText(88), '88');
  assert.equal(scoreText('A'), 'A');
  assert.equal(scoreText('  '), null);
  assert.equal(scoreText(undefined), null);
});

test('examKeyOf 只认 examId', () => {
  assert.equal(examKeyOf({ examId: 1001 }), '1001');
  assert.equal(examKeyOf({}), null);
  assert.equal(examKeyOf(null), null);
});

test('normalizeItem 保留 raw 原文', () => {
  const it = normalizeItem({ examId: 7, examTypeId: 2, subjectName: '语文', studentScore: '95.5', extra: '未来新增字段' });
  assert.equal(it.examKey, '7');
  assert.equal(it.examId, '7');
  assert.equal(it.examTypeId, '2');
  assert.equal(it.subjectName, '语文');
  assert.equal(it.scoreText, '95.5');
  assert.equal(it.scoreNum, 95.5);
  assert.ok(it.rawJson.includes('未来新增字段'));
});

test('首次出现的成绩单 -> new_report', () => {
  const { items, events } = diffExams(new Map(), [{ examId: 1, subjectName: '数学', studentScore: 90 }]);
  assert.equal(items.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'new_report');
  assert.equal(events[0].newScore, '90');
  assert.equal(events[0].oldScore, null);
});

test('分数变化 -> score_change 且 delta 正确', () => {
  const prev = new Map([['1', { exam_key: '1', score_num: 90, score_text: '90' }]]);
  const { events } = diffExams(prev, [{ examId: 1, subjectName: '数学', studentScore: 93.5 }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'score_change');
  assert.equal(events[0].oldScore, '90');
  assert.equal(events[0].newScore, '93.5');
  assert.equal(events[0].delta, 3.5);
});

test('分数没变 -> 无事件（含 88 与 88.0 等价）', () => {
  const prev = new Map([['1', { exam_key: '1', score_num: 88, score_text: '88' }]]);
  assert.equal(diffExams(prev, [{ examId: 1, studentScore: '88.0' }]).events.length, 0);
  assert.equal(diffExams(prev, [{ examId: 1, studentScore: 88 }]).events.length, 0);
});

test('从缺考到出分 -> score_filled', () => {
  const prev = new Map([['1', { exam_key: '1', score_num: null, score_text: null }]]);
  const { events } = diffExams(prev, [{ examId: 1, studentScore: 76 }]);
  assert.equal(events[0].kind, 'score_filled');
  assert.equal(events[0].delta, null);
});

test('分数被清空 -> score_cleared', () => {
  const prev = new Map([['1', { exam_key: '1', score_num: 76, score_text: '76' }]]);
  const { events } = diffExams(prev, [{ examId: 1, studentScore: null }]);
  assert.equal(events[0].kind, 'score_cleared');
});

test('等级制分数的文本变化 -> score_change（delta 为 null）', () => {
  const prev = new Map([['1', { exam_key: '1', score_num: null, score_text: 'B' }]]);
  const { events } = diffExams(prev, [{ examId: 1, studentScore: 'A' }]);
  assert.equal(events[0].kind, 'score_change');
  assert.equal(events[0].delta, null);
});

test('翻页重叠的同一 examId 只算一次', () => {
  const { items, events } = diffExams(new Map(), [{ examId: 1, studentScore: 1 }, { examId: 1, studentScore: 1 }]);
  assert.equal(items.length, 1);
  assert.equal(events.length, 1);
});

test('缺少 examId 的脏数据被跳过而不是崩溃', () => {
  const { items, events } = diffExams(new Map(), [null, {}, { examId: null }, { examId: 2 }]);
  assert.equal(items.length, 1);
  assert.equal(events.length, 1);
});
