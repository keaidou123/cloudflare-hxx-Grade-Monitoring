import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createD1 } from './d1shim.mjs';
import worker from '../src/index.js';

const SCHEMA = fileURLToPath(new URL('../install.sql', import.meta.url));

test('三个页面都注入使用声明，且只注入一份', async (t) => {
  const db = createD1(SCHEMA);
  const env = { DB: db, SESSION_SECRET: 's', UPSTREAM_ORIGIN: 'https://c.hxxai.com' };
  t.after(() => db.close());
  for (const p of ['/admin', '/register']) {
    const res = await worker.fetch(new Request('https://w.example.com' + p), env, {});
    const htmlText = await res.text();
    assert.equal(res.status, 200, p);
    assert.equal((htmlText.match(/id="hxNotice"/g) || []).length, 1, p + ' 应只有一份声明');
    assert.ok(htmlText.includes('我已阅读并同意'), p + ' 缺确认按钮');
    assert.ok(htmlText.includes('Cloudflare 的境外服务器'), p + ' 缺出境告知');
    assert.ok(htmlText.includes('hxxai_notice_v1'), p + ' 缺本地记忆键');
    assert.ok(htmlText.indexOf('id="hxNotice"') < htmlText.indexOf('</body>'), p + ' 声明应在 body 内');
  }
});

test('声明弹窗：必须有 [hidden] 的显式规则，否则点确认不会消失（历史 bug）', async () => {
  const { NOTICE_HTML } = await import('../src/notice.js');
  assert.ok(NOTICE_HTML.includes('#hxNotice[hidden]{display:none!important}'), '缺少 [hidden] 显式规则');
  assert.ok(NOTICE_HTML.includes('hx-show') && NOTICE_HTML.includes('hx-hide'), '缺少进出场动画 class');
  assert.ok(NOTICE_HTML.includes('setTimeout') && NOTICE_HTML.includes('box.hidden = true'), '点击后必须真正隐藏');
});
