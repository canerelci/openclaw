// Regression test for the session-flow bridge (T349 C566, updated T350).
// Self-turns with consume-once markers (step 3b) never reach the bridge;
// queued inbounds always bridge regardless of age.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowRegistry, generateFlowId } from "./flow-registry.js";
import { onBeforeAgentStart } from "./pipeline-inbound.js";

function createStubPipeline(registry: FlowRegistry) {
  return {
    registry,
    cfg: { backendUrl: "http://localhost:0", pipeline: { disableEar: true } },
    ctxStore: {
      findByRecipient: () => undefined,
      findLatest: () => undefined,
      key: () => "",
      set: () => {},
      cleanupStale: () => {},
    },
    rawCfg: {},
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    scheduleSessionTurn: vi.fn(),
  } as never;
}

function makeCtx(
  overrides: Partial<{
    runId: string;
    sessionKey: string;
    sessionId: string;
    trigger: string | undefined;
    channel: string;
    senderId: string;
  }> = {},
) {
  return {
    runId: overrides.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: overrides.sessionKey ?? "agent:main:main",
    sessionId: overrides.sessionId ?? "sess-1",
    trigger: overrides.trigger,
    channel: overrides.channel,
    senderId: overrides.senderId,
  } as never;
}

describe("onBeforeAgentStart — bridge staleness guard (C566)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bridges a fresh binding (inbound race <30s)", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    const flowId = generateFlowId();
    registry.bindFlow(flowId, "contact_message", {
      sessionKey: "agent:main:main",
      channel: "telegram",
      sender: "user-1",
    });

    // 5 seconds later — well within the 30s race window
    vi.advanceTimersByTime(5_000);

    const ctx = makeCtx({ runId: "run-bridge", trigger: undefined });
    await onBeforeAgentStart(pipeline, {} as never, ctx);

    const bound = registry.getFlowForRun("run-bridge");
    expect(bound).not.toBeNull();
    expect(bound!.flowId).toBe(flowId);
  });

  it("a self-turn with a source hint does NOT bridge — consumed at step 3b, gets its own flow", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    const staleFlowId = generateFlowId();
    registry.bindFlow(staleFlowId, "contact_message", {
      sessionKey: "agent:main:main",
      channel: "telegram",
      sender: "user-1",
    });

    vi.advanceTimersByTime(60_000);

    // A cron self-turn always leaves a consume-once marker (inner-voice.ts:252-261)
    registry.setSourceHintBySession("agent:main:main", "scheduled_todo", undefined, "todo:1");

    const ctx = makeCtx({ runId: "run-cron-1", trigger: undefined });
    await onBeforeAgentStart(pipeline, {} as never, ctx);

    const bound = registry.getFlowForRun("run-cron-1");
    expect(bound).not.toBeNull();
    expect(bound!.flowId).not.toBe(staleFlowId);
    expect(bound!.source).toBe("scheduled_todo");
  });

  it("three sequential self-turns (with markers) never share a flow (the sticky-bridge regression)", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    // Simulate a prior inbound that bound a flow to this session 10 minutes ago
    const oldFlowId = generateFlowId();
    registry.bindFlow(oldFlowId, "owner_message", {
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      channel: "telegram",
      sender: "owner",
    });

    vi.advanceTimersByTime(10 * 60_000);

    // Three cron self-turns fire sequentially — each leaves a consume-once marker
    // (inner-voice.ts:252-261), consumed at step 3b before the bridge is reached.
    const flowIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      registry.setSourceHintBySession("agent:main:main", "scheduled_todo", undefined, `todo:${i}`);
      const runId = `run-self-${i}`;
      const ctx = makeCtx({ runId, trigger: undefined, sessionId: "sess-1" });
      await onBeforeAgentStart(pipeline, {} as never, ctx);

      const bound = registry.getFlowForRun(runId);
      expect(bound).not.toBeNull();
      flowIds.push(bound!.flowId);

      // Each self-turn is 4 minutes apart
      vi.advanceTimersByTime(4 * 60_000);
    }

    // All three must have DIFFERENT flow ids — none bridged onto the stale owner_message flow
    expect(new Set(flowIds).size).toBe(3);
    for (const fid of flowIds) {
      expect(fid).not.toBe(oldFlowId);
    }
  });

  it("still bridges correctly for a rapid inbound race (trigger=undefined, binding <1s old)", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    const inboundFlowId = generateFlowId();
    registry.bindFlow(inboundFlowId, "contact_message", {
      sessionKey: "agent:main:main",
      channel: "telegram",
      sender: "user-2",
    });

    // 200ms later — the genuine message_received → before_agent_start race
    vi.advanceTimersByTime(200);

    const ctx = makeCtx({ runId: "run-inbound-race", trigger: undefined });
    await onBeforeAgentStart(pipeline, {} as never, ctx);

    const bound = registry.getFlowForRun("run-inbound-race");
    expect(bound).not.toBeNull();
    expect(bound!.flowId).toBe(inboundFlowId);
  });

  it("trigger=heartbeat still skips the bridge regardless of binding age", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    const freshFlowId = generateFlowId();
    registry.bindFlow(freshFlowId, "contact_message", {
      sessionKey: "agent:main:main",
    });

    // Even with a FRESH binding, a heartbeat trigger must not bridge
    vi.advanceTimersByTime(100);

    const ctx = makeCtx({ runId: "run-heartbeat", trigger: "heartbeat" });
    await onBeforeAgentStart(pipeline, {} as never, ctx);

    const bound = registry.getFlowForRun("run-heartbeat");
    expect(bound).not.toBeNull();
    expect(bound!.flowId).not.toBe(freshFlowId);
    expect(bound!.source).toBe("heartbeat");
  });
});
