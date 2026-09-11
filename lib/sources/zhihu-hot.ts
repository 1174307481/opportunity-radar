import {
  BROWSER_UA,
  asRecord,
  briefError,
  configNumber,
  timeoutSignal,
  type RawSignal,
  type SourceAdapter,
  type SourceConfig,
} from "./types";

const API = "https://api.zhihu.com/topstory/hot-list";
const DEFAULT_LIMIT = 20;

/**
 * 知乎热榜适配器
 *
 * 走官方 API。JSON 结构：data[].target.title + data[].detail_text（热度词）。
 * target.url 若存在则用真实值否则 null。
 * 可试 limit=20，失败退 10。
 */
export const zhihuHotAdapter: SourceAdapter = {
  key: "zhihu-hot",
  label: "知乎热榜",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const limit = Math.min(
      Math.floor(configNumber(config, "limit", DEFAULT_LIMIT)),
      20
    );

    const out: RawSignal[] = [];
    // 先试 limit=20（配置值），失败退 10
    for (const tryLimit of [limit, Math.min(limit, 10)]) {
      const url = `${API}?limit=${tryLimit}`;
      let res: Response;
      try {
        res = await fetch(url, {
          signal: timeoutSignal(),
          headers: {
            "user-agent": BROWSER_UA,
            accept: "application/json",
          },
        });
      } catch (e) {
        console.warn(`[zhihu-hot] 请求失败，跳过：${briefError(e, 120)}`);
        return out;
      }
      if (!res.ok) {
        console.warn(`[zhihu-hot] HTTP ${res.status}，跳过该次尝试`);
        continue; // 退到下一次尝试
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        console.warn(`[zhihu-hot] JSON 解析失败，跳过：${briefError(e, 120)}`);
        return out;
      }

      const list = asRecord(json)?.data;
      if (!Array.isArray(list)) {
        continue;
      }

      for (const raw of list) {
        if (out.length >= limit) break;
        const item = asRecord(raw);
        if (!item) continue;
        const target = asRecord(item.target);
        if (!target) continue;
        const title = strOf(target.title);
        if (!title) continue;
        const detailText = strOf(item.detail_text);
        const url = strOf(target.url) || undefined;
        out.push({
          title,
          content: `${title}。${detailText} 热度:${detailText}`.trim(),
          url,
        });
      }
      if (out.length > 0) break; // 第一次尝试就有数据，不再退而求其次
    }
    return out;
  },
};

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
