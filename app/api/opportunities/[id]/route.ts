import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, opportunities } from "@/lib/db/schema";
import { logAction } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

const TIERS = ["today", "week", "archived", "observe"];
const STATUSES = ["new", "researching", "contacted", "deal", "ignored"];

/** 机会详情（含 L2 分析全文 + 原始信息） */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [opp] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, Number(id)));
  if (!opp) return NextResponse.json({ error: "不存在" }, { status: 404 });

  const [item] = await db.select().from(items).where(eq(items.id, opp.itemId));

  return NextResponse.json({
    opportunity: {
      id: opp.id,
      itemId: opp.itemId,
      type: opp.type,
      tier: opp.tier,
      userTier: opp.userTier,
      score: opp.score,
      skillMatch: opp.skillMatch,
      skillMatchDetail: opp.skillMatchDetail ? JSON.parse(opp.skillMatchDetail) : [],
      fastTrack: !!opp.fastTrack,
      status: opp.status,
      analysis: opp.analysis ? JSON.parse(opp.analysis) : null,
      createdAt: opp.createdAt,
    },
    item,
  });
}

/** 改档位 / 改状态，同时记行为账 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const oppId = Number(id);
  const body = (await req.json().catch(() => null)) as {
    tier?: string;
    status?: string;
  } | null;

  const [current] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, oppId));
  if (!current) return NextResponse.json({ error: "不存在" }, { status: 404 });

  const updates: Record<string, unknown> = { updatedAt: Date.now() };

  if (body?.tier) {
    if (body.tier === "auto") {
      // 取消人工改档，回到跟随机器档
      updates.userTier = null;
      await logAction(oppId, "tier_change", current.userTier || current.tier, "auto");
    } else {
      if (!TIERS.includes(body.tier)) {
        return NextResponse.json({ error: "tier 不合法" }, { status: 400 });
      }
      updates.userTier = body.tier; // 用户改档优先于机器档
      await logAction(oppId, "tier_change", current.userTier || current.tier, body.tier);
    }
  }
  if (body?.status) {
    if (!STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "status 不合法" }, { status: 400 });
    }
    updates.status = body.status;
    await logAction(oppId, "status_change", current.status, body.status);
  }

  await db.update(opportunities).set(updates).where(eq(opportunities.id, oppId));
  return NextResponse.json({ ok: true });
}
