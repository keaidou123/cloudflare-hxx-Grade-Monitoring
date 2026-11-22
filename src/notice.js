/**
 * 首次访问强制阅读的使用声明。
 * 由服务端注入到 /admin、/register、/account 三个页面的 </body> 之前。
 * 点「我已阅读并同意」后写入 localStorage，之后不再显示。
 */
export const NOTICE_KEY = 'hxxai_notice_v1';

export const NOTICE_HTML = `<style>
/* 关键：id 选择器的 display:flex 会压过 [hidden] 的 display:none（浏览器默认样式优先级更低），
   所以必须显式把 [hidden] 规则写出来，否则点了确认也不消失、老用户还会每次都看到 */
#hxNotice[hidden]{display:none!important}
#hxNotice{position:fixed;inset:0;z-index:99999;background:rgba(3,5,8,.88);display:flex;align-items:center;justify-content:center;padding:20px;font:14px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:0;transition:opacity .22s ease}
#hxNotice.hx-show{opacity:1}
#hxNotice.hx-hide{opacity:0}
#hxNotice .box{transform:translateY(14px) scale(.975);opacity:0;transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .3s ease}
#hxNotice.hx-show .box{transform:none;opacity:1}
#hxNotice.hx-hide .box{transform:translateY(10px) scale(.98);opacity:0}
@media (prefers-reduced-motion:reduce){#hxNotice,#hxNotice .box{transition:none}}
#hxNotice .box{width:100%;max-width:620px;max-height:86vh;display:flex;flex-direction:column;background:#12171e;border:1px solid #2a3441;border-radius:10px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.6)}
#hxNotice .hd{padding:16px 20px;border-bottom:1px solid #232a33;display:flex;align-items:baseline;gap:10px}
#hxNotice .hd b{font-size:16px;color:#e6edf3}
#hxNotice .hd span{font-size:12px;color:#8b949e}
#hxNotice .bd{padding:6px 20px 14px;overflow-y:auto;color:#c9d1d9;font-size:13px}
#hxNotice .bd ol{margin:10px 0 0;padding-left:20px}
#hxNotice .bd li{margin:9px 0}
#hxNotice .bd b{color:#e6edf3}
#hxNotice .ft{padding:14px 20px;border-top:1px solid #232a33;display:flex;align-items:center;gap:12px}
#hxNotice .tip{flex:1;font-size:12px;color:#8b949e}
#hxNotice button{padding:10px 18px;border-radius:6px;border:1px solid #2f81f7;background:#1f6feb;color:#fff;font-size:14px;cursor:pointer}
#hxNotice button:disabled{background:#1a2230;border-color:#2a3441;color:#5a6675;cursor:not-allowed}
</style>
<div id="hxNotice" hidden>
  <div class="box">
    <div class="hd"><b>使用声明</b><span>首次使用必读 · 阅读到底部后可确认</span></div>
    <div class="bd" id="hxNoticeBody">
      <ol>
        <li><b>用途限制</b>：本系统仅供你本人／本家庭查看<b>自己孩子</b>的成绩。不得查看、收集、存储他人（含同学）的成绩或个人信息，不得对外提供、出售或公开分享。</li>
        <li><b>数据来源</b>：成绩、试卷信息、答题卡扫描件来自「慧学星」（四川云数赋智教育科技有限公司）。相关著作权与数据权利归原权利方，本系统仅作展示，不主张任何权利。</li>
        <li><b>存储位置</b>：你的账号与成绩数据保存在 <b>Cloudflare 的境外服务器</b>（D1 数据库）。这属于个人信息出境，你在此确认已知悉并同意。</li>
        <li><b>账号与密码</b>：登录系统较为简易，<b>没有找回密码方案</b>，请牢记密码。你填写的慧学星密码经加密后保存，仅用于自动登录上游抓取你自己的成绩。</li>
        <li><b>访问方式</b>：本系统用你提供的慧学星账号<b>正常登录</b>、按固定间隔读取你自己的成绩页面，未使用任何绕过鉴权、破解或撞库手段。若上游明确要求停止，请立即停用并删除数据。</li>
        <li><b>免责</b>：本项目由 <b>AI 辅助开发</b>，可能存在缺陷；作者不对使用过程中产生的任何问题（成绩显示错误或丢失、账号异常、违反第三方条款等）承担责任。</li>
        <li><b>停止使用</b>：你可以随时在「账号设置」页注销账号，该账号的全部成绩数据会被一并删除。</li>
      </ol>
    </div>
    <div class="ft">
      <div class="tip" id="hxNoticeTip">请向下滚动阅读全部内容</div>
      <button id="hxNoticeOk" disabled>我已阅读并同意</button>
    </div>
  </div>
</div>
<script>
(function () {
  try { if (localStorage.getItem('hxxai_notice_v1') === '1') return; } catch (e) {}
  var box = document.getElementById('hxNotice');
  var body = document.getElementById('hxNoticeBody');
  var btn = document.getElementById('hxNoticeOk');
  var tip = document.getElementById('hxNoticeTip');
  if (!box || !body || !btn) return;
  box.hidden = false;
  document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(function () { box.classList.add('hx-show'); });
  var need = 8;            // 最短阅读秒数
  var left = need;
  var scrolled = body.scrollHeight <= body.clientHeight + 4;   // 内容不满一屏视为已读完
  function refresh() {
    if (scrolled && left <= 0) {
      btn.disabled = false;
      tip.textContent = '已读完全部内容';
    } else if (!scrolled) {
      tip.textContent = '请向下滚动阅读全部内容';
    } else {
      tip.textContent = '请阅读 ' + left + ' 秒后可确认';
    }
  }
  body.addEventListener('scroll', function () {
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 6) { scrolled = true; refresh(); }
  });
  refresh();
  var timer = setInterval(function () {
    left -= 1;
    if (left <= 0) { left = 0; clearInterval(timer); }
    refresh();
  }, 1000);
  btn.addEventListener('click', function () {
    if (btn.disabled || box.getAttribute('data-closing') === '1') return;   // 防连点
    box.setAttribute('data-closing', '1');
    try { localStorage.setItem('hxxai_notice_v1', '1'); } catch (e) {}
    box.classList.remove('hx-show');
    box.classList.add('hx-hide');                 // 先播淡出+下移动画
    document.documentElement.style.overflow = '';
    setTimeout(function () {                      // 动画结束再真正移除
      box.hidden = true;
      box.classList.remove('hx-hide');
      box.removeAttribute('data-closing');
    }, 240);
  });
})();
</script>`;
