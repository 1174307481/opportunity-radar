import {
  BROWSER_UA,
  asRecord,
  briefError,
  configNumber,
  configStringArray,
  timeoutSignal,
  type RawSignal,
  type SourceAdapter,
  type SourceConfig,
} from "./types";

const API = "https://hn.algolia.com/api/v1/search_by_date";
const MAX_TOTAL = 25;

/**
 * 默认查询词：覆盖「有人在找开发者做事」的需求信号面。
 *
 * 设计取舍（2026-09 诊断后定稿）：
 * - 不用 advancedSyntax + 引号短语：实测 7 天 ask_hn 精确短语命中 0 条，
 *   短语太长在低流量板块里根本搜不到。
 * - 不用 restrictSearchableAttributes=title：Ask HN 的问题写在正文
 *   （story_text），标题只有 "Ask HN: ..." 几个字，限标题搜会把真需求搜没。
 * - tags=story,ask_hn（逗号=OR）：Ask HN 面太窄（7 天仅 ~96 帖），
 *   加入 story（Show HN / Launch HN）补量——不少 Show HN 是「找开发者合作」。
 * - 14 天窗口 + points>1：7 天太短，points>3 挡掉了大量真实 Ask HN 小众需求
 *   （很多真问题只有 1-3 分）。
 * - 宽松词（Algolia 默认 AND 各词）：宁可多捞让 L1 路由判噪，也不漏。
 */
const DEFAULT_QUERIES = [
  "looking for developer", // 直接招聘信号
  "hire developer", // 直接招聘
  "need developer", // 需求信号
  "would pay", // 付费意愿
  "freelance", // 自由职业
  "side project", // 副业变现
  "consulting", // 咨询需求
  "budget", // 有预算的项目
];

/**
 * Hacker News（Algolia 搜索 API）适配器
 *
 * 走 hn.algolia.com（可直连；news.ycombinator.com 本机不通，故不直连、不做代理）。
 * 按发布时间倒序搜每个 query，取最近的 story + ask_hn。
 * 标题保留原文：大小写、产品名一律不动（降噪留给后面的 L1 路由判断）。
 */
export const hnAdapter: SourceAdapter = {
  key: "hn",
  label: "Hacker News",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const queries = configStringArray(config, "queries", DEFAULT_QUERIES);
    const days = configNumber(config, "days", 14);
    const perQuery = configNumber(config, "perQuery", 8);
    const since = Math.floor((Date.now() - days * 86400_000) / 1000);

    const seen = new Set<string>();
    const out: RawSignal[] = [];
    const errors: string[] = [];

    for (const q of queries) {
      if (out.length >= MAX_TOTAL) break;
      // 宽松搜索：不用 advancedSyntax，不限标题，tags=story,ask_hn（逗号=OR）
      // numericFilters 叠加 created_at_i + points 过滤噪声。
      const url =
        `${API}?query=${encodeURIComponent(q)}&tags=story,ask_hn` +
        `&hitsPerPage=${Math.floor(perQuery)}&numericFilters=created_at_i>${since},points>1`;
      try {
        const res = await fetch(url, {
          signal: timeoutSignal(),
          headers: { "user-agent": BROWSER_UA, accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        const hits = asRecord(json)?.hits;
        if (!Array.isArray(hits)) throw new Error("响应缺少 hits 数组");

        let qNew = 0;
        for (const raw of hits) {
          if (out.length >= MAX_TOTAL) break;
          const hit = asRecord(raw);
          if (!hit) continue;
          const objectID = strOf(hit.objectID);
          const title = strOf(hit.title);
          if (!objectID || !title || seen.has(objectID)) continue;
          seen.add(objectID);
          qNew++;
          // created_at 是 ISO 字符串：带上发布日期，时效性判断才有依据
          const published = strOf(hit.created_at).slice(0, 10);
          out.push({
            title,
            // 原文拼接：标题 + 正文（Ask HN 等故事正文多为 story_text）+ 外链
            content:
              `${title}。${strOf(hit.story_text)} ${strOf(hit.url)} 发布:${published}`.trim(),
            url: `https://news.ycombinator.com/item?id=${objectID}`,
          });
        }
        console.log(
          `[hn] 查询「${q}」命中 ${hits.length} 条，新增 ${qNew} 条（累计 ${out.length}）`
        );
      } catch (e) {
        errors.push(`「${q}」${briefError(e, 80)}`);
      }
    }

    // 全部 query 都失败才算该源失败；部分失败返回已有结果
    if (!out.length && errors.length) {
      throw new Error(`HN 查询全部失败：${errors.join("；")}`);
    }
    console.log(
      `[hn] 采集完成：${out.length} 条（${queries.length} 个查询，${errors.length} 个失败）`
    );
    return out.slice(0, MAX_TOTAL);
  },
};

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
