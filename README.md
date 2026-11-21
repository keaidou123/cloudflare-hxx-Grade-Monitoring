# 慧学星成绩单监控

自动记录慧学星（c.hxxai.com）成绩单的 Cloudflare Worker：每 5 分钟检查一次，有新成绩/涨分就记下来，并在一个带密码的管理页面里展示成绩、试卷信息、答题卡与扣分明细。

> 部署教程（小白向，一步一步）：见 [DEPLOY.md](DEPLOY.md)，纯文本版见 [DEPLOY.txt](DEPLOY.txt)。

## 能做什么

- 自动巡检：Cron 每 5 分钟拉一次成绩列表，冷启动第一次只建立基线，不误报
- 变化追踪：新发布成绩、单科分数变化都写成事件，页面顶部有时间线
- 试卷信息：类型、考试时间、实考人数、满分、客观题/主观题题数与分值、试题总数、难度、难中易比例、老师评语
- 科目明细：每科分数 / 满分 / 得分率 / 条形图 / 雷达图 / 排名（语数英 150，其余 100，合成科目 300，多科合计 1050）
- 答题卡：按科目分组的扫描件缩略图，点开看大图
- 扣分明细：按题目块坐标在答题卡上画红框并标注失分，底部给出合计（例：红框 6 处失分，合计 -32 分）
- 管理页：密码登录（HMAC 签名 Cookie + 登录频率限制），可手动检查、重新登录上游、诊断
- 数据持久：成绩、试卷信息、答题卡地址全部落在 D1，界面读库不现场打上游

## 目录结构

```
worker.js              单文件成品，粘进 Cloudflare Worker 就能跑（推荐小白用这个）
schema.sql             首次部署要执行的主建表语句
migrations/            增量迁移，按 001→004 顺序执行
wrangler.toml          可选：用命令行 wrangler 部署时用
src/                   源码（多文件，便于维护）
test/                  单元测试与集成测试（node --test）
package.json           仅本地开发需要
DEPLOY.md / DEPLOY.txt 部署教程
```

## 快速开始

1. 建 D1 数据库 → 执行 schema.sql 与 4 个迁移
2. 建 Worker → 粘贴 worker.js → 部署
3. 绑定 D1，变量名必须是 DB
4. 添加变量：HXXAI_USERNAME / HXXAI_PASSWORD 用「文本」，ADMIN_PASSWORD / SESSION_SECRET 用「机密」
5. 添加 Cron：*/5 * * * *
6. 打开 https://你的域名/admin，点「立即检查」

细节（每一步点哪里）都在 [DEPLOY.md](DEPLOY.md) 里；想换成自己的域名（更稳、更好记）见教程第 12 节「绑定自己的域名」。

## 页面与接口

- /admin 管理页面（需密码）
- /healthz 健康检查
- /cron?token=xxx 外部定时入口（需设置 CRON_TOKEN）

## 用到的上游接口（非官方，随时可能变）

- POST /api/account/userLogin 表单登录
- GET /api/examReport/examList 成绩单列表
- GET /api/examReport/examReportList 单科明细
- GET /api/examReport/examCourse 课程列表
- GET /report/alldetail 整页报告（各科分数 + 试卷信息 + 评语）
- POST /api/examReport/originalVolume 原卷（答题卡页、题目块坐标、得分）
- GET /api/gradeQuery/examReportList、/api/gradeQuery/baseInfo 成绩查询模块

## 数据表

- exam_snapshot 每场考试的当前分数与元信息
- exam_subject 多科考试的各科分数
- exam_meta 试卷信息 + 答题卡页 + 扣分块坐标（JSON）
- exam_image 答题卡图片地址（按科目）
- events 变化事件（新发布 / 分数变化）
- poll_runs 每轮巡检记录（含 message，排障就看它）
- login_attempts 管理页登录频率限制
- session 上游会话

## 已知限制

- Cloudflare Workers 是请求级执行，没有常驻进程，Cron 最小 1 分钟且不保证准点，所以是「每 5 分钟巡检」而不是实时
- 免费版每天 10 万次请求，本程序约 288 次/天；每场考试会额外请求 1 次原卷接口，默认每轮最多 5 场
- 上游是网页自用接口，改版会导致失效
- 扣分框依赖 OSS 的 image/info 提供真实像素尺寸；取不到时退回按块坐标推算，可能略有偏差

## 本地开发

```bash
npm test          # 单元 + 集成测试（Node 20+）
npm run build     # 从 src/ 生成单文件 worker.js（需要 _build 脚本）
```

## 免责声明

本项目仅供本人/本人家庭查看自己的成绩，不绕过任何付费内容，不上传任何数据到第三方。
调用的是上游网页自用接口，非官方 API，使用风险由使用者自行承担。

## License

MIT
