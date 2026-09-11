import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, opportunities } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const TIERS = ["today", "week", "archived", "observe"] as const;
const STATUSES = ["new", "researching", "contacted", "deal", "ignored"] as const;

type Tier = (typeof TIERS)[number];
type Status = (typeof STATUSES)[number];

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

/** 标题关键词转 LIKE 模式：转义 % _ \，配合 ESCAPE '\' 使用 */
function toLikePattern(keyword: string): string {
  const escaped = keyword.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** 机会列表：支持 ?tier= &status= &source= &query= 过滤，createdAt 倒序，上限 200 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tierParam = (searchParams.get("tier") || "").trim();
  const statusParam = (searchParams.get("status") || "").trim();
  const sourceParam = (searchParams.get("source") || "").trim();
  const query = (searchParams.get("query") || "").trim();

  if (tierParam && !isTier(tierParam)) {
    return NextResponse.json({ error: "tier 不合法" }, { status: 400 });
  }
  if (statusParam && !isStatus(statusParam)) {
    return NextResponse.json({ error: "status 不合法" }, { status: 400 });
  }
  // source 过滤：manual = 手动录入（text/url 合并），其余按 source:<key> 精确匹配；all/空 = 不过滤
  const SOURCE_KEYS = ["eleduck", "hn", "github"] as const;
  let sourceCond: SQL | null = null;
  if (sourceParam === "manual") {
    sourceCond = inArray(items.sourceType, ["text", "url"]);
  } else if ((SOURCE_KEYS as readonly string[]).includes(sourceParam)) {
    sourceCond = eq(items.sourceType, `source:${sourceParam}`);
  } else if (sourceParam && sourceParam !== "all") {
    return NextResponse.json({ error: "source 不合法" }, { status: 400 });
  }

  // 实际档位：用户改档优先于机器档
  const effectiveTier = sql<string>`COALESCE(${opportunities.userTier}, ${opportunities.tier})`;

  const conds: SQL[] = [];
  if (tierParam) {
    conds.push(
      sql`COALESCE(${opportunities.userTier}, ${opportunities.tier}) = ${tierParam}`
    );
  }
  if (statusParam) {
    conds.push(eq(opportunities.status, statusParam));
  }
  if (query) {
    conds.push(sql`${items.title} LIKE ${toLikePattern(query)} ESCAPE '\\'`);
  }
  if (sourceCond) conds.push(sourceCond);

  const rows = await db
    .select({
      opportunityId: opportunities.id,
      itemId: items.id,
      title: items.title,
      url: items.url,
      type: opportunities.type,
      effectiveTier,
      userTier: opportunities.userTier,
      score: opportunities.score,
      skillMatch: opportunities.skillMatch,
      fastTrack: opportunities.fastTrack,
      status: opportunities.status,
      sourceType: items.sourceType,
      createdAt: opportunities.createdAt,
    })
    .from(opportunities)
    .innerJoin(items, eq(items.id, opportunities.itemId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(opportunities.createdAt))
    .limit(200);

  return NextResponse.json({
    items: rows.map((r) => ({
      opportunityId: r.opportunityId,
      itemId: r.itemId,
      title: r.title,
      url: r.url,
      type: r.type,
      effectiveTier: r.effectiveTier,
      userTier: r.userTier,
      score: r.score,
      skillMatch: r.skillMatch,
      fastTrack: !!r.fastTrack,
      status: r.status,
      sourceType: r.sourceType,
      createdAt: r.createdAt,
    })),
  });
}
