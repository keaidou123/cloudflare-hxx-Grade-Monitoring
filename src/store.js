/**
 * D1 访问层。所有 SQL 都在这里，便于一处审查。
 * 所有时间列统一存 ISO8601 UTC 字符串（落盘用 UTC，展示时转 Asia/Shanghai）。
 */

export async function getSession(db) {
  const row = await db.prepare('SELECT cookies, updated_at, login_ok, login_msg FROM session WHERE id = 1').first();
  if (!row) return null;
  let jar = [];
  try { jar = JSON.parse(row.cookies); } catch { jar = []; }
  return { jar, updatedAt: row.updated_at, loginOk: !!row.login_ok, loginMsg: row.login_msg };
}

export async function saveSession(db, jar, loginOk, loginMsg, nowIso) {
  await db
    .prepare(
      'INSERT INTO session (id, cookies, updated_at, login_ok, login_msg) VALUES (1, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET cookies = excluded.cookies, updated_at = excluded.updated_at, login_ok = excluded.login_ok, login_msg = excluded.login_msg'
    )
    .bind(JSON.stringify(jar || []), nowIso, loginOk ? 1 : 0, loginMsg === undefined ? null : String(loginMsg))
    .run();
}

export async function countSnapshots(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM exam_snapshot').first();
  return row ? Number(row.n || 0) : 0;
}

export async function loadSnapshotMap(db) {
  const rows = await db.prepare('SELECT exam_key, exam_id, exam_type_id, subject_name, score_text, score_num, first_seen_at, last_seen_at, last_change_at FROM exam_snapshot').all();
  const map = new Map();
  for (const r of (rows && rows.results) || []) map.set(r.exam_key, r);
  return map;
}

export async function upsertSnapshot(db, item, nowIso, changed) {
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

export async function insertEvent(db, ev, nowIso) {
  await db
    .prepare(
      'INSERT INTO events (kind, exam_key, exam_id, exam_type_id, subject_name, old_score, new_score, delta, detected_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(ev.kind, ev.examKey, ev.examId, ev.examTypeId ?? null, ev.subjectName ?? null, ev.oldScore ?? null, ev.newScore ?? null, ev.delta ?? null, nowIso, ev.rawJson)
    .run();
}

export async function insertRun(db, run) {
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
export async function syncSubjects(db, examKey, rows, nowIso) {
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
export async function loadAllSubjects(db) {
  const rows = await db.prepare('SELECT exam_key, subject, score, full FROM exam_subject ORDER BY exam_key').all();
  const map = new Map();
  for (const r of (rows && rows.results) || []) {
    if (!map.has(r.exam_key)) map.set(r.exam_key, []);
    map.get(r.exam_key).push({ subject: r.subject, score: r.score, full: r.full });
  }
  return map;
}

/* ---------- 试卷信息 ---------- */

export async function saveExamMeta(db, examKey, payload, nowIso) {
  await db
    .prepare('INSERT INTO exam_meta (exam_key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(exam_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .bind(examKey, JSON.stringify(payload || null), nowIso)
    .run();
}

export async function loadAllExamMeta(db) {
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

export async function saveExamImages(db, examKey, groups, nowIso) {
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

export async function loadAllExamImages(db) {
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

export async function listEvents(db, limit = 200) {
  const rows = await db.prepare('SELECT id, kind, exam_key, exam_id, subject_name, old_score, new_score, delta, detected_at FROM events ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (rows && rows.results) || [];
}

export async function listSnapshots(db, limit = 200) {
  const rows = await db
    .prepare('SELECT exam_key, exam_id, exam_type_id, subject_name, score_text, first_seen_at, last_seen_at, last_change_at, raw_json FROM exam_snapshot ORDER BY last_seen_at DESC, exam_key DESC LIMIT ?')
    .bind(limit)
    .all();
  return (rows && rows.results) || [];
}

export async function listRuns(db, limit = 30) {
  const rows = await db
    .prepare('SELECT id, started_at, finished_at, status, http_status, exams_seen, events_created, relogin, duration_ms, message FROM poll_runs ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all();
  return (rows && rows.results) || [];
}

export async function pruneRuns(db, keep = 300) {
  await db.prepare('DELETE FROM poll_runs WHERE id NOT IN (SELECT id FROM poll_runs ORDER BY id DESC LIMIT ?)').bind(keep).run();
}

/* ---------- 管理端登录限流 ---------- */

export async function getLoginAttempt(db, ip) {
  return db.prepare('SELECT ip, count, window_start, blocked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
}

export async function recordLoginFailure(db, ip, nowIso, { maxFailures = 8, windowMs = 15 * 60 * 1000, blockMs = 15 * 60 * 1000 } = {}) {
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

export async function clearLoginAttempts(db, ip) {
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

/** 被限流则返回剩余秒数 */
export function blockedSeconds(row, nowMs = Date.now()) {
  if (!row || !row.blocked_until) return 0;
  const t = Date.parse(row.blocked_until);
  if (!Number.isFinite(t) || t <= nowMs) return 0;
  return Math.ceil((t - nowMs) / 1000);
}
