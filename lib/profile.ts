/** 技能画像默认值：canonical skill → 熟练度（精通 1.0 / 熟练 0.85 / 会用 0.7） */
export const SKILL_PROFILE: Record<string, number> = {
  vue: 0.95, react: 0.9, typescript: 0.95, nextjs: 0.85, uniapp: 0.85,
  echarts: 0.9, threejs: 0.7, element: 0.9, antd: 0.85, vant: 0.85,
  java: 0.8, spring: 0.8,
  nodejs: 0.85, nestjs: 0.8, express: 0.85,
  python: 0.9, fastapi: 0.85,
  llm: 0.9, agent: 0.85, langgraph: 0.8, rag: 0.85, workflow: 0.85,
  "doc-parse": 0.8, multimodal: 0.7, "ai-analysis": 0.8,
  mysql: 0.8, postgresql: 0.75, mongodb: 0.7, redis: 0.75,
  linux: 0.85, docker: 0.85, k8s: 0.7, nginx: 0.8, cicd: 0.8,
  "video-editing": 0.8, "ai-image": 0.8, "ai-video": 0.75,
  "ai-voice": 0.75, copywriting: 0.8, subtitle: 0.8,
  crawling: 0.75, automation: 0.85, "mini-program": 0.85,
};

/** 中文/英文/缩写 → canonical（默认词表，settings 可追加） */
export const SKILL_ALIAS: Record<string, string> = {
  "vue2": "vue", "vue3": "vue", "vuejs": "vue", "vue.js": "vue",
  "reactjs": "react", "react.js": "react", "react native": "react",
  "ts": "typescript", "next.js": "nextjs", "next": "nextjs",
  "小程序": "mini-program", "微信小程序": "mini-program",
  "element ui": "element", "element-plus": "element", "elementplus": "element",
  "ant design": "antd", "antd": "antd",
  "spring boot": "spring", "springboot": "spring",
  "node": "nodejs", "node.js": "nodejs",
  "大模型": "llm", "llm api": "llm", "ai应用": "llm",
  "ai agent": "agent", "智能体": "agent", "ai工作流": "workflow",
  "知识库": "rag", "ai知识库": "rag", "企业知识库": "rag",
  "文档解析": "doc-parse", "pdf解析": "doc-parse",
  "多模态": "multimodal",
  "mysql/postgresql": "mysql", "数据库": "mysql",
  "docker/k8s": "docker", "kubernetes": "k8s", "容器": "docker",
  "ci/cd": "cicd", "jenkins": "cicd", "运维": "linux",
  "剪辑": "video-editing", "视频剪辑": "video-editing", "短视频剪辑": "video-editing",
  "短视频": "video-editing", "视频二创": "video-editing", "字幕": "subtitle",
  "生图": "ai-image", "ai生图": "ai-image", "商品图": "ai-image", "海报": "ai-image",
  "生视频": "ai-video", "ai生视频": "ai-video", "图片转视频": "ai-video",
  "配音": "ai-voice", "ai配音": "ai-voice", "tts": "ai-voice",
  "文案": "copywriting", "短视频文案": "copywriting", "文案写作": "copywriting", "脚本": "copywriting",
  "爬虫": "crawling", "数据采集": "crawling", "采集": "crawling",
  "自动化": "automation", "rpa": "automation", "数据处理": "automation",
  "前端开发": "frontend", "前端": "frontend", "全栈": "fullstack", "全栈开发": "fullstack",
  "后端": "backend", "后端开发": "backend",
  "full-stack": "fullstack", "fullstack": "fullstack",
  "web development": "frontend", "web dev": "frontend", "saas": "fullstack",
  "h5": "vue", "uni-app": "uniapp",
  "剪映": "video-editing", "ai剪辑": "video-editing", "功能型ai剪辑": "video-editing",
  "ai工具": "ai", "ai工具提效": "ai", "ai提效": "ai", "aigc": "ai",
};

/** 伞形技能 → 用成员最高熟练度代表命中 */
export const SKILL_UMBRELLAS: Record<string, string[]> = {
  frontend: ["vue", "react", "typescript", "nextjs"],
  fullstack: ["vue", "react", "nodejs", "python"],
  backend: ["java", "spring", "nodejs", "nestjs", "python", "fastapi"],
  ai: ["llm", "agent", "rag", "langgraph"],
};

/** 软技能/玄学词：不计入匹配分母（避免「网感」「沟通能力」稀释真实技能权重） */
export const SOFT_SKILLS = [
  "网感", "沟通", "沟通能力", "责任心", "自学能力", "学习能力", "审美",
  "创意", "经验", "相关经验", "英语", "团队合作", "抗压", "执行力", "时间自由",
];

/** 生效画像：levels/aliases 支持被 settings 覆盖扩展 */
export interface EffectiveProfile {
  levels: Record<string, number>;
  aliases: Record<string, string>;
  soft: Set<string>;
}

export function defaultProfile(): EffectiveProfile {
  return {
    levels: { ...SKILL_PROFILE },
    aliases: { ...SKILL_ALIAS },
    soft: new Set(SOFT_SKILLS),
  };
}

export function normalizeSkill(raw: string, prof: EffectiveProfile): string | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (prof.levels[k] !== undefined) return k;
  if (prof.aliases[k]) return prof.aliases[k];
  return null;
}

export function skillLevel(canonical: string, prof: EffectiveProfile): number | null {
  if (prof.levels[canonical] !== undefined) return prof.levels[canonical];
  const members = SKILL_UMBRELLAS[canonical];
  if (members) {
    const vals = members.map((m) => prof.levels[m]).filter((v) => v !== undefined);
    if (vals.length) return Math.max(...vals);
  }
  return null;
}

/** 去括号脏词：「海外平台内容节奏（TikTok/Facebook）」→「海外平台内容节奏」 */
function stripParen(raw: string): string {
  return raw
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[（(].*$/, "")
    .trim();
}

/**
 * 检查 token 是否包含软技能词（coreHit 软技能漏洞修复）。
 * 「短视频网感」含「网感」(soft) → 靠子串兜底命中 video-editing 也不算 coreHit。
 */
function tokenContainsSoft(token: string, soft: Set<string>): boolean {
  const t = token.toLowerCase();
  for (const s of soft) {
    if (s.length >= 2 && t.includes(s.toLowerCase())) return true;
  }
  return false;
}

/** 单个 token 的规范化匹配（精确 → 别名 → 子串包含） */
function matchToken(token: string, prof: EffectiveProfile): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (prof.soft.has(t)) return null; // 软技能不算 miss
  const direct = normalizeSkill(t, prof);
  if (direct) return direct;
  const bare = stripParen(t);
  if (bare !== t) return normalizeSkill(bare, prof);
  // 子串兜底：原料里包含已知别名（如「内容剪辑节奏」含「剪辑」）
  const aliases = Object.keys(prof.aliases).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (alias.length >= 2 && t.includes(alias)) return prof.aliases[alias];
  }
  for (const key of Object.keys(prof.levels)) {
    if (key.length >= 3 && t.includes(key)) return key; // ≥3 覆盖 llm/rag/k8s 等短名
  }
  return null;
}

export interface SkillHit {
  skill: string;
  importance: number;
  hit: boolean;
  level: number | null;
}

export interface MatchResult {
  score: number;
  detail: SkillHit[];
  /** importance≥4 的硬技能是否至少命中一条（快通道资格用） */
  coreHit: boolean;
}

/**
 * skill_match = Σ(命中: importance × level) / Σ(importance) × 100
 * 复合词条先按 / 、，& 拆分，任一 token 命中即算命中。
 */
export function computeSkillMatch(
  required: { skill: string; importance: number }[],
  prof: EffectiveProfile = defaultProfile()
): MatchResult {
  if (!required.length) return { score: 50, detail: [], coreHit: false };
  let weighted = 0;
  let total = 0;
  let coreHit = false;
  const detail: SkillHit[] = [];
  for (const r of required) {
    const imp = Math.min(5, Math.max(1, r.importance || 1));
    const tokens = r.skill.split(/[/、，,&]| and /i).map((s) => s.trim());
    // 整条都是软技能 → 不进分子也不进分母（裁决 A2）
    const softOnly = tokens.length > 0 && tokens.every((t) => prof.soft.has(t.toLowerCase()));
    if (softOnly) {
      detail.push({ skill: r.skill, importance: imp, hit: true, level: null });
      continue;
    }
    let level: number | null = null;
    let softAdjacent = false;
    for (const token of tokens) {
      const canonical = matchToken(token, prof);
      if (canonical) {
        level = skillLevel(canonical, prof);
        // 追踪命中的 token 是否含软技能词：含则不算 coreHit（但正常记入 score/detail）
        softAdjacent = tokenContainsSoft(token, prof.soft);
        break;
      }
    }
    total += imp;
    if (level !== null) weighted += imp * level;
    if (imp >= 4 && level !== null && !softAdjacent) coreHit = true;
    detail.push({ skill: r.skill, importance: imp, hit: level !== null, level });
  }
  return {
    score: total ? Math.round((weighted / total) * 100) : 50,
    detail,
    coreHit,
  };
}

export function profileText(prof: EffectiveProfile): string {
  return Object.keys(prof.levels).join("/");
}
