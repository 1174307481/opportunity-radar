import {
  asRecord,
  briefError,
  configNumber,
  configString,
  timeoutSignal,
  type RawSignal,
  type SourceAdapter,
  type SourceConfig,
} from "./types";

const API = "https://api.github.com/search/repositories";
const DEFAULT_DAYS = 30;
const DEFAULT_PER_PAGE = 15;
/** 星数门槛：低于这个数的仓库噪音太大（个人练手项目、教程仓库） */
const MIN_STARS = 80;

/**
 * GitHub 新星适配器
 *
 * 搜「最近 N 天创建 + 星数达标」的仓库，用 star 排序——刚起量的小工具/新产品
 * 往往意味着有人在真金白银投票的新需求。走 api.github.com（可直连）。
 * 未带 token 时匿名限额 10 次/分钟，遇到 403 会把 reset 时间带进错误信息。
 */
export const githubAdapter: SourceAdapter = {
  key: "github",
  label: "GitHub 新星",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const days = configNumber(config, "days", DEFAULT_DAYS);
    const perPage = Math.min(Math.floor(configNumber(config, "perPage", DEFAULT_PER_PAGE)), 100);
    // config.q 给定时完全替换默认查询（便于人工临时换条件）
    const q = configString(config, "q", "").trim() || defaultQuery(days);

    const url =
      `${API}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
    let res: Response;
    try {
      res = await fetch(url, {
        signal: timeoutSignal(),
        headers: {
          "user-agent": "opportunity-radar/0.1 (personal tool)",
          accept: "application/vnd.github+json",
        },
      });
    } catch (e) {
      throw new Error(`GitHub 请求失败：${briefError(e, 160)}`);
    }

    if (!res.ok) {
      throw new Error(await describeError(res, q));
    }

    const json: unknown = await res.json();
    const items = asRecord(json)?.items;
    if (!Array.isArray(items)) {
      throw new Error("GitHub 响应缺少 items 数组");
    }

    const out: RawSignal[] = [];
    for (const raw of items) {
      const repo = asRecord(raw);
      if (!repo) continue;
      const fullName = strOf(repo.full_name);
      const htmlUrl = strOf(repo.html_url);
      if (!fullName || !htmlUrl) continue;
      const stars = numOrNull(repo.stargazers_count);
      const lang = strOf(repo.language);
      const createdAt = strOf(repo.created_at).slice(0, 10);
      const desc = strOf(repo.description);
      out.push({
        title: `${fullName} ★${stars ?? 0}`,
        content: [
          desc || null,
          lang ? `语言:${lang}` : null,
          stars !== null ? `star:${stars}` : null,
          createdAt ? `创建:${createdAt}` : null,
        ]
          .filter((x): x is string => !!x)
          .join(" | "),
        url: htmlUrl,
      });
    }
    return out;
  },
};

/** 默认查询：今天往前 days 天创建、星数 > MIN_STARS */
function defaultQuery(days: number): string {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return `created:>${since} stars:>${MIN_STARS}`;
}

/** 403/422 等错误：尽量把原因和速率限制重置时间带出来 */
async function describeError(res: Response, q: string): Promise<string> {
  let detail = "";
  try {
    const body: unknown = await res.json();
    detail = strOf(asRecord(body)?.message);
  } catch {
    /* 响应不是 JSON，忽略 */
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
    const resetAt = reset > 0 ? new Date(reset * 1000).toLocaleString("zh-CN") : "未知";
    const kind = remaining === "0" ? "触发速率限制" : "被拒绝（403）";
    return (
      `GitHub ${kind}：${detail || "API rate limit exceeded"}；` +
      `限额重置时间 ${resetAt}（查询：${q}）。可稍后重试或配 GITHUB_TOKEN。`
    );
  }
  return `GitHub 返回 HTTP ${res.status}${detail ? `：${detail}` : ""}（查询：${q}）`;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
