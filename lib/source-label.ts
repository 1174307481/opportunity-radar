/** source_type → 展示标签（items.sourceType 实际取值："text"|"url"|"source:<key>"） */
const LABELS: Record<string, string> = {
  text: "粘贴",
  url: "URL",
  "source:eleduck": "电鸭",
  "source:hn": "HN",
  "source:github": "GitHub",
};

export function sourceLabel(sourceType: string): string {
  return LABELS[sourceType] ?? sourceType;
}
