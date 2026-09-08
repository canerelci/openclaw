// T493: quota gate must fail CLOSED — block whenever a refusal was decided,
// regardless of delivery outcome. Normal turns (no refusal) must proceed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineInboundContext } from "./context.js";
import { onBeforeAgentRun } from "./pipeline-inbound.js";

vi.mock("./pipeline.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    logFlowStep: vi.fn(() => "fl-test"),
    sleep: vi.fn(),
  };
});

const { logFlowStep, sleep: mockSleep } = await import("./pipeline.js");

function makeEntry(overrides: Partial<PipelineInboundContext> = {}): PipelineInboundContext {
  return {
    from: "user-1",
    channel: "telegram",
    conversationId: null,
    flowId: "fl-quota-test",
    originalMessage: "hello",
    earPlan: null,
    earStarted: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createPipeline(entry?: PipelineInboundContext) {
  return {
    cfg: {
      backendUrl: "http://localhost:0",
      internalToken: "test",
      pipeline: { disableEar: true },
    },
    ctxStore: {
      findByRecipient: () => entry ?? undefined,
      findLatest: () => entry ?? undefined,
      key: () => "",
      set: () => {},
      cleanupStale: () => {},
    },
    rawCfg: {},
    registry: {
      bindFlow: vi.fn(),
      getFlowForRun: () => null,
      resolve: () => null,
      consumeExternalFlow: () => null,
      consumeExternalFlowBySession: () => null,
      consumeSourceHint: () => null,
      consumeSourceHintBySession: () => null,
    },
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    scheduleSessionTurn: vi.fn(),
  } as never;
}

let caseN = 0;
function uniqueCase() {
  caseN++;
  return {
    event: { prompt: `msg-${caseN}`, senderId: `user-${caseN}`, channelId: "telegram" } as never,
    ctx: { sessionKey: `telegram:user-${caseN}` } as never,
    sender: `user-${caseN}`,
  };
}

describe("quota gate — fail closed (T493)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("case 1: no refusal decided — normal turn PROCEEDS", async () => {
    const { event, ctx } = uniqueCase();
    const entry = makeEntry();
    const pipeline = createPipeline(entry);
    const result = await onBeforeAgentRun(pipeline, event, ctx);
    expect(result?.outcome).not.toBe("block");
  });

  it("case 2: refusal decided, delivery confirmed — BLOCKS", async () => {
    const { event, ctx } = uniqueCase();
    const entry = makeEntry({
      quotaRefused: { detail: "Account quota exceeded.", delivered: true },
    });
    const pipeline = createPipeline(entry);
    const result = await onBeforeAgentRun(pipeline, event, ctx);
    expect(result).toMatchObject({
      outcome: "block",
      category: "quota",
    });
    expect(result!.reason).toContain("delivered");
    expect(logFlowStep).not.toHaveBeenCalled();
  });

  it("case 3a: refusal decided, delivery FAILED — BLOCKS + alarm", async () => {
    const { event, ctx } = uniqueCase();
    const entry = makeEntry({
      quotaRefused: { detail: "Account quota exceeded.", delivered: false },
    });
    const pipeline = createPipeline(entry);
    const result = await onBeforeAgentRun(pipeline, event, ctx);
    expect(result).toMatchObject({
      outcome: "block",
      category: "quota",
    });
    expect(result!.reason).toContain("undelivered");
    expect(logFlowStep).toHaveBeenCalledWith(
      pipeline,
      { flowId: "fl-quota-test" },
      expect.objectContaining({
        step_name: "quota_refusal_undelivered",
        step_type: "alarm",
        status: "error",
        metadata: expect.objectContaining({ reason: "send_failed" }),
      }),
    );
  });

  it("case 3b: refusal decided, delivery TIMED OUT — BLOCKS + alarm", async () => {
    const { event, ctx } = uniqueCase();
    const entry = makeEntry({
      quotaRefused: { detail: "Account quota exceeded." },
    });
    const pipeline = createPipeline(entry);
    const result = await onBeforeAgentRun(pipeline, event, ctx);
    expect(result).toMatchObject({
      outcome: "block",
      category: "quota",
    });
    expect(result!.reason).toContain("undelivered");
    expect(logFlowStep).toHaveBeenCalledWith(
      pipeline,
      { flowId: "fl-quota-test" },
      expect.objectContaining({
        step_name: "quota_refusal_undelivered",
        step_type: "alarm",
        status: "error",
        metadata: expect.objectContaining({ reason: "timeout" }),
      }),
    );
  });
});
