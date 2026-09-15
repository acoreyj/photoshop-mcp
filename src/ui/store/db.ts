import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPhotoshopMcpHomeDir } from '../../lib/export-paths.js';

const DATA_DIR = getPhotoshopMcpHomeDir();
const DB_PATH = join(DATA_DIR, 'data.db');

let instance: DatabaseType | null = null;
let loadError: Error | null = null;

export function getDB(): DatabaseType {
  if (instance) return instance;
  if (loadError) throw loadError;
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    instance = db;
    return db;
  } catch (err) {
    loadError = err instanceof Error ? err : new Error(String(err));
    throw loadError;
  }
}

export function closeDB(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
  loadError = null;
}

function migrate(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      session_id  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getDataDir(): string {
  return DATA_DIR;
}

export function getDBPath(): string {
  return DB_PATH;
}
