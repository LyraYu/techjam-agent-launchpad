import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

/** Every run reports 17 billable tokens (12 in + 5 out). */
class MeteredRunner implements AgentRunner {
  calls = 0;
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls += 1;
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "metered-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeFixture(runner: AgentRunner = new MeteredRunner()) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-budget-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const databasePath = path.join(root, "data", "db.json");
  const service = new AgentService(
    config,
    new JsonStore(databasePath),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return { service, config, databasePath, root };
}

describe("Token budget middleware", () => {
  it("admits, charges, denies, and recovers after a reset", async () => {
    const runner = new MeteredRunner();
    const { service } = await makeFixture(runner);
    const agent = await service.createAgent({ name: "Metered", tokenBudget: 30 });
    expect(agent.tokenBudget).toBe(30);
    expect(agent.tokensUsed).toBe(0);

    // Normal case: first run is admitted and charged 17 tokens.
    const first = await service.sendMessage(agent.id, "first task");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).tokensUsed).toBe(17);

    // Second run is still admitted (13 remaining) and pushes the meter to 34 > 30.
    const second = await service.sendMessage(agent.id, "second task");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).tokensUsed).toBe(34);

    // Denial case: the third run is refused at the control plane.
    await expect(service.sendMessage(agent.id, "third task")).rejects.toMatchObject({
      statusCode: 429,
    });
    // Nothing leaked past the boundary: no Run, no message, no Runtime call.
    expect(runner.calls).toBe(2);
    expect(service.getRuns(agent.id)).toHaveLength(2);
    expect(service.getMessages(agent.id)).toHaveLength(4);
    expect(service.getAgent(agent.id).status).toBe("ready");

    // Evidence: the ledger records every decision in order.
    const types = service
      .getPolicyEvents(agent.id)
      .map((event) => event.type)
      .reverse();
    expect(types).toEqual([
      "budget.allowed",
      "budget.charged",
      "budget.allowed",
      "budget.charged",
      "budget.denied",
    ]);
    const denied = service.getPolicyEvents(agent.id)[0];
    expect(denied?.runId).toBeNull();
    expect(denied?.tokensUsed).toBe(34);

    // Recovery case: an operator reset clears the meter and runs resume.
    const reset = await service.resetBudget(agent.id, { tokenBudget: 50 });
    expect(reset.tokensUsed).toBe(0);
    expect(reset.tokenBudget).toBe(50);
    const fourth = await service.sendMessage(agent.id, "fourth task");
    await expect.poll(() => service.getRun(fourth.run.id).status).toBe("completed");
    expect(runner.calls).toBe(3);
    expect(service.getPolicyEvents(agent.id)[0]?.type).toBe("budget.charged");
  });

  it("does not meter or deny an Agent without a budget", async () => {
    const runner = new MeteredRunner();
    const { service } = await makeFixture(runner);
    const agent = await service.createAgent({ name: "Unlimited" });
    for (const prompt of ["a", "b", "c"]) {
      const { run } = await service.sendMessage(agent.id, prompt);
      await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    }
    expect(runner.calls).toBe(3);
    expect(service.getAgent(agent.id).tokensUsed).toBe(51);
    expect(service.getPolicyEvents(agent.id).every((event) => event.type !== "budget.denied"))
      .toBe(true);
  });

  it("refuses a reset while a run is active", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { service } = await makeFixture({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy", tokenBudget: 10 });
    const { run } = await service.sendMessage(agent.id, "long task");
    await expect(service.resetBudget(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    finish({ output: "done", threadId: "t", usage: { inputTokens: 1, outputTokens: 1 } });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("records an unmetered event when a run fails without usage", async () => {
    const { service } = await makeFixture({
      run: async () => {
        throw new Error("codex exited with code 1");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Flaky", tokenBudget: 100 });
    const { run } = await service.sendMessage(agent.id, "will fail");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getAgent(agent.id).tokensUsed).toBe(0);
    const latest = service.getPolicyEvents(agent.id)[0];
    expect(latest?.type).toBe("budget.unmetered");
    expect(latest?.runId).toBe(run.id);
    expect(latest?.detail).toContain("no tokens were charged");
  });

  it("upgrades a pre-middleware database file with safe defaults", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-legacy-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "db.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Legacy",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: path.join(root, "workspaces", "legacy"),
            codexThreadId: null,
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [],
      }),
    );
    const store = new JsonStore(databasePath);
    await store.initialize();
    const legacy = store.snapshot().agents[0];
    expect(legacy?.tokenBudget).toBeNull();
    expect(legacy?.tokensUsed).toBe(0);
    expect(store.snapshot().policyEvents).toEqual([]);
    expect(JSON.parse(await readFile(databasePath, "utf8")).version).toBe(1);
  });

  it("enforces the budget at the HTTP boundary and exposes the ledger", async () => {
    const { service, config } = await makeFixture();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Http", tokenBudget: 10 },
    });
    expect(created.statusCode).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;

    const admitted = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "do work" },
    });
    expect(admitted.statusCode).toBe(202);
    const runId = (admitted.json() as { run: { id: string } }).run.id;
    await expect.poll(() => service.getRun(runId).status).toBe("completed");

    const denied = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "more work" },
    });
    expect(denied.statusCode).toBe(429);
    expect((denied.json() as { error: string }).error).toContain("exhausted");

    const ledger = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/policy-events",
    });
    expect(ledger.statusCode).toBe(200);
    expect((ledger.json() as { events: unknown[] }).events).toHaveLength(3);

    const reset = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/budget/reset",
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { agent: { tokensUsed: number } }).agent.tokensUsed).toBe(0);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Bad", tokenBudget: -5 },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});
