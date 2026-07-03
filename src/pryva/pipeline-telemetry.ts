/**
 * Telemetry + flow-trace hooks: llm_output (log every LLM turn + token usage),
 * after_tool_call (log every tool call), agent_end (log a session error to the
 * flow trace). Every LLM/tool hop is attributed STRUCTURALLY to its flow —
 * resolved from the run's own identifiers (runId → sessionId → sessionKey) via
 * the registry, never by heuristic. A step that cannot be bound is logged under
 * `fl-unbound` + WARN (an alarm, not a fake flow). Conversation-message logging
 * is left to the per-flavor extensions (single writer, no double-logging).
 */

import type {
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookLlmOutputEvent,
} from "../plugins/types.js";
import { pryvaFetch } from "./backend.js";
import { logFlowStep, type PryvaPipeline } from "./pipeline.js";

// Full transparency: keep the WHOLE input + output on the flow step so the Logs
// magnifier shows exactly what went into and came out of every model call. Caps
// are generous (not 500 chars) — the operator explicitly wants completeness; the
// feature is toggleable, so space isn't the constraint.
const LLM_INPUT_CAP = 16000;
const LLM_OUTPUT_CAP = 16000;

export async function onLlmOutput(
  pipeline: PryvaPipeline,
  event: PluginHookLlmOutputEvent,
): Promise<void> {
  const usage = event?.usage;
  const model = event?.model || "unknown";
  const provider = event?.provider || "unknown";
  // INPUT: the prompt that produced this turn (the only input the hook exposes —
  // system prompt + history live in the session JSONL, surfaced as "Session turns").
  const inputText =
    typeof event?.prompt === "string" && event.prompt.trim()
      ? event.prompt.slice(0, LLM_INPUT_CAP)
      : null;
  // OUTPUT: the full assistant text, not a 500-char teaser.
  const outputFull = Array.isArray(event?.assistantTexts)
    ? event.assistantTexts.join("\n") || null
    : null;
  const outputText = outputFull ? outputFull.slice(0, LLM_OUTPUT_CAP) : null;
  // The OCW llm_output hook does NOT carry reasoning CONTENT (only the effort
  // level); the actual chain-of-thought for the main agent is in the session
  // JSONL turns. Record the effort level so the UI can show the mode at least.
  const reasoningEffort = event?.reasoningEffort ?? null;

  // Structural attribution: the LLM turn's own runId/sessionId resolve to its
  // flow; unbound → fl-unbound + WARN (never a re-minted fake id).
  const flowId = logFlowStep(
    pipeline,
    { runId: event?.runId, sessionId: event?.sessionId },
    {
      step_name: "ocw_llm_turn",
      step_type: "llm_call",
      input_text: inputText,
      output_text: outputText,
      status: "ok",
      metadata: {
        provider,
        model,
        tokens: usage ?? null,
        reasoning_effort: reasoningEffort,
        // Structured prompt/response so the LlmDetailPanel renders them uniformly
        // (same shape the backend internal-LLM records use).
        prompt: inputText ? [{ role: "user", content: inputText }] : undefined,
        response: outputText,
      },
    },
  );

  if (usage) {
    await pryvaFetch(
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
          reasoning_effort: reasoningEffort,
          // Full input + output so the LLM Usage tab detail shows both, not just
          // the response (main-agent rows previously carried response only).
          prompt: inputText ? [{ role: "user", content: inputText }] : undefined,
          response: outputText,
        },
      },
      { flowId },
    );
  }
}

export async function onAfterToolCall(
  pipeline: PryvaPipeline,
  event: PluginHookAfterToolCallEvent,
): Promise<void> {
  const toolName = event?.toolName || "unknown";
  const error = event?.error ?? null;
  logFlowStep(
    pipeline,
    { runId: event?.runId },
    {
      step_name: `ocw_tool:${toolName}`,
      step_type: "tool_call",
      input_text: JSON.stringify(event?.params ?? {}).slice(0, 500),
      output_text: event?.result ? JSON.stringify(event.result).slice(0, 500) : null,
      status: error ? "error" : "ok",
      error,
      latency_ms: event?.durationMs ?? null,
      metadata: { tool: toolName },
    },
  );
}

export async function onAgentEnd(
  pipeline: PryvaPipeline,
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  // Only record session failures on the flow trace. Successful auto-reply
  // capture (conversation logging) is owned by the per-flavor extensions.
  if (event?.success) {
    return;
  }
  logFlowStep(
    pipeline,
    { runId: event?.runId, sessionKey: ctx?.sessionKey },
    {
      step_name: "ocw_session_error",
      step_type: "internal",
      output_text: event?.error || "Agent session failed",
      status: "error",
      error: event?.error || "Unknown error",
      latency_ms: event?.durationMs ?? null,
    },
  );
}
