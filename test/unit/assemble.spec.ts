import { describe, expect, it } from "vitest";

import {
  type AggregatedUsageResponse,
  type RawQuota,
  type UsageSummaryResponse,
  assemble,
  toQuota,
} from "../../src/cursor";

describe("toQuota", () => {
  it("returns null when given undefined", () => {
    expect(toQuota(undefined)).toBeNull();
  });

  it("returns null-typed limits and zero used when given an empty object", () => {
    const q = toQuota({});
    expect(q).toEqual({
      enabled: false,
      used: 0,
      limit: null,
      remaining: null,
      usedPct: null,
    });
  });

  it("computes usedPct rounded to two decimals when a limit is present", () => {
    const q = toQuota({ enabled: true, used: 250, limit: 1000, remaining: 750 });
    expect(q?.usedPct).toBe(25);
  });

  it("rounds non-integer percentages to two decimals", () => {
    const q = toQuota({ enabled: true, used: 1, limit: 3 });
    expect(q?.usedPct).toBe(33.33);
  });

  it("returns null usedPct when limit is zero (avoids div-by-zero)", () => {
    const q = toQuota({ enabled: true, used: 0, limit: 0 });
    expect(q?.usedPct).toBeNull();
  });

  it("ignores non-finite numeric inputs", () => {
    const q = toQuota({
      enabled: true,
      used: Number.NaN as unknown as number,
      limit: Number.POSITIVE_INFINITY as unknown as number,
      remaining: Number.NEGATIVE_INFINITY as unknown as number,
    });
    expect(q?.used).toBe(0);
    expect(q?.limit).toBeNull();
    expect(q?.remaining).toBeNull();
  });

  it("coerces a missing `enabled` to false", () => {
    expect(toQuota({ used: 10, limit: 100 })?.enabled).toBe(false);
  });
});

const SAMPLE_AGG: AggregatedUsageResponse = {
  totalCostCents: 34427,
  totalInputTokens: 1200,
  totalOutputTokens: 800,
  totalCacheWriteTokens: 50,
  totalCacheReadTokens: 30,
  aggregations: [
    {
      modelIntent: "claude-sonnet-4",
      inputTokens: 1000,
      outputTokens: 600,
      cacheWriteTokens: 40,
      cacheReadTokens: 20,
      totalCents: 30000,
    },
    {
      modelIntent: "gpt-5",
      inputTokens: 200,
      outputTokens: 200,
      cacheWriteTokens: 10,
      cacheReadTokens: 10,
      totalCents: 4427,
    },
  ],
};

const SAMPLE_SUMM: UsageSummaryResponse = {
  billingCycleStart: "2026-05-01",
  billingCycleEnd: "2026-05-31",
  membershipType: "Business",
  isUnlimited: false,
  individualUsage: {
    overall: { enabled: true, used: 250, limit: 1000, remaining: 750 } satisfies RawQuota,
  },
  teamUsage: {
    pooled: { enabled: true, used: 10, limit: 100, remaining: 90 } satisfies RawQuota,
  },
};

describe("assemble", () => {
  it("converts cents to USD with two-decimal precision", () => {
    const s = assemble(SAMPLE_AGG, SAMPLE_SUMM);
    expect(s.totalCostUsd).toBeCloseTo(344.27, 2);
    expect(s.byModel[0].costUsd).toBeCloseTo(300, 2);
    expect(s.byModel[1].costUsd).toBeCloseTo(44.27, 2);
  });

  it("forwards top-level token counts as integers", () => {
    const s = assemble(SAMPLE_AGG, SAMPLE_SUMM);
    expect(s.totalInputTokens).toBe(1200);
    expect(s.totalOutputTokens).toBe(800);
    expect(s.totalCacheWriteTokens).toBe(50);
    expect(s.totalCacheReadTokens).toBe(30);
  });

  it("forwards billing cycle and membership verbatim", () => {
    const s = assemble(SAMPLE_AGG, SAMPLE_SUMM);
    expect(s.billingCycleStart).toBe("2026-05-01");
    expect(s.billingCycleEnd).toBe("2026-05-31");
    expect(s.membershipType).toBe("Business");
    expect(s.isUnlimited).toBe(false);
  });

  it("derives both individual and team quotas via toQuota", () => {
    const s = assemble(SAMPLE_AGG, SAMPLE_SUMM);
    expect(s.individualQuota?.usedPct).toBe(25);
    expect(s.teamQuotaPooled?.usedPct).toBe(10);
  });

  it("stamps fetchedAt with an ISO-8601 string", () => {
    const s = assemble(SAMPLE_AGG, SAMPLE_SUMM);
    expect(new Date(s.fetchedAt).toString()).not.toBe("Invalid Date");
  });

  it("handles empty aggregations array safely", () => {
    const s = assemble({}, {});
    expect(s.byModel).toEqual([]);
    expect(s.totalCostUsd).toBe(0);
    expect(s.totalInputTokens).toBe(0);
    expect(s.individualQuota).toBeNull();
    expect(s.teamQuotaPooled).toBeNull();
    expect(s.membershipType).toBe("");
  });

  it("coerces a missing modelIntent to 'unknown'", () => {
    const s = assemble(
      { aggregations: [{ totalCents: 100, inputTokens: 1 }] },
      {},
    );
    expect(s.byModel[0].model).toBe("unknown");
  });

  it("uses 0 for tokens that arrive as null/undefined", () => {
    const s = assemble(
      { aggregations: [{ modelIntent: "x", totalCents: 100 }] },
      {},
    );
    expect(s.byModel[0].inputTokens).toBe(0);
    expect(s.byModel[0].outputTokens).toBe(0);
  });
});
