import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { items, opportunities } from "@/lib/db/schema";
import { startPipeline } from "@/lib/pipeline";
import { findDuplicate } from "@/app/api/cron/collect/route";

export const dynamic = "force-dynamic";

/** 信息列表（信息库页），支持 ?query= 关键词 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("query") || "").trim().toLowerCase();
  const rows = await db
    .select({
      id: items.id,
      title: items.title,
      url: items.url,
      sourceType: items.sourceType,
      aiStage: items.aiStage,
      errorMessage: items.errorMessage,
      foundAt: items.foundAt,
      oppId: opportunities.id,
      type: opportunities.type,
      tier: opportunities.tier,
      score: opportunities.score,
      skillMatch: opportunities.skillMatch,
      status: opportunities.status,
    })
    .from(items)
    .leftJoin(opportunities, eq(opportunities.itemId, items.id))
    .orderBy(desc(items.foundAt))
    .limit(200);

  const filtered = query
    ? rows.filter(
        (r) =>
          r.title.toLowerCase().includes(query) ||
          (r.tier || "").includes(query) ||
          r.aiStage.includes(query)
      )
    : rows;
  return NextResponse.json({ items: filtered });
}

/** 快速录入：text 直接存，url 先抓正文。返回 item id，流水线后台跑 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    type?: "text" | "url";
    content?: string;
  } | null;
  const content = (body?.content || "").trim();
  const type = body?.type === "url" ? "url" : "text";
  if (!content) {
    return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
  }
  if (type === "url" && !/^https?:\/\//i.test(content)) {
    return NextResponse.json({ error: "URL 格式不合法" }, { status: 400 });
  }

  let title = "";
  let text = content;
  let url: string | null = null;

  if (type === "url") {
    url = content;
    // 入库前双查重：先查 url 哈希（避免不必要的抓取）
    const dupe = await findDuplicate("", url);
    if (dupe) {
      return NextResponse.json({ id: dupe.id, duplicated: true });
    }
    try {
      const res = await fetch(content, {
        signal: AbortSignal.timeout(12000),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        },
      });
      const html = await res.text();
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = m ? m[1].trim().slice(0, 200) : content.slice(0, 80);
      text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 6000);
    } catch (e) {
      return NextResponse.json(
        { error: `抓取失败：${(e as Error).message.slice(0, 120)}。可改用「粘贴文本」方式录入。` },
        { status: 400 }
      );
    }
    // 抓取后双查重：标题匹配（防跨源重复）
    const titleDupe = await findDuplicate(title, null);
    if (titleDupe) {
      return NextResponse.json({ id: titleDupe.id, duplicated: true });
    }
  } else {
    title = content.split("\n")[0].slice(0, 100);
    text = content.slice(0, 8000);
    // 入库前双查重：归一化标题匹配（手工录入无 url，靠标题防跨源重复）
    const dupe = await findDuplicate(title, null);
    if (dupe) return NextResponse.json({ id: dupe.id, duplicated: true });
  }

  const now = Date.now();
  const [item] = await db
    .insert(items)
    .values({
      title,
      url,
      urlHash: url
        ? createHash("sha256").update(url.trim()).digest("hex")
        : createHash("sha256").update(text.replace(/\s+/g, "")).digest("hex"),
      content: text,
      sourceType: type,
      aiStage: "pending",
      foundAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (!item) {
    return NextResponse.json({ duplicated: true });
  }
  startPipeline(item.id);
  return NextResponse.json({ id: item.id, title: item.title });
}
