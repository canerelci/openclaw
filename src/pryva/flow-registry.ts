/**
 * Structural flow registry — the single source of truth for flow identity.
 *
 * A "flow" is the complete tree of work caused by exactly ONE trigger (an inbound
 * channel message, a heartbeat tick, a cron job, …). Flow identity here is
 * STRUCTURAL, not heuristic: the instant a trigger creates a flow, its id is
 * bound to the run's structural identifiers (runId / sessionKey / sessionId),
 * and every later step — LLM turn, tool call, outbound message — resolves back
 * to that SAME id through the identifiers already on its own event. There is no
 * "most recent flow in the last 5 minutes" guessing (that roulette is the bug
 * this replaces; see `_docs/_plans/flawless-flow.md` RC1).
 *
 * Minting a flow id (`generateFlowId`) is allowed in EXACTLY two places, both in
 * pipeline-inbound.ts:
 *   1. `onMessageReceived` — every inbound channel message.
 *   2. `onBeforeAgentStart` — non-message-triggered runs (heartbeat / cron /
 *      system / followup), OR a continuation of an externally-supplied flow
 *      (NCW completion, D5).
 * Plus `bindExternalFlow` (C1) for a run that carries an externally-supplied
 * `pryvaFlowId`. Nowhere else mints.
 *
 * A step that cannot be structurally bound is logged under the reserved id
 * `fl-unbound` with `metadata.unbound=true` + a WARN. `fl-unbound` is an ALARM,
 * not a flow: its target count is ZERO. It exists so a missing binding path is
 * LOUD instead of hidden behind a freshly-minted fake id. Never paper over an
 * unbound step by minting a real-looking flow — fix the binding path.
 */

import { generateFlowId } from "./flow.js";

/** What kind of trigger started (or resumed) a flow. §0 of flawless-flow.md. */
export type FlowSource =
  | "owner_message"
  | "contact_message"
  | "internal_chat"
  | "heartbeat"
  | "cron"
  | "followup"
  | "system"
  // `ncw_completion` is only ever a flow_resume source (an NCW agent finishing
  // re-enters the SAME flow — it is never a new trigger).
  | "ncw_completion";

/** A flow's structural binding to a run/session. */
export type FlowBinding = {
  flowId: string;
  source: FlowSource;
  channel?: string;
  sender?: string;
  startedAt: number;
  parentFlowId?: string;
};

/** A pending external-flow attachment for a run not yet bound (D5 NCW continuation). */
type PendingExternal = {
  flowId: string;
  source: FlowSource;
  parentFlowId?: string;
  /** NCW agent name + job id, surfaced on the `flow_resume` step (C2). */
  agent?: string;
  jobId?: string;
};

/** Reserved id for steps that could not be structurally bound (an ALARM, not a flow). */
export const UNBOUND_FLOW_ID = "fl-unbound";

const TTL_MS = 90 * 60 * 1000; // GC only — NEVER consulted by resolution.
const GC_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The flow registry. One instance lives on the PryvaPipeline and is published
 * read-only on `globalThis.__pryvaFlowRegistry` (C1) so per-flavor extensions
 * can READ the flow for a session without ever minting their own id.
 */
export class FlowRegistry {
  /** runId → binding (per-turn exact). */
  private readonly runs = new Map<string, FlowBinding>();
  /** sessionKey → binding (inbound-minted flows; survives the pre-run window). */
  private readonly sessionBindings = new Map<string, FlowBinding>();
  /** sessionId → binding (telemetry resolution fallback). */
  private readonly sessionIdBindings = new Map<string, FlowBinding>();
  /** runId → externally-supplied flow, consumed at before_agent_start (D5). */
  private readonly pendingExternal = new Map<string, PendingExternal>();
  /** runId → forced source, consumed at before_agent_start (D6 followup drain). */
  private readonly sourceHints = new Map<string, FlowSource>();
  /**
   * sessionKey → externally-supplied flow, consumed at before_agent_start (D5).
   * Used when the caller knows the SESSION but not the runId yet — e.g. a
   * gateway `sessions.send`/`sessions.steer` carrying `pryvaFlowId`: the run is
   * started for that session and its before_agent_start re-enters the flow.
   */
  private readonly pendingExternalBySession = new Map<string, PendingExternal>();
  private lastGc = Date.now();

  /**
   * Bind a flow id to a run/session. The primary bind primitive — call this
   * immediately after minting (or when binding an external flow). Indexes the
   * binding under every structural identifier supplied so resolution can find it
   * from any of them.
   */
  bindFlow(
    flowId: string,
    source: FlowSource,
    opts: {
      runId?: string;
      sessionKey?: string;
      sessionId?: string;
      channel?: string;
      sender?: string;
      parentFlowId?: string;
    } = {},
  ): FlowBinding {
    const binding: FlowBinding = {
      flowId,
      source,
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.sender ? { sender: opts.sender } : {}),
      ...(opts.parentFlowId ? { parentFlowId: opts.parentFlowId } : {}),
      startedAt: Date.now(),
    };
    if (opts.runId) this.runs.set(opts.runId, binding);
    if (opts.sessionKey) this.sessionBindings.set(opts.sessionKey, binding);
    if (opts.sessionId) this.sessionIdBindings.set(opts.sessionId, binding);
    this.maybeGc();
    return binding;
  }

  /** Attach an externally-supplied flow to a run before/when it starts (D5). */
  attachExternalFlow(
    runId: string,
    flowId: string,
    source: FlowSource,
    parentFlowId?: string,
    agent?: string,
    jobId?: string,
  ): void {
    this.pendingExternal.set(runId, { flowId, source, parentFlowId, agent, jobId });
  }

  /** Attach an external flow keyed by SESSION (D5) — for callers that know the
   *  session but not the runId (gateway sessions.send/steer with pryvaFlowId). */
  attachExternalFlowBySession(
    sessionKey: string,
    flowId: string,
    source: FlowSource,
    parentFlowId?: string,
    agent?: string,
    jobId?: string,
  ): void {
    this.pendingExternalBySession.set(sessionKey, { flowId, source, parentFlowId, agent, jobId });
  }

  /** Take + clear a session-keyed external-flow attachment, if any (idempotent). */
  consumeExternalFlowBySession(sessionKey: string | undefined): PendingExternal | undefined {
    if (!sessionKey) return undefined;
    const p = this.pendingExternalBySession.get(sessionKey);
    if (p) this.pendingExternalBySession.delete(sessionKey);
    return p;
  }

  /** Force the source a fresh run will be minted with (D6 followup drain). */
  setSourceHint(runId: string, source: FlowSource): void {
    this.sourceHints.set(runId, source);
  }

  /** Take + clear a pending external-flow attachment, if any (idempotent). */
  consumeExternalFlow(runId: string): PendingExternal | undefined {
    const p = this.pendingExternal.get(runId);
    if (p) this.pendingExternal.delete(runId);
    return p;
  }

  /** Take + clear a forced source hint, if any (idempotent). */
  consumeSourceHint(runId: string): FlowSource | undefined {
    const s = this.sourceHints.get(runId);
    if (s) this.sourceHints.delete(runId);
    return s;
  }

  /** Bind a run to an EXISTING externally-supplied flow (C1 public surface, D5). */
  bindExternalFlow(runId: string, flowId: string, source: FlowSource, parentFlowId?: string): void {
    this.bindFlow(flowId, source, { runId, parentFlowId });
  }

  getFlowForRun(runId: string): FlowBinding | null {
    return this.runs.get(runId) ?? null;
  }

  /** C1 surface: the flow bound to a session (read by flavor extensions). */
  getFlowForSession(sessionKey: string): { flowId: string; source: FlowSource } | null {
    const b = this.sessionBindings.get(sessionKey);
    return b ? { flowId: b.flowId, source: b.source } : null;
  }

  getFlowForSessionId(sessionId: string): FlowBinding | null {
    return this.sessionIdBindings.get(sessionId) ?? null;
  }

  /**
   * Structural resolution for a telemetry/outbound step. Order matters: runId is
   * per-turn-exact; sessionId narrows; sessionKey is the broadest fallback (the
   * pre-run inbound binding). Returns the binding, or null when nothing binds —
   * the caller then logs `fl-unbound` + WARN (never mints a fake id).
   */
  resolve(runId?: string, sessionId?: string, sessionKey?: string): FlowBinding | null {
    if (runId) {
      const b = this.runs.get(runId);
      if (b) return b;
    }
    if (sessionId) {
      const b = this.sessionIdBindings.get(sessionId);
      if (b) return b;
    }
    if (sessionKey) {
      const b = this.sessionBindings.get(sessionKey);
      if (b) return b;
    }
    return null;
  }

  /** GC evictions — TTL only, NEVER consulted by resolution. */
  gc(): void {
    const now = Date.now();
    const cutoff = now - TTL_MS;
    for (const [runId, b] of this.runs) {
      if (b.startedAt < cutoff) this.runs.delete(runId);
    }
    for (const [sk, b] of this.sessionBindings) {
      if (b.startedAt < cutoff) this.sessionBindings.delete(sk);
    }
    for (const [sid, b] of this.sessionIdBindings) {
      if (b.startedAt < cutoff) this.sessionIdBindings.delete(sid);
    }
    this.lastGc = now;
  }

  private maybeGc(): void {
    if (Date.now() - this.lastGc < GC_INTERVAL_MS) return;
    this.gc();
  }
}

/**
 * Map an agent-run trigger string to a flow source (D1.2 normalizeTrigger). Real
 * trigger strings observed in src/auto-reply + src/cron: "user", "heartbeat"
 * (via params.isHeartbeat), "cron", "budget", "memory", "diagnostics", "manual",
 * "export-trajectory". "user" with NO channel binding (no message_received) is an
 * unattributed run (a followup drain is tagged explicitly via setSourceHint, not
 * via trigger) → surface as `system` rather than masquerading as an owner message.
 */
export function normalizeTrigger(trigger: string | undefined): FlowSource {
  switch (trigger) {
    case "heartbeat":
      return "heartbeat";
    case "cron":
      return "cron";
    case "budget":
    case "memory":
    case "diagnostics":
    case "manual":
    case "export-trajectory":
      return "system";
    default:
      return "system";
  }
}

// ---- C1: read-only surface published on globalThis for flavor extensions ----

export type PryvaFlowRegistryGlobal = {
  getFlowForSession(sessionKey: string): { flowId: string; source: FlowSource } | null;
  getFlowForRun(runId: string): FlowBinding | null;
  bindExternalFlow(runId: string, flowId: string, source: FlowSource, parentFlowId?: string): void;
  /** D5: attach an external flow by SESSION so a gateway sessions.send/steer run
   *  re-enters that flow. Consumed at before_agent_start. */
  attachExternalFlowBySession(
    sessionKey: string,
    flowId: string,
    source: FlowSource,
    parentFlowId?: string,
  ): void;
};

const GLOBAL_KEY = "__pryvaFlowRegistry";

/**
 * Publish a read-only view of the registry on globalThis so per-flavor extensions
 * (which run in the same plugin process) can READ the flow for a session without
 * minting. The native pipeline resolves structurally regardless; this surface
 * only lets extensions stop minting duplicate ids (D2).
 */
export function publishFlowRegistry(registry: FlowRegistry): PryvaFlowRegistryGlobal {
  const surface: PryvaFlowRegistryGlobal = {
    getFlowForSession: (sessionKey: string) => registry.getFlowForSession(sessionKey),
    getFlowForRun: (runId: string) => registry.getFlowForRun(runId),
    bindExternalFlow: (runId, flowId, source, parentFlowId) =>
      registry.bindExternalFlow(runId, flowId, source, parentFlowId),
    attachExternalFlowBySession: (sessionKey, flowId, source, parentFlowId) =>
      registry.attachExternalFlowBySession(sessionKey, flowId, source, parentFlowId),
  };
  try {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = surface;
  } catch {
    // globalThis assignment can fail in locked-down runtimes; non-fatal — the
    // native pipeline still resolves structurally, the extension just can't read.
  }
  return surface;
}

export function getGlobalFlowRegistry(): PryvaFlowRegistryGlobal | null {
  return ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as PryvaFlowRegistryGlobal) ?? null;
}

export { generateFlowId };
