import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "./db/schema";
import {
  SKILL_PROFILE,
  SKILL_ALIAS,
  SOFT_SKILLS,
  type EffectiveProfile,
  defaultProfile,
} from "./profile";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: JSON.stringify(value), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value), updatedAt: Date.now() },
    });
}

export interface ProfileOverride {
  /** 在默认画像上覆盖等级；值为 0 表示从画像中移除 */
  levels?: Record<string, number>;
  /** 追加的自定义技能（canonical → level） */
  custom?: Record<string, number>;
  softSkills?: string[];
}

/** 默认画像 + settings 覆盖 → 当前生效画像 */
export async function loadProfile(): Promise<EffectiveProfile> {
  const base = defaultProfile();
  const ov = await getSetting<ProfileOverride>("profile_override", {});
  const softList = Array.isArray(ov.softSkills) ? ov.softSkills : null;
  const soft = softList ? new Set(softList) : base.soft; // 提供即整表替换
  const custom = ov.custom ?? {};
  const levels: Record<string, number> = { ...base.levels, ...custom };
  for (const [k, v] of Object.entries(ov.levels ?? {})) {
    if (v === 0) delete levels[k]; // 等级 0 = 移除（对默认技能与自定义技能都生效）
    else levels[k] = v;
  }
  return { levels, aliases: base.aliases, soft };
}

export { SKILL_PROFILE, SKILL_ALIAS, SOFT_SKILLS };
