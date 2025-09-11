const fs = require('fs');
const path = require('path');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  throw new Error('better-sqlite3 未安装，请执行: npm i better-sqlite3');
}

class DBStore {
  constructor(options = {}) {
    this.baseDir = options.baseDir || process.cwd();
    this.dbPath = path.join(this.baseDir, 'data.sqlite');
    this.isOpen = false;

    // 配额
    this.maxKeysPerPlugin = Number(options.maxKeysPerPlugin || 1000);
    this.maxValueBytes = Number(options.maxValueBytes || 256 * 1024); // 256KB
  }

  ensureDir() {
    try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch {}
  }

  open() {
    if (this.isOpen) return;
    this.ensureDir();
    this.db = new Database(this.dbPath, { fileMustExist: false });
    try { this.db.pragma('journal_mode = WAL'); } catch {}
    try { this.db.pragma('synchronous = NORMAL'); } catch {}

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        plugin_id   TEXT NOT NULL,
        collection  TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT,
        updated_at  INTEGER NOT NULL,
        UNIQUE(plugin_id, collection, key)
      );
      CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv (plugin_id, collection, key);
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id  TEXT NOT NULL,
        metric     TEXT NOT NULL,
        value      REAL NOT NULL DEFAULT 1,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_lookup ON events (plugin_id, metric, ts);
    `);

    // 预编译常用语句
    this.stmtHasKey = this.db.prepare('SELECT 1 FROM kv WHERE plugin_id=? AND collection=? AND key=? LIMIT 1');
    this.stmtGetKey = this.db.prepare('SELECT value, updated_at FROM kv WHERE plugin_id=? AND collection=? AND key=?');
    this.stmtInsertOrReplace = this.db.prepare(`
      INSERT INTO kv (plugin_id, collection, key, value, updated_at)
      VALUES (@pid, @collection, @key, @value, @ts)
      ON CONFLICT(plugin_id, collection, key)
      DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    this.stmtDeleteKey = this.db.prepare('DELETE FROM kv WHERE plugin_id=? AND collection=? AND key=?');
    this.stmtCountKeys = this.db.prepare('SELECT COUNT(1) AS c FROM kv WHERE plugin_id=?');

    this.stmtListBase = (hasPrefix) => this.db.prepare(`
      SELECT key, value, updated_at
      FROM kv
      WHERE plugin_id=@pid AND collection=@collection
        ${hasPrefix ? 'AND key LIKE @like' : ''}
      ORDER BY updated_at DESC
      LIMIT @limit OFFSET @offset
    `);
    this.stmtCountBase = (hasPrefix) => this.db.prepare(`
      SELECT COUNT(1) AS c
      FROM kv
      WHERE plugin_id=@pid AND collection=@collection
        ${hasPrefix ? 'AND key LIKE @like' : ''}
    `);

    this.stmtInsertEvent = this.db.prepare('INSERT INTO events (plugin_id, metric, value, ts) VALUES (?,?,?,?)');
    this.stmtStatsRange = (fmt) => this.db.prepare(`
      SELECT strftime('${fmt}', datetime(ts,'unixepoch')) AS bucket, SUM(value) AS total
      FROM events
      WHERE plugin_id=@pid AND metric=@metric AND ts BETWEEN @from AND @to
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    this.isOpen = true;
  }

  // ========== 内部工具 ==========
  static toStringValue(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  static tryParse(value) {
    if (value == null) return value;
    try { return JSON.parse(value); } catch { return value; }
  }

  isValueWithinLimit(value) {
    const str = DBStore.toStringValue(value);
    const bytes = Buffer.byteLength(str, 'utf8');
    if (bytes > this.maxValueBytes) {
      const kb = Math.ceil(bytes / 1024);
      throw new Error(`value too large: ${kb}KB > ${Math.floor(this.maxValueBytes/1024)}KB`);
    }
    return str;
  }

  // ========== KV API ==========
  put(pluginId, collection, key, value) {
    this.open();
    if (!pluginId || !collection || !key) throw new Error('invalid payload');
    const str = this.isValueWithinLimit(value);

    const exists = !!this.stmtHasKey.get(pluginId, collection, key);
    if (!exists) {
      const row = this.stmtCountKeys.get(pluginId);
      const current = (row && row.c) || 0;
      if (current >= this.maxKeysPerPlugin) {
        throw new Error(`quota exceeded: keys >= ${this.maxKeysPerPlugin}`);
      }
    }

    const ts = Math.floor(Date.now() / 1000);
    this.stmtInsertOrReplace.run({ pid: pluginId, collection, key, value: str, ts });
    return true;
  }

  get(pluginId, collection, key) {
    this.open();
    if (!pluginId || !collection || !key) throw new Error('invalid payload');
    const row = this.stmtGetKey.get(pluginId, collection, key);
    if (!row) return null;
    return { value: DBStore.tryParse(row.value), updated_at: row.updated_at };
  }

  del(pluginId, collection, key) {
    this.open();
    if (!pluginId || !collection || !key) throw new Error('invalid payload');
    this.stmtDeleteKey.run(pluginId, collection, key);
    return true;
  }

  list(pluginId, collection, opts = {}) {
    this.open();
    const { prefix = '', limit = 50, offset = 0 } = opts || {};
    const hasPrefix = !!(prefix && String(prefix).length > 0);
    const stmt = this.stmtListBase(hasPrefix);
    const rows = stmt.all({
      pid: pluginId,
      collection,
      like: hasPrefix ? `${prefix}%` : undefined,
      limit: Math.max(0, Number(limit)||0),
      offset: Math.max(0, Number(offset)||0)
    });
    return rows.map(r => ({ key: r.key, value: DBStore.tryParse(r.value), updated_at: r.updated_at }));
  }

  count(pluginId, collection, opts = {}) {
    this.open();
    const { prefix = '' } = opts || {};
    const hasPrefix = !!(prefix && String(prefix).length > 0);
    const stmt = this.stmtCountBase(hasPrefix);
    const row = stmt.get({ pid: pluginId, collection, like: hasPrefix ? `${prefix}%` : undefined });
    return (row && row.c) || 0;
  }

  // ========== 统计 API ==========
  statsInc(pluginId, metric, value = 1, ts = Math.floor(Date.now()/1000)) {
    this.open();
    if (!pluginId || !metric) throw new Error('invalid payload');
    const v = Number(value);
    this.stmtInsertEvent.run(pluginId, String(metric), isFinite(v) ? v : 1, Number(ts)||Math.floor(Date.now()/1000));
    return true;
  }

  statsRange(pluginId, metric, from, to, groupBy = 'day') {
    this.open();
    if (!pluginId || !metric) throw new Error('invalid payload');
    const gb = groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
    const rows = this.stmtStatsRange(gb).all({
      pid: pluginId,
      metric: String(metric),
      from: Number(from)||0,
      to: Number(to)||Math.floor(Date.now()/1000)
    });
    return rows;
  }
}

module.exports = { DBStore };


