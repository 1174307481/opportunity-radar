import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { items } from "@/lib/db/schema";
import { douyinHotAdapter } from "@/lib/sources/douyin-hot";
import { weiboHotAdapter } from "@/lib/sources/weibo-hot";
import { toutiaoHotAdapter } from "@/lib/sources/toutiao-hot";
import { zhihuHotAdapter } from "@/lib/sources/zhihu-hot";
import { baiduHotAdapter } from "@/lib/sources/baidu-hot";
import type { RawSignal } from "@/lib/sources/types";
import {
  dedupCrossSource,
  type TaggedRawSignal,
} from "@/lib/hotspot-dedup";
import { processHotspotBatch } from "@/lib/hotspot-pipeline";
import { findDuplicate } from "@/app/api/cron/collect/route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface SourceSummary {
  key: string;
  found: number;
  inserted: number;
  status: "ok" | "error";
  message?: string;
}

/**
 * 热点采集 cron 端点（与现有 collect 平行，逻辑独立）。
 *
 * crontab 示例（每 6 小时一次）：
 *   "0 0,6,12,18 * * * curl -s -H 'x-cron-secret: $CRON_SECRET' http://localhost:3000/api/cron/collect-hotspot"
 *
 * 流程：鉴权 → 五适配器采集 → 跨源去重 → findDuplicate 精确去重入库 → processHotspotBatch
 */
async function runCollect(req: Request): Promise<NextResponse> {
  // ---- 鉴权（与现有 collect 共用 CRON_SECRET） ----
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

  const adapters = [
    { adapter: douyinHotAdapter, sourceKey: "douyin-hot" },
    { adapter: weiboHotAdapter, sourceKey: "weibo-hot" },
    { adapter: toutiaoHotAdapter, sourceKey: "toutiao-hot" },
    { adapter: zhihuHotAdapter, sourceKey: "zhihu-hot" },
    { adapter: baiduHotAdapter, sourceKey: "baidu-hot" },
  ];

  // ---- 1. 五适配器采集（单源失败静默跳过） ----
  const sourceSummaries: SourceSummary[] = [];
  const allTagged: TaggedRawSignal[] = [];

  for (const { adapter, sourceKey } of adapters) {
    let signals: RawSignal[] = [];
    try {
      signals = await adapter.fetchSignals({});
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 200) : String(e);
      console.error(`[collect-hotspot] ${sourceKey} 采集失败:`, message);
      sourceSummaries.push({
        key: sourceKey,
        found: 0,
        inserted: 0,
        status: "error",
        message,
      });
      continue; // 单源挂了继续下一源
    }

    // 标注来源，收集到 allTagged
    for (const sig of signals) {
      allTagged.push({
        ...sig,
        sourceKey,
      });
    }
    sourceSummaries.push({
      key: sourceKey,
      found: signals.length,
      inserted: 0, // 先占位，入库后回填
      status: "ok",
    });
  }

  // ---- 2. 跨源去重（§4.2 阶段 2） ----
  let deduped;
  try {
    deduped = dedupCrossSource(allTagged);
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : String(e);
    console.error("[collect-hotspot] 跨源去重失败:", message);
    // 去重失败：降级为不去重，直接入库（每条独立）
    deduped = allTagged.map((s) => ({
      ...s,
      mergedFrom: [s.sourceKey],
      percentile: 0,
    }));
  }

  const dedupMergedCount = allTagged.length - deduped.length;

  // ---- 3. 逐条 findDuplicate 精确去重入库 ----
  const insertedIds: number[] = [];
  let insertedTotal = 0;
  let dedupDbSkipCount = 0;

  for (const sig of deduped) {
    const title = (sig.title || "").trim().slice(0, 200);
    const content = (sig.content || "").trim().slice(0, 8000);
    const url = (sig.url || "").trim() || null;
    if (!title && !content) continue;

    // 精确去重：urlHash 或归一化标题命中即跳过
    const dupe = await findDuplicate(title, url);
    if (dupe) {
      dedupDbSkipCount++;
      continue;
    }

    const urlHash = url
      ? createHash("sha256").update(url).digest("hex")
      : createHash("sha256").update(content.replace(/\s+/g, "")).digest("hex");

    const ts = Date.now();
    const sourceType = `source:${sig.sourceKey}`;
    try {
      const [item] = await db
        .insert(items)
        .values({
          title,
          url,
          urlHash,
          content,
          sourceType,
          aiStage: "pending",
          foundAt: ts,
          updatedAt: ts,
        })
        .onConflictDoNothing()
        .returning({ id: items.id });
      if (item) {
        insertedIds.push(item.id);
        insertedTotal++;
      }
    } catch (e) {
      console.error(
        `[collect-hotspot] 入库失败 (${sig.sourceKey} / ${title.slice(0, 40)}):`,
        e instanceof Error ? e.message.slice(0, 160) : String(e)
      );
    }
  }

  // 回填各源 inserted 计数（按 sourceType 统计）
  if (insertedIds.length > 0) {
    const insertedRows = await db
      .select({ id: items.id, sourceType: items.sourceType })
      .from(items)
      .where(
        // 只统计本次插入的
        inArray(items.id, insertedIds)
      );
    const bySourceCount = new Map<string, number>();
    for (const r of insertedRows) {
      bySourceCount.set(
        r.sourceType,
        (bySourceCount.get(r.sourceType) ?? 0) + 1
      );
    }
    for (const s of sourceSummaries) {
      if (s.status === "ok") {
        s.inserted = bySourceCount.get(`source:${s.key}`) ?? 0;
      }
    }
  }

  // ---- 4. processHotspotBatch ----
  let preFilterPass = 0;
  let l3Done = 0;
  let pipelineError: string | undefined;

  if (insertedIds.length > 0) {
    try {
      const outcomes = await processHotspotBatch(insertedIds);
      for (const o of outcomes) {
        if (o.preFilterPassed) preFilterPass++;
        if (o.tier === "today" || o.tier === "week" || o.tier === "archived") {
          // l3Done 统计 L3 完成的（通过预筛且 tier 非 null）
          if (o.preFilterPassed && !o.error) l3Done++;
        }
      }
    } catch (e) {
      pipelineError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      console.error("[collect-hotspot] 流水线失败:", pipelineError);
    }
  }

  return NextResponse.json({
    ranAt: Date.now(),
    sources: sourceSummaries,
    deduped: {
      totalCollected: allTagged.length,
      afterCrossSource: deduped.length,
      merged: dedupMergedCount,
      dbSkipped: dedupDbSkipCount,
    },
    inserted: insertedTotal,
    insertedIds,
    preFilterPass,
    l3Done,
    ...(pipelineError ? { pipelineError } : {}),
    ...(warning ? { warning } : {}),
  });
}

export async function GET(req: Request) {
  return runCollect(req);
}

export async function POST(req: Request) {
  return runCollect(req);
}
