/**
 * Cursor dashboard HTTPS client + JSON assembly.
 *
 * Two endpoints; one cookie shape; no retries — the extension layer
 * decides how often to call us. The contract here is byte-identical to
 * ``token_tracker``'s ``adapters/cursor_api.py``; keep them in sync if
 * Cursor server-side changes anything about the JSON or the cookie.
 */

import * as https from "https";

import {
  type FetchStatus,
  type ModelUsage,
  type MonthSummary,
  type Quota,
} from "./apiTypes";
import { type AccessToken } from "./jwt";

const BASE = "https://cursor.com";
const USER_AGENT =
  "ai-cost-tracker-cursor/0.4 (+https://github.com/zhmzhen/ai-cost-tracker)";

class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}`);
  }
}

function postJson<T>(
  urlPath: string,
  token: AccessToken,
  body: object,
  timeoutMs: number,
): Promise<T> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  // The Cursor web client encodes the cookie as: WorkosCursorSessionToken=<sub>::<jwt>
  // We percent-encode the "::" separator to match what the browser sends.
  const cookie = `WorkosCursorSessionToken=${token.sub}%3A%3A${token.token}`;

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      `${BASE}${urlPath}`,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Accept: "application/json",
          Origin: BASE,
          Referer: `${BASE}/dashboard`,
          "User-Agent": USER_AGENT,
          Cookie: cookie,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new HttpError(status, text));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

// ----------------------------- response shapes -----------------------------

/** @internal Exported for unit tests only. */
export interface AggregatedUsageResponse {
  totalCostCents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheWriteTokens?: number;
  totalCacheReadTokens?: number;
  aggregations?: Array<{
    modelIntent?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number;
  }>;
}

/** @internal Exported for unit tests only. */
export interface UsageSummaryResponse {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  individualUsage?: { overall?: RawQuota };
  teamUsage?: { pooled?: RawQuota };
}

/** @internal Exported for unit tests only. */
export interface RawQuota {
  enabled?: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
}

// ----------------------------- shape assembly ------------------------------

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** @internal Exported for unit tests only. */
export function toQuota(raw: RawQuota | undefined): Quota | null {
  if (!raw) return null;
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit) ? raw.limit : null;
  const remaining =
    typeof raw.remaining === "number" && Number.isFinite(raw.remaining)
      ? raw.remaining
      : null;
  const used = toInt(raw.used);
  const usedPct =
    limit !== null && limit > 0 ? Math.round((used / limit) * 10000) / 100 : null;
  return { enabled: Boolean(raw.enabled), used, limit, remaining, usedPct };
}

/** @internal Exported for unit tests only. */
export function assemble(
  agg: AggregatedUsageResponse,
  summ: UsageSummaryResponse,
): MonthSummary {
  const byModel: ModelUsage[] = (agg.aggregations || []).map((a) => ({
    model: String(a.modelIntent || "unknown"),
    inputTokens: toInt(a.inputTokens),
    outputTokens: toInt(a.outputTokens),
    cacheWriteTokens: toInt(a.cacheWriteTokens),
    cacheReadTokens: toInt(a.cacheReadTokens),
    costUsd: (Number(a.totalCents) || 0) / 100,
  }));
  return {
    fetchedAt: new Date().toISOString(),
    billingCycleStart: String(summ.billingCycleStart || ""),
    billingCycleEnd: String(summ.billingCycleEnd || ""),
    membershipType: String(summ.membershipType || ""),
    isUnlimited: Boolean(summ.isUnlimited),
    totalCostUsd: (Number(agg.totalCostCents) || 0) / 100,
    totalInputTokens: toInt(agg.totalInputTokens),
    totalOutputTokens: toInt(agg.totalOutputTokens),
    totalCacheWriteTokens: toInt(agg.totalCacheWriteTokens),
    totalCacheReadTokens: toInt(agg.totalCacheReadTokens),
    byModel,
    individualQuota: toQuota(summ.individualUsage?.overall),
    teamQuotaPooled: toQuota(summ.teamUsage?.pooled),
  };
}

// ----------------------------- endpoint client -----------------------------

/**
 * Fast path: call the Cursor dashboard API with a token we already have.
 * Usually completes in well under a second; the only slow step in the whole
 * pipeline is the initial SQLite read.
 */
export async function fetchMonthSummaryWithToken(
  token: AccessToken,
  timeoutMs = 8000,
): Promise<FetchStatus> {
  try {
    const [agg, summ] = await Promise.all([
      postJson<AggregatedUsageResponse>(
        "/api/dashboard/get-aggregated-usage-events",
        token,
        {},
        timeoutMs,
      ),
      postJson<UsageSummaryResponse>(
        "/api/usage-summary",
        token,
        {},
        timeoutMs,
      ),
    ]);
    if (typeof agg !== "object" || agg === null) {
      return { ok: false, error: "shape_error" };
    }
    if (typeof summ !== "object" || summ === null) {
      return { ok: false, error: "shape_error" };
    }
    return { ok: true, summary: assemble(agg, summ) };
  } catch (e) {
    if (e instanceof HttpError) {
      return { ok: false, error: "http_error" };
    }
    return { ok: false, error: "network_error" };
  }
}
