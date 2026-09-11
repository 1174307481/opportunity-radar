const BASE = (process.env.LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
export const MODEL_FAST = process.env.MODEL_FAST || "deepseek-v4-flash";
export const MODEL_THINK = process.env.MODEL_THINK || "deepseek-v4-flash";

if (!BASE || !KEY) {
  console.warn("[gateway] LLM_BASE_URL/LLM_API_KEY 未配置（回退 ANTHROPIC_* 环境变量）");
}

export interface Usage { input: number; output: number }

/**
 * 调用 Anthropic 兼容网关。注意：网关模型是思考型，
 * thinking token 计入 max_tokens，所以调用方必须给足额度（L1≥6000 / L2≥12000）。
 * 只拼接 type==="text" 的内容块。
 */
export async function callGateway(
  prompt: string,
  opts: { maxTokens: number; model?: string }
): Promise<{ text: string; usage: Usage }> {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      authorization: `Bearer ${KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model || MODEL_THINK,
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`gateway ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
  return {
    text,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
  };
}

/** 从模型输出里抠出 JSON（容忍 ``` 包裹与前后杂文字） */
export function extractJson(raw: string): unknown {
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error("输出中未找到 JSON");
  const open = raw[start];
  const close = open === "[" ? "]" : "}";
  const end = raw.lastIndexOf(close);
  if (end <= start) throw new Error("JSON 不完整");
  return JSON.parse(raw.slice(start, end + 1));
}
