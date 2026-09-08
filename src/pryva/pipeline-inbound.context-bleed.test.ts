// T500: onBeforePromptBuild must scope the ear-plan lookup to the run's own
// conversation. Pre-fix, findLatest() returned the most recent entry globally,
// so a self-turn (no sender) adopted a foreign conversation's ear plan, and a
// sender-bearing run could pick up a different sender's entry if it was newer.
//
// Discriminator: on the pre-fix pipeline-inbound.ts (single-file swap), the old
// two-param function ignores the ctx argument, calls findLatest(), and these
// tests go RED on assertion failures (not compile errors — the extra arg is
// simply ignored at runtime).
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

function makeEntry(
  from: string,
  channel: string,
  overrides: Partial<PipelineInboundContext> = {},
): PipelineInboundContext {
  return {
    from,
    channel,
    conversationId: null,
    flowId: `fl-${from}`,
    originalMessage: `msg from ${from}`,
    earPlan: { intent: `intent-${from}`, key_points: [`kp-${from}`] },
    earStarted: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

type CtxStore = {
  findByRecipient: (to?: string, channel?: string) => PipelineInboundContext | null;
  findLatest: ReturnType<typeof vi.fn>;
};

function createPipeline(entries: PipelineInboundContext[]) {
  const findByRecipient = (to?: string, channel?: string): PipelineInboundContext | null => {
    if (!to) return null;
    for (const ctx of entries) {
      if (ctx.from === to && (!channel || ctx.channel === channel)) return ctx;
    }
    return null;
  };
  // findLatest returns the newest entry globally — the pre-fix behaviour.
  const findLatest = vi.fn((): PipelineInboundContext | null => {
    let best: PipelineInboundContext | null = null;
    for (const ctx of entries) {
      if (!best || ctx.timestamp > best.timestamp) best = ctx;
    }
    return best;
  });

  return {
    pipeline: {
      cfg: {
        backendUrl: "http://localhost:0",
        internalToken: "test",
        pipeline: { disableEar: false },
      },
      ctxStore: {
        findByRecipient,
        findLatest,
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
    } as never,
    findLatest,
  };
}

describe("T500: onBeforePromptBuild context-bleed prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("C-c: sender-bearing run gets only its OWN ear plan, not the newest global entry", async () => {
    // Two entries: sender A (older) and sender B (newer). A run with senderId=A
    // must get A's ear plan, not B's.
    const entryA = makeEntry("user-A", "telegram", { timestamp: Date.now() - 1000 });
    const entryB = makeEntry("user-B", "telegram", { timestamp: Date.now() });
    const { pipeline, findLatest } = createPipeline([entryA, entryB]);

    const result = await onBeforePromptBuild(
      pipeline,
      {} as never,
      { senderId: "user-A", channelId: "telegram" } as never,
    );

    // The ear plan block must contain A's intent, NOT B's.
    expect(result?.prependContext).toContain("intent-user-A");
    expect(result?.prependContext).not.toContain("intent-user-B");
    // findLatest must NOT be consulted — scoped lookup only.
    expect(findLatest).not.toHaveBeenCalled();
  });

  it("C-d: senderless run (heartbeat/cron) gets NO ear plan — no context leak", async () => {
    // A fresh entry exists in the store, but the run has no sender.
    // Pre-fix: findLatest() returns it → ear plan injected (BUG).
    // Post-fix: no senderId → lookup skipped → no ear plan.
    const entry = makeEntry("some-user", "whatsapp", { timestamp: Date.now() });
    const { pipeline, findLatest } = createPipeline([entry]);

    const result = await onBeforePromptBuild(
      pipeline,
      {} as never,
      { trigger: "heartbeat" } as never,
    );

    // Only [CURRENT TIME] should be present, no ear plan block.
    expect(result?.prependContext).not.toContain("intent-some-user");
    expect(result?.prependContext).not.toContain("[EAR ANALYSIS");
    // findLatest must NOT be consulted.
    expect(findLatest).not.toHaveBeenCalled();
  });

  it("sender-bearing run with no matching entry gets no ear plan (no fallback to findLatest)", async () => {
    const entry = makeEntry("user-X", "telegram", { timestamp: Date.now() });
    const { pipeline, findLatest } = createPipeline([entry]);

    const result = await onBeforePromptBuild(
      pipeline,
      {} as never,
      { senderId: "user-Y", channelId: "telegram" } as never,
    );

    expect(result?.prependContext).not.toContain("intent-user-X");
    expect(result?.prependContext).not.toContain("[EAR ANALYSIS");
    expect(findLatest).not.toHaveBeenCalled();
  });
});
