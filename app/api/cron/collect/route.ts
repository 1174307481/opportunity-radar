import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, sources } from "@/lib/db/schema";
import { startPipeline } from "@/lib/pipeline";
import { ADAPTERS, briefError, ensureSourcesSeeded } from "@/lib/sources";
import type { RawSignal, SourceConfig } from "@/lib/sources";

export const dynamic = "force-dynamic";
/** 单源串行 + 每个适配器内部多请求，给足时间（自部署长驻进程 / 支持 maxDuration 的平台） */
export const maxDuration = 300;

interface SourceResult {
  key: string;
  found: number;
  inserted: number;
  status: "ok" | "error";
  message?: string;
}

/**
 * 采集入口：GET/POST 都支持（方便 crontab 用 curl 直接打）
 *
 * crontab 示例（每 30 分钟一次）：
 *   "0,30 * * * * curl -s -H 'x-cron-secret: $CRON_SECRET' http://localhost:3000/api/cron/collect"
 *
 * 单源失败不影响其他源；新条目落库后 fire-and-forget 跑流水线。
 */
async function runCollect(req: Request): Promise<NextResponse> {
  // ---- 鉴权：CRON_SECRET 非空则强制校验；未设置则放行（本地单用户）并给 warning ----
  const secret = (process.env.CRON_SECRET || "").trim();
  const warning = secret
    ? undefined
    : "CRON_SECRET 未设置，采集接口未鉴权（仅建议本地单用户环境如此）";
  if (secret) {
    const { searchParams } = new URL(req.url);
    const provided =
      req.headers.get("x-cron-secret") || searchParams.get("secret") || "";
    if (provided !== secret) {
      return NextResponse.json({ error: "鉴权失败" }, { status: 401 });
    }
  }

  await ensureSourcesSeeded();
  const rows = await db.select().from(sources).where(eq(sources.enabled, 1));

  const results: SourceResult[] = [];
  for (const row of rows) {
    const now = Date.now();
    const adapter = ADAPTERS[row.key];
    if (!adapter) {
      const message = `未注册的适配器：${row.key}`;
      await db
        .update(sources)
        .set({ lastRunAt: now, lastStatus: "error", lastMessage: message })
        .where(eq(sources.id, row.id));
      results.push({ key: row.key, found: 0, inserted: 0, status: "error", message });
      continue;
    }

    let signals: RawSignal[] = [];
    try {
      signals = await adapter.fetchSignals(parseConfig(row.config));
    } catch (e) {
      const message = brief(e);
      await db
        .update(sources)
        .set({ lastRunAt: now, lastStatus: "error", lastMessage: message })
        .where(eq(sources.id, row.id));
      console.error(`[collect] ${row.key} 采集失败:`, message);
      results.push({ key: row.key, found: 0, inserted: 0, status: "error", message });
      continue; // 单源挂了继续下一源
    }

    let inserted = 0;
    try {
      for (const sig of signals) {
        const title = (sig.title || "").trim().slice(0, 200);
        const content = (sig.content || "").trim().slice(0, 8000);
        const url = (sig.url || "").trim() || null;
        if (!title && !content) continue;

        const urlHash = hashOf(url, content);
        // 入库前双查重：urlHash 或归一化标题命中即跳过
        const dupe = await findDuplicate(title, url);
        if (dupe) {
          console.log(`[collect] 跳过重复条目（命中已有 item ${dupe.id}）`);
          continue;
        }

        const ts = Date.now();
        const [item] = await db
          .insert(items)
          .values({
            title,
            url,
            urlHash,
            content,
            sourceType: `source:${row.key}`,
            aiStage: "pending",
            foundAt: ts,
            updatedAt: ts,
          })
          .onConflictDoNothing()
          .returning({ id: items.id });
        if (!item) continue;
        inserted += 1;
        startPipeline(item.id); // fire-and-forget，不阻塞采集
      }
    } catch (e) {
      const message = brief(e);
      await db
        .update(sources)
        .set({ lastRunAt: now, lastStatus: "error", lastMessage: message })
        .where(eq(sources.id, row.id));
      console.error(`[collect] ${row.key} 入库失败:`, message);
      results.push({
        key: row.key,
        found: signals.length,
        inserted,
        status: "error",
        message,
      });
      continue;
    }

    const message = `采集${signals.length}条，新入库${inserted}条`;
    await db
      .update(sources)
      .set({ lastRunAt: now, lastStatus: "ok", lastMessage: message })
      .where(eq(sources.id, row.id));
    console.log(`[collect] ${row.key} ✓ ${message}`);
    results.push({
      key: row.key,
      found: signals.length,
      inserted,
      status: "ok",
      message,
    });
  }

  return NextResponse.json({
    ranAt: Date.now(),
    results,
    ...(warning ? { warning } : {}),
  });
}

export async function GET(req: Request) {
  return runCollect(req);
}

export async function POST(req: Request) {
  return runCollect(req);
}

/** 有 url 用 url 的 sha256；无 url 用去空白后的正文 sha256（与 items 路由保持一致） */
function hashOf(url: string | null, content: string): string {
  return url
    ? createHash("sha256").update(url).digest("hex")
    : createHash("sha256").update(content.replace(/\s+/g, "")).digest("hex");
}

/** 归一化标题：trim + 空白折叠 + 小写 + 去标点（用于跨源去重） */
export function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 入库前去重双查：
 * 1. urlHash = sha256(url)（有 url 时）
 * 2. 归一化标题精确匹配
 * 命中任一即返回已存在的 item id，调用方应跳过该条。
 * 修复手工录入（无 url）与采集条目撞不上的跨源重复 bug。
 */
export async function findDuplicate(
  title: string,
  url: string | null
): Promise<{ id: number } | null> {
  // 查 1：url 哈希
  if (url) {
    const urlHash = createHash("sha256").update(url).digest("hex");
    const [dupe] = await db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.urlHash, urlHash));
    if (dupe) return dupe;
  }

  // 查 2：归一化标题精确匹配（无 schema 列，取最近 1000 条在 JS 里比）
  const normalized = normalizeTitle(title);
  if (normalized) {
    const candidates = await db
      .select({ id: items.id, title: items.title })
      .from(items)
      .orderBy(desc(items.foundAt))
      .limit(1000);
    for (const c of candidates) {
      if (normalizeTitle(c.title) === normalized) {
        return { id: c.id };
      }
    }
  }

  return null;
}

function parseConfig(raw: string | null): SourceConfig {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as SourceConfig)
      : {};
  } catch {
    return {};
  }
}

/** 错误消息截到 200 字后落库/返回 */
function brief(e: unknown): string {
  return briefError(e, 200);
}
