import { z } from "zod";
import { callGateway, extractJson, MODEL_FAST, MODEL_THINK } from "./gateway";

// ============================================================================
// 预筛 Schema（批量 LLM 调用）—— 设计稿 §2.1
// ============================================================================

const HotspotPreFilterSchema = z.object({
  results: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      pass: z.boolean(),
      relevance: z.enum(["high", "medium", "low"]),
      monetizability: z.enum(["high", "medium", "low"]),
      time_window: z.enum(["3-5天", "1-2天", "已过峰", "常青"]),
      reason: z.string(),
    })
  ),
});

export type HotspotPreFilterResult = z.infer<
  typeof HotspotPreFilterSchema
>["results"][number];

/** 服务器本地时区的今天日期，格式 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 构建预筛 system prompt。注入：
 * - 当前日期（消灭「本周/本月」类日期幻觉）
 * - 主人技能画像
 * - 最近 24h 已分析标题列表（语义层去重兜底）
 */
export function buildPreFilterSystem(
  now: string,
  recentTitles: string[],
  profileLine?: string
): string {
  const recentBlock =
    recentTitles.length > 0
      ? `\n\n【最近 24h 已通过预筛的热点标题】（与下列任一为同一趋势的，pass=false 并在 reason 注明「与已分析标题『XXX』重复」）：\n${recentTitles
        .map((t, i) => `${i + 1}. ${t}`)
        .join("\n")}`
      : "";

  const profileBlock = profileLine
    ? `\n\n【主人技能画像】${profileLine}`
    : "";

  return `你是趋势机会预筛器。判断每条热榜条目是否值得做深度变现分析。

【今天日期】${now}（时区 Asia/Shanghai）
所有「本周/本月/最近」的判断以此为准。

主人的技能画像（只对这些领域敏感）：
- 前端：Vue/React/TypeScript/Next.js/uniapp 小程序
- 后端：Java/Spring、Node.js、Python/FastAPI
- AI：LLM 应用、Agent、RAG、工作流、文档解析、多模态
- 内容生产：AI 剪辑/生图/生视频/配音/文案
- 爬虫与自动化
${profileBlock}${recentBlock}

预筛判断口径：
1. relevance（相关度）：热榜条目是否在主人技能的辐射范围内？主人能生产什么跟风产品？
   - high：直接命中主人技能（如 AI 工具火爆→主人能做 AI 教程）
   - medium：间接相关（如某明星火爆→主人能做周边内容/自动化工具）
   - low：完全不相关（如纯政治新闻、体育赛事无变现路径）
2. monetizability（可变现性）：这个热度能催生什么可出售的东西？
   - high：能做信息差产品（攻略/教程/合集）、服务（代做/咨询）、内容（视频/图文），且有人会付费
   - medium：能做但路径模糊，或付费意愿不确定
   - low：想不出能卖什么，或纯娱乐无付费意愿
3. time_window（时效窗）：热度还有多久？
   - 3-5天：热度正盛且持续
   - 1-2天：窗口短但够今晚行动
   - 已过峰：热度在退，拒绝
   - 常青：不依赖时效，长期有效

pass 条件：relevance ≥ medium AND monetizability ≥ medium AND time_window ≠ "已过峰"。
预筛必须严格：目标通过率 3-5%。宁可漏过也不放过——每放一条进 L3 就多一次推理档调用。

reason 一句话，必须引用热榜标题关键词作为依据。

只输出一个 JSON 对象：
{"results":[{"id":1,"pass":true,"relevance":"high","monetizability":"high","time_window":"3-5天","reason":"..."}]}
不要输出任何 JSON 以外的文字。`;
}

/**
 * 批量预筛。
 *
 * max_tokens 公式：min(6000 + 1000×(n-1), 16000)
 * 思考型模型 thinking 计入 max_tokens，批内条数越多 thinking 越长，
 * 固定值会被 thinking 吃光导致 text 块截断（踩过的坑）。
 *
 * 批量分块：一批 >30 条时切成 ≤30 条的块逐块调用，
 * 每块独立 max_tokens = min(6000+1000×(n-1), 16000)。
 */
export async function runHotspotPreFilter(
  inputs: { id: number; title: string; content: string }[],
  recentTitles: string[] = [],
  profileLine?: string
): Promise<HotspotPreFilterResult[]> {
  if (inputs.length === 0) return [];

  const now = todayStr();
  const system = buildPreFilterSystem(now, recentTitles, profileLine);

  // 分块：每块 ≤30 条
  const CHUNK = 30;
  const chunks: typeof inputs[] = [];
  for (let i = 0; i < inputs.length; i += CHUNK) {
    chunks.push(inputs.slice(i, i + CHUNK));
  }

  const allResults: HotspotPreFilterResult[] = [];

  for (const chunk of chunks) {
    const body = chunk
      .map(
        (x) =>
          `【热点${x.id}】标题：${x.title}\n内容：${x.content.slice(0, 600)}`
      )
      .join("\n\n");

    const maxTokens = Math.min(6000 + 1000 * (chunk.length - 1), 16000);
    const { text, usage } = await callGateway(`${system}\n\n${body}`, {
      maxTokens,
      model: MODEL_FAST,
    });
    console.log(
      `[hotspot-prefilter] chunk ${chunks.indexOf(chunk) + 1}/${chunks.length}`,
      "usage", usage, "maxTokens", maxTokens
    );

    let parsed = HotspotPreFilterSchema.safeParse(extractJson(text));
    if (!parsed.success) {
      // 一次修正重试
      const retry = await callGateway(
        `${system}\n\n${body}\n\n你上次的输出无法解析：${parsed.error.message.slice(0, 300)}。请重新只输出合法 JSON。`,
        { maxTokens, model: MODEL_FAST }
      );
      parsed = HotspotPreFilterSchema.safeParse(extractJson(retry.text));
      if (!parsed.success) {
        throw new Error(`预筛输出校验失败: ${parsed.error.message.slice(0, 200)}`);
      }
    }

    // 保证顺序与入参一致；模型未返回的条目按不通过兜底
    const byId = new Map(parsed.data.results.map((r) => [String(r.id), r]));
    for (const x of chunk) {
      allResults.push(
        byId.get(String(x.id)) ?? {
          id: x.id,
          pass: false,
          relevance: "low" as const,
          monetizability: "low" as const,
          time_window: "已过峰" as const,
          reason: "模型未返回该条结果，按不通过处理",
        }
      );
    }
  }

  return allResults;
}

// ============================================================================
// L3 变现假设 Schema（单条深度分析）—— 设计稿 §2.2
// ============================================================================

const ScoreItem = z.object({
  score: z.union([z.number(), z.null()]),
  reason: z.string(),
});

const HotspotL3Schema = z.object({
  trend_summary: z.string(),
  what_to_sell: z.object({
    deliverable: z.string(),
    format: z.enum([
      "pdf", "video", "image_set", "code_template", "service", "consulting",
    ]),
    why_this: z.string(),
  }),
  where_to_sell: z.object({
    primary: z.string(),
    why: z.string(),
  }),
  pricing_anchor: z.object({
    reference: z.string(),
    suggested_price: z.string(),
    basis: z.string(),
  }),
  time_window: z.object({
    days_left: z.number(),
    peak_prediction: z.string(),
    basis: z.string(),
  }),
  competition_heat: z.object({
    already_selling: z.boolean(),
    level: z.enum(["无竞争", "少量", "已饱和"]),
    differentiation: z.string(),
  }),
  scores: z.object({
    热度证据: ScoreItem,
    变现路径清晰度: ScoreItem,
    启动成本: ScoreItem,
    时效性: ScoreItem,
  }),
  first_step: z.object({
    time_box: z.string(),
    action: z.string(),
    object: z.string(),
    channel: z.string(),
    quantity: z.string(),
    completion_rule: z.string(),
    copyable_listing_copy: z.string(),
  }),
  verdict: z.string(),
});

export type HotspotL3Result = z.infer<typeof HotspotL3Schema>;

/**
 * 构建 L3 prompt。注入热榜原文 + 预筛结论 + 主人技能画像。
 */
export function buildL3Prompt(input: {
  title: string;
  content: string;
  preFilter: HotspotPreFilterResult;
  profileLine?: string;
}): string {
  const now = todayStr();
  const pf = input.preFilter;
  const profileBlock = input.profileLine
    ? `\n【主人技能画像】${input.profileLine}`
    : "";

  return `你是商业化机会分析师，服务对象是一位想用业余时间赶热度变现的开发者。下面是一条热榜条目和它的预筛结论，请做深度变现假设分析。

【今天日期】${now}（时区 Asia/Shanghai）

【标题】${input.title}
【内容】${input.content.slice(0, 4000)}
【预筛结论】相关度=${pf.relevance}；可变现性=${pf.monetizability}；时效窗=${pf.time_window}；预筛理由=${pf.reason}
${profileBlock}

分析纪律：
1. what_to_sell：具体到可上架的交付物名称（如「龙虾挑选避坑攻略 PDF + 3 段实操短视频」）。format 选最贴近的交付形态。why_this 必须基于主人技能 + 热度性质说明为什么是这个交付物。
2. where_to_sell：选最匹配的渠道。闲鱼适合信息差产品/攻略合集；小红书适合图文/种草；抖音/视频号适合短视频；公众号适合长文。说明流量匹配度/上架门槛/变现路径。
3. pricing_anchor：参考同类行情给出具体定价数字。basis 说明参考了什么。
4. time_window.days_left：剩余热度天数（数字）。peak_prediction 预计何时到峰/已过峰。basis 说明判断依据。
5. competition_heat：already_selling 是否已有人在卖同类。level 选「无竞争/少量/已饱和」。differentiation 基于主人技能优势说明如何差异化。
6. 四维打分（每维 0-100）：
   - 热度证据（权重 30%）：跨源命中的多源保留条 = 80~95；单源高热 = 60~75；单源低热或已过峰 = 30~50。引用具体热度数字/排名。
   - 变现路径清晰度（权重 30%）：交付物明确+渠道明确+定价有据 = 80~95；交付物或渠道模糊 = 50~70；想不出卖什么 = 20~40。最重要的维度。
   - 启动成本（权重 25%）：今晚 30 分钟能产出可上架交付物 = 80~95；需 1-2 天 = 60~75；需一周以上或需采购物料 = 30~50。衡量「多快能上架」。
   - 时效性（权重 15%）：热度还有 3-5 天 = 80~95；1-2 天 = 60~75；已过峰 = 20~40。
   reason 分两段：「①档位依据 ②置信度」。
7. first_step：今晚 30 分钟可完成的具体动作。copyable_listing_copy 是可直接复制粘贴的上架文案（标题+描述+定价+标签，完整可发布）。
8. verdict 规则：总分 ≥60 →「做」；40-59 →「谨慎做」；<40 →「不做」。开头必须回填总分，格式如「做（总分 78）：...」。

只输出一个 JSON 对象：
{"trend_summary":"...","what_to_sell":{"deliverable":"...","format":"pdf","why_this":"..."},"where_to_sell":{"primary":"闲鱼","why":"..."},"pricing_anchor":{"reference":"...","suggested_price":"¥9.9","basis":"..."},"time_window":{"days_left":3,"peak_prediction":"...","basis":"..."},"competition_heat":{"already_selling":true,"level":"少量","differentiation":"..."},"scores":{"热度证据":{"score":0,"reason":"..."},"变现路径清晰度":{"score":0,"reason":"..."},"启动成本":{"score":0,"reason":"..."},"时效性":{"score":0,"reason":"..."}},"first_step":{"time_box":"今晚 30 分钟","action":"...","object":"...","channel":"闲鱼","quantity":"挂 1 个","completion_rule":"上架发布即完成","copyable_listing_copy":"..."},"verdict":"做（总分 78）：..."}
不要输出任何 JSON 以外的文字。`;
}

/**
 * L3 变现假设分析（单条）。
 *
 * MODEL_THINK，max_tokens = 12000（固定，与 L2 对齐）。
 * 解析 + 一次修正重试。
 */
export async function runHotspotL3(input: {
  title: string;
  content: string;
  preFilter: HotspotPreFilterResult;
  profileLine?: string;
}): Promise<{ result: HotspotL3Result; usage: { input: number; output: number } }> {
  const prompt = buildL3Prompt(input);
  let { text, usage } = await callGateway(prompt, {
    maxTokens: 12000,
    model: MODEL_THINK,
  });
  console.log("[hotspot-l3] usage", usage);

  let parsed = HotspotL3Schema.safeParse(extractJson(text));
  if (!parsed.success) {
    const retry = await callGateway(
      `${prompt}\n\n你上次的输出无法解析：${parsed.error.message.slice(0, 300)}。请重新只输出合法 JSON，不要省略任何字段。`,
      { maxTokens: 12000, model: MODEL_THINK }
    );
    usage = retry.usage;
    parsed = HotspotL3Schema.safeParse(extractJson(retry.text));
    if (!parsed.success) {
      throw new Error(`L3 输出校验失败: ${parsed.error.message.slice(0, 200)}`);
    }
  }
  return { result: parsed.data, usage };
}

// ============================================================================
// 四维评分计算 —— 设计稿 §3.3
// ============================================================================

export type HotspotScores = HotspotL3Result["scores"];

/**
 * 四维加权总分：热度证据×30 + 启动成本×25 + 变现路径清晰度×30 + 时效性×15
 * 权重总和 100，结果 0-100 分制，取整。
 */
export function computeHotspotScore(s: HotspotScores): number {
  const v = (x: { score: number | null }) =>
    typeof x.score === "number" ? x.score : 0;
  return Math.round(
    (v(s["热度证据"]) * 30 +
      v(s["启动成本"]) * 25 +
      v(s["变现路径清晰度"]) * 30 +
      v(s["时效性"]) * 15) /
      100
  );
}
