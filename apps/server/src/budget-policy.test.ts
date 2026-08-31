import { describe, expect, it } from "vitest";
import { evaluateBudget, tokensFromUsage } from "./budget-policy.js";

describe("budget policy decisions", () => {
  it("admits every run when no budget is configured", () => {
    const decision = evaluateBudget({ tokenBudget: null, tokensUsed: 999_999 });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBeNull();
  });

  it("admits a run while tokens remain and reports the remainder", () => {
    const decision = evaluateBudget({ tokenBudget: 100, tokensUsed: 40 });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(60);
  });

  it("denies a run once the meter reaches or exceeds the limit", () => {
    expect(evaluateBudget({ tokenBudget: 100, tokensUsed: 100 }).allowed).toBe(false);
    expect(evaluateBudget({ tokenBudget: 100, tokensUsed: 130 }).allowed).toBe(false);
  });

  it("counts input and output tokens and ignores missing usage", () => {
    expect(tokensFromUsage(null)).toBe(0);
    expect(tokensFromUsage({ inputTokens: 12 })).toBe(12);
    expect(tokensFromUsage({ inputTokens: 12, outputTokens: 5, cachedInputTokens: 3 })).toBe(17);
  });
});
