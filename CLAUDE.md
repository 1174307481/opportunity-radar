# 项目：个人商业机会雷达（Opportunity Radar）

## 子 Agent 调度约定（重要）

本项目派子 agent（Agent 工具）时，`model` 参数使用以下模型，格式为 `glm-5.3-flash-<后缀>`：

| 后缀 | 完整模型名 |
| --- | --- |
| zxk | glm-5.3-zxk |
| xyf | glm-5.3-xyf |
| zxs | glm-5.3-zxs |
| zfg | glm-5.3-zfg |
| zjk | glm-5.3-zjk |

- 多 agent 并行时按后缀混搭分配（如 2×zxs + 2×zfg + 2×zxk），不同后缀≈不同视角。
- 主会话模型与子 agent 模型相互独立，派活时按任务性质选后缀即可。

## LLM 网关（AI 功能开发用）

- 本机环境变量已有可用网关：`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，走 Anthropic 兼容 `/v1/messages`（`x-api-key` 头）。
- 已验证可用模型：`deepseek-v4-flash`（思考型模型：thinking token 计入 `max_tokens`，L1 调用 ≥6000、L2 ≥12000；解析时只取 `type=="text"` 内容块）。
- 严禁把 key 写进代码/文档/日志，一律读环境变量。

## 关键文档

- `docs/product-design-v2.md` —— 产品设计定稿（评分三档制、接单快通道、行动工件、裁决记录 A1-A3）
- `docs/smoke-test.md` —— 假设 A 测试 + M1 端到端实测 + 3 条规则修订要点
- `docs/test-report.md` —— M2/M3 三路审查报告（黑盒 42/43、代码 3P1+10P2、产品断点）+ 修复清单
- `docs/research/05-playbook.md` —— 15 条赚钱路径 playbook，L2 提示词按 type 召回引用
- 合规红线：BOSS/闲鱼/猪八戒/拉勾等禁爬平台不爬，走人工快速录入。

## 已知坑（别再踩）

- 端口进程：lsof 看不到 next-server，杀端口用 `ss -ltnp | grep <port>` 拿 PID；重启后用新探针（如 PATCH tier:"auto"）确认构建版本。
- L2 是思考型模型：prompt 里别写「满分 40」这种词——会被当成各维上限打分（评分尺 bug 根因）。
- 思考型模型的 max_tokens 含 thinking：**合批调用必须按条数放大**（L1：6000+1500×(n-1)，上限 16000；曾用 +1000 在 n=6 时 output 顶到 10999/11000 截断）。固定值在批内多条时会被 thinking 吃光，text 块截断报「输出中未找到 JSON」——特征是 usage.output 恰好等于 maxTokens。
- **绝不让第二个进程直连 data/radar.db**：WAL 多进程并发写会 SQLITE_CORRUPT（子 agent 测试时踩过，回滚备份丢过一天数据）。测试/脚本要么 readonly 连接，要么拷贝 DB 副本，要么走 HTTP 打线上端口。
- 热点条目（sourceType `source:%-hot`）走 lib/hotspot-pipeline.ts 独立流水线，`recoverPendingItems` 已排除它们——别把热榜条目喂进 L1（会被「无需求方=噪声」规则全量判噪，这是 L1 设计正确而非 bug）。
- 技能匹配：L1 抽的词条必须过 SOFT_SKILLS 过滤（软技能不进分子不进分母）+ 括号剥离 + token 拆分 + 子串兜底，缺一环就会误杀真机会。

## 开发约定

- 单用户工具，全中文界面，不做 i18n、不做多租户、无登录（预留 ACCESS_TOKEN）。
- M1 范围：快速录入 → L1 路由 → L2 行动分析 → 三档呈现 + 该不该做 + 第一步。时限一个晚上，禁止过度设计。
- 首页原则：宁可空手绝不凑数；没有行动建议的机会不进首页。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
