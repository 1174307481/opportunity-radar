import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ledger } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** 标记完成 / 改跟进时间 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ledgerId = Number(id);
  if (!Number.isFinite(ledgerId)) {
    return NextResponse.json({ error: "id 不合法" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as {
    done?: boolean;
    followUpAt?: number | null;
  } | null;

  const [current] = await db
    .select()
    .from(ledger)
    .where(eq(ledger.id, ledgerId));
  if (!current) return NextResponse.json({ error: "不存在" }, { status: 404 });

  const updates: { doneAt?: number; followUpAt?: number | null } = {};
  if (body?.done === true) updates.doneAt = Date.now();
  if (body && "followUpAt" in body) {
    const v = body.followUpAt;
    if (v === null) updates.followUpAt = null;
    else if (
      typeof v === "number" &&
      Number.isFinite(v) &&
      // 量纲守卫（与 POST 一致）：防 0/负数/秒级戳造成「永远到期」
      v >= Date.now() - 86400e3 &&
      v <= Date.now() + 10 * 365 * 86400e3
    ) {
      updates.followUpAt = v;
    } else {
      return NextResponse.json(
        { error: "followUpAt 需为合理的毫秒时间戳" },
        { status: 400 }
      );
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  }

  await db.update(ledger).set(updates).where(eq(ledger.id, ledgerId));
  return NextResponse.json({ ok: true });
}
