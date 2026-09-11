import { z } from "zod";
import { callGateway, extractJson, MODEL_FAST } from "./gateway";

export const CATEGORIES = [
  "接单", "招聘JD", "信息差", "价格差", "效率差", "资源差", "产品空白", "其他",
] as const;

const L1Schema = z.object({
  results: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      category: z.enum(CATEGORIES),
      is_noise: z.boolean(),
      has_budget: z.boolean().nullable(),
      budget_amount: z.string().nullable(),
      required_skills: z.array(
        z.object({ skill: z.string(), importance: z.number() })
      ),
      reason: z.string(),
      // 命中软降权词表时为 true；模型未返回时默认 false
      downweight: z.boolean().default(false),
      // 风险标记，如「纯剪辑计件」「TG匿名」「要求免费试稿」；模型未返回时默认空数组
      risk_flags: z.array(z.string()).default([]),
    })
  ),
});

export type L1Result = z.infer<typeof L1Schema>["results"][number];

/** 服务器本地时区的今天日期，格式 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 构建 L1 系统提示词。注入当前日期以消灭「本周/本月」类日期幻觉。
 * 替代旧版 export const L1_SYSTEM（无外部引用，安全替换）。
 */
export function buildL1System(now: string): string {
  return `你是信息过滤器。把输入信息分类，判断是否值得主人为之行动。

【今天日期】${now}（时区 Asia/Shanghai）
所有「本周/本月/最近」的判断以此为准；原文中的日期晚于今天才可称为未来日期，早于今天的日期一律视为正常历史信息，不得写「数据异常/疑似未来数据」。

主人的技能画像（只对这些领域敏感）：
- 前端：Vue/React/TypeScript/Next.js/uniapp 小程序
- 后端：Java/Spring、Node.js、Python/FastAPI
- AI：LLM 应用、Agent、RAG、工作流、文档解析、多模态
- 运维：Docker/K8s/Linux
- 内容生产：AI 剪辑/生图/生视频/配音/文案
- 爬虫与自动化

严格规则：
1. has_budget 只有同时满足三条才为 true：①原文出现明确金额数字；②该金额是某个买方为「主人可提供的服务/产品/源码」支付的；③不是平台内部测试金额、不是对第三方平台的假设性付费意愿（如「if I pay $9/mo」）、不是他人之间的成交价。只满足①时 has_budget=false，并在 reason 里注明「有金额但非可收款预算」。budget_amount 必须原样摘录含单位与结算方式的最短片段。
2. is_noise=true 的情况（命中任一即 true）：纯招聘坐班 JD；广告/纯闲聊/防骗提醒；需要线下到场且无法远程；发帖人本人在推销自己的服务/产品（出现「我能提供/我们提供/可接单/自荐/免费试用/定价方案」，除非帖子同时在招人或发包）；以及与主人技能领域相关、但不存在需求方、付款方或可利用价差的公开信息——包括开源仓库/榜单元数据（如 GitHub「名字 ★星数 语言 创建日期」类）、教程与课程、行业新闻与观点文、Show HN 类个人项目发布、社区规则帖。判断口径：若这条信息无法回答「谁会在什么条件下付钱给我」，就是噪声。
3. required_skills：只抽主人可能具备的可匹配技能名词（语言/框架/中间件/工具/领域能力，如 llm、redis、uniapp、视频剪辑），importance 1-5（5=没这个就做不了）。禁止抽取对交付物的描述（如「私有项目源码」「多租户SaaS架构」「真实业务场景项目」）或需求方单方面的条件。
4. reason：一句话，必须引用原文关键词作为依据，不许空泛。
5. 降权词表（命中时 is_noise=false 但 downweight=true，并把命中的具体词写进 risk_flags，如「纯剪辑计件」「数据标注」「PPT代做」「模板小程序」「套壳」）：纯数据标注、PPT/文档代做、无创意门槛的纯剪辑计件、模板化小程序、套壳聊天机器人。硬噪声词表（命中直接 is_noise=true）：刷单/水军、传销/拉人头、需要垫资的、赌/灰产。「要求免费试稿/试剪」可在 risk_flags 里标注但不算噪声。
6. 若某条输入带【来源备注】且注明正文为截断摘要：未出现金额≠没有预算，不得仅因缺金额判噪或降权，relevant 线索以标题和已有片段为准。

只输出一个 JSON 对象，格式：
{"results":[{"id":1,"category":"接单|招聘JD|信息差|价格差|效率差|资源差|产品空白|其他","is_noise":false,"has_budget":null,"budget_amount":null,"required_skills":[{"skill":"xxx","importance":3}],"reason":"依据原文的一句话","downweight":false,"risk_flags":[]}]}
不要输出任何 JSON 以外的文字。`;
}

export async function runL1(
  inputs: { id: number; title: string; content: string; sourceNote?: string }[],
  profileLine?: string
): Promise<L1Result[]> {
  const now = todayStr();
  const system = buildL1System(now);
  const body = inputs
    .map((x) => {
      const sourceNote = x.sourceNote ? `\n【来源备注】${x.sourceNote}` : "";
      return `【信息${x.id}】标题：${x.title}\n内容：${x.content.slice(0, 4000)}${sourceNote}`;
    })
    .join("\n\n");
  const profileBlock = profileLine
    ? `\n\n【当前生效技能画像（技能键名）】${profileLine}`
    : "";
  // 思考型模型：thinking 计入 max_tokens，批内条数越多 thinking 越长，
  // 固定 6000 会在 thinking 阶段被吃光导致 text 块截断（输出 usage=output=max 即此症）。
  // 单条保持 6000（实测够用），每多一条 +1500（+1000 实测余量太薄：n=6 时 output 顶到
  // 10999/11000 截断），上限 16000。
  const maxTokens = Math.min(6000 + 1500 * (inputs.length - 1), 16000);
  const { text, usage } = await callGateway(
    `${system}${profileBlock}\n\n${body}`,
    {
      maxTokens,
      model: MODEL_FAST,
    }
  );
  console.log("[l1] usage", usage, "maxTokens", maxTokens);

  let parsed = L1Schema.safeParse(extractJson(text));
  if (!parsed.success) {
    // 一次修正重试
    const retry = await callGateway(
      `${system}${profileBlock}\n\n${body}\n\n你上次的输出无法解析：${parsed.error.message.slice(0, 300)}。请重新只输出合法 JSON。`,
      { maxTokens, model: MODEL_FAST }
    );
    parsed = L1Schema.safeParse(extractJson(retry.text));
    if (!parsed.success) throw new Error(`L1 输出校验失败: ${parsed.error.message.slice(0, 200)}`);
  }
  // 保证顺序与入参一致；模型未返回的条目按噪声兜底
  const byId = new Map(parsed.data.results.map((r) => [String(r.id), r]));
  return inputs.map(
    (x) =>
      byId.get(String(x.id)) ?? {
        id: x.id, category: "其他" as const, is_noise: true,
        has_budget: null, budget_amount: null, required_skills: [],
        reason: "模型未返回该条结果，按噪声处理",
        downweight: false, risk_flags: [],
      }
  );
}
