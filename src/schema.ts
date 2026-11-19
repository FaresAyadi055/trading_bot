import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { migrate, SCHEMA_VERSION } from './migrate'

/** Create / upgrade the schema. Safe to run on every boot and on a database of any earlier version. */
export function ensureSchema(db: Database): void {
  const hasMeta = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()
  const prev = hasMeta ? Number((db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | null)?.value ?? 0) : null
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  if (prev !== null && prev > 0 && prev < SCHEMA_VERSION) migrate(db, prev)
}
