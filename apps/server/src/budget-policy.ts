import type { PolicyEvent, PolicyEventType, RunUsage } from "./types.js";

/**
 * Budget policy: pure decision logic for the per-Agent token budget.
 *
 * This module owns the *decision*; AgentService owns *when* it is consulted
 * (before a Run is admitted) and *what happens* when it denies (no Run is
 * created, no Runtime container starts, a 429 is returned to the caller).
 */

export interface BudgetSubject {
  tokenBudget: number | null;
  tokensUsed: number;
}

export interface BudgetDecision {
  allowed: boolean;
  remaining: number | null;
  detail: string;
}

/** Sum the billable tokens reported by the Runtime for one Run. */
export function tokensFromUsage(usage: RunUsage | null | undefined): number {
  if (!usage) return 0;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Decide whether an Agent may admit another Run under its current budget. */
export function evaluateBudget(subject: BudgetSubject): BudgetDecision {
  if (subject.tokenBudget === null) {
    return { allowed: true, remaining: null, detail: "No budget configured; run admitted" };
  }
  const remaining = subject.tokenBudget - subject.tokensUsed;
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining,
      detail:
        "Token budget exhausted: used " +
        subject.tokensUsed +
        " of " +
        subject.tokenBudget +
        ". Reset the budget to resume.",
    };
  }
  return {
    allowed: true,
    remaining,
    detail: "Run admitted; " + remaining + " of " + subject.tokenBudget + " tokens remaining",
  };
}

export function makePolicyEvent(
  id: string,
  agentId: string,
  runId: string | null,
  type: PolicyEventType,
  subject: BudgetSubject,
  detail: string,
  createdAt: string,
): PolicyEvent {
  return {
    id,
    agentId,
    runId,
    type,
    tokensUsed: subject.tokensUsed,
    tokenBudget: subject.tokenBudget,
    detail,
    createdAt,
  };
}
