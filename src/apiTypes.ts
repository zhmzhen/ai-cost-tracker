/**
 * Public response types for the Cursor billing/quota fetcher.
 *
 * Kept in a leaf module so any combination of {@link "./cursor"},
 * {@link "./api"}, and the extension entrypoint can import them without
 * pulling in fs / https / sql.js as a side effect, and without creating
 * an import cycle through cursor.ts.
 */

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface Quota {
  enabled: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  usedPct: number | null;
}

export interface MonthSummary {
  fetchedAt: string;
  billingCycleStart: string;
  billingCycleEnd: string;
  membershipType: string;
  isUnlimited: boolean;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  byModel: ModelUsage[];
  individualQuota: Quota | null;
  teamQuotaPooled: Quota | null;
}

export type FetchStatus =
  | { ok: true; summary: MonthSummary }
  | { ok: false; error: FetchError };

export type FetchError =
  | "state_db_not_found"
  | "no_access_token"
  | "token_expired"
  | "invalid_token"
  | "http_error"
  | "network_error"
  | "shape_error";
