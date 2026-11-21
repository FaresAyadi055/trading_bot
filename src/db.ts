import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from './config'
import { ensureSchema } from './schema'

/**
 * Paper mode works on its own copy of the live database so simulated trades never touch the real books.
 * The copy is made once (first boot, or after `TEST_DB_RESET=1`) with `VACUUM INTO`, which is consistent even
 * when the source is in WAL mode. Without a source DB the paper account simply starts empty.
 */
function seedPaperDb(dest: string, src: string): boolean {
  if (process.env.TEST_DB_RESET === '1') {
    for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) rmSync(f, { force: true })
  }
  if (existsSync(dest)) return false
  if (!existsSync(src)) return false
  mkdirSync(dirname(dest), { recursive: true })
  const s = new Database(src, { readonly: true })
  try {
    s.exec('PRAGMA busy_timeout = 5000')
    s.run('VACUUM INTO ?', [dest])
    console.log(`[db] paper database seeded from ${src} -> ${dest}`)
    return true
  } catch (e) {
    // A running live app can hold a lock. Starting with an empty paper account is safer than refusing to boot.
    console.warn(`[db] could not copy ${src} into ${dest}: ${e instanceof Error ? e.message : e}`)
    for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) rmSync(f, { force: true })
    return false
  } finally { s.close() }
}

if (config.mode === 'test' && config.dbPath !== ':memory:') {
  // Refuse any configuration that would make the paper instance open (or TEST_DB_RESET delete) the live books.
  const paper = resolve(config.dbPath)
  if (paper === resolve(config.liveDbPath) || paper === resolve(config.paperSource)) {
    throw new Error('MODE=test must not use the live database as its working database. Set TEST_DB_PATH (default data-test/trading.sqlite).')
  }
}
const seededPaper = config.mode === 'test' && config.dbPath !== ':memory:' ? seedPaperDb(config.dbPath, config.paperSource) : false
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
export const db = new Database(config.dbPath, { create: true })
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
db.exec('PRAGMA cache_size = -2000; PRAGMA mmap_size = 0; PRAGMA temp_store = FILE;') // keep RAM small
ensureSchema(db)
// A copied live outbox must not be delivered by the paper instance.
if (seededPaper) db.query('DELETE FROM notifications').run()

export const getMeta = (k: string): string | null =>
  (db.query('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | null)?.value ?? null
export const setMeta = (k: string, v: string) =>
  db.query('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)

/** Run fn inside an immediate transaction (atomic persistence per processed bar). */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn).immediate()
}
