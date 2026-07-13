import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayAttribution, isGatewayBaseUrl } from "./gateway-attribution.js";

type FlowLookup = {
  getFlowForSessionId(sessionId: string): { flowId: string; source: string } | null;
  getFlowForRun?(runId: string): { flowId: string; source: string } | null;
};

function publishFakeRegistry(reg: FlowLookup | undefined) {
  (globalThis as { __pryvaFlowRegistry?: unknown }).__pryvaFlowRegistry = reg;
}

afterEach(() => {
  publishFakeRegistry(undefined);
});

describe("isGatewayBaseUrl", () => {
  it("recognizes a Pryva-gateway baseUrl", () => {
    expect(isGatewayBaseUrl("https://gw.pryva.internal/llm/groq/v1")).toBe(true);
  });

  it("rejects a non-gateway baseUrl", () => {
    expect(isGatewayBaseUrl("https://api.groq.com/openai/v1")).toBe(false);
    expect(isGatewayBaseUrl(undefined)).toBe(false);
    expect(isGatewayBaseUrl(null)).toBe(false);
  });
});

describe("buildGatewayAttribution", () => {
  const gatewayUrl = "https://gw.pryva.internal/llm/groq/v1";

  it("returns undefined for a non-gateway baseUrl regardless of flow state", () => {
    publishFakeRegistry({
      getFlowForSessionId: () => ({ flowId: "fl-abc", source: "heartbeat" }),
      getFlowForRun: () => ({ flowId: "fl-abc", source: "heartbeat" }),
    });
    expect(
      buildGatewayAttribution("https://api.groq.com/openai/v1", "sess-1", "run-1"),
    ).toBeUndefined();
  });

  it("resolves task + flow id from the flow bound to runId, preferring it over sessionId", () => {
    publishFakeRegistry({
      getFlowForSessionId: () => ({ flowId: "fl-stale", source: "owner_message" }),
      getFlowForRun: (runId) =>
        runId === "run-1" ? { flowId: "fl-heartbeat", source: "heartbeat" } : null,
    });
    const headers = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1");
    expect(headers).toEqual({
      "X-Pryva-Caller": "ocw",
      "X-Pryva-Agent": "main",
      "X-Pryva-Task": "heartbeat",
      "X-Pryva-Flow-Id": "fl-heartbeat",
    });
  });

  it("falls back to sessionId when runId is not (yet) bound", () => {
    publishFakeRegistry({
      getFlowForSessionId: (sessionId) =>
        sessionId === "sess-1" ? { flowId: "fl-session", source: "cron" } : null,
      getFlowForRun: () => null,
    });
    const headers = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1");
    expect(headers?.["X-Pryva-Task"]).toBe("cron");
    expect(headers?.["X-Pryva-Flow-Id"]).toBe("fl-session");
  });

  it("degrades to unknown (never drops the header) when nothing resolves, and omits flow id", () => {
    publishFakeRegistry({
      getFlowForSessionId: () => null,
      getFlowForRun: () => null,
    });
    const headers = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1");
    expect(headers).toEqual({
      "X-Pryva-Caller": "ocw",
      "X-Pryva-Agent": "main",
      "X-Pryva-Task": "unknown",
    });
    expect(headers).not.toHaveProperty("X-Pryva-Flow-Id");
  });

  it("degrades to unknown fail-open when the registry is not published", () => {
    publishFakeRegistry(undefined);
    const headers = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1");
    expect(headers?.["X-Pryva-Task"]).toBe("unknown");
  });

  it("reflects a flow bound AFTER an earlier lookup missed — proves callers must resolve per-call, not once", () => {
    // Simulates the real bug: before_agent_start binds the flow only moments after the streamFn
    // is constructed. A caller that snapshots buildGatewayAttribution() once at build time would
    // freeze "unknown" forever; a caller that re-invokes it at actual call time sees the bind.
    const runs = new Map<string, { flowId: string; source: string }>();
    publishFakeRegistry({
      getFlowForSessionId: () => null,
      getFlowForRun: (runId) => runs.get(runId) ?? null,
    });

    const early = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1");
    expect(early?.["X-Pryva-Task"]).toBe("unknown");
    expect(early).not.toHaveProperty("X-Pryva-Flow-Id");

    runs.set("run-1", { flowId: "fl-heartbeat", source: "heartbeat" });

    const late = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1");
    expect(late?.["X-Pryva-Task"]).toBe("heartbeat");
    expect(late?.["X-Pryva-Flow-Id"]).toBe("fl-heartbeat");
  });

  it("fails open (never throws) when the registry lookup itself throws", () => {
    publishFakeRegistry({
      getFlowForSessionId: () => {
        throw new Error("boom");
      },
      getFlowForRun: () => {
        throw new Error("boom");
      },
    });
    expect(() => buildGatewayAttribution(gatewayUrl, "sess-1", "run-1")).not.toThrow();
    expect(buildGatewayAttribution(gatewayUrl, "sess-1", "run-1")?.["X-Pryva-Task"]).toBe(
      "unknown",
    );
  });

  it("accepts a surface WITHOUT getFlowForSessionId (the pre-fix live shape) and resolves via runId", () => {
    // Regression: the published global once lacked getFlowForSessionId, and the duck-type check
    // required exactly that method — so the live registry was rejected and EVERY gateway call
    // metered as task=unknown even though the flow was bound. Any lookup method must qualify.
    publishFakeRegistry({
      getFlowForRun: (runId) =>
        runId === "run-1" ? { flowId: "fl-heartbeat", source: "heartbeat" } : null,
    } as never);
    const headers = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1");
    expect(headers?.["X-Pryva-Task"]).toBe("heartbeat");
    expect(headers?.["X-Pryva-Flow-Id"]).toBe("fl-heartbeat");
  });

  it("falls back to sessionKey when neither runId nor sessionId is bound", () => {
    publishFakeRegistry({
      getFlowForSessionId: () => null,
      getFlowForRun: () => null,
      getFlowForSession: (sessionKey: string) =>
        sessionKey === "agent:main:main" ? { flowId: "fl-hb", source: "heartbeat" } : null,
    } as never);
    const headers = buildGatewayAttribution(gatewayUrl, "sess-1", "run-1", "agent:main:main");
    expect(headers?.["X-Pryva-Task"]).toBe("heartbeat");
    expect(headers?.["X-Pryva-Flow-Id"]).toBe("fl-hb");
  });

  it("resolves through the REAL published registry surface (publishFlowRegistry) end to end", async () => {
    // The exact integration that broke live: FlowRegistry binds a heartbeat flow, the pipeline
    // publishes the read-only surface, and attribution must resolve through THAT surface — not
    // through a test double with a friendlier shape.
    const { FlowRegistry, publishFlowRegistry } = await import("./flow-registry.js");
    const registry = new FlowRegistry();
    registry.bindFlow("fl-live", "heartbeat", {
      runId: "run-live",
      sessionKey: "agent:main:main",
      sessionId: "sess-live",
    });
    publishFlowRegistry(registry);
    expect(buildGatewayAttribution(gatewayUrl, "sess-live", "run-live")).toEqual({
      "X-Pryva-Caller": "ocw",
      "X-Pryva-Agent": "main",
      "X-Pryva-Task": "heartbeat",
      "X-Pryva-Flow-Id": "fl-live",
    });
    // sessionId-only call site (sdk.ts streamFn) must resolve too.
    expect(buildGatewayAttribution(gatewayUrl, "sess-live")?.["X-Pryva-Task"]).toBe("heartbeat");
    // sessionKey-only resolution (no runId/sessionId) must resolve as well.
    expect(
      buildGatewayAttribution(gatewayUrl, undefined, undefined, "agent:main:main")?.[
        "X-Pryva-Task"
      ],
    ).toBe("heartbeat");
  });
});
