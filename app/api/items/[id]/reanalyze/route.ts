import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { items } from "@/lib/db/schema";
import { startPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/** 重新分析（L1/L2 prompt 或画像更新后） */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const itemId = Number(id);
  await db.update(items).set({
    aiStage: "pending",
    errorMessage: null,
    updatedAt: Date.now(),
  }).where(eq(items.id, itemId));
  startPipeline(itemId);
  return NextResponse.json({ ok: true, id: itemId });
}
