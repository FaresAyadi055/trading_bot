import { z } from "zod";

/**
 * Zod validation for decision-tree/v2.
 * Compatible with Zod 3.23+ and Zod 4.
 *
 * This validates the JSON contract and graph references. It does not execute
 * the trading strategy or validate runtime market/account calculations.
 */

const nonEmpty = z.string().min(1);
const finiteNumber = z.number().finite();
const nullableFinite = finiteNumber.nullable();
const stringList = z.array(z.string());
const bool = z.boolean();
const positive = finiteNumber.positive();
const nonNegative = finiteNumber.nonnegative();

const AssetASchema = z.object({
  enabled: bool,
  persistenceErMin: finiteNumber.optional(),
}).strict();

const AssetCSchema = z.object({
  enabled: bool,
  mode: z.enum(["disabled", "gated", "unrestricted"]).optional(),
  qualityCompressionRatio: nullableFinite.optional(),
  qualityBreakoutAtr: finiteNumber.optional(),
  avoidABreakoutAtr: nullableFinite.optional(),
}).strict();

const AssetSchema = z.object({
  enabled: bool,
  capitalInput: nonEmpty,
  strategies: z.object({
    A: AssetASchema,
    C: AssetCSchema,
  }).strict(),
  notes: z.string().optional(),
}).strict();

const ConditionOperatorSchema = z.enum([
  "eq", "gt", "gte", "lt", "lte", "between",
]);

const ConditionRightSchema = z.union([
  finiteNumber,
  z.string(),
  z.tuple([z.string(), z.string()]),
]);

const ConditionNodeSchema = z.object({
  id: nonEmpty,
  type: z.literal("cond"),
  left: nonEmpty,
  op: ConditionOperatorSchema,
  right: ConditionRightSchema,
  yes: nonEmpty,
  no: nonEmpty,
  note: z.string().optional(),
  tag: z.string().optional(),
  description: z.string().optional(),
}).strict();

const NoTradeNodeSchema = z.object({
  id: nonEmpty,
  type: z.literal("action"),
  action: z.literal("NO_TRADE"),
  reason: nonEmpty,
  description: z.string().optional(),
}).strict();

const HoldNodeSchema = z.object({
  id: nonEmpty,
  type: z.literal("action"),
  action: z.literal("HOLD"),
  reason: nonEmpty,
}).strict();

const QueueEntryNodeSchema = z.object({
  id: nonEmpty,
  type: z.literal("action"),
  action: z.literal("QUEUE_ENTRY"),
  strategy: z.enum(["A", "C"]),
  stopFrom: z.enum(["A.stop", "C.stop"]),
  stopAtrMult: nonEmpty,
  riskMultiplier: nonEmpty,
  fill: z.literal("next_bar_open"),
}).strict();

const ExitNodeSchema = z.object({
  id: nonEmpty,
  type: z.literal("action"),
  action: z.literal("EXIT"),
  exitReason: z.enum(["STOP", "HARD_STOP", "KILL", "TIME", "TRAIL"]),
}).strict();

const TightenStopNodeSchema = z.object({
  id: nonEmpty,
  type: z.literal("action"),
  action: z.literal("TIGHTEN_STOP"),
  newStopFrom: z.literal("position.killStop"),
}).strict();

export const DecisionNodeSchema = z.discriminatedUnion("type", [
  ConditionNodeSchema,
  z.discriminatedUnion("action", [
    NoTradeNodeSchema,
    HoldNodeSchema,
    QueueEntryNodeSchema,
    ExitNodeSchema,
    TightenStopNodeSchema,
  ]),
]);

const StrategyEnumSchema = z.object({
  NONE: z.literal(0),
  DONCHIAN_A: z.literal(1),
  VCEB_C: z.literal(2),
}).strict();

const ExitReasonEnumSchema = z.object({
  NONE: z.literal(0),
  STOP: z.literal(1),
  HARD_STOP: z.literal(2),
  TRAIL: z.literal(3),
  KILL: z.literal(4),
  TIME: z.literal(5),
  DRAWDOWN: z.literal(6),
}).strict();

const DecisionEnumSchema = z.object({
  NO_TRADE: z.literal(0),
  HOLD: z.literal(1),
  ENTER: z.literal(2),
  EXIT: z.literal(3),
  TIGHTEN_STOP: z.literal(4),
}).strict();

const ParamsSchema = z.object({
  data: z.object({
    warmupBars: positive,
    gapCheckBars: positive,
    requireFiniteEnabledFeatures: bool,
  }).passthrough(),

  cost: z.object({
    feeRatePerSide: nonNegative,
    slipRatePerSide: nonNegative,
    stopSlipMult: nonNegative,
    roundTripCostModel: nonEmpty,
    maxCostInR: nonNegative,
    minTargetCostMultiple: nonNegative,
    costGateAppliesTo: z.array(z.enum(["A", "C"])),
    costInputsMustBeEstimatedBeforeEntry: bool,
  }).passthrough(),

  indicators: z.object({
    atr: positive,
    bb: positive,
    bbStd: positive,
    compressionLookback: positive,
    compressionPercentile: finiteNumber.min(0).max(1),
    donchianA: positive,
    donchianC: positive,
    emaRiseLookback: positive,
    emaTrend: positive,
    persistenceErWindow: positive,
  }).passthrough(),

  strategyA: z.object({
    enabledByAsset: bool,
    donchianPeriod: positive,
    emaPeriod: positive,
    volumeMult: nullableFinite,
    initialStopAtr: positive,
    trailAtr: positive,
    trailReference: nonEmpty,
    trailTrigger: nonEmpty,
    trailExecution: nonEmpty,
  }).passthrough(),

  strategyC: z.object({
    name: nonEmpty,
    description: z.string(),
    enabledByAsset: bool,
    bbPeriod: positive,
    bbStd: positive,
    compressionLookback: positive,
    compressionPercentile: finiteNumber.min(0).max(1),
    compressionOffset: finiteNumber,
    emaRiseLookback: positive,
    breakoutLookback: positive,
    volumeMult: nullableFinite,
    initialStopAtr: positive,
    trailAtr: positive,
    trailReference: nonEmpty,
    trailExecution: nonEmpty,
    qualityCompressionRatio: nullableFinite,
    qualityBreakoutAtr: finiteNumber,
    avoidABreakoutAtr: nullableFinite,
  }).passthrough(),

  priority: z.array(z.enum(["A", "C"])).min(1),

  risk: z.object({
    riskPerTrade: finiteNumber.min(0).max(1),
    strategyMultiplier: z.object({ A: nonNegative, C: nonNegative }).strict(),
    maxPositionFraction: nonNegative,
    maxAlloc: nonNegative,
    globalHardStopAtr: positive,
    minimumNotional: nonNegative,
    allInCheckFraction: finiteNumber.min(0).max(1),
    allInRule: nonEmpty,
    killRule: nonEmpty,
    sizingCapitalField: nonEmpty,
    formula: nonEmpty,
    rejectIfStopDistanceNonPositive: bool,
    rejectIfNotionalBelowMinimum: bool,
  }).passthrough(),

  exit: z.object({
    A: z.object({
      initialStopAtr: positive,
      trailAtr: positive,
      trailReference: nonEmpty,
    }).passthrough(),
    C: z.object({
      initialStopAtr: positive,
      trailAtr: positive,
      trailReference: nonEmpty,
      trailIntrabar: bool,
    }).passthrough(),
    hardStopAtr: positive,
    maxHoldBars: positive,
  }).passthrough(),

  kill: z.object({
    enabled: bool,
    atrPercentileMin: finiteNumber.min(0).max(1),
    rNowMin: finiteNumber,
    tightenAtrMult: positive,
  }).passthrough(),

  account: z.object({
    drawdownPause: finiteNumber.min(0).max(1),
    drawdownPauseBars: positive,
    rollingLossWindowBars: positive,
    rollingRFloor: finiteNumber,
    cooldownBaseBars: nonNegative,
    cooldownAfterStopBars: nonNegative,
    cooldownMaxBars: nonNegative,
    degradation: z.object({
      enabled: bool,
      windowTrades: positive,
      minSumR: finiteNumber,
      resumeAfterBars: positive,
    }).passthrough(),
  }).passthrough(),

  capital: z.object({
    initialCapital: nonEmpty,
    perAssetIndependent: bool,
  }).passthrough(),

  gates: z.object({
    stopMinAtr: nonNegative,
    stopMaxAtr: positive,
  }).passthrough(),
}).passthrough();

const FeaturesSchema = z.object({
  market: stringList,
  candidate: z.object({
    A: stringList,
    C: stringList,
  }).passthrough(),
  account: stringList,
  position: stringList,
  execution: stringList,
}).passthrough();

const RuntimeSchema = z.object({
  evaluation: nonEmpty,
  closedCandlesOnly: bool,
  noLookahead: bool,
  sameTreeForAllAssets: bool,
  stateIsolationKey: nonEmpty,
  requiredInputs: stringList,
  capital: z.object({
    BTCUSDT: nullableFinite,
    ETHUSDT: nullableFinite,
    BNBUSDT: nullableFinite,
    SOLUSDT: nullableFinite,
  }).strict(),
  previousState: z.object({
    required: bool,
    source: nonEmpty,
    scope: nonEmpty,
    restoreBeforeEvaluation: bool,
    persistAfterEvaluation: bool,
    fields: stringList,
    staleOrMissingStatePolicy: nonEmpty,
  }).passthrough(),
}).passthrough();

const CapitalModelSchema = z.object({
  mode: z.literal("independent_per_asset"),
  capitalSource: nonEmpty,
  requiredAtRuntime: bool,
  capitalMustBePositive: bool,
  sharedCapital: z.literal(false),
  crossAssetTransfers: z.literal(false),
  allocationOwner: nonEmpty,
  treeResponsibilities: stringList,
  treeMustNot: stringList,
}).passthrough();

const ExecutionSchema = z.object({
  barOrder: stringList,
  entry: z.object({
    signalTiming: nonEmpty,
    fillTiming: nonEmpty,
    entryFillFormula: nonEmpty,
    atrForInitialStop: nonEmpty,
    AInitialStop: nonEmpty,
    CInitialStop: nonEmpty,
    hardStop: nonEmpty,
    sizing: nonEmpty,
    minimumNotional: nonNegative,
  }).passthrough(),
  positionManagement: z.object({
    A: nonEmpty,
    C: nonEmpty,
    stopFill: nonEmpty,
    hardStopPriority: nonEmpty,
    neverLoosenStop: bool,
  }).passthrough(),
  accounting: z.object({
    entryFee: nonEmpty,
    exitFee: nonEmpty,
    entrySlippage: nonEmpty,
    exitSlippage: nonEmpty,
    rMultiple: nonEmpty,
  }).passthrough(),
}).passthrough();

const StateTransitionsSchema = z.object({
  onTradeClose: stringList,
  drawdownPause: z.object({
    trigger: nonEmpty,
    durationBars: positive,
    effect: nonEmpty,
    expiry: nonEmpty,
  }).passthrough(),
  rollingLossCap: z.object({
    windowBars: positive,
    blockWhen: nonEmpty,
  }).passthrough(),
  cooldown: z.object({
    baseBars: nonNegative,
    afterStopBars: nonNegative,
    maxBars: nonNegative,
    escalateWithConsecutiveLosses: bool,
  }).passthrough(),
  degradation: z.object({
    enabled: bool,
    windowTrades: positive,
    pauseWhenSumRAtOrBelow: finiteNumber,
    resumeAfterBars: positive,
    perStrategyAndAsset: bool,
  }).passthrough(),
}).passthrough();

export const DecisionTreeSchema = z.object({
  schema: z.literal("decision-tree/v2"),
  name: nonEmpty,
  treeVersion: nonEmpty,
  description: z.string(),

  market: z.object({
    venue: nonEmpty,
    quoteAsset: nonEmpty,
    interval: nonEmpty,
    direction: z.literal("long_only"),
    leverage: z.literal(false),
  }).passthrough(),

  assets: z.object({
    BTCUSDT: AssetSchema,
    ETHUSDT: AssetSchema,
    BNBUSDT: AssetSchema,
    SOLUSDT: AssetSchema,
  }).strict(),

  capitalModel: CapitalModelSchema,
  runtime: RuntimeSchema,

  enums: z.object({
    Strategy: StrategyEnumSchema,
    ExitReason: ExitReasonEnumSchema,
    Decision: DecisionEnumSchema,
  }).strict(),

  strategyKeys: z.object({
    A: z.literal("DONCHIAN_A"),
    C: z.literal("VCEB_C"),
  }).strict(),

  params: ParamsSchema,
  features: FeaturesSchema,
  root: nonEmpty,
  nodes: z.array(DecisionNodeSchema).min(1),

  featureDefinitions: z.record(z.string(), z.string()),
  execution: ExecutionSchema,
  stateTransitions: StateTransitionsSchema,

  diagnostics: z.object({
    perAsset: stringList,
    priorityRule: nonEmpty,
    noTradeReasonTags: stringList,
    sameBarConflictDefinition: nonEmpty,
  }).passthrough(),

  validation: z.object({
    required: stringList,
    researchReferences: z.record(z.string(), finiteNumber),
  }).passthrough(),
}).strict().superRefine((tree, ctx) => {
  const ids = tree.nodes.map((node) => node.id);
  const idSet = new Set(ids);

  // Node IDs must be unique.
  ids.forEach((id, index) => {
    if (ids.indexOf(id) !== index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "id"],
        message: `Duplicate node id: ${id}`,
      });
    }
  });

  // Root and all condition branches must point to existing nodes.
  if (!idSet.has(tree.root)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["root"],
      message: `Root node "${tree.root}" does not exist in nodes`,
    });
  }

  tree.nodes.forEach((node, index) => {
    if (node.type === "cond") {
      for (const branch of ["yes", "no"] as const) {
        if (!idSet.has(node[branch])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nodes", index, branch],
            message: `Unknown node reference "${node[branch]}"`,
          });
        }
      }
    }
  });

  // Enforce consistency between entry strategy and stop source.
  tree.nodes.forEach((node, index) => {
    if (node.type === "action" && node.action === "QUEUE_ENTRY") {
      const expectedStop = node.strategy === "A" ? "A.stop" : "C.stop";
      if (node.stopFrom !== expectedStop) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "stopFrom"],
          message: `Strategy ${node.strategy} must use ${expectedStop}`,
        });
      }
    }
  });

  // The stop-distance interval must be ordered.
  if (tree.params.gates.stopMinAtr > tree.params.gates.stopMaxAtr) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["params", "gates"],
      message: "stopMinAtr cannot exceed stopMaxAtr",
    });
  }
});

export type DecisionTree = z.infer<typeof DecisionTreeSchema>;
export type DecisionNode = z.infer<typeof DecisionNodeSchema>;
export type ConditionNode = z.infer<typeof ConditionNodeSchema>;

/** Parse and validate an unknown JSON value. Throws ZodError on failure. */
export function parseDecisionTree(input: unknown): DecisionTree {
  return DecisionTreeSchema.parse(input);
}

/** Non-throwing validation helper. */
export function safeParseDecisionTree(input: unknown) {
  return DecisionTreeSchema.safeParse(input);
}
