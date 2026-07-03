/**
 * Native Pryva pipeline registration.
 *
 * Wires the flavor-agnostic message pipeline into OpenClaw as a first-party,
 * always-loaded, config-gated set of plugin hooks. Registered through the same
 * plugin `api.on(...)` path as any extension, so the global hook runner
 * dispatches it natively on every turn — it can never be "missed" when enabled.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { resolvePryvaConfig } from "./config.js";
import { onBeforeAgentStart, onBeforePromptBuild, onMessageReceived } from "./pipeline-inbound.js";
import { onMessageSending } from "./pipeline-outbound.js";
import { onAfterToolCall, onAgentEnd, onLlmOutput } from "./pipeline-telemetry.js";
import { createPryvaPipeline } from "./pipeline.js";

/**
 * Register the native pipeline hooks on the given plugin api, gated by config.
 * Returns true when the pipeline was registered (enabled + backend configured),
 * false otherwise (disabled/misconfigured → no hooks registered, no-op).
 */
export function registerPryvaPipelineHooks(api: OpenClawPluginApi, cfg: OpenClawConfig): boolean {
  const resolved = resolvePryvaConfig(cfg);
  if (!resolved) {
    return false;
  }

  const pipeline = createPryvaPipeline(resolved, cfg);

  api.on("message_received", (event, ctx) => onMessageReceived(pipeline, event, ctx));
  // before_agent_start is the second mint point (D1): it binds every
  // non-message-triggered run (heartbeat/cron/system/followup) to a flow,
  // consumes external-flow attachments (D5) and source hints (D6), and
  // race-safe-bridges message-triggered runs. Idempotent across its multiple
  // fires per run. (Legacy hook, but it is the single earliest per-run point
  // with the full structural ctx — runId + sessionKey + trigger.)
  api.on("before_agent_start", (event, ctx) => onBeforeAgentStart(pipeline, event, ctx));
  // Priority 10 so the native time/Ear context is prepended ahead of flavor
  // extensions' own before_prompt_build injections.
  api.on("before_prompt_build", (event) => onBeforePromptBuild(pipeline, event), {
    priority: 10,
  });
  api.on("message_sending", (event, ctx) => onMessageSending(pipeline, event, ctx));
  api.on("agent_end", (event, ctx) => onAgentEnd(pipeline, event, ctx));
  api.on("llm_output", (event) => onLlmOutput(pipeline, event));
  api.on("after_tool_call", (event) => onAfterToolCall(pipeline, event));

  pipeline.log.info(
    `native pipeline enabled (ear=${!resolved.pipeline.disableEar} ` +
      `cortex=${!resolved.pipeline.disableCortex} mouth=${!resolved.pipeline.disableMouth})`,
  );
  return true;
}
