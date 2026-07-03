/**
 * Pryva pipeline runtime state.
 *
 * Holds the resolved config + the per-conversation context store + the structural
 * flow registry shared across the native pipeline hooks. One instance is created
 * when the pipeline is registered (config-gated).
 *
 * Scope: the native pipeline owns the flavor-agnostic pipeline STAGES (Ear,
 * Cortex, Mouth, outbound sanitization) and the FLOW TRACE / telemetry
 * (flow_logs + usage). Conversation-message logging (the messages table /
 * per-flavor history) stays in the per-flavor extensions so there is exactly one
 * writer per concern and no double-logging.
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { pryvaFetch } from "./backend.js";
import type { ResolvedPryvaConfig } from "./config.js";
import { PipelineContextStore } from "./context.js";
import { FlowRegistry, UNBOUND_FLOW_ID, publishFlowRegistry } from "./flow-registry.js";

export type PryvaPipeline = {
  cfg: ResolvedPryvaConfig;
  timezone: string;
  ctxStore: PipelineContextStore;
  /** Structural flow identity (D1). Single source of truth for flow_id attribution. */
  registry: FlowRegistry;
  log: ReturnType<typeof createSubsystemLogger>;
};

function resolveTimezone(openClawConfig: OpenClawConfig | undefined): string {
  const agents = openClawConfig?.agents as { defaults?: { userTimezone?: string } } | undefined;
  return agents?.defaults?.userTimezone || process.env.PRYVA_OWNER_TIMEZONE || "UTC";
}

export function createPryvaPipeline(
  cfg: ResolvedPryvaConfig,
  openClawConfig: OpenClawConfig | undefined,
): PryvaPipeline {
  const registry = new FlowRegistry();
  // Publish the read-only C1 surface on globalThis so per-flavor extensions can
  // READ the flow for a session (and never mint their own id — D2).
  publishFlowRegistry(registry);
  return {
    cfg,
    timezone: resolveTimezone(openClawConfig),
    ctxStore: new PipelineContextStore(),
    registry,
    log: createSubsystemLogger("pryva"),
  };
}

/**
 * Log a flow step, attributing it STRUCTURALLY (never by heuristic). Resolution
 * order: an explicit `flowId` (for trigger markers minted at a known point) →
 * runId → sessionId → sessionKey from the registry. A step that cannot be bound
 * is logged under the reserved id `fl-unbound` with `metadata.unbound=true` +
 * WARN — an ALARM (target ZERO), never a freshly-minted fake id (parent §4, I1).
 * Fire-and-forget: pryvaFetch never throws and never blocks message delivery.
 *
 * Returns the resolved flow id so callers that need it for a follow-up POST
 * (e.g. usage logging) reuse the SAME id without re-resolving.
 */
export function logFlowStep(
  pipeline: PryvaPipeline,
  resolve: { runId?: string; sessionId?: string; sessionKey?: string; flowId?: string },
  payload: {
    step_name: string;
    step_type: string;
    source?: string;
    status?: string;
    input_text?: string | null;
    output_text?: string | null;
    error?: string | null;
    latency_ms?: number | null;
    metadata?: Record<string, unknown>;
  },
): string {
  const metadata: Record<string, unknown> = { ...(payload.metadata ?? {}) };

  let flowId: string;
  if (resolve.flowId) {
    flowId = resolve.flowId;
  } else {
    const binding = pipeline.registry.resolve(resolve.runId, resolve.sessionId, resolve.sessionKey);
    if (binding) {
      flowId = binding.flowId;
    } else {
      flowId = UNBOUND_FLOW_ID;
      metadata.unbound = true;
      if (resolve.runId) metadata.run_id = resolve.runId;
      if (resolve.sessionKey) metadata.session_key = resolve.sessionKey;
      pipeline.log.warn(
        `unbound flow step: ${payload.step_name} ` +
          `(run=${resolve.runId ?? "?"} session=${resolve.sessionKey ?? "?"})`,
      );
    }
  }

  void pryvaFetch(
    pipeline.cfg,
    "POST",
    "/flows/log-step",
    {
      flow_id: flowId,
      step_name: payload.step_name,
      step_type: payload.step_type,
      source: payload.source ?? "openclaw",
      status: payload.status ?? "ok",
      input_text: payload.input_text ?? null,
      output_text: payload.output_text ?? null,
      error: payload.error ?? null,
      latency_ms: payload.latency_ms ?? null,
      metadata,
    },
    { flowId },
  );

  return flowId;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
