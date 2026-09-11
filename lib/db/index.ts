import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const dir = path.join(process.cwd(), "data");
fs.mkdirSync(dir, { recursive: true });

const globalForDb = globalThis as unknown as { radarSqlite?: Database.Database };

const sqlite =
  globalForDb.radarSqlite ??
  (() => {
    const d = new Database(path.join(dir, "radar.db"));
    d.pragma("journal_mode = WAL");
    return d;
  })();
globalForDb.radarSqlite = sqlite;

export const db = drizzle(sqlite, { schema });
export { sqlite };
