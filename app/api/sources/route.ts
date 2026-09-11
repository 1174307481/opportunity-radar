import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sources } from "@/lib/db/schema";
import { ADAPTERS, ensureSourcesSeeded } from "@/lib/sources";
import type { SourceConfig } from "@/lib/sources";

export const dynamic = "force-dynamic";

/** 源列表：首次调用会预置默认源；config 反序列化成对象返回 */
export async function GET() {
  await ensureSourcesSeeded();
  const rows = await db.select().from(sources).orderBy(asc(sources.id));
  return NextResponse.json({
    sources: rows.map((r) => ({
      id: r.id,
      key: r.key,
      label: ADAPTERS[r.key]?.label ?? r.key,
      enabled: r.enabled === 1,
      config: parseConfig(r.config),
      lastRunAt: r.lastRunAt,
      lastStatus: r.lastStatus,
      lastMessage: r.lastMessage,
      createdAt: r.createdAt,
    })),
  });
}

/** 改源：{key, enabled?, config?} —— 只允许改这两项，key 是定位用的不落库更新 */
export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    key?: string;
    enabled?: boolean;
    config?: SourceConfig;
  } | null;
  const key = (body?.key || "").trim();
  if (!body || !key) {
    return NextResponse.json({ error: "缺少 key" }, { status: 400 });
  }

  const [row] = await db.select().from(sources).where(eq(sources.key, key));
  if (!row) {
    return NextResponse.json({ error: `源不存在：${key}` }, { status: 404 });
  }

  const patch: { enabled?: number; config?: string } = {};
  if (typeof body.enabled === "boolean") {
    patch.enabled = body.enabled ? 1 : 0;
  }
  if (body.config !== undefined) {
    if (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)) {
      return NextResponse.json({ error: "config 必须是对象" }, { status: 400 });
    }
    patch.config = JSON.stringify(body.config);
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  }

  await db.update(sources).set(patch).where(eq(sources.key, key));
  return NextResponse.json({ ok: true });
}

/** config 是 TEXT 列存的 JSON；解析失败按空对象处理（适配器自身有默认值兜底） */
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
