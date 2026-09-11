import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, ledger, opportunities } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** 最近 100 条行动记录（倒序） */
export async function GET() {
  const rows = await db
    .select({
      id: ledger.id,
      opportunityId: ledger.opportunityId,
      title: items.title,
      note: ledger.note,
      followUpAt: ledger.followUpAt,
      doneAt: ledger.doneAt,
      createdAt: ledger.createdAt,
    })
    .from(ledger)
    .innerJoin(opportunities, eq(opportunities.id, ledger.opportunityId))
    .innerJoin(items, eq(items.id, opportunities.itemId))
    .orderBy(desc(ledger.createdAt))
    .limit(100);

  return NextResponse.json({ entries: rows });
}

/** 记一笔行动 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    opportunityId?: number;
    note?: string;
    followUpAt?: number | null;
  } | null;

  const opportunityId = Number(body?.opportunityId);
  if (!Number.isFinite(opportunityId) || opportunityId <= 0) {
    return NextResponse.json({ error: "opportunityId 不合法" }, { status: 400 });
  }
  const note = (body?.note ?? "").trim();
  if (!note) {
    return NextResponse.json({ error: "备注不能为空" }, { status: 400 });
  }

  const [opp] = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.id, opportunityId));
  if (!opp) return NextResponse.json({ error: "机会不存在" }, { status: 404 });

  let followUpAt: number | null = null;
  if (
    typeof body?.followUpAt === "number" &&
    Number.isFinite(body.followUpAt)
  ) {
    // 量纲守卫：只接受合理范围内的毫秒时间戳（防秒级/0/负数混入导致"永远到期"）
    if (
      body.followUpAt < Date.now() - 86400e3 ||
      body.followUpAt > Date.now() + 10 * 365 * 86400e3
    ) {
      return NextResponse.json(
        { error: "followUpAt 需为合理的毫秒时间戳" },
        { status: 400 }
      );
    }
    followUpAt = body.followUpAt;
  }

  const [row] = await db
    .insert(ledger)
    .values({ opportunityId, note, followUpAt, createdAt: Date.now() })
    .returning({ id: ledger.id });

  return NextResponse.json({ id: row.id });
}
