import type { RawSignal } from "./sources/types";

/**
 * 跨源热点去重模块
 *
 * 五源采集时，同一热点会同时挂在抖音+微博+头条榜上。绝不能分析三遍。
 * 本模块在入库前对本次采集的所有 RawSignal[] 做一轮跨源相似度匹配：
 *
 * 1. 各源内按排名（数组位置）算百分位：第 1 = 100，第 N = 0
 * 2. 归一化标题（复用 normalizeTitle 的思路：trim + 小写 + 去标点）
 * 3. 两两比较：2-gram Jaccard ≥ 0.5 或包含关系 → 同一趋势
 * 4. 同一趋势多条只保留百分位最高的一条
 * 5. 保留条的 content 前缀拼 `[多源: 抖音,微博]` 标记
 *
 * 为什么用 2-gram Jaccard 而非编辑距离：
 * - Jaccard 对词序不敏感（「龙虾火爆」和「火爆的龙虾」会匹配），中文热榜标题常换语序
 * - Set 交集 O(n)，比编辑距离 O(n²) 快
 * - 阈值 0.5 是保守起点（误合比漏合更严重）
 */

/** 带来源标注的 RawSignal（cron 端点构造） */
export interface TaggedRawSignal extends RawSignal {
  /** 适配器 key，如 "douyin-hot" / "weibo-hot" */
  sourceKey: string;
}

/** 去重后的信号（带合并来源列表 + 百分位） */
export interface DedupedSignal extends RawSignal {
  /** 取百分位最高那条的来源 */
  sourceKey: string;
  /** 命中的所有来源 key（含保留条本身的来源），按百分位降序 */
  mergedFrom: string[];
  /** 源内百分位（0-100，第 1 名 = 100） */
  percentile: number;
}

/** 短名 → 展示名（用于 [多源:] 标记） */
const SOURCE_SHORT_NAME: Record<string, string> = {
  "douyin-hot": "抖音",
  "weibo-hot": "微博",
  "zhihu-hot": "知乎",
  "baidu-hot": "百度",
  "toutiao-hot": "头条",
};

/** 归一化标题：trim + 小写 + 去标点 + 折叠空白（与 collect/route.ts 对齐） */
export function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 跨源去重主函数。
 *
 * 输入：五源采集的 TaggedRawSignal[]（已按各源内排名排序，第一名在前）
 * 输出：去重后的 DedupedSignal[]（同趋势只保留百分位最高的一条）
 *
 * 算法：并查集 + 2-gram Jaccard
 * - 先算各条信号的源内百分位
 * - 两两比较相似度，相似的合并为同一组
 * - 每组保留百分位最高的一条，content 前缀拼 [多源: ...]
 */
export function dedupCrossSource(
  signals: TaggedRawSignal[]
): DedupedSignal[] {
  if (signals.length === 0) return [];

  // 1. 算各条信号的源内百分位
  // 各源内按数组位置算：第 1 = 100，第 N = 0
  const bySource = new Map<string, TaggedRawSignal[]>();
  for (const s of signals) {
    const arr = bySource.get(s.sourceKey) ?? [];
    arr.push(s);
    bySource.set(s.sourceKey, arr);
  }
  const percentileOf = new Map<TaggedRawSignal, number>();
  for (const [, arr] of bySource) {
    const n = arr.length;
    for (let i = 0; i < n; i++) {
      // 第 0 名 = 100，第 n-1 名 = 0；n=1 时唯一一条 = 100
      const pct = n <= 1 ? 100 : Math.round(((n - 1 - i) / (n - 1)) * 100);
      percentileOf.set(arr[i], pct);
    }
  }

  // 2. 预计算每条信号的归一化标题 + 2-gram 集合
  const norms = signals.map((s) => normalizeTitle(s.title));
  const grams = norms.map((n) => bigramSet(n));

  // 3. 并查集：相似的信号合并为同一组
  const parent = signals.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // O(n²) 两两比较：n 通常 ≤ 180，可接受
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      if (signals[i].sourceKey === signals[j].sourceKey) continue; // 同源不跨源去重
      if (isSameTrend(norms[i], grams[i], norms[j], grams[j])) {
        union(i, j);
      }
    }
  }

  // 4. 分组：root → 成员索引列表
  const groups = new Map<number, number[]>();
  for (let i = 0; i < signals.length; i++) {
    const r = find(i);
    const arr = groups.get(r) ?? [];
    arr.push(i);
    groups.set(r, arr);
  }

  // 5. 每组保留百分位最高的一条
  const out: DedupedSignal[] = [];
  for (const [, members] of groups) {
    // 按百分位降序，取第一条
    members.sort((a, b) => (percentileOf.get(signals[b]) ?? 0) - (percentileOf.get(signals[a]) ?? 0));
    const keeperIdx = members[0];
    const keeper = signals[keeperIdx];
    const keeperPct = percentileOf.get(keeper) ?? 0;

    // 合并来源列表（按百分位降序，去重）
    const mergedSources: string[] = [];
    const seen = new Set<string>();
    for (const idx of members) {
      const sk = signals[idx].sourceKey;
      if (!seen.has(sk)) {
        seen.add(sk);
        mergedSources.push(sk);
      }
    }

    // 拼 [多源: ...] 标记（只在多源命中时加）
    const sourceNames = mergedSources
      .map((k) => SOURCE_SHORT_NAME[k] ?? k)
      .filter(Boolean);
    const prefix =
      mergedSources.length > 1 ? `[多源: ${sourceNames.join(",")}] ` : "";

    out.push({
      title: keeper.title,
      content: `${prefix}${keeper.content}`,
      url: keeper.url,
      sourceKey: keeper.sourceKey,
      mergedFrom: mergedSources,
      percentile: keeperPct,
    });
  }

  return out;
}

/**
 * 判定两条标题是否描述同一趋势：
 * - 2-gram Jaccard ≥ 0.5，或
 * - 一方标题完全包含另一方（归一化后）
 */
function isSameTrend(
  normA: string,
  gramsA: Set<string>,
  normB: string,
  gramsB: Set<string>
): boolean {
  if (!normA || !normB) return false;

  // 包含关系（如「小龙虾火爆」包含于「如何评价小龙虾火爆」）
  if (normA.includes(normB) || normB.includes(normA)) return true;

  // 2-gram Jaccard
  const inter = intersectionSize(gramsA, gramsB);
  const union = gramsA.size + gramsB.size - inter;
  if (union === 0) return false;
  const jaccard = inter / union;
  return jaccard >= 0.5;
}

/** 生成标题的 2-gram 集合（相邻 2 字符） */
function bigramSet(norm: string): Set<string> {
  const s = norm.replace(/\s+/g, "");
  if (s.length < 2) return new Set(s ? [s] : []);
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/** 两个 Set 的交集大小（遍历较小的那个） */
function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const x of small) {
    if (large.has(x)) count++;
  }
  return count;
}
