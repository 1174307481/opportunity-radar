import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 原始信息 */
export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull().default(""),
    url: text("url"),
    urlHash: text("url_hash"),
    content: text("content").notNull().default(""),
    sourceType: text("source_type").notNull().default("manual_text"), // manual_text | manual_url
    /** pending → l1_done → ready | archived | failed */
    aiStage: text("ai_stage").notNull().default("pending"),
    l1: text("l1"), // L1 路由结果 JSON
    errorMessage: text("error_message"),
    foundAt: integer("found_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("items_url_hash_uq").on(t.urlHash)]
);

/** 机会（与 item 1:1） */
export const opportunities = sqliteTable(
  "opportunities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id").notNull(),
    type: text("type").notNull().default("其他"),
    /** today | week | archived | observe（红队降级观察） */
    tier: text("tier").notNull().default("week"),
    /** 用户改档位，非空时优先于 tier */
    userTier: text("user_tier"),
    score: integer("score"),
    skillMatch: integer("skill_match"),
    skillMatchDetail: text("skill_match_detail"), // JSON
    fastTrack: integer("fast_track").notNull().default(0),
    /** new | researching | contacted | deal | ignored */
    status: text("status").notNull().default("new"),
    analysis: text("analysis"), // L2 结果 JSON
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("opp_item_uq").on(t.itemId),
    index("opp_tier_idx").on(t.tier),
  ]
);

/** 用户行为事件流（改档/改状态等，学习原料） */
export const userActions = sqliteTable("user_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  opportunityId: integer("opportunity_id").notNull(),
  action: text("action").notNull(), // view | tier_change | status_change | copied_script
  fromValue: text("from_value"),
  toValue: text("to_value"),
  createdAt: integer("created_at").notNull(),
});

/** 键值设置（画像覆盖、今天做这一件事等） */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
  updatedAt: integer("updated_at").notNull(),
});

/** 采集源（M3：适配器注册表） */
export const sources = sqliteTable(
  "sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull(), // eleduck | hn | github | ...
    enabled: integer("enabled").notNull().default(1),
    config: text("config"), // JSON：查询词/时间窗等
    lastRunAt: integer("last_run_at"),
    lastStatus: text("last_status"), // ok | error | skipped
    lastMessage: text("last_message"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("sources_key_uq").on(t.key)]
);

/** 行动账本（M3：每条行动 + 可选跟进时间） */
export const ledger = sqliteTable("ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  opportunityId: integer("opportunity_id").notNull(),
  note: text("note").notNull().default(""),
  followUpAt: integer("follow_up_at"), // 到期需跟进
  doneAt: integer("done_at"),
  createdAt: integer("created_at").notNull(),
});
