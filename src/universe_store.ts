// Persistence for the dynamic universe: the selected list + every evaluated candidate's data.
// The max size is configurable through the API and stored in meta (`universe_max_assets`).
import { db, tx, getMeta, setMeta } from './db'
import { P } from './params'
import type { UniverseRow } from './universe'

const clampMax = (n: number) => Math.max(1, Math.min(500, Math.floor(n)))

export function getUniverseMax(): number {
  const v = Number(getMeta('universe_max_assets') ?? P.universe.maxDefault)
  return clampMax(Number.isFinite(v) && v > 0 ? v : P.universe.maxDefault)
}
export function setUniverseMax(n: number): number {
  const v = clampMax(n)
  setMeta('universe_max_assets', String(v))
  return v
}

interface RawRow { symbol: string; selected: number; rank: number | null; metrics: string; reason: string; updated_at: number; added_at: number | null }
const parse = (r: RawRow): UniverseRow => ({ ...JSON.parse(r.metrics), symbol: r.symbol, rank: r.rank, selected: r.selected === 1, reason: r.reason, updatedAt: r.updated_at })

export function universeRows(onlySelected = false): UniverseRow[] {
  const rows = db.query(`SELECT symbol, selected, rank, metrics, reason, updated_at, added_at FROM universe${onlySelected ? ' WHERE selected=1' : ''} ORDER BY COALESCE(rank, 1000000), symbol`).all() as RawRow[]
  return rows.map(parse)
}
export const selectedUniverse = (): string[] => universeRows(true).map((r) => r.symbol)

/** Replace the whole universe snapshot. `added_at` is preserved for members that stay selected. */
export function saveUniverse(rows: UniverseRow[], selected: string[]) {
  const chosen = new Set(selected)
  const now = Date.now()
  const prev = new Map((db.query('SELECT symbol, added_at FROM universe').all() as { symbol: string; added_at: number | null }[]).map((r) => [r.symbol, r.added_at]))
  tx(() => {
    db.query('DELETE FROM universe').run()
    const ins = db.query('INSERT INTO universe(symbol,selected,rank,metrics,reason,updated_at,added_at) VALUES(?,?,?,?,?,?,?)')
    for (const r of rows) {
      const sel = chosen.has(r.symbol)
      const added = sel ? (prev.get(r.symbol) ?? now) : null
      const { symbol, rank, selected: _s, reason, updatedAt, ...metrics } = r
      ins.run(symbol, sel ? 1 : 0, rank, JSON.stringify(metrics), reason, updatedAt ?? now, added)
    }
    setMeta('universe_updated_at', String(now))
  })
}

export const universeUpdatedAt = (): number | null => Number(getMeta('universe_updated_at') ?? 0) || null
export const universeUpdatedBar = (): number | null => (getMeta('universe_updated_bar') == null ? null : Number(getMeta('universe_updated_bar')))
export function markUniverseBar(bar: number) { setMeta('universe_updated_bar', String(bar)) }

/** Funnel counts of the last scan, for the status endpoint / daily Telegram summary. */
export interface UniverseFunnel {
  total: number
  eligible: number
  volumeOk: number
  historyOk: number
  selected: number
  maxAssets: number
  updatedAt: number | null
}
export function universeFunnel(): UniverseFunnel {
  const rows = universeRows()
  const count = (key: string) => Number(getMeta(key) ?? 0) || 0
  return {
    total: count('universe_total_symbols'),
    eligible: count('universe_eligible_symbols'),
    volumeOk: rows.length,
    historyOk: rows.filter((r) => r.historyOk).length,
    selected: rows.filter((r) => r.selected).length,
    maxAssets: getUniverseMax(),
    updatedAt: universeUpdatedAt() ?? (rows.length ? Math.max(...rows.map((r) => r.updatedAt)) : null),
  }
}

/** Drop one symbol from the selected list (delisting / not trading). Never touches the stored candles. */
export function deselectSymbol(symbol: string, reason: string) {
  db.query('UPDATE universe SET selected=0, reason=?, updated_at=? WHERE symbol=?').run(reason, Date.now(), symbol)
}

export function universeStatus() {
  const all = universeRows()
  const sel = all.filter((r) => r.selected)
  return {
    maxAssets: getUniverseMax(),
    updatedAt: universeUpdatedAt(),
    updatedBar: universeUpdatedBar(),
    selected: sel.map((r) => r.symbol),
    candidates: all.length,
    rows: all,
  }
}
