import { eq, inArray, or } from "drizzle-orm";
import { db } from "./db";
import { items, opportunities, userActions } from "./db/schema";
import { runL1, type L1Result } from "./ai/l1";
import { runL2, computeTotalScore, type L2Result } from "./ai/l2";
import {
  computeSkillMatch,
  profileText,
  type EffectiveProfile,
  type MatchResult,
} from "./profile";
import { loadProfile } from "./settings";

export type Tier = "today" | "week" | "archived" | "observe";

export interface PipelineOutcome {
  itemId: number;
  noise: boolean;
  fastTrack: boolean;
  tier: Tier | null;
  score: number | null;
  skillMatch: number | null;
  opportunityId: number | null;
}

type ItemRow = typeof items.$inferSelect;

/**
 * 完整流水线：L1 路由 →（噪声→归档 | 快通道或 L2）→ 评分 → 分档
 * 分档规则（V2 定稿 + 门禁重排）：
 * - 噪声 → archived（skillMatch=null）
 * - !fastTrack && skillMatch < 40 → archived（跳过 L2，省 24% L2 调用）
 * - !fastTrack && 无商业信号 → archived（跳过 L2，保护钱包）
 * - 快通道（接单+明确预算+coreHit+未降权）→ today（跳过分数门槛）
 * - score ≥ 70 且 skillMatch ≥ 60 → today
 * - 40 ≤ score < 70 → week
 * - 其余 → archived
 */
export async function processItem(itemId: number): Promise<PipelineOutcome> {
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new Error(`item ${itemId} 不存在`);

  const out: PipelineOutcome = {
    itemId, noise: false, fastTrack: false,
    tier: null, score: null, skillMatch: null, opportunityId: null,
  };

  const prof = await loadProfile();

  // ---- L1（单条直调，不进批处理队列） ----
  let l1: L1Result;
  try {
    [l1] = await runL1(
      [{ id: itemId, title: item.title, content: item.content,
         sourceNote: getSourceNote(item.sourceType) }],
      profileText(prof)
    );
  } catch (e) {
    await db.update(items).set({
      aiStage: "failed",
      errorMessage: `L1: ${(e as Error).message.slice(0, 500)}`,
      updatedAt: Date.now(),
    }).where(eq(items.id, itemId));
    throw e;
  }

  await db.update(items).set({
    aiStage: "l1_done",
    l1: JSON.stringify(l1),
    updatedAt: Date.now(),
  }).where(eq(items.id, itemId));

  await processItemL1Done(item, l1, prof, out);
  return out;
}

/**
 * L1 之后的共享处理逻辑：噪声 → 归档 | 门禁 → L2 → 评分 → 分档。
 * 供 processItem（单条）和 processBatch（批量化）共用。
 */
async function processItemL1Done(
  item: ItemRow,
  l1: L1Result,
  prof: EffectiveProfile,
  out: PipelineOutcome,
): Promise<void> {
  const itemId = item.id;

  // ---- 噪声 → 归档 ----
  if (l1.is_noise) {
    out.noise = true;
    // 覆盖旧结论：重分析判噪时，不能让上一轮的 today/评分残留在首页
    await db.insert(opportunities).values({
      itemId, type: l1.category, tier: "archived",
      score: null, skillMatch: null, skillMatchDetail: null,
      fastTrack: 0, analysis: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    }).onConflictDoUpdate({
      target: opportunities.itemId,
      set: {
        type: l1.category, tier: "archived",
        score: null, skillMatch: null, skillMatchDetail: null,
        fastTrack: 0, analysis: null, updatedAt: Date.now(),
      },
    });
    await db.update(items).set({ aiStage: "archived", updatedAt: Date.now() })
      .where(eq(items.id, itemId));
    return;
  }

  // ---- 技能匹配 ----
  const match = computeSkillMatch(l1.required_skills, prof);
  out.skillMatch = match.score;

  /**
   * 快通道（V2 设计）：接单类 + 明确预算 + 核心技能命中（importance≥4 的硬技能
   * 至少一条匹配）+ 未被 L1 降权。不看总分——快通道的意义就是总分未知的接单
   * 直进今天看，由 L2 红队分析和第一步验证动作帮用户降低风险，而不是挡在门外。
   */
  const fastTrack =
    l1.category === "接单" &&
    l1.has_budget === true &&
    match.coreHit &&
    l1.downweight !== true;
  out.fastTrack = fastTrack;

  // ---- 门禁 1：技能匹配过低 → 归档，跳过 L2（省 24% L2 调用） ----
  if (!fastTrack && match.score < 40) {
    out.tier = "archived";
    await archivePreL2(itemId, l1, match);
    return;
  }

  // ---- 门禁 2：无商业信号 → 归档，跳过 L2（保护钱包） ----
  // 电鸭源豁免：正文被截断为约200字摘要，缺金额词不等于没预算
  if (!fastTrack && !hasCommercialSignal(item.title, item.content, item.sourceType)) {
    out.tier = "archived";
    await archivePreL2(itemId, l1, match);
    return;
  }

  // ---- L2 ----
  let l2: L2Result;
  try {
    ({ result: l2 } = await runL2({
      title: item.title, content: item.content, l1,
    }));
  } catch (e) {
    await db.update(items).set({
      aiStage: "failed",
      errorMessage: `L2: ${(e as Error).message.slice(0, 500)}`,
      updatedAt: Date.now(),
    }).where(eq(items.id, itemId));
    throw e;
  }

  const score = computeTotalScore(l2.scores);
  out.score = score;

  // ---- 分档 ----
  let tier: Tier;
  if (fastTrack) tier = "today";
  else if (score >= 70 && match.score >= 60) tier = "today";
  else if (score >= 40) tier = "week";
  else tier = "archived";
  out.tier = tier;

  const [opp] = await db.insert(opportunities).values({
    itemId,
    type: l1.category,
    tier,
    score,
    skillMatch: match.score,
    skillMatchDetail: JSON.stringify(match.detail),
    fastTrack: fastTrack ? 1 : 0,
    analysis: JSON.stringify(l2),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: opportunities.itemId,
    set: {
      type: l1.category, tier, score,
      skillMatch: match.score,
      skillMatchDetail: JSON.stringify(match.detail),
      fastTrack: fastTrack ? 1 : 0,
      analysis: JSON.stringify(l2),
      updatedAt: Date.now(),
    },
  }).returning();

  out.opportunityId = opp.id;
  await db.update(items).set({ aiStage: "ready", updatedAt: Date.now() })
    .where(eq(items.id, itemId));
}

/** 落 archived 机会行（带 skillMatch/skillMatchDetail，score=null，analysis=null） */
async function archivePreL2(
  itemId: number,
  l1: L1Result,
  match: MatchResult,
): Promise<void> {
  await db.insert(opportunities).values({
    itemId, type: l1.category, tier: "archived",
    score: null, skillMatch: match.score, skillMatchDetail: JSON.stringify(match.detail),
    fastTrack: 0, analysis: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: opportunities.itemId,
    set: {
      type: l1.category, tier: "archived",
      score: null, skillMatch: match.score, skillMatchDetail: JSON.stringify(match.detail),
      fastTrack: 0, analysis: null, updatedAt: Date.now(),
    },
  });
  await db.update(items).set({ aiStage: "archived", updatedAt: Date.now() })
    .where(eq(items.id, itemId));
}

const COMMERCIAL_RE = /pay|hire|budget|price|\$|元|预算|付费|报价|招聘|薪资|月薪|\/月|\/天|k\b/i;

/**
 * 商业信号预检：title+content 是否含付费/招聘相关词。
 * 电鸭源豁免（正文被截断为约200字摘要，缺金额词不等于没预算）。
 */
function hasCommercialSignal(title: string, content: string, sourceType: string): boolean {
  if (sourceType.startsWith("source:eleduck")) return true;
  return COMMERCIAL_RE.test(`${title} ${content}`);
}

/** 电鸭源的 L1 提示，告知正文被截断 */
function getSourceNote(sourceType: string): string | undefined {
  if (sourceType.startsWith("source:eleduck")) {
    return "来源：电鸭社区，正文被截断为约200字摘要；未出现金额不等于没有预算";
  }
  return undefined;
}

// ============================================================================
// 批处理队列：攒批调用 runL1（每批最多 8 条），一次 runL1(批) 后逐条走各自分支。
// 失败隔离：批内某条后续处理失败只影响该条（stage=failed）；
//           runL1 整体失败则批内全部 failed（沿用现有错误写库格式）。
// inFlight 去重、MAX_CONCURRENT、recoverPendingItems 语义保持
// （并发=2 理解为 2 个在飞批）。
// ============================================================================

const MAX_CONCURRENT = 2;
const BATCH_SIZE = 8;
const BATCH_FLUSH_MS = 500;
const queue: (() => void)[] = [];
const inFlight = new Set<number>();
let active = 0;
const pendingBatch: number[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift()!;
    active++;
    task();
  }
}

function flushBatch(): void {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (pendingBatch.length === 0) return;
  const batch = pendingBatch.splice(0, Math.min(BATCH_SIZE, pendingBatch.length));
  // 剩余待处理项：立即排程下一次 flush
  if (pendingBatch.length > 0) {
    batchTimer = setTimeout(() => flushBatch(), 0);
  }
  queue.push(() => {
    processBatch(batch)
      .catch((e) => {
        console.error(
          "[pipeline] 批处理失败:",
          e instanceof Error ? e.message : String(e)
        );
      })
      .finally(() => {
        active--;
        for (const id of batch) inFlight.delete(id);
        pump();
      });
  });
  pump();
}

export function startPipeline(itemId: number): void {
  if (inFlight.has(itemId)) return;
  inFlight.add(itemId);
  pendingBatch.push(itemId);

  if (pendingBatch.length >= BATCH_SIZE) {
    flushBatch();
  } else if (!batchTimer) {
    batchTimer = setTimeout(() => flushBatch(), BATCH_FLUSH_MS);
  }
}

/**
 * 批量处理：一次 runL1 调用处理整批，然后逐条走 processItemL1Done。
 * 失败隔离：L1 整体失败 → 批内全部 failed；后续处理失败 → 仅该条 failed。
 */
async function processBatch(itemIds: number[]): Promise<void> {
  // 加载所有条目
  const batchItems = await db
    .select()
    .from(items)
    .where(inArray(items.id, itemIds));

  const itemMap = new Map(batchItems.map((i) => [i.id, i]));
  const prof = await loadProfile();

  // 准备 L1 输入（跳过不存在的条目）
  const l1Inputs: { id: number; title: string; content: string; sourceNote?: string }[] = [];
  const validItems: ItemRow[] = [];
  for (const id of itemIds) {
    const item = itemMap.get(id);
    if (!item) {
      console.error(`[pipeline] item ${id} 不存在（批内跳过）`);
      continue;
    }
    validItems.push(item);
    l1Inputs.push({
      id: item.id,
      title: item.title,
      content: item.content,
      sourceNote: getSourceNote(item.sourceType),
    });
  }

  if (l1Inputs.length === 0) return;

  // ---- 批量 L1 ----
  let l1Results: L1Result[];
  try {
    l1Results = await runL1(l1Inputs, profileText(prof));
  } catch (e) {
    // L1 整体失败：批内全部 failed
    const msg = `L1: ${(e as Error).message.slice(0, 500)}`;
    for (const item of validItems) {
      await db.update(items).set({
        aiStage: "failed",
        errorMessage: msg,
        updatedAt: Date.now(),
      }).where(eq(items.id, item.id));
    }
    throw e;
  }

  // ---- 逐条处理 ----
  for (let i = 0; i < validItems.length; i++) {
    const item = validItems[i];
    const l1 = l1Results[i];
    const out: PipelineOutcome = {
      itemId: item.id, noise: false, fastTrack: false,
      tier: null, score: null, skillMatch: null, opportunityId: null,
    };
    try {
      // 持久化 L1 结果（与单条路径一致）
      await db.update(items).set({
        aiStage: "l1_done",
        l1: JSON.stringify(l1),
        updatedAt: Date.now(),
      }).where(eq(items.id, item.id));

      await processItemL1Done(item, l1, prof, out);
    } catch (e) {
      // 单条失败：仅该条 failed
      const msg = (e as Error).message.slice(0, 500);
      await db.update(items).set({
        aiStage: "failed",
        errorMessage: msg,
        updatedAt: Date.now(),
      }).where(eq(items.id, item.id));
      console.error(
        `[pipeline] item ${item.id} 处理失败:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}

/** 进程启动时补偿：把上次重启丢在队列里的非终态条目重新入队 */
export async function recoverPendingItems(): Promise<number> {
  const stuck = await db
    .select({ id: items.id })
    .from(items)
    .where(or(eq(items.aiStage, "pending"), eq(items.aiStage, "l1_done")));
  for (const s of stuck) {
    if (!inFlight.has(s.id)) {
      console.log(`[pipeline] 恢复未完成条目 item ${s.id}`);
      startPipeline(s.id);
    }
  }
  return stuck.length;
}

export async function logAction(
  opportunityId: number,
  action: string,
  fromValue?: string | null,
  toValue?: string | null
): Promise<void> {
  await db.insert(userActions).values({
    opportunityId, action,
    fromValue: fromValue ?? null, toValue: toValue ?? null,
    createdAt: Date.now(),
  });
}
