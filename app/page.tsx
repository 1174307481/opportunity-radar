"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { sourceLabel } from "@/lib/source-label";

/** ---------- 接口定义 ---------- */

interface FirstStep {
  time_box: string;
  action: string;
  object: string;
  channel: string;
  quantity: string;
  completion_rule: string;
  copyable_first_message: string;
}

interface TodayItem {
  opportunityId: number;
  itemId: number;
  title: string;
  url: string | null;
  type: string;
  score: number | null;
  skillMatch: number | null;
  fastTrack: boolean;
  status: string;
  verdict: string;
  firstStep: FirstStep | null;
  sourceType: string;
}

interface WeekItem {
  opportunityId: number;
  itemId: number;
  title: string;
  type: string;
  score: number | null;
  skillMatch: number | null;
  status: string;
  sourceType: string;
}

interface Counts {
  today: number;
  week: number;
  archived: number;
  items: number;
}

interface RecentItem {
  id: number;
  title: string;
  aiStage: string;
  foundAt: number;
}

interface KpiDay {
  date: string;
  count: number;
}

/** 行动账本聚合（GET /api/dashboard 的 kpi 字段） */
interface Kpi {
  weekActions: number;
  daysSinceLastAction: number | null;
  last7Days: KpiDay[];
}

interface DashboardData {
  today: TodayItem[];
  week: WeekItem[];
  counts: Counts;
  recentItems: RecentItem[];
  kpi: Kpi | null;
}

/** GET /api/items/{id} —— 轮询单条分析进度 */
interface ItemStatus {
  id: number;
  title: string;
  aiStage: string;
  errorMessage: string | null;
  opportunityId: number | null;
  tier: string | null;
}

/** POST /api/items 响应 */
interface SubmitResponse {
  id?: number;
  title?: string;
  duplicated?: boolean;
  error?: string;
}

/** GET /api/today-focus 响应 */
interface FocusRecord {
  date: string;
  opportunityId: number;
  done: boolean;
  title: string;
}

interface DueFollowUp {
  ledgerId: number;
  opportunityId: number;
  title: string;
  note: string;
  followUpAt: number;
}

interface TodayFocusData {
  focus: FocusRecord | null;
  dueFollowUps: DueFollowUp[];
}

/** POST /api/ledger 响应 */
interface LedgerCreateResponse {
  id?: number;
  error?: string;
}

/** GET /api/sources 响应 */
interface SourceRow {
  id: number;
  key: string;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  lastRunAt: number | null;
  lastStatus: string;
  lastMessage: string;
  createdAt: number;
}

interface SourcesResponse {
  sources: SourceRow[];
}

type Notice = { kind: "info" | "error"; text: string };

/** 卡片内的即时提示（只在该机会卡片下显示） */
type CardNotice = Notice & { opportunityId: number };

const POLL_INTERVAL_MS = 2500;
const TERMINAL_STAGES = ["ready", "archived", "failed"];

/** 发出话术后 3 天跟进（模块级，避免渲染期直接调用 Date.now） */
function followUpAtIn3Days(): number {
  return Date.now() + 3 * 86400e3;
}

/** 相对时间：now - lastRunAt，用于数据源最近采集时间展示 */
function formatRelativeTime(ms: number | null): string {
  if (ms === null) return "未运行";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ms).toLocaleDateString();
}

export default function HomePage() {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [pollItemId, setPollItemId] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ itemId: number; message: string } | null>(
    null
  );
  const [reanalyzing, setReanalyzing] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  /** 「已发出，记一笔」状态 */
  const [ledgerBusyId, setLedgerBusyId] = useState<number | null>(null);
  const [cardNotice, setCardNotice] = useState<CardNotice | null>(null);

  /** 今天做这一件事 + 到期跟进 */
  const [focusData, setFocusData] = useState<TodayFocusData | null>(null);
  const [focusBusy, setFocusBusy] = useState(false);

  /** 📡 数据源状态 */
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [sourcesUnavailable, setSourcesUnavailable] = useState(false);
  const [toggleBusyKey, setToggleBusyKey] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  /** ---------- 数据加载 ---------- */

  const loadFocus = useCallback(async () => {
    try {
      const res = await fetch("/api/today-focus", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TodayFocusData;
      setFocusData({ focus: data.focus, dueFollowUps: data.dueFollowUps ?? [] });
    } catch {
      // 焦点区失败不打扰首页主流程
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardData;
      setDashboard(data);
      setDashboardError(null);
    } catch (e) {
      setDashboardError((e as Error).message || "加载失败");
    }
    // focus 依赖 today 数据：dashboard 刷新后同步重取
    void loadFocus();
  }, [loadFocus]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  /** 📡 数据源：挂载时拉取一次，失败静默 */
  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SourcesResponse;
      setSources(data.sources ?? []);
      setSourcesUnavailable(false);
    } catch {
      setSourcesUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  /** ---------- 轮询分析进度 ---------- */

  useEffect(() => {
    if (pollItemId === null) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 60; // 60 × 2.5s ≈ 2.5 分钟，防止队列积压时永久轮询

    const tick = async () => {
      try {
        attempts++;
        if (attempts > MAX_ATTEMPTS) {
          if (!cancelled) {
            setPollItemId(null);
            setStage("仍在分析中，稍后到信息库查看结果");
          }
          return;
        }
        const res = await fetch(`/api/items/${pollItemId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ItemStatus;
        if (cancelled) return;
        setStage(data.aiStage);

        if (!TERMINAL_STAGES.includes(data.aiStage)) return;

        // 终态：停止轮询并刷新首页
        setPollItemId(null);
        void loadDashboard();

        if (data.aiStage === "failed") {
          setFailed({
            itemId: pollItemId,
            message: data.errorMessage || "分析失败，请重试",
          });
        }
      } catch {
        // 网络抖动：忽略，等下一次 tick
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollItemId, loadDashboard]);

  /** ---------- 快速录入（支持空行分隔的批量粘贴，如闲鱼多个宝贝） ---------- */

  const submitOne = async (
    text: string
  ): Promise<SubmitResponse | null> => {
    // 单行且以 http(s):// 开头 → url，其余走 text
    const isUrl = /^https?:\/\//i.test(text) && text.split("\n").length === 1;
    const res = await fetch("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: isUrl ? "url" : "text", content: text }),
    });
    return (await res.json().catch(() => null)) as SubmitResponse | null;
  };

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setNotice(null);
    try {
      const chunks = trimmed
        .split(/\n\s*\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (chunks.length <= 1) {
        const data = await submitOne(trimmed);
        if (data?.duplicated) {
          setNotice({ kind: "info", text: "该信息已在库中" });
          void loadDashboard();
        } else if (data?.error) {
          setNotice({ kind: "error", text: data.error });
        } else if (typeof data?.id === "number") {
          setContent("");
          setFailed(null);
          setStage("pending");
          setNotice({ kind: "info", text: "已投入雷达，分析中…" });
          setPollItemId(data.id);
          void loadDashboard();
        } else {
          setNotice({ kind: "error", text: "提交失败，请重试" });
        }
      } else {
        let added = 0;
        let duplicated = 0;
        let lastId: number | null = null;
        let lastError = "";
        for (const chunk of chunks) {
          const data = await submitOne(chunk);
          if (data?.duplicated) duplicated++;
          else if (typeof data?.id === "number") {
            added++;
            lastId = data.id;
          } else {
            lastError = data?.error || "部分提交失败";
          }
        }
        if (added > 0) {
          setContent("");
          setFailed(null);
          setStage("pending");
          setNotice({
            kind: "info",
            text: `已投入 ${added} 条${
              duplicated ? `，跳过重复 ${duplicated} 条` : ""
            }${lastError ? `；${lastError}` : ""}，分析中…`,
          });
          if (lastId !== null) setPollItemId(lastId);
          void loadDashboard();
        } else {
          setNotice({ kind: "error", text: lastError || "提交失败，请重试" });
        }
      }
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message || "提交失败" });
    } finally {
      setSubmitting(false);
    }
  };

  /** ---------- 重新分析 ---------- */

  const handleReanalyze = async (itemId: number) => {
    if (reanalyzing) return;
    setReanalyzing(true);
    try {
      const res = await fetch(`/api/items/${itemId}/reanalyze`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFailed(null);
      setStage("pending");
      setNotice({ kind: "info", text: "重新分析中…" });
      setPollItemId(itemId);
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message || "重新分析失败" });
    } finally {
      setReanalyzing(false);
    }
  };

  /** ---------- 复制话术 ---------- */

  const handleCopy = async (key: string, text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2000);
    } catch {
      setNotice({ kind: "error", text: "复制失败，请手动选择文本" });
    }
  };

  /** ---------- 行动账本：已发出，记一笔 ---------- */

  const handleLogSent = async (opportunityId: number) => {
    if (ledgerBusyId !== null) return;
    setLedgerBusyId(opportunityId);
    setCardNotice(null);
    try {
      // 1. 记一笔行动（3 天后跟进）
      const res = await fetch("/api/ledger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityId,
          note: "已发送联系话术",
          followUpAt: followUpAtIn3Days(),
        }),
      });
      const data = (await res.json().catch(() => null)) as LedgerCreateResponse | null;
      if (!res.ok || typeof data?.id !== "number") {
        throw new Error(data?.error || `记账失败（${res.status}）`);
      }

      // 2. 机会状态推进到「已联系」
      const patch = await fetch(`/api/opportunities/${opportunityId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "contacted" }),
      });
      if (!patch.ok) {
        const body = (await patch.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error || `状态更新失败（${patch.status}）`);
      }

      setCardNotice({
        kind: "info",
        text: "已记一笔，状态推进到「已联系」",
        opportunityId,
      });
      await loadDashboard();
    } catch (e) {
      setCardNotice({
        kind: "error",
        text: (e as Error).message || "操作失败",
        opportunityId,
      });
    } finally {
      setLedgerBusyId(null);
    }
  };

  /** ---------- 今天做这一件事 ---------- */

  const handleSetFocus = async (opportunityId: number) => {
    if (focusBusy) return;
    setFocusBusy(true);
    try {
      const res = await fetch("/api/today-focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunityId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadFocus();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message || "设置失败" });
    } finally {
      setFocusBusy(false);
    }
  };

  const handleCompleteFocus = async () => {
    if (focusBusy) return;
    setFocusBusy(true);
    try {
      const res = await fetch("/api/today-focus", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadFocus();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message || "操作失败" });
    } finally {
      setFocusBusy(false);
    }
  };

  const handleLedgerFollowUpDone = async (ledgerId: number) => {
    if (focusBusy) return;
    setFocusBusy(true);
    try {
      const res = await fetch(`/api/ledger/${ledgerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadFocus();
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message || "操作失败" });
    } finally {
      setFocusBusy(false);
    }
  };

  /** ---------- 数据源开关 ---------- */

  const handleToggleSource = async (row: SourceRow) => {
    if (toggleBusyKey !== null) return;
    setToggleBusyKey(row.key);
    setToggleError(null);
    try {
      const next = !row.enabled;
      const res = await fetch("/api/sources", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: row.key, enabled: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      // 局部更新该行
      setSources((prev) =>
        prev
          ? prev.map((s) => (s.key === row.key ? { ...s, enabled: next } : s))
          : prev
      );
    } catch (e) {
      setToggleError((e as Error).message || "操作失败");
    } finally {
      setToggleBusyKey(null);
    }
  };

  /** ---------- 渲染 ---------- */

  const today = dashboard?.today ?? [];
  const week = dashboard?.week ?? [];
  const counts = dashboard?.counts ?? null;
  const kpi = dashboard?.kpi ?? null;
  const polling = pollItemId !== null;
  const focus = focusData?.focus ?? null;
  const dueFollowUps = focusData?.dueFollowUps ?? [];

  /** 连续 3 天无行动 → 顶部变红（沉默惩罚） */
  const silent =
    kpi !== null &&
    kpi.daysSinceLastAction !== null &&
    kpi.daysSinceLastAction >= 3;
  const lastActionText =
    kpi === null || kpi.daysSinceLastAction === null
      ? "还没有记录"
      : kpi.daysSinceLastAction === 0
        ? "今天"
        : `${kpi.daysSinceLastAction} 天前`;
  const kpiMaxCount = kpi
    ? Math.max(1, ...kpi.last7Days.map((d) => d.count))
    : 1;

  return (
    <div className="flex flex-col gap-8">
      {/* 📈 行动账本（唯一 KPI） */}
      <section
        className={`rounded-xl border px-4 py-3 ${
          silent
            ? "border-red-800 bg-red-950/30"
            : "border-neutral-800 bg-neutral-900"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2
              className={`text-sm font-semibold ${
                silent ? "text-red-400" : "text-neutral-300"
              }`}
            >
              📈 行动账本
            </h2>
            {kpi ? (
              <p
                className={`text-sm ${silent ? "text-red-300" : "text-neutral-400"}`}
              >
                本周行动{" "}
                <span
                  className={`text-base font-semibold tabular-nums ${
                    silent ? "text-red-200" : "text-neutral-100"
                  }`}
                >
                  {kpi.weekActions}
                </span>{" "}
                次 · 最近行动{" "}
                <span className="tabular-nums">{lastActionText}</span>
              </p>
            ) : (
              <p className="text-sm text-neutral-500">载入中…</p>
            )}
          </div>

          {/* 近 7 天迷你柱状图 */}
          {kpi ? (
            <div className="flex items-center gap-3">
              <div className="flex h-8 items-end gap-1">
                {kpi.last7Days.map((d) => {
                  const pct =
                    d.count === 0
                      ? 15
                      : 30 + Math.round((d.count / kpiMaxCount) * 70);
                  return (
                    <div
                      key={d.date}
                      title={`${d.date} · ${d.count} 次`}
                      className={`w-1.5 rounded-sm ${
                        silent ? "bg-red-500/70" : "bg-emerald-500/70"
                      }`}
                      style={{ height: `${pct}%` }}
                    />
                  );
                })}
              </div>
              <Link
                href="/actions"
                className={`text-xs underline-offset-2 hover:underline ${
                  silent ? "text-red-300" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                记一笔 →
              </Link>
            </div>
          ) : null}
        </div>

        {silent && kpi ? (
          <p className="mt-2 text-sm font-medium text-red-400">
            已经 {kpi.daysSinceLastAction} 天没行动了，今天动一动
          </p>
        ) : null}
      </section>

      {/* 🎯 今天做这一件事 */}
      {focus ? (
        focus.done ? (
          <section className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-5 py-6 text-center">
            <p className="text-base font-medium text-emerald-300">
              ✅ 今日事今日毕。别的机会明天再说。
            </p>
          </section>
        ) : (
          <section className="rounded-xl border-2 border-red-800 bg-red-950/30 p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-red-400">
              🎯 今天做这一件事
            </h2>
            <Link
              href={`/opportunities/${focus.opportunityId}`}
              className="mt-3 block text-xl font-semibold text-neutral-50 hover:underline"
            >
              {focus.title || "（无标题）"}
            </Link>
            <button
              type="button"
              onClick={() => void handleCompleteFocus()}
              disabled={focusBusy}
              className="mt-4 rounded-lg border border-emerald-800 bg-emerald-950/70 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-900/70 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {focusBusy ? "处理中…" : "标记完成"}
            </button>
          </section>
        )
      ) : today.length > 0 ? (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-400">
            🎯 今天做这一件事
          </h2>
          <p className="mt-2 text-sm text-neutral-400">
            从今天的 {today.length} 条机会里挑一件，只做这一件。
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {today.map((item) => (
              <li
                key={`focus-pick-${item.opportunityId}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2"
              >
                <Link
                  href={`/opportunities/${item.opportunityId}`}
                  className="min-w-0 truncate text-sm text-neutral-300 hover:underline"
                >
                  {item.title || "（无标题）"}
                </Link>
                <button
                  type="button"
                  onClick={() => void handleSetFocus(item.opportunityId)}
                  disabled={focusBusy}
                  className="shrink-0 rounded-md border border-red-900 bg-red-950/60 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  就做它
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ⏰ 到期跟进 */}
      {dueFollowUps.length > 0 ? (
        <section className="rounded-xl border border-amber-900/60 bg-amber-950/20 px-4 py-3">
          <h2 className="mb-2 text-sm font-semibold text-amber-400">⏰ 到期跟进</h2>
          <ul className="flex flex-col divide-y divide-amber-900/30">
            {dueFollowUps.map((d) => (
              <li
                key={`due-${d.ledgerId}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <Link
                    href={`/opportunities/${d.opportunityId}`}
                    className="truncate text-sm text-neutral-200 hover:underline"
                  >
                    {d.title || "（无标题）"}
                  </Link>
                  {d.note ? (
                    <span className="truncate text-xs text-neutral-500">
                      {d.note}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void handleLedgerFollowUpDone(d.ledgerId)}
                  disabled={focusBusy}
                  className="shrink-0 rounded-md border border-emerald-900 bg-emerald-950/60 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  已跟进
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 快速录入 */}
      <section>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          rows={4}
          placeholder="粘贴链接、需求原文，或闲鱼/群里的机会文案（空行分隔可批量）…"
          className="w-full resize-y rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || content.trim().length === 0}
            className="rounded-lg border border-red-900 bg-red-950/60 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "提交中…" : "投入雷达"}
          </button>
          <span className="text-xs text-neutral-600">
            ⌘/Ctrl + Enter 快捷提交 · 闲鱼/群里的机会：标题+价格+描述整段贴进来
          </span>
        </div>

        {notice ? (
          <p
            className={`mt-3 text-sm ${
              notice.kind === "error" ? "text-red-400" : "text-neutral-400"
            }`}
          >
            {notice.text}
          </p>
        ) : null}

        {polling ? (
          <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm">
            <span className="inline-flex items-center gap-2 text-neutral-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              {stage === "l1_done" ? "已通过初筛，深分析中" : "分析中…"}
            </span>
          </div>
        ) : null}

        {failed ? (
          <div className="mt-3 rounded-lg border border-red-900/70 bg-red-950/30 px-4 py-3">
            <p className="text-sm text-red-400">分析失败：{failed.message}</p>
            <button
              type="button"
              onClick={() => void handleReanalyze(failed.itemId)}
              disabled={reanalyzing}
              className="mt-2 rounded-md border border-red-900 bg-red-950/60 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {reanalyzing ? "提交中…" : "重新分析"}
            </button>
          </div>
        ) : null}
      </section>

      {/* 顶部统计 */}
      <p className="text-xs text-neutral-500">
        {counts
          ? `库中 ${counts.items} 条 · 🟡本周 ${counts.week} · ⚪归档 ${counts.archived}`
          : "载入中…"}
      </p>

      {dashboardError ? (
        <p className="text-sm text-red-400">数据加载失败：{dashboardError}</p>
      ) : null}

      {/* 🔴 今天看 */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-400">
          🔴 今天看
        </h2>

        {today.length === 0 ? (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 px-6 py-16 text-center">
            <p className="text-xl font-semibold text-neutral-200">
              今天没有值得看的机会
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              没有新信号就不硬塞。去录入一条，或者去干正事。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {today.map((item) => {
              const key = `today-${item.opportunityId}`;
              const fs = item.firstStep;
              return (
                <li
                  key={key}
                  className="rounded-xl border border-neutral-800 bg-neutral-900 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/opportunities/${item.opportunityId}`}
                        className="text-base font-medium text-neutral-100 hover:underline"
                      >
                        {item.title || "（无标题）"}
                      </Link>
                      <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400">
                        {item.type}
                      </span>
                      <span
                        title={`来源：${sourceLabel(item.sourceType)}`}
                        className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-500"
                      >
                        {sourceLabel(item.sourceType)}
                      </span>
                      {item.fastTrack ? (
                        <span
                          title="快通道：预算明确+核心技能命中，先验证真身再谈开工"
                          className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-400"
                        >
                          ⚡ 接单·待验真
                        </span>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-xs text-neutral-500">
                      匹配{" "}
                      <span className="text-neutral-300">
                        {item.skillMatch != null ? `${item.skillMatch}%` : "—"}
                      </span>
                    </div>
                  </div>

                  {item.verdict ? (
                    <p className="mt-2 text-sm text-neutral-300">{item.verdict}</p>
                  ) : null}

                  {fs ? (
                    <>
                      <p className="mt-2 text-sm text-neutral-400">
                        ⏱ {fs.time_box} · {fs.action}
                        {fs.channel ? ` · ${fs.channel}` : ""}
                      </p>
                    </>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {fs?.copyable_first_message ? (
                      <button
                        type="button"
                        onClick={() =>
                          void handleCopy(key, fs.copyable_first_message)
                        }
                        className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
                      >
                        {copiedKey === key ? "已复制 ✓" : "复制话术"}
                      </button>
                    ) : null}

                    {item.status === "contacted" || item.status === "deal" ? (
                      <span className="cursor-default rounded-md border border-emerald-900 bg-emerald-950/50 px-3 py-1.5 text-xs font-medium text-emerald-400 opacity-70">
                        ✓ 已记 · 已联系
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleLogSent(item.opportunityId)}
                        disabled={ledgerBusyId !== null}
                        className="rounded-md border border-emerald-900 bg-emerald-950/60 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {ledgerBusyId === item.opportunityId
                          ? "记账中…"
                          : "📨 已发出，记一笔"}
                      </button>
                    )}
                  </div>

                  {cardNotice?.opportunityId === item.opportunityId ? (
                    <p
                      className={`mt-2 text-xs ${
                        cardNotice.kind === "error"
                          ? "text-red-400"
                          : "text-emerald-400"
                      }`}
                    >
                      {cardNotice.text}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 🟡 本周看 */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-400">🟡 本周看</h2>
        {week.length === 0 ? (
          <p className="text-sm text-neutral-600">本周暂无。</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-xl border border-neutral-800 bg-neutral-900">
            {week.map((item) => (
              <li
                key={`week-${item.opportunityId}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Link
                    href={`/opportunities/${item.opportunityId}`}
                    className="truncate text-sm text-neutral-300 hover:underline"
                  >
                    {item.title || "（无标题）"}
                  </Link>
                  <span className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-500">
                    {item.type}
                  </span>
                  <span className="shrink-0 text-[11px] text-neutral-600">
                    {sourceLabel(item.sourceType)}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-neutral-500">
                  {item.score ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 📡 数据源 */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-neutral-400">📡 数据源</h2>
          <span className="text-xs text-neutral-600">
            每小时 13/43 分自动采集
          </span>
        </div>

        {sourcesUnavailable ? (
          <p className="text-xs text-neutral-600">数据源状态不可用</p>
        ) : sources === null ? (
          <p className="text-xs text-neutral-600">载入中…</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-neutral-800">
              {sources.map((row) => {
                const dot = row.enabled
                  ? row.lastStatus === "ok"
                    ? "bg-emerald-500"
                    : "bg-red-500"
                  : "bg-neutral-600";
                const busy = toggleBusyKey === row.key;
                return (
                  <li
                    key={row.key}
                    className={`flex items-center gap-3 py-2.5 ${
                      !row.enabled ? "opacity-50" : ""
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${dot}`}
                    />
                    <span className="shrink-0 text-sm text-neutral-300">
                      {row.label}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {formatRelativeTime(row.lastRunAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
                      {row.lastMessage}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleToggleSource(row)}
                      disabled={busy}
                      className="shrink-0 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy ? "处理中…" : row.enabled ? "停用" : "启用"}
                    </button>
                  </li>
                );
              })}
            </ul>

            {toggleError ? (
              <p className="mt-2 text-xs text-red-400">{toggleError}</p>
            ) : null}

            {/* 手动录入通道 */}
            <ul className="mt-3 flex flex-col gap-1.5 border-t border-neutral-800 pt-3">
              <li className="flex items-center gap-3 text-xs text-neutral-500">
                <span className="h-2 w-2 shrink-0 rounded-full bg-violet-500" />
                <span>粘贴录入 · 首页输入框，空行分隔可批量</span>
              </li>
              <li className="flex items-center gap-3 text-xs text-neutral-500">
                <span className="h-2 w-2 shrink-0 rounded-full bg-violet-500" />
                <span>
                  闲鱼/BOSS 快录 · Tampermonkey 脚本，单条一键投递（合规：不爬取）
                </span>
              </li>
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
