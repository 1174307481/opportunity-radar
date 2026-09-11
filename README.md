# 个人商业机会雷达（Opportunity Radar）

> 个人使用的商业机会情报系统：持续从互联网发现「别人正在付钱解决的问题、信息差、价格差、效率差、低成本资源、可被 AI 加工变现的机会」，并结合个人技术能力做匹配推荐。

## 项目文档

| 文档 | 说明 |
| --- | --- |
| [docs/PRD-v1.0.md](docs/PRD-v1.0.md) | 初始需求文档 V1.0（2026-09-11 存档，后续在此基础上打磨） |
| [docs/product-design-v2.md](docs/product-design-v2.md) | **产品设计 V2（当前定稿）**：护城河公式 / 评分三档制 / 行动工件体系 / 冲突裁决记录 |
| [docs/product-design-v1.md](docs/product-design-v1.md) | 产品设计 V1（被 V2 部分取代；技术栈与数据模型章节仍有效） |
| [docs/research/](docs/research/) | V2 六份专项研究：01 机会信号地图 · 02 行动转化闭环 · 03 评分红队 · 04 竞品成败 · 05 赚钱路径 Playbook 库（15 条） · 06 生存审查 |

## 核心定位

> **不是信息产品，是行动工具：把互联网信号变成「你今天该做的下一件事」。**

护城河 = **个人技能画像作为核心过滤器 × 行动工件作为交付单元**。
KPI 不是信息条数，是：本周行动数（唯一 KPI）→ 回复率（领先）→ 成交金额（滞后）。

```text
信号采集（含人工粘贴）→ L1 分类路由（接单快通道/噪音归档）
→ L2 行动分析（真伪三证/四维评分/红队审查/playbook 召回）
→ 三档呈现（🔴今天看 ≤3 条 · 宁空勿凑）→ 今天做这一件事 → 行动账本回流
```

## 设计原则（V2 修订版精选）

1. 过滤先于排序——宁可空手，绝不凑数
2. 信号类型优先于数字分——接单类需求方真实+有预算，直接进今日必看
3. 每个结论必须带证据和理由，说不出就降档
4. 没有行动建议的机会不允许进首页
5. 人工录入是一等公民，不是妥协
6. 功能靠产出解锁（连续 7 天有产出才解锁次级功能）
7. 信息源接入标准 = 能产出「谁在花钱 + 需要什么技能」，纯新闻源免费也不接

## 技术栈（已定，2026-09-11）

**Next.js 全栈单体**——单用户场景一个应用跑完采集 / 分析 / 前端：

- 框架：Next.js（App Router）+ TypeScript，页面 + API Route 一体
- 数据库：SQLite（单文件零运维，clone 即跑）；量大平移 Postgres
- ORM：Drizzle
- AI：Vercel AI SDK + zod 结构化输出，DeepSeek 单 provider 双档——L1 筛查用对话档（高频便宜）、L2 商业分析用推理档（核心价值所在，量小）；OpenAI 兼容协议，换模型只改环境变量
- 采集：TS 实现——rss-parser / @mozilla/readability / octokit，可插拔 Source Adapter
- 定时：系统 crontab 调用受 CRON_SECRET 保护的 /api/cron/*
- 部署：pm2 或 docker 单容器；Vercel + Neon 亦可（需外部 cron）

砍掉的组件：Redis（无队列需求）、独立后端、前后端分离。

## 当前状态

- [x] 需求文档 V1.0 存档
- [x] 产品设计第一轮（product-design-v1.md）
- [x] 技术栈拍板：Next.js 全栈单体 + SQLite + Drizzle + Vercel AI SDK，砍掉 Redis 与独立后端（2026-09-11）
- [x] LLM 拍板：DeepSeek 单 provider 双档（L1 对话档路由 / L2 推理档分析），成本超限仅告警（2026-09-11）
- [x] **产品设计 V2 定稿**：6 份专项研究（信号地图/行动转化/评分红队/竞品/Playbook/生存审查）交叉综合，含冲突裁决记录（2026-09-11）
- [x] **部署拍板（2026-09-11）：本地优先验证，零新增成本。** 实测现有服务器可直连 GitHub/HN/电鸭（仅 V2EX 被封→该源走 Mac+Clash 或代理抓取，采集器设计加「按源配代理」字段）；海外 VPS 推迟到系统被验证有价值之后
- [x] 输入端冒烟测试（2026-09-11）：电鸭 20% 真信号率 ✅ / HN Algolia ✅ / GitHub 搜索 ✅ / V2EX 服务器直连被封 ⚠️ / App Store 评论 RSS 空数据 ⚠️（待换实现）
- [x] **假设 A 冒烟测试通过（2026-09-11，≈8.5/10）**：deepseek-v4-flash 实跑 L1 路由 3/4、L2 行动分析 9/10——三证不编造、红队点出画像盲区（东南亚本地化）、时薪反算诚实输出 null、话术可直接发送；4 条工程结论见 [docs/smoke-test.md](docs/smoke-test.md)（思考型模型 max_tokens 要放大、has_budget 规则收紧、试剪边界写死）
- [x] **M1 完成（2026-09-11 晚）：核心闭环端到端跑通**——快速录入（粘贴/URL+去重）→ L1 路由 → L2 行动分析 → 三档呈现+该不该做+第一步话术，生产构建全绿；真实数据实测 2 条（接单快通道→🔴 / 产品空白→⚪宁空勿凑），3 条规则修订见 [docs/smoke-test.md](docs/smoke-test.md)。启动：`npm run build && npm start`（:3000）
- [ ] M2 机会与状态：~~三档呈现+改档位+搜索+去重（M1 已含）~~ + 机会总览页 + 技能画像设置页（进行中：2 页面并行编写）
- [ ] M3 自动采集 + 行动闭环（进行中：源适配器 eleduck/HN/GitHub + /api/cron/collect + 行动账本 + 今天做这一件事 + 到期跟进，4 agent 并行）
  - 设计裁决 A3：增长动量/语义聚类推迟到 M5（单用户+人工录入阶段无时序数据可算）
- [ ] M4（闸门：连续 7 天有产出）：盲测校准 + 学习权重展示 + 成本对账单
- [ ] M5（闸门解锁）：Playbook 结构化召回 + 领域放大器 + 进阶源（政采/AppStore 差评/IT桔子）

## 运行

```bash
npm install
npx drizzle-kit push   # 初始化/更新 data/radar.db
npm run build && npm start   # http://localhost:3000
```

环境变量（见 `.env.local.example`）：LLM 网关走已有的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`；自动采集保护用 `CRON_SECRET`。
⚠️ 「今天做这一件事」按服务器本地日历日计算，Docker/服务器部署时请设置 `TZ=Asia/Shanghai`，否则焦点会在早 8 点错位过期。

线上部署（2026-09-12 起）：`https://opportunity.singular-test.kcura.cn/` —— 边缘 nginx（本机 `/etc/nginx/sites-enabled/opportunity-singular-test.conf`，复用 `*.singular-test.kcura.cn` 通配证书）反代 `127.0.0.1:3001`；应用只绑回环，公网直连 3001 已关闭。重启命令：`nohup npx next start -H 127.0.0.1 -p 3001 > /tmp/radar-3001.log 2>&1 &`。

定时采集（可选，本地 crontab，每 30 分钟一轮）：

```cron
*/30 * * * * curl -s -X POST -H "x-cron-secret: 换成你的CRON_SECRET" http://localhost:3000/api/cron/collect > /dev/null
```

手动触发：`curl -X POST localhost:3000/api/cron/collect`（未设 CRON_SECRET 时本机直接可用）。

## 红线平台快录（闲鱼/BOSS直聘：一键快录，不爬）

闲鱼、BOSS直聘与猪八戒/拉勾同属**禁爬红线**（无开放 API、有风控与封号风险、爬阿里/招聘数据有判例）。这些平台的价值走**浏览器端一键快录**承接——你正常刷，看到值得看的一条点一下，脚本把「标题+价格/薪资+描述+链接」投进雷达走 L1/L2 全流程。单条、你触发、不绕任何风控，本质是「手动复制粘贴」的一次点击化（同 Notion 剪藏模式）；**不做、也不会做服务端批量采集**。

安装（一次性）：

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开 `https://opportunity.singular-test.kcura.cn/opportunity-clipper.user.js`，Tampermonkey 会弹出安装页（脚本默认投递到该域名；纯本地调试可改脚本顶部 `RADAR_URL`）
3. 打开任意闲鱼宝贝页或 BOSS 职位详情页，右下角出现「⚡ 投雷达」按钮

使用：进详情页 → 点「⚡ 投雷达」→ 确认预览 → 自动分析。描述抓取不准时，先在页面选中描述文字再点按钮（选中文本优先）。

⚠️ 站点已启用 nginx basic auth（凭证文件在服务器 `/etc/nginx/.htpasswd-radar`，密码不进仓库）。装好脚本后在 Tampermonkey 编辑器里把顶部的 `RADAR_USER`/`RADAR_PASS` 填上，否则投递会 401。

蹲守姿势：
- **闲鱼**：搜「代做 开发」「小程序 定制」「AI 部署」「爬虫 代做」，按最新排序，像样的需求就投
- **BOSS直聘**：筛「兼职/远程」+ 技能词（前端/AI/Python），找小企业的项目制短工——「兼职」「外包」「项目制」「按天结算」是关键词；薪资写明的帖子 L1 预算抽取最准。坐班全职 JD 不用投（L1 会判噪归档，不花钱，但也别浪费时间）

## 热点雷达（趋势 → 变现假设）

与需求侧信号（谁在花钱）互补的**趋势侧信号**：抖音/微博/知乎/百度/头条五源热榜，每 6 小时采集一次（cron `8 0,6,12,18 * * *`，端点 `/api/cron/collect-hotspot`）。链路：五源采集 → 跨源去重（同一热点多榜命中只保留热度百分位最高的一条，标 `[多源:]`）→ 批量预筛（通过率卡 3-5%）→ L3 变现假设（卖什么/在哪卖/定价锚/时效窗/竞争热度 + 可直接复制的闲鱼上架文案）。产出入 opportunities（type=热点衍生），详情页有专门的「变现假设」区；预筛拒绝的条目只归档 items，不建机会行。设计细节见 `docs/design-hotspot.md`。

热点条目走独立流水线（`lib/hotspot-pipeline.ts`），与 L1→L2 零交集——L1 的「无需求方=噪声」规则会把热榜全量判噪，这是设计使然。

## 约束

- 个人工具（Personal Tool），不做注册 / 多租户 / 支付 / 社交 / SEO
- 合法合规，尊重网站服务条款与版权，不以盗取、欺诈、绕过权限或侵犯隐私为商业模式
- 第一阶段以自己使用、快速验证、低成本开发为原则，不过度设计
