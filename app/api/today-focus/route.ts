import { NextResponse } from "next/server";
import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, ledger, opportunities } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

const FOCUS_KEY = "today_focus";

/** settings.today_focus 存储结构 */
interface FocusRecord {
  date: string;
  opportunityId: number;
  done: boolean;
}

/** 本地日期 YYYY-MM-DD */
function today(): string {
  return new Date().toLocaleDateString("sv-SE");
}

/** 焦点（含标题）+ 到期跟进 */
export async function GET() {
  const stored = await getSetting<FocusRecord | null>(FOCUS_KEY, null);

  let focus: {
    date: string;
    opportunityId: number;
    done: boolean;
    title: string;
  } | null = null;

  if (stored && stored.date === today()) {
    const [row] = await db
      .select({ title: items.title })
      .from(opportunities)
      .innerJoin(items, eq(items.id, opportunities.itemId))
      .where(eq(opportunities.id, stored.opportunityId));
    focus = {
      date: stored.date,
      opportunityId: stored.opportunityId,
      done: !!stored.done,
      title: row?.title ?? "",
    };
  }

  const dueRows = await db
    .select({
      ledgerId: ledger.id,
      opportunityId: ledger.opportunityId,
      title: items.title,
      note: ledger.note,
      followUpAt: ledger.followUpAt,
    })
    .from(ledger)
    .innerJoin(opportunities, eq(opportunities.id, ledger.opportunityId))
    .innerJoin(items, eq(items.id, opportunities.itemId))
    .where(
      and(
        isNotNull(ledger.followUpAt),
        lte(ledger.followUpAt, Date.now()),
        isNull(ledger.doneAt)
      )
    )
    .orderBy(asc(ledger.followUpAt))
    .limit(10);

  const dueFollowUps = dueRows.map((r) => ({
    ledgerId: r.ledgerId,
    opportunityId: r.opportunityId,
    title: r.title,
    note: r.note,
    followUpAt: r.followUpAt as number,
  }));

  return NextResponse.json({ focus, dueFollowUps });
}

/** 设今天的焦点 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    opportunityId?: number;
  } | null;
  const opportunityId = Number(body?.opportunityId);
  if (!Number.isFinite(opportunityId) || opportunityId <= 0) {
    return NextResponse.json({ error: "opportunityId 不合法" }, { status: 400 });
  }

  const [opp] = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.id, opportunityId));
  if (!opp) return NextResponse.json({ error: "机会不存在" }, { status: 404 });

  const record: FocusRecord = { date: today(), opportunityId, done: false };
  await setSetting(FOCUS_KEY, record);
  return NextResponse.json({ ok: true, focus: record });
}

/** 标记今天的焦点完成 */
export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as { done?: boolean } | null;
  if (body?.done !== true) {
    return NextResponse.json({ error: "仅支持 {done:true}" }, { status: 400 });
  }

  const stored = await getSetting<FocusRecord | null>(FOCUS_KEY, null);
  if (!stored || stored.date !== today()) {
    return NextResponse.json({ error: "今天还没有焦点" }, { status: 404 });
  }

  const record: FocusRecord = { ...stored, done: true };
  await setSetting(FOCUS_KEY, record);
  return NextResponse.json({ ok: true, focus: record });
}
