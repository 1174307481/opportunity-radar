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

const API = "https://www.douyin.com/aweme/v1/web/hot/search/list/";
const DEFAULT_LIMIT = 50;

/**
 * 抖音热搜适配器
 *
 * 走官方 web 接口，需 User-Agent + Referer，无 cookie。JSON 结构：
 * data.word_list[]（word=标题，hot_value=热度数字，position=排名）。
 *
 * 注意：word_list 里无可信链接字段，url 一律 null（禁止拼假 URL）。
 */
export const douyinHotAdapter: SourceAdapter = {
  key: "douyin-hot",
  label: "抖音热搜",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const limit = Math.min(
      Math.floor(configNumber(config, "limit", DEFAULT_LIMIT)),
      50
    );

    let res: Response;
    try {
      res = await fetch(API, {
        signal: timeoutSignal(),
        headers: {
          "user-agent": BROWSER_UA,
          referer: "https://www.douyin.com/",
          accept: "application/json, text/plain, */*",
        },
      });
    } catch (e) {
      throw new Error(`抖音热搜请求失败：${briefError(e, 160)}`);
    }
    if (!res.ok) {
      throw new Error(`抖音热搜返回 HTTP ${res.status}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(`抖音热搜 JSON 解析失败：${briefError(e, 160)}`);
    }

    const data = asRecord(asRecord(json)?.data);
    const list = data?.word_list;
    if (!Array.isArray(list)) {
      // 结构异常 → 静默返回空数组（不阻塞其他源）
      return [];
    }

    const out: RawSignal[] = [];
    for (const raw of list) {
      if (out.length >= limit) break;
      const item = asRecord(raw);
      if (!item) continue;
      const title = strOf(item.word);
      if (!title) continue;
      const hotValue = numOrZero(item.hot_value);
      const position = numOrZero(item.position);
      out.push({
        title,
        content: `${title} 热度:${hotValue} 排名:${position || out.length + 1}`,
        url: undefined,
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
