/** source_type → 展示标签（items.sourceType 实际取值："text"|"url"|"source:<key>"|"clipper:<key>"） */
const LABELS: Record<string, string> = {
  text: "粘贴",
  url: "URL",
  "source:eleduck": "电鸭",
  "source:hn": "HN",
  "source:github": "GitHub",
  "source:douyin-hot": "抖音热搜",
  "source:weibo-hot": "微博热搜",
  "source:zhihu-hot": "知乎热榜",
  "source:baidu-hot": "百度热搜",
  "source:toutiao-hot": "头条热榜",
  "clipper:xianyu": "闲鱼",
  "clipper:boss": "BOSS直聘",
};

export function sourceLabel(sourceType: string): string {
  return LABELS[sourceType] ?? sourceType;
}
