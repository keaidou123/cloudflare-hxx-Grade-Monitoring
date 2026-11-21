import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createD1 } from './d1shim.mjs';
import worker, { runPoll } from '../src/index.js';

const SCHEMA = fileURLToPath(new URL('../schema.sql', import.meta.url));

/** 假上游：只实现实测到的那三个端点，行为按真实响应形状复刻 */
function makeUpstream() {
  const state = { sessions: new Set(), exams: [], counter: 0, failExamList: 0, user: 'u', pass: 'p' };

  function respond(obj, setCookies) {
    const headers = new Headers({ 'content-type': 'application/json;charset=UTF-8' });
    for (const sc of setCookies || []) headers.append('set-cookie', sc);
    return new Response(JSON.stringify(obj), { status: 200, headers });
  }

  async function fetchStub(url, init = {}) {
    const u = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    const cookie = String((init.headers && (init.headers.cookie || init.headers.Cookie)) || '');
    const sid = (cookie.match(/JSESSIONID=([^;]+)/) || [])[1];

    if (u.pathname === '/') {
      const h = new Headers({ 'content-type': 'text/html;charset=UTF-8' });
      h.append('set-cookie', 'c_msid=anon-' + (++state.counter) + '; path=/; domain=hxxai.com; HttpOnly');
      return new Response('<html><title>慧学星家长学生登录</title></html>', { status: 200, headers: h });
    }
    if (u.pathname === '/api/account/userLogin' && method === 'POST') {
      const form = new URLSearchParams(String(init.body || ''));
      if (form.get('userName') !== state.user || form.get('password') !== state.pass) {
        return respond({ msg: '账号或密码错误', code: 500, data: '' });
      }
      const next = 'sess-' + (++state.counter);
      state.sessions.add(next);
      return respond({ msg: '登录成功', code: 200, data: { itemThirdId: 't1' } }, ['JSESSIONID=' + next + '; Path=/; HttpOnly']);
    }
    if (u.pathname === '/api/examReport/examList') {
      if (state.failExamList > 0) return respond({ msg: '系统繁忙', code: 500, data: '' });
      if (!sid || !state.sessions.has(sid)) return respond({ msg: '用户会话已经失效，请重新登录！', code: '401', data: '' });
      return respond({ msg: 'ok', code: '200', data: { list: state.exams, totalPage: 1, pageNumber: 1 } });
    }
    if (u.pathname === '/report') {
      if (!sid || !state.sessions.has(sid)) return new Response('<html><title>401 - 慧学星</title></html>', { status: 200 });
      return new Response('<html><title>成绩报告</title></html>', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }

  return { fetchStub, state };
}

function makeEnv(db) {
  return {
    DB: db,
    HXXAI_USERNAME: 'u',
    HXXAI_PASSWORD: 'p',
    ADMIN_PASSWORD: 'admin-pw',
    SESSION_SECRET: 'unit-test-secret',
    UPSTREAM_ORIGIN: 'https://c.hxxai.com',
    POLL_PAGE_SIZE: '50',
    MAX_POLL_PAGES: '2',
    SYS_COURSE_ID: '0',
    SYS_GRADE_ID: '0',
    SYS_EXAM_TYPE_ID: '0',
    LOGIN_TYPE: '0',
  };
}

test('端到端：基线 -> 无变化 -> 发布与涨分 -> 会话过期自动重登', async (t) => {
  const upstream = makeUpstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = upstream.fetchStub;
  const db = createD1(SCHEMA);
  const env = makeEnv(db);
  t.after(() => { globalThis.fetch = realFetch; db.close(); });

  upstream.state.exams = [
    { examId: 101, examTypeId: 1, subjectName: '语文', studentScore: 88 },
    { examId: 102, examTypeId: 1, subjectName: '数学', studentScore: 95 },
  ];

  const r1 = await runPoll(env, { trigger: 'test' });
  assert.equal(r1.status, 'baseline', '首次运行只建基线：' + r1.message);
  assert.equal(r1.examsSeen, 2);
  assert.equal(r1.eventsCreated, 0);
  assert.equal(r1.relogin, 1, '首次必须登录');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exam_snapshot').first().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').first().n, 0);

  const r2 = await runPoll(env, { trigger: 'test' });
  assert.equal(r2.status, 'ok');
  assert.equal(r2.eventsCreated, 0);

  upstream.state.exams = [
    { examId: 101, examTypeId: 1, subjectName: '语文', studentScore: 92 },
    { examId: 102, examTypeId: 1, subjectName: '数学', studentScore: 95 },
    { examId: 103, examTypeId: 1, subjectName: '物理', studentScore: 100 },
  ];
  const r3 = await runPoll(env, { trigger: 'test' });
  assert.equal(r3.status, 'changed');
  assert.equal(r3.eventsCreated, 2);

  const kinds = db.prepare('SELECT kind, subject_name, old_score, new_score FROM events ORDER BY id').all().results;
  // 事件顺序跟随上游 list 顺序：101 涨分在前，103 新发布在后
  assert.deepEqual(kinds.map((k) => k.kind), ['score_change', 'new_report']);
  assert.equal(kinds[0].subject_name, '语文');
  assert.equal(kinds[0].old_score, '88');
  assert.equal(kinds[0].new_score, '92');
  assert.equal(kinds[1].subject_name, '物理');

  const snap = db.prepare('SELECT score_num, last_change_at FROM exam_snapshot WHERE exam_key = ?').bind('101').first();
  assert.equal(snap.score_num, 92);
  assert.ok(snap.last_change_at, '变化时间要落库');

  // 上游把会话踢掉：必须自动重登一次并继续成功
  upstream.state.sessions.clear();
  const r4 = await runPoll(env, { trigger: 'test' });
  assert.equal(r4.relogin, 1, '会话失效应触发重登');
  assert.equal(r4.status, 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').first().n, 2, '重登不应产生重复事件');

  const runs = db.prepare('SELECT status FROM poll_runs ORDER BY id').all().results.map((r) => r.status);
  assert.deepEqual(runs, ['baseline', 'ok', 'changed', 'ok']);
});

test('失败隔离：抓取报错不改快照、不写事件；账号错了记为 auth_failed', async (t) => {
  const upstream = makeUpstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = upstream.fetchStub;
  const db = createD1(SCHEMA);
  const env = makeEnv(db);
  t.after(() => { globalThis.fetch = realFetch; db.close(); });

  upstream.state.exams = [{ examId: 201, subjectName: '英语', studentScore: 70 }];
  assert.equal((await runPoll(env)).status, 'baseline');

  upstream.state.failExamList = 1;
  const bad = await runPoll(env);
  assert.equal(bad.status, 'upstream_error');
  assert.ok(bad.message.startsWith('upstream_error'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exam_snapshot').first().n, 1, '失败不得删快照');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').first().n, 0, '失败不得写事件');

  upstream.state.failExamList = 0;
  upstream.state.pass = 'changed-password';
  const authFail = await runPoll(env, { forceRelogin: true });
  assert.equal(authFail.status, 'auth_failed');
  assert.ok(authFail.message.includes('账号或密码错误'), authFail.message);
});

test('管理界面：密码保护、no-store、未授权 401', async (t) => {
  const upstream = makeUpstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = upstream.fetchStub;
  const db = createD1(SCHEMA);
  const env = makeEnv(db);
  t.after(() => { globalThis.fetch = realFetch; db.close(); });

  upstream.state.exams = [{ examId: 301, subjectName: '化学', studentScore: 66 }];
  await runPoll(env);

  const page = await worker.fetch(new Request('https://w.example.com/admin'), env, {});
  assert.equal(page.status, 200);
  assert.match(await page.text(), /慧学星/);
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  const unauth = await worker.fetch(new Request('https://w.example.com/admin/api/state'), env, {});
  assert.equal(unauth.status, 401);

  const mkLogin = (pw, ip) => new Request('https://w.example.com/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ password: pw }),
  });

  const wrong = await worker.fetch(mkLogin('nope', '9.9.9.1'), env, {});
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'bad_password');

  const ok = await worker.fetch(mkLogin('admin-pw', '9.9.9.2'), env, {});
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /hw_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];

  const authed = await worker.fetch(new Request('https://w.example.com/admin/api/state', { headers: { cookie } }), env, {});
  assert.equal(authed.status, 200);
  const body = await authed.json();
  assert.equal(body.ok, true);
  assert.equal(body.snapshotCount, 1);
  assert.equal(body.config.passwordSet, true);
  assert.ok(!JSON.stringify(body).includes('admin-pw'), '响应里不能出现管理密码明文');
  assert.ok(!JSON.stringify(body).includes('"p"'), '响应里不能出现上游密码明文');

  const forged = await worker.fetch(new Request('https://w.example.com/admin/api/state', { headers: { cookie: cookie.slice(0, -3) + 'zzz' } }), env, {});
  assert.equal(forged.status, 401, '被篡改的签名必须拒绝');

  const redirect = await worker.fetch(new Request('https://w.example.com/'), env, {});
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), /\/admin$/);
});
