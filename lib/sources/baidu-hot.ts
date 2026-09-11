import {
  BROWSER_UA,
  briefError,
  configNumber,
  timeoutSignal,
  type RawSignal,
  type SourceAdapter,
  type SourceConfig,
} from "./types";

const URL = "https://top.baidu.com/board?tab=realtime";
const DEFAULT_LIMIT = 20;

/**
 * 百度热搜适配器
 *
 * 抓 HTML 页面正则解析（非 JSON）。结构实测稳定：
 * - 标题：<div class="...c-single-text-ellipsis...">标题</div>
 * - 热度：<div class="...hot-index_1Bl1a...">数字</div>
 *
 * 失败静默：HTML 改版或请求失败都 try-catch 返回空数组，不阻塞其他源。
 */
export const baiduHotAdapter: SourceAdapter = {
  key: "baidu-hot",
  label: "百度热搜",

  async fetchSignals(config: SourceConfig): Promise<RawSignal[]> {
    const limit = Math.min(
      Math.floor(configNumber(config, "limit", DEFAULT_LIMIT)),
      20
    );

    let res: Response;
    try {
      res = await fetch(URL, {
        signal: timeoutSignal(),
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (e) {
      console.warn(`[baidu-hot] 请求失败，跳过：${briefError(e, 120)}`);
      return [];
    }
    if (!res.ok) {
      console.warn(`[baidu-hot] HTTP ${res.status}，跳过`);
      return [];
    }

    const html = await res.text();

    try {
      // 跳过 <style> 块（CSS 里也含 class 名，会误匹配）
      const cutAt = html.indexOf("</style>");
      const body = cutAt > 0 ? html.slice(cutAt + 7) : html;

      // 标题 + 热度配对：标题在前，热度在后
      const pairRe =
        /<div class="[^"]*c-single-text-ellipsis[^"]*"[^>]*>\s*(.+?)\s*<\/div>[\s\S]*?hot-index_1Bl1a[^"]*"[^>]*>\s*(\d+)\s*<\/div>/g;
      const matches = body.match(pairRe);
      if (!matches) return [];

      // 用 exec 循环拿分组（matchAll 在某些 Node 版本对 s 标志支持不一）
      const out: RawSignal[] = [];
      const re = new RegExp(pairRe.source, pairRe.flags);
      let m: RegExpExecArray | null;
      let idx = 0;
      while ((m = re.exec(body)) !== null && out.length < limit) {
        const title = stripTags(m[1]).trim();
        const hot = Number(m[2]);
        if (!title) continue;
        idx += 1;
        out.push({
          title,
          content: `${title} 热度:${hot} 排名:${idx}`,
          url: undefined,
        });
      }
      return out;
    } catch (e) {
      console.warn(
        `[baidu-hot] HTML 解析失败（结构可能改版），跳过：${briefError(e, 120)}`
      );
      return [];
    }
  },
};

/** 去掉内嵌标签（如 <span>），只留纯文本 */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
