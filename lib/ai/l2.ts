import { z } from "zod";
import { callGateway, extractJson, MODEL_THINK } from "./gateway";
import type { L1Result } from "./l1";

const nullableNum = z.union([z.number(), z.null()]).nullable();
const nullableStr = z.union([z.string(), z.null()]).nullable();

const ScoreItem = z.object({
  score: z.union([z.number(), z.null()]),
  reason: z.string(),
});

const L2Schema = z.object({
  evidence_trilogy: z.object({
    资金证据: z.object({ 依据: nullableStr, 结论: z.string() }),
    身份证据: z.object({ 依据: nullableStr, 结论: z.string() }),
    时间证据: z.object({ 依据: nullableStr, 结论: z.string() }),
    总体结论: z.string(),
  }),
  scores: z.object({
    需求真实性: ScoreItem,
    行动可行性: ScoreItem,
    独特性: ScoreItem,
    时效性: ScoreItem,
  }),
  devil_advocate: z.union([z.array(z.string()), z.string()]),
  hourly_check: z.object({
    预估单价: nullableStr,
    预估工时: nullableStr,
    反算时薪: nullableStr,
    底线时薪: z.union([z.number(), z.string(), z.null()]),
    说明: z.string(),
  }),
  verdict: z.string(),
  first_step: z.object({
    time_box: z.string(),
    action: z.string(),
    object: z.string(),
    channel: z.string(),
    quantity: z.string(),
    completion_rule: z.string(),
    copyable_first_message: z.string(),
  }),
});

export type L2Result = z.infer<typeof L2Schema>;

/** 服务器本地时区的今天日期，格式 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 按机会 type 召回的参考打法。从 docs/research/05-playbook.md 提炼，
 * 每类 2-4 行，保留 P 编号。注入时标注「参考打法，与原文冲突时以原文为准」。
 * 无匹配的 category（招聘JD/其他）不注入。
 */
const PLAYBOOK: Record<string, string> = {
  接单: [
    "P01 AI 知识库/企业问答：求快用 Dify；要权限·私有化·扫描件解析用 RAGFlow 或自建；数据清洗占 40-60% 工时须单列报价。",
    "P05 本地商家 AI 内容月费：素材+批量剪辑+配音+字幕做流水线，一人 5-10 家，¥2k-8k/月，只承诺条数不承诺线索量。",
    "P06 AI 视频批量生产：生图+抠图+图生视频+ffmpeg 拼接，建模板换产品即出新片，须有实拍料避免限流。",
    "视角：区分单条计件（¥50-300/条，被 AI 压价）vs 可打包成流水线/月费（月费模式更抗跌，优先接）。",
  ].join("\n"),
  信息差: [
    "P07 海外工具汉化与合规代办：汉化 UI+中文文档+国内支付/登录改造；只做合规落地，不碰账号代充/换汇/翻墙。",
    "P08 开源项目二开与落地：Docker 一键部署包+中文文档+定制模块；二开走插件不改核心，遵守原项目协议（AGPL 商用谨慎）。",
    "P09 垂直行业 AI 助手：复用知识库底座，价值在行业知识与流程；先做单场景不贪大，数据合规是生死线。",
  ].join("\n"),
  价格差: [
    "P10 海外 API 套利封装：同一能力海内外价差→封装中文 API 网关+计费+文档+微信支付，面向国内开发者。",
    "坑：价格战吞利润须绑增值层；转售条款先读清。报价：订阅 ¥99-999/月或按量抽成；私有化 ¥2-10万。",
  ].join("\n"),
  资源差: [
    "P11 文档解析与数据治理：PDF/OCR/版面分析+LLM 清洗，输出干净 chunk 与元数据；是知识库项目的上游。",
    "坑：OCR 准确率须写进验收；数据脱敏与不出境是前提。报价：¥0.1-1/页（批量）；项目制 ¥5k-5万。",
  ].join("\n"),
  效率差: [
    "P12 企业 AI 内训与提效咨询：把 AI 工作流拆成课件+实操沙盘；交付岗位级 SOP+内部工具原型。只讲概念必被差评，须带可跑 Demo。",
    "P15 停服/涨价接盘与迁移：SaaS 停服/API 涨价/免费额度取消→迁移工具+平移方案+导出脚本；公告后 2-4 周是黄金窗，先出数据地图再承诺工期。",
  ].join("\n"),
  产品空白: [
    "P13 模板/脚手架资产化：同类需求 repeat≥3 时把重复交付沉淀为模板资产（客服/知识库/采集/内容），先卖部署版再卖 SaaS。",
    "坑：别在有稳定接单时过早产品化；先验证同一模板卖 3 次再投入。报价：模板源码 ¥1k-1万/份；托管订阅 ¥199-1,999/月。",
  ].join("\n"),
};

export function buildL2Prompt(input: {
  title: string;
  content: string;
  l1: L1Result;
}): string {
  const now = todayStr();
  const playbookEntry = PLAYBOOK[input.l1.category];
  const playbookBlock = playbookEntry
    ? `\n\n【参考打法（与原文冲突时以原文为准）】\n${playbookEntry}`
    : "";
  return `你是商业化机会分析师，服务对象是一位想用业余时间接单/做产品的开发者。下面是一条原始信息和对它的初步分类，请做深度行动分析。

【今天日期】${now}（时区 Asia/Shanghai）
所有「本周/本月/最近」的判断以此为准；原文中的日期晚于今天才可称为未来日期，早于今天的日期一律视为正常历史信息，不得写「数据异常/疑似未来数据」。

【标题】${input.title}
【内容】${input.content.slice(0, 4000)}
【初步分类】${input.l1.category}；预算线索：${input.l1.has_budget ? input.l1.budget_amount || "有" : "未提及"}${playbookBlock}

分析纪律：
1. 三证（资金/身份/时间）：每证都要引用原文原句作依据；原文没有就写 null 并明确说"原文未提供"，禁止脑补。
2. 四维打分：每维 **0-100 分**。判据是「若原文所述为真，这个机会对主人值多少」，不是「原文证明了多少」。原文没写 ≠ 需求不存在：缺证据只降低你的置信度，不直接压低该维得分；reason 分两段写：「①档位依据 ②置信度/待验证项」。先判断命中哪一档，再在档内微调（±5），禁止不判档位直接给 10~30 分。
   - 需求真实性：需求方+预算+时间窗=85~95；需求方+预算、无时间窗=65~80；有明确需求方、无预算=45~60；仅转述/猜测=20~40；TG/匿名中介且无凭证=25~35（有合同/担保/历史成交凭证可上浮到 50）
   - 行动可行性：业余可做+远程+交付边界清晰=75~90；远程但边界模糊=50~70；需驻场、需垫资、或合规审批≥3 个月=25~45
   - 独特性（口径按 category 切换，唯一随类型变口径的维度）：
     · 接单类：不问「多少人能看到这条帖」，只问议价权/可替代性——需求方只能找你、或有一句话说清的差异化交付=70~90；来者不拒的公开招人=40~60；平台竞价、价低者得=20~35。公开可见本身不扣分。
     · 产品空白/信息差/价格差/效率差/资源差类：按「别人也知道吗」判——独家渠道/私有信息=75~90；公开但可差异化=50~70；人人可 fork 的公开仓库=15~35
     · 判断对象永远是「这个信息给主人的优势」，不是「发帖人本人有多特别」；发帖人资历只能写进身份证据，不得作为独特性加分理由。
   - 时效性：本周内要人/热点窗口=80~95；deadline 在未来 30 天内=65~80；长期有效但不急的常青需求=60~75（常青不等于过期，不许因为「不是本周」就压到 40 以下）；已过期/已关闭=0~25
   每个分数必须引用原文原句作依据。校准自检：若四维都落在 20~35，问自己「这条和一条真正的垃圾（纯广告）差在哪」，说不出差异就必须上调其中至少一维；若四维全部 <40，verdict 只允许「不做」。
3. devil_advocate：站在反方挑刺 3-5 条，专挑会让主人白干一场的坑（验收风险/账期/需求蔓延/竞品/合规等）。每条必须标注【可在第一步内验证】或【无法验证】。
4. hourly_check：估算单价与工时，反算时薪；底线时薪按 80 元/小时。
5. first_step：必须是"今天下班后 2 小时内可完成"的具体动作，产出物明确、有完成判据（completion_rule）。copyable_first_message 是可直接复制发送的开口话术。
6. 严格红线：主人不做任何免费试稿/试剪。如果机会方要求试稿，话术里必须写明"可以付费试做小样"或直接拒绝免费试稿。
7. verdict 必须按下列规则产出，禁止自由发挥：
   - 总分 ≥60 且红队没有任何一条标【无法验证】→「做」
   - 总分 40~59，或红队存在【无法验证】但核心风险可用付费小样/合同/身份核验规避 →「谨慎做：+ 前置条件」
   - 总分 <40 →「不做」
   - 四维全部 <40 → 只能「不做」
   verdict 开头必须回填总分，格式如「谨慎做（总分 52）：…」

只输出一个 JSON 对象（字段名用中文，如示例），格式：
{"evidence_trilogy":{"资金证据":{"依据":null,"结论":"..."},"身份证据":{"依据":null,"结论":"..."},"时间证据":{"依据":null,"结论":"..."},"总体结论":"..."},"scores":{"需求真实性":{"score":0,"reason":"①档位依据 ②置信度/待验证项"},"行动可行性":{"score":0,"reason":"..."},"独特性":{"score":0,"reason":"..."},"时效性":{"score":0,"reason":"..."}},"devil_advocate":["...【可在第一步内验证】","...【无法验证】"],"hourly_check":{"预估单价":"...","预估工时":"...","反算时薪":"...","底线时薪":80,"说明":"..."},"verdict":"谨慎做（总分 52）：...","first_step":{"time_box":"今晚 30 分钟","action":"...","object":"...","channel":"...","quantity":"...","completion_rule":"...","copyable_first_message":"..."}}
不要输出任何 JSON 以外的文字。`;
}

export async function runL2(input: {
  title: string;
  content: string;
  l1: L1Result;
}): Promise<{ result: L2Result; usage: { input: number; output: number } }> {
  const prompt = buildL2Prompt(input);
  let { text, usage } = await callGateway(prompt, {
    maxTokens: 12000,
    model: MODEL_THINK,
  });
  console.log("[l2] usage", usage);

  let parsed = L2Schema.safeParse(extractJson(text));
  if (!parsed.success) {
    const retry = await callGateway(
      `${prompt}\n\n你上次的输出无法解析：${parsed.error.message.slice(0, 300)}。请重新只输出合法 JSON，不要省略任何字段。`,
      { maxTokens: 12000, model: MODEL_THINK }
    );
    usage = retry.usage;
    parsed = L2Schema.safeParse(extractJson(retry.text));
    if (!parsed.success) throw new Error(`L2 输出校验失败: ${parsed.error.message.slice(0, 200)}`);
  }
  return { result: parsed.data, usage };
}

export function computeTotalScore(s: L2Result["scores"]): number {
  const v = (x: { score: number | null }) => (typeof x.score === "number" ? x.score : 0);
  return Math.round(
    (v(s.需求真实性) * 40 + v(s.行动可行性) * 30 + v(s.独特性) * 15 + v(s.时效性) * 15) / 100
  );
}
