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
import { onInboundClaim } from "./pipeline-claim.js";
import { onBeforeAgentFinalize } from "./pipeline-finalize.js";
import {
  onBeforeAgentRun,
  onBeforeAgentStart,
  onBeforePromptBuild,
  onMessageReceived,
} from "./pipeline-inbound.js";
import { onMessageSending } from "./pipeline-outbound.js";
import { onSubagentEnded, onSubagentSpawned } from "./pipeline-subagent.js";
import {
  onAfterCompaction,
  onAfterToolCall,
  onAgentEnd,
  onLlmInput,
  onLlmOutput,
  onMessageSent,
  onModelCallEnded,
} from "./pipeline-telemetry.js";
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

  // inbound_claim runs BEFORE the agent: for a trivial short message the backend
  // quick-reply may answer it directly (handled), skipping the whole agent turn.
  // Fail-open — if the backend doesn't claim it, the message flows on as normal.
  api.on("inbound_claim", (event, ctx) => onInboundClaim(pipeline, event, ctx));
  api.on("message_received", (event, ctx) => onMessageReceived(pipeline, event, ctx));
  // before_agent_run is the run-level dedup gate: it blocks a DUPLICATE agent run
  // for the same inbound message (spool retry). Complements the message_received
  // guard (which dedups flow-mint + Ear); scoped to real channel messages only.
  api.on("before_agent_run", (event, ctx) => onBeforeAgentRun(pipeline, event, ctx));
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
  // message_sent is the delivery-confirmation counterpart to message_sending: it
  // records whether the channel actually delivered the reply (success/failure),
  // closing the flow trace's last-hop blind spot.
  api.on("message_sent", (event, ctx) => onMessageSent(pipeline, event, ctx));
  // before_agent_finalize forces one in-character rewrite when the draft breaks
  // persona — fixes the style-leak at the agent turn (the outbound guard can only
  // delete the offending sentence). Deterministic + capped at one retry.
  api.on("before_agent_finalize", (event, ctx) => onBeforeAgentFinalize(pipeline, event, ctx));
  api.on("agent_end", (event, ctx) => onAgentEnd(pipeline, event, ctx));
  // model_call_ended fires on BOTH completed and error. We log every call as the
  // transport-level `ocw_model_call` step (latency/TTFB/bytes/transport + error
  // classification) — the physical complement to llm_output's semantic
  // ocw_llm_turn (tokens/prompt/response). Neither event carries the other's data.
  api.on("model_call_ended", (event) => onModelCallEnded(pipeline, event));
  // llm_input fires just before llm_output and carries the prompt/systemPrompt/history the
  // llm_output event omits; we stash it and attach it to the turn so every LLM call shows its input.
  api.on("llm_input", (event) => onLlmInput(pipeline, event));
  api.on("llm_output", (event) => onLlmOutput(pipeline, event));
  api.on("after_tool_call", (event) => onAfterToolCall(pipeline, event));
  // Context-window compaction: log a trace step so silent history drops (a common
  // "why did it forget" + token event) are visible. Attributed to the running turn.
  api.on("after_compaction", (event, ctx) => onAfterCompaction(pipeline, event, ctx));
  // OCW native subagents (sessions_spawn): attach the parent (requester) flow to the
  // child so the subagent's whole work tree joins the SAME flow, and log spawn/end
  // markers. NOT NCW — NCW is a backend job that re-enters via the D5 sessions seam.
  api.on("subagent_spawned", (event, ctx) => onSubagentSpawned(pipeline, event, ctx));
  api.on("subagent_ended", (event, ctx) => onSubagentEnded(pipeline, event, ctx));

  pipeline.log.info(
    `native pipeline enabled (ear=${!resolved.pipeline.disableEar} ` +
      `cortex=${!resolved.pipeline.disableCortex} mouth=${!resolved.pipeline.disableMouth})`,
  );
  return true;
}
