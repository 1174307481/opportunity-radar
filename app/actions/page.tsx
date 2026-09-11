"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

/** ---------- 接口类型 ---------- */

/** GET /api/items —— 取有 oppId 的条目作为机会下拉选项 */
interface ItemRow {
  id: number;
  title: string;
  oppId: number | null;
  tier: string | null;
}

interface OpportunityOption {
  opportunityId: number;
  title: string;
}

interface LedgerEntry {
  id: number;
  opportunityId: number;
  title: string;
  note: string;
  followUpAt: number | null;
  doneAt: number | null;
  createdAt: number;
}

interface DueFollowUp {
  ledgerId: number;
  opportunityId: number;
  title: string;
  note: string;
  followUpAt: number;
}

interface TodayFocusResponse {
  focus: unknown;
  dueFollowUps: DueFollowUp[];
}

type Notice = { kind: "info" | "error"; text: string };

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** 跟进/完成时间展示：MM-DD HH:mm */
function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export default function ActionsPage() {
  const [options, setOptions] = useState<OpportunityOption[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [dueFollowUps, setDueFollowUps] = useState<DueFollowUp[]>([]);
  const [loading, setLoading] = useState(true);

  const [opportunityId, setOpportunityId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [followUpInput, setFollowUpInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** 数据加载时刻，用于判断跟进是否到期（避免渲染期调用 Date.now） */
  const [nowTs, setNowTs] = useState(0);
  /** URL 预填：/actions?opportunityId=5 */
  const [prefillId, setPrefillId] = useState<number | null>(null);
  const prefillAppliedRef = useRef(false);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("opportunityId");
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) setPrefillId(n);
  }, []);

  /** ---------- 数据加载 ---------- */

  const loadEntries = useCallback(async () => {
    const res = await fetch("/api/ledger", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { entries: LedgerEntry[] };
    setEntries(data.entries);
    setNowTs(Date.now());
  }, []);

  const loadFocus = useCallback(async () => {
    const res = await fetch("/api/today-focus", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as TodayFocusResponse;
    setDueFollowUps(data.dueFollowUps);
  }, []);

  const loadOptions = useCallback(async () => {
    const res = await fetch("/api/items", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { items: ItemRow[] };
    const seen = new Set<number>();
    const opts: OpportunityOption[] = [];
    for (const it of data.items) {
      if (it.oppId === null || seen.has(it.oppId)) continue;
      seen.add(it.oppId);
      opts.push({ opportunityId: it.oppId, title: it.title || "（无标题）" });
    }
    setOptions(opts);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadEntries(), loadFocus(), loadOptions()]);
      setNotice(null);
    } catch (e) {
      setNotice({ kind: "error", text: `加载失败：${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, [loadEntries, loadFocus, loadOptions]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  /** 选项就绪后应用 URL 预填（只应用一次，之后照常手选） */
  useEffect(() => {
    if (prefillId === null || prefillAppliedRef.current) return;
    if (!options.some((o) => o.opportunityId === prefillId)) return;
    prefillAppliedRef.current = true;
    setOpportunityId(String(prefillId));
  }, [prefillId, options]);

  /** 按关键词过滤后的下拉选项 */
  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.title.toLowerCase().includes(q));
  }, [options, query]);

  /** ---------- 记一笔 ---------- */

  const handleSubmit = async () => {
    if (submitting) return;
    const oppId = Number(opportunityId);
    if (!Number.isFinite(oppId) || oppId <= 0) {
      setNotice({ kind: "error", text: "请先选择一条机会" });
      return;
    }
    if (!note.trim()) {
      setNotice({ kind: "error", text: "备注不能为空" });
      return;
    }

    let followUpAt: number | null = null;
    if (followUpInput) {
      const ts = new Date(followUpInput).getTime();
      if (!Number.isFinite(ts)) {
        setNotice({ kind: "error", text: "跟进时间不合法" });
        return;
      }
      followUpAt = ts;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/ledger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunityId: oppId, note: note.trim(), followUpAt }),
      });
      const data = (await res.json().catch(() => null)) as
        | { id?: number; error?: string }
        | null;
      if (!res.ok || typeof data?.id !== "number") {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setNote("");
      setFollowUpInput("");
      setQuery("");
      setNotice({ kind: "info", text: "已记下这一笔。" });
      await Promise.all([loadEntries(), loadFocus()]);
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message || "提交失败" });
    } finally {
      setSubmitting(false);
    }
  };

  /** ---------- 到期跟进操作 ---------- */

  const patchLedger = async (
    ledgerId: number,
    body: { done?: true; followUpAt?: number }
  ) => {
    if (busyId !== null) return;
    setBusyId(ledgerId);
    try {
      const res = await fetch(`/api/ledger/${ledgerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      await Promise.all([loadEntries(), loadFocus()]);
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message || "操作失败" });
    } finally {
      setBusyId(null);
    }
  };

  const handleDone = (ledgerId: number) => patchLedger(ledgerId, { done: true });
  const handleSnooze = (ledgerId: number) =>
    patchLedger(ledgerId, { followUpAt: Date.now() + THREE_DAYS_MS });

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-lg font-semibold text-neutral-100">行动账本</h1>

      {notice ? (
        <p
          className={`text-sm ${
            notice.kind === "error" ? "text-red-400" : "text-neutral-400"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {/* ➕ 记一笔 */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-300">➕ 记一笔</h2>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-neutral-500">机会</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索机会标题…"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
            <select
              value={opportunityId}
              onChange={(e) => setOpportunityId(e.target.value)}
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 focus:border-neutral-600 focus:outline-none"
            >
              <option value="">— 选择机会 —</option>
              {filteredOptions.map((o) => (
                <option key={o.opportunityId} value={o.opportunityId}>
                  #{o.opportunityId} · {o.title}
                </option>
              ))}
            </select>
            {options.length === 0 && !loading ? (
              <span className="text-xs text-neutral-600">
                还没有可关联的机会，先去首页录入。
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-neutral-500">备注</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="做了什么？例：发了话术、加了微信、报了价…"
              className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-neutral-500">跟进时间（可空）</label>
            <input
              type="datetime-local"
              value={followUpInput}
              onChange={(e) => setFollowUpInput(e.target.value)}
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 focus:border-neutral-600 focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="self-start rounded-lg border border-red-900 bg-red-950/60 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "提交中…" : "记下这一笔"}
          </button>
        </div>
      </section>

      {/* ⏰ 到期跟进 */}
      {dueFollowUps.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-amber-400">⏰ 到期跟进</h2>
          <ul className="flex flex-col gap-2">
            {dueFollowUps.map((d) => (
              <li
                key={d.ledgerId}
                className="rounded-xl border border-amber-900/70 bg-amber-950/20 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/opportunities/${d.opportunityId}`}
                    className="text-sm font-medium text-neutral-100 hover:underline"
                  >
                    {d.title || "（无标题）"}
                  </Link>
                  <span className="text-xs text-amber-400">
                    到期 {formatDateTime(d.followUpAt)}
                  </span>
                </div>
                {d.note ? (
                  <p className="mt-1 text-sm text-neutral-400">{d.note}</p>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleDone(d.ledgerId)}
                    disabled={busyId === d.ledgerId}
                    className="rounded-md border border-emerald-900 bg-emerald-950/60 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    已跟进
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSnooze(d.ledgerId)}
                    disabled={busyId === d.ledgerId}
                    className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    +3天再看
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 📜 全部记录 */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-400">📜 全部记录</h2>

        {loading ? (
          <p className="text-sm text-neutral-600">载入中…</p>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 px-6 py-16 text-center">
            <p className="text-base text-neutral-300">
              还没有行动记录。机会再多，不行动等于零。
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-xl border border-neutral-800 bg-neutral-900">
            {entries.map((e) => {
              const done = e.doneAt !== null;
              return (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/opportunities/${e.opportunityId}`}
                      className={`text-sm hover:underline ${
                        done
                          ? "text-neutral-500 line-through"
                          : "text-neutral-200"
                      }`}
                    >
                      {e.title || "（无标题）"}
                    </Link>
                    <div className="flex items-center gap-2 text-xs">
                      {done ? (
                        <span className="text-neutral-600">
                          ✅ {formatDateTime(e.doneAt as number)}
                        </span>
                      ) : e.followUpAt !== null ? (
                        <span
                          className={
                            e.followUpAt <= nowTs
                              ? "text-amber-400"
                              : "text-neutral-500"
                          }
                        >
                          跟进中 {formatDateTime(e.followUpAt).slice(0, 5)}
                        </span>
                      ) : (
                        <span className="text-neutral-600">待行动</span>
                      )}
                      <span className="text-neutral-700">
                        {formatDateTime(e.createdAt)}
                      </span>
                    </div>
                  </div>
                  {e.note ? (
                    <p
                      className={`mt-1 text-sm ${
                        done ? "text-neutral-600 line-through" : "text-neutral-400"
                      }`}
                    >
                      {e.note}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
