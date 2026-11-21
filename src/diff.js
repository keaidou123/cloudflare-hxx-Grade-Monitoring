/**
 * 纯函数模块：条目规范化 + 变更判定。
 * 上游字段名全部来自实测（https://c.hxxai.com/assets/vue/report/index.js）：
 *   examId / examTypeId / subjectName / studentScore / dataParent
 * 不臆造字段：没被确认过的字段一律原样进 raw_json，由管理界面按实际内容展示。
 */

/** 分数归一化：'88' -> 88, '88.5' -> 88.5, null/''/非数字 -> null */
export function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** 原样分数文本：null 保留 null（表示缺考/未出分），其余转字符串 */
export function scoreText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** 成绩单身份：上游以 examId 为主键（examReportList / checkReport 均以 examId 定位） */
export function examKeyOf(item) {
  if (!item || item.examId === null || item.examId === undefined) return null;
  return String(item.examId);
}

export function normalizeItem(item) {
  const examKey = examKeyOf(item);
  if (!examKey) return null;
  return {
    examKey,
    examId: examKey,
    examTypeId: item.examTypeId === null || item.examTypeId === undefined ? null : String(item.examTypeId),
    subjectName: item.subjectName === null || item.subjectName === undefined ? null : String(item.subjectName),
    scoreText: scoreText(item.studentScore),
    scoreNum: normalizeScore(item.studentScore),
    rawJson: JSON.stringify(item),
  };
}

/**
 * 与上一轮快照比较，产出事件。
 * @param {Map<string, {score_num:number|null, score_text:string|null}>} prevMap
 * @param {Array<object>} rawItems 上游 list 数组
 * @returns {{items: object[], events: object[]}}
 */
export function diffExams(prevMap, rawItems) {
  const items = [];
  const events = [];
  const seen = new Set();

  for (const raw of rawItems || []) {
    const cur = normalizeItem(raw);
    if (!cur) continue;
    if (seen.has(cur.examKey)) continue; // 翻页重叠去重
    seen.add(cur.examKey);
    items.push(cur);

    const prev = prevMap instanceof Map ? prevMap.get(cur.examKey) : prevMap[cur.examKey];
    if (!prev) {
      events.push({
        kind: 'new_report',
        examKey: cur.examKey,
        examId: cur.examId,
        examTypeId: cur.examTypeId,
        subjectName: cur.subjectName,
        oldScore: null,
        newScore: cur.scoreText,
        delta: null,
        rawJson: cur.rawJson,
      });
      continue;
    }

    const a = prev.score_num === undefined ? null : prev.score_num;
    const b = cur.scoreNum;
    const prevText = prev.score_text === undefined ? null : prev.score_text;
    let kind = null;

    if (a === null && b !== null) {
      kind = 'score_filled';            // 之前缺考/未出分，现在有分
    } else if (a !== null && b === null) {
      kind = 'score_cleared';           // 分数被收回/清空
    } else if (a !== null && b !== null) {
      if (a !== b) kind = 'score_change';
    } else if (prevText !== cur.scoreText && cur.scoreText !== null) {
      kind = 'score_change';            // 非数值分数（等级制）：按文本比较
    }
    if (!kind) continue;

    events.push({
      kind,
      examKey: cur.examKey,
      examId: cur.examId,
      examTypeId: cur.examTypeId,
      subjectName: cur.subjectName,
      oldScore: prevText,
      newScore: cur.scoreText,
      delta: a !== null && b !== null ? Number((b - a).toFixed(4)) : null,
      rawJson: cur.rawJson,
    });
  }

  return { items, events };
}

export const EVENT_LABELS = {
  new_report: '新成绩单发布',
  score_change: '分数变化',
  score_filled: '出分（原为缺考/未出分）',
  score_cleared: '分数被清空',
};
