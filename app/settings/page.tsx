"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 设置页：技能画像编辑器。
 * 画像（levels + custom + softSkills）是匹配打分的输入，改完保存后，
 * 对已录入的信息点「重新分析」即可按新画像重新评分。
 */

/** 可提交的等级档位：0.95 精通 / 0.85 熟练 / 0.7 会用，0 = 从画像移除 */
type LevelValue = 0 | 0.7 | 0.85 | 0.95;

/** GET /api/profile 返回的技能行 */
interface ProfileSkill {
  key: string;
  level: number;
  isCustom: boolean;
  isOverridden: boolean;
}

interface ProfileResponse {
  skills: ProfileSkill[];
  softSkills: string[];
}

/** PUT /api/profile 请求体：只提交改动项 */
interface ProfilePutBody {
  levels?: Record<string, number>;
  custom?: Record<string, number>;
  softSkills?: string[];
}

interface ProfileErrorResponse {
  error?: string;
}

/** 技能区渲染用的行（服务端行 + 本地待提交状态合并） */
interface SkillRowView {
  key: string;
  /** 服务端基线等级，0 表示已从画像移除 */
  baseLevel: number;
  /** 当前显示等级（含未保存改动） */
  level: LevelValue;
  isCustom: boolean;
  /** 相对默认值被改过（本地点过「恢复默认」后不再显示） */
  isOverridden: boolean;
  /** 存在未保存改动 */
  pending: boolean;
  /** 本次新增、尚未保存的自定义技能 */
  isNew: boolean;
}

interface LevelOption {
  value: LevelValue;
  label: string;
}

/** 下拉可选项：精通 / 熟练 / 会用 / 移除 */
const LEVEL_OPTIONS: LevelOption[] = [
  { value: 0.95, label: "精通" },
  { value: 0.85, label: "熟练" },
  { value: 0.7, label: "会用" },
  { value: 0, label: "移除" },
];

/** 自定义技能只能选正档位 */
const CUSTOM_LEVEL_OPTIONS: LevelOption[] = LEVEL_OPTIONS.filter((o) => o.value !== 0);

const LEVEL_LABEL: Record<LevelValue, string> = {
  0.95: "精通",
  0.85: "熟练",
  0.7: "会用",
  0: "已移除",
};

const LEVEL_TEXT_CLASS: Record<LevelValue, string> = {
  0.95: "text-emerald-300",
  0.85: "text-sky-300",
  0.7: "text-neutral-300",
  0: "text-neutral-600",
};

/** 共享表单控件样式（见 globals.css 的 .field） */
const SELECT_CLASS = "field w-auto shrink-0 px-2 py-1 text-xs";

const INPUT_CLASS = "field min-w-0 flex-1";

const MAX_SKILL_NAME = 24;

/** 非标准等级归到最近的档：≥0.9→精通、≥0.78→熟练、否则会用；≤0 → 移除 */
function bucketOf(level: number): LevelValue {
  if (level <= 0) return 0;
  if (level >= 0.9) return 0.95;
  if (level >= 0.78) return 0.85;
  return 0.7;
}

/** <select> 的字符串值 → 档位（非法值兜底为 0） */
function parseLevelValue(raw: string): LevelValue {
  switch (raw) {
    case "0.95":
      return 0.95;
    case "0.85":
      return 0.85;
    case "0.7":
      return 0.7;
    default:
      return 0;
  }
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function SettingsPage() {
  const [skills, setSkills] = useState<ProfileSkill[]>([]);
  const [softSkills, setSoftSkills] = useState<string[]>([]);
  const [baseSoftSkills, setBaseSoftSkills] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 未保存的等级改动：key → 档位（0 = 移除）。默认技能的移除也走这里（提交 levels[key]=0） */
  const [edits, setEdits] = useState<Record<string, LevelValue>>({});
  /** 点过「恢复默认」的行（本地隐藏「已改」徽章，保存时回写其当前等级） */
  const [restored, setRestored] = useState<Set<string>>(new Set());
  /** 本次新增的自定义技能：中文技能名 → 档位 */
  const [pendingCustom, setPendingCustom] = useState<Record<string, LevelValue>>({});

  const [customName, setCustomName] = useState("");
  const [customLevel, setCustomLevel] = useState<LevelValue>(0.85);
  const [customError, setCustomError] = useState<string | null>(null);

  const [softInput, setSoftInput] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTip, setSavedTip] = useState(false);

  /** 请求序号：避免慢请求覆盖新结果 */
  const reqSeq = useRef(0);

  const fetchProfile = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await fetch("/api/profile", { cache: "no-store" });
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const data = (await res.json()) as ProfileResponse;
      if (seq !== reqSeq.current) return;
      setSkills(Array.isArray(data.skills) ? data.skills : []);
      const soft = Array.isArray(data.softSkills) ? data.softSkills : [];
      setSoftSkills([...soft]);
      setBaseSoftSkills([...soft]);
      setLoadError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const softChanged = !sameStringArray(softSkills, baseSoftSkills);

  /** 技能区行：服务端技能（保持服务端排序，避免编辑时行跳动）+ 本次新增的自定义技能 */
  const rows = useMemo<SkillRowView[]>(() => {
    const out: SkillRowView[] = skills.map((s) => {
      const edit = edits[s.key];
      return {
        key: s.key,
        baseLevel: s.level,
        level: edit !== undefined ? edit : bucketOf(s.level),
        isCustom: s.isCustom,
        isOverridden: s.isOverridden && !restored.has(s.key),
        pending: edit !== undefined || restored.has(s.key),
        isNew: false,
      };
    });
    for (const [key, level] of Object.entries(pendingCustom)) {
      const edit = edits[key];
      out.push({
        key,
        baseLevel: level,
        level: edit !== undefined ? edit : level,
        isCustom: true,
        isOverridden: false,
        pending: true,
        isNew: true,
      });
    }
    return out;
  }, [skills, edits, restored, pendingCustom]);

  const changeCount = useMemo(() => {
    const keys = new Set<string>(Object.keys(edits));
    restored.forEach((k) => keys.add(k));
    Object.keys(pendingCustom).forEach((k) => keys.add(k));
    return keys.size + (softChanged ? 1 : 0);
  }, [edits, restored, pendingCustom, softChanged]);

  const handleLevelChange = useCallback((row: SkillRowView, value: LevelValue) => {
    setSavedTip(false);
    setSaveError(null);
    setRestored((prev) => {
      if (!prev.has(row.key)) return prev;
      const next = new Set(prev);
      next.delete(row.key);
      return next;
    });
    if (row.isNew) {
      // 尚未保存的自定义技能：直接改/删本地草稿
      setEdits((prev) => {
        const next = { ...prev };
        delete next[row.key];
        return next;
      });
      setPendingCustom((prev) => {
        const next = { ...prev };
        if (value === 0) delete next[row.key];
        else next[row.key] = value;
        return next;
      });
      return;
    }
    setEdits((prev) => {
      const next = { ...prev };
      // 选回基线档位 = 没有改动
      if (value === bucketOf(row.baseLevel)) delete next[row.key];
      else next[row.key] = value;
      return next;
    });
  }, []);

  const handleRestore = useCallback((row: SkillRowView) => {
    setSavedTip(false);
    setSaveError(null);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[row.key];
      return next;
    });
    setRestored((prev) => new Set(prev).add(row.key));
  }, []);

  const handleAddCustom = useCallback(() => {
    const name = customName.trim().replace(/\s+/g, " ");
    if (!name) {
      setCustomError("请输入技能名称");
      return;
    }
    if (name.length > MAX_SKILL_NAME) {
      setCustomError(`技能名不超过 ${MAX_SKILL_NAME} 个字`);
      return;
    }
    const lower = name.toLowerCase();
    const existing = rows.find((r) => r.key.toLowerCase() === lower);
    if (existing) {
      // 已移除的行可以直接选回来
      if (existing.level === 0) {
        handleLevelChange(existing, customLevel);
        setCustomName("");
        setCustomError(null);
        return;
      }
      setCustomError(`「${name}」已在画像中，直接调整它的等级即可`);
      return;
    }
    setPendingCustom((prev) => ({ ...prev, [name]: customLevel }));
    setCustomName("");
    setCustomError(null);
    setSavedTip(false);
    setSaveError(null);
  }, [customName, customLevel, rows, handleLevelChange]);

  const handleRemoveSoft = useCallback((word: string) => {
    setSoftSkills((prev) => prev.filter((w) => w !== word));
    setSavedTip(false);
    setSaveError(null);
  }, []);

  const handleAddSoft = useCallback(() => {
    const word = softInput.trim();
    if (!word) return;
    setSoftSkills((prev) => (prev.includes(word) ? prev : [...prev, word]));
    setSoftInput("");
    setSavedTip(false);
    setSaveError(null);
  }, [softInput]);

  const handleSave = useCallback(async () => {
    // 1) 硬技能等级：本地改动 + 恢复默认（回写该 key 当前等级）
    const levels: Record<string, number> = {};
    for (const [key, value] of Object.entries(edits)) levels[key] = value;
    for (const key of restored) {
      if (levels[key] !== undefined) continue;
      const s = skills.find((x) => x.key === key);
      if (s && s.level > 0) levels[key] = bucketOf(s.level);
    }
    // 2) 自定义技能：新增的（值为 0 视为放弃新增，custom 不接受 0）
    const custom: Record<string, number> = {};
    for (const [key, level] of Object.entries(pendingCustom)) {
      const edit = edits[key];
      const value = edit !== undefined && edit !== 0 ? edit : level;
      if (value === 0) continue;
      custom[key] = value;
    }

    const body: ProfilePutBody = {};
    if (Object.keys(levels).length) body.levels = levels;
    if (Object.keys(custom).length) body.custom = custom;
    if (softChanged) body.softSkills = softSkills;

    if (Object.keys(body).length === 0) {
      setSaveError(null);
      setSavedTip(true);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as ProfileErrorResponse | null;
        throw new Error(data?.error ?? `保存失败（${res.status}）`);
      }
      // 成功后就地把服务端真相写回本地
      setSkills((prev) => {
        const out = prev.map((s) => {
          if (restored.has(s.key)) {
            return { ...s, level: bucketOf(s.level), isOverridden: false };
          }
          const edit = edits[s.key];
          if (edit === undefined) return s;
          return { ...s, level: edit, isOverridden: !s.isCustom };
        });
        for (const key of Object.keys(custom)) {
          if (out.some((s) => s.key === key)) continue;
          out.push({ key, level: custom[key], isCustom: true, isOverridden: false });
        }
        return out;
      });
      setBaseSoftSkills([...softSkills]);
      setEdits({});
      setRestored(new Set());
      setPendingCustom({});
      setSavedTip(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [edits, restored, skills, pendingCustom, softChanged, softSkills]);

  const disabled = loading || saving;

  return (
    <div className="flex flex-col gap-6 pb-2">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-100">设置</h1>
        <p className="mt-1 text-sm text-neutral-500">技能画像编辑器</p>
      </header>

      <p className="panel px-3 py-2 text-xs leading-5 text-neutral-400">
        技能画像是匹配度的打分基础。接单快通道要求核心硬技能命中你的画像。
      </p>

      {loadError && <p className="alert alert-danger">{loadError}</p>}

      {/* 技能 */}
      <section className="panel overflow-hidden">
        <div className="panel-header">
          <h2 className="section-title">技能</h2>
          <span className="num text-xs text-neutral-500">{rows.length} 项</span>
        </div>

        {loading ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-500">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-500">
            画像为空，可在下方添加自定义技能。
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {rows.map((row) => {
              const removed = row.level === 0;
              const canRestore = row.isOverridden && !row.isCustom && row.baseLevel > 0;
              return (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 transition-colors hover:bg-neutral-900/60"
                >
                  <div className="flex min-w-32 flex-1 flex-wrap items-center gap-1.5">
                    <span
                      className={`text-sm ${
                        removed ? "text-neutral-600 line-through" : "text-neutral-200"
                      }`}
                    >
                      {row.key}
                    </span>
                    {row.isCustom && (
                      <span className="badge border-indigo-900 bg-indigo-950/60 text-indigo-300">
                        自定义
                      </span>
                    )}
                    {row.isOverridden && (
                      <span className="badge border-amber-900 bg-amber-950/50 text-amber-300">
                        已改
                      </span>
                    )}
                    {row.isNew && (
                      <span className="badge border-sky-900 bg-sky-950/60 text-sky-300">新增</span>
                    )}
                    {row.pending && <span className="badge badge-neutral">未保存</span>}
                  </div>

                  <span className={`num w-12 shrink-0 text-right text-xs ${LEVEL_TEXT_CLASS[row.level]}`}>
                    {LEVEL_LABEL[row.level]}
                  </span>

                  <select
                    aria-label={`${row.key} 等级`}
                    value={String(row.level)}
                    disabled={disabled}
                    onChange={(e) => handleLevelChange(row, parseLevelValue(e.target.value))}
                    className={SELECT_CLASS}
                  >
                    {LEVEL_OPTIONS.map((o) => (
                      <option key={o.value} value={String(o.value)}>
                        {o.label}
                      </option>
                    ))}
                  </select>

                  {canRestore && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleRestore(row)}
                      title="撤销改动，回到当前画像等级"
                      className="btn"
                    >
                      恢复默认
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 自定义技能 */}
      <section className="panel">
        <div className="border-b border-hairline px-4 py-3">
          <h2 className="section-title">自定义技能</h2>
          <p className="mt-1 text-xs text-neutral-500">
            默认词表里没有的技能，可自行添加（自由中文名）
          </p>
        </div>
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={customName}
              onChange={(e) => {
                setCustomName(e.target.value);
                if (customError) setCustomError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddCustom();
              }}
              maxLength={MAX_SKILL_NAME}
              placeholder="技能名称，如：音视频工程"
              className={INPUT_CLASS}
            />
            <select
              aria-label="自定义技能档位"
              value={String(customLevel)}
              onChange={(e) => setCustomLevel(parseLevelValue(e.target.value))}
              className={SELECT_CLASS}
            >
              {CUSTOM_LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAddCustom}
              disabled={loading}
              className="btn btn-solid px-3"
            >
              添加
            </button>
          </div>
          {customError && <p className="mt-2 text-xs text-red-400">{customError}</p>}
          {Object.keys(pendingCustom).length > 0 && (
            <p className="mt-2 text-xs text-neutral-500">
              待保存：{Object.keys(pendingCustom).join("、")}
            </p>
          )}
        </div>
      </section>

      {/* 软技能 */}
      <section className="panel">
        <div className="border-b border-hairline px-4 py-3">
          <h2 className="section-title">软技能（不参与匹配）</h2>
          <p className="mt-1 text-xs text-neutral-500">只作展示与描述，不计入匹配度分母</p>
        </div>
        <div className="px-4 py-3">
          {softSkills.length === 0 ? (
            <p className="text-xs text-neutral-500">暂无软技能</p>
          ) : (
            <ul className="mb-3 flex flex-wrap gap-2">
              {softSkills.map((word) => (
                <li key={word} className="chip">
                  {word}
                  <button
                    type="button"
                    aria-label={`删除 ${word}`}
                    onClick={() => handleRemoveSoft(word)}
                    className="text-neutral-500 transition-colors hover:text-red-400"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <input
              value={softInput}
              onChange={(e) => setSoftInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddSoft();
              }}
              placeholder="添加软技能，如：网感"
              className={INPUT_CLASS}
            />
            <button
              type="button"
              onClick={handleAddSoft}
              className="btn btn-solid px-3"
            >
              添加
            </button>
          </div>
        </div>
      </section>

      {saveError && <p className="alert alert-danger">{saveError}</p>}

      {/* 吸底操作条 */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-2 border-t border-hairline bg-canvas/95 px-4 py-3 backdrop-blur">
        {savedTip && (
          <p className="alert alert-success mb-2 flex items-start gap-2">
            <span className="flex-1">已保存。对已录入的信息点「重新分析」后按新画像生效</span>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => setSavedTip(false)}
              className="shrink-0 text-emerald-500 transition-colors hover:text-emerald-300"
            >
              ×
            </button>
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="num text-xs text-neutral-500">
            {changeCount > 0 ? `${changeCount} 项改动待保存` : "暂无改动"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void handleSave()}
            className="btn btn-primary"
          >
            {saving ? "保存中…" : "保存修改"}
          </button>
        </div>
      </div>
    </div>
  );
}
