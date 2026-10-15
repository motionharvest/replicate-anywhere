/**
 * Replicate cost estimation for the `run-model` tool.
 *
 * Replicate returns NO dollar figure in its API response. Cost is derived two ways:
 *   - Community / public models: per GPU-second  ×  the prediction's `predict_time`.
 *   - Official models:           per output (image / token / video-second).
 *
 * This table is therefore a MAINTAINED ESTIMATE — always reconcile against the real
 * numbers in your Replicate billing dashboard. Add or override entries as your usage
 * changes; any model not listed falls back to DEFAULT_PER_SECOND_USD × predict_time.
 *
 * Rates are USD as of June 2026 — verify against https://replicate.com/pricing.
 */

export type CostBasis = 'per-output' | 'per-second' | 'per-second-default' | 'unknown';

export interface ReplicateCostEstimate {
  costUsd: number | null;
  basis: CostBasis;
  rate: number | null; // $/output or $/second actually used
  predictTime: number | null;
  outputCount: number;
}

/** Replicate GPU hardware rates, USD per second (June 2026 — tune as needed). */
const HARDWARE_USD_PER_SEC: Record<string, number> = {
  cpu: 0.0001,
  t4: 0.000225,
  l40s: 0.000975,
  'a100-40gb': 0.00115,
  'a100-80gb': 0.0014,
  h100: 0.001525,
};

/** Fallback for models whose hardware/pricing we don't know. Tune to your typical mix. */
const DEFAULT_PER_SECOND_USD = HARDWARE_USD_PER_SEC['a100-80gb'];

/**
 * Per-model overrides, keyed by "owner/name" (version stripped, lowercased).
 *   - perOutput: official models billed per image/token/output.
 *   - perSecond: community models pinned to a known hardware rate.
 * EXTEND THIS with the models you actually run most.
 */
const MODEL_PRICING: Record<string, { perOutput?: number; perSecond?: number }> = {
  'black-forest-labs/flux-schnell': { perOutput: 0.003 },
  'black-forest-labs/flux-dev': { perOutput: 0.025 },
  'black-forest-labs/flux-1.1-pro': { perOutput: 0.04 },
  'stability-ai/sdxl': { perSecond: HARDWARE_USD_PER_SEC['a100-80gb'] },
};

function normalizeModel(model: string): string {
  // "owner/name:version" or "owner/name" -> "owner/name" lowercased
  return model.split(':')[0].trim().toLowerCase();
}

function countOutputs(output: unknown): number {
  if (Array.isArray(output)) return output.length || 1;
  if (output == null) return 0;
  return 1;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Estimate the USD cost of a completed Replicate prediction. Returns `costUsd: null`
 * with basis `'unknown'` when there is nothing to base an estimate on (no per-output
 * price and no predict_time), so callers never fabricate a number.
 */
export function estimateReplicateCost(params: {
  model: string;
  predictTime?: number | null;
  output?: unknown;
}): ReplicateCostEstimate {
  const outputCount = countOutputs(params.output);
  const predictTime = typeof params.predictTime === 'number' ? params.predictTime : null;
  const entry = MODEL_PRICING[normalizeModel(params.model)];

  if (entry?.perOutput != null) {
    return {
      costUsd: round(entry.perOutput * Math.max(outputCount, 1)),
      basis: 'per-output',
      rate: entry.perOutput,
      predictTime,
      outputCount,
    };
  }

  const perSec = entry?.perSecond ?? DEFAULT_PER_SECOND_USD;
  if (predictTime != null) {
    return {
      costUsd: round(perSec * predictTime),
      basis: entry?.perSecond != null ? 'per-second' : 'per-second-default',
      rate: perSec,
      predictTime,
      outputCount,
    };
  }

  return { costUsd: null, basis: 'unknown', rate: null, predictTime, outputCount };
}

/** Machine-readable marker appended to run-model output; parsed downstream for Langfuse. */
export function formatCostMarker(est: ReplicateCostEstimate): string {
  const usd = est.costUsd != null ? est.costUsd.toFixed(6) : 'unknown';
  const pt = est.predictTime != null ? est.predictTime.toFixed(2) : 'n/a';
  return `\n\n[replicate-cost] usd=${usd} predict_time=${pt} outputs=${est.outputCount} basis=${est.basis} (estimate — reconcile with Replicate billing)`;
}
