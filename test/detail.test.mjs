import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScoresFromHtml, summarizeCourseList, parsePaperInfo, extractImageUrls, collectImageUrls, pickAnswerSheetImages, summarizeOriginalVolume } from '../src/format.js';

// 结构照抄线上真实页面：标签在 <p class="font_grey">，值在 <p class="ft13">
const realPage = '<div class="msg font_title">高一数学周测1106</div>'
  + '<div class="msg_info"><span class="font_grey text-left"> 类型：周考 </span>'
  + '<span class="font_grey text-left">时间：2026-11-06</span>'
  + '<span class="font_grey text-left">实考考生：373</span></div>'
  + '<div class="panel_title font_title font_middle">数学试卷信息</div><div class="msgs">'
  + '<div class="sing_msg_info">'
  + '<span><p class="font_grey">满分</p> <p class="ft13">150分</p></span>'
  + '<span><p class="font_grey">客观题</p> <p class="ft13">11道/58分</p></span>'
  + '<span><p class="font_grey">试卷难度</p><p class="ft13">简单</p></span></div>'
  + '<div class="sing_msg_info">'
  + '<span><p class="font_grey">试题总数</p><p class="ft13">17道</p></span>'
  + '<span><p class="font_grey">主观题</p> <p class="ft13">6道/92分</p></span>'
  + '<span><p class="font_grey">试卷难度比例</p><p class="ft13">难中易 1:6:10</p></span></div></div>'
  + '<div>本次数学成绩被评定为 良好 ，距离优秀就差那么一点点，希望下次能有所突破。</div>';

test('parsePaperInfo 按真实页面结构抽出试卷信息', () => {
  const html = realPage;
  const r = parsePaperInfo(html);
  assert.ok(r.info);
  assert.equal(r.info.type, '周考');
  assert.equal(r.info.date, '2026-11-06');
  assert.equal(r.info.candidates, 373);
  assert.equal(r.info.full, 150);
  assert.deepEqual(r.info.objective, { count: 11, score: 58 });
  assert.deepEqual(r.info.subjective, { count: 6, score: 92 });
  assert.equal(r.info.questions, 17);
  assert.equal(r.info.difficulty, '简单');
  assert.equal(r.info.difficultyRatio, '1:6:10');
  assert.ok(r.info.comment.startsWith('良好'), '评语=' + r.info.comment);
});

test('parseScoresFromHtml 不会被单科页的杂项误匹配', () => {
  const single = '<div>数学</div><div>学生姓名：吴雨辰</div><div>数学 110 分</div><div>物理 1</div>';
  const r = parseScoresFromHtml(single);
  assert.equal(r.normalized, false, '少于 3 科不算多科明细页');
});

test('parsePaperInfo 对空页返回 null，不抛', () => {
  assert.equal(parsePaperInfo('').info, null);
  assert.equal(parsePaperInfo(null).info, null);
});

// 复刻用户截图那一屏的形态：科目名 与 分数/满分 相邻
const page = '<html><body><div class="k">语文</div><div class="v">88</div><div>/150</div>'
  + '<div class="k">数学</div><div class="v">99</div><div>/150</div>'
  + '<div class="k">政治</div><div class="v">57</div><div>/100</div><div>/B</div>'
  + '<div class="k">史地政</div><div class="v">154</div><div>/300</div>'
  + '<script>var x = {语文: 9999}</script></body></html>';

test('parseScoresFromHtml 按科目名锚定取分与满分', () => {
  const r = parseScoresFromHtml(page);
  assert.equal(r.normalized, true);
  assert.deepEqual(r.rows, [
    { subject: '语文', score: '88', full: 150 },
    { subject: '数学', score: '99', full: 150 },
    { subject: '政治', score: '57', full: 100 },
    { subject: '史地政', score: '154', full: 300 },
  ]);
});

test('parseScoresFromHtml 不吃 script 里的数字', () => {
  const r = parseScoresFromHtml('<script>语文 9999</script>');
  assert.equal(r.normalized, false);
});

test('parseScoresFromHtml 没有满分就不认（防止把页面杂项当成分数）', () => {
  const r = parseScoresFromHtml('<span>数学</span><span>93.5</span>');
  assert.deepEqual(r.rows, []);
  assert.equal(r.normalized, false);
});

test('parseScoresFromHtml 对空/垃圾输入不崩', () => {
  assert.equal(parseScoresFromHtml('').normalized, false);
  assert.equal(parseScoresFromHtml(null).normalized, false);
});

test('summarizeCourseList 只有科目名没有分数时 normalized=false', () => {
  const r = summarizeCourseList([{ courseName: '语文', sysCourseId: 2 }, { courseName: '数学', sysCourseId: 3 }]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.normalized, false);
});

test('summarizeCourseList 带分数时可用', () => {
  const r = summarizeCourseList([{ courseName: '语文', score: 88, fullMark: 150 }]);
  assert.equal(r.normalized, true);
  assert.deepEqual(r.rows[0], { subject: '语文', score: '88', full: 150 });
});

test('extractImageUrls 丢掉「致家长的一封信」这类站点装饰图', () => {
  const html = '<img src="https://c.hxxai.com/assets/img/2fscoreSearch/banner.png">'
    + '<img data-src="https://oss.hxxai.com/srcImgOK/377704/1/2/srcImgOK.png">'
    + '<script>var u = "https://oss.hxxai.com/srcImgOK/377704/3/4/srcImgOK.jpeg";</script>';
  const urls = extractImageUrls(html);
  assert.equal(urls.length, 2, JSON.stringify(urls));
  assert.ok(urls.every((u) => u.includes('srcImgOK')));
});

test('extractImageUrls 只留 hxxai 域下的答题卡图', () => {
  const html = '<img src="https://oss.hxxai.com/srcImgOK/377704/1/2/srcImgOK.png">'
    + '<img src="//oss.hxxai.com/srcImgOK/377704/3/4/srcImgOK.png">'
    + '<img src="/assets/images/logo.png">'
    + '<img src="https://evil.example.com/x.png">'
    + '<img src="data:image/png;base64,AAA">';
  const urls = extractImageUrls(html);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.includes('oss.hxxai.com')));
  assert.ok(urls[1].startsWith('https://oss.hxxai.com/'));
});

test('collectImageUrls 从接口 JSON 里挖出原卷图（不依赖字段名）', () => {
  const payload = {
    examCourseList: [
      { courseName: '数学', originalImg: 'https://oss.hxxai.com/srcImgOK/377704/1/2/srcImgOK.png' },
      { courseName: '语文', originalImgs: ['https://oss.hxxai.com/srcImgOK/377704/3/4/srcImgOK.jpg', 'https://c.hxxai.com/assets/img/x.png'] },
    ],
    scoreList: [{ picUrl: 'https://oss.hxxai.com/srcImgOK/377704/5/6/srcImgOK.webp' }],
    examInfo: { examName: '高一数学周测1106', logo: 'https://c.hxxai.com/assets/logo.png' },
  };
  const urls = collectImageUrls(payload);
  assert.equal(urls.length, 3, JSON.stringify(urls));
  assert.ok(urls.every((u) => u.includes('srcImgOK')));
});

test('collectImageUrls 认得接口里的相对路径', () => {
  const urls = collectImageUrls({ originalImg: '/srcImgOK/377704/348046/386231/srcImgOK.png' });
  assert.deepEqual(urls, ['https://oss.hxxai.com/srcImgOK/377704/348046/386231/srcImgOK.png']);
});



test('pickAnswerSheetImages 答卷在前、扣分图层在后', () => {
  const all = [
    'https://c.hxxai.com/assets/img/original_i1.png',
    'https://oss.hxxai.com/srcImgOK/377704/348046/386231/srcImgOK.png',
    'https://c.hxxai.com/assets/img/original_i2.png',
  ];
  const got = pickAnswerSheetImages(all);
  assert.equal(got.length, 3, JSON.stringify(got));
  assert.ok(got[0].includes('srcImgOK'), '答卷应排第一');
  assert.ok(got[2].includes('original_i2'), '扣分图层垫后');
});

test('collectImageUrls 认得扣分图层（/assets/img/original_iN.png）', () => {
  const urls = collectImageUrls({ a: '/assets/img/original_i1.png' });
  assert.deepEqual(urls, ['https://c.hxxai.com/assets/img/original_i1.png']);
  const abs = collectImageUrls({ b: 'https://c.hxxai.com/assets/img/original_i2.png' });
  assert.deepEqual(abs, ['https://c.hxxai.com/assets/img/original_i2.png']);
});

// 用线上真实响应裁出来的最小样本（2026-11-22 实测 377704 数学）
const realOriginalVolume = {
  paper: {
    paperURLs: [
      { zipFileId: '386231', fileUrl: 'https://oss.hxxai.com/srcImgOK/377704/348046/386231/srcImgOK.png', pageNum: '1' },
      { zipFileId: '386232', fileUrl: 'https://oss.hxxai.com/srcImgOK/377704/348046/386232/srcImgOK.png', pageNum: '2' },
    ],
  },
  objects: [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ questionNumber: n, saveFileUrl: '1_2', scoreValue: 5, finallyScore: 5 })),
    { questionNumber: 8, saveFileUrl: '1_2', scoreValue: 5, finallyScore: 0 },
    { questionNumber: 9, saveFileUrl: '1_3', scoreValue: 6, finallyScore: 6 },
    { questionNumber: 10, saveFileUrl: '1_3', scoreValue: 6, finallyScore: 4 },
    { questionNumber: 11, saveFileUrl: '1_3', scoreValue: 6, finallyScore: 2 },
  ],
  subjectFiles: [
    { blockIndex: '1_2', zipFileId1: 386231, posInfo: '67-646-920-192', isObj: 0 },
    { blockIndex: '1_3', zipFileId1: 386231, posInfo: '67-920-920-154', isObj: 0 },
    { blockIndex: '1_4', posInfo: '67-1156-920-825', subjects: [{ zipFileId1: 386231, scoreValue: 15, finallyScore: 10 }] },
    { blockIndex: '2_1', posInfo: '1052-68-920-1911', subjects: [{ zipFileId1: 386231, scoreValue: 13, finallyScore: 13 }] },
    { blockIndex: '3_1', posInfo: '2033-68-920-1913', subjects: [{ zipFileId1: 386231, scoreValue: 17, finallyScore: 17 }] },
    { blockIndex: '4_1', posInfo: '67-67-917-1905', subjects: [{ zipFileId2: 386232, scoreValue: 15, finallyScore: 13 }] },
  ],
};

test('summarizeOriginalVolume 按块算出失分位置（真实响应形状）', () => {
  const r = summarizeOriginalVolume(realOriginalVolume);
  assert.equal(r.pages.length, 2, '两页答卷');
  assert.deepEqual(r.pages[0], { page: 1, url: 'https://oss.hxxai.com/srcImgOK/377704/348046/386231/srcImgOK.png' });
  // 1_2 丢 5、1_3 丢 6、1_4 丢 5；2_1 不丢 → 只有 3 个红框
  const lost = r.marks.map((m) => m.lost).sort((a, b) => a - b);
  assert.deepEqual(lost, [2, 5, 5, 6], JSON.stringify(r.marks));
  assert.ok(r.marks.every((m) => m.left >= 0 && m.left < 1 && m.top >= 0 && m.top < 1));
  assert.equal(r.marks.filter((m) => m.page === 1).length, 3, '第1页三块（zipFileId1=386231）');
  // 页宽 = 三栏最大右边界 2033+920=2953 → 单栏 920/2953≈0.31，不能接近整页
  assert.ok(r.marks.every((m) => m.width < 0.4), '红框宽度应约一栏：' + JSON.stringify(r.marks.map((m) => m.width)));
  // 第 2 页的块必须落在 page 2（zipFileId2=386232），否则会全挤到第 1 页
  const p2 = r.marks.filter((m) => m.page === 2);
  assert.equal(p2.length, 1, '第2页应有1个框：' + JSON.stringify(r.marks.map((m) => m.page)));
  assert.equal(p2[0].lost, 2);
  assert.equal(r.totalLost, 18);   // 5+6+5（第1页） + 2（第2页）
});

test('summarizeOriginalVolume 对空输入返回 null', () => {
  assert.equal(summarizeOriginalVolume(null), null);
  assert.equal(summarizeOriginalVolume({}), null);
});
