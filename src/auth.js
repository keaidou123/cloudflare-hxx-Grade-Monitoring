/**
 * 管理界面密码体系：
 *  - 口令只存在 Secrets（ADMIN_PASSWORD），代码与数据库里没有明文
 *  - 校验用 HMAC 后定长比较，避免明文比较的时序差
 *  - 会话 Cookie = base64url(payload) + '.' + base64url(HMAC)，密钥来自 SESSION_SECRET
 */

const encoder = new TextEncoder();
export const COOKIE_NAME = 'hw_session';

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

export async function hmacSha256(secret, message) {
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
export async function passwordMatches(input, expectedPassword, secret) {
  if (!expectedPassword || !secret) return false;
  const a = await hmacSha256(secret, 'password:' + String(input ?? ''));
  const b = await hmacSha256(secret, 'password:' + String(expectedPassword));
  return constantTimeEqual(a, b);
}

/** 生成会话令牌，payload 内含过期时间（epoch 秒） */
export async function createSessionToken(secret, arg = 12 * 3600, ttlSeconds) {
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

export async function verifySessionToken(secret, token) {
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

export function parseCookies(header) {
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

export function sessionCookie(token, maxAgeSeconds = 12 * 3600) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAgeSeconds;
}

export function clearSessionCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

/** 从请求里取出并校验会话；返回 {ok, exp, reason} */
export async function requireSession(request, secret) {
  const cookies = parseCookies(request.headers.get('cookie'));
  return verifySessionToken(secret, cookies[COOKIE_NAME]);
}
