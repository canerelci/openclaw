/**
 * Pryva pipeline runtime state.
 *
 * Holds the resolved config + the per-conversation context store shared across
 * the native pipeline hooks. One instance is created when the pipeline is
 * registered (config-gated).
 *
 * Scope: the native pipeline owns the flavor-agnostic pipeline STAGES (Ear,
 * Cortex, Mouth, outbound sanitization) and the FLOW TRACE / telemetry
 * (flow_logs + usage). Conversation-message logging (the messages table /
 * per-flavor history) stays in the per-flavor extensions so there is exactly one
 * writer per concern and no double-logging.
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedPryvaConfig } from "./config.js";
import { PipelineContextStore } from "./context.js";
import { generateFlowId } from "./flow.js";

export type PryvaPipeline = {
  cfg: ResolvedPryvaConfig;
  timezone: string;
  ctxStore: PipelineContextStore;
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
  return {
    cfg,
    timezone: resolveTimezone(openClawConfig),
    ctxStore: new PipelineContextStore(),
    log: createSubsystemLogger("pryva"),
  };
}

/** Flow id for the current turn — most recent inbound context, or a fresh id. */
export function currentFlowId(pipeline: PryvaPipeline): string {
  return pipeline.ctxStore.findLatest()?.flowId ?? generateFlowId();
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
