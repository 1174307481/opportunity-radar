import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, opportunities } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** 单条信息 + 关联机会（首页轮询录入进度用） */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [item] = await db
    .select()
    .from(items)
    .where(eq(items.id, Number(id)));
  if (!item) return NextResponse.json({ error: "不存在" }, { status: 404 });

  const [opp] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.itemId, item.id));

  return NextResponse.json({
    id: item.id,
    title: item.title,
    aiStage: item.aiStage,
    errorMessage: item.errorMessage,
    opportunityId: opp?.id ?? null,
    tier: opp?.tier ?? null,
  });
}
