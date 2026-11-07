import { Database } from 'bun:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config'

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
export const db = new Database(config.dbPath, { create: true })
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
db.exec('PRAGMA cache_size = -2000; PRAGMA mmap_size = 0; PRAGMA temp_store = FILE;') // keep RAM small
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))

export const getMeta = (k: string): string | null =>
  (db.query('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | null)?.value ?? null
export const setMeta = (k: string, v: string) =>
  db.query('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)

/** Run fn inside an immediate transaction (atomic persistence per processed bar). */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn).immediate()
}
