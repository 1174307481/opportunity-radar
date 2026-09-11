import {
  asRecord,
  briefError,
  configNumber,
  timeoutSignal,
  type RawSignal,
  type SourceAdapter,
  type SourceConfig,
} from "./types";

const API = "https://60s-api.viki.moe/v2/weibo";
const DEFAULT_LIMIT = 50;

/**
 * 微博热搜适配器
 *
 * 走开源聚合 60s-api（github.com/vikiboss/60s）。JSON 结构：
 * data[]（title/hot_value/link），50 条，link 是真实链接。
 *
 * 降级：60s API 请求失败时返回空数组（不抛错），不阻塞其他源。
 */
export const weiboHotAdapter: SourceAdapter = {
  key: "weibo-hot",
  label: "微博热搜",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const limit = Math.min(
      Math.floor(configNumber(config, "limit", DEFAULT_LIMIT)),
      50
    );

    let res: Response;
    try {
      res = await fetch(API, {
        signal: timeoutSignal(),
        headers: { accept: "application/json" },
      });
    } catch (e) {
      // 降级：60s 挂了，静默返回空数组
      console.warn(`[weibo-hot] 请求失败，跳过：${briefError(e, 120)}`);
      return [];
    }
    if (!res.ok) {
      console.warn(`[weibo-hot] HTTP ${res.status}，跳过`);
      return [];
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      console.warn(`[weibo-hot] JSON 解析失败，跳过：${briefError(e, 120)}`);
      return [];
    }

    const list = asRecord(json)?.data;
    if (!Array.isArray(list)) return [];

    const out: RawSignal[] = [];
    for (const raw of list) {
      if (out.length >= limit) break;
      const item = asRecord(raw);
      if (!item) continue;
      const title = strOf(item.title);
      if (!title) continue;
      const hotValue = numOrZero(item.hot_value);
      const link = strOf(item.link) || undefined;
      out.push({
        title,
        content: `${title} 热度:${hotValue}`,
        url: link,
      });
    }
    return out;
  },
};

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function numOrZero(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
