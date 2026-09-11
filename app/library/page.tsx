"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

/** 后端 /api/items?query= 返回的行 */
interface LibraryItem {
  id: number;
  title: string;
  url: string | null;
  sourceType: SourceType | string;
  aiStage: AiStage | string;
  errorMessage: string | null;
  foundAt: number;
  /** 关联机会 id，未生成机会时为 null */
  oppId: number | null;
  type: string | null;
  tier: Tier | string | null;
  score: number | null;
  skillMatch: number | null;
  status: string | null;
}

type SourceType = "manual_text" | "manual_url";
type AiStage = "pending" | "l1_done" | "ready" | "archived" | "failed";
type Tier = "today" | "week" | "archived" | "observe";

interface ItemsResponse {
  items: LibraryItem[];
}

interface StageMeta {
  label: string;
  className: string;
  spin?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  manual_text: "粘贴",
  manual_url: "URL",
};

const STAGE_META: Record<string, StageMeta> = {
  pending: {
    label: "分析中",
    className: "border-sky-900 bg-sky-950/60 text-sky-300",
    spin: true,
  },
  l1_done: {
    label: "深分析中",
    className: "border-indigo-900 bg-indigo-950/60 text-indigo-300",
    spin: true,
  },
  ready: {
    label: "完成",
    className: "border-emerald-900 bg-emerald-950/60 text-emerald-300",
  },
  archived: {
    label: "已归档",
    className: "border-neutral-800 bg-neutral-900 text-neutral-400",
  },
  failed: {
    label: "失败",
    className: "border-red-900 bg-red-950/60 text-red-300",
  },
};

const TIER_META: Record<string, { label: string; className: string }> = {
  today: {
    label: "🔴 今日",
    className: "border-red-900/70 bg-red-950/40 text-red-300",
  },
  week: {
    label: "🟡 本周",
    className: "border-amber-900/70 bg-amber-950/40 text-amber-300",
  },
  archived: {
    label: "⚪ 归档",
    className: "border-neutral-800 bg-neutral-900 text-neutral-400",
  },
  observe: {
    label: "👁 观察",
    className: "border-violet-900/70 bg-violet-950/40 text-violet-300",
  },
};

function Spinner() {
  return (
    <svg className="size-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

export default function LibraryPage() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 请求序号，避免慢请求覆盖新结果 */
  const reqSeq = useRef(0);
  /** 待清理的刷新定时器（重新分析后 2.5s 拉取） */
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** 本地标记为「分析中」的行，合并进列表展示 */
  const [localPending, setLocalPending] = useState<Record<number, true>>({});

  const fetchItems = useCallback(async (keyword: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const search = keyword.trim() ? `?query=${encodeURIComponent(keyword.trim())}` : "";
      const res = await fetch(`/api/items${search}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const data = (await res.json()) as ItemsResponse;
      if (seq !== reqSeq.current) return;
      setItems(Array.isArray(data.items) ? data.items : []);
      setError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  // 搜索防抖：输入停止 400ms 后带 query 重新请求
  useEffect(() => {
    const t = setTimeout(() => {
      void fetchItems(query);
    }, 400);
    return () => clearTimeout(t);
  }, [query, fetchItems]);

  // 卸载时清掉挂起的刷新定时器
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
    };
  }, []);

  const handleReanalyze = useCallback(
    async (id: number) => {
      setLocalPending((prev) => ({ ...prev, [id]: true }));
      try {
        const res = await fetch(`/api/items/${id}/reanalyze`, { method: "POST" });
        if (!res.ok) throw new Error(`重新分析失败（${res.status}）`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "重新分析失败");
      }
      // 简单起见：2.5s 后整体刷新一次
      const t = setTimeout(() => {
        setLocalPending((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        void fetchItems(query);
      }, 2500);
      timers.current.push(t);
    },
    [fetchItems, query]
  );

  return (
    <main className="flex w-full flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-100">信息库</h1>
        <p className="mt-1 text-sm text-neutral-500">所有录入过的原始信息与处理状态</p>
      </header>

      <div className="flex flex-col gap-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索标题、档位或处理状态…"
          className="field"
        />

        {error && <p className="alert alert-danger">{error}</p>}

        {items.length === 0 && !loading ? (
          <div className="panel px-4 py-12 text-center text-sm text-neutral-500">
            还没有录入任何信息。回首页粘贴一条试试。
          </div>
        ) : (
          <ul className="list">
            {items.map((item) => {
              const stage: StageMeta = STAGE_META[item.aiStage] ?? {
                label: item.aiStage,
                className: "badge-neutral",
              };
              const pending = localPending[item.id] === true;
              const stageLabel = pending ? "分析中" : stage.label;
              const stageClass = pending ? STAGE_META.pending.className : stage.className;
              const spinning = pending || stage.spin === true;
              const tier = item.tier ? TIER_META[item.tier] : undefined;
              const canViewAnalysis = item.oppId != null && item.aiStage === "ready";
              const isToday = item.tier === "today";

              return (
                <li
                  key={item.id}
                  className={`flex flex-col gap-2 bg-neutral-950/40 px-3 py-3 transition-colors hover:bg-neutral-900/70 sm:flex-row sm:items-center sm:gap-3 ${
                    isToday ? "shadow-[inset_2px_0_0_0_rgba(153,27,27,0.9)]" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      {item.oppId != null ? (
                        <Link
                          href={`/opportunities/${item.oppId}`}
                          className="line-clamp-2 text-sm font-medium text-neutral-100 underline-offset-2 transition-colors hover:text-sky-300 hover:underline"
                        >
                          {item.title || "（无标题）"}
                        </Link>
                      ) : (
                        <span className="line-clamp-2 text-sm font-medium text-neutral-300">
                          {item.title || "（无标题）"}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="badge badge-neutral">
                        {SOURCE_LABEL[item.sourceType] ?? item.sourceType}
                      </span>
                      <span className={`badge ${stageClass}`} title={item.errorMessage ?? undefined}>
                        {spinning && <Spinner />}
                        {stageLabel}
                      </span>
                      {tier && <span className={`badge ${tier.className}`}>{tier.label}</span>}
                      {item.type && <span className="badge badge-neutral">{item.type}</span>}
                      <span className="num text-[11px] text-neutral-600">
                        {formatTime(item.foundAt)}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                    <span
                      className="num w-14 text-right text-xs text-neutral-400"
                      title={item.skillMatch != null ? `技能匹配 ${item.skillMatch}` : undefined}
                    >
                      {item.score != null ? (
                        <>
                          <span className="text-sm font-semibold text-neutral-200">{item.score}</span>
                          <span className="text-neutral-600"> 分</span>
                        </>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </span>

                    {canViewAnalysis ? (
                      <Link href={`/opportunities/${item.oppId}`} className="btn">
                        查看分析
                      </Link>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => void handleReanalyze(item.id)}
                      disabled={pending}
                      className="btn"
                    >
                      重新分析
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
