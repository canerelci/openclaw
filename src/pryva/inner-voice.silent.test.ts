// Covers the Pryva silent self-turn gate: a background self-turn must be STRUCTURALLY unable to
// reach any channel (deliveryMode "none"), while still running tools and keeping flow attribution.
import { describe, expect, it, vi } from "vitest";
import { FlowRegistry } from "./flow-registry.js";
import { publishSelfTurn, scheduleSelfWake } from "./inner-voice.js";

type ScheduleParams = {
  sessionKey: string;
  message: string;
  deliveryMode?: "none" | "announce";
  deleteAfterRun?: boolean;
  bestEffort?: boolean;
  omitPromptHeader?: boolean;
  tag?: string;
};

function createStubPipeline() {
  const scheduled: ScheduleParams[] = [];
  const registry = new FlowRegistry();
  const setSourceHintBySession = vi.spyOn(registry, "setSourceHintBySession");
  const attachExternalFlowBySession = vi.spyOn(registry, "attachExternalFlowBySession");
  const pipeline = {
    registry,
    cfg: { backendUrl: "http://localhost:0" },
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    scheduleSessionTurn: vi.fn(async (params: ScheduleParams) => {
      scheduled.push(params);
      return { id: "job-1" };
    }),
  };
  return {
    pipeline: pipeline as never,
    scheduled,
    setSourceHintBySession,
    attachExternalFlowBySession,
  };
}

describe("scheduleSelfWake — silent self-turns", () => {
  it("schedules a silent turn with deliveryMode none", async () => {
    const { pipeline, scheduled } = createStubPipeline();

    const armed = await scheduleSelfWake(pipeline, {
      sessionKey: "agent:main:main",
      thought: "tidy up the backlog",
      source: "scheduled_todo",
      reason: "todo:42",
      tag: "pryva-scheduled-todo",
      silent: true,
    });

    expect(armed).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.deliveryMode).toBe("none");
  });

  it("keeps deliveryMode announce for a normal (non-silent) turn", async () => {
    const { pipeline, scheduled } = createStubPipeline();

    await scheduleSelfWake(pipeline, {
      sessionKey: "agent:main:main",
      thought: "say hello",
      source: "inner_voice",
      reason: "first_contact_followup",
      tag: "pryva-inner-voice",
    });

    expect(scheduled[0]?.deliveryMode).toBe("announce");
  });

  it("treats silent:false exactly like an unset flag", async () => {
    const { pipeline, scheduled } = createStubPipeline();

    await scheduleSelfWake(pipeline, {
      sessionKey: "agent:main:main",
      thought: "say hello",
      source: "inner_voice",
      reason: "first_contact_followup",
      tag: "pryva-inner-voice",
      silent: false,
    });

    expect(scheduled[0]?.deliveryMode).toBe("announce");
  });

  it("changes nothing else about the scheduled turn — the thought still runs as a real turn", async () => {
    const { pipeline, scheduled } = createStubPipeline();

    await scheduleSelfWake(pipeline, {
      sessionKey: "agent:main:main",
      thought: "reconcile the catalog",
      source: "scheduled_todo",
      reason: "todo:7",
      tag: "pryva-scheduled-todo",
      silent: true,
    });

    const params = scheduled[0];
    // The framed thought is still the prompt (tools/model work is unaffected by delivery mode).
    expect(params?.message).toContain("## YOUR INNER VOICE SAYS");
    expect(params?.message).toContain("reconcile the catalog");
    expect(params?.sessionKey).toBe("agent:main:main");
    expect(params?.deleteAfterRun).toBe(true);
    expect(params?.omitPromptHeader).toBe(true);
    expect(params?.tag).toBe("pryva-scheduled-todo");
  });

  it("keeps flow attribution unchanged for a silent turn (new child flow via source hint)", async () => {
    const { pipeline, setSourceHintBySession } = createStubPipeline();

    await scheduleSelfWake(pipeline, {
      sessionKey: "agent:main:main",
      thought: "background bookkeeping",
      source: "scheduled_todo",
      reason: "todo:9",
      tag: "pryva-scheduled-todo",
      parentFlowId: "fl-abcdef123456",
      silent: true,
    });

    expect(setSourceHintBySession).toHaveBeenCalledWith(
      "agent:main:main",
      "scheduled_todo",
      "fl-abcdef123456",
      "todo:9",
    );
  });

  it("keeps flow_resume attribution unchanged for a silent turn", async () => {
    const { pipeline, attachExternalFlowBySession, scheduled } = createStubPipeline();

    await scheduleSelfWake(pipeline, {
      sessionKey: "agent:main:main",
      thought: "the job finished",
      source: "ncw_completion",
      reason: "ncw_completion",
      tag: "pryva-scheduled-todo",
      resumeFlowId: "fl-111122223333",
      silent: true,
    });

    expect(attachExternalFlowBySession).toHaveBeenCalledWith(
      "agent:main:main",
      "fl-111122223333",
      "ncw_completion",
      "fl-111122223333",
    );
    expect(scheduled[0]?.deliveryMode).toBe("none");
  });
});

describe("publishSelfTurn — threads silent through to the scheduler", () => {
  const SELF_TURN_KEY = "__pryvaSelfTurn";

  async function withPublishedSelfTurn(
    run: (
      selfTurn: (req: Record<string, unknown>) => Promise<boolean>,
      scheduled: ScheduleParams[],
    ) => Promise<void>,
  ) {
    const g = globalThis as Record<string, unknown>;
    const previous = g[SELF_TURN_KEY];
    delete g[SELF_TURN_KEY];
    try {
      const { pipeline, scheduled } = createStubPipeline();
      publishSelfTurn(pipeline);
      const fn = g[SELF_TURN_KEY] as (req: Record<string, unknown>) => Promise<boolean>;
      expect(typeof fn).toBe("function");
      await run(fn, scheduled);
    } finally {
      if (previous === undefined) {
        delete g[SELF_TURN_KEY];
      } else {
        g[SELF_TURN_KEY] = previous;
      }
    }
  }

  it("forwards silent:true as deliveryMode none", async () => {
    await withPublishedSelfTurn(async (selfTurn, scheduled) => {
      const armed = await selfTurn({
        sessionKey: "agent:main:main",
        thought: "background work",
        source: "scheduled_todo",
        silent: true,
      });
      expect(armed).toBe(true);
      expect(scheduled[0]?.deliveryMode).toBe("none");
    });
  });

  it("leaves a request without silent on announce", async () => {
    await withPublishedSelfTurn(async (selfTurn, scheduled) => {
      await selfTurn({
        sessionKey: "agent:main:main",
        thought: "tell the owner",
        source: "scheduled_todo",
      });
      expect(scheduled[0]?.deliveryMode).toBe("announce");
    });
  });
});
