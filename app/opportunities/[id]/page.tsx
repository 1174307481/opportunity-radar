"use client";

import { use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { sourceLabel } from "@/lib/source-label";

/** ---------- 接口定义 ---------- */

type Tier = "today" | "week" | "archived" | "observe";
type Status = "new" | "researching" | "contacted" | "deal" | "ignored";

/** 技能命中项（lib/profile.ts SkillHit） */
interface SkillHit {
  skill: string;
  importance: number;
  hit: boolean;
  level: number | null;
}

/** 三证中的单项：依据可能为 null（原文未提供，禁止脑补） */
interface EvidenceItem {
  依据?: string | null;
  结论?: string | null;
}

interface EvidenceTrilogy {
  资金证据?: EvidenceItem | null;
  身份证据?: EvidenceItem | null;
  时间证据?: EvidenceItem | null;
  总体结论?: string | null;
}

interface ScoreItem {
  score: number | null;
  reason: string;
}

interface Scores {
  需求真实性?: ScoreItem | null;
  行动可行性?: ScoreItem | null;
  独特性?: ScoreItem | null;
  时效性?: ScoreItem | null;
}

interface HourlyCheck {
  预估单价?: string | number | null;
  预估工时?: string | number | null;
  反算时薪?: string | number | null;
  底线时薪?: string | number | null;
  说明?: string | null;
}

interface FirstStep {
  time_box: string;
  action: string;
  object: string;
  channel: string;
  quantity: string;
  completion_rule: string;
  copyable_first_message: string;
}

interface Analysis {
  evidence_trilogy?: EvidenceTrilogy | null;
  scores?: Scores | null;
  /** 兼容模型输出：数组或整段字符串（按行拆分） */
  devil_advocate?: string[] | string | null;
  hourly_check?: HourlyCheck | null;
  verdict?: string | null;
  first_step?: FirstStep | null;
}

interface Opportunity {
  id: number;
  itemId: number;
  type: string;
  tier: Tier | string;
  userTier: Tier | string | null;
  score: number | null;
  skillMatch: number | null;
  skillMatchDetail: SkillHit[];
  fastTrack: boolean;
  status: Status | string;
  createdAt: number;
  analysis: Analysis | null;
}

interface SourceItem {
  id: number;
  title: string;
  url: string | null;
  content: string;
  sourceType: string;
  aiStage: string;
  errorMessage: string | null;
  foundAt: number;
}

interface DetailResponse {
  opportunity: Opportunity;
  item: SourceItem;
}

/** GET /api/ledger 的一条行动记录 */
interface LedgerEntry {
  id: number;
  opportunityId: number;
  title: string;
  note: string;
  followUpAt: number | null;
  doneAt: number | null;
  createdAt: number;
}

/** POST /api/ledger 响应 */
interface LedgerCreateResponse {
  id?: number;
  error?: string;
}

/** 跟进快捷选项 */
type FollowUpChoice = "none" | "3d" | "7d";

const DAY_MS = 86400e3;

const FOLLOW_UP_OPTIONS: { key: FollowUpChoice; label: string }[] = [
  { key: "none", label: "不跟进" },
  { key: "3d", label: "+3天" },
  { key: "7d", label: "+7天" },
];

function followUpAtOf(choice: FollowUpChoice): number | null {
  if (choice === "3d") return Date.now() + 3 * DAY_MS;
  if (choice === "7d") return Date.now() + 7 * DAY_MS;
  return null;
}

/** ---------- 常量与元数据 ---------- */

interface Meta {
  label: string;
  className: string;
  activeClassName: string;
}

const TIER_META: Record<Tier, Meta> = {
  today: {
    label: "🔴 今天看",
    className: "border-red-900/70 bg-red-950/40 text-red-300",
    activeClassName: "border-red-700 bg-red-900/70 text-red-100",
  },
  week: {
    label: "🟡 本周看",
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
    className: "border-sky-900/70 bg-sky-950/40 text-sky-300",
    activeClassName: "border-sky-700 bg-sky-900/70 text-sky-100",
  },
};

const STATUS_META: Record<Status, string> = {
  new: "新",
  researching: "研究中",
  contacted: "已联系",
  deal: "已成交",
  ignored: "忽略",
};

/** 四维评分：分值口径见 toMaxScale */
const SCORE_DIMS: { key: keyof Scores; label: string; max: number }[] = [
  { key: "需求真实性", label: "需求真实性", max: 40 },
  { key: "行动可行性", label: "行动可行性", max: 30 },
  { key: "独特性", label: "独特性", max: 15 },
  { key: "时效性", label: "时效性", max: 15 },
];

const BADGE =
  "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-4 whitespace-nowrap";

const CARD = "rounded-lg border border-neutral-800 bg-neutral-900";

const SECTION_TITLE =
  "text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500";

/** 轮询间隔 / 最大轮询次数（重新分析后约 2.5 分钟） */
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 60;

/** ---------- 工具函数 ---------- */

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

function isTier(value: string): value is Tier {
  return value === "today" || value === "week" || value === "archived" || value === "observe";
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

/** 字符串或数字统一成可展示文本；空值显示占位符 */
function text(value: string | number | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s.length ? s : fallback;
}

/** devil_advocate 归一化：数组直接用，字符串按行拆分 */
function toDevilList(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((s) => s.replace(/^[-*\d.、)）\s]+/, "").trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * L2 的维度分可能是 0-100 归一值（配合 lib/ai/l2.ts 的 computeTotalScore 加权），
 * 也可能直接按满分制输出。若任一维超过自身满分，则整体按 0-100 口径换算，
 * 否则条形图会溢出或恒满。
 */
function toMaxScale(raw: number | null, max: number, percentMode: boolean): number {
  if (raw === null || !Number.isFinite(raw)) return 0;
  const v = percentMode ? (raw * max) / 100 : raw;
  return Math.min(max, Math.max(0, v));
}

/** 技能熟练度：level 为 0-1 时按百分比展示，其余原样 */
function formatLevel(level: number | null): string {
  if (level === null || !Number.isFinite(level)) return "";
  return level <= 1 ? `${Math.round(level * 100)}%` : String(level);
}

/** verdict 首字定调色 */
function verdictTone(verdict: string): string {
  const v = verdict.trim();
  if (v.startsWith("不做") || v.startsWith("别做")) return "text-red-400";
  if (v.startsWith("谨慎")) return "text-amber-300";
  if (v.startsWith("做")) return "text-emerald-300";
  return "text-neutral-100";
}

function Section({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${CARD} p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className={SECTION_TITLE}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <span className="w-20 shrink-0 text-xs text-neutral-500">{label}</span>
      <span className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap text-neutral-200">
        {value}
      </span>
    </div>
  );
}

/** ---------- 页面 ---------- */

export default function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingTier, setSavingTier] = useState<Tier | null>(null);
  const [savingStatus, setSavingStatus] = useState<Status | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [copied, setCopied] = useState(false);

  /** 行动记录 */
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [ledgerNote, setLedgerNote] = useState("");
  const [followUpChoice, setFollowUpChoice] = useState<FollowUpChoice>("none");
  const [savingLedger, setSavingLedger] = useState(false);
  const [ledgerBusyId, setLedgerBusyId] = useState<number | null>(null);
  const [ledgerNotice, setLedgerNotice] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);
  /** 用户改过备注后不再用 first_step.action 覆盖 */
  const noteTouchedRef = useRef(false);

  const loadDetail = useCallback(
    async (opts?: { silent?: boolean }): Promise<DetailResponse | null> => {
      if (!opts?.silent) setLoading(true);
      try {
        const res = await fetch(`/api/opportunities/${id}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `请求失败（${res.status}）`);
        }
        const next = (await res.json()) as DetailResponse;
        setData(next);
        // 备注默认值 = 第一步的动作（用户改过就不再覆盖）
        if (!noteTouchedRef.current) {
          const action = next.opportunity.analysis?.first_step?.action;
          if (typeof action === "string" && action.trim()) setLedgerNote(action);
        }
        setLoadError(null);
        return next;
      } catch (e) {
        if (!opts?.silent) setLoadError(e instanceof Error ? e.message : "加载失败");
        return null;
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [id]
  );

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  /** ---------- 行动记录 ---------- */

  const loadLedger = useCallback(async () => {
    try {
      const res = await fetch("/api/ledger", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { entries: LedgerEntry[] };
      const oppId = Number(id);
      setLedgerEntries(body.entries.filter((e) => e.opportunityId === oppId));
    } catch (e) {
      setLedgerNotice({
        kind: "error",
        text: `行动记录加载失败：${e instanceof Error ? e.message : "未知错误"}`,
      });
    }
  }, [id]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const handleCreateLedger = useCallback(async () => {
    if (savingLedger) return;
    const note = ledgerNote.trim();
    if (!note) {
      setLedgerNotice({ kind: "error", text: "备注不能为空" });
      return;
    }
    setSavingLedger(true);
    setLedgerNotice(null);
    try {
      const res = await fetch("/api/ledger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityId: Number(id),
          note,
          followUpAt: followUpAtOf(followUpChoice),
        }),
      });
      const body = (await res.json().catch(() => null)) as LedgerCreateResponse | null;
      if (!res.ok || typeof body?.id !== "number") {
        throw new Error(body?.error || `记录失败（${res.status}）`);
      }
      setLedgerNotice({ kind: "info", text: "已记下这一笔。" });
      await loadLedger();
    } catch (e) {
      setLedgerNotice({
        kind: "error",
        text: e instanceof Error ? e.message : "记录失败",
      });
    } finally {
      setSavingLedger(false);
    }
  }, [id, ledgerNote, followUpChoice, savingLedger, loadLedger]);

  const handleFollowUpDone = useCallback(
    async (ledgerId: number) => {
      if (ledgerBusyId !== null) return;
      setLedgerBusyId(ledgerId);
      setLedgerNotice(null);
      try {
        const res = await fetch(`/api/ledger/${ledgerId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done: true }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error || `操作失败（${res.status}）`);
        }
        await loadLedger();
      } catch (e) {
        setLedgerNotice({
          kind: "error",
          text: e instanceof Error ? e.message : "操作失败",
        });
      } finally {
        setLedgerBusyId(null);
      }
    },
    [ledgerBusyId, loadLedger]
  );

  /** 重新分析后轮询，直到 analysis 出现或达到上限 */
  useEffect(() => {
    if (!reanalyzing) return;
    let cancelled = false;
    let attempts = 0;

    const timer = window.setInterval(() => {
      void (async () => {
        if (cancelled) return;
        attempts += 1;
        const next = await loadDetail({ silent: true });
        if (cancelled) return;
        const done =
          !next ||
          next.opportunity.analysis !== null ||
          next.item.aiStage === "failed" ||
          attempts >= POLL_MAX_ATTEMPTS;
        if (done) {
          setReanalyzing(false);
          if (!next?.opportunity.analysis) {
            setActionError("分析仍未完成，稍后刷新页面再看看");
          }
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reanalyzing, loadDetail]);

  const handlePatch = useCallback(
    async (body: { tier?: Tier; status?: Status }) => {
      setActionError(null);
      try {
        const res = await fetch(`/api/opportunities/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const resBody = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(resBody?.error ?? `保存失败（${res.status}）`);
        }
        // 本地即时回显：改档写 userTier，改状态写 status
        setData((prev) =>
          prev
            ? {
                ...prev,
                opportunity: {
                  ...prev.opportunity,
                  tier: body.tier ?? prev.opportunity.tier,
                  userTier: body.tier ?? prev.opportunity.userTier,
                  status: body.status ?? prev.opportunity.status,
                },
              }
            : prev
        );
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "保存失败");
      }
    },
    [id]
  );

  const handleReanalyze = useCallback(
    async (itemId: number) => {
      setActionError(null);
      setReanalyzing(true);
      try {
        const res = await fetch(`/api/items/${itemId}/reanalyze`, { method: "POST" });
        if (!res.ok) throw new Error(`重新分析失败（${res.status}）`);
      } catch (e) {
        setReanalyzing(false);
        setActionError(e instanceof Error ? e.message : "重新分析失败");
      }
    },
    []
  );

  const handleCopy = useCallback(async (message: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError("复制失败，请手动选择文本");
    }
  }, []);

  /** ---------- 加载 / 错误态 ---------- */

  if (loading) {
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-16 text-center text-sm text-neutral-500">
        载入中…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <BackLinks />
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-10 text-center text-sm text-red-300">
          {loadError ?? "机会不存在"}
        </div>
      </div>
    );
  }

  const { opportunity: opp, item } = data;
  const analysis = opp.analysis;
  const effectiveTier: Tier | null = isTier(opp.userTier ?? "")
    ? (opp.userTier as Tier)
    : isTier(opp.tier)
      ? (opp.tier as Tier)
      : null;
  const activeStatus: Status | null = isStatus(opp.status) ? (opp.status as Status) : null;

  const scores = analysis?.scores ?? null;
  const rawScores = SCORE_DIMS.map((d) => scores?.[d.key]?.score ?? null);
  const percentMode = SCORE_DIMS.some((d, i) => (rawScores[i] ?? 0) > d.max);

  const evidence = analysis?.evidence_trilogy ?? null;
  const evidenceRows: { label: string; value: EvidenceItem | null | undefined }[] = [
    { label: "资金证据", value: evidence?.资金证据 },
    { label: "身份证据", value: evidence?.身份证据 },
    { label: "时间证据", value: evidence?.时间证据 },
  ];

  const devils = toDevilList(analysis?.devil_advocate);
  const hourly = analysis?.hourly_check ?? null;
  const firstStep = analysis?.first_step ?? null;
  const skillDetail = Array.isArray(opp.skillMatchDetail) ? opp.skillMatchDetail : [];

  return (
    <div className="flex flex-col gap-5">
      <BackLinks />

      {/* 1. 头部 */}
      <header className={`${CARD} p-4`}>
        <h1 className="text-lg leading-6 font-semibold text-neutral-100">
          {item.title || "（无标题）"}
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="ml-2 text-sky-400 underline-offset-2 hover:underline"
              title={item.url}
            >
              🔗
            </a>
          ) : null}
        </h1>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className={`${BADGE} border-neutral-800 bg-neutral-900 text-neutral-300`}>
            {opp.type}
          </span>
          {effectiveTier ? (
            <span className={`${BADGE} ${TIER_META[effectiveTier].className}`}>
              {TIER_META[effectiveTier].label}
            </span>
          ) : (
            <span className={`${BADGE} border-neutral-800 bg-neutral-900 text-neutral-400`}>
              {opp.tier}
            </span>
          )}
          {opp.userTier ? (
            <span className={`${BADGE} border-violet-900/70 bg-violet-950/40 text-violet-300`}>
              用户改档
            </span>
          ) : null}
          {opp.fastTrack ? (
            <span className={`${BADGE} border-red-900/70 bg-red-950/50 text-red-300`}>
              ⚡ 接单·待验真
            </span>
          ) : null}
          {activeStatus ? (
            <span className={`${BADGE} border-neutral-800 bg-neutral-900 text-neutral-400`}>
              {STATUS_META[activeStatus]}
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex items-end gap-6">
          <div>
            <div className={SECTION_TITLE}>总分</div>
            <div className="mt-0.5 text-3xl leading-9 font-semibold text-neutral-100">
              {opp.score ?? "—"}
            </div>
          </div>
          <div>
            <div className={SECTION_TITLE}>技能匹配</div>
            <div className="mt-0.5 text-3xl leading-9 font-semibold text-sky-300">
              {opp.skillMatch != null ? `${opp.skillMatch}%` : "—"}
            </div>
          </div>
          <div className="ml-auto text-right text-[11px] text-neutral-600">
            <div>入档 {formatTime(opp.createdAt)}</div>
            <div>采集 {formatTime(item.foundAt)}</div>
          </div>
        </div>
      </header>

      {/* 2. 档位 / 状态操作条 */}
      <section className={`${CARD} p-4`}>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(TIER_META) as Tier[]).map((tier) => {
            const meta = TIER_META[tier];
            const active = effectiveTier === tier;
            const saving = savingTier === tier;
            return (
              <button
                key={tier}
                type="button"
                disabled={saving}
                onClick={() => {
                  setSavingTier(tier);
                  void handlePatch({ tier }).finally(() => setSavingTier(null));
                }}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  active ? meta.activeClassName : `${meta.className} hover:border-neutral-600`
                }`}
              >
                {saving ? "保存中…" : meta.label}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 border-t border-neutral-800 pt-3">
          {(Object.keys(STATUS_META) as Status[]).map((status) => {
            const active = activeStatus === status;
            const saving = savingStatus === status;
            return (
              <button
                key={status}
                type="button"
                disabled={saving}
                onClick={() => {
                  setSavingStatus(status);
                  void handlePatch({ status }).finally(() => setSavingStatus(null));
                }}
                className={`rounded-md border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? "border-emerald-700 bg-emerald-900/50 text-emerald-100"
                    : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                }`}
              >
                {saving ? "保存中…" : STATUS_META[status]}
              </button>
            );
          })}
        </div>

        {actionError ? <p className="mt-2 text-xs text-red-400">{actionError}</p> : null}
      </section>

      {!analysis ? (
        /* 流水线失败 / 尚未分析 */
        <section className="rounded-lg border border-red-900 bg-red-950/30 p-6 text-center">
          <p className="text-sm font-medium text-red-300">这条机会还没有分析结果</p>
          <p className="mt-1.5 text-xs text-neutral-400">
            {item.errorMessage
              ? `流水线报错：${item.errorMessage}`
              : `当前阶段：${item.aiStage}，可能仍在分析中或已失败`}
          </p>
          <button
            type="button"
            disabled={reanalyzing}
            onClick={() => void handleReanalyze(opp.itemId)}
            className="mt-4 rounded-md border border-red-900 bg-red-950/60 px-4 py-1.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reanalyzing ? "分析中…" : "重新分析"}
          </button>
          {actionError ? <p className="mt-3 text-xs text-red-400">{actionError}</p> : null}
        </section>
      ) : (
        <>
          {/* 3. verdict 结论卡 */}
          {analysis.verdict ? (
            <section className={`${CARD} p-4`}>
              <div className={SECTION_TITLE}>结论</div>
              <p
                className={`mt-1.5 text-xl leading-7 font-semibold ${verdictTone(analysis.verdict)}`}
              >
                {analysis.verdict}
              </p>
            </section>
          ) : null}

          {/* 4. 三证 */}
          <Section title="📋 三证">
            <div className="flex flex-col gap-3">
              {evidenceRows.map((row) => {
                const proof = row.value?.依据;
                const hasProof = typeof proof === "string" && proof.trim().length > 0;
                return (
                  <div key={row.label} className="border-l-2 border-neutral-800 pl-3">
                    <div className="text-xs font-medium text-neutral-300">{row.label}</div>
                    <p
                      className={`mt-1 text-xs break-words whitespace-pre-wrap ${
                        hasProof ? "text-neutral-400" : "text-neutral-600 italic"
                      }`}
                    >
                      {hasProof ? `依据：${proof}` : "依据：原文未提供"}
                    </p>
                    <p className="mt-1 text-sm break-words whitespace-pre-wrap text-neutral-200">
                      结论：{text(row.value?.结论)}
                    </p>
                  </div>
                );
              })}
            </div>
            {evidence?.总体结论 ? (
              <p className="mt-3 border-t border-neutral-800 pt-3 text-sm break-words whitespace-pre-wrap text-neutral-300">
                总体结论：{evidence.总体结论}
              </p>
            ) : null}
          </Section>

          {/* 5. 四维评分 */}
          <Section
            title="📊 四维评分"
            right={
              <span className="text-xs text-neutral-500">
                总分 <span className="text-base font-semibold text-neutral-200">{opp.score ?? "—"}</span>
              </span>
            }
          >
            {scores ? (
              <div className="flex flex-col gap-3">
                {SCORE_DIMS.map((dim, i) => {
                  const scoreItem = scores[dim.key];
                  const raw = rawScores[i];
                  const value = toMaxScale(raw, dim.max, percentMode);
                  const pct = Math.round((value / dim.max) * 100);
                  return (
                    <div key={dim.key}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-neutral-200">{dim.label}</span>
                        <span className="text-xs text-neutral-400">
                          <span className="text-sm font-semibold text-neutral-200">
                            {raw === null ? "—" : Math.round(value)}
                          </span>
                          <span className="text-neutral-600"> / {dim.max}</span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                        <div
                          className="h-full rounded-full bg-sky-500/80 transition-[width] duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs break-words whitespace-pre-wrap text-neutral-500">
                        {text(scoreItem?.reason, "（无理由）")}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-neutral-500">该机会没有四维评分。</p>
            )}
          </Section>

          {/* 6. 技能匹配 */}
          <Section
            title="🎯 技能匹配"
            right={
              <span className="text-2xl leading-7 font-semibold text-sky-300">
                {opp.skillMatch != null ? `${opp.skillMatch}%` : "—"}
              </span>
            }
          >
            {skillDetail.length ? (
              <ul className="flex flex-col divide-y divide-neutral-800">
                {skillDetail.map((hit, i) => (
                  <li
                    key={`${hit.skill}-${i}`}
                    className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="text-sm text-neutral-200">{hit.skill}</span>
                    <span
                      className="text-[11px] tracking-tight text-amber-400"
                      title={`重要度 ${hit.importance}/5`}
                    >
                      {"★".repeat(Math.min(5, Math.max(1, hit.importance || 1)))}
                    </span>
                    {hit.hit ? (
                      <span className={`${BADGE} border-emerald-900/70 bg-emerald-950/50 text-emerald-300`}>
                        有
                        {formatLevel(hit.level) ? ` ${formatLevel(hit.level)}` : ""}
                      </span>
                    ) : (
                      <span className={`${BADGE} border-red-900/70 bg-red-950/50 text-red-300`}>
                        缺口
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-500">没有技能匹配明细。</p>
            )}
          </Section>

          {/* 7. 魔鬼代言人 */}
          {devils.length ? (
            <section className="rounded-lg border border-red-900/50 bg-red-950/30 p-4">
              <h2 className="mb-3 text-[11px] font-semibold tracking-[0.18em] text-red-400 uppercase">
                😈 魔鬼代言人
              </h2>
              <ul className="flex flex-col gap-2">
                {devils.map((d, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-sm break-words whitespace-pre-wrap text-red-200/90"
                  >
                    <span className="shrink-0 text-red-500">⚠</span>
                    <span className="min-w-0">{d}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* 8. 时薪账 */}
          {hourly ? (
            <Section title="💰 时薪账">
              <div className="flex flex-col gap-2">
                <KeyValue label="预估单价" value={text(hourly.预估单价)} />
                <KeyValue label="预估工时" value={text(hourly.预估工时)} />
                <KeyValue label="反算时薪" value={text(hourly.反算时薪)} />
                <KeyValue label="底线时薪" value={text(hourly.底线时薪)} />
                <KeyValue label="说明" value={text(hourly.说明)} />
              </div>
            </Section>
          ) : null}

          {/* 9. 第一步（重点卡） */}
          {firstStep ? (
            <section className="rounded-lg border border-sky-800/60 bg-neutral-900 p-4 ring-1 ring-sky-900/30">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-xs font-semibold tracking-[0.18em] text-sky-300 uppercase">
                  ✅ 第一步
                </h2>
                <span className="text-xs text-neutral-400">{text(firstStep.time_box)}</span>
              </div>

              <div className="flex flex-col gap-2">
                <KeyValue label="动作" value={text(firstStep.action)} />
                <KeyValue label="对象" value={text(firstStep.object)} />
                <KeyValue label="渠道" value={text(firstStep.channel)} />
                <KeyValue label="数量" value={text(firstStep.quantity)} />
                <KeyValue label="完成判据" value={text(firstStep.completion_rule)} />
              </div>

              {firstStep.copyable_first_message ? (
                <div className="mt-4 border-t border-neutral-800 pt-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className={SECTION_TITLE}>开口话术</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy(firstStep.copyable_first_message)}
                      className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
                    >
                      {copied ? "已复制 ✓" : "复制话术"}
                    </button>
                  </div>
                  <p className="rounded-md border border-neutral-800 bg-neutral-950/60 p-3 text-sm break-words whitespace-pre-wrap text-neutral-200">
                    {firstStep.copyable_first_message}
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      {/* 9.5 行动记录 */}
      <Section title="📒 行动记录">
        <div className="flex flex-col gap-2">
          <textarea
            value={ledgerNote}
            onChange={(e) => {
              noteTouchedRef.current = true;
              setLedgerNote(e.target.value);
            }}
            rows={2}
            placeholder="做了什么？例：发了话术、加了微信、报了价…"
            className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-500">跟进</span>
            {FOLLOW_UP_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setFollowUpChoice(opt.key)}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  followUpChoice === opt.key
                    ? "border-sky-700 bg-sky-900/50 text-sky-100"
                    : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void handleCreateLedger()}
            disabled={savingLedger}
            className="self-start rounded-md border border-emerald-900 bg-emerald-950/60 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {savingLedger ? "记录中…" : "记录"}
          </button>

          {ledgerNotice ? (
            <p
              className={`text-xs ${
                ledgerNotice.kind === "error" ? "text-red-400" : "text-emerald-400"
              }`}
            >
              {ledgerNotice.text}
            </p>
          ) : null}
        </div>

        <div className="mt-3 border-t border-neutral-800 pt-3">
          {ledgerEntries.length === 0 ? (
            <p className="text-xs text-neutral-600">还没有行动记录。发出第一条消息，记下这一笔。</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-800">
              {ledgerEntries.map((entry) => {
                const done = entry.doneAt !== null;
                const pendingFollowUp = !done && entry.followUpAt !== null;
                return (
                  <li key={entry.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                    <p
                      className={`text-sm break-words whitespace-pre-wrap ${
                        done ? "text-neutral-500" : "text-neutral-200"
                      }`}
                    >
                      {entry.note || "（无备注）"}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-neutral-600">
                        {formatTime(entry.createdAt)}
                      </span>
                      {done ? (
                        <span className="text-neutral-600">
                          ✅ 已跟进 {formatTime(entry.doneAt as number)}
                        </span>
                      ) : pendingFollowUp ? (
                        <>
                          <span className="text-amber-400">
                            跟进中 · {formatTime(entry.followUpAt as number)}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleFollowUpDone(entry.id)}
                            disabled={ledgerBusyId !== null}
                            className="rounded border border-emerald-900 bg-emerald-950/60 px-2 py-0.5 text-[11px] text-emerald-300 transition-colors hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {ledgerBusyId === entry.id ? "处理中…" : "已跟进"}
                          </button>
                        </>
                      ) : (
                        <span className="text-neutral-600">未设跟进</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Section>

      {/* 10. 原始信息 */}
      <details className={`${CARD} p-4`}>
        <summary className="cursor-pointer text-[11px] font-semibold tracking-[0.18em] text-neutral-500 uppercase select-none">
          原始信息
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span className={`${BADGE} border-neutral-800 bg-neutral-900 text-neutral-400`}>
              来源：{sourceLabel(item.sourceType)}
            </span>
            <span>采集 {formatTime(item.foundAt)}</span>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 underline-offset-2 hover:underline"
              >
                查看来源 🔗
              </a>
            ) : null}
          </div>
          <p className="rounded-md border border-neutral-800 bg-neutral-950/60 p-3 text-xs leading-5 break-words whitespace-pre-wrap text-neutral-300">
            {item.content || "（无正文）"}
          </p>
        </div>
      </details>
    </div>
  );
}

function BackLinks() {
  return (
    <nav className="flex items-center gap-4 text-xs text-neutral-500">
      <Link href="/library" className="transition-colors hover:text-neutral-200">
        ← 信息库
      </Link>
      <Link href="/" className="transition-colors hover:text-neutral-200">
        ← 首页
      </Link>
    </nav>
  );
}
