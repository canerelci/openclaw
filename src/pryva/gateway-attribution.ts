/**
 * Pryva gateway attribution headers.
 *
 * When a tenant routes its LLM calls through the Pryva gateway (the provider baseUrl points at
 * `.../llm/<provider>/...` and the apiKey is an instance token), the gateway records every call
 * but needs to know WHO made it — so its firsthand ledger can attribute spend per source/agent.
 * We attach three headers to every outbound provider request that targets the gateway:
 *
 *   X-Pryva-Caller = "ocw"                (constant — this is the main OpenClaw agent)
 *   X-Pryva-Agent  = <agent id>           (e.g. "main"; derived from the session key)
 *   X-Pryva-Task   = <flow source>        (owner_message / heartbeat / cron / …; from the flow)
 *
 * These are additive and only emitted for gateway-bound requests, so non-gateway providers are
 * untouched. Unlike install-telemetry attribution, this is NOT gated on a telemetry setting —
 * it is billing-critical and must always be present.
 */
/** Recognise a Pryva-gateway baseUrl. The gateway mounts every provider under `/llm/<provider>`. */
export function isGatewayBaseUrl(baseUrl: string | undefined | null): boolean {
  return typeof baseUrl === "string" && baseUrl.includes("/llm/");
}

type FlowLookup = {
  getFlowForSessionId(sessionId: string): { flowId: string; source: string } | null;
};

function readFlowRegistry(): FlowLookup | undefined {
  const reg = (globalThis as { __pryvaFlowRegistry?: unknown }).__pryvaFlowRegistry;
  if (reg && typeof (reg as FlowLookup).getFlowForSessionId === "function") {
    return reg as FlowLookup;
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
 * current flow's source (owner_message / heartbeat / cron / …), looked up by session id.
 */
export function buildGatewayAttribution(
  baseUrl: string | undefined | null,
  sessionId: string | undefined | null,
): Record<string, string> | undefined {
  if (!isGatewayBaseUrl(baseUrl)) {
    return undefined;
  }
  let task = "unknown";
  if (sessionId) {
    try {
      const flow = readFlowRegistry()?.getFlowForSessionId(sessionId);
      if (flow?.source) {
        task = flow.source;
      }
    } catch {
      // fail-open: attribution must never break a real LLM call
    }
  }

  return {
    "X-Pryva-Caller": "ocw",
    "X-Pryva-Agent": "main",
    "X-Pryva-Task": task,
  };
}

type StreamOptions = { headers?: Record<string, string> } | undefined;
type StreamFnLike = (model: unknown, context: unknown, options: StreamOptions) => unknown;

/**
 * Wrap the embedded-agent stream fn so every gateway-bound provider call carries the three
 * X-Pryva-* attribution headers. This is the seam for the MAIN agent: the embedded-agent-runner
 * rebuilds agent.streamFn per attempt (attempt.ts), so attribution has to be layered on top of
 * that rebuilt fn — the SDK-level streamFn seam is bypassed for the real agent run.
 *
 * baseUrl is read off the resolved model; sessionId is the run's session id (for the flow-source
 * task lookup). Non-gateway models are passed through untouched.
 */
export function wrapStreamFnWithGatewayAttribution<F extends StreamFnLike>(
  streamFn: F,
  baseUrl: string | undefined | null,
  sessionId: string | undefined | null,
): F {
  const attribution = buildGatewayAttribution(baseUrl, sessionId);
  if (!attribution) {
    return streamFn;
  }
  return ((model: unknown, context: unknown, options: StreamOptions) =>
    streamFn(model, context, {
      ...options,
      headers: { ...attribution, ...options?.headers },
    })) as F;
}
