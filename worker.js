// @ts-nocheck —— 这是构建产物，给 Cloudflare 编辑器的类型推断关掉，避免无意义的红字
/* 慧学星成绩单监控 —— 单文件构建产物（由 _build/bundle.mjs 生成，勿手改）
   源文件在 src/，改了源文件请重新运行：node _build/bundle.mjs 
   生成时间: 2026-11-22T14:03:12.753Z */

// ---- diff.js ----
/**
 * 纯函数模块：条目规范化 + 变更判定。
 * 上游字段名全部来自实测（https://c.hxxai.com/assets/vue/report/index.js）：
 *   examId / examTypeId / subjectName / studentScore / dataParent
 * 不臆造字段：没被确认过的字段一律原样进 raw_json，由管理界面按实际内容展示。
 */

/** 分数归一化：'88' -> 88, '88.5' -> 88.5, null/''/非数字 -> null */
function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** 原样分数文本：null 保留 null（表示缺考/未出分），其余转字符串 */
function scoreText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** 成绩单身份：上游以 examId 为主键（examReportList / checkReport 均以 examId 定位） */
function examKeyOf(item) {
  if (!item || item.examId === null || item.examId === undefined) return null;
  return String(item.examId);
}

function normalizeItem(item) {
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
function diffExams(prevMap, rawItems) {
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

const EVENT_LABELS = {
  new_report: '新成绩单发布',
  score_change: '分数变化',
  score_filled: '出分（原为缺考/未出分）',
  score_cleared: '分数被清空',
};


// ---- format.js ----
/**
 * 展示层字段解析（纯函数，可单测）。
 *
 * 已实测确认的上游字段：examId / examTypeId / subjectName / studentScore / dataParent。
 * 但"考试名称""考试日期"这两个字段**没有**被测实过 —— 我拿不到你登录后的原始报文。
 * 所以这里采用三级策略，任何一步命中都能显示：
 *   ① 候选键（TITLE_KEYS / DATE_KEYS）
 *   ② 内容启发式（找出最像"考试名"的那个字符串；找出最像日期的那个值）
 *   ③ 保底拼接（科目 + examId）
 * 一旦在管理界面「诊断」里看到真实键名，把该键移到候选列表第一位即可钉死，无需改别处。
 */

const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const isIdKey = (k) => /id$/i.test(k) && k !== 'valid';

// examName / typeName 已由用户真实报文确认（2026-11-21，session 实录）：
//   {"examName":"2026级高一10月月考","examId":372948,"subjectName":"多科","examYear":"2026","typeName":"月考"}
// 站点渲染成 "[月考] 2026级高一10月月考" —— 方括号里的是 typeName，不是 examName 的一部分。
const TITLE_KEYS = ['examName', 'examTitle', 'title', 'name', 'paperName'];
const TYPE_KEYS = ['typeName', 'examTypeName'];
const DATE_KEYS = ['examTime', 'examDate', 'examDay', 'testTime', 'startTime', 'beginTime', 'createTime'];

function resolveExamTitle(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let name = str(raw.examName);
  if (name.length < 2) {
    for (const k of TITLE_KEYS.slice(1)) {
      const v = str(raw[k]);
      if (v.length >= 2) { name = v; break; }
    }
  }
  if (name.length >= 2) {
    if (name.startsWith('[')) return name; // 上游已自带类型前缀，别重复加
    const type = TYPE_KEYS.map((k) => str(raw[k])).find((v) => v.length > 0);
    return type ? '[' + type + '] ' + name : name;
  }

  // 兜底：连 examName 都没有时，才在报文里找最像考试名的字符串
  const subject = str(raw.subjectName).slice(0, 2);
  let best = null;
  for (const [k, val] of Object.entries(raw)) {
    if (TITLE_KEYS.includes(k) || isIdKey(k)) continue;
    const v = str(val);
    if (v.length < 4 || v.length > 60) continue;
    if (subject && v === subject) continue;
    if (/^\d+$/.test(v)) continue;
    if (!/[考测试月周期末期中]/.test(v)) continue;
    if (!best || v.length > best.length) best = v;
  }
  return best;
}

function toDateText(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 1e12) {
    const d = new Date(v);
    return d.toISOString().slice(0, 10);
  }
  const s = str(v);
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return null;
}

function resolveExamDate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const k of DATE_KEYS) {
    const d = toDateText(raw[k]);
    if (d) return d;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (isIdKey(k) || k === 'examId' || k === 'examTypeId') continue;
    const d = toDateText(v);
    if (d) return d;
  }
  return null;
}

/** 多科考试：上游 subjectName 就是"多科"两个字（截图可见）；兼容 dataParent 多科结构 */
function isMultiSubject(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (str(raw.subjectName).includes('多科')) return true;
  const dp = raw.dataParent;
  return Array.isArray(dp) && dp.length > 1;
}

const SUBJECT_KEYS = ['subjectName', 'courseName', 'subject', 'name'];
const SCORE_KEYS = ['studentScore', 'score', 'examScore', 'totalScore', 'studentScoreNum'];
const FULL_KEYS = ['fullScore', 'scoreFull', 'totalFullScore', 'paperScore', 'fullMarks'];

function firstFrom(keys, obj, want) {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (want === 'string') {
      const s = str(v);
      if (s) return s;
    } else if (v !== null && v !== undefined && v !== '') {
      return v;
    }
  }
  return null;
}

/**
 * 把单场考试明细（/api/examReport/examReportList 的 examReportList）归一化成
 * [{subject, score, full}]；解析不出任何行时 normalized=false，调用方应回退到 raw。
 */
function summarizeDetail(data) {
  const list = Array.isArray(data) ? data : (data && (data.examReportList || data.reportList || data.list)) || [];
  const rows = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const subject = firstFrom(SUBJECT_KEYS, it, 'string');
    const score = firstFrom(SCORE_KEYS, it, 'scalar');
    if (subject === null && score === null) continue;
    rows.push({ subject, score: score === null ? null : String(score), full: firstFrom(FULL_KEYS, it, 'scalar') });
  }
  return { rows, normalized: rows.length > 0, total: Array.isArray(list) ? list.length : 0 };
}

/**
 * 多科明细的来源②：GET /api/examReport/examCourse 返回的 courseList。
 * 该端点是 /report/alldetail 页脚本（/assets/vue/report/alldetail.js）实调，
 * 每条至少含 sysCourseId / courseName / type（2=新高考赋分科目）/ error；
 * 是否带分数未实测，所以分数键做候选匹配，取不到就交给来源③。
 */
function summarizeCourseList(courseList) {
  const rows = [];
  for (const it of Array.isArray(courseList) ? courseList : []) {
    if (!it || typeof it !== 'object') continue;
    const subject = firstFrom(SUBJECT_KEYS.concat(['courseName']), it, 'string');
    if (!subject) continue;
    const score = firstFrom(SCORE_KEYS.concat(['courseScore', 'markScore']), it, 'scalar');
    const full = firstFrom(FULL_KEYS.concat(['fullMark', 'courseFullMark']), it, 'scalar');
    rows.push({ subject, score: score === null ? null : String(score), full });
  }
  const normalized = rows.some((r) => r.score !== null);
  return { rows, normalized };
}

// /report/alldetail 页面上实际出现的科目名（截图实证），用于 HTML 兜底解析时锚定
const SUBJECT_WHITELIST = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '技术', '史地政', '理综', '文综'];

/**
 * 多科明细的来源③：直接解析 /report/alldetail 的 HTML（用户截图里那一屏）。
 * 这一屏是服务端渲染的，科目名后面紧跟 "88 / 150" 这种文本，所以按科目名锚定取分数。
 * 宁可少解析，也不要把排名、人数、百分比误当成分数。
 */
function parseScoresFromHtml(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const rows = [];
  for (const sub of SUBJECT_WHITELIST) {
    // 必须同时出现「分数 / 满分」，否则很可能是页面上的无关数字
    const re = new RegExp(sub + '[^0-9]{0,14}(\\d{1,3}(?:\\.\\d+)?)\\s*\\/\\s*(\\d{2,3})');
    const m = text.match(re);
    if (!m) continue;
    const sc = parseFloat(m[1]);
    const fu = Number(m[2]);
    if (!(fu > 0) || !(sc <= fu)) continue;
    rows.push({ subject: sub, score: m[1], full: fu });
  }
  // 单科报告页也会零散出现「数学 110 / 150」这类文字；只有凑够 3 科才当作多科明细页
  return { rows, normalized: rows.length >= 3 };
}

/**
 * 高中标准满分（现行高考/学业水平口径）：语数英各 150，其余各 100。
 * 上游没给满分时用它兜底；多科九科合计 = 150×3 + 100×6 = 1050（与站点页面上"总分1050"一致）。
 */
const FULL_MARKS = { 语文: 150, 数学: 150, 英语: 150, 物理: 100, 化学: 100, 生物: 100, 政治: 100, 历史: 100, 地理: 100, 技术: 100, 史地政: 300, 理综: 300, 文综: 300 };
const MULTI_FULL = 1050;

function standardFull(subject) {
  if (!subject) return null;
  const key = String(subject).trim();
  if (FULL_MARKS[key]) return FULL_MARKS[key];
  const hit = Object.keys(FULL_MARKS).find((k) => key.includes(k));
  return hit ? FULL_MARKS[hit] : null;
}

function flattenHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * 从 /report/alldetail 这一页里抽「考试信息 + 试卷信息 + 评语」。
 * 全部按页面上真实出现的文字锚定（见截图）：
 *   类型：周考 / 时间：2026-11-06 / 实考考生：373 / 满分 150分 /
 *   客观题 11道/58分 / 主观题 6道/92分 / 试题总数 17道 / 试卷难度 简单 / 试卷难度比例 难中易 1:6:10
 */
function RAW_TYPES(v) {
  if (!v) return null;
  const W2 = ['周考', '周测', '月考', '期中', '期末', '联考', '统考', '校考', '会考', '模拟', '调研', '单科', '综合'];
  return W2.indexOf(v) >= 0 ? v : null;   // 认不出来的类型宁可空着，也不显示乱码
}

function parsePaperInfo(html) {
  const t = flattenHtml(html);
  const one = (re) => {
    const m = t.match(re);
    return m ? (m[1] === undefined ? m[0] : m[1]).trim() : null;
  };
  const num = (v) => (v === null ? null : Number(v));

  const obj = t.match(/客观题\s*(\d+)\s*道\s*\/\s*(\d+)\s*分/);
  const sub = t.match(/主观题\s*(\d+)\s*道\s*\/\s*(\d+)\s*分/);

  const TYPE_WHITELIST = ['周考', '周测', '月考', '期中', '期末', '联考', '统考', '校考', '会考', '模拟', '调研', '单科', '综合'];
  const rawType = one(/类型[:：]\s*([^\s]{1,8})/);
  const info = {
    type: RAW_TYPES(rawType),
    date: one(/时间[:：]\s*(\d{4}-\d{2}-\d{2})/),
    candidates: num(one(/实考考生[:：]?\s*(\d+)/)),
    full: num(one(/满分\s*(\d+)\s*分/)),
    objective: obj ? { count: Number(obj[1]), score: Number(obj[2]) } : null,
    subjective: sub ? { count: Number(sub[1]), score: Number(sub[2]) } : null,
    questions: num(one(/试题总数\s*(\d+)\s*道/)),
    difficulty: one(/试卷难度\s*(简单|较易|中等|较难|困难|适中)/),
    difficultyRatio: one(/难中易\s*([\d:]{3,12})/),
    // 页面原文是「被评定为 良好 ，距离…」，标签之间的空格会留下「良好 ，」，这里清掉中文标点前的空格
    comment: (one(/被(?:评定为|评为)\s*([^。]{2,80})/) || '').replace(/\s+([，、；：])/g, '$1').trim() || null,
  };
  const count = Object.keys(info).filter((k) => info[k] !== null && info[k] !== undefined).length;
  // 至少认出 2 个字段才当作有效信息；否则当作没识别，并把原文片段带回去给用户复制
  return { info: count >= 2 ? info : null, text: t.slice(0, 800) };
}

/**
 * 从答题卡/报告页里抽图片地址。
 * 只认 hxxai 域名下的图（线上实测形如 https://oss.hxxai.com/srcImgOK/377704/348046/386231/srcImgOK.png），
 * 其余一律丢弃 —— 既避免抓到无关图标，也避免把任意 URL 存进库。
 */
function extractImageUrls(html, origin = 'https://c.hxxai.com') {
  const src = String(html || '');
  const urls = [];
  const seen = new Set();

  const keep = (raw) => {
    let u = String(raw || '').trim();
    if (!u || /^data:/i.test(u)) return;
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) u = origin.replace(/\/+$/, '') + u;
    if (!/^https:\/\//i.test(u)) return;
    let parsed;
    try { parsed = new URL(u); } catch { return; }
    const host = parsed.hostname;
    const path = parsed.pathname || '';
    if (!/(^|\.)hxxai\.com$/i.test(host)) return;
    // 站点自身的装饰图（/assets/ 下的 banner、图标、二维码）一律不要：
    // 「致家长的一封信」那张 2fscoreSearch/banner.png 就属于这一类，只在首访时弹一次。
    if (/^\/assets\//i.test(path)) return;
    if (/\.(gif|svg)$/i.test(path)) return;
    // 只认扫描件：实测答题卡在 oss.hxxai.com/srcImgOK/... 下
    if (!/srcimg|answer|sheet|scan|timu|paperimg/i.test(path)) return;
    if (seen.has(u)) return;
    seen.add(u);
    urls.push(u);
  };

  // ① <img src>（含 data-src / data-original，懒加载常见）
  for (const m of src.matchAll(/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/gi)) keep(m[1]);
  // ② 内联 JS 里拼出来的图片地址（有些页面是脚本赋值的）
  for (const m of src.matchAll(/https?:\/\/[^\s"'\\<>]+\.(?:png|jpe?g|webp)/gi)) keep(m[0]);

  return urls.slice(0, 30);
}

// 红色扣分明细是站点自己的叠加图：/assets/img/original_i1.png、original_i2.png
const OVERLAY_RE = /^https?:\/\/[^/]*\.?hxxai\.com\/assets\/img\/original_i\d+\.(?:png|jpe?g|webp)$/i;

const looksLikeSheetImage = (u) => {
  if (!/^https?:\/\//i.test(u)) return false;
  let p;
  try { p = new URL(u); } catch { return false; }
  if (!/(^|\.)hxxai\.com$/i.test(p.hostname)) return false;
  if (OVERLAY_RE.test(u)) return true;                    // 扣分图层放行
  if (/^\/assets\//i.test(p.pathname)) return false;
  if (!/\.(png|jpe?g|webp)(\?|$)/i.test(p.pathname + (p.search || ''))) return false;
  return /srcimg|answer|sheet|scan|timu|paperimg|original/i.test(p.pathname);
};

/**
 * 从任意 JSON 里深度挖出答题卡图片地址。
 * 不写死字段名 —— 原卷图的字段名我没有实测过，靠「长得像图片地址」来认，
 * 这样上游加字段、改名都不会漏。
 */
const SHEET_REL = /^\/(?:[\w.%-]+\/)*srcimg[\w.%-]*\.(?:png|jpe?g|webp)$/i;
const OVERLAY_REL = /^\/assets\/img\/original_i\d+\.(?:png|jpe?g|webp)$/i;

function collectImageUrls(value, out = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    const s = value.trim();
    // 相对路径（/srcImgOK/…/srcImgOK.png）补成完整地址 —— 接口里常见不带域名
    if (OVERLAY_REL.test(s)) {
      const full = 'https://c.hxxai.com' + s;
      if (out.indexOf(full) < 0) out.push(full);
      return out;
    }
    if (SHEET_REL.test(s)) {
      const full = 'https://oss.hxxai.com' + s;
      if (out.indexOf(full) < 0) out.push(full);
      return out;
    }
    if (looksLikeSheetImage(s) && out.indexOf(s) < 0) out.push(s);
    // 有些字段是逗号/竖线分隔的多张图
    if (s.indexOf(',') > 0 || s.indexOf('|') > 0) {
      for (const part of s.split(/[,|\s]+/)) {
        const t = part.trim();
        if (looksLikeSheetImage(t) && out.indexOf(t) < 0) out.push(t);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectImageUrls(v, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) collectImageUrls(value[k], out, depth + 1);
  }
  return out;
}

/**
 * 从挖到的图里挑出"真正的答题卡页"。
 * 实测原卷接口会顺带给出十几张杂图（缩略图/切块/预览），
 * 而真正的答卷扫描件文件名是 original_i1.png、original_i2.png（DevTools 实测）。
 * 只要出现过这种命名，就只留它们并按页码排序；否则保持原样。
 */
function pickAnswerSheetImages(urls) {
  const list = (Array.isArray(urls) ? urls : []).map(String);
  const scan = list.filter((u) => /\/srcImgOK\.(?:png|jpe?g|webp)(?:\?|$)/i.test(u));
  const page = list.filter((u) => /original_i\d+\.(?:png|jpe?g|webp)(?:\?|$)/i.test(u) && !/^https?:\/\/[^/]*hxxai\.com\/assets\//i.test(u));
  const overlay = list.filter((u) => /\/assets\/img\/original_i\d+\.(?:png|jpe?g|webp)(?:\?|$)/i.test(u));
  const rest = list.filter((u) => scan.indexOf(u) < 0 && page.indexOf(u) < 0 && overlay.indexOf(u) < 0);
  const uniq = (arr) => arr.filter((u, i) => arr.indexOf(u) === i);
  // 答卷和扣分图层分别限额：图层永远保留，不能被海量答卷挤掉
  const ordered = [].concat(uniq(scan).slice(0, 30), uniq(page).slice(0, 30), uniq(rest).slice(0, 10), uniq(overlay).slice(0, 12));
  return uniq(ordered);
}

/**
 * 解析 POST /api/examReport/originalVolume 的真实响应（2026-11-22 实测）。
 * 关键事实：
 *   paper.paperURLs[]  -> 每页扫描件 { pageNum, fileUrl }（一科正好 2 页）
 *   subjectFiles[]     -> 题目块 { blockIndex, posInfo:"x-y-w-h", fileUrl, subjects[] }
 *                          subjects[].scoreValue = 满分，finallyScore = 实得
 *   objects[]          -> 客观题 { questionNumber, answer, studentAnswer, scoreValue, finallyScore, saveFileUrl }
 * 响应里**没有**红色批改图层（那两张 original_iN.png 是站点自己的静态素材），
 * 所以"扣分明细"只能由我们自己按失分块画红框。
 */
function summarizeOriginalVolume(data, overrides) {
  if (!data || typeof data !== 'object') return null;
  const paper = data.paper || {};
  const pages = [];
  for (const p of paper.paperURLs || []) {
    if (p && p.fileUrl) pages.push({ page: Number(p.pageNum) || pages.length + 1, url: String(p.fileUrl) });
  }
  if (!pages.length && paper.paperUrl) {
    // 兜底：1:386231:https://...;2:386232:https://...
    for (const seg of String(paper.paperUrl).split(';')) {
      const m = seg.match(/^(\d+):[^:]*:(https?:\/\/\S+)$/);
      if (m) pages.push({ page: Number(m[1]), url: m[2] });
    }
  }
  if (!pages.length) return null;

  // 每页尺寸用块坐标的最大值推算（线上实测 page1 宽约 2953、高约 1981）
  // 页码：用 zipFileId1..4 去匹配 paperURLs[].zipFileId。
  // 之前误用 blockIndex 首段（1_2/2_1/3_1 是**题块序号**，不是页码），
  // 导致一页被当成多页，每页宽度只剩 987，红框按 920/987≈93% 铺满整页。
  const pageByZip = new Map();
  for (const p of paper.paperURLs || []) if (p && p.zipFileId !== undefined) pageByZip.set(String(p.zipFileId), Number(p.pageNum) || 1);
  const pickZip = (obj) => {
    if (!obj) return null;
    for (const k of ['zipFileId1', 'zipFileId2', 'zipFileId3', 'zipFileId4']) {
      const v = obj[k];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };
  // 注意：真实响应里 zipFileId1..4 挂在 subjects[] 的每一项上，不在 subjectFiles 条目本身
  const pageOf = (b) => {
    const candidates = [b].concat(b.subjects || []);
    for (const obj of candidates) {
      const z = pickZip(obj);
      if (z !== null && pageByZip.has(String(z))) return pageByZip.get(String(z));
    }
    for (const obj of candidates) {
      const z = pickZip(obj);
      if (z === null) continue;
      if (obj.zipFileId1) return 1;
      if (obj.zipFileId2) return 2;
      if (obj.zipFileId3) return 3;
      if (obj.zipFileId4) return 4;
    }
    return 1;
  };

  const dims = {};
  const blocks = [];
  for (const b of data.subjectFiles || []) {
    const pos = String(b.posInfo || '').split('-').map(Number);
    if (pos.length !== 4 || pos.some((n) => !isFinite(n))) continue;
    const [x, y, w, h] = pos;
    const page = pageOf(b);
    dims[page] = dims[page] || { w: 0, h: 0 };
    dims[page].w = Math.max(dims[page].w, x + w);
    dims[page].h = Math.max(dims[page].h, y + h);
    let full = 0;
    let got = 0;
    for (const s of b.subjects || []) {
      full += Number(s.scoreValue) || 0;
      got += Number(s.finallyScore) || 0;
    }
    blocks.push({ page, x, y, w, h, full, got, lost: Math.max(0, full - got) });
  }
  // 客观题按 saveFileUrl 归到块上
  const objByBlock = {};
  for (const o of data.objects || []) {
    const key = String(o.saveFileUrl || '');
    if (!key) continue;
    objByBlock[key] = objByBlock[key] || { full: 0, got: 0 };
    objByBlock[key].full += Number(o.scoreValue) || 0;
    objByBlock[key].got += Number(o.finallyScore) || 0;
  }
  // 客观题块没有 subjects，用 subjectFiles 里同 blockIndex 的块补坐标
  for (const b of data.subjectFiles || []) {
    const key = String(b.blockIndex || '');
    const agg = objByBlock[key];
    if (!agg || (b.subjects && b.subjects.length)) continue;
    const pos = String(b.posInfo || '').split('-').map(Number);
    if (pos.length !== 4) continue;
    const page = pageOf(b);
    const hit = blocks.find((x) => x.page === page && x.x === pos[0] && x.y === pos[1] && x.w === pos[2] && x.h === pos[3]);
    if (hit) {
      hit.full = agg.full;
      hit.got = agg.got;
      hit.lost = Math.max(0, agg.full - agg.got);
    }
  }
  let gw = 0;
  let gh = 0;
  for (const k of Object.keys(dims)) {
    gw = Math.max(gw, dims[k].w);
    gh = Math.max(gh, dims[k].h);
  }
  const marks = blocks
    .filter((b) => b.lost > 0.001)
    .map((b) => {
      // 优先用 OSS 给的真实像素尺寸（轮询时补进来），否则退回按块外扩推算
      const real = (overrides && overrides[b.page]) || null;
      const d = real
        ? { w: real.w, h: real.h }
        : { w: gw || (dims[b.page] || {}).w || 0, h: gh || (dims[b.page] || {}).h || 0 };
      return {
        page: b.page,
        left: d.w ? b.x / d.w : 0,
        top: d.h ? b.y / d.h : 0,
        width: d.w ? b.w / d.w : 0,
        height: d.h ? b.h / d.h : 0,
        lost: Math.round(b.lost * 10) / 10,
      };
    });
  const pageDims = {};
  for (const k of Object.keys(dims)) pageDims[k] = dims[k];
  return { pages, marks, pageDims, totalLost: Math.round(marks.reduce((a, m) => a + m.lost, 0) * 10) / 10 };
}

/** 给"原始字段"面板用：列出前 N 个条目的键名 */
function keyNames(items, limit = 3) {
  const keys = new Set();
  for (const it of (Array.isArray(items) ? items : []).slice(0, limit)) {
    if (it && typeof it === 'object') for (const k of Object.keys(it)) keys.add(k);
  }
  return [...keys];
}


// ---- auth.js ----
/**
 * 管理界面密码体系：
 *  - 口令只存在 Secrets（ADMIN_PASSWORD），代码与数据库里没有明文
 *  - 校验用 HMAC 后定长比较，避免明文比较的时序差
 *  - 会话 Cookie = base64url(payload) + '.' + base64url(HMAC)，密钥来自 SESSION_SECRET
 */

const encoder = new TextEncoder();
const COOKIE_NAME = 'hw_session';

function toB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(String(message)));
  return new Uint8Array(mac);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 口令校验：两边都先 HMAC，再定长比较 */
async function passwordMatches(input, expectedPassword, secret) {
  if (!expectedPassword || !secret) return false;
  const a = await hmacSha256(secret, 'password:' + String(input ?? ''));
  const b = await hmacSha256(secret, 'password:' + String(expectedPassword));
  return constantTimeEqual(a, b);
}

/** 生成会话令牌，payload 内含过期时间（epoch 秒） */
/**
 * @param {string} secret
 * @param {any} [arg] 传数字=有效期秒数；传 {accountId, username} = 绑定账号的会话
 * @param {number} [ttlSeconds]
 * @returns {Promise<string>}
 */
async function createSessionToken(secret, arg = 12 * 3600, ttlSeconds) {
  // 兼容两种调用：createSessionToken(secret, 3600) 或 createSessionToken(secret, {accountId, username}, 3600)
  let ttl = 12 * 3600;
  let extra = {};
  if (typeof arg === 'number') {
    ttl = arg;
  } else if (arg && typeof arg === 'object') {
    extra = { a: Number(arg.accountId) || 0, u: String(arg.username || '').slice(0, 40) };
    ttl = Number(ttlSeconds) || 12 * 3600;
  }
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttl, n: toB64url(crypto.getRandomValues(new Uint8Array(9))), ...extra });
  const body = toB64url(encoder.encode(payload));
  const sig = toB64url(await hmacSha256(secret, body));
  return body + '.' + sig;
}

/**
 * @param {string} secret
 * @param {string} token
 * @returns {Promise<{ok: boolean, reason?: string, exp?: number, accountId?: number, username?: string}>}
 */
async function verifySessionToken(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };
  const [body, sig] = token.split('.');
  const expected = toB64url(await hmacSha256(secret, body));
  let a; let b;
  try { a = encoder.encode(sig); b = encoder.encode(expected); } catch { return { ok: false, reason: 'malformed' }; }
  if (!constantTimeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return { ok: false, reason: 'bad_payload' }; }
  if (!payload || typeof payload.exp !== 'number') return { ok: false, reason: 'bad_payload' };
  if (payload.exp * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  // 第二阶段：会话必须绑定某个账号（旧格式 token 一律视为未登录）
  const accountId = Number(payload.a) || 0;
  if (!accountId) return { ok: false, reason: 'no_account' };
  return { ok: true, exp: payload.exp, accountId, username: String(payload.u || '') };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function sessionCookie(token, maxAgeSeconds = 12 * 3600) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAgeSeconds;
}

function clearSessionCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

/** 从请求里取出并校验会话；返回 {ok, exp, reason} */
async function requireSession(request, secret) {
  const cookies = parseCookies(request.headers.get('cookie'));
  return verifySessionToken(secret, cookies[COOKIE_NAME]);
}


// ---- hxxai.js ----
/**
 * 慧学星上游客户端。
 * 下面每个端点、每个参数名都来自实际抓取，不是猜的：
 *   POST /api/account/userLogin        —— 登录页 /assets/vue/login/index.js 的 loginSubmit()
 *   GET  /api/examReport/examList      —— 成绩单页 /assets/vue/report/index.js 的 getExamList()
 *   (未登录访问证明见 README 的"实测记录")
 * 请求编码为 application/x-www-form-urlencoded：站点用 jQuery $.ajax，默认序列化方式即此。
 */

class UpstreamError extends Error {
  constructor(kind, message, extra = {}) {
    super(message || kind);
    this.name = 'UpstreamError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 上游站点在国内，Cloudflare 边缘节点出境访问有时会慢；15s 容易踩线
const TIMEOUT_MS = 25000;

function originOf(env) {
  return String(env.UPSTREAM_ORIGIN || 'https://c.hxxai.com').replace(/\/+$/, '');
}

function baseHeaders(referer) {
  return {
    'user-agent': UA,
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer,
  };
}

function pathOf(url) {
  try { return new URL(String(url)).pathname; } catch { return String(url); }
}

/**
 * 上游请求统一入口。
 * 跨境访问偶发超时/连接重置，网络层错误自动重试一次（业务错误不重试）。
 */
async function call(fetchImpl, url, init) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    } catch (e) {
      last = e && e.message ? e.message : String(e);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
    }
  }
  throw new UpstreamError('network_error', '请求上游失败（已重试 1 次，超时 ' + Math.round(TIMEOUT_MS / 1000) + 's）: ' + last + ' ← ' + pathOf(url), { url });
}

function readSetCookie(res) {
  try {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  } catch { /* 老运行时降级 */ }
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/** 解析一条 Set-Cookie，返回 {name,value,domain,path,expires} */
function parseSetCookie(line) {
  const parts = String(line).split(';');
  const first = parts.shift() || '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  const out = { name, value, domain: null, path: '/', expires: null };
  for (const raw of parts) {
    const p = raw.trim();
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toLowerCase();
    const v = p.slice(i + 1).trim();
    if (k === 'domain') out.domain = v.replace(/^\./, '');
    else if (k === 'path') out.path = v || '/';
    else if (k === 'max-age') {
      const s = Number(v);
      if (Number.isFinite(s)) out.expires = s <= 0 ? 0 : Date.now() + s * 1000;
    } else if (k === 'expires') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) out.expires = out.expires === null ? t : out.expires;
    }
  }
  return out;
}

/** 把响应里的 Set-Cookie 合并进 jar（同 name+path 覆盖；Max-Age<=0 视为删除） */
function mergeCookieJar(jar, setCookieLines, nowMs = Date.now()) {
  const next = Array.isArray(jar) ? jar.slice() : [];
  for (const line of setCookieLines || []) {
    const c = parseSetCookie(line);
    if (!c) continue;
    const idx = next.findIndex((x) => x.name === c.name && (x.path || '/') === (c.path || '/'));
    if (c.expires === 0) {
      if (idx >= 0) next.splice(idx, 1);
      continue;
    }
    if (c.expires === null) c.expires = null;
    if (idx >= 0) next[idx] = { ...next[idx], ...c };
    else next.push(c);
  }
  return next.filter((c) => c.expires === null || c.expires > nowMs);
}

function cookieHeader(jar, nowMs = Date.now()) {
  if (!Array.isArray(jar) || jar.length === 0) return '';
  return jar
    .filter((c) => c && c.name && (c.expires === null || c.expires === undefined || c.expires > nowMs))
    .map((c) => c.name + '=' + c.value)
    .join('; ');
}

/**
 * 登录。返回 {jar, data, message}。
 * 失败抛 UpstreamError('login_failed' | 'parse_error' | 'network_error')。
 */
const cleanEnv = (v) => String(v === undefined || v === null ? '' : v).replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, '');

async function login(env, fetchImpl = fetch) {
  const origin = originOf(env);
  // 去掉首尾空白 / BOM：在 Cloudflare 里粘贴变量很容易带进换行，
  // 而「机密」类型的值添加后不可查看，导致登录一直失败却看不出原因。
  const username = cleanEnv(env.HXXAI_USERNAME);
  const password = cleanEnv(env.HXXAI_PASSWORD);
  if (!username || !password) {
    throw new UpstreamError('config_error', '缺少 HXXAI_USERNAME / HXXAI_PASSWORD');
  }
  let jar = [];

  // 1) 先访问登录页，取匿名 cookie（实测会下发 c_msid，域名 .hxxai.com）
  const seed = await call(fetchImpl, origin + '/', { method: 'GET', headers: { ...baseHeaders(origin + '/'), accept: 'text/html,*/*' } });
  jar = mergeCookieJar(jar, readSetCookie(seed));

  // 2) 提交登录表单
  const form = new URLSearchParams();
  form.set('userName', username);
  form.set('password', password);
  form.set('openid', '');
  form.set('loginType', String(env.LOGIN_TYPE ?? '0'));
  form.set('isLight', '0');

  const ck = cookieHeader(jar);
  const headers = {
    ...baseHeaders(origin + '/'),
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin,
    'x-requested-with': 'XMLHttpRequest',
    ...(ck ? { cookie: ck } : {}),
  };

  const res = await call(fetchImpl, origin + '/api/account/userLogin', { method: 'POST', headers, body: form.toString() });
  jar = mergeCookieJar(jar, readSetCookie(res));
  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError('parse_error', '登录返回非 JSON（HTTP ' + res.status + '）', { httpStatus: res.status, raw: text.slice(0, 400) });
  }
  if (String(json.code) !== '200') {
    throw new UpstreamError('login_failed', String(json.msg || ('登录失败 code=' + json.code)) + '（账号长度 ' + username.length + '，密码长度 ' + password.length + '；若明显不对，检查变量里有没有多余空格或换行）', { httpStatus: res.status, code: json.code, raw: text.slice(0, 400) });
  }
  return { jar, data: json.data, message: json.msg || 'ok', cookieCount: jar.length };
}

function d1Bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return Number(v);
}

/** 拉一页成绩单列表。返回 {list, totalPage, pageNumber, httpStatus} */
async function fetchExamList(env, jar, opts = {}, fetchImpl = fetch) {
  const origin = originOf(env);
  const pageNumber = opts.pageNumber || 1;
  const pageSize = opts.pageSize || d1Bool(env.POLL_PAGE_SIZE, 50);
  const url = new URL(origin + '/api/examReport/examList');
  url.searchParams.set('pageNumber', String(pageNumber));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('sysCourseId', String(env.SYS_COURSE_ID ?? '0'));
  url.searchParams.set('sysGradeId', String(env.SYS_GRADE_ID ?? '0'));
  url.searchParams.set('sysExamTypeId', String(env.SYS_EXAM_TYPE_ID ?? '0'));

  const ck = cookieHeader(jar);
  const headers = { ...baseHeaders(origin + '/report'), 'x-requested-with': 'XMLHttpRequest', ...(ck ? { cookie: ck } : {}) };

  const res = await call(fetchImpl, url.toString(), { method: 'GET', headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError('parse_error', '成绩列表返回非 JSON（HTTP ' + res.status + '）', { httpStatus: res.status, raw: text.slice(0, 400) });
  }
  const code = String(json.code);
  if (code === '401' || code === '403') {
    throw new UpstreamError('auth_expired', String(json.msg || '会话失效'), { httpStatus: res.status, code });
  }
  if (code !== '200') {
    throw new UpstreamError('upstream_error', String(json.msg || ('code=' + json.code)), { httpStatus: res.status, code, raw: text.slice(0, 400) });
  }
  const data = json.data || {};
  return {
    list: Array.isArray(data.list) ? data.list : [],
    totalPage: Number(data.totalPage || 1),
    pageNumber: Number(data.pageNumber || pageNumber),
    httpStatus: res.status,
  };
}

/**
 * 单场考试的明细（多科考试的各科分数）。
 * 端点来自成绩单页脚本 /assets/vue/report/index.js 的 goToURL()：
 *   getData("/api/examReport/examReportList", { examId }) -> { directForward, examReportList, customConfigId }
 * 注意：examReportList 里每个条目的字段名我没有实测过，交给 src/format.js 做候选键解析。
 */
async function fetchExamDetail(env, jar, opts, fetchImpl = fetch) {
  const { examId, customConfigId = 0 } = typeof opts === 'object' ? opts : { examId: opts };
  const origin = originOf(env);
  const url = new URL(origin + '/api/examReport/examReportList');
  url.searchParams.set('examId', String(examId));
  if (customConfigId) url.searchParams.set('customConfigId', String(customConfigId));
  const ck = cookieHeader(jar);
  const headers = { ...baseHeaders(origin + '/report'), 'x-requested-with': 'XMLHttpRequest', ...(ck ? { cookie: ck } : {}) };

  const res = await call(fetchImpl, url.toString(), { method: 'GET', headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError('parse_error', '明细返回非 JSON（HTTP ' + res.status + '）', { httpStatus: res.status, raw: text.slice(0, 400) });
  }
  const code = String(json.code);
  if (code === '401' || code === '403') throw new UpstreamError('auth_expired', String(json.msg || '会话失效'), { httpStatus: res.status, code });
  if (code !== '200') throw new UpstreamError('upstream_error', String(json.msg || ('code=' + json.code)), { httpStatus: res.status, code, raw: text.slice(0, 400) });
  const data = json.data || {};
  return {
    directForward: data.directForward === undefined ? null : data.directForward,
    customConfigId: data.customConfigId === undefined ? null : data.customConfigId,
    examReportList: data.examReportList || data.reportList || data.list || [],
    raw: data,
  };
}

/**
 * 多科报告页顶部的课程列表。端点来自 /assets/vue/report/alldetail.js 的 getExamCourseList()：
 *   getData("/api/examReport/examCourse", { customConfigId, examId })
 * 返回 data.courseList（含 sysCourseId / courseName / type / error）。
 */
async function fetchExamCourse(env, jar, opts, fetchImpl = fetch) {
  const origin = originOf(env);
  const url = new URL(origin + '/api/examReport/examCourse');
  url.searchParams.set('examId', String(opts.examId));
  url.searchParams.set('customConfigId', String(opts.customConfigId || 0));
  const ck = cookieHeader(jar);
  const headers = { ...baseHeaders(origin + '/report'), 'x-requested-with': 'XMLHttpRequest', ...(ck ? { cookie: ck } : {}) };

  const res = await call(fetchImpl, url.toString(), { method: 'GET', headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError('parse_error', 'examCourse 返回非 JSON（HTTP ' + res.status + '）', { httpStatus: res.status, raw: text.slice(0, 300) });
  }
  const code = String(json.code);
  if (code === '401' || code === '403') throw new UpstreamError('auth_expired', String(json.msg || '会话失效'), { httpStatus: res.status, code });
  if (code !== '200') throw new UpstreamError('upstream_error', String(json.msg || ('code=' + json.code)), { httpStatus: res.status, code, raw: text.slice(0, 300) });
  return { courseList: (json.data && json.data.courseList) || [], examTypeId: json.data && json.data.examTypeId, raw: json.data };
}

/**
 * 抓 /report/alldetail 这一屏（服务端渲染的多科明细页）。
 * URL 形态由用户实测给出：/report/alldetail?examId=&examTypeId=&sysCourseId=&customConfigId=
 */
async function fetchReportHtml(env, jar, opts, fetchImpl = fetch) {
  const origin = originOf(env);
  const url = new URL(origin + '/report/alldetail');
  url.searchParams.set('examId', String(opts.examId));
  url.searchParams.set('examTypeId', String(opts.examTypeId || 0));
  url.searchParams.set('sysCourseId', String(opts.sysCourseId || 0));
  url.searchParams.set('customConfigId', String(opts.customConfigId || 0));
  const ck = cookieHeader(jar);
  const headers = { ...baseHeaders(origin + '/report'), accept: 'text/html,*/*', ...(ck ? { cookie: ck } : {}) };

  const res = await call(fetchImpl, url.toString(), { method: 'GET', headers });
  const text = await res.text();
  const title = (text.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  if (title.startsWith('401')) throw new UpstreamError('auth_expired', '报告页返回 401（会话失效）', { httpStatus: res.status });
  return { status: res.status, title, html: text };
}

/**
 * 答题卡页（成绩查询模块）：/scoreSearch/report?examId=<examId>
 * 页面里会内嵌扫描件地址（实测形如 https://oss.hxxai.com/srcImgOK/<examId>/…/srcImgOK.png）。
 */
async function fetchAnswerSheetHtml(env, jar, examId, fetchImpl = fetch) {
  const origin = originOf(env);
  const url = new URL(origin + '/scoreSearch/report');
  url.searchParams.set('examId', String(examId));
  const ck = cookieHeader(jar);
  const headers = ck
    ? { ...baseHeaders(origin + '/report'), accept: 'text/html,*/*', cookie: ck }
    : { ...baseHeaders(origin + '/report'), accept: 'text/html,*/*' };
  const res = await call(fetchImpl, url.toString(), { method: 'GET', headers });
  const text = await res.text();
  const title = (text.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  if (title.startsWith('401')) throw new UpstreamError('auth_expired', '答题卡页返回 401', { httpStatus: res.status });
  return { status: res.status, title, html: text };
}

/** 成绩查询模块的 GET 接口（返回 {code,msg,data}） */
async function gradeQueryGet(env, jar, pathName, params, fetchImpl) {
  const origin = originOf(env);
  const url = new URL(origin + pathName);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  const ck = cookieHeader(jar);
  const headers = ck
    ? { ...baseHeaders(origin + '/report'), 'x-requested-with': 'XMLHttpRequest', cookie: ck }
    : { ...baseHeaders(origin + '/report'), 'x-requested-with': 'XMLHttpRequest' };
  const res = await call(fetchImpl, url.toString(), { method: 'GET', headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new UpstreamError('parse_error', pathName + ' 非 JSON', { httpStatus: res.status, raw: text.slice(0, 200) }); }
  const code = String(json.code);
  if (code === '401' || code === '403') throw new UpstreamError('auth_expired', String(json.msg || '会话失效'), { code });
  if (code !== '200') throw new UpstreamError('upstream_error', String(json.msg || ('code=' + json.code)), { code });
  return json.data;
}

/**
 * 答题卡（原卷）数据。页面脚本 /assets/vue/scoreSearch/report.js 的真实取数链路：
 *   GET /api/gradeQuery/examReportList?examId=          -> 每科的 customConfigId
 *   GET /api/gradeQuery/baseInfo?examId=&customConfigId= -> 页面数据（原卷图在里面）
 * 图片地址不写死字段，交给 collectImageUrls 深度挖掘。
 */
async function fetchAnswerSheetData(env, jar, examId, fetchImpl = fetch) {
  const list = await gradeQueryGet(env, jar, '/api/gradeQuery/examReportList', { examId }, fetchImpl);
  const reports = (list && list.examReportList) || [];
  const payloads = [];
  const configIds = reports.length ? reports.map((r) => (r.customConfigId === undefined ? 0 : r.customConfigId)) : [0];
  for (const cid of configIds.slice(0, 4)) {
    try {
      payloads.push(await gradeQueryGet(env, jar, '/api/gradeQuery/baseInfo', { examId, customConfigId: cid }, fetchImpl));
    } catch (e) {
      if (e && e.kind === 'auth_expired') throw e;
    }
  }
  // 原卷元信息：真实响应里 examCourseList 带 examPaperId / original / originalState
  // 注意：不能只挑 original=1 的科 —— 实测有些考试该字段是 2 或字符串，
  // 一旦过滤掉就整场拿不到分组，图会全部堆进「无科目」那一块。
  const papers = [];
  const seenCourse = new Set();
  for (const p of payloads) {
    for (const c of (p && p.examCourseList) || []) {
      if (!c || c.sysCourseId === undefined || c.sysCourseId === null) continue;
      const key = String(c.sysCourseId);
      if (seenCourse.has(key)) continue;
      seenCourse.add(key);
      papers.push({
        examPaperId: c.examPaperId,
        courseName: c.courseName || '',
        sysCourseId: c.sysCourseId,
        hasOriginal: Number(c.original) === 1 || Number(c.original) === 3,
      });
    }
  }
  return { reports, payloads, papers };
}

/**
 * 原卷（答题卡）：POST /api/examReport/originalVolume  { examId, sysCourseId }
 * 依据：站点自己的 /assets/vue/report/paper.js 里写死的
 *   postData(ctx + '/api/examReport/originalVolume', { examId, sysCourseId }, ...)
 * 注意是 **POST**（表单），我之前用 GET /api/gradeQuery/originalVolume 探 404 就是这个原因。
 */
async function fetchOriginalVolume(env, jar, examId, sysCourseId, fetchImpl = fetch) {
  const origin = originOf(env);
  const ck = cookieHeader(jar);
  const headers = {
    ...baseHeaders(origin + '/report/paper'),
    // 与站点 jQuery $.ajax 默认一致：表单编码 + 同源 + XHR 标记，缺一个都可能被上游判为非法请求
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin,
    'x-requested-with': 'XMLHttpRequest',
    ...(ck ? { cookie: ck } : {}),
  };
  const body = new URLSearchParams({ examId: String(examId), sysCourseId: String(sysCourseId) }).toString();
  const res = await call(fetchImpl, origin + '/api/examReport/originalVolume', { method: 'POST', headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new UpstreamError('parse_error', 'originalVolume 非 JSON', { httpStatus: res.status }); }
  const code = String(json.code);
  if (code === '401' || code === '403') throw new UpstreamError('auth_expired', String(json.msg || '会话失效'), { code });
  if (code !== '200') throw new UpstreamError('upstream_error', String(json.msg || ('code=' + json.code)), { code });
  return json.data;
}

/**
 * 取扫描件的真实像素尺寸：OSS 的 image/info 接口（站点本来就在用 x-oss-process 裁剪）。
 * posInfo 的坐标就是这套像素空间，有了真实宽高，红框百分比才可能分毫不差。
 */
async function fetchImageInfo(env, imageUrl, fetchImpl = fetch) {
  const sep = imageUrl.indexOf('?') >= 0 ? '&' : '?';
  const url = imageUrl + sep + 'x-oss-process=image/info';
  const res = await call(fetchImpl, url, {
    method: 'GET',
    headers: { 'user-agent': UA, referer: originOf(env) + '/', accept: 'application/json,*/*' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const num = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'object' && v.value !== undefined) return Number(v.value) || 0;
    return Number(v) || 0;
  };
  const w = num(j.ImageWidth);
  const h = num(j.ImageHeight);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** 代理取图（答题卡扫描件在 OSS 上，带对 Referer 才稳） */
async function fetchUpstreamImage(env, targetUrl, fetchImpl = fetch) {
  const res = await call(fetchImpl, targetUrl, {
    method: 'GET',
    headers: { 'user-agent': UA, referer: originOf(env) + '/', accept: 'image/avif,image/webp,image/*,*/*' },
  });
  return res;
}

/** 探测 /report 页面本身（未登录返回 401 HTML，已登录返回真实页面）——给"诊断"用 */
async function probeReportPage(env, jar, fetchImpl = fetch) {
  const origin = originOf(env);
  const ck = cookieHeader(jar);
  const headers = { ...baseHeaders(origin + '/report'), accept: 'text/html,*/*', ...(ck ? { cookie: ck } : {}) };
  const res = await call(fetchImpl, origin + '/report', { method: 'GET', headers });
  const text = await res.text();
  const title = (text.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  return { status: res.status, title, length: text.length, sample: text.slice(0, 600) };
}


// ---- schema.js ----
/**
 * 内嵌的建库脚本 + 自动补列（由 _build/embed-schema.mjs 从 install.sql 生成，勿手改）。
 *
 * 目的：让"只粘贴 worker.js"也能跑起来 ——
 *   1. 首次请求时把 install.sql 里的 CREATE TABLE IF NOT EXISTS 全部执行一遍（已存在则跳过）
 *   2. 检查三处后期新增的列，缺了就用 ALTER 补上（SQLite 没有 ADD COLUMN IF NOT EXISTS）
 * 因此：全新库、只跑过老版 schema 的库、跑过部分迁移的库，三种都能自动修好。
 */

const SCHEMA_SQL = "-- ============================================================================\n-- 慧学星成绩单监控 · 一键建库脚本（install.sql）\n--\n-- 用法：D1 控制台 → 粘贴本文件全文 → 点 Run 右边小箭头 ▾ →「Run all in sequence」\n--\n--   · 全新数据库：跑这一份就够了（等价于原来的 schema.sql + migrate-003~007）\n--   · 已经部署过旧版：**不要**跑这个文件（表已存在，CREATE 会跳过、但缺的新列加不上），\n--     请按顺序跑 migrations/ 里的升级脚本\n--   · 本文件全部是 CREATE TABLE IF NOT EXISTS，重复执行不会报错、不会丢数据\n-- ============================================================================\n\n-- 慧学星成绩单监控 —— D1 (SQLite) 表结构\n-- 应用方式：wrangler d1 execute hxxai_report_watch --remote --file=./schema.sql\n\n-- 上游登录态（cookie jar）。只有一行，id 恒为 1。\nCREATE TABLE IF NOT EXISTS session (\n  id             INTEGER PRIMARY KEY CHECK (id = 1),\n  cookies        TEXT    NOT NULL,          -- JSON: [{name,value,domain,path,expires}]\n  updated_at     TEXT    NOT NULL,          -- ISO8601 UTC\n  login_ok       INTEGER NOT NULL DEFAULT 0,\n  login_msg      TEXT\n);\n\n-- 每份成绩单的最近一次已知状态（变更判定的基准）\nCREATE TABLE IF NOT EXISTS exam_snapshot (\n  exam_key       TEXT    PRIMARY KEY,       -- 上游 examId 的字符串形式\n  exam_id        TEXT    NOT NULL,\n  exam_type_id   TEXT,\n  subject_name   TEXT,\n  score_text     TEXT,                      -- 原样保留（'88' / '88.5' / NULL）\n  score_num      REAL,                      -- 归一化数值，用于比较\n  raw_json       TEXT    NOT NULL,          -- 上游原始条目，字段以后再变也不丢信息\n  first_seen_at  TEXT    NOT NULL,\n  last_seen_at   TEXT    NOT NULL,\n  last_change_at TEXT\n);\n\nCREATE INDEX IF NOT EXISTS idx_snapshot_last_seen ON exam_snapshot (last_seen_at DESC);\n\n-- 成绩发布行为事件（唯一需要长期保留的\"记录\"）\nCREATE TABLE IF NOT EXISTS events (\n  id           INTEGER PRIMARY KEY AUTOINCREMENT,\n  kind         TEXT    NOT NULL,            -- new_report | score_change | score_filled | score_cleared\n  exam_key     TEXT    NOT NULL,\n  exam_id      TEXT    NOT NULL,\n  exam_type_id TEXT,\n  subject_name TEXT,\n  old_score    TEXT,\n  new_score    TEXT,\n  delta        REAL,\n  detected_at  TEXT    NOT NULL,            -- ISO8601 UTC，落盘用 UTC\n  raw_json     TEXT    NOT NULL,\n  account_id   INTEGER NOT NULL DEFAULT 0    -- 第二阶段：数据归属账号\n);\n\nCREATE INDEX IF NOT EXISTS idx_events_detected ON events (detected_at DESC);\nCREATE INDEX IF NOT EXISTS idx_events_exam ON events (exam_key, detected_at DESC);\n\n-- 每次轮询的运行记录（可观测性：判断\"到底有没有在跑\"）\nCREATE TABLE IF NOT EXISTS poll_runs (\n  id             INTEGER PRIMARY KEY AUTOINCREMENT,\n  started_at     TEXT    NOT NULL,\n  finished_at    TEXT,\n  status         TEXT    NOT NULL,          -- ok | changed | baseline | auth_failed | upstream_error | parse_error | internal_error\n  http_status    INTEGER,\n  exams_seen     INTEGER NOT NULL DEFAULT 0,\n  events_created INTEGER NOT NULL DEFAULT 0,\n  relogin        INTEGER NOT NULL DEFAULT 0,\n  duration_ms    INTEGER,\n  message        TEXT,\n  account_id     INTEGER NOT NULL DEFAULT 0   -- 第二阶段：数据归属账号\n);\n\nCREATE INDEX IF NOT EXISTS idx_runs_started ON poll_runs (started_at DESC);\n\n-- 管理端登录失败限流（按 IP）\nCREATE TABLE IF NOT EXISTS login_attempts (\n  ip           TEXT    PRIMARY KEY,\n  count        INTEGER NOT NULL,\n  window_start TEXT    NOT NULL,\n  blocked_until TEXT\n);\n\n-- 多科考试的次级科目分数（每轮轮询一并抓取，不需要打开界面才去取）\nCREATE TABLE IF NOT EXISTS exam_subject (\n  exam_key   TEXT NOT NULL,\n  subject    TEXT NOT NULL,\n  score      TEXT,\n  full       REAL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (exam_key, subject)\n);\n\nCREATE INDEX IF NOT EXISTS idx_subject_exam ON exam_subject (exam_key);\n\n-- 试卷信息（每轮轮询一并抓取，界面不现取）\nCREATE TABLE IF NOT EXISTS exam_meta (\n  exam_key   TEXT PRIMARY KEY,\n  payload    TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\n\n-- 答题卡/试卷扫描件（轮询时从答题卡页解析图片地址，图片本身按需经 Worker 代理取）\nCREATE TABLE IF NOT EXISTS exam_image (\n  exam_key   TEXT NOT NULL,\n  subject    TEXT NOT NULL DEFAULT '',\n  url        TEXT NOT NULL,\n  idx        INTEGER NOT NULL DEFAULT 0,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (exam_key, url)\n);\n\n-- ---------------------------------------------------------------------------\n-- 多账号（原 migrate-007-accounts.sql 并入）\n-- ---------------------------------------------------------------------------\n\nCREATE TABLE IF NOT EXISTS account (\n  id            INTEGER PRIMARY KEY AUTOINCREMENT,\n  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- 登录名（大小写不敏感）\n  pwd_salt      TEXT    NOT NULL,                        -- base64url 随机盐\n  pwd_hash      TEXT    NOT NULL,                        -- base64url PBKDF2-SHA256（10 万次）\n  pwd_iter      INTEGER NOT NULL DEFAULT 100000,         -- Workers 的 PBKDF2 上限就是 100000\n  upstream_user TEXT,                                    -- 该账号自己的慧学星账号（手机号）\n  upstream_seal TEXT,                                    -- 慧学星密码：AES-GCM 封存\n  created_at    TEXT    NOT NULL,\n  updated_at    TEXT    NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS account_session (\n  account_id INTEGER PRIMARY KEY,\n  cookies    TEXT    NOT NULL,\n  updated_at TEXT    NOT NULL,\n  login_ok   INTEGER NOT NULL DEFAULT 0,\n  login_msg  TEXT\n);\n\nCREATE TABLE IF NOT EXISTS app_meta (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n";

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
async function ensureSchema(db) {
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


// ---- scope.js ----
/**
 * 按账号隔离的数据访问层（第二阶段）。
 *
 * 做法：在不动既有表结构的前提下，把 exam_key 统一加 "a<账号>|" 前缀。
 * 这样 exam_snapshot / exam_subject / exam_meta / exam_image 的主键与索引原样可用，
 * 不同账号即使上游 examId 相同也不会互相覆盖；events / poll_runs 用 account_id 过滤。
 *
 * 用法：const st = scopedStore(env.DB, accountId); 之后签名与 store.js 相同但不再传 db。
 */

function keyPrefix(accountId) {
  return 'a' + (Number(accountId) || 0) + '|';
}

function scopedStore(db, accountId) {
  const acc = Number(accountId) || 0;
  const pre = keyPrefix(acc);
  const like = pre + '%';
  const K = (k) => pre + String(k);
  const unK = (k) => {
    const s = String(k || '');
    return s.startsWith(pre) ? s.slice(pre.length) : null;
  };

  return {
    accountId: acc,
    key: K,

    // —— 上游登录态：按账号一行 ——
    async getSession() {
      const row = await db.prepare('SELECT cookies, updated_at, login_ok, login_msg FROM account_session WHERE account_id = ?').bind(acc).first();
      if (!row) return null;
      let jar = [];
      try { jar = JSON.parse(row.cookies); } catch { jar = []; }
      return { jar, updatedAt: row.updated_at, loginOk: !!row.login_ok, loginMsg: row.login_msg };
    },

    async saveSession(jar, loginOk, loginMsg, nowIso) {
      await db.prepare(
        'INSERT INTO account_session (account_id, cookies, updated_at, login_ok, login_msg) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(account_id) DO UPDATE SET cookies = excluded.cookies, updated_at = excluded.updated_at, login_ok = excluded.login_ok, login_msg = excluded.login_msg'
      ).bind(acc, JSON.stringify(jar || []), nowIso, loginOk ? 1 : 0, loginMsg === undefined ? null : String(loginMsg)).run();
    },

    // —— 快照 ——
    async countSnapshots() {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM exam_snapshot WHERE exam_key LIKE ?').bind(like).first();
      return row ? Number(row.n || 0) : 0;
    },

    async loadSnapshotMap() {
      const rows = await db.prepare('SELECT exam_key, exam_id, exam_type_id, subject_name, score_text, score_num, first_seen_at, last_seen_at, last_change_at FROM exam_snapshot WHERE exam_key LIKE ?').bind(like).all();
      const map = new Map();
      for (const r of (rows && rows.results) || []) {
        const k = unK(r.exam_key);
        if (k) map.set(k, { ...r, exam_key: k });
      }
      return map;
    },

    async listSnapshots(limit = 500) {
      const rows = await db.prepare('SELECT * FROM exam_snapshot WHERE exam_key LIKE ? ORDER BY last_seen_at DESC LIMIT ?').bind(like, Number(limit) || 500).all();
      return ((rows && rows.results) || []).map((r) => ({ ...r, exam_key: unK(r.exam_key) || r.exam_key }));
    },

    async upsertSnapshot(item, nowIso, changed) {
      await db.prepare(
        'INSERT INTO exam_snapshot (exam_key, exam_id, exam_type_id, subject_name, score_text, score_num, raw_json, first_seen_at, last_seen_at, last_change_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(exam_key) DO UPDATE SET exam_type_id = excluded.exam_type_id, subject_name = excluded.subject_name, ' +
        'score_text = excluded.score_text, score_num = excluded.score_num, raw_json = excluded.raw_json, ' +
        'last_seen_at = excluded.last_seen_at, last_change_at = excluded.last_change_at'
      ).bind(K(item.examKey), item.examId, item.examTypeId, item.subjectName, item.scoreText, item.scoreNum, item.rawJson, nowIso, nowIso, changed ? nowIso : null).run();
    },

    // —— 事件 / 巡检记录：带 account_id ——
    async insertEvent(ev, nowIso) {
      await db.prepare(
        'INSERT INTO events (kind, exam_key, exam_id, exam_type_id, subject_name, old_score, new_score, delta, detected_at, raw_json, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(ev.kind, K(ev.examKey), ev.examId, ev.examTypeId ?? null, ev.subjectName ?? null, ev.oldScore ?? null, ev.newScore ?? null, ev.delta ?? null, nowIso, ev.rawJson, acc).run();
    },

    async listEvents(limit = 50) {
      const rows = await db.prepare('SELECT * FROM events WHERE account_id = ? ORDER BY detected_at DESC, id DESC LIMIT ?').bind(acc, Number(limit) || 50).all();
      return ((rows && rows.results) || []).map((r) => ({ ...r, exam_key: unK(r.exam_key) || r.exam_key }));
    },

    async insertRun(run) {
      const r = await db.prepare(
        'INSERT INTO poll_runs (started_at, finished_at, status, http_status, exams_seen, events_created, relogin, duration_ms, message, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(run.startedAt, run.finishedAt ?? null, run.status, run.httpStatus ?? null, run.examsSeen ?? 0, run.eventsCreated ?? 0, run.relogin ?? 0, run.durationMs ?? null, run.message ?? null, acc).run();
      return r;
    },

    async listRuns(limit = 20) {
      const rows = await db.prepare('SELECT * FROM poll_runs WHERE account_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').bind(acc, Number(limit) || 20).all();
      return (rows && rows.results) || [];
    },

    async pruneRuns(keep = 200) {
      await db.prepare('DELETE FROM poll_runs WHERE account_id = ? AND id NOT IN (SELECT id FROM poll_runs WHERE account_id = ? ORDER BY id DESC LIMIT ?)').bind(acc, acc, Number(keep) || 200).run();
    },

    // —— 多科分数 / 试卷信息 / 图片 ——
    async syncSubjects(examKey, rows, nowIso) {
      const k = K(examKey);
      await db.prepare('DELETE FROM exam_subject WHERE exam_key = ?').bind(k).run();
      for (const r of rows || []) {
        await db.prepare('INSERT INTO exam_subject (exam_key, subject, score, full, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(exam_key, subject) DO UPDATE SET score = excluded.score, full = excluded.full, updated_at = excluded.updated_at')
          .bind(k, r.subject, r.score ?? null, r.full ?? null, nowIso).run();
      }
      return (rows || []).length;
    },

    async loadAllSubjects() {
      const rows = await db.prepare('SELECT exam_key, subject, score, full FROM exam_subject WHERE exam_key LIKE ?').bind(like).all();
      const map = new Map();
      for (const r of (rows && rows.results) || []) {
        const k = unK(r.exam_key);
        if (!k) continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ subject: r.subject, score: r.score, full: r.full });
      }
      return map;
    },

    async saveExamMeta(examKey, payload, nowIso) {
      await db.prepare('INSERT INTO exam_meta (exam_key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(exam_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
        .bind(K(examKey), JSON.stringify(payload), nowIso).run();
    },

    async loadAllExamMeta() {
      const rows = await db.prepare('SELECT exam_key, payload FROM exam_meta WHERE exam_key LIKE ?').bind(like).all();
      const map = new Map();
      for (const r of (rows && rows.results) || []) {
        const k = unK(r.exam_key);
        if (!k) continue;
        let info = null;
        try { info = JSON.parse(r.payload); } catch { info = null; }
        map.set(k, { info });
      }
      return map;
    },

    async saveExamImages(examKey, groups, nowIso) {
      const k = K(examKey);
      await db.prepare('DELETE FROM exam_image WHERE exam_key = ?').bind(k).run();
      let n = 0;
      for (const g of groups || []) {
        let i = 0;
        for (const url of g.urls || []) {
          await db.prepare('INSERT INTO exam_image (exam_key, subject, url, idx, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(exam_key, url) DO UPDATE SET subject = excluded.subject, idx = excluded.idx, updated_at = excluded.updated_at')
            .bind(k, g.subject || '', url, i, nowIso).run();
          i += 1; n += 1;
        }
      }
      return n;
    },

    async loadAllExamImages() {
      const rows = await db.prepare('SELECT exam_key, subject, url, idx FROM exam_image WHERE exam_key LIKE ? ORDER BY exam_key, idx').bind(like).all();
      const map = new Map();
      for (const r of (rows && rows.results) || []) {
        const k = unK(r.exam_key);
        if (!k) continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ subject: r.subject, url: r.url });
      }
      return map;
    },
  };
}


// ---- pages.js ----
/** 注册页 / 账号设置页（独立页面，路由在 index.js） */

const REGISTER_HTML = "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>注册账号 · 慧学星成绩单监控</title>\n<style>\n:root{--bg:#0b0d10;--panel:#11151a;--line:#232a33;--text:#e6edf3;--dim:#8b949e;--accent:#2f81f7;--warn:#f0883e;--bad:#f85149;--ok:#3fb950}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font:14px/1.7 -apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}\n.card{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:26px 24px}\nh1{font-size:18px;margin:0 0 4px}\np.sub{margin:0 0 18px;color:var(--dim);font-size:13px}\nlabel{display:block;margin:14px 0 6px;font-size:13px;color:var(--dim)}\ninput{width:100%;padding:10px 12px;background:#0d1117;border:1px solid var(--line);border-radius:3px;color:var(--text);font-size:14px;outline:none}\ninput:focus{border-color:var(--accent)}\nbutton{margin-top:20px;width:100%;padding:11px;background:var(--accent);border:0;border-radius:3px;color:#fff;font-size:14px;cursor:pointer}\nbutton:hover{filter:brightness(1.1)}\nbutton.ghost{background:transparent;border:1px solid var(--line);color:var(--dim)}\nbutton.danger{background:transparent;border:1px solid var(--bad);color:var(--bad)}\n.tip{margin:18px 0 0;padding:12px;border:1px solid var(--warn);border-left-width:3px;border-radius:3px;background:rgba(240,136,62,.08);color:#ffd7b5;font-size:13px}\n.msg{margin-top:14px;font-size:13px;min-height:20px}\n.msg.ok{color:var(--ok)} .msg.bad{color:var(--bad)}\n.links{margin-top:16px;display:flex;justify-content:space-between;font-size:13px}\na{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}\n.hr{height:1px;background:var(--line);margin:22px 0}\n.badge{display:inline-block;padding:1px 6px;border:1px solid var(--line);border-radius:2px;color:var(--dim);font-size:12px}\n</style></head><body><div class=\"card\">\n<h1>注册账号</h1>\n<p class=\"sub\">一个账号对应一个慧学星账号，彼此数据完全隔离。</p>\n<form id=\"f\">\n  <label>登录账号名（3–24 位，字母/数字/_/-）</label>\n  <input id=\"u\" autocomplete=\"username\" placeholder=\"例如 kevin\">\n  <label>登录密码（至少 8 位，不能是纯数字）</label>\n  <input id=\"p\" type=\"password\" autocomplete=\"new-password\" placeholder=\"至少 8 位\">\n  <label>再输一次密码</label>\n  <input id=\"p2\" type=\"password\" autocomplete=\"new-password\">\n  <label>你的慧学星账号（11 位手机号）</label>\n  <input id=\"xu\" type=\"tel\" inputmode=\"numeric\" maxlength=\"11\" autocomplete=\"off\" placeholder=\"11 位手机号，用于抓取你自己的成绩单\">\n  <label>你的慧学星密码</label>\n  <input id=\"xp\" type=\"password\" autocomplete=\"new-password\" placeholder=\"会加密保存，仅用于登录上游\">\n  <p class=\"tip\">本网站登录系统较为简易，无找回方案，请牢记密码。</p>\n  <button type=\"submit\">注册</button>\n  <div class=\"msg\" id=\"m\"></div>\n</form>\n<div class=\"links\"><a href=\"/admin\">← 返回登录</a><span class=\"badge\">无找回密码</span></div>\n<script>\nconst $=function(id){return document.getElementById(id)};\nfunction msg(t,ok){const m=$('m');m.textContent=t||'';m.className='msg '+(ok?'ok':'bad')}\n$('f').addEventListener('submit',async function(e){\n  e.preventDefault();\n  if($('p').value!==$('p2').value){msg('两次输入的密码不一致');return}\n  var phone=String($('xu').value||'').replace(/\\s|-/g,'');\n  if(!/^1[3-9]\\d{9}$/.test(phone)){msg('慧学星账号要填 11 位手机号（1 开头），现在填的是「'+phone+'」');return}\n  msg('正在提交…',true);\n  try{\n    const r=await fetch('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({\n      username:$('u').value,password:$('p').value,upstreamUser:$('xu').value,upstreamSecret:$('xp').value\n    })});\n    const j=await r.json().catch(function(){return {}});\n    if(r.ok&&j.ok){msg('注册成功，正在跳转登录…',true);location.href='/admin'}\n    else msg(j.message||'注册失败');\n  }catch(err){msg('网络错误：'+err.message)}\n});\n</script></div></body></html>";

const ACCOUNT_HTML = "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>账号设置 · 慧学星成绩单监控</title>\n<style>\n:root{--bg:#0b0d10;--panel:#11151a;--line:#232a33;--text:#e6edf3;--dim:#8b949e;--accent:#2f81f7;--warn:#f0883e;--bad:#f85149;--ok:#3fb950}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font:14px/1.7 -apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}\n.card{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:26px 24px}\nh1{font-size:18px;margin:0 0 4px}\np.sub{margin:0 0 18px;color:var(--dim);font-size:13px}\nlabel{display:block;margin:14px 0 6px;font-size:13px;color:var(--dim)}\ninput{width:100%;padding:10px 12px;background:#0d1117;border:1px solid var(--line);border-radius:3px;color:var(--text);font-size:14px;outline:none}\ninput:focus{border-color:var(--accent)}\nbutton{margin-top:20px;width:100%;padding:11px;background:var(--accent);border:0;border-radius:3px;color:#fff;font-size:14px;cursor:pointer}\nbutton:hover{filter:brightness(1.1)}\nbutton.ghost{background:transparent;border:1px solid var(--line);color:var(--dim)}\nbutton.danger{background:transparent;border:1px solid var(--bad);color:var(--bad)}\n.tip{margin:18px 0 0;padding:12px;border:1px solid var(--warn);border-left-width:3px;border-radius:3px;background:rgba(240,136,62,.08);color:#ffd7b5;font-size:13px}\n.msg{margin-top:14px;font-size:13px;min-height:20px}\n.msg.ok{color:var(--ok)} .msg.bad{color:var(--bad)}\n.links{margin-top:16px;display:flex;justify-content:space-between;font-size:13px}\na{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}\n.hr{height:1px;background:var(--line);margin:22px 0}\n.badge{display:inline-block;padding:1px 6px;border:1px solid var(--line);border-radius:2px;color:var(--dim);font-size:12px}\n</style></head><body><div class=\"card\">\n<h1>账号设置</h1>\n<p class=\"sub\">当前账号：<b id=\"who\">—</b>　登录系统简易、无找回方案，请自行记牢密码。</p>\n<div class=\"hr\"></div>\n<h1 style=\"font-size:15px\">修改登录密码</h1>\n<form id=\"fp\">\n  <label>新密码（至少 8 位，不能是纯数字）</label>\n  <input id=\"np\" type=\"password\" autocomplete=\"new-password\">\n  <label>再输一次</label>\n  <input id=\"np2\" type=\"password\" autocomplete=\"new-password\">\n  <button type=\"submit\">保存新密码</button>\n  <div class=\"msg\" id=\"mp\"></div>\n</form>\n<div class=\"hr\"></div>\n<h1 style=\"font-size:15px\">修改绑定的慧学星账号</h1>\n<form id=\"fu\">\n  <label>慧学星账号（手机号）</label>\n  <input id=\"xu\" type=\"tel\" inputmode=\"numeric\" maxlength=\"11\" autocomplete=\"off\" placeholder=\"11 位手机号\">\n  <label>慧学星密码（留空表示不修改）</label>\n  <input id=\"xp\" type=\"password\" autocomplete=\"new-password\">\n  <button type=\"submit\">保存上游凭据</button>\n  <div class=\"msg\" id=\"mu\"></div>\n</form>\n<div class=\"hr\"></div>\n<h1 style=\"font-size:15px\" id=\"delete\">退出 / 注销</h1>\n<button class=\"ghost\" id=\"out\" type=\"button\">退出登录</button>\n<div style=\"height:10px\"></div>\n<button class=\"danger\" id=\"del\" type=\"button\">注销本账号（数据一并删除，不可恢复）</button>\n<div class=\"msg\" id=\"md\"></div>\n<script>\nconst $=function(id){return document.getElementById(id)};\nfunction msg(id,t,ok){const m=$(id);m.textContent=t||'';m.className='msg '+(ok?'ok':'bad')}\nasync function api(path,body){\n  const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});\n  const j=await r.json().catch(function(){return {}});\n  if(r.status===401){location.href='/admin'}\n  return {ok:r.ok&&j.ok,status:r.status,message:j.message||''};\n}\nfetch('/admin/api/me').then(function(r){return r.json()}).then(function(j){if(j&&j.ok)$('who').textContent=j.username}).catch(function(){});\n$('fp').addEventListener('submit',async function(e){\n  e.preventDefault();\n  if($('np').value!==$('np2').value){msg('mp','两次输入的密码不一致');return}\n  const r=await api('/admin/api/account/password',{password:$('np').value});\n  msg('mp',r.ok?'密码已修改':(r.message||'修改失败'),r.ok);\n  if(r.ok){$('np').value='';$('np2').value=''}\n});\n$('fu').addEventListener('submit',async function(e){\n  e.preventDefault();\n  var phone=String($('xu').value||'').replace(/\\s|-/g,'');\n  if(!/^1[3-9]\\d{9}$/.test(phone)){msg('mu','慧学星账号要填 11 位手机号（1 开头）');return}\n  const r=await api('/admin/api/account/upstream',{upstreamUser:phone,upstreamSecret:$('xp').value});\n  msg('mu',r.ok?'已保存，下次巡检生效':(r.message||'保存失败'),r.ok);\n  if(r.ok)$('xp').value=''\n});\n$('out').addEventListener('click',async function(){\n  await fetch('/admin/api/logout',{method:'POST'});location.href='/admin';\n});\n$('del').addEventListener('click',async function(){\n  if(!confirm('确认注销？本账号的所有成绩数据会一并删除，且无法恢复。'))return;\n  const r=await api('/admin/api/account/delete',{confirm:'DELETE'});\n  if(r.ok){location.href='/admin'}else msg('md',r.message||'注销失败');\n});\n</script></div></body></html>";


// ---- notice.js ----
/**
 * 首次访问强制阅读的使用声明。
 * 由服务端注入到 /admin、/register、/account 三个页面的 </body> 之前。
 * 点「我已阅读并同意」后写入 localStorage，之后不再显示。
 */
const NOTICE_KEY = 'hxxai_notice_v1';

const NOTICE_HTML = `<style>
/* 关键：id 选择器的 display:flex 会压过 [hidden] 的 display:none（浏览器默认样式优先级更低），
   所以必须显式把 [hidden] 规则写出来，否则点了确认也不消失、老用户还会每次都看到 */
#hxNotice[hidden]{display:none!important}
#hxNotice{position:fixed;inset:0;z-index:99999;background:rgba(3,5,8,.88);display:flex;align-items:center;justify-content:center;padding:20px;font:14px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:0;transition:opacity .22s ease}
#hxNotice.hx-show{opacity:1}
#hxNotice.hx-hide{opacity:0}
#hxNotice .box{transform:translateY(14px) scale(.975);opacity:0;transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .3s ease}
#hxNotice.hx-show .box{transform:none;opacity:1}
#hxNotice.hx-hide .box{transform:translateY(10px) scale(.98);opacity:0}
@media (prefers-reduced-motion:reduce){#hxNotice,#hxNotice .box{transition:none}}
#hxNotice .box{width:100%;max-width:620px;max-height:86vh;display:flex;flex-direction:column;background:#12171e;border:1px solid #2a3441;border-radius:10px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.6)}
#hxNotice .hd{padding:16px 20px;border-bottom:1px solid #232a33;display:flex;align-items:baseline;gap:10px}
#hxNotice .hd b{font-size:16px;color:#e6edf3}
#hxNotice .hd span{font-size:12px;color:#8b949e}
#hxNotice .bd{padding:6px 20px 14px;overflow-y:auto;color:#c9d1d9;font-size:13px}
#hxNotice .bd ol{margin:10px 0 0;padding-left:20px}
#hxNotice .bd li{margin:9px 0}
#hxNotice .bd b{color:#e6edf3}
#hxNotice .ft{padding:14px 20px;border-top:1px solid #232a33;display:flex;align-items:center;gap:12px}
#hxNotice .tip{flex:1;font-size:12px;color:#8b949e}
#hxNotice button{padding:10px 18px;border-radius:6px;border:1px solid #2f81f7;background:#1f6feb;color:#fff;font-size:14px;cursor:pointer}
#hxNotice button:disabled{background:#1a2230;border-color:#2a3441;color:#5a6675;cursor:not-allowed}
</style>
<div id="hxNotice" hidden>
  <div class="box">
    <div class="hd"><b>使用声明</b><span>首次使用必读 · 阅读到底部后可确认</span></div>
    <div class="bd" id="hxNoticeBody">
      <ol>
        <li><b>用途限制</b>：本系统仅供你本人／本家庭查看<b>自己孩子</b>的成绩。不得查看、收集、存储他人（含同学）的成绩或个人信息，不得对外提供、出售或公开分享。</li>
        <li><b>数据来源</b>：成绩、试卷信息、答题卡扫描件来自「慧学星」（四川云数赋智教育科技有限公司）。相关著作权与数据权利归原权利方，本系统仅作展示，不主张任何权利。</li>
        <li><b>存储位置</b>：你的账号与成绩数据保存在 <b>Cloudflare 的境外服务器</b>（D1 数据库）。这属于个人信息出境，你在此确认已知悉并同意。</li>
        <li><b>账号与密码</b>：登录系统较为简易，<b>没有找回密码方案</b>，请牢记密码。你填写的慧学星密码经加密后保存，仅用于自动登录上游抓取你自己的成绩。</li>
        <li><b>访问方式</b>：本系统用你提供的慧学星账号<b>正常登录</b>、按固定间隔读取你自己的成绩页面，未使用任何绕过鉴权、破解或撞库手段。若上游明确要求停止，请立即停用并删除数据。</li>
        <li><b>免责</b>：本项目由 <b>AI 辅助开发</b>，可能存在缺陷；作者不对使用过程中产生的任何问题（成绩显示错误或丢失、账号异常、违反第三方条款等）承担责任。</li>
        <li><b>停止使用</b>：你可以随时在「账号设置」页注销账号，该账号的全部成绩数据会被一并删除。</li>
      </ol>
    </div>
    <div class="ft">
      <div class="tip" id="hxNoticeTip">请向下滚动阅读全部内容</div>
      <button id="hxNoticeOk" disabled>我已阅读并同意</button>
    </div>
  </div>
</div>
<script>
(function () {
  try { if (localStorage.getItem('hxxai_notice_v1') === '1') return; } catch (e) {}
  var box = document.getElementById('hxNotice');
  var body = document.getElementById('hxNoticeBody');
  var btn = document.getElementById('hxNoticeOk');
  var tip = document.getElementById('hxNoticeTip');
  if (!box || !body || !btn) return;
  box.hidden = false;
  document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(function () { box.classList.add('hx-show'); });
  var need = 8;            // 最短阅读秒数
  var left = need;
  var scrolled = body.scrollHeight <= body.clientHeight + 4;   // 内容不满一屏视为已读完
  function refresh() {
    if (scrolled && left <= 0) {
      btn.disabled = false;
      tip.textContent = '已读完全部内容';
    } else if (!scrolled) {
      tip.textContent = '请向下滚动阅读全部内容';
    } else {
      tip.textContent = '请阅读 ' + left + ' 秒后可确认';
    }
  }
  body.addEventListener('scroll', function () {
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 6) { scrolled = true; refresh(); }
  });
  refresh();
  var timer = setInterval(function () {
    left -= 1;
    if (left <= 0) { left = 0; clearInterval(timer); }
    refresh();
  }, 1000);
  btn.addEventListener('click', function () {
    if (btn.disabled || box.getAttribute('data-closing') === '1') return;   // 防连点
    box.setAttribute('data-closing', '1');
    try { localStorage.setItem('hxxai_notice_v1', '1'); } catch (e) {}
    box.classList.remove('hx-show');
    box.classList.add('hx-hide');                 // 先播淡出+下移动画
    document.documentElement.style.overflow = '';
    setTimeout(function () {                      // 动画结束再真正移除
      box.hidden = true;
      box.classList.remove('hx-hide');
      box.removeAttribute('data-closing');
    }, 240);
  });
})();
</script>`;


// ---- adminHtml.js ----
/** 由 _build/p1..p4 拼装并 JSON 转义生成。改界面请改分段后重新生成。 */
const ADMIN_HTML = "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<title>慧学星成绩单监控</title>\n<style>\n*{box-sizing:border-box}\nbody{margin:0;background:#0d1014;color:#e6edf3;font:14px/1.55 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"Microsoft YaHei\",sans-serif}\n.wrap{max-width:1180px;margin:0 auto;padding:18px 16px 60px}\nheader{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0 16px;border-bottom:1px solid #1e2530;margin-bottom:18px}\n.brand{font-size:17px;font-weight:650;letter-spacing:.3px}\n.spacer{flex:1}\nbutton{font:inherit;border-radius:7px;padding:6px 12px;cursor:pointer;border:1px solid #2b3440;background:#161c24;color:#d7e2ee;transition:.15s}\nbutton:hover{background:#1d2530;border-color:#3a4553}\nbutton.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}\nbutton.primary:hover{background:#2b7ff5}\nbutton.danger:hover{border-color:#7a2f2f;color:#ff9b9b}\nbutton[disabled]{opacity:.5;cursor:not-allowed}\nbutton.full{width:100%;margin-top:10px;padding:9px}\n.pill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid #2b3440;background:#151a21;color:#9fb0c1}\n.pill.ok{color:#7ee0a1;border-color:#245b3a;background:#12251a}\n.pill.warn{color:#ffd479;border-color:#5c4615;background:#231c0d}\n.pill.bad{color:#ff9b9b;border-color:#6a2b2b;background:#241313}\n.banner{margin:0 0 16px;padding:10px 14px;border-radius:9px;background:#231c0d;border:1px solid #5c4615;color:#ffd479;font-size:13px}\n.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:18px}\n.card{background:#12171e;border:1px solid #1e2530;border-radius:11px;padding:14px}\n.card .k{font-size:12px;color:#8b9aab;letter-spacing:.4px}\n.card .v{font-size:24px;font-weight:650;margin:4px 0 2px;font-variant-numeric:tabular-nums}\n.card .v.small{font-size:14px;font-weight:500;line-height:1.4}\n.card .s{font-size:11px;color:#6d7d8e}\n.panel{background:#12171e;border:1px solid #1e2530;border-radius:11px;padding:14px 16px;margin-bottom:16px}\n.panel h2{font-size:14px;margin:0 0 12px;font-weight:620;color:#c9d6e3}\n.tablewrap{overflow:auto;max-height:420px}\ntable{width:100%;border-collapse:collapse;font-size:13px}\nth{position:sticky;top:0;z-index:2;background:#12171e;text-align:left;font-weight:600;color:#8b9aab;font-size:12px;padding:8px 10px;border-bottom:1px solid #1e2530;white-space:nowrap}\ntd{padding:8px 10px;border-bottom:1px solid #161c24;vertical-align:top}\ntr:hover td{background:#151b23}\n.num{text-align:right;font-variant-numeric:tabular-nums}\n.score{font-weight:650;color:#8ad3ff}\n.null{color:#6d7d8e}\n.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid #2b3440;white-space:nowrap}\n.tag.new_report{color:#7ee0a1;border-color:#245b3a;background:#12251a}\n.tag.score_change{color:#8ad3ff;border-color:#1d4a6b;background:#0f1e2a}\n.tag.score_filled{color:#ffd479;border-color:#5c4615;background:#231c0d}\n.tag.score_cleared{color:#ff9b9b;border-color:#6a2b2b;background:#241313}\n.empty{font-size:13px;color:#6d7d8e;padding:6px 2px}\n.diag{background:#0b0f14;border:1px solid #1e2530;border-radius:9px;padding:12px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto;color:#a9bccf}\nfooter{margin-top:22px;font-size:12px;color:#5f6f80;border-top:1px solid #1e2530;padding-top:12px}\n.login{position:fixed;inset:0;background:rgba(8,10,14,.93);display:flex;align-items:center;justify-content:center;z-index:50}\n.loginbox{width:340px;background:#12171e;border:1px solid #26303c;border-radius:14px;padding:26px}\n.loginbox h1{font-size:18px;margin:0 0 6px}\n.muted{color:#8b9aab;font-size:12px;margin:0 0 14px}\n.loginbox input{width:100%;padding:9px 11px;border-radius:8px;border:1px solid #2b3440;background:#0b0f14;color:#e6edf3;font:inherit}\n.loginbox input:focus{outline:none;border-color:#1f6feb}\n.err{color:#ff9b9b;font-size:12px;min-height:18px;margin-top:8px}\ncode{background:#0b0f14;border:1px solid #1e2530;border-radius:4px;padding:1px 5px;font-size:12px}\n.hidden{display:none!important}\n.c{text-align:center}\nbutton.mini{font-size:12px;padding:2px 9px;border-radius:6px;border-color:#2b3440}\nbutton.mini:hover{background:#1d2530;border-color:#3a4553}\n.tag.multi{color:#ffd479;border-color:#5c4615;background:#231c0d}\n.tag.single{color:#9fb0c1;border-color:#2b3440}\ntr.detail-row>td{background:#0f141a;padding:10px 14px 14px 28px;border-bottom:1px solid #1e2530}\n.sub-table{width:auto;min-width:300px;font-size:13px;margin-top:4px}\n.sub-table td{padding:4px 16px 4px 0;border-bottom:1px solid #1a2028}\n.detail-hint{font-size:12px;color:#6d7d8e;margin-top:6px}\n.err-inline{color:#ff9b9b;font-size:12px}\npre.rawjson{background:#0b0f14;border:1px solid #1e2530;border-radius:8px;padding:10px;font-size:11px;line-height:1.45;max-height:240px;overflow:auto;color:#a9bccf;margin:8px 0 0;white-space:pre-wrap;word-break:break-all}\n\n/* ---------- 动效：只用 transform / opacity / grid-template-rows，单段 ≤300ms ---------- */\n@keyframes fade-up{from{opacity:0;transform:translate3d(0,8px,0)}to{opacity:1;transform:none}}\n@keyframes fade-in{from{opacity:0}to{opacity:1}}\n@keyframes shimmer{from{background-position:-140% 0}to{background-position:240% 0}}\n\n.reveal{animation:fade-up .26s cubic-bezier(.22,.61,.36,1) both}\n.reveal-1{animation-delay:.02s}\n.reveal-2{animation-delay:.06s}\n.reveal-3{animation-delay:.1s}\n.reveal-4{animation-delay:.14s}\n\n/* 表格行淡入：只在首屏渲染时加，后续刷新不重播，避免每次轮询闪一下 */\n/* 不写 fill:both —— 动画结束后不再保留合成层，避免把 sticky 表头压到下面去 */\ntr.row-in{animation:fade-in .22s ease}\n\n/* 只过渡颜色，不过渡尺寸，避免鼠标悬停时抖动 */\nbutton,input{transition:background-color .16s ease,border-color .16s ease,color .16s ease,opacity .16s ease}\nbutton:active:not([disabled]){transform:translateY(1px)}\nbutton:focus-visible,input:focus-visible{outline:2px solid #1f6feb;outline-offset:2px}\n.pill{transition:color .2s ease,border-color .2s ease,background-color .2s ease}\n\n.banner{animation:fade-up .22s cubic-bezier(.22,.61,.36,1) both}\n.login{animation:fade-in .18s ease both}\n.loginbox{animation:fade-up .24s cubic-bezier(.22,.61,.36,1) both}\n\n/* 明细展开：grid-template-rows 0fr→1fr，高度随内容自适应且不触发重排抖动 */\n.detail-wrap{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .28s cubic-bezier(.22,.61,.36,1),opacity .18s ease}\n.detail-wrap.open{grid-template-rows:1fr;opacity:1}\n.detail-inner{overflow:hidden;min-height:0}\n\n.skeleton{height:12px;border-radius:4px;background:linear-gradient(90deg,#182028 25%,#202a37 37%,#182028 63%);background-size:240% 100%;animation:shimmer 1.15s linear infinite}\n.skeleton+.skeleton{margin-top:8px}\n\n@media (prefers-reduced-motion:reduce){\n  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}\n}\n\n</head>\n<body>\n\n/* ---------- 视觉：深色层次 ---------- */\nbody{background-image:radial-gradient(900px 420px at 10% -10%,rgba(31,111,235,.10),transparent 62%),radial-gradient(700px 380px at 100% 0%,rgba(30,180,166,.06),transparent 55%)}\n.card{background:linear-gradient(180deg,#141a22,#10151c);box-shadow:inset 0 1px 0 rgba(255,255,255,.035);transition:border-color .18s ease,transform .18s ease,box-shadow .18s ease}\n.card:hover{border-color:#2b3644;transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 6px 20px rgba(0,0,0,.28)}\nbutton.primary{box-shadow:0 2px 12px rgba(31,111,235,.32)}\nbutton.primary:hover{box-shadow:0 3px 16px rgba(31,111,235,.42)}\n.panel h2{display:flex;align-items:center;gap:8px}\n.panel h2:before{content:'';width:3px;height:13px;border-radius:2px;background:linear-gradient(180deg,#3d8bff,#1f6feb)}\ntr.snap-row{transition:box-shadow .15s ease}\ntr.snap-row:hover{box-shadow:inset 2px 0 0 #1f6feb}\n.tag.multi{background:linear-gradient(180deg,#2a2410,#231c0d)}\n\n/* ---------- 次级科目明细 ---------- */\n.detail-head{display:flex;align-items:center;gap:12px;font-size:12px;color:#8b9aab;margin:2px 0 10px}\n.detail-head .src{color:#7d8c9c;border:1px solid #2b3440;border-radius:999px;padding:1px 8px;font-size:11px}\n.detail-head .sum{margin-left:auto;color:#c9d6e3;font-variant-numeric:tabular-nums}\ntable.sub-table{width:100%;max-width:560px;border-collapse:collapse;font-size:13px}\ntable.sub-table td{padding:6px 10px 6px 0;border-bottom:1px solid #171f28;vertical-align:middle}\ntable.sub-table tr:last-child td{border-bottom:0}\ntable.sub-table td.subj{width:76px;color:#c9d6e3}\ntable.sub-table td.barcell{width:44%}\n.bar{height:6px;border-radius:999px;background:#1a222c;overflow:hidden}\n.bar>i{display:block;height:100%;border-radius:999px;background:#3d8bff;transform-origin:left center;animation:bar-in .38s cubic-bezier(.22,.61,.36,1)}\n@keyframes bar-in{from{transform:scaleX(0)}to{transform:scaleX(1)}}\n.bar.great>i{background:linear-gradient(90deg,#38c172,#7ee0a1)}\n.bar.good>i{background:linear-gradient(90deg,#2b7ff5,#66b3ff)}\n.bar.ok>i{background:linear-gradient(90deg,#c98a1a,#ffd479)}\n.bar.low>i{background:linear-gradient(90deg,#c1453f,#ff9b9b)}\n.score.great{color:#7ee0a1}\n.score.good{color:#8ad3ff}\n.score.ok{color:#ffd479}\n.score.low{color:#ff9b9b}\n\n/* ---------- 数据可视化：环形 / 雷达 / 参考线 ---------- */\n.detail-head{display:flex;align-items:center;gap:14px;font-size:12px;color:#8b9aab;margin:2px 0 14px}\n.dh-text{line-height:1.35}\n.dh-title{color:#c9d6e3;font-size:13px;font-weight:600}\n.dh-sub{color:#7d8c9c;font-variant-numeric:tabular-nums}\n.detail-head .src{margin-left:auto;color:#7d8c9c;border:1px solid #2b3440;border-radius:999px;padding:1px 8px;font-size:11px}\n.donut{flex:0 0 auto}\n.donut .track{stroke:#1a222c}\n.donut .prog{stroke:#3d8bff;stroke-linecap:round;transform:rotate(-90deg);transform-origin:50% 50%;animation:donut-draw .55s cubic-bezier(.22,.61,.36,1) both}\n.donut .pct{fill:#e6edf3;font-size:13px;font-weight:650;text-anchor:middle;dominant-baseline:central}\n@keyframes donut-draw{from{stroke-dashoffset:var(--from)}to{stroke-dashoffset:0}}\n\n.detail-grid{display:grid;grid-template-columns:248px minmax(260px,560px);gap:24px;align-items:start}\n.viz{display:flex;justify-content:center}\n.radar{display:block;overflow:visible}\n.radar .grid-line{stroke:#1e2833;fill:none}\n.radar .axis{stroke:#1a222c}\n.radar .lbl{fill:#7d8c9c;font-size:11px}\n.radar .val{fill:#8b9aab;font-size:9px;text-anchor:middle}\n.radar-poly{fill:rgba(61,139,255,.16);stroke:#3d8bff;stroke-width:1.6;stroke-linejoin:round;transform-box:fill-box;transform-origin:center;animation:radar-in .5s cubic-bezier(.22,.61,.36,1) both}\n.radar-dot{fill:#0d1014;stroke:#3d8bff;stroke-width:1.6;animation:fade-in .4s ease .18s both}\n@keyframes radar-in{from{transform:scale(.55);opacity:0}to{transform:scale(1);opacity:1}}\n@media (max-width:760px){.detail-grid{grid-template-columns:1fr}.viz{justify-content:flex-start}}\n\n.bars{display:flex;flex-direction:column;gap:8px}\n.sub-row{display:grid;grid-template-columns:64px 96px 1fr;gap:12px;align-items:center;transition:opacity .15s ease}\n.sub-row:hover .bar>i{filter:brightness(1.18)}\n.sub-row .subj{color:#c9d6e3;font-size:13px}\n.sub-row .val{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}\n.bar{position:relative}\n.bar:after{content:'';position:absolute;left:70%;top:-3px;bottom:-3px;width:1px;background:rgba(255,255,255,.15)}\n.bars-foot{margin-top:10px;font-size:11px;color:#5f6f80}\n\n/* ---------- 版面：更宽、更大、无内嵌滚动 ---------- */\n.wrap{max-width:1440px;padding:22px 28px 76px}\nheader{padding:8px 0 20px;margin-bottom:22px}\n.brand{font-size:19px;letter-spacing:.4px}\n.tablewrap{max-height:none;overflow:visible}\n.panel{padding:20px 22px;border-radius:15px;margin-bottom:20px}\n.panel h2{font-size:15px;margin:0 0 16px}\ntable{font-size:13.5px}\ntd{padding:11px 12px}\n\n/* ---------- 英雄区：最近一次考试 ---------- */\n.hero{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:30px;padding:26px 30px;margin-bottom:20px;border-radius:16px;border:1px solid #1e2836;background:linear-gradient(120deg,#121a24,#0f1620 46%,#101a23);position:relative;overflow:hidden}\n.hero:before{content:'';position:absolute;right:-8%;top:-45%;width:560px;height:340px;background:radial-gradient(closest-side,rgba(56,140,255,.20),transparent);pointer-events:none;animation:hero-glow 14s ease-in-out infinite alternate}\n@keyframes hero-glow{from{transform:translate3d(0,0,0) scale(1);opacity:.72}to{transform:translate3d(-38px,16px,0) scale(1.12);opacity:1}}\n.hero-kicker{font-size:11px;letter-spacing:.2em;color:#5f7d9c}\n.hero-title{font-size:27px;line-height:1.25;margin:7px 0 9px;font-weight:650;letter-spacing:.2px}\n.hero-meta{font-size:12.5px;color:#7d8c9c}\n.hero-score{font-size:54px;font-weight:680;font-variant-numeric:tabular-nums;line-height:1;text-align:right;letter-spacing:-.02em}\n.hero-score small{font-size:15px;color:#6d7d8e;font-weight:500;margin-left:6px;letter-spacing:0}\n.hero-ring{width:112px;height:112px}\n.hero-ring .track{stroke:#1a2430}\n.hero-ring .prog{stroke:#54a6ff;stroke-linecap:round;transform:rotate(-90deg);transform-origin:50% 50%;animation:donut-draw .7s cubic-bezier(.22,.61,.36,1) both}\n.hero-ring text{fill:#e6edf3;font-size:22px;font-weight:680;text-anchor:middle;dominant-baseline:central}\n.hero-ring .cap{font-size:9px;fill:#5f7d9c;font-weight:500;letter-spacing:.12em}\n\n/* ---------- 指标条 ---------- */\n.cards{grid-template-columns:repeat(4,1fr);gap:14px}\n.card{padding:16px 18px;border-radius:13px}\n.card .v{font-size:26px}\n\n/* ---------- 行内得分率 ---------- */\n.score-cell{display:flex;flex-direction:column;align-items:flex-end}\n.rail{position:relative;height:5px;width:112px;border-radius:999px;background:#161f29;overflow:hidden;margin-top:7px}\n.rail>i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#2b7ff5,#66b3ff);transform-origin:left center;animation:rail-grow .55s cubic-bezier(.22,.61,.36,1)}\n@keyframes rail-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}\n.rail.great>i{background:linear-gradient(90deg,#2f9e63,#7ee0a1)}\n.rail.good>i{background:linear-gradient(90deg,#2b7ff5,#66b3ff)}\n.rail.ok>i{background:linear-gradient(90deg,#b8791a,#ffd479)}\n.rail.low>i{background:linear-gradient(90deg,#a83c36,#ff9b9b)}\n\n/* ---------- 明细：两列铺开，一屏装下 ---------- */\n.detail-grid{grid-template-columns:288px 1fr;gap:28px}\n.subj-grid{display:grid;grid-template-columns:repeat(2,minmax(300px,1fr));gap:0 32px}\n.srow{display:grid;grid-template-columns:66px 92px 1fr;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid #151d26}\n.srow:hover .bar>i{filter:brightness(1.2)}\n.srow .subj{color:#c9d6e3;font-size:13px}\n.srow .val{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}\n@media (max-width:1180px){.subj-grid{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}}\n@media (max-width:820px){.hero{grid-template-columns:1fr;gap:16px}.hero-score{text-align:left}.detail-grid{grid-template-columns:1fr}}\n\n/* ---------- 大胆版：极光 / 玻璃 / 辉光 ---------- */\nbody{background-attachment:fixed}\nbody:before{content:'';position:fixed;left:-10%;right:-10%;top:-18%;height:72vh;z-index:-1;pointer-events:none;\n  background:radial-gradient(46% 56% at 16% 10%,rgba(52,120,255,.22),transparent 70%),\n             radial-gradient(42% 50% at 84% 4%,rgba(0,222,200,.15),transparent 72%),\n             radial-gradient(40% 46% at 54% -8%,rgba(150,90,255,.18),transparent 70%);\n  filter:blur(12px);animation:aurora 22s ease-in-out infinite alternate}\n@keyframes aurora{0%{transform:translate3d(-1.5%,0,0) scale(1)}100%{transform:translate3d(2%,2.5%,0) scale(1.14)}}\n\n.panel{background:linear-gradient(165deg,rgba(21,29,39,.92),rgba(13,19,26,.95));border:1px solid rgba(120,170,255,.10);\n  box-shadow:0 14px 40px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.045)}\n.card{background:linear-gradient(165deg,rgba(23,32,43,.95),rgba(14,20,27,.96));border:1px solid rgba(120,170,255,.10);\n  box-shadow:0 10px 28px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.05)}\n.card:hover{transform:translateY(-2px);border-color:rgba(120,170,255,.28);box-shadow:0 18px 42px rgba(0,0,0,.46),0 0 0 1px rgba(90,150,255,.16)}\n\n.hero{border:1px solid transparent;\n  background-image:linear-gradient(120deg,#111a24,#0d151d 48%,#101b22),\n                   linear-gradient(120deg,rgba(61,139,255,.8),rgba(29,224,200,.55) 45%,rgba(150,90,255,.65));\n  background-origin:border-box;background-clip:padding-box,border-box;\n  box-shadow:0 26px 64px rgba(0,0,0,.5)}\n.hero-title{background:linear-gradient(92deg,#ffffff,#a9d2ff 58%,#8fe7dd);-webkit-background-clip:text;background-clip:text;color:transparent}\n.hero-score{text-shadow:0 0 30px rgba(84,166,255,.35)}\n.hero-ring .prog{filter:drop-shadow(0 0 10px rgba(84,166,255,.7))}\n\n.rail>i{box-shadow:0 0 12px rgba(84,166,255,.45)}\n.rail.great>i{box-shadow:0 0 12px rgba(126,224,161,.45)}\n.rail.ok>i{box-shadow:0 0 12px rgba(255,212,121,.42)}\n.rail.low>i{box-shadow:0 0 12px rgba(255,155,155,.42)}\n.radar-poly{filter:drop-shadow(0 0 14px rgba(61,139,255,.6))}\n.dh-title{font-size:14px;background:linear-gradient(92deg,#fff,#9fd0ff);-webkit-background-clip:text;background-clip:text;color:transparent}\n.srow{grid-template-columns:26px 66px 92px 1fr;padding:7px 0;border-bottom:1px solid #141c25;transition:background-color .16s ease}\n.srow:hover{background:linear-gradient(90deg,rgba(61,139,255,.09),transparent)}\n.srow .rank{width:20px;height:20px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;\n  font-size:10.5px;color:#8fb6ff;background:rgba(61,139,255,.13);border:1px solid rgba(61,139,255,.28)}\n.srow:nth-child(-n+6) .rank{color:#0d1014;background:linear-gradient(135deg,#8fd7ff,#5aa8ff);border-color:transparent}\ntr.snap-row{transition:background-color .16s ease}\ntr.snap-row:hover{background:linear-gradient(90deg,rgba(61,139,255,.09),transparent)}\n.panel h2:before{background:linear-gradient(180deg,#5ad7ff,#3d8bff);box-shadow:0 0 10px rgba(90,180,255,.6)}\n\n/* ---------- 试卷信息 ---------- */\n.paper{border:1px solid rgba(120,170,255,.12);border-radius:12px;padding:14px 16px;margin:0 0 16px;background:linear-gradient(160deg,rgba(20,28,38,.85),rgba(13,19,26,.9))}\n.paper-h{font-size:12px;letter-spacing:.12em;color:#5f7d9c;margin-bottom:10px}\n.paper-grid{display:flex;flex-wrap:wrap;gap:8px}\n.pchip{display:inline-flex;align-items:baseline;gap:7px;padding:5px 11px;border-radius:9px;background:rgba(61,139,255,.07);border:1px solid rgba(61,139,255,.16)}\n.pchip .pk{font-size:11px;color:#7d8c9c}\n.pchip .pv{font-size:13px;color:#dbe7f3;font-variant-numeric:tabular-nums}\n.paper-comment{margin-top:11px;font-size:12.5px;color:#9fb3c6;padding-left:11px;border-left:2px solid rgba(61,139,255,.45)}\n\n.paper-raw{font-size:12px;color:#7d8c9c;margin:0 0 14px}\n.paper-raw summary{cursor:pointer;color:#8fb6ff}\n\n.donut{flex:0 0 auto}\n.donut .pct{font-size:16px;font-weight:700;fill:#e9f2fb}\n.donut .cap{font-size:9px;fill:#6d7d8e;letter-spacing:.04em}\n\n/* ================= 扁平化重制（覆盖前面的拟物/玻璃/辉光） ================= */\nbody{background:#0b0d10;background-image:none}\nbody:before{display:none}\n.wrap{max-width:1520px}\n.panel,.card,.hero{background:#11151a;border:1px solid #232a33;border-radius:3px;box-shadow:none;backdrop-filter:none}\n.hero{background:#11151a;border:1px solid #232a33;border-left:3px solid #2f81f7;box-shadow:none}\n.hero:before{display:none}\n.hero-title{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:#f0f4f8;-webkit-text-fill-color:#f0f4f8;font-weight:750;letter-spacing:-.01em}\n.hero-score{text-shadow:none;font-weight:800}\n.hero-kicker{color:#5b6673}\nbutton{border-radius:2px;background:#151a21;border:1px solid #2b333d;color:#d5dde6}\nbutton:hover{background:#1c232b;border-color:#3b4654}\nbutton.primary{background:#2f81f7;border-color:#2f81f7;color:#fff;box-shadow:none}\nbutton.primary:hover{background:#4c9bff;box-shadow:none}\n.card{border-radius:3px}\n.card:hover{transform:none;background:#151a21;border-color:#3b4654;box-shadow:none}\n.card .v{font-weight:800}\n.panel h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8b97a5;padding-bottom:11px;border-bottom:1px solid #232a33;margin-bottom:16px;position:relative}\n.panel h2:before{display:none}\n.panel h2:after{content:'';position:absolute;left:0;bottom:-1px;height:2px;width:100%;background:#2f81f7;transform-origin:left center;animation:line-grow .55s cubic-bezier(.2,.75,.2,1) both}\n@keyframes line-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}\n.pill,.tag,.pchip,.src,.rank,.mini,.paper,.paper-raw,pre.rawjson,.sub-table td,.bars,.bar,.rail{border-radius:2px}\n.tag.multi{background:#1a2635;border-color:#2f4a6b;color:#8fc3ff}\n.tag.single{background:#151a21;border-color:#2b333d;color:#98a4b2}\ntr.snap-row:hover{background:#151a21;box-shadow:none}\ntr.snap-row:hover td:first-child{box-shadow:inset 2px 0 0 #2f81f7}\n.rail>i,.hero-ring .prog,.donut .prog,.radar-poly{filter:none}\n.rail,.bar{background:#1a2028}\n.donut .track,.hero-ring .track{stroke:#1a2028}\n.score{color:#eef4fa}\n.score.great{color:#2ec27e}.score.good{color:#4c9bff}.score.ok{color:#e3b341}.score.low{color:#f85149}\n.rail.great>i{background:#2ec27e}.rail.good>i{background:#4c9bff}.rail.ok>i{background:#e3b341}.rail.low>i{background:#f85149}\n.radar-poly{fill:rgba(47,129,247,.14);stroke:#2f81f7}\n.radar-dot{stroke:#2f81f7;fill:#0b0d10}\n.pchip{border-color:#2b333d;background:#151a21}\n.paper{background:#0e1216;border-color:#232a33}\n.paper-comment{border-left-color:#2f81f7;color:#9aa7b4}\n.rank{color:#8fa3b8;background:#151a21;border-color:#2b333d}\n.srow:nth-child(-n+6) .rank{color:#fff;background:#2f81f7;border-color:#2f81f7}\n.detail-wrap{transition:grid-template-rows .34s cubic-bezier(.2,.75,.2,1),opacity .22s ease}\ntr.detail-row>td{animation:sheet-in .3s cubic-bezier(.2,.75,.2,1) both}\n@keyframes sheet-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}\n.loginbox{background:#11151a;border-color:#232a33;border-radius:3px}\ninput{border-radius:2px}\n.detail-head .src{border-color:#2b333d;color:#8b97a5}\n\n/* ---------- 答题卡缩略图 ---------- */\n.shots-h{font-size:12px;letter-spacing:.1em;color:#5b6673;margin:14px 0 8px}\n.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:16px}\n.shot{position:relative;display:block;border:1px solid #232a33;background:#0e1216;overflow:hidden;text-decoration:none}\n.shot img{display:block;width:100%;height:96px;object-fit:cover;opacity:.92;transition:transform .3s cubic-bezier(.2,.75,.2,1),opacity .2s}\n.shot:hover img{transform:scale(1.04);opacity:1}\n.shot-i{position:absolute;left:6px;top:6px;font-size:10px;padding:1px 5px;background:#2f81f7;color:#fff}\n\n.shots-imp{margin:14px 0 16px}\n.imp-ta{width:100%;max-width:720px;height:64px;background:#0e1216;border:1px solid #232a33;color:#cfd8e3;font:12px/1.5 ui-monospace,monospace;padding:8px;border-radius:2px;resize:vertical}\n.imp-btn{margin-top:8px;margin-right:10px}\n.imp-msg{font-size:12px;color:#8b97a5}\n\n.shots-grp{margin-bottom:18px}\n.shots-grp .shots-h{margin:0 0 8px}\n.shots-grp .shots{margin-bottom:0}\n\n.shot--mark{border-color:#5a2a2a}\n.shot--mark .shot-i{background:#f85149}\n\n/* ---------- 答题卡灯箱（合成版） ---------- */\n.shot-mark{position:absolute;right:6px;top:6px;font-size:10px;padding:1px 5px;background:#f85149;color:#fff}\n.lightbox{position:fixed;inset:0;z-index:60;display:none;background:rgba(4,6,9,.94)}\n.lightbox.open{display:block}\n.lb-inner{position:absolute;inset:0;display:flex;flex-direction:column;padding:0}\n.lb-close{position:absolute;right:18px;top:14px;z-index:2;width:36px;height:36px;font-size:22px;line-height:1;background:#151a21;border:1px solid #2b333d;color:#d5dde6;border-radius:2px;cursor:pointer}\n.lb-title{flex:0 0 auto;padding:14px 20px;font-size:12px;letter-spacing:.1em;color:#8b97a5;border-bottom:1px solid #232a33}\n.lb-stage{position:relative;flex:1 1 auto;display:flex;align-items:center;justify-content:center;overflow:auto;padding:18px}\n.lb-stage img{max-width:100%;max-height:calc(100vh - 120px);display:block}\n.lb-frame{position:relative;display:inline-block;line-height:0}\n.lb-base{position:relative;z-index:1;display:block;max-width:100%;max-height:calc(100vh - 120px)}\n.lb-over{position:absolute;left:0;top:0;width:100%;height:100%;z-index:2;pointer-events:none;object-fit:fill}\n\n.lb-mark{position:absolute;z-index:3;border:2px solid #f85149;background:rgba(248,81,73,.10);box-sizing:border-box}\n.lb-mark i{position:absolute;right:-1px;top:-18px;font-style:normal;font-size:11px;line-height:16px;padding:0 4px;background:#f85149;color:#fff;white-space:nowrap}\n.lb-note{padding:0 20px 16px;font-size:12px;color:#8b97a5}\n\n.shot--lost{border-color:#f85149}\n.shot--lost .shot-i{background:#f85149}\n</style>\n<div class=\"wrap\">\n  <header class=\"reveal reveal-1\">\n    <div class=\"brand\">慧学星 · 成绩单监控</div>\n    <div class=\"spacer\"></div>\n    <span id=\"pill\" class=\"pill\">加载中</span>\n    <button id=\"btnRefresh\" class=\"ghost\">刷新</button>\n    <button id=\"btnPoll\" class=\"primary\">立即检查</button>\n    <button id=\"btnRelogin\" class=\"ghost\">重新登录上游</button>\n    <button id=\"btnDiag\" class=\"ghost\">诊断</button>\n    <a href=\"/account\" class=\"ghost\" style=\"display:inline-block;text-decoration:none;line-height:1.6;padding:6px 12px\">账号设置</a>\n    <button id=\"btnLogout\" class=\"ghost danger\">退出</button>\n  </header>\n\n  <div id=\"banner\" class=\"banner hidden\"></div>\n\n  <section class=\"hero reveal reveal-2\">\n    <div>\n      <div class=\"hero-kicker\">LATEST EXAM</div>\n      <h1 class=\"hero-title\" id=\"heroTitle\">—</h1>\n      <div class=\"hero-meta\" id=\"heroMeta\">—</div>\n    </div>\n    <div class=\"hero-score\"><span id=\"heroScore\">—</span><small id=\"heroFull\"></small></div>\n    <div class=\"hero-ring\" id=\"heroRing\"></div>\n  </section>\n\n  <section class=\"cards reveal reveal-3\">\n    <div class=\"card\"><div class=\"k\">已记录考试</div><div class=\"v\" id=\"cSnap\">-</div><div class=\"s\">最近一次抓取到的全部成绩单</div></div>\n    <div class=\"card\"><div class=\"k\">近 24h 变化</div><div class=\"v\" id=\"cEvents\">-</div><div class=\"s\">新发布 + 分数变化</div></div>\n    <div class=\"card\"><div class=\"k\">观察到的检查间隔</div><div class=\"v\" id=\"cInterval\">-</div><div class=\"s\">由最近运行记录推算（分钟）</div></div>\n    <div class=\"card\"><div class=\"k\">上游会话</div><div class=\"v small\" id=\"cSession\">-</div><div class=\"s\" id=\"cSessionNote\">-</div></div>\n  </section>\n\n  <section class=\"panel reveal reveal-4\">\n    <h2>最新成绩单</h2>\n    <div class=\"tablewrap\">\n      <table>\n        <thead><tr><th>考试</th><th class=\"c\">类型</th><th class=\"num\">分数</th><th>考试日期</th><th>最近变化</th><th class=\"c\">明细</th></tr></thead>\n        <tbody id=\"tbSnap\"></tbody>\n      </table>\n    </div>\n    <div class=\"detail-hint\">「多科」行点 <b>明细</b> 展开各科分数；单科行只有一科，右侧显示 —</div>\n    <div class=\"empty hidden\" id=\"snapEmpty\">还没有数据。定时任务第一次运行后会写入基线。</div>\n  </section>\n\n  <section class=\"panel reveal reveal-4\">\n    <h2>发布 / 变化记录</h2>\n    <div class=\"tablewrap\">\n      <table>\n        <thead><tr><th>时间</th><th>类型</th><th>考试</th><th>分数变化</th></tr></thead>\n        <tbody id=\"tbEvents\"></tbody>\n      </table>\n    </div>\n    <div class=\"empty hidden\" id=\"eventsEmpty\">暂无事件。首次运行只建立基线，之后的发布与变化才会记录。</div>\n  </section>\n\n  <section class=\"panel reveal reveal-5\">\n    <h2>运行日志（最近 20 次）</h2>\n    <div class=\"tablewrap\">\n      <table>\n        <thead><tr><th>开始时间</th><th>状态</th><th class=\"num\">耗时</th><th class=\"num\">条目</th><th class=\"num\">事件</th><th>说明</th></tr></thead>\n        <tbody id=\"tbRuns\"></tbody>\n      </table>\n    </div>\n  </section>\n\n  <section class=\"panel hidden\" id=\"diagPanel\">\n    <h2>诊断（会真实登录一次上游，不覆盖已存会话）</h2>\n    <pre id=\"diagOut\" class=\"diag\">-</pre>\n  </section>\n\n  <footer>时间按 Asia/Shanghai 显示，数据库内以 UTC 存储。考试名称/日期由字段候选规则解析，若显示不对请点「诊断」把 examList 样例发我。</footer>\n\n  <div id=\"login\" class=\"login hidden\">\n    <div class=\"loginbox\">\n      <h1>登录</h1>\n      <p class=\"muted\">使用你自己的账号名与密码登录。</p>\n      <input id=\"uname\" type=\"text\" placeholder=\"账号名\" autocomplete=\"username\" />\n      <input id=\"pw\" type=\"password\" placeholder=\"密码\" autocomplete=\"current-password\" />\n      <button id=\"btnLogin\" class=\"primary full\">登录</button>\n      <a href=\"/register\" class=\"primary full\" style=\"display:block;text-align:center;text-decoration:none;padding:11px 10px;margin-top:12px;line-height:20px;border-radius:8px;background:#12325c;border:1px solid #2f81f7;color:#a9d3ff;font-weight:600;font-size:14px\">还没有账号？点这里注册 →</a>\n      <div id=\"loginErr\" class=\"err\"></div>\n      <p class=\"muted\" style=\"margin-top:12px;font-size:12px\">本网站登录系统较为简易，无找回方案，请牢记密码。</p>\n    </div>\n  </div>\n</div>\n<script>\n(function () {\n  var state = null;\n  var firstRender = true;\n  var LABEL = { new_report: '新成绩单发布', score_change: '分数变化', score_filled: '出分', score_cleared: '分数清空' };\n\n  function el(id) { return document.getElementById(id); }\n  function esc(s) {\n    if (s === null || s === undefined) return '';\n    return String(s).replace(/[&<>\"']/g, function (c) {\n      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c];\n    });\n  }\n  function dt(iso) {\n    if (!iso) return '-';\n    var d = new Date(iso);\n    if (isNaN(d.getTime())) return esc(iso);\n    var parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);\n    var m = {};\n    parts.forEach(function (p) { m[p.type] = p.value; });\n    return m.year + '/' + m.month + '/' + m.day + ' ' + m.hour + ':' + m.minute + ':' + m.second;\n  }\n  function api(path, opts) {\n    var init = Object.assign({ credentials: 'same-origin' }, opts || {});\n    if (init.body) { init.headers = { 'content-type': 'application/json' }; }\n    return fetch(path, init).then(function (r) {\n      return r.text().then(function (t) {\n        var j;\n        try { j = JSON.parse(t); } catch (e) { j = { ok: false, error: 'bad_response', raw: t.slice(0, 300) }; }\n        return { status: r.status, body: j };\n      });\n    });\n  }\n  function showLogin(msg) { el('login').classList.remove('hidden'); el('loginErr').textContent = msg || ''; el('pw').focus(); }\n  function hideLogin() { el('login').classList.add('hidden'); el('loginErr').textContent = ''; }\n  function banner(text, warn) {\n    var b = el('banner');\n    if (!text) { b.classList.add('hidden'); return; }\n    b.textContent = text;\n    b.style.background = warn ? '#241313' : '#231c0d';\n    b.style.borderColor = warn ? '#6a2b2b' : '#5c4615';\n    b.style.color = warn ? '#ff9b9b' : '#ffd479';\n    b.classList.remove('hidden');\n  }\n  function busy(btn, on, text) {\n    if (!btn) return;\n    btn.disabled = on;\n    if (on) { btn.dataset.label = btn.textContent; btn.textContent = text; }\n    else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }\n  }\n\n  function heroRingSvg(ratio) {\n    if (ratio === null || ratio === undefined) return '';\n    var C = 2 * Math.PI * 44;\n    var len = C * ratio;\n    return '<svg viewBox=\"0 0 112 112\" width=\"112\" height=\"112\" role=\"img\" aria-label=\"得分率 ' + Math.round(ratio * 100) + '%\">'\n      + '<circle class=\"track\" cx=\"56\" cy=\"56\" r=\"44\" fill=\"none\" stroke-width=\"7\"/>'\n      + '<circle class=\"prog\" cx=\"56\" cy=\"56\" r=\"44\" fill=\"none\" stroke-width=\"7\" stroke-dasharray=\"' + len.toFixed(1) + ' ' + C.toFixed(1) + '\" style=\"--from:' + len.toFixed(1) + '\"/>'\n      + '<text x=\"56\" y=\"52\">' + Math.round(ratio * 100) + '</text>'\n      + '<text class=\"cap\" x=\"56\" y=\"70\">得分率</text></svg>';\n  }\n\n  function railCls(ratio) {\n    if (ratio === null || ratio === undefined) return '';\n    return ratio >= 0.85 ? 'great' : ratio >= 0.7 ? 'good' : ratio >= 0.5 ? 'ok' : 'low';\n  }\n\n  function render(s) {\n    state = s;\n\n    // 英雄区：取考试日期最新的那条\n    var hero = (s.snapshots || []).slice().sort(function (a, b) {\n      var da = a.exam_date || '';\n      var db = b.exam_date || '';\n      if (da === db) return 0;\n      return da < db ? 1 : -1;\n    })[0];\n    if (hero) {\n      el('heroTitle').textContent = hero.title || ('#' + hero.exam_id);\n      el('heroMeta').textContent = (hero.exam_date || '日期未知') + ' · ' + (hero.is_multi ? '多科' : '单科')\n        + (hero.full ? ' · 满分 ' + hero.full : '') + (hero.last_change_at ? ' · 最近变化 ' + dt(hero.last_change_at) : '');\n      el('heroScore').textContent = hero.score_text === null || hero.score_text === undefined ? '—' : hero.score_text;\n      el('heroFull').textContent = hero.full ? ' / ' + hero.full : '';\n      el('heroRing').innerHTML = heroRingSvg(hero.ratio);\n    }\n    el('cSnap').textContent = s.snapshotCount;\n    el('cEvents').textContent = s.stats.last24h;\n    el('cInterval').textContent = s.stats.observedIntervalMinutes === null ? '-' : (s.stats.observedIntervalMinutes + ' 分');\n    el('cSession').textContent = s.session ? (s.session.loginOk ? '已登录' : '需重新登录') : '尚未登录';\n    el('cSessionNote').textContent = s.session ? ('上次登录 ' + dt(s.session.updatedAt)) : ('首次运行时会自动登录 ' + s.config.upstream);\n\n    var last = s.runs[0];\n    var pill = el('pill');\n    if (!last) { pill.textContent = '未运行'; pill.className = 'pill warn'; }\n    else if (last.status === 'ok' || last.status === 'changed' || last.status === 'baseline') { pill.textContent = '正常'; pill.className = 'pill ok'; }\n    else if (last.status === 'auth_failed') { pill.textContent = '登录失效'; pill.className = 'pill bad'; }\n    else { pill.textContent = last.status; pill.className = 'pill warn'; }\n\n    if (last) {\n      if (last.status === 'auth_failed') banner('上游登录失败：' + (last.message || '') + '　请先核对机密里的账号密码，再点\"重新登录上游\"。', true);\n      else if (last.status === 'baseline') banner('已完成首次基线（' + last.exams_seen + ' 份成绩单）。本次不产生事件，之后的新发布与分数变化才会记录。', false);\n      else if (last.status !== 'ok' && last.status !== 'changed') banner('上次检查异常（' + last.status + '）：' + (last.message || ''), true);\n      else banner('', false);\n    }\n\n    el('tbSnap').innerHTML = (s.snapshots || []).map(function (r) {\n      var cls = railCls(r.ratio);\n      var score = (r.score_text === null || r.score_text === undefined)\n        ? '<span class=\"null\">未出分/缺考</span>'\n        : '<span class=\"score ' + cls + '\">' + esc(r.score_text) + '</span>' + (r.full ? '<span class=\"null\"> /' + esc(String(r.full)) + '</span>' : '');\n      var rail = (r.ratio === null || r.ratio === undefined) ? '' : '<div class=\"rail ' + cls + '\"><i style=\"width:' + (r.ratio * 100).toFixed(1) + '%\"></i></div>';\n      var type = r.is_multi ? '<span class=\"tag multi\">多科</span>' : '<span class=\"tag single\">单科</span>';\n      var act = '<button class=\"mini\" data-exam=\"' + esc(r.exam_id) + '\" data-type=\"' + esc(r.exam_type_id || '') + '\">' + (r.is_multi ? '明细' : '详情') + '</button>';\n      return '<tr class=\"snap-row\">'\n        + '<td>' + esc(r.title || ('#' + r.exam_id)) + '</td>'\n        + '<td class=\"c\">' + type + '</td>'\n        + '<td class=\"num score-cell\">' + score + rail + '</td>'\n        + '<td>' + (r.exam_date ? esc(r.exam_date) : '-') + '</td>'\n        + '<td>' + (r.last_change_at ? dt(r.last_change_at) : '-') + '</td>'\n        + '<td class=\"c\">' + act + '</td></tr>';\n    }).join('');\n    el('snapEmpty').classList.toggle('hidden', (s.snapshots || []).length > 0);\n    if (firstRender) {\n      Array.prototype.forEach.call(el('tbSnap').children, function (tr, i) {\n        tr.classList.add('row-in');\n        tr.style.animationDelay = Math.min(i * 18, 150) + 'ms';\n      });\n    }\n\n    el('tbEvents').innerHTML = (s.events || []).map(function (e) {\n      var change = (e.old_score === null || e.old_score === undefined ? '—' : esc(e.old_score)) + ' → ' + (e.new_score === null || e.new_score === undefined ? '—' : esc(e.new_score));\n      if (e.delta !== null && e.delta !== undefined) change += ' <span class=\"null\">(' + (e.delta > 0 ? '+' : '') + e.delta + ')</span>';\n      return '<tr><td>' + dt(e.detected_at) + '</td><td><span class=\"tag ' + esc(e.kind) + '\">' + esc(LABEL[e.kind] || e.kind) + '</span></td><td>' + esc(e.title || e.subject_name || ('#' + e.exam_id)) + '</td><td>' + change + '</td></tr>';\n    }).join('');\n    el('eventsEmpty').classList.toggle('hidden', (s.events || []).length > 0);\n\n    firstRender = false;\n    el('tbRuns').innerHTML = (s.runs || []).map(function (r) {\n      return '<tr><td>' + dt(r.started_at) + '</td><td>' + esc(r.status) + '</td><td class=\"num\">' + (r.duration_ms === null ? '-' : r.duration_ms + 'ms') + '</td><td class=\"num\">' + (r.exams_seen || 0) + '</td><td class=\"num\">' + (r.events_created || 0) + '</td><td>' + esc(r.message || '') + '</td></tr>';\n    }).join('');\n  }\n\n  function loadState() {\n    return api('/admin/api/state').then(function (r) {\n      if (r.status === 401) { showLogin('会话已过期，请重新输入密码。'); return; }\n      if (!r.body.ok) { showLogin('服务端未就绪：' + (r.body.message || r.body.error || '')); return; }\n      hideLogin();\n      render(r.body);\n    });\n  }\n  // ---------- 多科明细展开（二级菜单）----------\n  var detailCache = {};\n\n  var SUBJECT_ORDER = ['语文', '数学', '英语', '政治', '历史', '地理', '物理', '化学', '生物', '技术', '史地政', '理综', '文综'];\n  var SRC_LABEL = { examReportList: '明细接口', examCourse: '课程列表', 'alldetail-html': '报告页解析', db: '已入库' };\n\n  function round1(n) { return Math.round(n * 10) / 10; }\n\n  var STD_FULL = { 语文: 150, 数学: 150, 英语: 150, 物理: 100, 化学: 100, 生物: 100, 政治: 100, 历史: 100, 地理: 100, 技术: 100, 史地政: 300, 理综: 300, 文综: 300 };\n\n  function withRatio(rows) {\n    return rows.map(function (r) {\n      var isTotal = /总分|合计|总计/.test(String(r.subject || ''));\n      var score = r.score === null || r.score === undefined ? null : String(r.score);\n      var full = (r.full === null || r.full === undefined || r.full === '') ? (STD_FULL[r.subject] || (isTotal ? 1050 : null)) : Number(r.full);\n      var num = score === null ? NaN : parseFloat(score);\n      var ratio = full && isFinite(num) ? Math.max(0, Math.min(1, num / full)) : null;\n      return { subject: r.subject, score: score, full: full, ratio: ratio, isTotal: isTotal };\n    }).filter(function (x) { return !x.isTotal; });\n  }\n\n  function donutSvg(ratio, score, full) {\n    var R = 30;\n    var C = 2 * Math.PI * R;\n    var r2 = ratio === null || ratio === undefined ? 0 : ratio;\n    var len = C * r2;\n    var scoreTxt = score === null || score === undefined ? '—' : String(score);\n    return '<svg class=\"donut\" width=\"76\" height=\"76\" viewBox=\"0 0 76 76\" role=\"img\" aria-label=\"' + esc(scoreTxt) + ' / ' + esc(String(full)) + '\">'\n      + '<circle class=\"track\" cx=\"38\" cy=\"38\" r=\"' + R + '\" fill=\"none\" stroke-width=\"5\"/>'\n      + '<circle class=\"prog\" cx=\"38\" cy=\"38\" r=\"' + R + '\" fill=\"none\" stroke-width=\"5\"'\n      + ' stroke-dasharray=\"' + len.toFixed(1) + ' ' + C.toFixed(1) + '\" style=\"--from:' + len.toFixed(1) + '\"/>'\n      + '<text class=\"pct\" x=\"38\" y=\"35\">' + esc(scoreTxt) + '</text>'\n      + (full ? '<text class=\"cap\" x=\"38\" y=\"49\">/ ' + esc(String(full)) + '</text>' : '')\n      + '</svg>';\n  }\n\n  function radarSvg(items) {\n    var n = items.length;\n    if (n < 3) return '';\n    var C = 120;\n    var R = 82;\n    var parts = [];\n    [0.34, 0.67, 1].forEach(function (k) {\n      var p = [];\n      for (var i = 0; i < n; i++) {\n        var a = (-90 + (360 / n) * i) * Math.PI / 180;\n        p.push((C + Math.cos(a) * R * k).toFixed(1) + ',' + (C + Math.sin(a) * R * k).toFixed(1));\n      }\n      parts.push('<polygon class=\"grid-line\" points=\"' + p.join(' ') + '\" stroke-dasharray=\"3 4\"/>');\n    });\n    var poly = [];\n    var dots = [];\n    for (var i = 0; i < n; i++) {\n      var ang = (-90 + (360 / n) * i) * Math.PI / 180;\n      var x1 = C + Math.cos(ang) * R;\n      var y1 = C + Math.sin(ang) * R;\n      parts.push('<line class=\"axis\" x1=\"' + C + '\" y1=\"' + C + '\" x2=\"' + x1.toFixed(1) + '\" y2=\"' + y1.toFixed(1) + '\"/>');\n      var r = items[i].ratio === null ? 0 : items[i].ratio;\n      var px = C + Math.cos(ang) * R * r;\n      var py = C + Math.sin(ang) * R * r;\n      poly.push(px.toFixed(1) + ',' + py.toFixed(1));\n      dots.push('<circle class=\"radar-dot\" cx=\"' + px.toFixed(1) + '\" cy=\"' + py.toFixed(1) + '\" r=\"2.4\"/>');\n      var lx = C + Math.cos(ang) * (R + 15);\n      var ly = C + Math.sin(ang) * (R + 15);\n      var anchor = Math.abs(lx - C) < 6 ? 'middle' : (lx > C ? 'start' : 'end');\n      parts.push('<text class=\"lbl\" x=\"' + lx.toFixed(1) + '\" y=\"' + (ly + 4).toFixed(1) + '\" text-anchor=\"' + anchor + '\">' + esc(items[i].subject) + '</text>');\n    }\n    return '<svg class=\"radar\" viewBox=\"0 0 240 240\" width=\"240\" height=\"240\" role=\"img\" aria-label=\"各科得分率雷达图\">'\n      + parts.join('')\n      + '<polygon class=\"radar-poly\" points=\"' + poly.join(' ') + '\"/>'\n      + dots.join('')\n      + '</svg>';\n  }\n\n  function subjectTable(rows, srcLabel) {\n    var items = withRatio(rows.slice().sort(function (p, q) {\n      var ip = SUBJECT_ORDER.indexOf(p.subject);\n      var iq = SUBJECT_ORDER.indexOf(q.subject);\n      if (ip < 0) ip = 50;\n      if (iq < 0) iq = 50;\n      return ip - iq;\n    }));\n\n    // 求和 / 雷达只用核心科目：合成科目（史地政等）与总分行是派生值，重复计入会翻倍\n    var isAggName = function (n) { return /史地政|理综|文综|总分|合计|总计/.test(String(n || '')); };\n    var core = items.filter(function (x) { return !isAggName(x.subject); });\n    var total = 0;\n    var totalFull = 0;\n    var summable = true;\n    core.forEach(function (it) {\n      if (it.full && isFinite(parseFloat(it.score))) { total += parseFloat(it.score); totalFull += it.full; }\n      else { summable = false; }\n    });\n    var ratio = summable && totalFull > 0 ? total / totalFull : null;\n\n    var ranked = items.slice().filter(function (x) { return x.ratio !== null; }).sort(function (a, b) { return b.ratio - a.ratio; });\n    ranked.forEach(function (x, i) { x.__rank = i + 1; });\n    // 有得分的按排名从高到低排，没得分的垫后 → 徽章 1..N 顺序递增，不再乱跳\n    var ordered = ranked.concat(items.filter(function (x) { return x.ratio === null; }));\n    var bars = ordered.map(function (it) {\n      var cls = it.ratio === null ? '' : it.ratio >= 0.85 ? 'great' : it.ratio >= 0.7 ? 'good' : it.ratio >= 0.5 ? 'ok' : 'low';\n      var bar = it.ratio === null ? '' : '<div class=\"bar ' + cls + '\"><i style=\"width:' + (it.ratio * 100).toFixed(1) + '%\"></i></div>';\n      var val = it.score === null\n        ? '<span class=\"null\">—</span>'\n        : '<span class=\"score ' + cls + '\">' + esc(it.score) + '</span>' + (it.full ? '<span class=\"null\">/' + it.full + '</span>' : '');\n      return '<div class=\"srow\"><span class=\"rank\">' + (it.__rank || '') + '</span><span class=\"subj\">' + esc(it.subject) + '</span><span class=\"val\">' + val + '</span>' + bar + '</div>';\n    }).join('');\n\n    var head = '<div class=\"detail-head\">'\n      + (ratio === null && !summable ? '' : donutSvg(ratio, round1(total), totalFull || null))\n      + '<div class=\"dh-text\"><div class=\"dh-title\">各科明细 · ' + items.length + ' 科</div>'\n      + '<div class=\"dh-sub\">' + (ratio === null ? '满分未知，暂不计算得分率' : '得分率 ' + Math.round(ratio * 100) + '% · 按得分率排序') + '</div></div>'\n      + (srcLabel ? '<span class=\"src\">' + esc(srcLabel) + '</span>' : '')\n      + '</div>';\n\n    return head\n      + '<div class=\"detail-grid\">'\n      + '<div class=\"viz\">' + radarSvg(core) + '</div>'\n      + '<div><div class=\"subj-grid\">' + bars + '</div>'\n      + '<div class=\"bars-foot\">竖虚线 = 70% 及格参考线 · 条形长度 = 得分率（分数 ÷ 满分）</div></div>'\n      + '</div>';\n  }\n\n  function shotsImportHtml(examId) {\n    return '<div class=\"shots-imp\"><div class=\"shots-h\">没有抓到答题卡图 · 粘贴 DevTools 里的响应（JSON 或 HTML），自动提取图片地址</div>'\n      + '<textarea class=\"imp-ta\" placeholder=\"把 baseInfo 接口的「响应」整段粘到这里，或把答题卡页的 HTML 粘进来\"></textarea>'\n      + '<button class=\"imp-btn\" data-exam=\"' + esc(examId) + '\">解析并保存</button>'\n      + '<span class=\"imp-msg\"></span></div>';\n  }\n\n  function isMarkUrl(u) { return /\\/assets\\/img\\/original_i/.test(String(u)); }\n\n  // 一级菜单：只显示答卷（扣分图层收进 data 属性，点开再看）\n  function marksFor(originals, subj, page) {\n    if (!originals || !originals.length) return [];\n    var hit = originals.filter(function (o) { return (o.subject || '') === subj; })[0]\n      || originals.filter(function (o) { return !o.subject; })[0];\n    if (!hit || !hit.marks) return [];\n    return hit.marks.filter(function (m) { return Number(m.page) === Number(page); });\n  }\n\n  function marksForAll(originals, subj) {\n    if (!originals || !originals.length) return [];\n    var hit = originals.filter(function (o) { return (o.subject || '') === subj; })[0]\n      || originals.filter(function (o) { return !o.subject; })[0];\n    return (hit && hit.marks) ? hit.marks : [];\n  }\n\n  function shotsHtml(list, examId, originals) {\n    if (!list || !list.length) return examId ? shotsImportHtml(examId) : '';\n    var items = list.map(function (x) { return typeof x === 'string' ? { subject: '', url: x } : x; });\n    var order = [];\n    var bySubj = {};\n    items.forEach(function (it) {\n      var k = it.subject || '';\n      if (!bySubj[k]) { bySubj[k] = []; order.push(k); }\n      bySubj[k].push(it.url);\n    });\n    return order.map(function (k) {\n      var all = bySubj[k];\n      var marks = all.filter(isMarkUrl);\n      var scans = all.filter(function (u) { return !isMarkUrl(u); });\n      var show = scans.length ? scans : all;          // 没有答卷时才退回显示图层\n      var cells = show.map(function (u, i) {\n        var src = '/admin/api/image?u=' + encodeURIComponent(u);\n        var data = esc(JSON.stringify(marks.map(function (m) { return '/admin/api/image?u=' + encodeURIComponent(m); })));\n        return '<a class=\"shot\" href=\"' + src + '\" data-marks=\"' + data + '\" data-rects=\"' + esc(JSON.stringify(marksFor(originals, k, i + 1))) + '\" data-rects-all=\"' + esc(JSON.stringify(marksForAll(originals, k))) + '\" data-title=\"' + esc((k || '答题卡') + ' 第' + (i + 1) + '页') + '\" rel=\"noreferrer\">'\n          + '<img src=\"' + src + '\" alt=\"' + esc((k || '答题卡') + ' 第' + (i + 1) + '页') + '\" loading=\"lazy\">'\n          + '<span class=\"shot-i\">' + (i + 1) + '</span>'\n          + (marks.length ? '<span class=\"shot-mark\">批改</span>' : '')\n          + '</a>';\n      }).join('');\n      return '<div class=\"shots-grp\"><div class=\"shots-h\">' + (k ? esc(k) : '答题卡') + ' · ' + show.length + ' 张'\n        + (marks.length ? '（含 ' + marks.length + ' 张扣分图层，点开看合成图）' : '') + '</div>'\n        + '<div class=\"shots\">' + cells + '</div></div>';\n    }).join('');\n  }\n\n  function paperInfoHtml(meta) {\n    if (!meta) return '';\n    var chips = [];\n    if (meta.type) chips.push(['类型', meta.type]);\n    if (meta.date) chips.push(['时间', meta.date]);\n    if (meta.candidates) chips.push(['实考', meta.candidates + ' 人']);\n    if (meta.full) chips.push(['满分', meta.full + ' 分']);\n    if (meta.questions) chips.push(['试题', meta.questions + ' 道']);\n    if (meta.difficulty) chips.push(['难度', meta.difficulty]);\n    if (meta.difficultyRatio) chips.push(['难中易', meta.difficultyRatio]);\n    if (meta.objective) chips.push(['客观题', meta.objective.count + ' 道 / ' + meta.objective.score + ' 分']);\n    if (meta.subjective) chips.push(['主观题', meta.subjective.count + ' 道 / ' + meta.subjective.score + ' 分']);\n    if (!chips.length && !meta.comment) return '';\n    if (meta.papers && meta.papers.length) {\n      var pk = meta.papers.map(function (p) { return (p.courseName || '') + ' #' + p.examPaperId; }).join('、');\n      chips.push(['原卷', pk]);\n    }\n    return '<div class=\"paper\"><div class=\"paper-h\">试卷信息</div><div class=\"paper-grid\">'\n      + chips.map(function (c) { return '<div class=\"pchip\"><span class=\"pk\">' + esc(c[0]) + '</span><span class=\"pv\">' + esc(c[1]) + '</span></div>'; }).join('')\n      + '</div>' + (meta.comment ? '<div class=\"paper-comment\">' + esc(meta.comment) + '</div>' : '') + '</div>';\n  }\n\n  function metaFallbackHtml(txt) {\n    if (!txt) return '';\n    return '<details class=\"paper-raw\"><summary>未识别到试卷信息 · 展开原文（复制给作者校准）</summary><pre class=\"rawjson\">' + esc(txt) + '</pre></details>';\n  }\n\n  var curExamId = null;\n  function CurExamId() { return curExamId; }\n\n  function openLightbox(base, opts) {\n    opts = opts || {};\n    var lb = el('lightbox');\n    if (!lb) {\n      lb = document.createElement('div');\n      lb.id = 'lightbox';\n      lb.className = 'lightbox';\n      lb.innerHTML = '<div class=\"lb-inner\"><button class=\"lb-close\" aria-label=\"关闭\">×</button>'\n        + '<div class=\"lb-title\"></div><div class=\"lb-stage\"></div><div class=\"lb-note\"></div></div>';\n      document.body.appendChild(lb);\n      lb.addEventListener('click', function (ev) {\n        if (ev.target === lb || (ev.target.className || '').indexOf('lb-close') >= 0) lb.classList.remove('open');\n      });\n    }\n    var rects = opts.rects || [];\n    var imgs = opts.images || [];\n    var html = '<div class=\"lb-frame\"><img class=\"lb-base\" src=\"' + base + '\" alt=\"答题卡\">';\n    imgs.forEach(function (m) { html += '<img class=\"lb-over\" src=\"' + m + '\" alt=\"图层\">'; });\n    rects.forEach(function (r) {\n      var pct = function (v) { return (Math.max(0, Math.min(1, Number(v) || 0)) * 100).toFixed(2) + '%'; };\n      html += '<span class=\"lb-mark\" style=\"left:' + pct(r.left) + ';top:' + pct(r.top)\n        + ';width:' + pct(r.width) + ';height:' + pct(r.height) + '\">'\n        + (r.lost ? '<i>-' + r.lost + '</i>' : '') + '</span>';\n    });\n    html += '</div>';\n    lb.querySelector('.lb-stage').innerHTML = html;\n    lb.querySelector('.lb-title').textContent = opts.title || '答题卡';\n    var total = rects.reduce(function (a, r) { return a + (Number(r.lost) || 0); }, 0);\n    lb.querySelector('.lb-note').textContent = rects.length\n      ? ('红框 ' + rects.length + ' 处失分' + (total ? '，合计 -' + Math.round(total * 10) / 10 + ' 分' : '') + '（可按 Esc 或点空白关闭）')\n      : ('本页没有失分标记 · 本页 rects=0；该科共 ' + (opts.debug || '0') + ' 块失分数据');\n    lb.classList.add('open');\n  }\n\n  function detailHtml(d) {\n    if (!d || d.ok === false) {\n      return '<span class=\"err-inline\">取明细失败：' + esc((d && d.error) || 'error') + ' ' + esc((d && d.message) || '') + '</span>';\n    }\n    var paper = paperInfoHtml(d.meta);\n    var fb = paper ? '' : metaFallbackHtml(d.metaText);\n    // 详情接口没带图时，回落到轮询已入库的 state.images（避免白框）\n    var imgs = (d.images && d.images.length) ? d.images : (state && state.images ? state.images[d.examId] : null);\n    var origs = (d.meta && d.meta.originals) || (state && state.meta && state.meta[d.examId] && state.meta[d.examId].info ? state.meta[d.examId].info.originals : null);\n    var shots = shotsHtml(imgs, d.examId, origs);\n    if (d.normalized && d.rows && d.rows.length) return paper + shots + fb + subjectTable(d.rows, SRC_LABEL[d.source] || d.source || '');\n    var keys = (d.keys || []).join(', ');\n    var raw = d.raw ? JSON.stringify(d.raw, null, 1) : '';\n    if (raw.length > 3200) raw = raw.slice(0, 3200) + ' …';\n    return paper + '<div class=\"detail-hint\">接口返回了 ' + esc(String(d.total || 0)) + ' 条，但字段名没对上，解析不出科目/分数。</div>'\n      + (keys ? '<div class=\"detail-hint\">出现的键名：<code>' + esc(keys) + '</code></div>' : '')\n      + (raw ? '<pre class=\"rawjson\">' + esc(raw) + '</pre>' : '');\n  }\n\n  function toggleDetail(row) {\n    var next = row.nextElementSibling;\n    if (next && next.classList && next.classList.contains('detail-row')) {\n      var wrap0 = next.querySelector('.detail-wrap');\n      if (wrap0) wrap0.classList.remove('open');       // 先收高度，再移除节点\n      setTimeout(function () { if (next.parentNode) next.parentNode.removeChild(next); }, 300);\n      return;\n    }\n    var btn = row.querySelector('button.mini');\n    if (!btn) return;\n    var stale = row.nextElementSibling;\n    if (stale && stale.classList && stale.classList.contains('detail-row')) stale.parentNode.removeChild(stale);\n    var examId = btn.getAttribute('data-exam');\n    curExamId = examId;\n    var examTypeId = btn.getAttribute('data-type') || '';\n    var tr = document.createElement('tr');\n    tr.className = 'detail-row';\n    tr.innerHTML = '<td colspan=\"6\"><div class=\"detail-wrap\"><div class=\"detail-inner\">'\n      + '<div class=\"detail-hint\">正在向上游取各科明细…</div>'\n      + '<div class=\"skeleton\" style=\"width:220px\"></div>'\n      + '<div class=\"skeleton\" style=\"width:180px\"></div>'\n      + '<div class=\"skeleton\" style=\"width:200px\"></div>'\n      + '</div></div></td>';\n    row.parentNode.insertBefore(tr, row.nextSibling);\n    var wrap = tr.querySelector('.detail-wrap');\n    var inner = tr.querySelector('.detail-inner');\n    // 轮询时已经把分数与试卷信息存库，这里直接用：零等待、不打上游\n    var dbRows = state && state.subjects ? state.subjects[examId] : null;\n    var dbMeta = state && state.meta ? state.meta[examId] : null;\n    var hasDb = (dbRows && dbRows.length) || dbMeta;\n    if (hasDb) {\n      var storedInfo = dbMeta ? (dbMeta.info || null) : null;\n      var dbShots = state && state.images ? state.images[examId] : null;\n      inner.innerHTML = paperInfoHtml(storedInfo) + shotsHtml(dbShots, examId, storedInfo && storedInfo.originals) + (dbRows && dbRows.length ? subjectTable(dbRows, SRC_LABEL.db) : '');\n      requestAnimationFrame(function () { wrap.classList.add('open'); });\n      return;\n    }\n    requestAnimationFrame(function () { wrap.classList.add('open'); });   // 下一帧再开，保证过渡生效\n    if (detailCache[examId]) { inner.innerHTML = detailCache[examId]; return; }\n    api('/admin/api/detail?examId=' + encodeURIComponent(examId) + '&examTypeId=' + encodeURIComponent(examTypeId)).then(function (r) {\n      if (r.status === 401) { showLogin('会话已过期，请重新输入密码。'); row.parentNode.removeChild(tr); return; }\n      var html = detailHtml(r.body);\n      detailCache[examId] = html;\n      inner.innerHTML = html;\n    }).catch(function (e) {\n      inner.innerHTML = '<span class=\"err-inline\">请求失败：' + esc(String(e)) + '</span>';\n    });\n  }\n\n  el('tbSnap').addEventListener('click', function (ev) {\n    var t = ev.target;\n    var shot = t && t.closest ? t.closest('.shot') : null;\n    if (shot) {\n      ev.preventDefault();\n      var imgs = [];\n      try { imgs = JSON.parse(shot.getAttribute('data-marks') || '[]'); } catch (e) { imgs = []; }\n      var rects = [];\n      try { rects = JSON.parse(shot.getAttribute('data-rects') || '[]'); } catch (e) { rects = []; }\n      var dbg = '0';\n      try {\n        var all = JSON.parse(shot.getAttribute('data-rects-all') || '[]');\n        dbg = String(all.length);\n      } catch (e) { dbg = '?'; }\n      openLightbox(shot.getAttribute('href'), { rects: rects, images: imgs, title: shot.getAttribute('data-title'), debug: dbg });\n      return;\n    }\n    if (t && t.className && String(t.className).indexOf('imp-btn') >= 0) {\n      var box = t.closest ? t.closest('.shots-imp') : null;\n      var ta = box ? box.querySelector('.imp-ta') : null;\n      var msg = box ? box.querySelector('.imp-msg') : null;\n      var examId = t.getAttribute('data-exam');\n      if (!ta || !ta.value.trim()) { if (msg) msg.textContent = '先粘贴内容'; return; }\n      if (msg) msg.textContent = '解析中…';\n      t.disabled = true;\n      api('/admin/api/import-images', { method: 'POST', body: JSON.stringify({ examKey: examId, text: ta.value }) }).then(function (r) {\n        t.disabled = false;\n        if (r.status === 401) { showLogin('会话已过期，请重新输入密码。'); return; }\n        if (!r.body.ok) { if (msg) msg.textContent = '没解析到图片：' + (r.body.hint || r.body.error || ''); return; }\n        if (msg) msg.textContent = '已保存 ' + r.body.count + ' 张';\n        detailCache = {};\n        if (r.body.state) render(r.body.state);\n      }).catch(function (e) { t.disabled = false; if (msg) msg.textContent = '请求失败：' + e; });\n      return;\n    }\n    if (!t || t.tagName !== 'BUTTON') return;\n    var row = t.closest ? t.closest('tr') : null;\n    if (row) toggleDetail(row);\n  });\n\n  // ---------- 按钮 ----------\n  function doLogin() {\n    var un = el('uname') ? String(el('uname').value || '').trim() : '';\n    var pw = el('pw').value;\n    if (!un) { el('loginErr').textContent = '请输入账号名'; return; }\n    if (!pw) { el('loginErr').textContent = '请输入密码'; return; }\n    busy(el('btnLogin'), true, '验证中…');\n    api('/admin/api/login', { method: 'POST', body: JSON.stringify({ username: un, password: pw }) }).then(function (r) {\n      busy(el('btnLogin'), false);\n      if (r.body.ok) { el('pw').value = ''; hideLogin(); loadState(); return; }\n      if (r.body.error === 'too_many_attempts') el('loginErr').textContent = '尝试过多，请 ' + r.body.retryAfter + ' 秒后再试。';\n      else if (r.body.error === 'bad_password') el('loginErr').textContent = '密码不对，还可以再试 ' + r.body.remaining + ' 次。';\n      else el('loginErr').textContent = '登录失败：' + (r.body.message || r.body.error || r.status);\n    }).catch(function (e) { busy(el('btnLogin'), false); el('loginErr').textContent = '请求失败：' + e; });\n  }\n\n  function runNow(btn, path, label) {\n    busy(btn, true, label);\n    banner('正在执行：' + label + '…', false);\n    detailCache = {};\n    api(path, { method: 'POST' }).then(function (r) {\n      busy(btn, false);\n      if (r.status === 401) { showLogin('会话已过期，请重新输入密码。'); return; }\n      if (r.body && r.body.state) render(r.body.state);\n      if (r.body && r.body.run) banner((r.body.run.status === 'ok' || r.body.run.status === 'changed' || r.body.run.status === 'baseline' ? '' : '检查未通过：') + (r.body.run.message || ''), r.body.ok === false);\n    }).catch(function (e) { busy(btn, false); banner('请求失败：' + e, true); });\n  }\n\n  el('btnLogin').addEventListener('click', doLogin);\n  el('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });\n  el('btnRefresh').addEventListener('click', function () { detailCache = {}; loadState(); });\n  el('btnPoll').addEventListener('click', function () { runNow(el('btnPoll'), '/admin/api/poll', '检查中…'); });\n  el('btnRelogin').addEventListener('click', function () { runNow(el('btnRelogin'), '/admin/api/relogin', '登录中…'); });\n  el('btnDiag').addEventListener('click', function () {\n    el('diagPanel').classList.remove('hidden');\n    el('diagOut').textContent = '正在诊断…';\n    busy(el('btnDiag'), true, '诊断中…');\n    api('/admin/api/diagnose').then(function (r) {\n      busy(el('btnDiag'), false);\n      if (r.status === 401) { showLogin('会话已过期，请重新输入密码。'); return; }\n      el('diagOut').textContent = JSON.stringify(r.body, null, 2);\n    }).catch(function (e) { busy(el('btnDiag'), false); el('diagOut').textContent = '诊断失败：' + e; });\n  });\n  el('btnLogout').addEventListener('click', function () {\n    api('/admin/api/logout', { method: 'POST' }).then(function () { showLogin('已退出。'); });\n  });\n\n  loadState();\n})();\n</script>\n</body>\n</html>\n";

// ---- store.js（以 store.* 形式暴露，与多文件版本保持同名调用）----
const store = (function () {
/**
 * D1 访问层。所有 SQL 都在这里，便于一处审查。
 * 所有时间列统一存 ISO8601 UTC 字符串（落盘用 UTC，展示时转 Asia/Shanghai）。
 */

async function getSession(db) {
  const row = await db.prepare('SELECT cookies, updated_at, login_ok, login_msg FROM session WHERE id = 1').first();
  if (!row) return null;
  let jar = [];
  try { jar = JSON.parse(row.cookies); } catch { jar = []; }
  return { jar, updatedAt: row.updated_at, loginOk: !!row.login_ok, loginMsg: row.login_msg };
}

async function saveSession(db, jar, loginOk, loginMsg, nowIso) {
  await db
    .prepare(
      'INSERT INTO session (id, cookies, updated_at, login_ok, login_msg) VALUES (1, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET cookies = excluded.cookies, updated_at = excluded.updated_at, login_ok = excluded.login_ok, login_msg = excluded.login_msg'
    )
    .bind(JSON.stringify(jar || []), nowIso, loginOk ? 1 : 0, loginMsg === undefined ? null : String(loginMsg))
    .run();
}

async function countSnapshots(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM exam_snapshot').first();
  return row ? Number(row.n || 0) : 0;
}

async function loadSnapshotMap(db) {
  const rows = await db.prepare('SELECT exam_key, exam_id, exam_type_id, subject_name, score_text, score_num, first_seen_at, last_seen_at, last_change_at FROM exam_snapshot').all();
  const map = new Map();
  for (const r of (rows && rows.results) || []) map.set(r.exam_key, r);
  return map;
}

async function upsertSnapshot(db, item, nowIso, changed) {
  await db
    .prepare(
      'INSERT INTO exam_snapshot (exam_key, exam_id, exam_type_id, subject_name, score_text, score_num, raw_json, first_seen_at, last_seen_at, last_change_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(exam_key) DO UPDATE SET exam_type_id = excluded.exam_type_id, subject_name = excluded.subject_name, ' +
        'score_text = excluded.score_text, score_num = excluded.score_num, raw_json = excluded.raw_json, ' +
        'last_seen_at = excluded.last_seen_at, last_change_at = excluded.last_change_at'
    )
    .bind(
      item.examKey,
      item.examId,
      item.examTypeId,
      item.subjectName,
      item.scoreText,
      item.scoreNum,
      item.rawJson,
      nowIso,
      nowIso,
      changed ? nowIso : null
    )
    .run();
}

async function insertEvent(db, ev, nowIso) {
  await db
    .prepare(
      'INSERT INTO events (kind, exam_key, exam_id, exam_type_id, subject_name, old_score, new_score, delta, detected_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(ev.kind, ev.examKey, ev.examId, ev.examTypeId ?? null, ev.subjectName ?? null, ev.oldScore ?? null, ev.newScore ?? null, ev.delta ?? null, nowIso, ev.rawJson)
    .run();
}

async function insertRun(db, run) {
  const r = await db
    .prepare(
      'INSERT INTO poll_runs (started_at, finished_at, status, http_status, exams_seen, events_created, relogin, duration_ms, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      run.startedAt,
      run.finishedAt ?? null,
      run.status,
      run.httpStatus ?? null,
      run.examsSeen ?? 0,
      run.eventsCreated ?? 0,
      run.relogin ?? 0,
      run.durationMs ?? null,
      run.message ?? null
    )
    .run();
  return r;
}

/* ---------- 多科次级科目分数 ---------- */

/** 只写有变化的行：没变的不动，消失的删掉。返回写入/删除的行数。 */
async function syncSubjects(db, examKey, rows, nowIso) {
  const existing = await db.prepare('SELECT subject, score, full FROM exam_subject WHERE exam_key = ?').bind(examKey).all();
  const prev = new Map(((existing && existing.results) || []).map((r) => [r.subject, r]));
  const seen = new Set();
  let changed = 0;

  for (const r of rows || []) {
    if (!r || !r.subject) continue;
    seen.add(r.subject);
    const p = prev.get(r.subject);
    const sameScore = p && String(p.score === null || p.score === undefined ? '' : p.score) === String(r.score === null || r.score === undefined ? '' : r.score);
    const sameFull = p && String(p.full === null || p.full === undefined ? '' : p.full) === String(r.full === null || r.full === undefined ? '' : r.full);
    if (p && sameScore && sameFull) continue;
    await db
      .prepare('INSERT INTO exam_subject (exam_key, subject, score, full, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(exam_key, subject) DO UPDATE SET score = excluded.score, full = excluded.full, updated_at = excluded.updated_at')
      .bind(examKey, r.subject, r.score === null || r.score === undefined ? null : String(r.score), r.full === null || r.full === undefined ? null : r.full, nowIso)
      .run();
    changed += 1;
  }
  for (const subject of prev.keys()) {
    if (seen.has(subject)) continue;
    await db.prepare('DELETE FROM exam_subject WHERE exam_key = ? AND subject = ?').bind(examKey, subject).run();
    changed += 1;
  }
  return changed;
}

/** 一次取回全部科目的分数，按 exam_key 分组（考试数量很少，不做分页） */
async function loadAllSubjects(db) {
  const rows = await db.prepare('SELECT exam_key, subject, score, full FROM exam_subject ORDER BY exam_key').all();
  const map = new Map();
  for (const r of (rows && rows.results) || []) {
    if (!map.has(r.exam_key)) map.set(r.exam_key, []);
    map.get(r.exam_key).push({ subject: r.subject, score: r.score, full: r.full });
  }
  return map;
}

/* ---------- 试卷信息 ---------- */

async function saveExamMeta(db, examKey, payload, nowIso) {
  await db
    .prepare('INSERT INTO exam_meta (exam_key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(exam_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .bind(examKey, JSON.stringify(payload || null), nowIso)
    .run();
}

async function loadAllExamMeta(db) {
  const rows = await db.prepare('SELECT exam_key, payload, updated_at FROM exam_meta').all();
  const map = new Map();
  for (const r of (rows && rows.results) || []) {
    try { map.set(r.exam_key, { info: JSON.parse(r.payload), updatedAt: r.updated_at }); } catch { /* 坏数据跳过 */ }
  }
  return map;
}

/* ---------- 答题卡图片 ---------- */

/**
 * 按科保存答题卡。groups = [{ subject, urls }]，会按科覆盖同步（某科这次没图就清掉该科）。
 * 没有 subject 的旧数据（''）一并清掉，避免旧的混合列表继续显示。
 */
let imageHasSubject = true;   // 迁移 006 是否已执行；执行不了就自动降级

async function saveExamImages(db, examKey, groups, nowIso) {
  const existing = imageHasSubject
    ? await db.prepare('SELECT url, subject FROM exam_image WHERE exam_key = ?').bind(examKey).all()
    : await db.prepare('SELECT url FROM exam_image WHERE exam_key = ?').bind(examKey).all();
  const prev = new Map();
  for (const r of (existing && existing.results) || []) prev.set(r.url, r.subject || '');
  const wanted = new Map();
  for (const g of groups || []) {
    let i = 0;
    for (const u of g.urls || []) {
      wanted.set(u, { subject: g.subject || '', idx: i });
      i += 1;
    }
  }
  let changed = 0;
  for (const [u, meta] of wanted) {
    const had = prev.get(u);
    if (had === undefined || had !== meta.subject) {
      try {
        if (imageHasSubject) {
          await db
            .prepare('INSERT OR REPLACE INTO exam_image (exam_key, subject, url, idx, updated_at) VALUES (?, ?, ?, ?, ?)')
            .bind(examKey, meta.subject, u, meta.idx, nowIso)
            .run();
        } else {
          await db
            .prepare('INSERT OR REPLACE INTO exam_image (exam_key, url, idx, updated_at) VALUES (?, ?, ?, ?)')
            .bind(examKey, u, meta.idx, nowIso)
            .run();
        }
      } catch (e) {
        // 典型：no such column: subject —— 迁移没跑。降级重试一次，别让整块图都丢掉。
        if (!imageHasSubject) throw e;
        imageHasSubject = false;
        await db
          .prepare('INSERT OR REPLACE INTO exam_image (exam_key, url, idx, updated_at) VALUES (?, ?, ?, ?)')
          .bind(examKey, u, meta.idx, nowIso)
          .run();
      }
      changed += 1;
    }
    prev.delete(u);
  }
  for (const u of prev.keys()) {
    await db.prepare('DELETE FROM exam_image WHERE exam_key = ? AND url = ?').bind(examKey, u).run();
    changed += 1;
  }
  return changed;
}

async function loadAllExamImages(db) {
  let rows;
  try {
    rows = imageHasSubject
      ? await db.prepare('SELECT exam_key, subject, url FROM exam_image ORDER BY exam_key, subject, idx').all()
      : await db.prepare('SELECT exam_key, url FROM exam_image ORDER BY exam_key, idx').all();
  } catch (e) {
    imageHasSubject = false;
    rows = await db.prepare('SELECT exam_key, url FROM exam_image ORDER BY exam_key, idx').all();
  }
  const map = new Map();
  for (const r of (rows && rows.results) || []) {
    if (!map.has(r.exam_key)) map.set(r.exam_key, []);
    map.get(r.exam_key).push({ subject: r.subject || '', url: r.url });
  }
  return map;
}

async function listEvents(db, limit = 200) {
  const rows = await db.prepare('SELECT id, kind, exam_key, exam_id, subject_name, old_score, new_score, delta, detected_at FROM events ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (rows && rows.results) || [];
}

async function listSnapshots(db, limit = 200) {
  const rows = await db
    .prepare('SELECT exam_key, exam_id, exam_type_id, subject_name, score_text, first_seen_at, last_seen_at, last_change_at, raw_json FROM exam_snapshot ORDER BY last_seen_at DESC, exam_key DESC LIMIT ?')
    .bind(limit)
    .all();
  return (rows && rows.results) || [];
}

async function listRuns(db, limit = 30) {
  const rows = await db
    .prepare('SELECT id, started_at, finished_at, status, http_status, exams_seen, events_created, relogin, duration_ms, message FROM poll_runs ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all();
  return (rows && rows.results) || [];
}

async function pruneRuns(db, keep = 300) {
  await db.prepare('DELETE FROM poll_runs WHERE id NOT IN (SELECT id FROM poll_runs ORDER BY id DESC LIMIT ?)').bind(keep).run();
}

/* ---------- 管理端登录限流 ---------- */

async function getLoginAttempt(db, ip) {
  return db.prepare('SELECT ip, count, window_start, blocked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
}

async function recordLoginFailure(db, ip, nowIso, { maxFailures = 8, windowMs = 15 * 60 * 1000, blockMs = 15 * 60 * 1000 } = {}) {
  const row = await getLoginAttempt(db, ip);
  const now = Date.parse(nowIso);
  let count = 1;
  let windowStart = nowIso;
  if (row) {
    const started = Date.parse(row.window_start);
    if (Number.isFinite(started) && now - started < windowMs) {
      count = Number(row.count || 0) + 1;
      windowStart = row.window_start;
    }
  }
  const blockedUntil = count >= maxFailures ? new Date(now + blockMs).toISOString() : null;
  await db
    .prepare('INSERT INTO login_attempts (ip, count, window_start, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, blocked_until = excluded.blocked_until')
    .bind(ip, count, windowStart, blockedUntil)
    .run();
  return { count, blockedUntil };
}

async function clearLoginAttempts(db, ip) {
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

/** 被限流则返回剩余秒数 */
function blockedSeconds(row, nowMs = Date.now()) {
  if (!row || !row.blocked_until) return 0;
  const t = Date.parse(row.blocked_until);
  if (!Number.isFinite(t) || t <= nowMs) return 0;
  return Math.ceil((t - nowMs) / 1000);
}

return { getSession, saveSession, countSnapshots, loadSnapshotMap, upsertSnapshot, insertEvent, insertRun, syncSubjects, loadAllSubjects, saveExamMeta, loadAllExamMeta, saveExamImages, loadAllExamImages, listEvents, listSnapshots, listRuns, pruneRuns, getLoginAttempt, recordLoginFailure, clearLoginAttempts, blockedSeconds };
})();

// ---- accounts.js（以 accounts.* 形式暴露，与多文件版本保持同名调用）----
const accounts = (function () {
/**
 * 多账号：口令散列、上游密码封存、账号增删改查。
 *  - 口令只存 PBKDF2-SHA256 派生值（盐 + 迭代次数 + 结果），不可逆
 *  - 慧学星密码必须可还原（要拿去登录上游），因此用 AES-GCM 封存，
 *    密钥由 SESSION_SECRET 经 PBKDF2 派生；换 SESSION_SECRET 会导致上游密码需重填
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const USERNAME_RE = /^[A-Za-z0-9_\-]{3,24}$/;
const MIN_PASSWORD = 8;
// Cloudflare Workers 的 crypto.subtle 对 PBKDF2 有硬上限：超过 100000 次直接抛
// "iteration counts above 100000 are not supported"。这里用允许的最大值。
const PBKDF2_ITERATIONS = 100000;
const MAX_PASSWORD = 72;
const MAX_ACCOUNTS = 20;

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timedEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

function usernameProblem(username) {
  const u = String(username || '').trim();
  if (!u) return '账号名不能为空';
  if (u.length < 3 || u.length > 24) return '账号名长度需在 3～24 个字符之间';
  if (!USERNAME_RE.test(u)) return '账号名只能用字母、数字、下划线、短横线';
  return '';
}

// 中国大陆手机号：11 位，1 开头，第二位 3-9（虚拟运营商 16x/17x 也在这个范围内）
const PHONE_RE = /^1[3-9]\d{9}$/;

function phoneProblem(phone) {
  const p = String(phone == null ? '' : phone).replace(/[\s-]/g, '');
  if (!p) return '慧学星账号（手机号）不能为空';
  if (!/^\d+$/.test(p)) return '慧学星账号只能是数字';
  if (p.length !== 11) return '慧学星账号必须是 11 位手机号（现在是 ' + p.length + ' 位）';
  if (!PHONE_RE.test(p)) return '手机号格式不对：应是 1 开头的 11 位数字';
  return '';
}

function passwordProblem(password) {
  const p = String(password || '');
  if (!p) return '密码不能为空';
  if (p.length < MIN_PASSWORD) return '密码至少 ' + MIN_PASSWORD + ' 位';
  if (p.length > MAX_PASSWORD) return '密码最多 ' + MAX_PASSWORD + ' 位';
  if (/^[0-9]+$/.test(p)) return '密码不能是纯数字';
  if (/^(.)\1+$/.test(p)) return '密码不能是同一个字符重复';
  return '';
}

async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return { salt: b64url(salt), hash: b64url(hash), iterations };
}

async function verifyPassword(password, row) {
  if (!row || !row.pwd_salt || !row.pwd_hash) return false;
  const salt = unb64url(row.pwd_salt);
  const expected = unb64url(row.pwd_hash);
  // 历史行若写了更大的迭代次数，按上限截断再比对，避免直接抛错把登录打死
  const iter = Math.min(Number(row.pwd_iter) || PBKDF2_ITERATIONS, PBKDF2_ITERATIONS);
  const actual = await pbkdf2(password, salt, iter);
  return timedEqual(actual, expected);
}

// —— 上游密码封存（AES-GCM，密钥由 SESSION_SECRET 派生）——
async function sealingKey(sessionSecret) {
  if (!sessionSecret) throw new Error('缺少 SESSION_SECRET，无法封存上游密码');
  const salt = enc.encode('hxxai-upstream-seal-v1');
  const raw = await pbkdf2(String(sessionSecret), salt, 60000);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sealSecret(plain, sessionSecret) {
  if (!plain) return null;
  const key = await sealingKey(sessionSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plain))));
  return b64url(iv) + '.' + b64url(ct);
}

async function openSecret(sealed, sessionSecret) {
  if (!sealed) return '';
  const [ivPart, ctPart] = String(sealed).split('.');
  if (!ivPart || !ctPart) return '';
  try {
    const key = await sealingKey(sessionSecret);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(ivPart) }, key, unb64url(ctPart));
    return dec.decode(plain);
  } catch {
    return '';
  }
}

// —— CRUD ——
async function countAccounts(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM account').first();
  return row ? Number(row.n || 0) : 0;
}

async function findAccountByUsername(db, username) {
  return await db.prepare('SELECT * FROM account WHERE username = ? COLLATE NOCASE').bind(String(username || '').trim()).first();
}

async function getAccount(db, id) {
  return await db.prepare('SELECT * FROM account WHERE id = ?').bind(Number(id) || 0).first();
}

async function listAccounts(db) {
  const rows = await db.prepare('SELECT id, username, upstream_user, created_at, updated_at FROM account ORDER BY id').all();
  return (rows && rows.results) || [];
}

/** 创建账号；重名/弱口令一律报错，绝不覆盖既有账号 */
/**
 * @returns {Promise<{ok: boolean, account?: any, error?: string, message?: string}>}
 */
async function createAccount(db, { username, password, upstreamUser, upstreamSecret, sessionSecret }, nowIso) {
  const name = String(username || '').trim();
  const badName = usernameProblem(name);
  if (badName) return { ok: false, error: 'bad_username', message: badName };
  const pp = passwordProblem(password);
  if (pp) return { ok: false, error: 'weak_password', message: pp };
  const up = phoneProblem(upstreamUser);
  if (up) return { ok: false, error: 'bad_phone', message: up };
  if ((await countAccounts(db)) >= MAX_ACCOUNTS) return { ok: false, error: 'too_many', message: '账号数量已达上限（' + MAX_ACCOUNTS + '）' };
  const exists = await findAccountByUsername(db, name);
  if (exists) return { ok: false, error: 'duplicate', message: '该账号名已被占用，请换一个' };

  const h = await hashPassword(password);
  const seal = upstreamSecret ? await sealSecret(upstreamSecret, sessionSecret) : null;
  try {
    await db
      .prepare('INSERT INTO account (username, pwd_salt, pwd_hash, pwd_iter, upstream_user, upstream_seal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(name, h.salt, h.hash, h.iterations, upstreamUser ? String(upstreamUser).trim() : null, seal, nowIso, nowIso)
      .run();
  } catch (e) {
    // 并发注册撞上唯一约束时同样走这里
    if (String(e && e.message).includes('UNIQUE')) return { ok: false, error: 'duplicate', message: '该账号名已被占用，请换一个' };
    throw e;
  }
  return { ok: true, account: await findAccountByUsername(db, name) };
}

/** 登录校验：账号不存在与口令错误返回同一个错误，避免账号枚举 */
/**
 * @returns {Promise<{ok: boolean, account?: any, error?: string, message?: string}>}
 */
async function authenticate(db, username, password) {
  const row = await findAccountByUsername(db, username);
  const ok = row ? await verifyPassword(password, row) : false;
  if (!row || !ok) return { ok: false, error: 'bad_credentials', message: '账号或密码不正确' };
  return { ok: true, account: row };
}

async function changePassword(db, id, password, nowIso) {
  const pp = passwordProblem(password);
  if (pp) return { ok: false, error: 'weak_password', message: pp };
  const h = await hashPassword(password);
  await db.prepare('UPDATE account SET pwd_salt = ?, pwd_hash = ?, pwd_iter = ?, updated_at = ? WHERE id = ?').bind(h.salt, h.hash, h.iterations, nowIso, Number(id)).run();
  return { ok: true };
}

async function updateUpstream(db, id, upstreamUser, upstreamSecret, sessionSecret, nowIso) {
  const badPhone = phoneProblem(upstreamUser);
  if (badPhone) return { ok: false, error: 'bad_phone', message: badPhone };
  const seal = upstreamSecret === undefined || upstreamSecret === null ? undefined : await sealSecret(upstreamSecret, sessionSecret);
  if (seal === undefined) {
    await db.prepare('UPDATE account SET upstream_user = ?, updated_at = ? WHERE id = ?').bind(upstreamUser || null, nowIso, Number(id)).run();
  } else {
    await db.prepare('UPDATE account SET upstream_user = ?, upstream_seal = ?, updated_at = ? WHERE id = ?').bind(upstreamUser || null, seal, nowIso, Number(id)).run();
  }
  return { ok: true };
}

async function deleteAccount(db, id) {
  await db.prepare('DELETE FROM account WHERE id = ?').bind(Number(id)).run();
  await db.prepare('DELETE FROM account_session WHERE account_id = ?').bind(Number(id)).run();
  return { ok: true };
}

/** 取该账号可用的上游凭据：优先账号自带，否则回退到环境变量（兼容旧单账号部署） */
async function upstreamCredentials(db, account, env, sessionSecret) {
  const user = (account && account.upstream_user) || env.HXXAI_USERNAME || '';
  let pass = '';
  if (account && account.upstream_seal) pass = await openSecret(account.upstream_seal, sessionSecret);
  if (!pass) pass = env.HXXAI_PASSWORD || '';
  return { username: String(user).trim(), password: String(pass) };
}

return { MIN_PASSWORD, PBKDF2_ITERATIONS, MAX_PASSWORD, MAX_ACCOUNTS, usernameProblem, phoneProblem, passwordProblem, hashPassword, verifyPassword, sealSecret, openSecret, countAccounts, findAccountByUsername, getAccount, listAccounts, createAccount, authenticate, changePassword, updateUpstream, deleteAccount, upstreamCredentials };
})();

// ---- index.js ----
/**
 * 慧学星成绩单发布监控 —— Worker 入口
 *   定时：scheduled() -> runPoll()
 *   界面：/admin（密码保护）-> /admin/api/*
 * 所有管理端响应都带 Cache-Control: no-store（含登录态的响应绝不进 CDN 缓存）。
 */

const NO_STORE = {
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...extra },
  });
}

// 明细缓存：同一 isolate 内 5 分钟内不重复打上游（考试明细点开一次就够看，反复点不必反复请求）
const detailCache = new Map();
const DETAIL_TTL_MS = 5 * 60 * 1000;

function html(body) {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE, 'content-security-policy': CSP, 'x-frame-options': 'DENY' },
  });
}

/* ============================ 轮询 ============================ */

function statusOf(err) {
  const kind = err instanceof UpstreamError ? err.kind : 'internal_error';
  if (kind === 'config_error' || kind === 'login_failed' || kind === 'auth_expired') return { kind, status: 'auth_failed' };
  if (kind === 'parse_error') return { kind, status: 'parse_error' };
  if (kind === 'internal_error') return { kind, status: 'internal_error' };
  return { kind, status: 'upstream_error' };
}

/**
 * 跑一轮检查。绝不抛出：所有失败都落 poll_runs 并在返回值里体现。
 * 失败时不动快照表 —— 因此不会因为一次抓取失败而误报"成绩单消失/重复发布"。
 */
export async function runPoll(env, opts = {}) {
  const account = opts.account || null;
  const accountId = Number(account && account.id) || 0;
  const st = scopedStore(env.DB, accountId);
  // 每个账号用自己绑定的慧学星账号抓取；未绑定时回退到环境变量（仅兼容旧部署）
  let creds = { username: '', password: '' };
  try { creds = await accounts.upstreamCredentials(env.DB, account, env, env.SESSION_SECRET); } catch { creds = { username: '', password: '' }; }
  const envUp = { ...env, HXXAI_USERNAME: creds.username, HXXAI_PASSWORD: creds.password };
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const run = {
    startedAt,
    status: 'ok',
    examsSeen: 0,
    eventsCreated: 0,
    relogin: 0,
    httpStatus: null,
    message: null,
    trigger: opts.trigger || 'cron',
    // 下面这些先占位声明：运行中会赋值，预声明可避免编辑器把 run.xxx = 标成类型错误
    finishedAt: null,
    durationMs: null,
    rowsWritten: 0,
    subjectsChanged: 0,
  };

  try {
    let session = null;
    try { session = await st.getSession(); } catch { session = null; }
    let jar = session ? session.jar : [];
    const mustLogin = opts.forceRelogin || !session || !session.loginOk || jar.length === 0;

    if (mustLogin) {
      const l = await login(envUp);
      jar = l.jar;
      run.relogin = 1;
      await st.saveSession(jar, true, l.message, new Date().toISOString());
    }

    let page;
    try {
      page = await fetchExamList(env, jar);
    } catch (e) {
      if (e && e.kind === 'auth_expired' && run.relogin === 0) {
        const l = await login(envUp);
        jar = l.jar;
        run.relogin = 1;
        await st.saveSession(jar, true, l.message, new Date().toISOString());
        page = await fetchExamList(env, jar);
      } else {
        throw e;
      }
    }
    run.httpStatus = page.httpStatus;

    // 翻页（有上限，避免考试数量增长后单次执行拖太久）
    const pageSize = Number(env.POLL_PAGE_SIZE || 50);
    const maxPages = Math.max(1, Number(env.MAX_POLL_PAGES || 2));
    let rawItems = page.list.slice();
    const totalPage = Math.max(1, page.totalPage || 1);
    let p = 1;
    while (p < Math.min(totalPage, maxPages)) {
      p += 1;
      const more = await fetchExamList(env, jar, { pageNumber: p, pageSize });
      rawItems = rawItems.concat(more.list);
    }

    const prevMap = await st.loadSnapshotMap();
    const coldStart = prevMap.size === 0;
    const { items, events } = diffExams(prevMap, rawItems);
    const nowIso = new Date().toISOString();

    // 首次运行只建基线：此时无法区分"刚发布"和"早就存在"，报新成绩单会是假警
    const effective = coldStart ? [] : events;
    const changedKeys = new Set(effective.map((e) => e.examKey));

    for (const ev of effective) await st.insertEvent(ev, nowIso);
    // 没变化的条目不必每轮都写库：30 分钟内已确认过的跳过，只为控制 D1 的写入行数配额
    const refreshMs = 30 * 60 * 1000;
    const nowMs = Date.now();
    let written = 0;
    for (const it of items) {
      const prev = prevMap.get(it.examKey);
      const stale = !prev || !prev.last_seen_at || nowMs - Date.parse(prev.last_seen_at) > refreshMs;
      if (!stale && !changedKeys.has(it.examKey)) continue;
      await st.upsertSnapshot(it, nowIso, changedKeys.has(it.examKey));
      written += 1;
    }
    run.rowsWritten = written;

    // 多科考试的次级科目分数：每轮一并抓下来存进 exam_subject，
    // 这样管理界面展开时读库即可，不再现场打上游。
    // 所有考试都抓一次整页：多科拿各科分数，单科也有试卷信息
    const targets = items.map((it) => ({ examKey: it.examKey, examId: it.examId, examTypeId: it.examTypeId }));
    const detailCap = Math.max(1, Number(env.MAX_DETAIL_PER_POLL || 5));
    const detailIssues = [];
    let subjectsChanged = 0;
    let metaSaved = 0;
    let imagesSaved = 0;
    for (const m of targets.slice(0, detailCap)) {
      try {
        const r = await resolveDetailRows(env, jar, { examId: m.examId, examTypeId: m.examTypeId });
        if (r.rows.length) subjectsChanged += await st.syncSubjects(m.examKey, r.rows, nowIso);
        if (r.meta) { await st.saveExamMeta(m.examKey, r.meta, nowIso); metaSaved += 1; }
        // 答题卡：原卷图不在 HTML 里（那是 Vue 模板），走页面脚本用的两个接口再深度挖 URL
        try {
          const groups = [];
          const originals = [];
          const ovStats = { tried: 0, ok: 0, parsed: 0 };
          let fallback = [];
          let urls = [];
          try {
            const sheetData = await fetchAnswerSheetData(env, jar, m.examId);
            fallback = collectImageUrls(sheetData.payloads);
            // 原卷图真正的来源：按科逐个 POST originalVolume（paper.js 里的真实调用）
            for (const p of sheetData.papers || []) {
              try {
                ovStats.tried += 1;
                const ov = await fetchOriginalVolume(env, jar, m.examId, p.sysCourseId);
                ovStats.ok += 1;
                const mine = collectImageUrls(ov);
                let parsed = summarizeOriginalVolume(ov);
                if (parsed) {
                  ovStats.parsed += 1;
                  // 真实像素尺寸：有它就按真实比例画框（没有则退回按块外扩推算）
                  const realDims = {};
                  for (const pg of parsed.pages) {
                    try {
                      const info = await fetchImageInfo(env, pg.url);
                      if (info) realDims[pg.page] = info;
                    } catch { /* 取不到就沿用推算 */ }
                  }
                  if (Object.keys(realDims).length) {
                    parsed = summarizeOriginalVolume(ov, realDims) || parsed;
                    ovStats.realDims = (ovStats.realDims || 0) + 1;
                  }
                }
                if (parsed) {
                  originals.push({ subject: p.courseName || String(p.sysCourseId), ...parsed });
                }
                if (mine.length) groups.push({ subject: p.courseName || String(p.sysCourseId), urls: pickAnswerSheetImages(mine) });
                urls = urls.concat(mine);
              } catch (e2) {
                if (e2 && e2.kind === 'auth_expired') throw e2;
                ovStats.tried += 1;
                detailIssues.push(m.examId + ' 原卷 ' + p.sysCourseId + ' ' + ((e2 && e2.kind) || 'error') + ':' + String((e2 && e2.message) || '').slice(0, 60));
              }
            }
            urls = pickAnswerSheetImages(urls.filter((u2, i2) => urls.indexOf(u2) === i2));
            // papers 与 originals 必须一次写完：分两次写时，后一次会用不含 originals 的对象覆盖前一次（真踩过）
            const metaExtra = {};
            if (originals.length) metaExtra.originals = originals;
            if (sheetData.papers && sheetData.papers.length) metaExtra.papers = sheetData.papers;
            if (Object.keys(metaExtra).length) {
              const payload = { ...(r.meta || {}), ...metaExtra };
              await st.saveExamMeta(m.examKey, payload, nowIso);
              if (String(m.examId) !== String(m.examKey)) {
                await st.saveExamMeta(String(m.examId), payload, nowIso);
              }
            }
          } catch (e) {
            if (e && e.kind === 'auth_expired') throw e;
            detailIssues.push(m.examId + ' 答题卡接口 ' + ((e && e.kind) || 'error'));
          }
          if (!urls.length) {
            const sheet = await fetchAnswerSheetHtml(env, jar, m.examId);
            urls = pickAnswerSheetImages(extractImageUrls(sheet.html, originOf(env)));
          }
          // 一科都没归上时，才把 baseInfo / HTML 里挖到的图当作「无科目」兜底
          if (!groups.length) {
            if (!urls.length && fallback.length) urls = fallback;
            if (urls.length) groups.push({ subject: '', urls });
          }
          detailIssues.push(m.examId + ' 原卷统计 试' + ovStats.tried + '/成' + ovStats.ok + '/解析' + ovStats.parsed + '/块' + originals.length);
          imagesSaved += await st.saveExamImages(m.examKey, groups, nowIso);   // 传空也会清掉旧地址
          if (groups.length) run.subjectsWithSheets = groups.length;
        } catch (e) {
          if (!(e && e.kind === 'auth_expired')) detailIssues.push(m.examId + ' 答题卡 ' + ((e && e.kind) || 'error'));
        }
        if (!r.rows.length && !r.meta) detailIssues.push(m.examId + ' 无明细');
      } catch (e) {
        detailIssues.push(m.examId + ' ' + ((e && e.kind) || 'error'));
      }
    }
    run.subjectsChanged = subjectsChanged;
    run.metaSaved = metaSaved;
    run.imagesSaved = imagesSaved;

    run.examsSeen = items.length;
    run.eventsCreated = effective.length;
    if (coldStart) {
      run.status = 'baseline';
      run.message = '首次运行建立基线，记录 ' + items.length + ' 份成绩单（不产生事件）';
    } else if (effective.length > 0) {
      run.status = 'changed';
      run.message = '发现 ' + effective.length + ' 条变化：' + effective.map((e) => (EVENT_LABELS[e.kind] || e.kind) + '/' + (e.subjectName || e.examId)).join('、').slice(0, 200);
    } else {
      run.status = 'ok';
      run.message = '无变化（共 ' + items.length + ' 份成绩单）';
    }
    if (detailIssues.length) run.message = (run.message || '') + ' | 明细: ' + detailIssues.join('、');
  } catch (e) {
    const { kind, status } = statusOf(e);
    run.status = status;
    run.httpStatus = e && e.httpStatus ? e.httpStatus : null;
    run.message = (kind + ': ' + (e && e.message ? e.message : String(e))).slice(0, 500);
    if (kind === 'login_failed' || kind === 'config_error') {
      try { await st.saveSession([], false, run.message, new Date().toISOString()); } catch { /* 记录失败不影响主流程 */ }
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - t0;
    try {
      await st.insertRun(run);
      await st.pruneRuns(300);
    } catch (e) {
      run.message = (run.message || '') + ' | poll_runs 写入失败: ' + (e && e.message ? e.message : String(e));
    }
  }
  return run;
}

/* ============================ 管理端数据 ============================ */

function meanIntervalMinutes(runs) {
  const times = runs.map((r) => Date.parse(r.started_at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.round((median / 60000) * 10) / 10;
}

async function buildState(env, accountId = 0) {
  const st = scopedStore(env.DB, Number(accountId) || 0);
  const [session, snapshots, events, runs, snapshotCount, subjectMap, metaMap, imageMap] = await Promise.all([
    st.getSession().catch(() => null),
    st.listSnapshots(200),
    st.listEvents(200),
    st.listRuns(20),
    st.countSnapshots().catch(() => 0),
    st.loadAllSubjects().catch(() => new Map()),
    st.loadAllExamMeta().catch(() => new Map()),
    st.loadAllExamImages().catch(() => new Map()),
  ]);
  const imagesOut = {};
  for (const [k, v] of imageMap) imagesOut[k] = v;
  const metaOut = {};
  for (const [k, v] of metaMap) metaOut[k] = v;
  for (const r of snapshots) {
    if (!metaOut[r.exam_id] && metaMap.get(r.exam_key)) metaOut[r.exam_id] = metaMap.get(r.exam_key);
  }
  const since = Date.now() - 24 * 3600 * 1000;
  const last24h = events.filter((e) => Date.parse(e.detected_at) >= since).length;

  // 科目名 → 考试名：subjectName 只有"数学/物理/多科"这种标签，没有信息量，这里换成真正的考试名称
  const titleByKey = new Map();
  const subjectOut = {};
  const enrichedSnapshots = snapshots.map((r) => {
    let raw = null;
    try { raw = JSON.parse(r.raw_json); } catch { raw = null; }
    const title = resolveExamTitle(raw) || ((r.subject_name || '考试') + ' #' + r.exam_id);
    titleByKey.set(r.exam_key, title);
    // 满分：上游有就用上游的，没有就按高中标准（语数英 150，其余 100；多科合计 1050）
    const multi = isMultiSubject(raw);
    // 科目行：上游没给满分就按高中标准补齐；「总分/合计」这类行单独标记，不参与求和，否则会翻倍
    const subsAll = (subjectMap.get(r.exam_key) || []).map((x) => {
      const isTotal = /总分|合计|总计/.test(String(x.subject || ''));
      const f = Number(x.full) > 0 ? Number(x.full) : standardFull(x.subject) || (isTotal ? MULTI_FULL : null);
      const n = x.score === null || x.score === undefined ? NaN : parseFloat(String(x.score));
      return {
        subject: x.subject,
        score: x.score,
        full: f,
        ratio: f && isFinite(n) ? Math.max(0, Math.min(1, n / f)) : null,
        isTotal,
      };
    });
    // 合成科目（史地政/理综/文综）与「总分」都是派生行，参与求和会把成绩翻倍
    const isAgg = (name) => /史地政|理综|文综/.test(String(name || ''));
    const subs = subsAll.filter((x) => !x.isTotal && !isAgg(x.subject));
    subjectOut[r.exam_key] = subsAll;
    let full = null;
    if (multi) {
      const sum = subs.reduce((acc, x) => acc + (x.full || 0), 0);
      full = sum > 0 ? sum : MULTI_FULL;
    } else {
      full = standardFull(r.subject_name);
    }
    const num = r.score_text === null || r.score_text === undefined ? NaN : parseFloat(String(r.score_text));
    const ratio = full && isFinite(num) ? Math.max(0, Math.min(1, num / full)) : null;
    return {
      exam_key: r.exam_key,
      exam_id: r.exam_id,
      exam_type_id: r.exam_type_id,
      subject_name: r.subject_name,
      score_text: r.score_text,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      last_change_at: r.last_change_at,
      title,
      exam_date: resolveExamDate(raw),
      is_multi: multi ? 1 : 0,
      full,
      ratio,
    };
  });
  const enrichedEvents = events.map((e) => ({ ...e, title: titleByKey.get(e.exam_key) || e.subject_name || ('#' + e.exam_id) }));
  return {
    ok: true,
    now: new Date().toISOString(),
    config: {
      upstream: originOf(env),
      usernameSet: !!env.HXXAI_USERNAME,
      passwordSet: !!env.HXXAI_PASSWORD,
      adminPasswordSet: !!env.ADMIN_PASSWORD,
      pollPageSize: Number(env.POLL_PAGE_SIZE || 50),
      maxPollPages: Number(env.MAX_POLL_PAGES || 2),
    },
    session: session
      ? { updatedAt: session.updatedAt, loginOk: session.loginOk, loginMsg: session.loginMsg, cookieNames: (session.jar || []).map((c) => c.name), cookieCount: (session.jar || []).length }
      : null,
    snapshotCount,
    subjects: subjectOut,
    meta: metaOut,
    images: imagesOut,
    snapshots: enrichedSnapshots,
    events: enrichedEvents,
    runs,
    stats: { last24h, observedIntervalMinutes: meanIntervalMinutes(runs) },
  };
}

/** 保证有会话；遇到 auth_expired 自动重登一次再重试 */
async function withSession(env, fn) {
  let session = await store.getSession(env.DB);
  let jar = session ? session.jar : [];
  if (!session || !session.loginOk || jar.length === 0) {
    const l = await login(env);
    jar = l.jar;
    await store.saveSession(env.DB, jar, true, l.message, new Date().toISOString());
  }
  try {
    return await fn(jar);
  } catch (e) {
    if (e && e.kind === 'auth_expired') {
      const l = await login(env);
      jar = l.jar;
      await store.saveSession(env.DB, jar, true, l.message, new Date().toISOString());
      return await fn(jar);
    }
    throw e;
  }
}

/**
 * 三级取数核心（不含会话管理）：给定 jar，返回 {source, rows, attempts}。
 * auth_expired 向上抛，交给 withSession 重登后重试。
 */
async function resolveDetailRows(env, jar, opts) {
  const examId = String(opts.examId);
  const examTypeId = opts.examTypeId ? String(opts.examTypeId) : null;
  const attempts = [];
  let meta = null;
  let metaText = null;

  // ① 先抓整页报告：既有各科分数，也有「考试信息 / 试卷信息 / 评语」，一次请求两用
  try {
    const page = await fetchReportHtml(env, jar, { examId, examTypeId, customConfigId: 0, sysCourseId: 0 });
    const paper = parsePaperInfo(page.html);
    meta = paper.info;
    metaText = paper.info ? null : paper.text;
    const parsed = parseScoresFromHtml(page.html);
    attempts.push({ source: 'alldetail-html', rows: parsed.rows.length, meta: !!meta });
    if (parsed.normalized) return { source: 'alldetail-html', rows: parsed.rows, meta, attempts };
  } catch (e) {
    if (e && e.kind === 'auth_expired') throw e;
    attempts.push({ source: 'alldetail-html', error: (e && e.kind) || 'error' });
  }

  try {
    const d = await fetchExamDetail(env, jar, { examId });
    const rawList = Array.isArray(d.raw) ? d.raw : (d.raw && (d.raw.examReportList || d.raw.reportList || d.raw.list)) || [];
    const sum = summarizeDetail(rawList);
    attempts.push({ source: 'examReportList', rows: sum.rows.length, directForward: d.directForward });
    if (sum.normalized) return { source: 'examReportList', rows: sum.rows, meta, attempts };
  } catch (e) {
    if (e && e.kind === 'auth_expired') throw e;
    attempts.push({ source: 'examReportList', error: (e && e.kind) || 'error' });
  }

  try {
    const cs = await fetchExamCourse(env, jar, { examId });
    const csum = summarizeCourseList(cs.courseList);
    const scored = csum.rows.filter((r) => r.score !== null);
    attempts.push({ source: 'examCourse', courses: csum.rows.length, scored: scored.length });
    if (csum.normalized) return { source: 'examCourse', rows: scored, meta, attempts };
  } catch (e) {
    if (e && e.kind === 'auth_expired') throw e;
    attempts.push({ source: 'examCourse', error: (e && e.kind) || 'error' });
  }

  return { source: null, rows: [], meta, metaText, attempts };
}

/**
 * 单场考试明细（管理界面「明细」按钮用）。日常数据已由 runPoll 预取入库，
 * 这里只在库里还没有该考试、或需要强制刷新时走一次上游。
 */
async function buildDetail(env, opts) {
  const accountId = Number(opts.accountId) || 0;
  const st = scopedStore(env.DB, accountId);
  const examId = String(opts.examId);
  const examTypeId = opts.examTypeId ? String(opts.examTypeId) : null;
  const cacheKey = examId + '|' + (examTypeId || '');
  const hit = detailCache.get(cacheKey);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.value;

  let value;
  try {
    // 库里有就直接用（轮询时已存），没有再打上游
    const storedMeta = await st.loadAllExamMeta().catch(() => new Map());
    const storedSubs = await st.loadAllSubjects().catch(() => new Map());
    const storedImgs = await st.loadAllExamImages().catch(() => new Map());
    const hasMeta = storedMeta.has(examId);
    const hasSubs = (storedSubs.get(examId) || []).length > 0;
    if (hasMeta || hasSubs) {
      const m = storedMeta.get(examId);
      const rows = (storedSubs.get(examId) || []).map((x) => ({ subject: x.subject, score: x.score, full: x.full }));
      value = { ok: true, examId, source: 'db', normalized: rows.length > 0, total: rows.length, rows, meta: m ? m.info : null, images: storedImgs.get(examId) || [], attempts: [{ source: 'db' }] };
      detailCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    const r = await withSession(env, (jar) => resolveDetailRows(env, jar, { examId, examTypeId }));
    value = {
      ok: true,
      examId,
      source: r.source,
      normalized: r.rows.length > 0,
      total: r.rows.length,
      rows: r.rows,
      meta: r.meta || null,
      images: storedImgs.get(examId) || [],
      metaText: r.meta ? null : (r.metaText || null),
      attempts: r.attempts,
    };
  } catch (e) {
    value = { ok: false, examId, error: (e && e.kind) || 'error', message: String((e && e.message) || e), attempts: [] };
  }

  detailCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function buildDiagnose(env) {
  const out = {
    ok: true,
    origin: originOf(env),
    config: { usernameSet: !!env.HXXAI_USERNAME, passwordSet: !!env.HXXAI_PASSWORD, adminPasswordSet: !!env.ADMIN_PASSWORD, sessionSecretSet: !!env.SESSION_SECRET },
    steps: [],
  };
  let jar = [];
  try { const s = await store.getSession(env.DB); if (s) jar = s.jar; } catch { /* 无会话也能继续 */ }

  try {
    const rep = await probeReportPage(env, jar);
    out.steps.push({ step: 'GET /report（当前已存会话）', ok: true, status: rep.status, title: rep.title, length: rep.length, sample: rep.sample });
  } catch (e) {
    out.steps.push({ step: 'GET /report（当前已存会话）', ok: false, message: String(e && e.message) });
  }

  try {
    const l = await login(env);
    jar = l.jar;
    out.steps.push({
      step: 'POST /api/account/userLogin',
      ok: true,
      message: l.message,
      cookieNames: l.jar.map((c) => c.name),
      dataKeys: l.data && typeof l.data === 'object' ? Object.keys(l.data) : [],
    });
  } catch (e) {
    out.steps.push({ step: 'POST /api/account/userLogin', ok: false, kind: e && e.kind, message: String(e && e.message), raw: e && e.raw });
    return out;
  }

  try {
    const d = await fetchExamList(env, jar);
    out.steps.push({ step: 'GET /api/examReport/examList', ok: true, count: d.list.length, totalPage: d.totalPage, sample: d.list.slice(0, 3) });
  } catch (e) {
    out.steps.push({ step: 'GET /api/examReport/examList', ok: false, kind: e && e.kind, message: String(e && e.message), raw: e && e.raw });
  }
  return out;
}

/* ============================ 登录 ============================ */

// 每个 isolate 只做一次建表/补列检查；失败也不抛，避免把请求打死
// 注意：Worker 不允许把 promise 存到模块级跨请求复用（会报
// "This promise was created by a request that has since ended"）。
// 因此这里只缓存「上次成功检查的时间戳」，每次请求自己创建并 await 自己的 promise。
const SCHEMA_CHECK_TTL_MS = 10 * 60 * 1000;
let schemaCheckedAt = 0;
async function ensureDb(env) {
  if (Date.now() - schemaCheckedAt < SCHEMA_CHECK_TTL_MS) return;
  try {
    await ensureSchema(env.DB);
    schemaCheckedAt = Date.now();
  } catch {
    /* 建表失败不阻塞请求；下次请求再试 */
  }
}

// 首次访问强制阅读的声明：注入到三个页面（/admin、/register、/account）
function withNotice(page) {
  const htmlText = String(page);
  if (htmlText.includes('id="hxNotice"')) return htmlText;
  return htmlText.includes('</body>') ? htmlText.replace('</body>', NOTICE_HTML + '</body>') : htmlText + NOTICE_HTML;
}

async function handleLogin(request, env) {
  if (!env.SESSION_SECRET || !env.DB) {
    return json({ ok: false, error: 'server_not_configured', message: '未设置 SESSION_SECRET 或未绑定 D1' }, 500);
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const attempt = await store.getLoginAttempt(env.DB, ip).catch(() => null);
  const blocked = store.blockedSeconds(attempt);
  if (blocked > 0) return json({ ok: false, error: 'too_many_attempts', retryAfter: blocked }, 429, { 'retry-after': String(blocked) });

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const username = String(body.username == null ? '' : body.username).trim();
  const password = String(body.password == null ? '' : body.password);

  // 账号不存在与口令错误返回同一个错误，避免账号枚举
  const result = await accounts.authenticate(env.DB, username, password);
  if (!result.ok) {
    await store.recordLoginFailure(env.DB, ip, new Date().toISOString()).catch(() => null);
    return json({ ok: false, error: 'bad_credentials', message: '账号或密码不正确' }, 401);
  }
  await store.clearLoginAttempts(env.DB, ip).catch(() => null);
  const hours = Math.max(1, Number(env.ADMIN_SESSION_HOURS || 12));
  const token = await createSessionToken(env.SESSION_SECRET, { accountId: result.account.id, username: result.account.username }, hours * 3600);
  return json({ ok: true, username: result.account.username }, 200, { 'set-cookie': sessionCookie(token, hours * 3600) });
}

/* ============================ 路由 ============================ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '' || path === '/') return Response.redirect(url.origin + '/admin', 302);
      if (path === '/healthz') return json({ ok: true, now: new Date().toISOString() });

      // 外部定时器专用入口：Pages 没有 Cron Triggers，只能由外部每 N 分钟打一次这个地址。
      // 没设 CRON_TOKEN 时此路由当作不存在（404），避免白白多开一个公开面。
      if (path === '/cron') {
        if (!env.CRON_TOKEN) return json({ ok: false, error: 'not_found' }, 404);
        const given = url.searchParams.get('token') || '';
        if (!(await passwordMatches(given, env.CRON_TOKEN, env.SESSION_SECRET || 'cron-token'))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        const run = await runPoll(env, { trigger: 'http-cron' });
        return json({ ok: run.status !== 'internal_error', run });
      }
      await ensureDb(env);

      if (path === '/register' && request.method === 'GET') return html(withNotice(REGISTER_HTML));
      if (path === '/register' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch { body = {}; }
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const att = await store.getLoginAttempt(env.DB, 'reg:' + ip).catch(() => null);
        const wait = store.blockedSeconds(att);
        if (wait > 0) return json({ ok: false, error: 'too_many_attempts', message: '尝试过于频繁，请 ' + wait + ' 秒后再试' }, 429, { 'retry-after': String(wait) });
        const created = await accounts.createAccount(
          env.DB,
          {
            username: body.username,
            password: body.password,
            upstreamUser: body.upstreamUser,
            upstreamSecret: body.upstreamSecret,
            sessionSecret: env.SESSION_SECRET,
          },
          new Date().toISOString()
        );
        if (!created.ok) {
          await store.recordLoginFailure(env.DB, 'reg:' + ip, new Date().toISOString()).catch(() => null);
          const code = created.error === 'duplicate' ? 409 : 400;
          return json({ ok: false, error: created.error, message: created.message }, code);
        }
        return json({ ok: true, username: created.account.username, id: created.account.id }, 201);
      }

      if (path === '/account' && request.method === 'GET') {
        const sess0 = await requireSession(request, env.SESSION_SECRET);
        if (!sess0.ok) return new Response(null, { status: 302, headers: { location: '/admin' } });
        return html(withNotice(ACCOUNT_HTML));
      }

      if (path === '/admin') return html(withNotice(ADMIN_HTML));

      if (path === '/admin/api/login' && request.method === 'POST') return await handleLogin(request, env);
      if (path === '/admin/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });

      if (path.startsWith('/admin/api/')) {
        const sess = await requireSession(request, env.SESSION_SECRET);
        if (!sess.ok) return json({ ok: false, error: 'unauthorized', reason: sess.reason }, 401);
        // 会话必须对应一个仍然存在的账号；账号被删除后旧 Cookie 立即失效
        const account = await accounts.getAccount(env.DB, sess.accountId).catch(() => null);
        if (!account) return json({ ok: false, error: 'unauthorized', reason: 'no_account' }, 401);

        if (path === '/admin/api/me' && request.method === 'GET') return json({ ok: true, username: account.username, upstreamUser: account.upstream_user || '' });

        if (path === '/admin/api/account/password' && request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch { body = {}; }
          const r = await accounts.changePassword(env.DB, account.id, body.password, new Date().toISOString());
          if (!r.ok) return json({ ok: false, error: r.error, message: r.message }, 400);
          return json({ ok: true });
        }

        if (path === '/admin/api/account/upstream' && request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch { body = {}; }
          const pass = body.upstreamSecret === undefined ? undefined : String(body.upstreamSecret || '');
          const up = await accounts.updateUpstream(env.DB, account.id, String(body.upstreamUser || '').trim(), pass, env.SESSION_SECRET, new Date().toISOString());
          if (!up.ok) return json({ ok: false, error: up.error, message: up.message }, 400);
          return json({ ok: true });
        }

        if (path === '/admin/api/account/delete' && request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch { body = {}; }
          if (body.confirm !== 'DELETE') return json({ ok: false, error: 'need_confirm', message: '需要确认才能注销' }, 400);
          // 先按前缀删掉该账号的全部数据，再删账号本身
          const pre = 'a' + account.id + '|';
          const like = pre + '%';
          await env.DB.batch([
            env.DB.prepare('DELETE FROM exam_snapshot WHERE exam_key LIKE ?').bind(like),
            env.DB.prepare('DELETE FROM exam_subject WHERE exam_key LIKE ?').bind(like),
            env.DB.prepare('DELETE FROM exam_meta WHERE exam_key LIKE ?').bind(like),
            env.DB.prepare('DELETE FROM exam_image WHERE exam_key LIKE ?').bind(like),
            env.DB.prepare('DELETE FROM events WHERE account_id = ?').bind(account.id),
            env.DB.prepare('DELETE FROM poll_runs WHERE account_id = ?').bind(account.id),
          ]);
          await accounts.deleteAccount(env.DB, account.id);
          return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
        }

        if (path === '/admin/api/state' && request.method === 'GET') return json(await buildState(env, account.id));
        if (path === '/admin/api/poll' && request.method === 'POST') {
          const run = await runPoll(env, { trigger: 'manual', account });
          return json({ ok: run.status !== 'internal_error', run, state: await buildState(env, account.id) });
        }
        if (path === '/admin/api/relogin' && request.method === 'POST') {
          const run = await runPoll(env, { trigger: 'manual', forceRelogin: true });
          return json({ ok: run.status !== 'auth_failed', run, state: await buildState(env, account.id) });
        }
        if (path === '/admin/api/diagnose' && request.method === 'GET') return json(await buildDiagnose(env));
        // 手动导入：把 DevTools 里复制的响应（JSON 或 HTML）整段贴进来，自动挖出图片地址
        if (path === '/admin/api/import-images' && request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch { body = {}; }
          const examKey = body.examKey ? String(body.examKey) : '';
          const text = typeof body.text === 'string' ? body.text : '';
          if (!examKey || !text.trim()) return json({ ok: false, error: 'missing_examKey_or_text' }, 400);
          let urls = [];
          try {
            const parsed = JSON.parse(text);
            urls = collectImageUrls(parsed);
          } catch { /* 不是 JSON，按 HTML 处理 */ }
          if (!urls.length) urls = extractImageUrls(text, originOf(env));
          if (!urls.length) return json({ ok: false, error: 'no_image_found', hint: '这段内容里没有识别到扫描件地址' }, 200);
          const changed = await store.saveExamImages(env.DB, examKey, urls, new Date().toISOString());
          return json({ ok: true, count: urls.length, changed, urls: urls.slice(0, 30), state: await buildState(env, account.id) });
        }
        if (path === '/admin/api/image' && request.method === 'GET') {
          const target = url.searchParams.get('u');
          if (!target) return json({ ok: false, error: 'missing_u' }, 400);
          let host = '';
          try { host = new URL(target).hostname; } catch { return json({ ok: false, error: 'bad_url' }, 400); }
          // 只代理 hxxai 自家的图，避免变成任意 URL 的开放代理
          if (!/(^|\.)hxxai\.com$/i.test(host)) return json({ ok: false, error: 'host_not_allowed' }, 403);
          try {
            const img = await fetchUpstreamImage(env, target);
            if (!img.ok) return json({ ok: false, error: 'upstream_' + img.status }, 502);
            return new Response(img.body, {
              status: 200,
              headers: {
                'content-type': img.headers.get('content-type') || 'image/jpeg',
                'cache-control': 'private, max-age=600',
                'x-content-type-options': 'nosniff',
              },
            });
          } catch (e) {
            return json({ ok: false, error: 'proxy_error', message: String((e && e.message) || e) }, 502);
          }
        }
        if (path === '/admin/api/detail' && request.method === 'GET') {
          const examId = url.searchParams.get('examId');
          if (!examId) return json({ ok: false, error: 'missing_examId' }, 400);
          return json(await buildDetail(env, { examId, examTypeId: url.searchParams.get('examTypeId') , accountId: account.id }));
        }
        return json({ ok: false, error: 'not_found' }, 404);
      }
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'internal', message: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // 每个账号各自抓自己的成绩单，互不干扰；单个账号失败不影响其他账号
    ctx.waitUntil((async () => {
      await ensureDb(env);
      let list = [];
      try { list = await accounts.listAccounts(env.DB); } catch { list = []; }
      if (!list.length) {
        // 还没有任何账号时，跑一次“无归属”巡检，避免旧部署完全停摆
        await runPoll(env, { trigger: 'cron:' + (event && event.cron ? event.cron : '') });
        return;
      }
      for (const row of list) {
        try {
          const full = await accounts.getAccount(env.DB, row.id);
          if (full) await runPoll(env, { trigger: 'cron:' + (event && event.cron ? event.cron : ''), account: full });
        } catch { /* 单账号失败继续下一个 */ }
      }
    })());
  },
};

