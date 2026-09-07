/**
 * Regression guard (T413/C695): runToolLifecycle must derive isError from a
 * resolved tool result's own isError field, not hardcode false.
 *
 * This exercises the CALL SITE in embedded-agent-subscribe.ts — the derivation
 * at the resolved path — rather than handleToolExecutionEnd with a pre-set flag
 * (which the existing predicate tests already cover).
 *
 * To isolate the call site from the predicate fix (isToolResultError also
 * honours isError after T410), the test mocks isToolResultError to always
 * return false. That way the ONLY path that can detect isError:true on the
 * result is the call-site derivation at embedded-agent-subscribe.ts:1354-1357.
 * Reverting that hunk makes this test fail even with the predicate fix present.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => true),
    runAfterToolCall: vi.fn(async () => {}),
    runBeforeToolCall: vi.fn(async () => {}),
  },
}));

const originalToolsModule = vi.hoisted(() => ({
  isToolResultError: vi.fn(() => false),
}));

vi.hoisted(() => {
  vi.stubGlobal("fetch", vi.fn());
});

let subscribeEmbeddedAgentSession: typeof import("./embedded-agent-subscribe.js").subscribeEmbeddedAgentSession;

async function loadModules() {
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => hookMocks.runner,
    loadHookRunnerGlobal: async () => ({
      getGlobalHookRunner: () => hookMocks.runner,
    }),
  }));
  vi.doMock("../infra/agent-events.js", () => ({
    emitAgentCommandOutputEvent: vi.fn(),
    emitAgentEvent: vi.fn(),
    emitAgentItemEvent: vi.fn(),
  }));
  vi.doMock("./agent-tools.before-tool-call.state.js", () => ({
    consumeAdjustedParamsForToolCall: vi.fn(() => undefined),
    consumePreExecutionBlockedToolCall: vi.fn(() => false),
    consumeStructuredReplaySafeToolCall: vi.fn(() => false),
  }));
  vi.doMock("./agent-tools.before-tool-call.js", () => ({
    BeforeToolCallBlockedError: class extends Error {},
    buildBlockedToolResult: vi.fn(),
    consumeAdjustedParamsForToolCall: vi.fn(() => undefined),
    consumePreExecutionBlockedToolCall: vi.fn(() => false),
    recordAdjustedParamsForToolCall: vi.fn(),
    recordStructuredReplayTrustForToolCall: vi.fn(),
    isBeforeToolCallBlockedError: () => false,
    isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
    runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
      blocked: false,
      params,
    })),
  }));

  const realTools = await vi.importActual<typeof import("./embedded-agent-subscribe.tools.js")>(
    "./embedded-agent-subscribe.tools.js",
  );
  vi.doMock("./embedded-agent-subscribe.tools.js", () => ({
    ...realTools,
    isToolResultError: originalToolsModule.isToolResultError,
  }));

  ({ subscribeEmbeddedAgentSession } = await import("./embedded-agent-subscribe.js"));
}

function createMinimalSession() {
  return {
    subscribe: vi.fn(() => vi.fn()),
    sessionManager: {},
    isCompacting: false,
    abortCompaction: vi.fn(),
    messages: [],
  };
}

describe("runToolLifecycle call-site derives isError from the result (T413)", () => {
  beforeAll(loadModules);

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    originalToolsModule.isToolResultError.mockClear();
    originalToolsModule.isToolResultError.mockReturnValue(false);
  });

  it("after_tool_call receives error SET when execute() resolves with isError:true", async () => {
    const session = createMinimalSession();
    const sub = subscribeEmbeddedAgentSession({
      session: session as never,
      runId: "t413-test",
      hookRunner: hookMocks.runner as never,
    });

    const toolResult = {
      content: [{ type: "text" as const, text: "Error: Pryva SMM API GET /smm/calendar -> 422" }],
      isError: true,
    };

    await sub.runToolLifecycle({
      toolName: "select_calendar",
      toolCallId: "t413-call-1",
      args: {},
      execute: async () => toolResult,
    });

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    const hookEvent = hookMocks.runner.runAfterToolCall.mock.calls[0]?.[0] as
      | { error?: unknown }
      | undefined;
    expect(hookEvent?.error).toBeDefined();
    expect(typeof hookEvent?.error).toBe("string");

    sub.unsubscribe();
  });

  it("after_tool_call receives error UNDEFINED when execute() resolves without isError", async () => {
    const session = createMinimalSession();
    const sub = subscribeEmbeddedAgentSession({
      session: session as never,
      runId: "t413-test-ok",
      hookRunner: hookMocks.runner as never,
    });

    const toolResult = {
      content: [{ type: "text" as const, text: "Calendar entries: ..." }],
    };

    await sub.runToolLifecycle({
      toolName: "select_calendar",
      toolCallId: "t413-call-2",
      args: {},
      execute: async () => toolResult,
    });

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    const hookEvent = hookMocks.runner.runAfterToolCall.mock.calls[0]?.[0] as
      | { error?: unknown }
      | undefined;
    expect(hookEvent?.error).toBeUndefined();

    sub.unsubscribe();
  });

  it("after_tool_call receives error UNDEFINED when execute() resolves with isError:false", async () => {
    const session = createMinimalSession();
    const sub = subscribeEmbeddedAgentSession({
      session: session as never,
      runId: "t413-test-explicit-false",
      hookRunner: hookMocks.runner as never,
    });

    const toolResult = {
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
    };

    await sub.runToolLifecycle({
      toolName: "select_calendar",
      toolCallId: "t413-call-3",
      args: {},
      execute: async () => toolResult,
    });

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    const hookEvent = hookMocks.runner.runAfterToolCall.mock.calls[0]?.[0] as
      | { error?: unknown }
      | undefined;
    expect(hookEvent?.error).toBeUndefined();

    sub.unsubscribe();
  });
});
