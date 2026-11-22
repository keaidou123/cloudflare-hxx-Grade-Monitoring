/**
 * 按账号隔离的数据访问层（第二阶段）。
 *
 * 做法：在不动既有表结构的前提下，把 exam_key 统一加 "a<账号>|" 前缀。
 * 这样 exam_snapshot / exam_subject / exam_meta / exam_image 的主键与索引原样可用，
 * 不同账号即使上游 examId 相同也不会互相覆盖；events / poll_runs 用 account_id 过滤。
 *
 * 用法：const st = scopedStore(env.DB, accountId); 之后签名与 store.js 相同但不再传 db。
 */

export function keyPrefix(accountId) {
  return 'a' + (Number(accountId) || 0) + '|';
}

export function scopedStore(db, accountId) {
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
