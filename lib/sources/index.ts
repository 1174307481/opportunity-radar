import { db } from "@/lib/db";
import { sources } from "@/lib/db/schema";
import { eleduckAdapter } from "./eleduck";
import { hnAdapter } from "./hn";
import type { SourceAdapter, SourceConfig } from "./types";

export * from "./types";
export { eleduckAdapter, hnAdapter };

/**
 * 适配器注册表：key → 适配器（cron 采集时按 sources.key 查）
 * github 已移除：star 涨 ≠ 有人付钱（需求信号标准不符），15 条全是历史积压且 0 今日产出。
 * github.ts 保留文件但不注册——已有 source:github 的历史 items 靠 source-label.ts 展示。
 */
export const ADAPTERS: Record<string, SourceAdapter> = {
  [eleduckAdapter.key]: eleduckAdapter,
  [hnAdapter.key]: hnAdapter,
};

/** 首次启动时预置的源（config 留空即用适配器默认值；enabled=0 的源种子时即关闭） */
export const DEFAULT_SOURCES: { key: string; config: SourceConfig; enabled: number }[] = [
  { key: "eleduck", config: {}, enabled: 1 },
  { key: "hn", config: {}, enabled: 1 },
];

/**
 * 保证 sources 表里有预置源：表为空才插（用户删光/改过的源不会被重新塞回来）
 * 幂等：并发调用靠 sources_key_uq 唯一索引兜底。
 */
export async function ensureSourcesSeeded(): Promise<void> {
  const rows = await db.select({ id: sources.id }).from(sources).limit(1);
  if (rows.length > 0) return;

  for (const s of DEFAULT_SOURCES) {
    await db
      .insert(sources)
      .values({
        key: s.key,
        enabled: s.enabled,
        config: JSON.stringify(s.config),
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
  }
}
