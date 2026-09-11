import { NextResponse } from "next/server";
import { and, desc, eq, ne, or, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, ledger, opportunities } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export interface FirstStep {
  time_box: string;
  action: string;
  object: string;
  channel: string;
  quantity: string;
  completion_rule: string;
  copyable_first_message: string;
}

/** 行动账本聚合（唯一 KPI：本周行动数） */
export interface Kpi {
  weekActions: number;
  daysSinceLastAction: number | null;
  last7Days: { date: string; count: number }[];
}

/** 本地时区 YYYY-MM-DD */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 一次拉全量 createdAt，在 JS 里做本地时区聚合（逻辑简单，量级小） */
async function buildKpi(): Promise<Kpi> {
  const rows = await db.select({ createdAt: ledger.createdAt }).from(ledger);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 本周一 0 点（本地时区）：getDay() 周日=0，换算成周一=0
  const mondayOffset = (todayStart.getDay() + 6) % 7;
  const weekStart = new Date(
    todayStart.getFullYear(),
    todayStart.getMonth(),
    todayStart.getDate() - mondayOffset
  ).getTime();

  // 今天往前 7 天（含今天）
  const last7Days: { date: string; count: number }[] = [];
  const indexByDate = new Map<string, number>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(
      todayStart.getFullYear(),
      todayStart.getMonth(),
      todayStart.getDate() - i
    );
    indexByDate.set(localDateKey(d), last7Days.length);
    last7Days.push({ date: localDateKey(d), count: 0 });
  }

  let weekActions = 0;
  let lastAt: number | null = null;
  for (const r of rows) {
    if (r.createdAt >= weekStart) weekActions += 1;
    const idx = indexByDate.get(localDateKey(new Date(r.createdAt)));
    if (idx !== undefined) last7Days[idx].count += 1;
    if (lastAt === null || r.createdAt > lastAt) lastAt = r.createdAt;
  }

  const daysSinceLastAction =
    lastAt === null ? null : Math.max(0, Math.ceil((Date.now() - lastAt) / 86400e3));

  return { weekActions, daysSinceLastAction, last7Days };
}

/** 首页数据：今天看 + 计数 + 最近录入（供轮询） */
export async function GET() {
  const rows = await db
    .select({
      opportunityId: opportunities.id,
      itemId: items.id,
      title: items.title,
      url: items.url,
      type: opportunities.type,
      tier: opportunities.tier,
      userTier: opportunities.userTier,
      score: opportunities.score,
      skillMatch: opportunities.skillMatch,
      fastTrack: opportunities.fastTrack,
      status: opportunities.status,
      analysis: opportunities.analysis,
      sourceType: items.sourceType,
      createdAt: opportunities.createdAt,
    })
    .from(opportunities)
    .innerJoin(items, eq(items.id, opportunities.itemId))
    .where(
      and(
        or(eq(opportunities.tier, "today"), eq(opportunities.userTier, "today")),
        ne(opportunities.status, "ignored")
      )
    )
    // 快通道排在分数通道之后（先看打分过硬的，快通道是「待验证」性质的补充）
    .orderBy(opportunities.fastTrack, desc(opportunities.createdAt))
    .limit(3); // 宁空勿凑：今天看最多 3 条

  const today = rows.map((r) => {
    const a = r.analysis ? JSON.parse(r.analysis) : null;
    return {
      opportunityId: r.opportunityId,
      itemId: r.itemId,
      title: r.title,
      url: r.url,
      type: r.type,
      score: r.score,
      skillMatch: r.skillMatch,
      fastTrack: !!r.fastTrack,
      status: r.status,
      verdict: a?.verdict ?? "",
      firstStep: a?.first_step ?? null,
      sourceType: r.sourceType,
    };
  });

  const countsRows = await db
    .select({
      tier: opportunities.tier,
      userTier: opportunities.userTier,
      count: sql<number>`count(*)`,
    })
    .from(opportunities)
    .groupBy(opportunities.tier, opportunities.userTier);

  const counts = { today: today.length, week: 0, archived: 0 };
  for (const c of countsRows) {
    const t = c.userTier || c.tier;
    if (t === "week") counts.week += c.count;
    else if (t === "archived" || t === "observe") counts.archived += c.count;
  }
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(items);

  const recentItems = await db
    .select({
      id: items.id,
      title: items.title,
      aiStage: items.aiStage,
      foundAt: items.foundAt,
    })
    .from(items)
    .orderBy(desc(items.foundAt))
    .limit(8);

  const weekList = await db
    .select({
      opportunityId: opportunities.id,
      itemId: items.id,
      title: items.title,
      type: opportunities.type,
      score: opportunities.score,
      skillMatch: opportunities.skillMatch,
      status: opportunities.status,
      sourceType: items.sourceType,
    })
    .from(opportunities)
    .innerJoin(items, eq(items.id, opportunities.itemId))
    .where(
      and(
        or(eq(opportunities.tier, "week"), eq(opportunities.userTier, "week")),
        ne(opportunities.status, "ignored")
      )
    )
    .orderBy(desc(opportunities.score))
    .limit(20);

  const kpi = await buildKpi();

  return NextResponse.json({
    today,
    week: weekList,
    counts: { ...counts, items: total },
    recentItems,
    kpi,
  });
}

// 防 lint 未使用告警
void isNull;
