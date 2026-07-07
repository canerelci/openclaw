import { describe, expect, it } from "vitest";
import { FlowRegistry } from "./flow-registry.js";

describe("FlowRegistry.resolve — freshest session binding wins", () => {
  // Reproduces the prod Mina fragmentation (2026-07-08): a new inbound refreshes
  // the sessionKey binding, but the PRIOR turn's sessionId binding lingers stale.
  // With a fixed sessionId-before-sessionKey order the stale binding stole the new
  // turn; the freshest-wins rule attributes the turn to the current inbound.
  it("prefers a fresh sessionKey binding over a stale sessionId binding", () => {
    const r = new FlowRegistry();
    const sessionKey = "agent:main:telegram:1511273575";
    const sessionId = "sess-abc";

    // Prior turn: before_agent_start bound BOTH maps to the old flow.
    const prev = r.bindFlow("fl-old", "contact_message", { sessionKey, sessionId });
    // Force the old binding to look older than the new one (startedAt is Date.now()).
    (prev as { startedAt: number }).startedAt = 1_000;

    // New inbound: onMessageReceived rebinds ONLY the sessionKey (it has no sessionId).
    const fresh = r.bindFlow("fl-new", "contact_message", { sessionKey });
    (fresh as { startedAt: number }).startedAt = 2_000;

    // before_agent_start for the new turn resolves via (runId?, sessionId, sessionKey):
    // runId misses (fresh run), sessionId still points at fl-old, sessionKey at fl-new.
    const got = r.resolve(undefined, sessionId, sessionKey);
    expect(got?.flowId).toBe("fl-new");
  });

  it("runId stays exact and always wins over session fallbacks", () => {
    const r = new FlowRegistry();
    r.bindFlow("fl-run", "system", { runId: "run-1" });
    r.bindFlow("fl-session", "contact_message", { sessionKey: "sk", sessionId: "sid" });
    expect(r.resolve("run-1", "sid", "sk")?.flowId).toBe("fl-run");
  });

  it("falls back to whichever single session binding exists", () => {
    const r = new FlowRegistry();
    r.bindFlow("fl-a", "contact_message", { sessionId: "sid" });
    expect(r.resolve(undefined, "sid", "sk-none")?.flowId).toBe("fl-a");
    const r2 = new FlowRegistry();
    r2.bindFlow("fl-b", "contact_message", { sessionKey: "sk" });
    expect(r2.resolve(undefined, "sid-none", "sk")?.flowId).toBe("fl-b");
  });

  it("returns null when nothing binds (caller logs fl-unbound)", () => {
    const r = new FlowRegistry();
    expect(r.resolve("run-x", "sid-x", "sk-x")).toBeNull();
  });
});
