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
export const TITLE_KEYS = ['examName', 'examTitle', 'title', 'name', 'paperName'];
export const TYPE_KEYS = ['typeName', 'examTypeName'];
export const DATE_KEYS = ['examTime', 'examDate', 'examDay', 'testTime', 'startTime', 'beginTime', 'createTime'];

export function resolveExamTitle(raw) {
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

export function resolveExamDate(raw) {
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
export function isMultiSubject(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (str(raw.subjectName).includes('多科')) return true;
  const dp = raw.dataParent;
  return Array.isArray(dp) && dp.length > 1;
}

export const SUBJECT_KEYS = ['subjectName', 'courseName', 'subject', 'name'];
export const SCORE_KEYS = ['studentScore', 'score', 'examScore', 'totalScore', 'studentScoreNum'];
export const FULL_KEYS = ['fullScore', 'scoreFull', 'totalFullScore', 'paperScore', 'fullMarks'];

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
export function summarizeDetail(data) {
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
export function summarizeCourseList(courseList) {
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
export const SUBJECT_WHITELIST = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '技术', '史地政', '理综', '文综'];

/**
 * 多科明细的来源③：直接解析 /report/alldetail 的 HTML（用户截图里那一屏）。
 * 这一屏是服务端渲染的，科目名后面紧跟 "88 / 150" 这种文本，所以按科目名锚定取分数。
 * 宁可少解析，也不要把排名、人数、百分比误当成分数。
 */
export function parseScoresFromHtml(html) {
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
export const FULL_MARKS = { 语文: 150, 数学: 150, 英语: 150, 物理: 100, 化学: 100, 生物: 100, 政治: 100, 历史: 100, 地理: 100, 技术: 100, 史地政: 300, 理综: 300, 文综: 300 };
export const MULTI_FULL = 1050;

export function standardFull(subject) {
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

export function parsePaperInfo(html) {
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
export function extractImageUrls(html, origin = 'https://c.hxxai.com') {
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

export function collectImageUrls(value, out = [], depth = 0) {
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
export function pickAnswerSheetImages(urls) {
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
export function summarizeOriginalVolume(data, overrides) {
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
export function keyNames(items, limit = 3) {
  const keys = new Set();
  for (const it of (Array.isArray(items) ? items : []).slice(0, limit)) {
    if (it && typeof it === 'object') for (const k of Object.keys(it)) keys.add(k);
  }
  return [...keys];
}
