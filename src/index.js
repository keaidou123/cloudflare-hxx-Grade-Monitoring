/**
 * 慧学星成绩单发布监控 —— Worker 入口
 *   定时：scheduled() -> runPoll()
 *   界面：/admin（密码保护）-> /admin/api/*
 * 所有管理端响应都带 Cache-Control: no-store（含登录态的响应绝不进 CDN 缓存）。
 */
import { login, fetchExamList, fetchExamDetail, fetchExamCourse, fetchReportHtml, fetchAnswerSheetHtml, fetchAnswerSheetData, fetchOriginalVolume, fetchImageInfo, fetchUpstreamImage, probeReportPage, UpstreamError, originOf } from './hxxai.js';
import { diffExams, EVENT_LABELS } from './diff.js';
import { resolveExamTitle, resolveExamDate, isMultiSubject, summarizeDetail, summarizeCourseList, parseScoresFromHtml, parsePaperInfo, extractImageUrls, collectImageUrls, pickAnswerSheetImages, summarizeOriginalVolume, keyNames, standardFull, MULTI_FULL } from './format.js';
import { requireSession, passwordMatches, createSessionToken, sessionCookie, clearSessionCookie } from './auth.js';
import * as store from './store.js';
import { scopedStore } from './scope.js';
import { ensureSchema } from './schema.js';
import * as accounts from './accounts.js';
import { REGISTER_HTML, ACCOUNT_HTML } from './pages.js';
import { ADMIN_HTML } from './adminHtml.js';

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

      if (path === '/register' && request.method === 'GET') return html(REGISTER_HTML);
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
        return html(ACCOUNT_HTML);
      }

      if (path === '/admin') return html(ADMIN_HTML);

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
