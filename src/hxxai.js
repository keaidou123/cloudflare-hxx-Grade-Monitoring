/**
 * 慧学星上游客户端。
 * 下面每个端点、每个参数名都来自实际抓取，不是猜的：
 *   POST /api/account/userLogin        —— 登录页 /assets/vue/login/index.js 的 loginSubmit()
 *   GET  /api/examReport/examList      —— 成绩单页 /assets/vue/report/index.js 的 getExamList()
 *   (未登录访问证明见 README 的"实测记录")
 * 请求编码为 application/x-www-form-urlencoded：站点用 jQuery $.ajax，默认序列化方式即此。
 */

export class UpstreamError extends Error {
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

export function originOf(env) {
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
export function parseSetCookie(line) {
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
export function mergeCookieJar(jar, setCookieLines, nowMs = Date.now()) {
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

export function cookieHeader(jar, nowMs = Date.now()) {
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

export async function login(env, fetchImpl = fetch) {
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
export async function fetchExamList(env, jar, opts = {}, fetchImpl = fetch) {
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
export async function fetchExamDetail(env, jar, opts, fetchImpl = fetch) {
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
export async function fetchExamCourse(env, jar, opts, fetchImpl = fetch) {
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
export async function fetchReportHtml(env, jar, opts, fetchImpl = fetch) {
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
export async function fetchAnswerSheetHtml(env, jar, examId, fetchImpl = fetch) {
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
export async function fetchAnswerSheetData(env, jar, examId, fetchImpl = fetch) {
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
export async function fetchOriginalVolume(env, jar, examId, sysCourseId, fetchImpl = fetch) {
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
export async function fetchImageInfo(env, imageUrl, fetchImpl = fetch) {
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
export async function fetchUpstreamImage(env, targetUrl, fetchImpl = fetch) {
  const res = await call(fetchImpl, targetUrl, {
    method: 'GET',
    headers: { 'user-agent': UA, referer: originOf(env) + '/', accept: 'image/avif,image/webp,image/*,*/*' },
  });
  return res;
}

/** 探测 /report 页面本身（未登录返回 401 HTML，已登录返回真实页面）——给"诊断"用 */
export async function probeReportPage(env, jar, fetchImpl = fetch) {
  const origin = originOf(env);
  const ck = cookieHeader(jar);
  const headers = { ...baseHeaders(origin + '/report'), accept: 'text/html,*/*', ...(ck ? { cookie: ck } : {}) };
  const res = await call(fetchImpl, origin + '/report', { method: 'GET', headers });
  const text = await res.text();
  const title = (text.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  return { status: res.status, title, length: text.length, sample: text.slice(0, 600) };
}
