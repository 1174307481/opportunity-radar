/**
 * 采集源适配器通用类型与工具
 *
 * 约定：适配器只负责「把外部信号抓成 RawSignal[]」，不碰数据库、不做去重入库
 * （去重与落库在 /api/cron/collect 里统一处理）。
 */

/** 适配器产出的原始信号（未去重、未分析） */
export interface RawSignal {
  title: string;
  content: string;
  url?: string;
}

/** 源配置：从 sources.config 反序列化来的对象，字段各适配器自定，读取时收窄 */
export interface SourceConfig {
  [k: string]: unknown;
}

export interface SourceAdapter {
  key: string;
  label: string;
  fetchSignals(config: SourceConfig): Promise<RawSignal[]>;
}

/** 浏览器 UA：不少站点（含电鸭）对空 UA / curl UA 直接拒绝或返回空壳页 */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 单次网络请求超时（毫秒） */
export const FETCH_TIMEOUT_MS = 15000;

/** 统一的 fetch 超时选项 */
export function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

/** 读字符串型配置（trim 后为空则回退默认值） */
export function configString(
  config: SourceConfig,
  key: string,
  fallback: string
): string {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** 读数字型配置（非法/非正数则回退默认值） */
export function configNumber(
  config: SourceConfig,
  key: string,
  fallback: number
): number {
  const v = config[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 读字符串数组配置（非法则回退默认值；空数组视为未配置） */
export function configStringArray(
  config: SourceConfig,
  key: string,
  fallback: string[]
): string[] {
  const v = config[key];
  if (!Array.isArray(v)) return fallback;
  const arr = v.filter((x): x is string => typeof x === "string" && !!x.trim());
  return arr.length ? arr.map((x) => x.trim()) : fallback;
}

/** 把未知值安全地当成 JSON 对象读（配合未知结构的外部 API 用） */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 截断错误信息，避免把整页 HTML 塞进日志/数据库 */
export function briefError(e: unknown, max = 200): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").slice(0, max);
}
