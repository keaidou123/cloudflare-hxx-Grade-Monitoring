import { existsSync } from 'node:fs';
// 迁移文件在源码仓叫 migrate-007-accounts.sql，发布包里叫 migrations/005-accounts.sql — 两处都能跑
const MIG = (() => {
  const a = fileURLToPath(new URL('../migrate-007-accounts.sql', import.meta.url));
  const b = fileURLToPath(new URL('../migrations/005-accounts.sql', import.meta.url));
  return existsSync(a) ? a : b;
})();
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createD1 } from './d1shim.mjs';
import worker, { runPoll } from '../src/index.js';
import * as accounts from '../src/accounts.js';
import { REGISTER_HTML } from '../src/pages.js';

const SCHEMA = fileURLToPath(new URL('../schema.sql', import.meta.url));

const SECRET = 'unit-test-secret';

/** 多账号假上游：登录时记住 userName，之后按该 userName 返回各自的成绩单 */
function makeMultiUpstream() {
  const bySid = new Map();
  // 现在上游账号必须是 11 位手机号，假上游按手机号分组
  const examsByUser = {
    '13800000001': [{ examId: 101, examTypeId: 1, subjectName: '语文', studentScore: 88 }],
    '13800000002': [{ examId: 101, examTypeId: 1, subjectName: '语文', studentScore: 55 }],
    '13800000003': [{ examId: 101, examTypeId: 1, subjectName: '语文', studentScore: 70 }],
  };
  let n = 0;
  function respond(obj, sc) {
    const h = new Headers({ 'content-type': 'application/json;charset=UTF-8' });
    for (const c of sc || []) h.append('set-cookie', c);
    return new Response(JSON.stringify(obj), { status: 200, headers: h });
  }
  async function fetchStub(url, init = {}) {
    const u = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    const cookie = String((init.headers && (init.headers.cookie || init.headers.Cookie)) || '');
    const sid = (cookie.match(/JSESSIONID=([^;]+)/) || [])[1];
    if (u.pathname === '/') {
      const h = new Headers({ 'content-type': 'text/html;charset=UTF-8' });
      h.append('set-cookie', 'c_msid=anon-' + (++n) + '; path=/; domain=hxxai.com; HttpOnly');
      return new Response('<html><title>慧学星</title></html>', { status: 200, headers: h });
    }
    if (u.pathname === '/api/account/userLogin' && method === 'POST') {
      const form = new URLSearchParams(String(init.body || ''));
      const user = form.get('userName');
      if (!examsByUser[user]) return respond({ msg: '账号或密码错误', code: 500, data: '' });
      const next = 'sess-' + (++n) + '-' + user;
      bySid.set(next, user);
      return respond({ msg: '登录成功', code: 200, data: {} }, ['JSESSIONID=' + next + '; Path=/; HttpOnly']);
    }
    if (u.pathname === '/api/examReport/examList') {
      const user = bySid.get(sid);
      if (!user) return respond({ msg: '用户会话已经失效，请重新登录！', code: '401', data: '' });
      return respond({ msg: 'ok', code: '200', data: { list: examsByUser[user], totalPage: 1, pageNumber: 1 } });
    }
    if (u.pathname === '/report') return new Response('<html><title>成绩报告</title></html>', { status: 200 });
    return new Response('not found', { status: 404 });
  }
  return { fetchStub };
}

function makeEnv(db) {
  return {
    DB: db,
    SESSION_SECRET: SECRET,
    UPSTREAM_ORIGIN: 'https://c.hxxai.com',
    POLL_PAGE_SIZE: '50',
    MAX_POLL_PAGES: '2',
    SYS_COURSE_ID: '0',
    SYS_GRADE_ID: '0',
    SYS_EXAM_TYPE_ID: '0',
    LOGIN_TYPE: '0',
  };
}

// 每个用例用独立 IP，避免登录限流把测试打挂（随机 IP 会撞车，导致偶发 429）
let ipSeq = 0;
const nextIp = () => '10.0.' + Math.floor(++ipSeq / 250) + '.' + (ipSeq % 250);
const reg = (env, username, password, upstreamUser) => worker.fetch(new Request('https://w.example.com/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
  body: JSON.stringify({ username, password, upstreamUser, upstreamSecret: 'x' }),
}), env, {});

const login = (env, username, password) => worker.fetch(new Request('https://w.example.com/admin/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
  body: JSON.stringify({ username, password }),
}), env, {});

test('注册页含固定提示语，且只出现一次', () => {
  const phrase = '本网站登录系统较为简易，无找回方案，请牢记密码。';
  const times = REGISTER_HTML.split(phrase).length - 1;
  assert.equal(times, 1, '提示语必须存在且只出现一次');
});

test('8 个账号各自注册与登录，互不影响', async (t) => {
  const upstream = makeMultiUpstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = upstream.fetchStub;
  const db = createD1(SCHEMA, MIG);
  const env = makeEnv(db);
  t.after(() => { globalThis.fetch = realFetch; db.close(); });

  // 登录名必须 ≥3 位；上游账号必须是 11 位手机号（假上游只认前三个）
  const names = ['user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7', 'user8'];
  const upstreamOf = (n) => '138000000' + String(n.slice(4)).padStart(2, '0');
  const cookies = [];
  for (const n of names) {
    const r = await reg(env, n, 'pass12345', upstreamOf(n));
    assert.equal(r.status, 201, n + ' 注册应成功');
    const lr = await login(env, n, 'pass12345');
    assert.equal(lr.status, 200, n + ' 应能登录');
    cookies.push(lr.headers.get('set-cookie').split(';')[0]);
  }
  assert.equal(new Set(cookies).size, 8, '8 个会话必须互不相同');

  // 每个账号用自己的凭据去抓，且上游 examId 完全相同
  for (const n of ['user1', 'user2', 'user3']) {
    const acc = await accounts.findAccountByUsername(db, n);
    await runPoll(env, { account: acc });
  }

  const keys = db.prepare("SELECT exam_key FROM exam_snapshot ORDER BY exam_key").all().results.map((r) => r.exam_key);
  assert.equal(keys.length, 3, '三个账号各存一份，互不覆盖：' + keys.join(','));
  assert.ok(keys.every((k) => /^a\d+\|101$/.test(k)), '键必须带账号前缀：' + keys.join(','));

  // u1 登录后只看到自己的 88 分
  const s1 = await worker.fetch(new Request('https://w.example.com/admin/api/state', { headers: { cookie: cookies[0] } }), env, {});
  assert.equal(s1.status, 200);
  const b1 = await s1.json();
  assert.equal(b1.snapshotCount, 1);
  assert.ok(b1.snapshots.some((s) => String(s.score_text) === '88'), 'u1 应看到自己的 88');
  assert.ok(b1.snapshots.every((s) => String(s.score_text) !== '55'), 'u1 不能看到 u2 的 55');

  // u2 看不到 u1 的分
  const s2 = await worker.fetch(new Request('https://w.example.com/admin/api/state', { headers: { cookie: cookies[1] } }), env, {});
  const b2 = await s2.json();
  assert.equal(b2.snapshotCount, 1);
  assert.ok(b2.snapshots.some((s) => String(s.score_text) === '55'), 'u2 应看到自己的 55');
  assert.ok(b2.snapshots.every((s) => String(s.score_text) !== '88'), 'u2 不能看到 u1 的 88');
});

test('账号异常：重名 409、弱口令 400、越权/未登录 401、无找回入口', async (t) => {
  const upstream = makeMultiUpstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = upstream.fetchStub;
  const db = createD1(SCHEMA, MIG);
  const env = makeEnv(db);
  t.after(() => { globalThis.fetch = realFetch; db.close(); });

  assert.equal((await reg(env, 'dup', 'pass12345', '13800000001')).status, 201);
  const dup = await reg(env, 'dup', 'pass12345', '13800000001');
  assert.equal(dup.status, 409, '重名必须拒绝而不是覆盖');
  assert.equal((await dup.json()).error, 'duplicate');

  const badPhone = await reg(env, 'phoneuser', 'pass12345', '1380000');
  assert.equal(badPhone.status, 400, '手机号位数不对必须拒绝');
  assert.equal((await badPhone.json()).error, 'bad_phone');

  const weak = await reg(env, 'weakuser', 'abc', '13800000001');
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error, 'weak_password');

  const bad = await reg(env, 'bad user', 'pass12345', '13800000001');
  assert.equal(bad.status, 400, '非法账号名必须拒绝');

  // 未登录访问
  const unauth = await worker.fetch(new Request('https://w.example.com/admin/api/state'), env, {});
  assert.equal(unauth.status, 401);

  // 伪造会话
  const forged = await worker.fetch(new Request('https://w.example.com/admin/api/state', { headers: { cookie: 'hw_session=eyJleHAiOjk5OTk5OTk5OTl9.zzz' } }), env, {});
  assert.equal(forged.status, 401);

  const lr = await login(env, 'dup', 'pass12345');
  const cookie = lr.headers.get('set-cookie').split(';')[0];

  // 账号被删除后旧 Cookie 立即失效
  const acc = await accounts.findAccountByUsername(db, 'dup');
  await accounts.deleteAccount(db, acc.id);
  const after = await worker.fetch(new Request('https://w.example.com/admin/api/state', { headers: { cookie } }), env, {});
  assert.equal(after.status, 401, '账号删除后会话必须失效');

  // 没有任何找回/重置密码的接口
  for (const p of ['/admin/api/account/reset', '/admin/api/reset', '/forgot']) {
    const r = await worker.fetch(new Request('https://w.example.com' + p, { method: 'POST', headers: { cookie } }), env, {});
    assert.ok(r.status === 404 || r.status === 401, p + ' 不应存在（' + r.status + '）');
  }
});
