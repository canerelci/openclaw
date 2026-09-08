// T497: onBeforePromptBuild ear wait loop must terminate on quotaRefused —
// a quota-refused ear never sets earPlan, so without the conjunct the loop
// spins the full 15s (150 x 100ms).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineInboundContext } from "./context.js";
import { onBeforePromptBuild } from "./pipeline-inbound.js";

vi.mock("./pipeline.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    logFlowStep: vi.fn(() => "fl-test"),
    sleep: vi.fn(),
  };
});

const { sleep: mockSleep } = await import("./pipeline.js");

function makeEntry(overrides: Partial<PipelineInboundContext> = {}): PipelineInboundContext {
  return {
    from: "user-1",
    channel: "telegram",
    conversationId: null,
    flowId: "fl-prompt-build-test",
    originalMessage: "hello",
    earPlan: null,
    earStarted: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

// T500: ctx with senderId so the scoped findByRecipient path is exercised.
const SENDER_CTX = { senderId: "user-1", channelId: "telegram" } as never;

function createPipeline(
  findByRecipientFn: (to?: string, channel?: string) => PipelineInboundContext | null,
) {
  return {
    cfg: {
      backendUrl: "http://localhost:0",
      internalToken: "test",
      pipeline: { disableEar: false },
    },
    ctxStore: {
      findByRecipient: findByRecipientFn,
      findLatest: vi.fn(),
      key: () => "",
      set: () => {},
      cleanupStale: () => {},
    },
    rawCfg: {},
    timezone: "UTC",
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

describe("onBeforePromptBuild ear wait — quotaRefused terminator (T497)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("case 1: quotaRefused at t=0 — loop is NOT entered", async () => {
    const entry = makeEntry({
      earStarted: true,
      earPlan: null,
      quotaRefused: { detail: "Account quota exceeded.", delivered: true },
    });
    const pipeline = createPipeline(() => entry);
    await onBeforePromptBuild(pipeline, {} as never, SENDER_CTX);
    expect((mockSleep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("case 2: quotaRefused arrives mid-loop — loop exits immediately", async () => {
    const entry = makeEntry({ earStarted: true, earPlan: null });
    let calls = 0;
    const pipeline = createPipeline(() => {
      calls++;
      if (calls >= 3) {
        entry.quotaRefused = { detail: "Account quota exceeded.", delivered: true };
      }
      return entry;
    });
    await onBeforePromptBuild(pipeline, {} as never, SENDER_CTX);
    // Exactly 2 sleep calls: the loop iterated twice before the 3rd
    // findByRecipient mutated quotaRefused and the loop condition exited.
    // Pre-fix code would spin all 150 iterations.
    expect((mockSleep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("case 3: earPlan arrives normally — loop exits on earPlan (no regression)", async () => {
    const entry = makeEntry({ earStarted: true, earPlan: null });
    let calls = 0;
    const pipeline = createPipeline(() => {
      calls++;
      if (calls >= 2) {
        entry.earPlan = { plan: "proceed" };
      }
      return entry;
    });
    await onBeforePromptBuild(pipeline, {} as never, SENDER_CTX);
    expect((mockSleep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("case 4: ear not started — loop is NOT entered", async () => {
    const entry = makeEntry({ earStarted: false, earPlan: null });
    const pipeline = createPipeline(() => entry);
    await onBeforePromptBuild(pipeline, {} as never, SENDER_CTX);
    expect((mockSleep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
