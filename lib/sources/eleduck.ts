import {
  asRecord,
  BROWSER_UA,
  briefError,
  configNumber,
  timeoutSignal,
  type RawSignal,
  type SourceAdapter,
  type SourceConfig,
} from "./types";

const HOME_URL = "https://eleduck.com/";
const DEFAULT_LIMIT = 40;
const MAX_WALK_DEPTH = 20;

/** 薪资模式：值钱帖优先排前面 */
const SALARY_RE = /\d+\s*[kK]|\d{4,}\s*元|\/月|\/天|预算|报价|full_title/i;
/** 非需求类分类：曝光/分享/讨论 */
const SKIP_CATEGORIES = new Set(["曝光", "分享", "讨论"]);

/**
 * 电鸭社区适配器
 *
 * 首页是 Next.js SSR，帖子列表挂在 __NEXT_DATA__ 的
 * props.initialProps.pageProps.postList.posts 里。为了不跟死页面层级，
 * 这里递归遍历整个 JSON，凡是「同时有 title 和 id」的节点都当帖子收。
 *
 * 关于 id（实测 2026-09）：电鸭的帖子 id 是 hashid 字符串（如 x0fRxy / MZXfoe），
 * 不是数字；只有少数接口会给数字 id。所以数字与字符串两种都收，
 * 判不准的宁可放过（漏收）也不误收——反正后面还有 items.urlHash 去重兜底。
 *
 * 帖子详情页真实路径是 /posts/<id>（/post/<id> 返回 404），故 url 用 /posts/。
 *
 * 列表级预过滤（首页 __NEXT_DATA__ 已有这些字段）：
 * - 丢 pinned===true
 * - 丢 category.name ∈ {曝光, 分享, 讨论}
 * - 丢标题以「[接单]」开头或含「我能提供/可接单/自荐」的供给方自荐帖
 * content 拼进 tags + category.name + publish_ele_paid，给 L1 更多线索。
 */
export const eleduckAdapter: SourceAdapter = {
  key: "eleduck",
  label: "电鸭社区",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const limit = configNumber(config, "limit", DEFAULT_LIMIT);

    let res: Response;
    try {
      res = await fetch(HOME_URL, {
        signal: timeoutSignal(),
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (e) {
      throw new Error(`电鸭首页请求失败：${briefError(e, 160)}`);
    }
    if (!res.ok) {
      throw new Error(`电鸭首页返回 HTTP ${res.status}`);
    }
    const html = await res.text();

    const m = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (!m) {
      throw new Error(
        '电鸭首页 HTML 中未找到 <script id="__NEXT_DATA__">，页面结构可能已改版'
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch (e) {
      throw new Error(
        `电鸭 __NEXT_DATA__ JSON 解析失败（前 120 字：${m[1].slice(0, 120)}）：${briefError(e, 160)}`
      );
    }

    // 递归遍历，收集形如帖子的节点
    const seen = new Set<string>();
    const out: PostData[] = [];
    const walk = (node: unknown, depth: number): void => {
      if (depth > MAX_WALK_DEPTH || out.length >= limit) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (node === null || typeof node !== "object") return;

      const post = toPost(node as Record<string, unknown>);
      if (post && !seen.has(post.id)) {
        seen.add(post.id);
        out.push(post);
      }
      for (const child of Object.values(node as Record<string, unknown>)) {
        walk(child, depth + 1);
      }
    };
    walk(data, 0);

    // 值钱帖优先：标题命中薪资模式的排前面
    out.sort((a, b) => (b.salaryHit ? 1 : 0) - (a.salaryHit ? 1 : 0));

    return out.slice(0, limit).map((p) => p.signal);
  },
};

interface PostData {
  id: string;
  signal: RawSignal;
  salaryHit: boolean;
}

/** title + id 齐全且通过预过滤的节点 → PostData；否则 null */
function toPost(node: Record<string, unknown>): PostData | null {
  // 标题取 full_title || title
  const rawFullTitle = strOf(node.full_title);
  const rawTitle = strOf(node.title);
  const title = rawFullTitle || rawTitle;
  if (!title) return null;

  const rawId = node.id;
  let id: string;
  if (typeof rawId === "number") {
    // 数字 id：4 位数以上才算帖子（过滤标签/分类等小整数 id）
    if (!Number.isInteger(rawId) || rawId < 1000) return null;
    id = String(rawId);
  } else if (typeof rawId === "string") {
    // 字符串 id：电鸭是 6 位左右 hashid（如 x0fRxy / MZXfoe），太短的判为噪声
    if (!/^[A-Za-z0-9_-]{5,64}$/.test(rawId)) return null;
    id = rawId;
  } else {
    return null;
  }

  // 预过滤：跳过置顶帖
  if (node.pinned === true) return null;

  // 预过滤：跳过非需求类分类（曝光/分享/讨论）
  const category = asRecord(node.category);
  const categoryName = category ? strOf(category.name) : "";
  if (SKIP_CATEGORIES.has(categoryName)) return null;

  // 预过滤：跳过供给方自荐帖
  if (title.startsWith("[接单]") || /我能提供|可接单|自荐/.test(title)) {
    return null;
  }

  // 拼装 content：标题 + 摘要 + tags + 分类 + 付费标记 + 发布时间（给 L1/L2 更多线索）
  const excerpt = strOf(node.excerpt) || strOf(node.summary);
  const tagsStr = tagsToString(node.tags);
  const paidStr = paidToString(node.publish_ele_paid);
  // 发布时间（实测为 ISO 字符串，如 2019-11-07T22:19:00.000+08:00；数字则兼容秒/毫秒），
  // 时效性判断只能靠它（正文常无日期）
  const rawPub = node.published_at;
  const publishedAtMs =
    typeof rawPub === "number"
      ? rawPub < 1e12
        ? rawPub * 1000
        : rawPub
      : typeof rawPub === "string" && !Number.isNaN(Date.parse(rawPub))
        ? Date.parse(rawPub)
        : null;
  const dateStr = publishedAtMs
    ? `发布:${new Date(publishedAtMs).toISOString().slice(0, 10)}`
    : "";
  const content = [title, excerpt, tagsStr, categoryName, paidStr, dateStr]
    .filter(Boolean)
    .join(" ")
    .trim();

  // 薪资模式检测（用于排序）
  const salaryHit = SALARY_RE.test(title);

  return {
    id,
    signal: {
      title,
      content,
      url: `https://eleduck.com/posts/${id}`,
    },
    salaryHit,
  };
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** tags 可能是字符串数组、对象数组（带 name）或逗号分隔字符串 */
function tagsToString(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item !== null && typeof item === "object") {
          return strOf((item as Record<string, unknown>).name);
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/** publish_ele_paid 可能是 boolean / number / string */
function paidToString(v: unknown): string {
  if (typeof v === "boolean") return v ? "付费发布" : "";
  if (typeof v === "number") return v ? "付费发布" : "";
  if (typeof v === "string" && v.trim()) return `付费:${v.trim()}`;
  return "";
}
