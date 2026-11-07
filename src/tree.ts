import raw from '../bot/decision_tree.json'
import { parseDecisionTree, type DecisionNode } from '../bot/decision-tree.schema'

/** Validated once at boot; a malformed tree stops the app (fail closed). */
export const tree = parseDecisionTree(raw)
const nodes = new Map<string, DecisionNode>(tree.nodes.map((n) => [n.id, n]))

type Inputs = Record<string, any>
const dig = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o)
const resolve = (v: unknown, inputs: Inputs): unknown =>
  typeof v === 'string' ? (v.startsWith('@') ? dig(tree.params, v.slice(1)) : dig(inputs, v)) : v

function compare(op: string, l: unknown, r: unknown, inputs: Inputs): boolean {
  const a = Number(l)
  if (!Number.isFinite(a)) return false // fail closed on missing / non-finite inputs
  if (op === 'between') {
    const [lo, hi] = (r as [string, string]).map((x) => Number(resolve(x, inputs)))
    return Number.isFinite(lo) && Number.isFinite(hi) && a >= lo! && a <= hi!
  }
  const b = Number(resolve(r, inputs))
  if (!Number.isFinite(b)) return false
  switch (op) {
    case 'eq': return a === b
    case 'gt': return a > b
    case 'gte': return a >= b
    case 'lt': return a < b
    case 'lte': return a <= b
  }
  return false
}

export type ActionNode = Extract<DecisionNode, { type: 'action' }>
export interface TreeResult { node: ActionNode; path: string[] }

/** Walk the JSON decision tree from root to an action node using the supplied feature inputs. */
export function runTree(inputs: Inputs): TreeResult {
  const path: string[] = []
  let id = tree.root
  for (let guard = 0; guard < 200; guard++) {
    const n = nodes.get(id)
    if (!n) throw new Error(`decision tree: unknown node ${id}`)
    path.push(id)
    if (n.type === 'action') return { node: n, path }
    id = compare(n.op, dig(inputs, n.left), n.right, inputs) ? n.yes : n.no
  }
  throw new Error('decision tree: cycle detected')
}

export const params = tree.params
export const assetCfg = (symbol: string) => {
  const a = (tree.assets as Record<string, (typeof tree.assets)['BTCUSDT']>)[symbol]
  if (!a) throw new Error(`unsupported asset ${symbol}`)
  const A = a.strategies.A
  const C = a.strategies.C
  return {
    enabled: a.enabled,
    A: { enabled: A.enabled, persistenceErMin: A.persistenceErMin ?? null },
    C: {
      enabled: C.enabled && C.mode !== 'disabled',
      qualityCompressionRatio: C.qualityCompressionRatio ?? null,
      qualityBreakoutAtr: C.qualityBreakoutAtr ?? 0,
      avoidABreakoutAtr: C.avoidABreakoutAtr ?? null,
    },
  }
}
