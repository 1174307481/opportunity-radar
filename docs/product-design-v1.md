# 产品设计 V1

> 基于 [PRD-v1.0.md](./PRD-v1.0.md) 的第一轮产品设计，2026-09-11
> 定位：把 PRD 里「想做什么」翻译成「具体怎么做」——对象模型、数据结构、评分公式、AI 流水线、信息源清单、里程碑。所有 PRD 未拍板的点在这里给出设计决策与理由，标注 ❓ 的留给用户拍板。

---

## 0. 设计总纲

一句话产品定义：

> **输入是信息，输出是行动建议。** 系统的一切设计都为了让用户每天花 ≤ 5 分钟，完成「看到 → 判断 → 标记 → （可能）行动」这个循环。

三条硬约束（贯穿所有设计）：

1. **合规红线**：不爬取禁止爬虫的平台（BOSS / 闲鱼 / 猪八戒等），不绕过登录/反爬。这些渠道用「人工快速录入」兜底——人负责采集，AI 负责分析。
2. **成本上限**：LLM 日成本控制在 ¥2 以内（DeepSeek 单模型 + 商业信号闸门，实际 < ¥0.5/天，超限仅告警）。
3. **单机单人**：无注册登录（若暴露公网，加一个环境变量访问口令即可），无多租户，单进程部署。

---

## 1. 产品总体设计

### 1.1 三个核心对象

```text
Item（原始信息）          —— 采集/录入进来的每一条信息
   ↓ AI 分析（可能有、可能没有商业信号）
Opportunity（机会）       —— 从信息中提炼出的可行动机会
   ↓ 用户操作
Action（行为/状态流转）    —— 收藏、忽略、状态推进，同时是学习信号
```

关键决策：**Item 和 Opportunity 分离**。大量信息没有商业价值，不应污染机会列表；同一个 Item 理论上可提炼多个机会（V1 先 1:0 或 1:1，表结构预留 1:N）。

### 1.2 两个空间

| 空间 | 对应页面 | 角色 |
| --- | --- | --- |
| 信息库（仓库） | 信息库列表 + 详情 | 存全量原始信息，可搜索、可追溯，是「证据库」 |
| 机会中心（门面） | 首页/今日简报 + 机会列表 + 机会详情 | 只展示通过评分闸门的机会，是「决策台」 |

首页 = 今日简报（PRD 三十六：围绕「机会」不围绕「资讯」）。

### 1.3 页面清单（V1 共 7 个）

| # | 页面 | 核心内容 |
| --- | --- | --- |
| 1 | 今日简报（首页） | 数字总览 + 分类统计 + Top 5~10 机会卡片 + 「今天最值得行动的一条」 |
| 2 | 机会列表 | 全量机会，筛选：类型 / 评分 / 匹配度 / 状态 / 标签 / 时间 |
| 3 | 机会详情 | 完整分析（见 §6.4 L2/L3 输出结构）+ 状态操作按钮 + 原始来源链接 |
| 4 | 信息库 | 全量 Item，搜索/筛选/收藏，可手动触发「重新分析」 |
| 5 | 信息源管理 | 源的增删改查、启停、频率、手动「立即抓取」 |
| 6 | 快速录入 | 粘贴 URL 或文本 → 抓正文 → 直接进 AI 分析流水线（合规兜底入口） |
| 7 | 设置 | 技能画像（可编辑）/ 评分权重 / 学习权重 / LLM 配置与本月花费 |

### 1.4 核心用户旅程（每天 ≤ 5 分钟）

```text
打开系统 → 扫今日简报（1 分钟）
   → 点开 1~2 条感兴趣的详情（2 分钟）
   → 标记状态：值得研究 / 忽略 / 已联系（1 分钟）
   → 关闭系统
偶尔：粘贴一条自己发现的信息进快速录入
```

推送（V1 可选，M4）：简报每日早 9 点同步到企业微信 / Server酱，≥90 分机会实时提醒——目标是「不用主动打开系统也不错过」。

---

## 2. 数据模型

V1 存储：SQLite 单文件（零运维，clone 即跑；JSON 字段存 text 配合 json1 查询；后续量大用 Drizzle 换 dialect 平移 Postgres，表结构不变）。

```text
sources                 信息源
  id, name, type(rss|github|manual_url|manual_text|hn|reddit|ph),
  url, config(jsonb), fetch_interval_minutes, enabled,
  last_fetched_at, created_at

items                   原始信息
  id, source_id, title, url, url_hash(unique), dedup_hash(unique),
  published_at, found_at,
  raw_content, clean_content,
  summary, category, tags(jsonb), required_skills(jsonb),   -- L1 输出
  ai_stage(pending|l1_done|l2_done|ready|archived|failed),  -- 流水线状态
  analysis_l1(jsonb), analysis_l2(jsonb),
  error_msg, retry_count

opportunities           机会（与 item 一对一，预留 item_id 可重复）
  id, item_id, type(接单|信息差|价格差|效率差|资源差|产品),
  one_liner,                                            -- 一句话机会描述
  analysis(jsonb),                                      -- §6.4 结构化分析
  score_base, score_final, score_breakdown(jsonb),      -- §4 评分
  skill_match, skill_match_detail(jsonb),
  user_status, is_favorite, user_score_override,        -- 用户可手改分数
  first_seen_at, last_action_at

user_actions            用户行为（学习信号 + 审计）
  id, opportunity_id, action(view|star|unstar|ignore|status|contact|score_edit),
  from_status, to_status, payload(jsonb), created_at

tag_weights             学习权重（§9）
  tag(category或tag名), weight(浮点), updated_at

skill_profile           技能画像（§5，可在设置页编辑）
  id, skills(jsonb), updated_at

daily_reports           简报快照
  date(unique), stats(jsonb), top_opportunity_ids(jsonb), content_md
```

去重策略：`url_hash`（规范化 URL 的 sha256）为第一道；`dedup_hash`（标题 + 正文前 500 字的 simhash）为第二道，同一来源或跨来源重复内容直接归档，但**把重复出现计数 +1 写回原 Item**——「同一需求在多个来源重复出现」本身就是需求强度证据（见 §10.4）。

---

## 3. 机会类型与判定规则

六类（继承 PRD 五~十），每类给 LLM 的判定锚点：

| 类型 | 判定锚点（LLM 提示词中的核心问题） | 典型信号词 |
| --- | --- | --- |
| 接单 | 是否有人此刻在花钱找人做这件事？ | 预算、报价、需求方、外包、兼职、招聘 JD 里的项目需求 |
| 信息差 | 海外已验证，国内是否存在认知/应用/服务差距？ | 海外新品、国内无同类、英文资料、PH/HN 热门 |
| 价格差 | 同一能力在两个渠道是否存在成本差？ | 定价、套餐、免费额度、API 价格、汇率 |
| 效率差 | 人工 X 小时的事，AI 能否压到 1/4 以下？ | 人工流程、重复劳动、剪辑、翻译、整理 |
| 资源差 | 免费低价资源能否加工成付费交付？ | 开源、免费 API、模板、数据集、素材 |
| 产品 | 同类需求是否已重复出现 ≥3 次？ | 重复需求、多人求助、高频搜索意图 |

一条信息可以命中多类，V1 取 LLM 置信度最高的一类为主类型、其余存 `secondary_types`（便于按类型筛选）。

---

## 4. Opportunity Score 评分模型

### 4.1 公式

```text
score_final = clamp( 0, 100,
    Σ(维度分 × 权重)          -- 基础分
    + user_bias(tag_weights)  -- 学习修正，§9，±10 以内
)
用户手动改分(user_score_override)永远优先于系统分。
```

### 4.2 维度与权重（继承 PRD 二十二，定义可计算口径）

| 维度 | 权重 | 0~100 打分口径（LLM 按 schema 输出 + 证据引用） |
| --- | --- | --- |
| 需求强度 | 20 | 有明确需求方+预算=90+；有需求方无预算=60~80；仅推测=≤40 |
| 付费意愿 | 15 | 明码标价=90+；平台历史成交可查=70；只问不做=≤30 |
| 信息差 | 15 | 海外有+国内无同类=90+；国内已有但认知度低=50~70 |
| 利润空间 | 15 | 按预估售价−预估成本占售价比例打分 |
| 技术匹配度 | 15 | 直接取 Skill Match Score（§5） |
| 执行难度 | 10 | 反向分：1 周内可交付=90+，1 月=60，更长=≤40 |
| 竞争程度 | 5 | 反向分：无成熟竞品=90+，红海=≤30 |
| 信息新鲜度 | 5 | ≤3 天=100；≤7 天=80；≤14 天=60；≤30 天=30；更早=10 |

权重存配置表，设置页可调（PRD 二十二：允许用户手动修改）。

### 4.3 分级与呈现

```text
90~100  ⭐⭐⭐⭐⭐ 重点关注     → 进入「今天最值得行动的一条」候选
80~89   ⭐⭐⭐⭐   值得验证     → 进入每日简报
70~79   ⭐⭐⭐     可以关注     → 机会列表可见
60~69   ⭐⭐       暂时观察     → 列表降权排序
<60     ⭐         自动归档     → 不进任何推荐位，仅可搜索到
```

---

## 5. Skill Match 技能匹配

### 5.1 技能画像（skill_profile，初始值来自 PRD 三，设置页可改）

```json
{
  "frontend":  { "level": 0.95, "skills": ["vue","react","typescript","nextjs","uniapp","echarts","threejs"] },
  "backend_java":   { "level": 0.80, "skills": ["java","spring","springboot"] },
  "backend_node":   { "level": 0.85, "skills": ["nodejs","nestjs","express"] },
  "python_ai":      { "level": 0.90, "skills": ["python","fastapi","llm","agent","langgraph","rag","workflow"] },
  "content":        { "level": 0.80, "skills": ["video_editing","ai_image","ai_video","ai_voice","copywriting"] },
  "devops":         { "level": 0.85, "skills": ["linux","docker","k8s","nginx","cicd"] }
}
```

`level` 为熟练度系数（精通 1.0 / 熟练 0.85 / 会用 0.7），影响匹配折扣。

### 5.2 匹配计算

L1 阶段 LLM 从信息中提取 `required_skills: [{skill, importance: 1~5}]`，然后纯代码计算（不用 LLM 算分，可解释、可复现）：

```text
skill_match = Σ(matched: importance × 用户对应 level) / Σ(全部 importance) × 100
```

例：`AI 知识库` 需求 → 提取 llm(5)/rag(4)/python(3)/vue(2)，全部命中且 level 高 → ≈95；
`CUDA 算子` → 提取 cuda(5)/c++(4)，用户画像无此项 → ≈20。

命中明细存 `skill_match_detail`，前端渲染成 PRD 二十三的勾选清单样式。

---

## 6. AI 分析流水线

### 6.1 模型策略（已拍板，2026-09-11：DeepSeek V4 单模型）

**单 Provider（DeepSeek，OpenAI 兼容协议），双档模型**——不做多 provider，但核心环节用推理档，这是「简单」与「质量」的平衡点：

| 调用 | 频次/天 | 模型档 | 理由 |
| --- | --- | --- | --- |
| L1 筛查 | ~100 | V4 对话档（env `MODEL_FAST`） | 任务简单（摘要/分类/标签/信号初筛），成本与延迟优先 |
| L2 全量分析 | ~25 | V4 推理档（env `MODEL_THINK`） | 商业判断 + 红队审查吃推理能力，是全系统价值所在；量小成本可控 |
| 简报叙事（top-1 行动建议） | 1 | 对话档 | 忽略不计 |

（具体 model 名以 DeepSeek 官方文档为准，均为环境变量，换模型不改代码。）评分 / Skill Match / 学习权重 / 去重 / 正文提取**不用 LLM，纯代码**；跨源聚类（P1）V1 用「标签+关键词聚合」近似，不为它引入第二家 embedding provider。

保留**调用分层**（两套 prompt）：

| 调用 | 职责 | 触发条件 |
| --- | --- | --- |
| L1 筛查 | 摘要、分类、标签、required_skills 提取、有无商业信号（宁可错杀） | 每条 Item 必跑 |
| L2 全量分析 | 六类机会判定、维度打分、赚钱路径、方案 A~D、红队审查、建议行动 | 仅 L1 判定「有商业信号」的 Item（预计 20~30%） |

为什么保留两次调用而不是合成一次：筛查要激进过滤（大部分信息是噪音），深析要彻底想清楚，两种指令混在一个 prompt 会互相拉低质量；且大 prompt 没必要全量跑。

模型仍是配置项（baseURL / apiKey / model 名均为环境变量），哪天想换模型或恢复分层，改配置不动代码。

### 6.2 流水线状态机

```text
Item 入库
  ↓
L1 筛查 ──无商业信号──→ archived（保留在信息库，不产生机会）
  ↓ 有信号
L2 全量分析 + 评分 + Skill Match ──→ ready（按 §4.3 分级呈现/降权/归档）
```

失败处理：每层最多重试 2 次（schema 校验失败自动重试并附错误信息），仍失败标 `failed`，信息库可见可手动重跑。

### 6.3 输出可靠性设计（防幻觉）

所有 LLM 输出强制 JSON Schema 约束，且必须包含：

- `evidence`：得出每个结论所依据的原文片段（前端详情页展示「为什么发现它」）
- `confidence`：每个判断的置信度 0~1，低于 0.6 的结论前端降权展示（灰色 + 「不确定」标记）
- 说不清就输出 `null`，禁止编造（尤其预算、价格类数字）

### 6.4 L2 结构化输出（即机会详情页的数据结构）

```json
{
  "what_happened": "……",
  "real_need": "真实需求是什么",
  "who_pays": "谁可能付钱（客户画像）",
  "why_gap": "为什么存在机会（信息差/价格差/效率差在哪里）",
  "ai_leverage": "AI 能降低多少成本（效率差量化）",
  "paths": [
    { "plan": "A", "mode": "直接接单", "desc": "…", "est_cost": "…", "est_price": "…", "difficulty": 60 },
    { "plan": "B", "mode": "做服务" },
    { "plan": "C", "mode": "做产品" },
    { "plan": "D", "mode": "做自动化" }
  ],
  "competition": "竞争情况",
  "suggested_action": "建议行动（具体到今天做什么）",
  "devil_advocate": "反向审查：这个机会为什么不成立（防自嗨，§10.3）",
  "scores": { "需求强度": 85, "付费意愿": 70, "…": "…" },
  "evidence": [ "原文片段1", "…" ],
  "confidence": { "real_need": 0.9, "who_pays": 0.6 }
}
```

### 6.5 成本预算（100 条信息/天 估算）

| 调用 | 次数/天 | 单次 token（入/出） |
| --- | --- | --- |
| L1 筛查 | 100 | ~1k / 0.3k |
| L2 全量分析 | ~25 | ~2k / 1k |

合计 ≈ 0.2M tokens/天，DeepSeek 价格量级下**日成本 < ¥0.5**。实际消耗逐条落库（model、tokens、估算费用），设置页显示本月累计。

---

## 7. 信息源体系（可插拔 Adapter）

### 7.1 Adapter 接口

每个源一个 Adapter（PRD 二十九），统一接口：

```text
fetch(source) → [Item]     # 只负责抓取 + 解析为标准 Item
normalize(Item) → Item     # 统一字段、清洗正文
```

新增源 = 新增一个 Adapter 类 + 注册，不动其他代码。

### 7.2 V1 内置源（P0，对应 PRD 三十七）

| 源 | 方式 | 频率 | 合规性 |
| --- | --- | --- | --- |
| 自定义 RSS | feedparser | 每源可配（默认 30 分钟） | 完全公开 |
| GitHub Trending | 公开页面/镜像 API | 每日 | 公开数据 |
| 手动 URL | 粘贴链接抓正文（readability 提取） | 手动 | 公开页面 |
| 手动录入 | 粘贴文本（如 JD、外包描述、闲鱼需求原文） | 手动 | 人工采集 |

### 7.3 P1/P2 扩展源（已设计接口，V1 后逐步接入）

| 优先 | 源 | 方式 | 抓什么 |
| --- | --- | --- | --- |
| P1 | Hacker News | Algolia 官方 API（免费公开） | Ask HN / Show HN / 求助帖 |
| P1 | Reddit | 官方 API / 公开 .json | r/SideProject、r/forhire、r/Entrepreneur、r/LocalLLaMA |
| P1 | Product Hunt | 官方 RSS/API | 新品与定价 |
| P2 | V2EX | 官方 RSS | 分享/创意节点 |
| P2 | SaaS 变价监控 | 定价页定时快照 diff | 涨价/免费额度取消（PRD 十七） |
| P2 | 停服信号 | status/changelog RSS | 下线公告 |
| P2 | 招聘/外包（BOSS、猪八戒、闲鱼等） | **不爬**。人工看到→快速录入 | JD/需求原文走完整 AI 分析 |

> 招聘与外包渠道是 PRD 的高价值来源，但平台 ToS 禁爬。设计取舍：**人肉雷达 + AI 分析**的混合模式——用户日常刷到就粘贴进来（30 秒），系统照走全套评分与匹配。既保住核心价值，又不越合规红线。

### 7.4 调度

Next.js 无内置定时器，用系统 crontab（或 node-cron 挂在 instrumentation）调用受 `CRON_SECRET` 保护的 API 路由：

```text
*/30 * * * *  curl /api/cron/fetch      # 按 sources.fetch_interval 抓取
*/5  * * * *  curl /api/cron/analyze    # 消化待分析队列（每轮限量，控成本）
0    9 * * *  curl /api/cron/report     # 生成每日简报
0    8 * * 1  curl /api/cron/weekly     # 生成周报
```

自部署（pm2 / docker）是常驻进程，cron 路由内可 fire-and-forget 跑长任务；若部署 Vercel serverless，需外部 cron 服务 + Neon 数据库，长任务分批。

---

## 8. 首页（今日简报）设计

```text
━━━━━━━━━━━━━━━━━━━━
昨日采集 127 条 → AI 筛出 23 条 → 与你高度匹配 8 条

🔥 接单 ×3   💰 价格差 ×2   🌏 信息差 ×2   🤖 AI 产品 ×1

⭐ 今天最值得行动的一条
「某教育公司寻找 AI 学习工具」
原因：真实需求 ✓ 付费可能 ✓ 匹配 94% 可快速验证 ✓ 竞争低 ✓
建议：今天联系 3 个潜在客户，验证付费意愿。
━━━━━━━━━━━━━━━━━━━━
[机会卡片 01] … [机会卡片 08]   ← 卡片含：标题/类型/匹配度/星级/建议一句话
                                  操作：查看 · 收藏 · 忽略 · 标记已验证
```

简报每天固化存 `daily_reports`（快照不随重算变化，可回看历史）。

---

## 9. 状态闭环与用户学习

### 9.1 状态机

V1 主线（PRD 三十七简化版）：`新发现 → 研究中 → 已验证 → 已联系 → 成交`，外加终态 `忽略`（子原因：无价值 / 不适合我 / 已有人做 / 暂无需求）。
完整状态（有回复/报价/交付/复盘）作为字段预留，V1 下拉里可选但默认隐藏。

每次状态变更写 `user_actions`——这是学习的原料。

### 9.2 学习机制（V1 显式规则，不上 ML）

| 用户行为 | 信号强度 | 效果 |
| --- | --- | --- |
| 收藏 | +1 | 该机会的 category + 主标签权重 +0.2 |
| 忽略 | −1 | 权重 −0.2 |
| 推进到已验证 | +2 | 权重 +0.4 |
| 已联系 | +3 | 权重 +0.6 |
| 成交 | +5 | 权重 +1.0 |

`user_bias = clamp(-10, +10, Σ相关tag权重×系数)` 加到最终分（§4.1）。设置页可视化展示当前权重表，可手动改/清零——**透明可控，用户始终知道系统为什么给自己推这些东西**（对应 PRD 二十七的雏形，V2 再考虑更精细的模型）。

---

## 10. 对 PRD 四十二的主动补充

### 10.1 补充赚钱模式

| 模式 | 说明 | 对应机会类型 |
| --- | --- | --- |
| API 套利封装 | 海外便宜/免费 API → 封装中文服务、中文文档、微信支付，卖给国内开发者 | 价格差 |
| 开源项目商业化 | GitHub 项目 → Docker 一键部署 + 托管运维 + 定制开发订阅 | 资源差 |
| 停服接盘 | 某 SaaS 停服/涨价 → 数据迁移工具 + 导出服务 + 平替方案 | 效率差/接单 |
| 反向信息差出海 | 国内已成熟的 AI 应用模式（如内容生成打法）→ 做海外市场 | 信息差 |
| 模板/脚手架资产化 | 重复接单需求沉淀成模板包（AI 客服模板、知识库模板）反复卖 | 产品 |
| 本地商家 AI 月费服务 | 商品图 + 短视频 + 文案打包，按月订阅，AI 批量生产 | 效率差 |

### 10.2 补充信息差类型

- **语言差**：英文世界的信息/工具 → 中文市场（翻译、汉化、中文教程付费）
- **认知差**：技术已成熟，但目标行业（医疗/教培/制造）不知道能用
- **渠道差**：需要海外支付/手机号的工具 → 存在开通/充值代办需求（仅做合规代办，不做灰产）
- **监管差**：数据合规、备案、本地化部署要求 → 带来国内定制改造需求（PRD 十九的具体化）

### 10.3 补充 AI 分析方式

- **跨源聚类**：用 embedding 把同需求的多条信息聚成一个需求簇 → 簇规模直接抬升「需求强度」分（需求实证，而非单条猜测）
- **证据链强制**：§6.3 的 evidence + confidence 机制
- **反向审查 prompt**：L2 分析时要求「论证这个机会为什么不成立」（红队视角，输出到 devil_advocate 字段），抑制乐观偏差——个人系统最大的敌人是自嗨

### 10.4 补充数据维度（在 §2 字段基础上的增量）

| 维度 | 用途 |
| --- | --- |
| repeat_count（跨源重复出现次数） | 需求强度实证，≥3 触发「产品机会」提示 |
| deadline（截止/时间窗口） | 行动紧迫度，简报优先展示 |
| est_cost_range / est_price_range | 利润空间计算，区间而非点值 |
| delivery_days | 执行难度量化 |

### 10.5 补充自动化

- 简报推送（企业微信/Server酱 webhook）+ ≥90 分实时提醒（M4）
- 「已联系」3 天无回复 → 自动生成跟进提醒
- V2：机会详情页一键生成联系话术/开发信（拿 AI 知识库需求 → 生成针对该教育公司的沟通稿）

---

## 11. 技术栈决策（已拍板，2026-09-11）

**结论：Next.js 全栈单体，一个应用搞定。** 单用户场景下独立后端与消息队列都是过度设计。

| 决策点 | 决策 | 说明 |
| --- | --- | --- |
| 框架 | **Next.js（App Router）+ TypeScript** | 页面 + API Route 一体，一个 repo 一个进程一个部署单元 |
| 数据库 | **SQLite（默认）** | 单文件零运维；量大平移 Postgres |
| ORM | Drizzle | 类型安全、轻量，SQLite/Postgres 只换 dialect |
| AI | Vercel AI SDK + zod，**单模型 DeepSeek V4** | OpenAI 兼容协议只配 baseURL + model；两次调用（L1 筛查 / L2 全量分析）见 §6.1，换模型只改环境变量 |
| 采集 | TS 原生 | rss-parser（RSS）、@mozilla/readability（正文提取）、octokit（GitHub）——V1 全部信息源不需要 Python |
| 队列 | **不需要** | 单人 ~100 条/天，"队列"就是 items.ai_stage 字段 + cron 消化，无 Redis |
| 定时 | 系统 crontab → 受保护 `/api/cron/*` | 见 §7.4 |
| 部署 | pm2 或 docker 单容器 | 常驻进程，cron 路由内可直接跑长任务；Vercel + Neon 亦可（需外部 cron） |

砍掉的组件：~~Redis~~（无队列/缓存需求）、~~独立 Python 采集服务~~（TS 生态覆盖 V1 全部源）、~~前后端分离~~（单应用）。

目录结构（单应用）：

```text
opportunity-radar/
├── docs/                  # PRD、产品设计（本文件）
├── src/
│   ├── app/               # 页面 + API 路由
│   │   ├── page.tsx       # 今日简报（首页）
│   │   ├── opportunities/ # 机会列表 / 详情
│   │   ├── library/       # 信息库
│   │   ├── sources/       # 信息源管理
│   │   ├── settings/      # 设置
│   │   └── api/
│   │       ├── cron/      # fetch / analyze / report（CRON_SECRET 保护）
│   │       └── items/     # 快速录入等业务接口
│   ├── lib/
│   │   ├── adapters/      # rss / github / manual（每源一个）
│   │   ├── ai/            # L1/L2/L3 prompt + zod schema + 分层调用
│   │   ├── scoring/       # Opportunity Score / Skill Match（纯函数）
│   │   └── db/            # drizzle schema + 查询
│   └── components/
├── data/                  # SQLite 文件（gitignore）
└── package.json
```

---

## 12. V1 里程碑（每个 M 结束系统都「可用」）

| 里程碑 | 内容 | 验收标志 |
| --- | --- | --- |
| M1 骨架 | 数据模型 + 手动录入/URL 抓取 + 信息库列表/详情/搜索 | 当天就能往里存信息并检索——先当个人信息库用 |
| M2 AI 分析 | L1+L2 流水线 + 评分 + Skill Match + 机会中心 + 状态闭环 | 录入一条 JD，自动产出完整机会分析与评分 |
| M3 自动采集 | RSS + GitHub Adapter + 调度 + 去重 | 挂 5 个 RSS 源跑一天，无人工介入产出机会 |
| M4 简报与学习 | 每日简报 + 周报 + 学习权重 + webhook 推送 | 每天早 9 点微信收到 5~10 条机会 |
| M5 打磨 | L2 输出精修（方案 A~D / 红队审查）+ 快速录入体验 | 高分机会自动产出完整行动方案 + 「为什么不成立」反向审查 |

---

## 13. 待拍板的开放问题

1. ~~后端语言~~ **已拍板（2026-09-11）：Next.js 全栈单体**，无独立后端、无 Redis，详见 §11。
2. ~~LLM 供应商~~ **已拍板（2026-09-11）：DeepSeek V4 单模型**（OpenAI 兼容协议接入），不做多档分层，详见 §6.1。
3. ~~每日预算~~ **降级为仅告警**：单模型后日成本 < ¥0.5，超 ¥2 只告警不停服。
4. **部署目标**：本地机器 / 已有服务器？（决定 webhook 推送和定时任务的可用性）
5. **V1 是否要周报**：PRD 三十五要求，但建议放 M4，与简报共用生成逻辑，成本很低。

—— 以上默认按推荐值执行，用户拍板后更新本文档并在 README 状态中勾选。
