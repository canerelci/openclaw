/**
 * Telemetry + flow-trace hooks: llm_output (log every LLM turn + token usage),
 * after_tool_call (log every tool call), agent_end (log a session error to the
 * flow trace). Every LLM/tool hop is attributed to the current turn's flow id so
 * cost + latency are traceable end-to-end. Conversation-message logging is left
 * to the per-flavor extensions (single writer, no double-logging).
 */

import type {
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookLlmOutputEvent,
} from "../plugins/types.js";
import { pryvaFetch } from "./backend.js";
import { currentFlowId, type PryvaPipeline } from "./pipeline.js";

export async function onLlmOutput(
  pipeline: PryvaPipeline,
  event: PluginHookLlmOutputEvent,
): Promise<void> {
  const flowId = currentFlowId(pipeline);
  const usage = event?.usage;
  const model = event?.model || "unknown";
  const provider = event?.provider || "unknown";
  const outputPreview = Array.isArray(event?.assistantTexts)
    ? event.assistantTexts.join("\n").slice(0, 500) || null
    : null;

  const flowStep = pryvaFetch(
    pipeline.cfg,
    "POST",
    "/flows/log-step",
    {
      flow_id: flowId,
      step_name: "ocw_llm_turn",
      step_type: "llm_call",
      source: "openclaw",
      output_text: outputPreview,
      status: "ok",
      metadata: { provider, model, tokens: usage ?? null },
    },
    { flowId },
  );

  const usageLog = usage
    ? pryvaFetch(
        pipeline.cfg,
        "POST",
        "/agents/me/usage",
        {
          model: provider ? `${provider}/${model}` : model,
          task_type: "messaging",
          assistant_name: "main",
          flow_id: flowId,
          prompt_tokens: (usage.input ?? 0) + (usage.cacheRead ?? 0),
          completion_tokens: usage.output ?? 0,
          metadata: {
            source: "llm_output_hook",
            cache_read: usage.cacheRead ?? 0,
            cache_write: usage.cacheWrite ?? 0,
            response: outputPreview,
          },
        },
        { flowId },
      )
    : Promise.resolve(null);

  await Promise.all([flowStep, usageLog]);
}

export async function onAfterToolCall(
  pipeline: PryvaPipeline,
  event: PluginHookAfterToolCallEvent,
): Promise<void> {
  const flowId = currentFlowId(pipeline);
  const toolName = event?.toolName || "unknown";
  const error = event?.error ?? null;
  await pryvaFetch(
    pipeline.cfg,
    "POST",
    "/flows/log-step",
    {
      flow_id: flowId,
      step_name: `ocw_tool:${toolName}`,
      step_type: "tool_call",
      source: "openclaw",
      input_text: JSON.stringify(event?.params ?? {}).slice(0, 500),
      output_text: event?.result ? JSON.stringify(event.result).slice(0, 500) : null,
      status: error ? "error" : "ok",
      error,
      latency_ms: event?.durationMs ?? null,
      metadata: { tool: toolName },
    },
    { flowId },
  );
}

export async function onAgentEnd(
  pipeline: PryvaPipeline,
  event: PluginHookAgentEndEvent,
  _ctx: PluginHookAgentContext,
): Promise<void> {
  // Only record session failures on the flow trace. Successful auto-reply
  // capture (conversation logging) is owned by the per-flavor extensions.
  if (event?.success) {
    return;
  }
  const flowId = currentFlowId(pipeline);
  await pryvaFetch(
    pipeline.cfg,
    "POST",
    "/flows/log-step",
    {
      flow_id: flowId,
      step_name: "ocw_session_error",
      step_type: "internal",
      source: "openclaw",
      output_text: event?.error || "Agent session failed",
      status: "error",
      error: event?.error || "Unknown error",
      latency_ms: event?.durationMs ?? null,
    },
    { flowId },
  );
}
