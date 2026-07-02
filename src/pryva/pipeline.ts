/**
 * Pryva pipeline runtime state.
 *
 * Holds the resolved config, the per-conversation context store, and the
 * outbound flow handoff shared across all the native pipeline hooks. One
 * instance is created when the pipeline is registered (config-gated).
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedPryvaConfig } from "./config.js";
import { PipelineContextStore } from "./context.js";
import { OutboundFlowHandoff, generateFlowId } from "./flow.js";

export type PryvaPipeline = {
  cfg: ResolvedPryvaConfig;
  timezone: string;
  ctxStore: PipelineContextStore;
  handoff: OutboundFlowHandoff;
  log: ReturnType<typeof createSubsystemLogger>;
  /** Keys whose outbound was already ingested by message_sent (agent_end dedup). */
  messageSentKeys: Set<string>;
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
    handoff: new OutboundFlowHandoff(),
    log: createSubsystemLogger("pryva"),
    messageSentKeys: new Set<string>(),
  };
}

/** Flow id for the current turn — most recent inbound context, or a fresh id. */
export function currentFlowId(pipeline: PryvaPipeline): string {
  return pipeline.ctxStore.findLatest()?.flowId ?? generateFlowId();
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
