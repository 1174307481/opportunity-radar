"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

/** ---------- 接口定义 ---------- */

type Tier = "today" | "week" | "archived" | "observe";
type Status = "new" | "researching" | "contacted" | "deal" | "ignored";
type TierFilter = Tier | "all";
type StatusFilter = Status | "all";

/** 后端 /api/opportunities 返回的行 */
interface Row {
  opportunityId: number;
  itemId: number;
  title: string;
  url: string | null;
  type: string;
  effectiveTier: string;
  userTier: string | null;
  score: number | null;
  skillMatch: number | null;
  fastTrack: boolean;
  status: string;
  createdAt: number;
}

interface ListResponse {
  items: Row[];
}

interface PatchBody {
  tier?: Tier;
  status?: Status;
}

/** ---------- 常量与元数据 ---------- */

interface Meta {
  label: string;
  className: string;
  activeClassName: string;
}

const TIER_META: Record<Tier, Meta> = {
  today: {
    label: "🔴 今天",
    className: "border-red-900/70 bg-red-950/40 text-red-300",
    activeClassName:
      "border-red-700 bg-red-900/70 text-red-100 shadow-[0_0_16px_-8px_rgba(239,68,68,0.7)]",
  },
  week: {
    label: "🟡 本周",
    className: "border-amber-900/70 bg-amber-950/40 text-amber-300",
    activeClassName: "border-amber-700 bg-amber-900/70 text-amber-100",
  },
  archived: {
    label: "⚪ 归档",
    className: "border-neutral-800 bg-neutral-900 text-neutral-400",
    activeClassName: "border-neutral-600 bg-neutral-800 text-neutral-100",
  },
  observe: {
    label: "👁 观察",
    className: "border-violet-900/70 bg-violet-950/40 text-violet-300",
    activeClassName: "border-violet-700 bg-violet-900/70 text-violet-100",
  },
};

const STATUS_META: Record<Status, string> = {
  new: "新",
  researching: "研究中",
  contacted: "已联系",
  deal: "已成交",
  ignored: "忽略",
};

const TIER_ORDER: Tier[] = ["today", "week", "archived", "observe"];
const STATUS_ORDER: Status[] = ["new", "researching", "contacted", "deal", "ignored"];

const TABS: { key: TierFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "today", label: TIER_META.today.label },
  { key: "week", label: TIER_META.week.label },
  { key: "archived", label: TIER_META.archived.label },
  { key: "observe", label: TIER_META.observe.label },
];

/** 共享表单控件样式（见 globals.css 的 .field） */
const SELECT = "field w-auto shrink-0 px-2 py-1 text-xs";

/** ---------- 工具函数 ---------- */

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

function isTier(value: string): value is Tier {
  return (
    value === "today" || value === "week" || value === "archived" || value === "observe"
  );
}

function isStatus(value: string): value is Status {
  return (
    value === "new" ||
    value === "researching" ||
    value === "contacted" ||
    value === "deal" ||
    value === "ignored"
  );
}

/**
 * 乐观更新一条行：改档写 userTier（effectiveTier 跟随），改状态写 status。
 * 若结果不再满足当前筛选条件，则把它移出列表（统计用的全量列表传 all/all 即可保留）。
 */
function updateList(
  list: Row[],
  opportunityId: number,
  patch: PatchBody,
  tierFilter: TierFilter,
  statusFilter: StatusFilter
): Row[] {
  const out: Row[] = [];
  for (const row of list) {
    if (row.opportunityId !== opportunityId) {
      out.push(row);
      continue;
    }
    const next: Row = {
      ...row,
      status: patch.status ?? row.status,
      userTier: patch.tier ?? row.userTier,
      effectiveTier: patch.tier ?? row.effectiveTier,
    };
    const tierOk = tierFilter === "all" || next.effectiveTier === tierFilter;
    const statusOk = statusFilter === "all" || next.status === statusFilter;
    if (tierOk && statusOk) out.push(next);
  }
  return out;
}

/** ---------- 页面 ---------- */

export default function OpportunitiesPage() {
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [queryInput, setQueryInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const [rows, setRows] = useState<Row[]>([]);
  /** 无筛选全量数据，仅用于顶部档位统计 */
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);

  /** 请求序号，避免慢请求覆盖新结果 */
  const listSeq = useRef(0);

  // 搜索防抖：停止输入 400ms 后才带上 query 请求
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(queryInput), 400);
    return () => clearTimeout(t);
  }, [queryInput]);

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tierFilter !== "all") params.set("tier", tierFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const keyword = debouncedQuery.trim();
      if (keyword) params.set("query", keyword);
      const qs = params.toString();

      const res = await fetch(`/api/opportunities${qs ? `?${qs}` : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const data = (await res.json()) as ListResponse;
      if (seq !== listSeq.current) return;
      setRows(Array.isArray(data.items) ? data.items : []);
      setError(null);
    } catch (e) {
      if (seq !== listSeq.current) return;
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (seq === listSeq.current) setLoading(false);
    }
  }, [tierFilter, statusFilter, debouncedQuery]);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/opportunities", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as ListResponse;
      setAllRows(Array.isArray(data.items) ? data.items : []);
    } catch {
      // 统计失败不阻塞主列表
    }
  }, []);

  // 筛选变化即重新请求（延到下一个 tick，避免渲染期级联更新）
  useEffect(() => {
    const t = setTimeout(() => void loadList(), 0);
    return () => clearTimeout(t);
  }, [loadList]);

  // 全量数据只在挂载时取一次，之后由乐观更新维护
  useEffect(() => {
    const t = setTimeout(() => void loadStats(), 0);
    return () => clearTimeout(t);
  }, [loadStats]);

  /** 行内快改：先本地乐观更新，失败则回拉服务端数据还原 */
  const handlePatch = useCallback(
    async (opportunityId: number, patch: PatchBody) => {
      setError(null);
      setSavingId(opportunityId);
      setRows((prev) => updateList(prev, opportunityId, patch, tierFilter, statusFilter));
      setAllRows((prev) => updateList(prev, opportunityId, patch, "all", "all"));
      try {
        const res = await fetch(`/api/opportunities/${opportunityId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `保存失败（${res.status}）`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "保存失败");
        void loadList();
        void loadStats();
      } finally {
        setSavingId(null);
      }
    },
    [tierFilter, statusFilter, loadList, loadStats]
  );

  /** 各档位数量：从全量数据 JS 统计（实际档位 = 用户档优先） */
  const counts = useMemo(() => {
    const base: Record<TierFilter, number> = {
      all: allRows.length,
      today: 0,
      week: 0,
      archived: 0,
      observe: 0,
    };
    for (const row of allRows) {
      if (isTier(row.effectiveTier)) base[row.effectiveTier] += 1;
    }
    return base;
  }, [allRows]);

  const tabClass = (key: TierFilter, active: boolean): string => {
    if (key === "all") {
      return active
        ? "border-neutral-600 bg-neutral-800 text-neutral-100"
        : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200";
    }
    const meta = TIER_META[key];
    return active ? meta.activeClassName : `${meta.className} hover:border-neutral-600`;
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-100">机会</h1>
        <p className="mt-1 text-sm text-neutral-500">全部机会总览，可直接改档位与状态</p>
      </header>

      {/* 1. 筛选行 */}
      <section className="panel p-3">
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((tab) => {
            const active = tierFilter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setTierFilter(tab.key)}
                aria-pressed={active}
                className={`btn ${tabClass(tab.key, active)}`}
              >
                {tab.label}
                <span className="num ml-0.5 text-neutral-500">{counts[tab.key]}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="按状态筛选"
            className={`${SELECT} sm:w-28`}
          >
            <option value="all">全部状态</option>
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {STATUS_META[status]}
              </option>
            ))}
          </select>

          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜索标题关键词…"
            className="field min-w-0 flex-1"
          />
        </div>
      </section>

      {error ? <p className="alert alert-danger">{error}</p> : null}

      {/* 2-3. 列表 + 行内快改 */}
      {loading && rows.length === 0 ? (
        <div className="panel px-4 py-12 text-center text-sm text-neutral-500">载入中…</div>
      ) : rows.length === 0 ? (
        <div className="panel px-4 py-12 text-center text-sm text-neutral-500">
          还没有机会。首页录入一条试试。
        </div>
      ) : (
        <ul className="list">
          {rows.map((row) => {
            const tier = isTier(row.effectiveTier) ? TIER_META[row.effectiveTier] : null;
            const status = isStatus(row.status) ? row.status : null;
            const saving = savingId === row.opportunityId;
            const isToday = row.effectiveTier === "today";
            return (
              <li
                key={row.opportunityId}
                className={`flex flex-col gap-2 bg-neutral-950/40 px-3 py-3 transition-colors hover:bg-neutral-900/70 lg:flex-row lg:items-center lg:gap-3 ${
                  isToday ? "shadow-[inset_2px_0_0_0_rgba(153,27,27,0.9)]" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/opportunities/${row.opportunityId}`}
                    className="line-clamp-2 text-sm font-medium text-neutral-100 underline-offset-2 transition-colors hover:text-sky-300 hover:underline"
                    title={row.url ?? undefined}
                  >
                    {row.title || "（无标题）"}
                  </Link>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="badge badge-neutral">{row.type}</span>
                    {tier ? (
                      <span className={`badge ${tier.className}`}>{tier.label}</span>
                    ) : (
                      <span className="badge badge-neutral">{row.effectiveTier}</span>
                    )}
                    {row.userTier ? (
                      <span className="badge border-violet-900/70 bg-violet-950/40 text-violet-300">
                        用户改档
                      </span>
                    ) : null}
                    {row.fastTrack ? (
                      <span className="badge border-red-900/70 bg-red-950/50 text-red-300">
                        ⚡ 接单·待验真
                      </span>
                    ) : null}
                    {status ? (
                      <span className="badge border-emerald-900/70 bg-emerald-950/40 text-emerald-300">
                        {STATUS_META[status]}
                      </span>
                    ) : (
                      <span className="badge badge-neutral">{row.status}</span>
                    )}
                    <span className="num text-[11px] text-neutral-600">
                      {formatTime(row.createdAt)}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <span className="num w-14 text-right text-xs text-neutral-400">
                    {row.score != null ? (
                      <>
                        <span className="text-sm font-semibold text-neutral-200">{row.score}</span>
                        <span className="text-neutral-600"> 分</span>
                      </>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </span>
                  <span className="num w-12 text-right text-xs text-sky-300">
                    {row.skillMatch != null ? `${row.skillMatch}%` : "—"}
                  </span>

                  <select
                    value={status ?? row.status}
                    disabled={saving}
                    onChange={(e) =>
                      void handlePatch(row.opportunityId, {
                        status: e.target.value as Status,
                      })
                    }
                    aria-label="改状态"
                    className={SELECT}
                  >
                    {status === null ? <option value={row.status}>{row.status}</option> : null}
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_META[s]}
                      </option>
                    ))}
                  </select>

                  <select
                    value={row.effectiveTier}
                    disabled={saving}
                    onChange={(e) =>
                      void handlePatch(row.opportunityId, {
                        tier: e.target.value as Tier,
                      })
                    }
                    aria-label="改档位"
                    className={SELECT}
                  >
                    {tier === null ? (
                      <option value={row.effectiveTier}>{row.effectiveTier}</option>
                    ) : null}
                    {TIER_ORDER.map((t) => (
                      <option key={t} value={t}>
                        {TIER_META[t].label}
                      </option>
                    ))}
                  </select>

                  {saving ? <span className="text-[11px] text-neutral-500">保存中…</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
