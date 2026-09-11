// ==UserScript==
// @name         红线平台快录 → Opportunity Radar（闲鱼/BOSS直聘）
// @namespace    opportunity-radar
// @version      0.2.0
// @description  在闲鱼/BOSS直聘宝贝与职位页，一键把「标题+价格/薪资+描述+链接」投进机会雷达。单条、手动触发、不做任何批量采集（等价于手动复制粘贴）。
// @author       opportunity-radar
// @match        https://www.goofish.com/item*
// @match        https://h5.m.goofish.com/item*
// @match        https://2.taobao.com/item*
// @match        https://www.zhipin.com/job_detail/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  // 雷达地址：本地服务换了端口就改这里
  const RADAR_URL = "http://127.0.0.1:3001/api/items";

  // 站点 → 平台名（写进正文给 L1 当线索）
  function platformName() {
    const h = location.hostname;
    if (h.includes("goofish.com") || h.includes("2.taobao.com")) return "闲鱼";
    if (h.includes("zhipin.com")) return "BOSS直聘";
    return h;
  }

  if (window.__radarClipperLoaded) return;
  window.__radarClipperLoaded = true;

  /** 依次尝试选择器，返回第一个非空文本 */
  function pickText(selectorList) {
    for (const sel of selectorList) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const t = (el.content || el.textContent || "").trim();
        if (t) return t;
      } catch (_) {
        /* 选择器非法就跳过 */
      }
    }
    return "";
  }

  /** 采集当前页信息；选中了文本则优先用选中内容当描述 */
  function collect() {
    const selection =
      window.getSelection && String(window.getSelection()).trim();

    const title =
      pickText([
        'meta[property="og:title"]',
        "h1",
        '[class*="ItemTitle"]',
        '[class*="itemTitle"]',
        '[class*="job-name"]',
        '[class*="JobName"]',
      ]) ||
      document.title
        .replace(/[-–—|]\s*(闲鱼|Goofish|goofish|BOSS直聘|zhipin).*$/i, "")
        .trim();

    // 价格（闲鱼）与薪资（BOSS）共用一个兜底链
    const price = pickText([
      '[class*="salary"]',
      '[class*="Salary"]',
      '[class*="price"]',
      '[class*="Price"]',
    ]);
    const desc = pickText([
      'meta[name="description"]',
      '[class*="description"]',
      '[class*="Description"]',
      '[class*="desc"]',
      '[class*="job-sec"]',
    ]);

    // 洗掉 query 里的跟踪参数，只留 id（BOSS 的 job_detail 也适用）
    const url = location.origin + location.pathname + (location.search || "");

    return { title, price, desc, selection, url };
  }

  function buildContent(c) {
    const lines = [`【${platformName()}快录】`];
    if (c.title) lines.push(`标题：${c.title}`);
    if (c.price) lines.push(`价格/薪资：${c.price}`);
    lines.push(`链接：${c.url}`);
    lines.push("---");
    lines.push(
      c.selection ||
        c.desc ||
        "（未取到描述：请在页面上选中描述文字后再点一次）"
    );
    return lines.join("\n");
  }

  function submit(content) {
    GM_xmlhttpRequest({
      method: "POST",
      url: RADAR_URL,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ type: "text", content }),
      timeout: 15000,
      onload(res) {
        let msg = `HTTP ${res.status}`;
        try {
          const d = JSON.parse(res.responseText);
          if (d.id) msg = "✅ 已投入雷达，开始分析";
          else if (d.duplicated) msg = "ℹ️ 该条已在库中";
          else if (d.error) msg = `❌ ${d.error}`;
        } catch (_) {
          /* 保留 HTTP 状态信息 */
        }
        alert(`机会雷达：${msg}`);
      },
      onerror() {
        alert("机会雷达：请求失败——请确认本地服务已启动（" + RADAR_URL + "）");
      },
      ontimeout() {
        alert("机会雷达：请求超时");
      },
    });
  }

  function handleClick() {
    const c = collect();
    const content = buildContent(c);
    const ok = window.confirm(
      "投入机会雷达？\n\n" +
        content +
        "\n\n（描述不对就取消，在页面上选中描述文字后再点）"
    );
    if (ok) submit(content);
  }

  function mountButton() {
    const btn = document.createElement("button");
    btn.textContent = "⚡ 投雷达";
    btn.title = "把这条信息投进机会雷达（单条，手动触发）";
    Object.assign(btn.style, {
      position: "fixed",
      right: "18px",
      bottom: "88px",
      zIndex: "2147483647",
      padding: "10px 16px",
      borderRadius: "999px",
      border: "1px solid #7f1d1d",
      background: "#7f1d1d",
      color: "#fff",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      boxShadow: "0 4px 12px rgba(0,0,0,.35)",
    });
    btn.addEventListener("click", handleClick);
    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountButton);
  } else {
    mountButton();
  }
})();
