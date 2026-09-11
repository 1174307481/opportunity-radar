#!/usr/bin/env bash
# 每日 SQLite 在线备份（WAL 安全），保留 14 天
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/backups
node -e "
const db = require('better-sqlite3')('data/radar.db');
db.backup('data/backups/radar-' + new Date().toISOString().slice(0,10) + '.db')
  .then(() => console.log('backup ok'))
  .catch((e) => { console.error(e); process.exit(1); });
"
find data/backups -name 'radar-*.db' -mtime +14 -delete
