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
const MAX_TOTAL = 15;

/**
 * 默认查询词：都是「未被满足的需求 / 找人问工具」的口吻，最接近可做的机会。
 * 配合 advancedSyntax=true + 引号短语，Algolia 会做精确匹配。
 */
const DEFAULT_QUERIES = [
  "I would pay for",
  "would pay for",
  "need someone to build",
  "looking for a developer",
  "is there a tool that",
  "hiring remote",
];

/**
 * Hacker News（Algolia 搜索 API）适配器
 *
 * 走 hn.algolia.com（可直连；news.ycombinator.com 本机不通，故不直连、不做代理）。
 * 按发布时间倒序搜每个 query，取最近的 story。
 * 标题保留原文：大小写、产品名一律不动（降噪留给后面的 L1 路由判断）。
 */
export const hnAdapter: SourceAdapter = {
  key: "hn",
  label: "Hacker News",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const queries = configStringArray(config, "queries", DEFAULT_QUERIES);
    const days = configNumber(config, "days", 7);
    const perQuery = configNumber(config, "perQuery", 8);
    const since = Math.floor((Date.now() - days * 86400_000) / 1000);

    const seen = new Set<string>();
    const out: RawSignal[] = [];
    const errors: string[] = [];

    for (const q of queries) {
      if (out.length >= MAX_TOTAL) break;
      // 短语加引号配合 advancedSyntax=true 做精确匹配；
      // restrictSearchableAttributes=title 让引号短语只在标题上匹配；
      // tags=ask_hn 聚焦需求帖（Show HN 65% 是产品发布）；
      // numericFilters 叠加 points>3 过滤零关注度噪声。
      const url =
        `${API}?query=${encodeURIComponent(`"${q}"`)}&tags=ask_hn` +
        `&hitsPerPage=${Math.floor(perQuery)}&advancedSyntax=true` +
        `&restrictSearchableAttributes=title` +
        `&numericFilters=created_at_i>${since},points>3`;
      try {
        const res = await fetch(url, {
          signal: timeoutSignal(),
          headers: { "user-agent": BROWSER_UA, accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        const hits = asRecord(json)?.hits;
        if (!Array.isArray(hits)) throw new Error("响应缺少 hits 数组");

        for (const raw of hits) {
          if (out.length >= MAX_TOTAL) break;
          const hit = asRecord(raw);
          if (!hit) continue;
          const objectID = strOf(hit.objectID);
          const title = strOf(hit.title);
          if (!objectID || !title || seen.has(objectID)) continue;
          seen.add(objectID);
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
      } catch (e) {
        errors.push(`「${q}」${briefError(e, 80)}`);
      }
    }

    // 全部 query 都失败才算该源失败；部分失败返回已有结果
    if (!out.length && errors.length) {
      throw new Error(`HN 查询全部失败：${errors.join("；")}`);
    }
    return out.slice(0, MAX_TOTAL);
  },
};

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
