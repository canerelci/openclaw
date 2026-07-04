/**
 * Subagent lifecycle hooks: subagent_spawned / subagent_ended.
 *
 * OCW can spawn its OWN subagents (via `sessions_spawn` / the `subagents` tool) to
 * do work for the current turn. A flow is "the complete tree of work caused by
 * exactly ONE trigger", so a subagent's work belongs to the SAME flow as the
 * parent that spawned it — NOT a fresh `system` flow (which is what the child's
 * before_agent_start would otherwise mint).
 *
 * NOTE: this is unrelated to NCW. NCW ("non-conversational work") is a BACKEND
 * job; it re-enters a flow via the gateway `sessions.send`/`sessions.steer`
 * seam carrying `pryvaFlowId` (D5, source `ncw_completion`) — it does NOT use
 * these subagent hooks. These hooks fire only for OCW's native subagents.
 *
 * Design (mirrors the D5 attach seam):
 *  - on spawn: resolve the PARENT (requester) flow, attach it to the child SESSION
 *    so the child's own before_agent_start re-enters that flow (source `subagent`).
 *    The child's later llm turns / tool calls then resolve to the parent flow. Also
 *    log a `ocw_subagent_spawned` marker on the parent flow.
 *  - on end: log a `ocw_subagent_ended` marker (resolved via the child runId, now
 *    bound to the parent flow) with the terminal outcome.
 * Fire-and-forget telemetry; never blocks a spawn.
 */

import type {
  PluginHookSubagentContext,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentSpawnedEvent,
} from "../plugins/types.js";
import { logFlowStep, type PryvaPipeline } from "./pipeline.js";

export async function onSubagentSpawned(
  pipeline: PryvaPipeline,
  event: PluginHookSubagentSpawnedEvent,
  ctx: PluginHookSubagentContext,
): Promise<void> {
  const parentSessionKey = ctx?.requesterSessionKey;
  const childSessionKey = event?.childSessionKey ?? ctx?.childSessionKey;

  // The parent's flow (bound at message_received / before_agent_start). Resolve by
  // the requester session — the subagent is part of THAT trigger's work tree.
  const parent = pipeline.registry.resolve(undefined, undefined, parentSessionKey);
  if (parent && childSessionKey) {
    // Attach by SESSION (D5 seam): the child's before_agent_start consumes it and
    // re-enters the parent flow via flow_resume. parentFlowId == flowId records the
    // parent linkage, matching the NCW attach convention.
    pipeline.registry.attachExternalFlowBySession(
      childSessionKey,
      parent.flowId,
      "subagent",
      parent.flowId,
    );
  }

  logFlowStep(pipeline, parent ? { flowId: parent.flowId } : { sessionKey: parentSessionKey }, {
    step_name: "ocw_subagent_spawned",
    step_type: "internal",
    status: "ok",
    metadata: {
      child_session_key: childSessionKey ?? null,
      agent_id: event?.agentId ?? null,
      label: event?.label ?? null,
      mode: event?.mode ?? null,
      resolved_model: event?.resolvedModel ?? null,
      resolved_provider: event?.resolvedProvider ?? null,
      thread_requested: event?.threadRequested ?? null,
    },
  });
}

export async function onSubagentEnded(
  pipeline: PryvaPipeline,
  event: PluginHookSubagentEndedEvent,
  ctx: PluginHookSubagentContext,
): Promise<void> {
  // Terminal outcomes: ok | error | timeout | killed | reset | deleted.
  const outcome = event?.outcome;
  const isError = outcome === "error" || outcome === "timeout" || outcome === "killed";
  logFlowStep(
    pipeline,
    // The child runId is bound to the parent flow (at the child's before_agent_start);
    // fall back to the requester session. Either resolves to the parent flow.
    { runId: event?.runId ?? ctx?.runId, sessionKey: ctx?.requesterSessionKey },
    {
      step_name: "ocw_subagent_ended",
      step_type: "internal",
      status: isError ? "error" : "ok",
      error: isError ? (event?.error ?? outcome ?? "subagent failed") : null,
      metadata: {
        child_session_key: event?.targetSessionKey ?? ctx?.childSessionKey ?? null,
        target_kind: event?.targetKind ?? null,
        reason: event?.reason ?? null,
        outcome: outcome ?? null,
      },
    },
  );
}
