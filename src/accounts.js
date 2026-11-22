/**
 * 多账号：口令散列、上游密码封存、账号增删改查。
 *  - 口令只存 PBKDF2-SHA256 派生值（盐 + 迭代次数 + 结果），不可逆
 *  - 慧学星密码必须可还原（要拿去登录上游），因此用 AES-GCM 封存，
 *    密钥由 SESSION_SECRET 经 PBKDF2 派生；换 SESSION_SECRET 会导致上游密码需重填
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const USERNAME_RE = /^[A-Za-z0-9_\-]{3,24}$/;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 72;
export const MAX_ACCOUNTS = 20;

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

export function usernameProblem(username) {
  const u = String(username || '').trim();
  if (!u) return '账号名不能为空';
  if (u.length < 3 || u.length > 24) return '账号名长度需在 3～24 个字符之间';
  if (!USERNAME_RE.test(u)) return '账号名只能用字母、数字、下划线、短横线';
  return '';
}

export function passwordProblem(password) {
  const p = String(password || '');
  if (!p) return '密码不能为空';
  if (p.length < MIN_PASSWORD) return '密码至少 ' + MIN_PASSWORD + ' 位';
  if (p.length > MAX_PASSWORD) return '密码最多 ' + MAX_PASSWORD + ' 位';
  if (/^[0-9]+$/.test(p)) return '密码不能是纯数字';
  if (/^(.)\1+$/.test(p)) return '密码不能是同一个字符重复';
  return '';
}

export async function hashPassword(password, iterations = 150000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return { salt: b64url(salt), hash: b64url(hash), iterations };
}

export async function verifyPassword(password, row) {
  if (!row || !row.pwd_salt || !row.pwd_hash) return false;
  const salt = unb64url(row.pwd_salt);
  const expected = unb64url(row.pwd_hash);
  const actual = await pbkdf2(password, salt, Number(row.pwd_iter) || 150000);
  return timedEqual(actual, expected);
}

// —— 上游密码封存（AES-GCM，密钥由 SESSION_SECRET 派生）——
async function sealingKey(sessionSecret) {
  if (!sessionSecret) throw new Error('缺少 SESSION_SECRET，无法封存上游密码');
  const salt = enc.encode('hxxai-upstream-seal-v1');
  const raw = await pbkdf2(String(sessionSecret), salt, 60000);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(plain, sessionSecret) {
  if (!plain) return null;
  const key = await sealingKey(sessionSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plain))));
  return b64url(iv) + '.' + b64url(ct);
}

export async function openSecret(sealed, sessionSecret) {
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
export async function countAccounts(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM account').first();
  return row ? Number(row.n || 0) : 0;
}

export async function findAccountByUsername(db, username) {
  return await db.prepare('SELECT * FROM account WHERE username = ? COLLATE NOCASE').bind(String(username || '').trim()).first();
}

export async function getAccount(db, id) {
  return await db.prepare('SELECT * FROM account WHERE id = ?').bind(Number(id) || 0).first();
}

export async function listAccounts(db) {
  const rows = await db.prepare('SELECT id, username, upstream_user, created_at, updated_at FROM account ORDER BY id').all();
  return (rows && rows.results) || [];
}

/** 创建账号；重名/弱口令一律报错，绝不覆盖既有账号 */
export async function createAccount(db, { username, password, upstreamUser, upstreamSecret, sessionSecret }, nowIso) {
  const name = String(username || '').trim();
  const up = usernameProblem(name);
  if (up) return { ok: false, error: 'bad_username', message: up };
  const pp = passwordProblem(password);
  if (pp) return { ok: false, error: 'weak_password', message: pp };
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
export async function authenticate(db, username, password) {
  const row = await findAccountByUsername(db, username);
  const ok = row ? await verifyPassword(password, row) : false;
  if (!row || !ok) return { ok: false, error: 'bad_credentials', message: '账号或密码不正确' };
  return { ok: true, account: row };
}

export async function changePassword(db, id, password, nowIso) {
  const pp = passwordProblem(password);
  if (pp) return { ok: false, error: 'weak_password', message: pp };
  const h = await hashPassword(password);
  await db.prepare('UPDATE account SET pwd_salt = ?, pwd_hash = ?, pwd_iter = ?, updated_at = ? WHERE id = ?').bind(h.salt, h.hash, h.iterations, nowIso, Number(id)).run();
  return { ok: true };
}

export async function updateUpstream(db, id, upstreamUser, upstreamSecret, sessionSecret, nowIso) {
  const seal = upstreamSecret === undefined || upstreamSecret === null ? undefined : await sealSecret(upstreamSecret, sessionSecret);
  if (seal === undefined) {
    await db.prepare('UPDATE account SET upstream_user = ?, updated_at = ? WHERE id = ?').bind(upstreamUser || null, nowIso, Number(id)).run();
  } else {
    await db.prepare('UPDATE account SET upstream_user = ?, upstream_seal = ?, updated_at = ? WHERE id = ?').bind(upstreamUser || null, seal, nowIso, Number(id)).run();
  }
  return { ok: true };
}

export async function deleteAccount(db, id) {
  await db.prepare('DELETE FROM account WHERE id = ?').bind(Number(id)).run();
  await db.prepare('DELETE FROM account_session WHERE account_id = ?').bind(Number(id)).run();
  return { ok: true };
}

/** 取该账号可用的上游凭据：优先账号自带，否则回退到环境变量（兼容旧单账号部署） */
export async function upstreamCredentials(db, account, env, sessionSecret) {
  const user = (account && account.upstream_user) || env.HXXAI_USERNAME || '';
  let pass = '';
  if (account && account.upstream_seal) pass = await openSecret(account.upstream_seal, sessionSecret);
  if (!pass) pass = env.HXXAI_PASSWORD || '';
  return { username: String(user).trim(), password: String(pass) };
}
