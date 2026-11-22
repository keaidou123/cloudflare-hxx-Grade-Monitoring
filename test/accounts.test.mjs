import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usernameProblem, passwordProblem, hashPassword, verifyPassword,
  sealSecret, openSecret, MIN_PASSWORD, PBKDF2_ITERATIONS, phoneProblem,
} from '../src/accounts.js';

test('账号名校验：空、太短、非法字符、合法', () => {
  assert.match(usernameProblem(''), /不能为空/);
  assert.match(usernameProblem('ab'), /3～24/);
  assert.match(usernameProblem('张三丰'), /字母、数字/);
  assert.match(usernameProblem('a b'), /字母、数字/);
  assert.equal(usernameProblem('kevin'), '');
  assert.equal(usernameProblem('kevin_02'), '');
  assert.equal(usernameProblem('a-b-c'), '');
});

test('密码校验：空、过短、纯数字、单字符重复、合法', () => {
  assert.match(passwordProblem(''), /不能为空/);
  assert.match(passwordProblem('abc123'), /至少 8 位/);
  assert.match(passwordProblem('12345678'), /纯数字/);
  assert.match(passwordProblem('aaaaaaaa'), /同一个字符/);
  assert.equal(passwordProblem('abc12345'), '');
  assert.equal(passwordProblem('P@ssw0rd!'), '');
});

test('口令散列：不可逆、同密码不同盐、校验通过、错密码失败', async () => {
  const a = await hashPassword('correct horse', 1000);
  const b = await hashPassword('correct horse', 1000);
  assert.notEqual(a.salt, b.salt, '每次散列的盐必须不同');
  assert.notEqual(a.hash, b.hash, '盐不同则散列不同');
  assert.ok(!a.hash.includes('correct'), '散列里不能出现明文');
  const row = { pwd_salt: a.salt, pwd_hash: a.hash, pwd_iter: a.iterations };
  assert.equal(await verifyPassword('correct horse', row), true);
  assert.equal(await verifyPassword('wrong horse', row), false);
  assert.equal(await verifyPassword('', row), false);
});

test('上游密码封存：可还原、盐随机、换密钥解不开', async () => {
  const sealed1 = await sealSecret('hxxai-pass', 'secret-A');
  const sealed2 = await sealSecret('hxxai-pass', 'secret-A');
  assert.notEqual(sealed1, sealed2, 'AES-GCM 每次 iv 不同');
  assert.ok(!sealed1.includes('hxxai-pass'));
  assert.equal(await openSecret(sealed1, 'secret-A'), 'hxxai-pass');
  assert.equal(await openSecret(sealed1, 'secret-B'), '', '换 SESSION_SECRET 必须解不开');
  assert.equal(await openSecret(null, 'secret-A'), '');
  assert.equal(await openSecret('garbage', 'secret-A'), '');
});

test('MIN_PASSWORD 与文本文案一致', () => {
  assert.equal(MIN_PASSWORD, 8);
});

test('PBKDF2 迭代次数不得超过 Workers 上限 100000', () => {
  // Cloudflare 会在超过 100000 时抛 "iteration counts above 100000 are not supported"
  assert.ok(PBKDF2_ITERATIONS <= 100000, '实际=' + PBKDF2_ITERATIONS);
  assert.ok(PBKDF2_ITERATIONS >= 50000, '太低不安全');
});

test('手机号校验：位数、非数字、首位不对、合法', () => {
  assert.match(phoneProblem(''), /不能为空/);
  assert.match(phoneProblem('1380000'), /11 位/);
  assert.match(phoneProblem('138000000001'), /11 位/, '12 位要拒绝');
  assert.match(phoneProblem('abcdefghijk'), /只能是数字/);
  assert.match(phoneProblem('23800000000'), /1 开头/);
  assert.equal(phoneProblem('13800000000'), '');
  assert.equal(phoneProblem('15927531920'), '');
  assert.equal(phoneProblem('138 0000 0000'), '', '带空格/短横线应自动去掉');
});
