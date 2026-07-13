/**
 * Pryva gateway attribution headers.
 *
 * When a tenant routes its LLM calls through the Pryva gateway (the provider baseUrl points at
 * `.../llm/<provider>/...` and the apiKey is an instance token), the gateway records every call
 * but needs to know WHO made it — so its firsthand ledger can attribute spend per source/agent.
 * We attach headers to every outbound provider request that targets the gateway:
 *
 *   X-Pryva-Caller  = "ocw"                (constant — this is the main OpenClaw agent)
 *   X-Pryva-Agent   = <agent id>           (e.g. "main"; derived from the session key)
 *   X-Pryva-Task    = <flow source>        (owner_message / heartbeat / cron / …; from the flow)
 *   X-Pryva-Flow-Id = <flow id>            (fl-…; omitted when the flow could not be resolved)
 *
 * These are additive and only emitted for gateway-bound requests, so non-gateway providers are
 * untouched. Unlike install-telemetry attribution, this is NOT gated on a telemetry setting —
 * it is billing-critical and must always be present.
 */
/** Recognise a Pryva-gateway baseUrl. The gateway mounts every provider under `/llm/<provider>`. */
export function isGatewayBaseUrl(baseUrl: string | undefined | null): boolean {
  return typeof baseUrl === "string" && baseUrl.includes("/llm/");
}

import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

type FlowLookup = {
  getFlowForSessionId?(sessionId: string): { flowId: string; source: string } | null;
  getFlowForRun?(runId: string): { flowId: string; source: string } | null;
  getFlowForSession?(sessionKey: string): { flowId: string; source: string } | null;
};

let log: SubsystemLogger | undefined;
function attributionLog(): SubsystemLogger {
  return (log ??= createSubsystemLogger("pryva"));
}

function readFlowRegistry(): FlowLookup | undefined {
  const reg = (globalThis as { __pryvaFlowRegistry?: unknown }).__pryvaFlowRegistry;
  // Duck-type on ANY lookup method, not one specific name: the published surface has grown over
  // time, and requiring exactly `getFlowForSessionId` once rejected a live registry that only
  // exposed run/sessionKey lookups — silently degrading every gateway ledger row to task=unknown.
  const lookup = reg as FlowLookup | undefined;
  if (
    lookup &&
    (typeof lookup.getFlowForRun === "function" ||
      typeof lookup.getFlowForSessionId === "function" ||
      typeof lookup.getFlowForSession === "function")
  ) {
    return lookup;
  }
  return undefined;
}

/**
 * Build the X-Pryva-* headers for a gateway-bound call. Returns undefined when the request is not
 * gateway-bound (so callers skip the spread entirely). Best-effort: missing flow context degrades
 * to "unknown" rather than dropping the header — the gateway must never see an unattributable call.
 *
 * caller is always "ocw" and agent is "main": a tenant's OpenClaw runs exactly one main agent, so
 * this is the correct constant (NCW specialists carry their own per-agent attribution). task is the
 * current flow's source (owner_message / heartbeat / cron / …). Non-message-triggered runs
 * (heartbeat/cron) bind their flow via before_agent_start keyed on runId, which can resolve BEFORE
 * the session-id binding is visible here — so try runId first, then sessionId as a fallback.
 */
export function buildGatewayAttribution(
  baseUrl: string | undefined | null,
  sessionId: string | undefined | null,
  runId?: string | null,
  sessionKey?: string | null,
): Record<string, string> | undefined {
  if (!isGatewayBaseUrl(baseUrl)) {
    return undefined;
  }
  let task = "unknown";
  let flowId: string | undefined;
  try {
    const registry = readFlowRegistry();
    // Resolution mirrors FlowRegistry.resolve: runId is per-turn exact and wins; sessionId and
    // sessionKey are session-scoped fallbacks. sessionKey matters for call sites that never learn
    // the runId (sdk.ts streamFn) and for runs whose sessionId binding lost the bind race.
    const flow =
      (runId && registry?.getFlowForRun?.(runId)) ||
      (sessionId && registry?.getFlowForSessionId?.(sessionId)) ||
      (sessionKey && registry?.getFlowForSession?.(sessionKey)) ||
      null;
    if (flow?.source) {
      task = flow.source;
    }
    if (flow?.flowId) {
      flowId = flow.flowId;
    }
    if (!flow) {
      // A gateway-bound call the ledger will meter as task=unknown. Name the miss precisely so a
      // live container log answers "which identifier failed to resolve" without a repro rebuild.
      attributionLog().warn(
        `gateway attribution unresolved (ledger will show task=unknown): registry=${registry ? "present" : "MISSING"} runId=${runId ?? "-"} sessionId=${sessionId ?? "-"} sessionKey=${sessionKey ?? "-"}`,
      );
    }
  } catch {
    // fail-open: attribution must never break a real LLM call
  }

  return {
    "X-Pryva-Caller": "ocw",
    "X-Pryva-Agent": "main",
    "X-Pryva-Task": task,
    ...(flowId ? { "X-Pryva-Flow-Id": flowId } : {}),
  };
}
