import test from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../src/hxxai.js';

const env = { UPSTREAM_ORIGIN: 'https://c.hxxai.com', HXXAI_USERNAME: 'u', HXXAI_PASSWORD: 'p', LOGIN_TYPE: '0' };

function okJson(obj, cookies) {
  const h = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies || []) h.append('set-cookie', c);
  return new Response(JSON.stringify(obj), { status: 200, headers: h });
}

test('上游第一次超时，自动重试一次后成功', async () => {
  let n = 0;
  const stub = async (url) => {
    n += 1;
    if (n === 1) throw new Error('The operation was aborted due to timeout');   // 模拟首次超时
    if (String(url).endsWith('/')) return new Response('<html>login</html>', { status: 200, headers: new Headers({ 'content-type': 'text/html' }) });
    return okJson({ msg: '登录成功', code: 200, data: {} }, ['JSESSIONID=s1; Path=/; HttpOnly']);
  };
  const out = await login(env, stub);
  assert.ok(out.jar.some((c) => c.name === 'JSESSIONID'), '重试后应拿到会话');
  assert.ok(n >= 3, '应发生重试，实际调用次数=' + n);
});

test('连续两次网络失败 → network_error，且报文里带路径与重试提示', async () => {
  const stub = async () => { throw new Error('The operation was aborted due to timeout'); };
  await assert.rejects(() => login(env, stub), (e) => {
    assert.equal(e.kind, 'network_error');
    assert.match(e.message, /已重试 1 次/);
    assert.match(e.message, /\//, '报文里应有请求路径');
    return true;
  });
});
