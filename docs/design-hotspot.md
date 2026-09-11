# 设计文档：热点 → 变现假设

> 2026-09-12。为「抓趋势侧信号、推导供给侧机会」功能做需求分析与设计。
> 依托现有架构（`lib/pipeline.ts` 流水线、`lib/ai/` 双档 LLM、`lib/sources/` 适配器模式、`lib/db/schema.ts` 数据模型、`docs/product-design-v2.md` 三档制），只做增量，不改动既有 L1→L2 流程。

---

## 0. 需求本源

用户原话：「有没有爬取热点新闻，分析机会来源的 agent——就是找机会的功能，例如今天龙虾火爆，分析出可以在闲鱼挂着教人找龙虾这种。」

现有雷达抓的是**需求侧信号**（谁在花钱、招人、发包）。这个新功能抓**趋势侧信号**（什么在火）并推导**供给侧机会**（我能赶着热度卖什么：信息差产品/服务/内容），落到「第一步今晚可做」。

---

## 1. 数据流设计

### 1.1 全局数据流

```text
热榜源（抖音 + 微博 + 知乎 + 百度 + 头条）
  ↓  adapter.fetchSignals() → RawSignal[]
采集入口（/api/cron/collect-hotspot，4 次/天）
  ↓  跨源去重入库（items.sourceType = source:{douyin|weibo|zhihu|baidu|toutiao}-hot，aiStage = pending）
趋势预筛（批量一次 LLM，复用 L1 的批调用模式）
  ├  不通过 → items.aiStage = archived（l1 字段存预筛结论，有审计痕迹）
  └  通过 → items.aiStage = l1_done（复用此阶段名表示「预筛通过待深分析」）
       ↓
L3 热点机会分析（逐条调用，推理档模型）
  ↓  产出变现假设 → opportunities 表（type = "热点衍生"，analysis = L3 JSON）
  ↓  分档（独立规则，不复用 L1→L2 的分档逻辑）
  ↓  items.aiStage = ready
```

**源优先级**：抖音 = 微博（消费级热点主战场）> 知乎 > 百度 ≈ 头条。五源覆盖中文热点生态的主战场，同一热点多源命中时跨源去重只保留热度最高的一条（见 §4.2）。

### 1.2 为什么独立分支而非复用 L1→L2

**这是最重要的架构裁决**。热点条目绝不能混进现有 L1，理由：

1. **L1 的噪声规则会正确判噪**：L1 规则写死了「若这条信息无法回答『谁会在什么条件下付钱给我』，就是噪声」。热榜条目没有买方、没有预算、没有需求方——会被 100% 判噪归档。这不是 bug，是 L1 设计正确；热点信号的性质和需求侧信号根本不同。
2. **L1 的分类体系不匹配**：L1 的八类（接单/招聘JD/信息差/价格差/效率差/资源差/产品空白/其他）全部是需求侧分类。热榜条目不描述「别人要什么」，描述的是「什么在火」。
3. **L2 的三证不适用**：L2 的资金证据/身份证据/时间证据是验证「需求方是否真实」。热榜没有需求方——这不是缺点，是信号性质不同。强行套三证会导致所有热点机会三证全 null、总分极低、全部归档。
4. **技能匹配的语义不同**：L1 的 `required_skills` 是「完成这个任务需要什么技能」。热点机会的技能匹配应该是「主人的技能能生产什么跟风产品」，是正向推导而非需求匹配。

因此，热点功能走**完全独立的预筛→L3 流程**，与 L1→L2 并行存在，通过 `sourceType` 路由隔离。

### 1.3 预筛不通过的条目落哪

**裁决：进 items 表，直接 archived。**

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| A. 不进 items | items 表干净 | 无审计痕迹，无法回溯预筛拒绝了什么 |
| B. 进 items 直接 archived | 有审计痕迹，可在信息库搜索查看 | items 表增长快（75-100 条/采集 × 4 次/天 = 300-400 条/天） |

选 B 的理由：
- 审计价值 > 存储成本。本地 SQLite 单用户，日增 ~300 条（跨源去重后实际入库 ~150-250 条），一年 ~5-8 万条，无压力。
- 信息库已有 archived 条目（L1 判噪的也进 archived），热点预筛拒绝的条目混在其中不影响首页（首页只查 today/week）。
- `items.l1` 字段存预筛结论 JSON（含 reason），用户在信息库能看到为什么被拒。
- `sourceType` 区分来源，日后可按来源过滤。

### 1.4 路由隔离机制

在采集入口（`/api/cron/collect-hotspot/route.ts`）中，入库后根据 `sourceType` 决定走哪条流水线：

```text
sourceType.startsWith("source:douyin-hot") 或 "source:weibo-hot" 或 "source:zhihu-hot" 或 "source:baidu-hot" 或 "source:toutiao-hot"
  → startHotspotPipeline(itemId)   ← 新函数，独立流程
否则
  → startPipeline(itemId)           ← 现有 L1→L2 流程
```

两条流水线共享 items/opportunities 表结构，但不共享处理逻辑。`startPipeline` 的批处理队列、`inFlight` 去重、`MAX_CONCURRENT` 等机制不混用——热点有自己的批处理（预筛是批量一次 LLM 调用）。

---

## 2. L3 输出 Schema

### 2.1 预筛 Schema（批量 LLM 调用）

预筛是一次批量调用，处理当批所有热点条目，输出每条的 pass/fail + 理由。

```json
{
  "results": [
    {
      "id": 1,
      "pass": true,
      "relevance": "high | medium | low",
      "monetizability": "high | medium | low",
      "time_window": "3-5天 | 1-2天 | 已过峰 | 常青",
      "reason": "一句话：为什么通过/拒绝（引用热榜标题关键词）"
    }
  ]
}
```

预筛判断口径：
- **relevance**：与主人技能/变现路径的相关度。主人能做什么：前端/后端/AI 应用/内容生产（AI 剪辑/生图/生视频/配音/文案）/爬虫自动化。热榜条目是否在这些领域的辐射范围内？
- **monetizability**：可变现性。这个热度能催生什么可出售的东西？信息差产品（攻略/教程/合集）、服务（代做/咨询）、内容（视频/图文）？有没有人会为此付费？
- **time_window**：时效窗。热度还有多久？已经过了峰值就拒绝。
- **pass 条件**：relevance ≥ medium AND monetizability ≥ medium AND time_window ≠ "已过峰"。

预筛必须严格：目标通过率 3-5%（每批 75-100 条跨源去重后约 50-80 条只放 2-3 条进 L3）。

### 2.2 L3 变现假设 Schema（逐条深度分析）

L3 是对预筛通过的条目做深度分析，产出可执行的变现假设。

```json
{
  "trend_summary": "一句话概括热榜趋势",
  "what_to_sell": {
    "deliverable": "具体到可上架的交付物名称（如：龙虾挑选避坑攻略 PDF + 3 段实操短视频）",
    "format": "pdf | video | image_set | code_template | service | consulting",
    "why_this": "为什么是这个交付物而非其他（基于主人技能 + 热度性质）"
  },
  "where_to_sell": {
    "primary": "闲鱼 | 小红书 | 公众号 | 视频号 | 抖音 | B站",
    "why": "为什么选这个渠道（流量匹配度/上架门槛/变现路径）"
  },
  "pricing_anchor": {
    "reference": "同类行情参考（如：闲鱼同类攻略合集 ¥9.9-19.9）",
    "suggested_price": "建议定价（具体数字）",
    "basis": "定价依据（参考了什么/怎么推算的）"
  },
  "time_window": {
    "days_left": 3,
    "peak_prediction": "预计何时到峰/已过峰",
    "basis": "为什么这么判断（热度曲线/事件性质/历史同类）"
  },
  "competition_heat": {
    "already_selling": true,
    "level": "无竞争 | 少量 | 已饱和",
    "differentiation": "如何在已有竞争者中差异化（基于主人技能优势）"
  },
  "scores": {
    "热度证据": { "score": 0, "reason": "①档位依据 ②置信度" },
    "变现路径清晰度": { "score": 0, "reason": "..." },
    "启动成本": { "score": 0, "reason": "..." },
    "时效性": { "score": 0, "reason": "..." }
  },
  "first_step": {
    "time_box": "今晚 30 分钟",
    "action": "具体动作",
    "object": "交付物",
    "channel": "闲鱼",
    "quantity": "挂 1 个",
    "completion_rule": "上架发布即完成，出单不是你能控制的",
    "copyable_listing_copy": "可直接复制的闲鱼上架文案（标题+描述+定价+标签，完整可粘贴）"
  },
  "verdict": "做（总分 78）：..."
}
```

与 L2 的差异说明：
- **没有三证**（evidence_trilogy）：热榜没有买方，不适用。
- **没有时薪反算**（hourly_check）：热点机会的「单价×工时」极难估算（信息产品的边际成本趋零），强行反算会产出虚假精度。
- **没有魔鬼代言人**（devil_advocate）：热点机会的下行风险是「热度散了卖不出去」，这在 `time_window` 和 `competition_heat` 字段里已经覆盖。保留它会让 prompt 过长、挤占 thinking 预算。
- **新增** `what_to_sell` / `where_to_sell` / `pricing_anchor` / `time_window` / `competition_heat`：这些是变现假设的核心，L2 里没有对应物。
- **first_step 的 `copyable_first_message` 改为 `copyable_listing_copy`**：L2 的话术是发给需求方的私信；L3 的是上架到平台的商品文案，性质不同。
- **verdict 规则**与 L2 对齐：总分 ≥60 →「做」；40-59 →「谨慎做」；<40 →「不做」。

---

## 3. 四维评分适配

### 3.1 维度替换

现有 L2 四维（需求真实性/行动可行性/独特性/时效性）是为需求侧信号设计的。L3 替换为：

| L2 维度 | L3 替换维度 | 权重 | 口径要点 |
| --- | --- | --- | --- |
| 需求真实性 (40) | **热度证据** (30) | 跨源去重后保留的热度值（多源命中的最高值）+ 持续上升=80~95；单源高热=60~75；单源低热或已过峰=30~50。需引用具体热度数字/排名作依据 |
| 行动可行性 (30) | **启动成本** (25) | 今晚 30 分钟能产出可上架交付物=80~95；需 1-2 天=60~75；需一周以上或需采购物料=30~50。衡量「多快能上架」 |
| 独特性 (15) | **变现路径清晰度** (30) | 交付物明确+渠道明确+定价有据=80~95；交付物或渠道模糊=50~70；想不出卖什么=20~40。这是最重要的维度 |
| 时效性 (15) | **时效性** (15) | 热度还有 3-5 天=80~95；1-2 天=60~75；已过峰=20~40。所有热点天然有时效性，权重不拉太高 |

权重总和 = 30+25+30+15 = 100。

### 3.2 为什么这样调权重

- **热度证据降权到 30**（L2 需求真实性是 40）：热榜条目天然有热度（否则不会出现在热榜），但「有热度」≠「能变现」。过度信任热度会导致假阳性。降权留空间给变现路径。
- **变现路径清晰度提到 30**（L2 独特性只有 15）：热点机会的核心风险不是「别人也知道了」（热榜人人可见，独特性本就低），而是「想不出卖什么」。路径不清晰的机会对主人毫无价值。提权确保只有真正能落地为交付物的才进 today。
- **启动成本 25**：热点机会的价值在于「赶热度窗口」——启动越快窗口越长。但成本不等于价值，只是门槛，不给到 30。
- **时效性保持 15**：所有热点天然有时效性，区分度不如其他三维。且时效性已通过 `time_window` 字段独立展示，评分里不再重复强调。

### 3.3 计算公式

```typescript
function computeHotspotScore(s: HotspotScores): number {
  const v = (x: { score: number | null }) => (typeof x.score === "number" ? x.score : 0);
  return Math.round(
    (v(s["热度证据"]) * 30 + v(s["启动成本"]) * 25 +
     v(s["变现路径清晰度"]) * 30 + v(s["时效性"]) * 15) / 100
  );
}
```

与 L2 的 `computeTotalScore` 对齐：0-100 分制，加权求和后取整。

### 3.4 分档阈值

| 档位 | 条件 | 说明 |
| --- | --- | --- |
| 🔴 today | score ≥ 65 **且** time_window.days_left ≤ 3 **且** 启动成本得分 ≥ 70 | 三重门槛：分数够 + 窗口够短（紧迫） + 今晚能做完。三者缺一不可 |
| 🟡 week | score ≥ 40 | 窗口 > 3 天或启动成本不够低，但仍有价值 |
| ⚪ archived | score < 40 | 热度散了或想不出卖什么 |

阈值比 L2 更严（L2 today 是 70+技配 60，L3 today 是 65+时效+成本三重门槛），因为热点机会天然不稳定，需要多重过滤降低假阳性。

---

## 4. 成本闸

### 4.1 采集频率

| 参数 | 值 | 理由 |
| --- | --- | --- |
| 采集频率 | 4 次/天（每 6 小时） | 热榜变化快但不至于 30 分钟一变；4 次/天平衡时效与成本 |
| crontab | `0 0,6,12,18 * * *` | 与现有 `0,30 * * * *`（每 30 分钟）独立，互不干扰 |
| 每源每次采集 | 抖音 top 50 + 微博 top 50 + 知乎 top 10 + 百度 top 20 + 头条 top 50 | 五源合计 ~180 条，跨源去重后 ~50-80 条入库。各源 limit 可在 adapter config 里调 |

**为什么不是每 30 分钟**：现有源（电鸭/HN）是需求侧信号，新帖出现频率低，30 分钟合理。热榜是趋势侧信号，单条热度持续数小时到数天，30 分钟采集会产生大量重复条目（虽然去重会跳过，但白白发请求）。6 小时一次足以捕捉新热点。

### 4.2 跨源热点去重（必答题）

五源采集时，同一热点会同时挂在抖音+微博+头条榜上（如「龙虾火爆」可能出现在全部五源）。绝不能分析三遍。

**两阶段去重**：

#### 阶段 1：入库前精确去重（复用现有机制）

复用 `findDuplicate()` + `normalizeTitle()`（trim + 小写 + 去标点）。已存在的条目直接跳过，不入库。这一层只做标题完全匹配。

#### 阶段 2：跨源相似去重（新增，入库前执行）

在采集入口 `/api/cron/collect-hotspot/route.ts` 中，五源全部 fetch 完之后、入库之前，对本次采集的所有 `RawSignal[]` 做一轮跨源相似度匹配：

```text
1. 合并五源的 RawSignal[] 为一个数组（标注来源）
2. 归一化每条标题：normalizeTitle()（已有）
3. 两两比较相似度：
   - 提取标题中的 2-gram 词组集合（相邻 2 字/词）
   - 计算 Jaccard 相似度 = |交集| / |并集|
   - Jaccard ≥ 0.5 → 判定为同一趋势
   - 或：一方标题完全包含另一方（如「小龙虾火爆」包含于「如何评价小龙虾火爆现象」）→ 同一趋势
4. 同一趋势的多条记录只保留热度值最高的一条
5. 保留条的 content 拼入其他命中的来源名（如「[多源: 抖音,微博,头条]」）
6. 保留条的 sourceType 取热度最高那条的来源
7. 被合并丢弃的其他条不入库
```

**为什么用 2-gram Jaccard 而非编辑距离**：
- 编辑距离 O(n²) 对长标题开销大；2-gram 集合做 Set 交集 O(n)，够快。
- Jaccard 对词序不敏感（「龙虾火爆」和「火爆的龙虾」会匹配），这对中文热榜标题（经常换语序）很关键。
- 阈值 0.5 是保守起点——上线后可调：误合（不同趋势被合并）比漏合（同一趋势分析三遍）更严重，所以初始宁可高一点。配合 §4.4 的 LLM 语义层去重做兜底。

**热度值归一化**：不同源的热度值口径不同（抖音 hot_value 几百万、微博 hot_value 几万、知乎热度几千万）。不能直接比大小。归一化方案：各源内部按相对排名计算百分位（排名第 1 = 100，排名第 50 = 0），跨源比百分位。取百分位最高的条保留。

| 参数 | 值 | 理由 |
| --- | --- | --- |
| 去重粒度 | 2-gram Jaccard ≥ 0.5 或包含关系 | 中文热榜标题常换语序，需词组级匹配 |
| 去重窗口 | 跨源即时 + 24h 历史查 items 表 | 即时防同批重复；历史防跨次重复 |
| 热度归一化 | 各源内排名百分位 | 不同源热度值口径不同，不可直接比大小 |
| 被丢弃条目 | 不入库（阶段 2 在入库前执行） | 阶段 1 的精确去重已覆盖已存在条目；阶段 2 的相似去重只处理本次新条目间的重复 |
| 多源命中标记 | content 前缀 `[多源: 抖音,微博]` | L3 分析时知道热度跨源验证过，热度证据可加分 |

**局限与兜底**：2-gram Jaccard 做不了语义去重（「龙虾火爆」和「夏天必吃小龙虾」可能 Jaccard < 0.5 但描述同一趋势）。兜底：预筛 prompt 注入最近 24h 已分析标题列表（§4.4），让 LLM 做语义层去重。

### 4.3 LLM 调用预算

| 调用 | 模型 | max_tokens 公式 | 每天上限 | 理由 |
| --- | --- | --- | --- | --- |
| 预筛 | MODEL_FAST（对话档） | `min(6000 + 1000×(n-1), 16000)` | 4 次（1 批/次，跨源去重后 50-80 条/批） | 复用 L1 的批调用公式：思考型模型 thinking 计入 max_tokens，批内条数越多 thinking 越长。50-80 条时 max_tokens 触顶 16000 |
| L3 | MODEL_THINK（推理档） | 12000（固定） | 2-3 次（预筛严格控制通过率） | 与 L2 对齐：深度分析需要足够 thinking 空间 |
| 日总 LLM 调用 | — | — | ~7 次 | 预筛 4 + L3 约 3，成本可控 |

预筛必须严格的原因在这里：每多放一条进 L3 就多一次 12000 tokens 的推理档调用。预筛通过率控制在 3-5%（每批 50-80 条跨源去重后只放 2-3 条），日 L3 调用 ≤ 3 次。

> 注：预筛从「2 源 × 4 次/天 = 8 次」降为「5 源合 1 批 × 4 次/天 = 4 次」——五源合并去重后一次预筛调用处理全量，比每源单独预筛更省 token，也避免了同趋势跨源重复预筛。

### 4.4 预筛 prompt 注入最近已分析标题

预筛的 system prompt 里注入「最近 24h 已通过预筛的热点标题列表」（查 items 表 `WHERE sourceType IN ('source:douyin-hot','source:weibo-hot','source:zhihu-hot','source:baidu-hot','source:toutiao-hot') AND aiStage IN ('l1_done','ready') AND updatedAt > now-86400000`），让 LLM 在判断时做语义层去重。这比 2-gram Jaccard 更有效（能识别「龙虾火爆」与「夏天必吃小龙虾」是同一趋势），代价是 prompt 略长（+200-500 tokens），远低于多跑一次 L3 的成本。

---

## 5. 落库与呈现

### 5.1 数据模型（零 schema 变更）

现有 `items` 和 `opportunities` 表完全复用，不加列：

| 表 | 字段 | 热点取值 | 说明 |
| --- | --- | --- | --- |
| items | sourceType | `source:douyin-hot` / `source:weibo-hot` / `source:zhihu-hot` / `source:baidu-hot` / `source:toutiao-hot` | 五种新 sourceType 值 |
| items | aiStage | pending → l1_done → ready / archived / failed | 复用现有阶段名（语义不同但状态机兼容） |
| items | l1 | 预筛结论 JSON | 复用字段存预筛结果（含 relevance/monetizability/time_window/reason） |
| opportunities | type | `"热点衍生"` | 新 type 值（text 字段无约束，直接用） |
| opportunities | score | L3 四维加权总分 | 与 L2 总分口径一致（0-100） |
| opportunities | skillMatch | `null` | 热点机会不做技能匹配（语义不同），首页显示「—」 |
| opportunities | skillMatchDetail | `null` | 同上 |
| opportunities | fastTrack | `0` | 快通道是接单专属，热点不适用 |
| opportunities | analysis | L3 JSON | 完整 L3 变现假设 |
| opportunities | tier | today / week / archived | L3 独立分档规则（见 §3.4） |

**为什么 `skillMatch = null`**：L1 的技能匹配是「需求方要的技能 vs 主人有的技能」。热点机会没有需求方，是主人主动推导「我能做什么」。强行算 skillMatch 会误导用户。首页和详情页对 null 的处理是显示「—」，语义正确。

### 5.2 sourceType 与来源标签

`lib/source-label.ts` 新增映射：

```typescript
"source:douyin-hot": "抖音热搜",
"source:weibo-hot": "微博热搜",
"source:zhihu-hot": "知乎热榜",
"source:baidu-hot": "百度热搜",
"source:toutiao-hot": "头条热榜",
```

现有首页卡片已有来源徽章（`sourceLabel(item.sourceType)`），零 UI 改动即自动展示「抖音热搜」/「微博热搜」等标签。

### 5.3 opportunities.type = "热点衍生"

现有 L1 的 `CATEGORIES` 数组不含「热点衍生」，但 `opportunities.type` 是 text 字段无约束。L3 直接写入 `"热点衍生"` 即可。

L2 的 `PLAYBOOK` 按 type 召回，`"热点衍生"` 无匹配条目 → `playbookBlock` 为空 → L3 prompt 不注入 playbook。L3 有自己的上下文和变现路径引导，不需要 playbook（playbook 是需求侧打法的总结，不适用于趋势侧机会）。

首页卡片已有 type 徽章（`{item.type}`），会自动展示「热点衍生」标签。

### 5.4 UI 复用方案（不加新页面）

| 现有 UI 元素 | 热点数据如何复用 | 需要改什么 |
| --- | --- | --- |
| 首页「🔴 今天看」卡片 | 热点机会 tier=today 时自动出现 | 零改动 |
| 首页「🟡 本周看」列表 | 热点机会 tier=week 时自动出现 | 零改动 |
| 首页来源徽章 | sourceLabel 返回「抖音热搜」/「微博热搜」/「知乎热榜」/「百度热搜」/「头条热榜」 | `source-label.ts` 加 5 行映射 |
| 首页 type 徽章 | 显示「热点衍生」 | 零改动 |
| 机会详情页三证卡 | L3 不产出三证 → 该区域显示空态 | 详情页加条件渲染：type==="热点衍生" 时不显示三证 |
| 机会详情页四维评分 | L3 产出自己的四维 → 自动渲染 | 详情页 `SCORE_DIMS` 配置需按 type 切换维度名和权重 |
| 机会详情页时薪账 | L3 不产出时薪账 → 不显示 | 详情页加条件渲染：type==="热点衍生" 时不显示时薪账 |
| 机会详情页魔鬼代言人 | L3 不产出 → 不显示 | 同上 |
| 机会详情页第一步 | L3 产出 `first_step`（含 `copyable_listing_copy`） | 详情页第一步区：type==="热点衍生" 时把「开口话术」标签改为「上架文案」，取 `copyable_listing_copy` |
| 机会详情页原始信息 | items.content 已存热榜原文 | 零改动 |
| 信息库 | archived 热点条目自动可搜 | 零改动 |

**详情页改动量**：约 3 处条件渲染 + 1 处标签文案切换。不改数据流、不加页面、不加路由。

### 5.5 首页 today 列表的挤占问题

现有 today 上限 ≤3 条。热点机会天然时效强，但它与接单快通道机会争夺同一个首页位置。

**裁决：不加配额，按分数公平竞争。**

理由：
1. 「宁空勿凑」原则不允许为了热点加第 4 个 slot。如果 today 已满 3 条，新热点机会要挤掉最弱的一条（不管它是热点还是接单）。
2. 热点机会的 score 是 L3 四维加权（热度证据 + 变现路径 + 启动成本 + 时效性），与 L2 四维加权口径一致，可比。
3. 热点的时效性已经在 score 里体现（time_window.days_left ≤ 3 才能 today），不需要额外加成。
4. 用户可以手动改档位（userTier）把热点降为 week、把接单升为 today，系统不强占用户决策权。

**dashboard 查询不需要改动**：现有 `GET /api/dashboard` 按 `tier IN ('today') OR userTier IN ('today')` 查询，热点机会 tier=today 自动出现。排序 `ORDER BY fastTrack, createdAt DESC` 也合理——热点机会 fastTrack=0，排在接单快通道后面（快通道是「待验证」性质，优先级合理）。

---

## 6. 分档门槛建议

### 6.1 热点 today 资格的三重门槛

与 L2 的 today 规则（score ≥ 70 且 skillMatch ≥ 60）不同，L3 的 today 规则是三重门槛：

```text
score ≥ 65
AND time_window.days_left ≤ 3
AND scores.启动成本.score ≥ 70
```

为什么需要三重：
- **score ≥ 65**：比 L2 的 70 略低，因为热点机会的评分尺度天然偏低（热度证据和变现路径比需求侧更难拿高分）。
- **days_left ≤ 3**：热点机会的核心价值是「赶热度窗口」。如果窗口还有 7 天，不急迫，放 week 即可。只有 ≤ 3 天才有 today 的紧迫性。
- **启动成本 ≥ 70**：对应「今晚 30 分钟能做完」。如果需要 2-3 天才能产出交付物，就算热度在，也来不及。这是「第一步今晚可做」的产品承诺的量化保证。

### 6.2 与现有 today 的共存规则

```text
dashboard today 查询（不改）：
  WHERE (tier = 'today' OR userTier = 'today') AND status != 'ignored'
  ORDER BY fastTrack ASC, createdAt DESC
  LIMIT 3

热点机会 tier = today 时自动出现，与接单快通道机会一起排序。
fastTrack = 0 的热点机会排在 fastTrack = 1 的接单快通道后面。
如果 today 已有 3 条，新热点如果 score 更高，不会自动挤掉——
它会在下次 dashboard 查询时出现在列表里（LIMIT 3 取最新的）。

用户手动改档：用户可以把任何机会改到 today/week/archived，
userTier 优先于 tier。
```

**不做自动挤占**的理由：自动挤掉已有 today 机会会破坏用户的预期（用户可能正在执行那个机会的第一步）。新增机会进 week，让用户自己决定是否升 today。

### 6.3 宁空勿凑优先

如果某次采集预筛全部拒绝（热榜没有可变现趋势），或者 L3 全部 score < 65，则 today 不出现热点机会。首页照常显示接单/其他类型机会，或「今天没有值得看的机会」。**绝不为了填充 today 而降低阈值**。

---

## 7. 冲突裁决记录

### 7.1 微博/腾讯新闻榜侦察结论推翻与重接

**旧侦察结论（已推翻）**：微博热搜 ajax 接口 403，需 cookie，放弃；腾讯新闻榜/第三方聚合返回空响应，放弃。

**新侦察结论（2026-09-12 实测）**：
- 微博热搜 ✅ 开源聚合 `GET https://60s-api.viki.moe/v2/weibo`（github.com/vikiboss/60s），返回 `data[]`（title/hot_value/link），50 条，无需 cookie
- 腾讯新闻榜（头条热榜）✅ 同一 60s API `/v2/toutiao`，50 条

因此微博和头条**纳入**。旧 §7.1 结论作废。

### 7.2 为什么独立分支而非复用 L1

见 §1.2。核心原因：L1 的噪声规则会正确判噪所有热榜条目（无需求方 = 噪声），这是 L1 设计正确而非 bug。热点信号的性质与需求侧信号根本不同，强行复用 L1 会导致 100% 判噪。

### 7.3 为什么不做微信热榜

微信生态封闭，无公开热榜接口。**不做硬接**，理由：

1. 微信热文多为抖音/微博二次传播——四源（抖音/微博/知乎/百度）已提前覆盖同一热点。微信不接不会漏趋势。
2. 微信公众号文章有搜狗微信搜索可间接获取，但接口不稳定、需维护，违反「采集器维护是第三周死亡路径」原则。
3. 兜底走已有手动快录通道：用户刷到微信热点（如朋友圈/群聊/看一看）可直接粘贴投递，30 秒入库走 L1→L2 流程。

### 7.4 60s API 降级策略与请求克制

60s API（`60s-api.viki.moe`）是第三方开源聚合，稳定性不保证。设计如下降级：

| 场景 | 降级策略 |
| --- | --- |
| 60s API 完全挂了 | 微博/头条不可用，但抖音有官方接口 + 知乎有官方 API + 百度有官方 HTML，三源仍覆盖热点主战场。热榜少两源不崩 |
| 60s 微博端点挂了 | 微博不可用，其余四源正常。微博的热点大概率也在抖音上榜 |
| 60s 头条端点挂了 | 头条不可用（头条本来就是顺手加的成本≈0，少它无影响） |
| 抖音官方接口挂了 | 抖音不可用，但微博大概率有同一热点 |

**请求频率克制**：4 次/天已足够（热榜变化频率以小时计，不是分钟）。60s API 是免费公共服务，高频请求不礼貌也不必要。适配器加 `FETCH_TIMEOUT_MS = 15000`（已有）+ 失败静默不阻塞其他源。

### 7.5 为什么预筛不通过也进 items

见 §1.3。审计价值 > 存储成本。本地 SQLite 单用户，日增几百条 archived 无压力。信息库可搜被拒条目，方便调优预筛 prompt。

### 7.6 为什么 skillMatch = null 而非算一个值

L1 的 skillMatch 是「需求方要的技能 vs 主人有的技能」的匹配率。热点机会没有需求方，是主人主动推导「我能做什么」。强行算 skillMatch（比如「主人有内容生产技能 → 80%」）会制造虚假精度，且与首页接单机会的 skillMatch 语义混淆。null 让首页显示「—」，语义清晰。

### 7.7 为什么不做独立的「热点机会」页面

V2 设计原则砍到 6 个页面。加页面违反「砍功能优先于加功能」。热点机会用 type 徽章 + 来源徽章区分，在三档体系内自然流动，不需要独立页面。用户在首页 today/week 看到它，在机会列表看到它，在详情页看到分析——和其他机会一样。

### 7.8 为什么 L3 不做魔鬼代言人

L2 的魔鬼代言人挑的是「会让主人白干一场的坑」（验收风险/账期/需求蔓延）。热点机会的下行风险单一明确：热度散了卖不出去。这在 `time_window.days_left` 和 `competition_heat` 里已覆盖。保留 devil_advocate 只会让 prompt 过长、挤占 thinking 预算，输出还是那句「热度可能很快散去」。

### 7.9 V2 原则「纯新闻源不接」是否被违反

**不违反**。V2 原则的完整表述（§2 第 13 条）：「信息源接入标准 = 能否产出『谁在花钱 + 需要什么技能』。纯新闻源免费也不接。」

热榜确实是新闻/趋势，但本功能**入库的不是热榜资讯本身**——入库的是**带行动建议的机会假设**（L3 变现假设：卖什么 + 在哪卖 + 定价 + 第一步）。热榜只是原料，经过预筛和 L3 加工后产出的是行动工件，符合 V2 第 10 条「没有行动建议的机会不允许进首页」。

同时，热榜条目绝不混进 L1→L2 流程（§1.2 已隔离），不会污染需求侧信号池。

---

## 8. 热榜源适配器设计

### 8.1 抖音热搜适配器（`lib/sources/douyin-hot.ts`）

```text
接口：GET https://www.douyin.com/aweme/v1/web/hot/search/list/
请求头：User-Agent: BROWSER_UA + Referer: https://www.douyin.com/
返回：JSON，data.word_list[]（word=标题，hot_value=热度），最多 50 条
直连：✅ 无需 cookie
解析：
  for each item in data.word_list[]:
    title = item.word
    content = `${title} 热度:${item.hot_value}`
    url = `https://www.douyin.com/hot/${item.position}`
  → RawSignal { title, content, url }
```

抖音官方接口，消费级热点主战场，列为最高优先级源。

### 8.2 微博热搜适配器（`lib/sources/weibo-hot.ts`）

```text
接口：GET https://60s-api.viki.moe/v2/weibo
返回：JSON，data[]（title/hot_value/link），50 条
直连：✅ 第三方开源聚合（github.com/vikiboss/60s），无需 cookie
解析：
  for each item in data[]:
    title = item.title
    content = `${title} 热度:${item.hot_value}`
    url = item.link || null
  → RawSignal { title, content, url }
降级：60s API 挂了 → 该源返回空数组（不抛错），不阻塞其他源
```

推翻旧侦察结论「微博 403 需 cookie」——通过 60s 开源聚合绕过。

### 8.3 知乎热榜适配器（`lib/sources/zhihu-hot.ts`）

```text
接口：GET https://api.zhihu.com/topstory/hot-list?limit=10
返回：JSON，data[].target.title + data[].detail_text（热度词）
直连：✅ 服务器国内，无需代理
解析：
  for each item in data[]:
    title = item.target.title
    content = `${title}。${item.detail_text} 热度:${item.detail_text}`
    url = `https://www.zhihu.com/hot/${item.target.id}`
  → RawSignal { title, content, url }
```

与现有适配器模式一致：只负责抓取和解析，不碰数据库、不做去重（`/api/cron/collect-hotspot/route.ts` 统一处理）。

### 8.4 百度热搜适配器（`lib/sources/baidu-hot.ts`）

```text
接口：GET https://top.baidu.com/board?tab=realtime
返回：HTML，需解析（标题 + 热度词结构稳定）
直连：✅ 200
解析（HTML 解析，非 JSON）：
  用正则或 DOM 解析提取榜单条目：
  - 标题：.c-single-text-wrapper 或同等选择器
  - 热度：.hot 文本
  → RawSignal { title, content: `${title} 热度:${hotValue}`, url }
  注意：HTML 结构可能改版，适配器需 try-catch + 结构校验
  失败时 briefError 上报，不阻塞采集
```

与电鸭适配器（`eleduck.ts`）的 HTML 解析模式一致：`BROWSER_UA` + `timeoutSignal()` + 正则提取 + 结构校验。

### 8.5 头条热榜适配器（`lib/sources/toutiao-hot.ts`）

```text
接口：GET https://60s-api.viki.moe/v2/toutiao
返回：JSON，data[]（title/hot_value/link），50 条
直连：✅ 同 60s API
解析：与微博适配器同构（data[] 结构一致）
降级：同 §8.2
```

顺手加，成本≈0。头条热榜与百度热搜优先级并列最低。

### 8.6 适配器注册

`lib/sources/index.ts` 的 `ADAPTERS` 注册表新增：

```typescript
export const ADAPTERS: Record<string, SourceAdapter> = {
  // ... 现有
  [douyinHotAdapter.key]: douyinHotAdapter,
  [weiboHotAdapter.key]: weiboHotAdapter,
  [zhihuHotAdapter.key]: zhihuHotAdapter,
  [baiduHotAdapter.key]: baiduHotAdapter,
  [toutiaoHotAdapter.key]: toutiaoHotAdapter,
};
```

但 `DEFAULT_SOURCES`（现有源种子）**不加**热点源——热点源由独立 cron 端点管理，不走 `sources` 表。这样现有 cron 不会误采集热点源。

---

## 9. 采集入口设计

### 9.1 独立 cron 端点（`app/api/cron/collect-hotspot/route.ts`）

与现有 `app/api/cron/collect/route.ts` 平行，但逻辑不同：

```text
1. 鉴权：CRON_SECRET（与现有 collect 共用环境变量）
2. 不查 sources 表，直接调五个热点适配器：
   - douyinHotAdapter.fetchSignals() → RawSignal[]（标记 source:douyin-hot）
   - weiboHotAdapter.fetchSignals() → RawSignal[]（标记 source:weibo-hot）
   - zhihuHotAdapter.fetchSignals() → RawSignal[]（标记 source:zhihu-hot）
   - baiduHotAdapter.fetchSignals() → RawSignal[]（标记 source:baidu-hot）
   - toutiaoHotAdapter.fetchSignals() → RawSignal[]（标记 source:toutiao-hot）
   - 单源失败静默跳过，不阻塞其他源（§7.4 降级策略）
3. 跨源去重（§4.2 阶段 2）：
   - 合并五源 RawSignal[]，标注来源
   - 2-gram Jaccard ≥ 0.5 或包含关系 → 同一趋势，保留热度百分位最高的一条
   - 保留条的 content 拼入 [多源: 抖音,微博] 标记
4. 逐条精确去重入库（复用 findDuplicate + normalizeTitle，§4.2 阶段 1）：
   - sourceType = "source:{douyin|weibo|zhihu|baidu|toutiao}-hot"
   - aiStage = "pending"
5. 批量预筛：
   - 收集本次入库的所有 pending 热点 items
   - 注入最近 24h 已分析标题列表
   - 一次 LLM 调用（MODEL_FAST，批量公式 max_tokens）
   - 通过 → aiStage = "l1_done"，items.l1 = 预筛 JSON
   - 不通过 → aiStage = "archived"，items.l1 = 预筛 JSON（含 reason）
6. 对通过的条目逐条调 L3：
   - MODEL_THINK，max_tokens = 12000
   - 产出变现假设
   - 落 opportunities 表（type = "热点衍生"，tier = L3 分档结果）
   - items.aiStage = "ready"
7. 返回采集 + 去重 + 预筛 + L3 结果摘要
```

### 9.2 crontab

```cron
# 现有：每 30 分钟采集需求侧信号
0,30 * * * * curl -s -H 'x-cron-secret: $CRON_SECRET' http://localhost:3000/api/cron/collect

# 新增：每 6 小时采集趋势侧信号
0 0,6,12,18 * * * curl -s -H 'x-cron-secret: $CRON_SECRET' http://localhost:3000/api/cron/collect-hotspot
```

---

## 10. 实施任务清单

以下任务可直接派单。按依赖顺序排列，可并行标注。

### 任务 1：抖音热搜适配器（最高优先级）
- 文件：`lib/sources/douyin-hot.ts`（新建）
- 依赖：`lib/sources/types.ts`（已有）
- 内容：实现 `SourceAdapter`，调 `https://www.douyin.com/aweme/v1/web/hot/search/list/`，带 `BROWSER_UA` + `Referer: https://www.douyin.com/`，解析 JSON `data.word_list[]`（word=标题，hot_value=热度），产出 `RawSignal[]`
- 参考：`lib/sources/hn.ts`（JSON API 适配器的范例）
- 验收：`fetchSignals()` 返回 ≤50 条 `RawSignal`，title + content 非空，无 cookie 可用

### 任务 2：微博 + 头条热搜适配器（合并，同 60s API）
- 文件：`lib/sources/weibo-hot.ts` + `lib/sources/toutiao-hot.ts`（均新建）
- 依赖：`lib/sources/types.ts`（已有）
- 内容：两个适配器结构几乎相同——调 `https://60s-api.viki.moe/v2/weibo` 和 `/v2/toutiao`，解析 `data[]`（title/hot_value/link），产出 `RawSignal[]`。可先写一个抽公共函数，两个 adapter key 不同
- 降级：60s API 请求失败时返回空数组（不抛错），不阻塞其他源
- 验收：两个 `fetchSignals()` 各返回 ≤50 条 `RawSignal`，title 非空；60s 挂了返回空数组不崩

### 任务 3：知乎热榜适配器（与任务 1/2 并行）
- 文件：`lib/sources/zhihu-hot.ts`（新建）
- 依赖：`lib/sources/types.ts`（已有）
- 内容：实现 `SourceAdapter`，调 `https://api.zhihu.com/topstory/hot-list?limit=10`，解析 JSON，产出 `RawSignal[]`
- 参考：`lib/sources/hn.ts`（JSON API 适配器的范例）
- 验收：`fetchSignals()` 返回 ≤10 条 `RawSignal`，title + content 非空

### 任务 4：百度热搜适配器（与任务 1/2/3 并行）
- 文件：`lib/sources/baidu-hot.ts`（新建）
- 依赖：`lib/sources/types.ts`（已有）
- 内容：实现 `SourceAdapter`，抓 `https://top.baidu.com/board?tab=realtime`，正则解析 HTML，产出 `RawSignal[]`
- 参考：`lib/sources/eleduck.ts`（HTML 解析适配器的范例）
- 验收：`fetchSignals()` 返回 ≤20 条 `RawSignal`，title 非空，HTML 改版时 briefError 上报不崩

### 任务 5：适配器注册 + 来源标签（依赖任务 1-4）
- 文件：`lib/sources/index.ts`（改）、`lib/source-label.ts`（改）
- 内容：`ADAPTERS` 注册表加 5 个热点适配器（`douyin-hot` / `weibo-hot` / `zhihu-hot` / `baidu-hot` / `toutiao-hot`）；`source-label.ts` 加 5 行映射；`DEFAULT_SOURCES` 不加（热点不走 sources 表）
- 验收：5 个 key 均可在 `ADAPTERS` 取到；`sourceLabel("source:douyin-hot")` 返回「抖音热搜」等

### 任务 6：跨源去重模块（与任务 5 可并行，不依赖适配器）
- 文件：`lib/hotspot-dedup.ts`（新建）
- 依赖：`lib/sources/types.ts`（RawSignal 类型）
- 内容：
  - `dedupCrossSource(signals: TaggedRawSignal[]): TaggedRawSignal[]`：
    - 合并五源信号，标注来源
    - 归一化标题（复用 `normalizeTitle`）
    - 计算 2-gram 词组集合的 Jaccard 相似度
    - Jaccard ≥ 0.5 或一方标题包含另一方 → 判定同一趋势
    - 同一趋势多条只保留热度百分位最高的一条
    - 保留条的 content 前缀 `[多源: 抖音,微博]`
  - `hotValuePercentile(signal, allFromSameSource)`：各源内按排名算百分位（第 1 = 100，第 N = 0）
- 验收：输入 3 条同趋势不同标题（如「龙虾火爆」「小龙虾火爆了」「如何评价龙虾火爆」）→ 合并为 1 条，content 含 `[多源:...]` 标记

### 任务 7：预筛 AI 模块
- 文件：`lib/ai/hotspot.ts`（新建）
- 依赖：`lib/ai/gateway.ts`（已有）、`lib/profile.ts`（已有，注入技能画像）
- 内容：
  - `HotspotPreFilterSchema`（Zod，见 §2.1）
  - `buildPreFilterSystem(now, recentTitles, profileLine)`：构建预筛 system prompt，注入日期、主人技能画像、最近 24h 已分析标题列表
  - `runHotspotPreFilter(inputs, recentTitles, profileLine)`：批量调用，max_tokens 公式 `min(6000 + 1000×(n-1), 16000)`，解析 + 一次修正重试（与 L1 对齐）
- 参考：`lib/ai/l1.ts`（批调用 + Zod + 重试的范例）
- 验收：输入 50-80 条热点 → 输出等量预筛结果，通过率 3-5%

### 任务 8：L3 变现假设 AI 模块（与任务 7 可并行）
- 文件：`lib/ai/hotspot.ts`（同文件追加）
- 依赖：任务 7 的 schema 定义
- 内容：
  - `HotspotL3Schema`（Zod，见 §2.2）
  - `buildL3Prompt(input)`：构建 L3 prompt，注入热榜原文 + 预筛结论 + 主人技能画像
  - `runHotspotL3(input)`：单条调用，MODEL_THINK，max_tokens = 12000，解析 + 一次修正重试
  - `computeHotspotScore(scores)`：四维加权求和（§3.3）
- 参考：`lib/ai/l2.ts`（单条调用 + Zod + 重试 + 评分计算的范例）
- 验收：输入一条预筛通过的热点 → 输出完整 L3 JSON，所有字段通过 Zod 校验

### 任务 9：热点流水线
- 文件：`lib/hotspot-pipeline.ts`（新建）
- 依赖：任务 7 + 8、`lib/db/schema.ts`（已有）、`lib/profile.ts`（已有）
- 内容：
  - `processHotspotBatch(itemIds: number[])`：
    1. 加载批内 items
    2. 查最近 24h 已分析标题列表
    3. 批量预筛（`runHotspotPreFilter`）
    4. 通过 → `aiStage = "l1_done"` + items.l1 = 预筛 JSON
    5. 不通过 → `aiStage = "archived"` + items.l1 = 预筛 JSON
    6. 对通过的逐条调 `runHotspotL3`
    7. 落 opportunities 表（type = "热点衍生"，tier = 分档结果，score = 总分，skillMatch = null，fastTrack = 0，analysis = L3 JSON）
    8. `aiStage = "ready"`
  - 分档逻辑（§3.4）：score ≥ 65 且 days_left ≤ 3 且 启动成本 ≥ 70 → today；score ≥ 40 → week；< 40 → archived
- 参考：`lib/pipeline.ts` 的 `processBatch` + `processItemL1Done`（批处理 + 分档的范例）
- 验收：输入一批 item IDs → 预筛拒绝的 archived，通过的产出 opportunities 行，tier 正确

### 任务 10：采集 cron 端点（依赖任务 1-9）
- 文件：`app/api/cron/collect-hotspot/route.ts`（新建）
- 依赖：任务 1-9 全部完成
- 内容：
  - `GET` / `POST` 都支持（与现有 collect 对齐）
  - `CRON_SECRET` 鉴权
  - 调 5 个热点适配器（单源失败静默跳过）
  - 跨源去重（调 `dedupCrossSource`，任务 6）
  - 逐条 `findDuplicate` + 入库（5 种 sourceType）
  - 调 `processHotspotBatch(insertedIds)`
  - 返回 JSON 摘要（每源 found/inserted + 去重合并数 + preFilterPass/l3Done/error）
- 参考：`app/api/cron/collect/route.ts`（鉴权 + 采集 + 入库的范例）
- 验收：`curl -H 'x-cron-secret: ...' http://localhost:3000/api/cron/collect-hotspot` 返回 200，items 表有新热点条目，opportunities 表有新机会行

### 任务 11：详情页条件渲染（与任务 10 可并行）
- 文件：`app/opportunities/[id]/page.tsx`（改）
- 依赖：无（纯前端改动）
- 内容：
  - type === "热点衍生" 时不渲染三证卡（`evidence_trilogy`）
  - type === "热点衍生" 时不渲染时薪账（`hourly_check`）
  - type === "热点衍生" 时不渲染魔鬼代言人（`devil_advocate`）
  - type === "热点衍生" 时四维评分切换为 L3 四维（热度证据/启动成本/变现路径清晰度/时效性，权重 30/25/30/15）
  - type === "热点衍生" 时第一步区：标签从「开口话术」改为「上架文案」，取 `copyable_listing_copy` 字段
- 验收：打开一个 type="热点衍生" 的机会详情页，不显示三证/时薪/魔鬼代言人，四维评分维度正确，第一步显示上架文案

### 任务 12：新增「热点衍生」展示字段（与任务 11 可并行，也可推迟）
- 文件：`app/opportunities/[id]/page.tsx`（改，与任务 11 同文件）
- 依赖：任务 11
- 内容：
  - type === "热点衍生" 时在 verdict 下方新增「变现假设」区：展示 `what_to_sell`、`where_to_sell`、`pricing_anchor`、`time_window`、`competition_heat`
  - 使用现有的 `KeyValue` 组件和 `Section` 组件，零新组件
- 验收：详情页展示「卖什么/在哪卖/定价锚/时效窗/竞争热度」五个字段

### 任务 13：端到端验收（依赖全部）
- 内容：配置 crontab，运行一次 `/api/cron/collect-hotspot`，用「龙虾火爆」场景做端到端验证
- 验收：见 §11

---

## 11. 验收标准（端到端样例）

### 11.1 样例场景：龙虾火爆 → 闲鱼挂攻略

**前提**：抖音热搜、微博热搜、知乎热榜同时出现龙虾相关热点（抖音：「龙虾火爆全网」热度 900 万、微博：「小龙虾为什么这么火」热度 4 万、知乎：「如何评价近期小龙虾火爆？」热度 5000 万）

**端到端流程**：

1. **采集 + 跨源去重**：`/api/cron/collect-hotspot` 调 5 个适配器，抖音/微博/知乎都抓到龙虾相关条目。跨源去重模块判定三条为同一趋势（2-gram Jaccard ≥ 0.5），保留热度百分位最高的知乎条目，content 拼入 `[多源: 抖音,微博,知乎]`。`findDuplicate` 未命中，入库：
   - `items.title = "如何评价近期小龙虾火爆？"`
   - `items.sourceType = "source:zhihu-hot"`（热度百分位最高的来源）
   - `items.aiStage = "pending"`
   - `items.content` 含 `[多源: 抖音,微博,知乎]` 标记

2. **预筛**：批量预筛 LLM 调用，判断：
   - relevance = "high"（主人有内容生产/文案/AI 生图技能，能产出龙虾相关内容）
   - monetizability = "high"（可做攻略合集，信息差产品，闲鱼有同类市场）
   - time_window = "3-5天"（热度正盛，三源同时上榜说明刚爆发）
   - pass = true
   - `items.aiStage = "l1_done"`，`items.l1 = {"pass":true,"relevance":"high",...}`

3. **L3 分析**：逐条调用 L3，产出：
   - `what_to_sell.deliverable = "龙虾挑选避坑攻略 PDF + 3 步清洗实操图文"`
   - `where_to_sell.primary = "闲鱼"`
   - `pricing_anchor.suggested_price = "¥9.9"`（参考同类攻略合集 ¥9.9-19.9）
   - `time_window.days_left = 4`
   - `competition_heat.level = "少量"`（已有人在卖但内容粗糙，可差异化）
   - `scores`：热度证据 88（三源命中，多源验证加分）、启动成本 85、变现路径清晰度 78、时效性 80
   - `computeHotspotScore` = round(88×0.3 + 85×0.25 + 78×0.3 + 80×0.15) = round(26.4+21.25+23.4+12) = 83
   - `first_step.copyable_listing_copy = "【龙虾季必看】刚从市场回来，整理了挑选+清洗+烹饪全套避坑攻略..."`（完整可粘贴上架文案）
   - `verdict = "做（总分 83）：三源同时上榜热度高，与你内容生产能力匹配，今晚挂闲鱼试水"`

4. **分档**：
   - score = 83 ≥ 65 ✅
   - days_left = 4 → **不满足** ≤ 3 天条件 ❌
   - → tier = "week"（而非 today）

   *如果 days_left = 2*：
   - score = 83 ≥ 65 ✅
   - days_left = 2 ≤ 3 ✅
   - 启动成本 = 85 ≥ 70 ✅
   - → tier = "today"

5. **呈现**：
   - 首页「🟡 本周看」出现该条，type 徽章显示「热点衍生」，来源徽章显示「知乎热榜」
   - 点击进入详情页：不显示三证/时薪/魔鬼代言人，显示四维评分（热度证据 88/启动成本 85/变现路径清晰度 78/时效性 80），第一步区显示上架文案 + 复制按钮

### 11.2 验收检查清单

- [ ] `curl -H 'x-cron-secret: ...' http://localhost:3000/api/cron/collect-hotspot` 返回 200
- [ ] 返回 JSON 含 `found` / `inserted` / `deduped` / `preFilterPass` / `l3Done` 字段
- [ ] `items` 表有 `sourceType` 为 `source:douyin-hot` / `source:weibo-hot` / `source:zhihu-hot` / `source:baidu-hot` / `source:toutiao-hot` 的条目
- [ ] 同一热点多源命中时只入库 1 条（跨源去重生效），content 含 `[多源:...]` 标记
- [ ] 60s API 某端点挂了时该源返回空数组，不阻塞其他源
- [ ] 预筛拒绝的条目 `aiStage = "archived"`，`l1` 字段有 reason
- [ ] 预筛通过的条目 `aiStage = "ready"`（L3 完成后）
- [ ] `opportunities` 表有 `type = "热点衍生"` 的行
- [ ] 首页 today/week 列表能出现热点机会（取决于分档）
- [ ] 首页卡片显示来源徽章（「抖音热搜」/「微博热搜」/「知乎热榜」等）+ 「热点衍生」type 徽章
- [ ] 详情页不显示三证/时薪/魔鬼代言人
- [ ] 详情页四维评分维度正确（热度证据/启动成本/变现路径清晰度/时效性）
- [ ] 详情页第一步区有「上架文案」+ 复制按钮
- [ ] 再次运行 cron（无新热点）时，`inserted = 0`（去重生效）
- [ ] 热点条目不出现在现有 L1→L2 流水线中（sourceType 路由隔离）

---

## 12. 改动量估算

| 类别 | 文件 | 操作 | 预计行数 |
| --- | --- | --- | --- |
| 新建 | `lib/sources/douyin-hot.ts` | 新建 | ~60 行（JSON API + UA/Referer） |
| 新建 | `lib/sources/weibo-hot.ts` | 新建 | ~40 行（60s API JSON） |
| 新建 | `lib/sources/toutiao-hot.ts` | 新建 | ~40 行（同 60s API，与 weibo 同构） |
| 新建 | `lib/sources/zhihu-hot.ts` | 新建 | ~50 行 |
| 新建 | `lib/sources/baidu-hot.ts` | 新建 | ~80 行（HTML 解析较长） |
| 新建 | `lib/hotspot-dedup.ts` | 新建 | ~100 行（2-gram Jaccard + 热度百分位归一化） |
| 新建 | `lib/ai/hotspot.ts` | 新建 | ~200 行（预筛 + L3 + 评分，参考 l1.ts+l2.ts） |
| 新建 | `lib/hotspot-pipeline.ts` | 新建 | ~120 行（参考 pipeline.ts 的 processBatch） |
| 新建 | `app/api/cron/collect-hotspot/route.ts` | 新建 | ~120 行（5 适配器 + 跨源去重 + 入库 + 流水线，参考 collect/route.ts） |
| 改 | `lib/sources/index.ts` | 加 5 行注册 | ~5 行 |
| 改 | `lib/source-label.ts` | 加 5 行映射 | ~5 行 |
| 改 | `app/opportunities/[id]/page.tsx` | 条件渲染 | ~40 行 |
| **总计** | | | **~860 行** |

零 schema 变更。零新页面。零新 API 路由（除 cron 端点）。现有 L1→L2 流水线零改动。
