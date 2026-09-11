import { NextResponse } from "next/server";
import { loadProfile, getSetting, setSetting, type ProfileOverride } from "@/lib/settings";
import { SKILL_PROFILE } from "@/lib/profile";

export const dynamic = "force-dynamic";

/** 当前生效画像（默认 + 覆盖合并后的结果；被移除的技能以 level=0 返回，供恢复） */
export async function GET() {
  const prof = await loadProfile();
  const override = await getSetting<ProfileOverride>("profile_override", {});
  const keys = new Set<string>([
    ...Object.keys(SKILL_PROFILE),
    ...Object.keys(prof.levels),
    ...Object.keys(override.levels ?? {}),
  ]);
  const skills = [...keys]
    .map((key) => ({
      key,
      level: prof.levels[key] ?? 0, // 0 = 已移除
      isCustom: !(key in SKILL_PROFILE),
      isOverridden:
        override.levels?.[key] !== undefined ||
        override.custom?.[key] !== undefined,
    }))
    .sort((a, b) => b.level - a.level || a.key.localeCompare(b.key));
  return NextResponse.json({
    skills,
    softSkills: [...prof.soft],
  });
}

/** 保存画像覆盖：{levels?: {key: 0|0.7|0.85|0.95}, custom?: {name: level}, softSkills?: string[]} */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    levels?: Record<string, number>;
    custom?: Record<string, number>;
    softSkills?: string[];
  } | null;
  if (!body) return NextResponse.json({ error: "请求体不合法" }, { status: 400 });

  const cur = await getSetting<ProfileOverride>("profile_override", {});
  const next: ProfileOverride = { ...cur };
  if (body.levels) {
    for (const v of Object.values(body.levels)) {
      if (![0, 0.7, 0.85, 0.95].includes(v)) {
        return NextResponse.json({ error: "level 只允许 0/0.7/0.85/0.95" }, { status: 400 });
      }
    }
    next.levels = { ...cur.levels, ...body.levels };
  }
  if (body.custom) {
    const custom: Record<string, number> = {};
    for (const [rawK, v] of Object.entries(body.custom)) {
      const k = rawK.trim().toLowerCase(); // 统一小写，否则匹配器永远命中不了
      if (!k || ![0.7, 0.85, 0.95].includes(v)) {
        return NextResponse.json({ error: "custom 不合法" }, { status: 400 });
      }
      custom[k] = v;
    }
    next.custom = { ...cur.custom, ...custom };
    // 清掉同名的历史 levels=0 覆盖，否则「移除后重新添加」会被陈旧的 0 杀掉
    if (next.levels) {
      for (const k of Object.keys(custom)) delete next.levels[k];
    }
  }
  if (body.softSkills !== undefined) {
    if (
      !Array.isArray(body.softSkills) ||
      body.softSkills.some((s) => typeof s !== "string" || !s.trim())
    ) {
      return NextResponse.json(
        { error: "softSkills 必须是非空字符串数组" },
        { status: 400 }
      );
    }
    next.softSkills = body.softSkills.map((s) => s.trim());
  }

  await setSetting("profile_override", next);
  return NextResponse.json({ ok: true });
}
