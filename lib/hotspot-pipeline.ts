import { eq, inArray, and, sql } from "drizzle-orm";
import { db } from "./db";
import { items, opportunities } from "./db/schema";
import {
  runHotspotPreFilter,
  runHotspotL3,
  computeHotspotScore,
  type HotspotPreFilterResult,
  type HotspotL3Result,
} from "./ai/hotspot";
import { profileText, type EffectiveProfile } from "./profile";
import { loadProfile } from "./settings";

export interface HotspotBatchOutcome {
  itemId: number;
  preFilterPassed: boolean;
  tier: "today" | "week" | "archived" | null;
  score: number | null;
  opportunityId: number | null;
  error?: string;
}

type ItemRow = typeof items.$inferSelect;

/**
 * 热点批量处理流水线。
 *
 * 1. 加载批内 items
 * 2. 查最近 24h 已分析标题列表（语义去重）
 * 3. 批量预筛（runHotspotPreFilter）
 * 4. 通过 → aiStage=l1_done + items.l1=预筛 JSON
 *    不通过 → aiStage=archived + items.l1=预筛 JSON（含 reason）
 * 5. 对通过的逐条调 L3
 * 6. 落 opportunities（type="热点衍生"，score=总分，skillMatch=null，fastTrack=0）
 * 7. 分档：score≥65 且 days_left≤3 且 启动成本≥70 → today；
 *    score≥40 → week；<40 → archived
 * 8. aiStage=ready
 */
export async function processHotspotBatch(
  itemIds: number[]
): Promise<HotspotBatchOutcome[]> {
  if (itemIds.length === 0) return [];

  // 1. 加载批内 items
  const batchItems = await db
    .select()
    .from(items)
    .where(inArray(items.id, itemIds));
  const itemMap = new Map(batchItems.map((i) => [i.id, i]));

  const validItems: ItemRow[] = [];
  for (const id of itemIds) {
    const item = itemMap.get(id);
    if (!item) {
      console.error(`[hotspot-pipeline] item ${id} 不存在（批内跳过）`);
      continue;
    }
    validItems.push(item);
  }
  if (validItems.length === 0) return [];

  const prof = await loadProfile();

  // 2. 查最近 24h 已分析标题列表（语义层去重）
  const recentTitles = await fetchRecentAnalyzedTitles();

  // 3. 批量预筛
  const preFilterInputs = validItems.map((item) => ({
    id: item.id,
    title: item.title,
    content: item.content,
  }));

  let preFilterResults: HotspotPreFilterResult[];
  try {
    preFilterResults = await runHotspotPreFilter(
      preFilterInputs,
      recentTitles,
      profileText(prof)
    );
  } catch (e) {
    // 预筛整体失败：批内全部 failed
    const msg = `预筛: ${(e as Error).message.slice(0, 500)}`;
    for (const item of validItems) {
      await db
        .update(items)
        .set({ aiStage: "failed", errorMessage: msg, updatedAt: Date.now() })
        .where(eq(items.id, item.id));
    }
    throw e;
  }

  // 4. 持久化预筛结果 + 分流
  const passed: { item: ItemRow; preFilter: HotspotPreFilterResult }[] = [];
  const outcomes: HotspotBatchOutcome[] = [];

  for (let i = 0; i < validItems.length; i++) {
    const item = validItems[i];
    const preFilter = preFilterResults[i];

    try {
      // 持久化预筛结论（通过/不通过都存 l1 字段，有审计痕迹）
      await db
        .update(items)
        .set({
          l1: JSON.stringify(preFilter),
          updatedAt: Date.now(),
        })
        .where(eq(items.id, item.id));

      if (preFilter.pass) {
        // 通过 → l1_done（待 L3 深分析）
        await db
          .update(items)
          .set({ aiStage: "l1_done", updatedAt: Date.now() })
          .where(eq(items.id, item.id));
        passed.push({ item, preFilter });
        outcomes.push({
          itemId: item.id,
          preFilterPassed: true,
          tier: null,
          score: null,
          opportunityId: null,
        });
      } else {
        // 不通过 → archived
        await archiveHotspotItem(item.id, preFilter);
        outcomes.push({
          itemId: item.id,
          preFilterPassed: false,
          tier: "archived",
          score: null,
          opportunityId: null,
        });
      }
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await db
        .update(items)
        .set({ aiStage: "failed", errorMessage: msg, updatedAt: Date.now() })
        .where(eq(items.id, item.id));
      outcomes.push({
        itemId: item.id,
        preFilterPassed: false,
        tier: null,
        score: null,
        opportunityId: null,
        error: msg,
      });
    }
  }

  // 5-8. 对通过的逐条调 L3
  for (const { item, preFilter } of passed) {
    try {
      await processL3(item, preFilter, prof, outcomes);
    } catch (e) {
      const msg = `L3: ${(e as Error).message.slice(0, 500)}`;
      await db
        .update(items)
        .set({ aiStage: "failed", errorMessage: msg, updatedAt: Date.now() })
        .where(eq(items.id, item.id));
      const idx = outcomes.findIndex((o) => o.itemId === item.id);
      if (idx >= 0) outcomes[idx].error = msg;
      console.error(
        `[hotspot-pipeline] item ${item.id} L3 失败:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return outcomes;
}

/**
 * L3 深度分析 + 落库 + 分档。
 */
async function processL3(
  item: ItemRow,
  preFilter: HotspotPreFilterResult,
  prof: EffectiveProfile,
  outcomes: HotspotBatchOutcome[]
): Promise<void> {
  // 调 L3
  const { result: l3 } = await runHotspotL3({
    title: item.title,
    content: item.content,
    preFilter,
    profileLine: profileText(prof),
  });

  // 计算总分
  const score = computeHotspotScore(l3.scores);

  // 分档（§3.4 三重门槛）
  const tier = computeHotspotTier(l3, score);

  // 落 opportunities
  const [opp] = await db
    .insert(opportunities)
    .values({
      itemId: item.id,
      type: "热点衍生",
      tier,
      score,
      skillMatch: null,
      skillMatchDetail: null,
      fastTrack: 0,
      analysis: JSON.stringify(l3),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: opportunities.itemId,
      set: {
        type: "热点衍生",
        tier,
        score,
        skillMatch: null,
        skillMatchDetail: null,
        fastTrack: 0,
        analysis: JSON.stringify(l3),
        updatedAt: Date.now(),
      },
    })
    .returning();

  // aiStage = ready
  await db
    .update(items)
    .set({ aiStage: "ready", updatedAt: Date.now() })
    .where(eq(items.id, item.id));

  // 更新 outcome
  const idx = outcomes.findIndex((o) => o.itemId === item.id);
  if (idx >= 0) {
    outcomes[idx].tier = tier;
    outcomes[idx].score = score;
    outcomes[idx].opportunityId = opp.id;
  }
}

/**
 * 分档规则（§3.4）：
 * - today：score ≥ 65 AND days_left ≤ 3 AND 启动成本.score ≥ 70
 * - week：score ≥ 40
 * - archived：score < 40
 */
function computeHotspotTier(
  l3: HotspotL3Result,
  score: number
): "today" | "week" | "archived" {
  const startupScore = l3.scores["启动成本"]?.score;
  const daysLeft = l3.time_window.days_left;

  if (
    score >= 65 &&
    typeof startupScore === "number" &&
    startupScore >= 70 &&
    typeof daysLeft === "number" &&
    daysLeft <= 3
  ) {
    return "today";
  }
  if (score >= 40) return "week";
  return "archived";
}

/**
 * 不通过的条目归档：只置 items.aiStage=archived（预筛结论已由调用方写入 items.l1）。
 * 不建 opportunities 行——L1 判噪同样是只归档 items 不建行，机会列表页只该出现
 * 真正分析过的机会，否则 173 条热榜垃圾行会刷满列表。
 */
async function archiveHotspotItem(
  itemId: number,
  _preFilter: HotspotPreFilterResult
): Promise<void> {
  await db
    .update(items)
    .set({ aiStage: "archived", updatedAt: Date.now() })
    .where(eq(items.id, itemId));
}

/**
 * 查最近 24h 已通过预筛的热点标题列表（语义层去重兜底）。
 *
 * 查 items 表 WHERE sourceType IN ('source:*-hot') AND aiStage IN ('l1_done','ready')
 * AND updatedAt > now-86400000
 */
async function fetchRecentAnalyzedTitles(): Promise<string[]> {
  const cutoff = Date.now() - 86_400_000;
  try {
    const rows = await db
      .select({ title: items.title })
      .from(items)
      .where(
        and(
          inArray(items.sourceType, [
            "source:douyin-hot",
            "source:weibo-hot",
            "source:zhihu-hot",
            "source:baidu-hot",
            "source:toutiao-hot",
          ]),
          inArray(items.aiStage, ["l1_done", "ready"]),
          sql`${items.updatedAt} > ${cutoff}`
        )
      )
      .limit(100);
    return rows.map((r) => r.title).filter(Boolean);
  } catch (e) {
    console.warn(
      "[hotspot-pipeline] 查询最近标题失败（继续，不做语义去重）:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}
