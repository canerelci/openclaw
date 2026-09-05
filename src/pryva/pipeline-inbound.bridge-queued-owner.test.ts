// FAILING REPRODUCTION for the T349 (e468c8c3f0) bridge staleness-window defect.
//
// Place at: src/pryva/pipeline-inbound.bridge-queued-owner.test.ts
//
// Scenario: a genuine owner message arrives while a long agent turn (2+ min) is still
// running on the same session. onMessageReceived binds the owner's flow IMMEDIATELY
// (pipeline-inbound.ts:324) — its comment states the invariant outright: "Bind IMMEDIATELY
// (before Ear) so the agent run — WHENEVER IT STARTS — resolves to this flow."
//
// But the run for that message only starts once the lane drains, i.e. >30s later. The
// staleness window added at pipeline-inbound.ts:595-597 keys on WALL-CLOCK AGE of the
// binding, and startedAt is stamped at bind time (flow-registry.ts:153) and never
// refreshed. So the bridge refuses the real owner binding and step 5 MINTS A SECOND FLOW
// for a message that already has one -> double flow_start, and the owner's turn is
// attributed to a flow that has no message_received.
//
// Expected (correct) behavior: the queued owner message keeps its original flow.
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

describe("onBeforeAgentStart — queued owner message must keep its flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT re-mint when the owner's run starts >30s after message_received", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    // 1. Owner message arrives; message_received binds its flow by sessionKey immediately.
    const ownerFlow = generateFlowId();
    registry.bindFlow(ownerFlow, "owner_message", {
      sessionKey: "agent:main:main",
      channel: "telegram",
      sender: "owner",
    });

    // 2. A long agent turn already holds the lane. The queued message waits 2 minutes.
    vi.advanceTimersByTime(120_000);

    // 3. The lane drains and the OWNER's run finally starts. A real inbound run carries
    //    trigger undefined, so it reaches the step-4 bridge.
    const ctx = {
      runId: "run-owner",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      trigger: undefined,
      channel: "telegram",
      senderId: "owner",
    } as never;
    await onBeforeAgentStart(pipeline, {} as never, ctx);

    // The owner's turn must belong to the flow message_received already minted.
    const bound = registry.getFlowForRun("run-owner");
    expect(bound).not.toBeNull();
    expect(bound!.flowId).toBe(ownerFlow); // FAILS on e468c8c3f0: a new flow is minted
    expect(bound!.source).toBe("owner_message"); // FAILS: becomes "system"
    // The bridge must NOT warn — a real inbound carries channel+sender evidence.
    expect(
      (pipeline as never as { log: { warn: ReturnType<typeof vi.fn> } }).log.warn,
    ).not.toHaveBeenCalled();
  });

  it("a self-turn still does not absorb a stale flow (the bug T349 fixed stays fixed)", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    // A stale flow from a prior turn sits on the session.
    const staleFlow = generateFlowId();
    registry.bindFlow(staleFlow, "contact_message", {
      sessionKey: "agent:main:main",
      channel: "telegram",
      sender: "owner",
    });
    vi.advanceTimersByTime(120_000);

    // A cron self-turn fires. scheduleSelfWake ALWAYS leaves a session marker when it arms
    // (inner-voice.ts:253/260), and steps 2/3b consume it BEFORE the bridge is reached —
    // which is the correct, non-time-based signal that this run is a self-turn.
    registry.setSourceHintBySession("agent:main:main", "scheduled_todo", undefined, "todo:1");

    const ctx = {
      runId: "run-selfturn",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      trigger: undefined,
    } as never;
    await onBeforeAgentStart(pipeline, {} as never, ctx);

    const bound = registry.getFlowForRun("run-selfturn");
    expect(bound).not.toBeNull();
    expect(bound!.flowId).not.toBe(staleFlow); // must NOT absorb the stale flow
    expect(bound!.source).toBe("scheduled_todo");
  });

  it("a marker-less self-turn that reaches step 4 bridges WITH a warn", async () => {
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);

    const staleFlow = generateFlowId();
    registry.bindFlow(staleFlow, "contact_message", {
      sessionKey: "agent:main:main",
      channel: "telegram",
      sender: "owner",
    });
    vi.advanceTimersByTime(120_000);

    // NO marker set — simulates a plugin calling scheduleSessionTurn directly
    // without going through scheduleSelfWake. This run reaches step 4 and bridges.
    const ctx = {
      runId: "run-no-marker",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      trigger: undefined,
    } as never;
    await onBeforeAgentStart(pipeline, {} as never, ctx);

    const bound = registry.getFlowForRun("run-no-marker");
    expect(bound).not.toBeNull();
    expect(bound!.flowId).toBe(staleFlow); // bridges (no marker to divert it)
    // The warn MUST fire — no channel/sender evidence means this is not a real inbound.
    const warn = (pipeline as never as { log: { warn: ReturnType<typeof vi.fn> } }).log.warn;
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("marker-less self-turn");
  });
});
