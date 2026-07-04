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
  PluginHookAfterCompactionEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookMessageContext,
  PluginHookMessageSentEvent,
  PluginHookModelCallEndedEvent,
} from "../plugins/types.js";
import { pryvaFetch } from "./backend.js";
import { logFlowStep, type PryvaPipeline } from "./pipeline.js";

// runId → the INPUT captured from the llm_input hook (fires just before llm_output for the same
// run). The llm_output event does NOT carry the prompt, so we stash the input here and consume it
// in onLlmOutput to show the full input on every main-agent LLM call. Bounded to avoid unbounded
// growth if an output somehow never fires.
type CapturedLlmInput = { prompt: string; systemPrompt?: string; historyCount: number };
const pendingLlmInput = new Map<string, CapturedLlmInput>();
const MAX_PENDING_LLM_INPUT = 512;

export async function onLlmInput(
  _pipeline: PryvaPipeline,
  event: PluginHookLlmInputEvent,
): Promise<void> {
  const runId = event?.runId;
  if (!runId) {
    return;
  }
  // Crude cap: if outputs stopped consuming (shouldn't happen), drop the oldest wholesale.
  if (pendingLlmInput.size > MAX_PENDING_LLM_INPUT) {
    pendingLlmInput.clear();
  }
  pendingLlmInput.set(runId, {
    prompt: typeof event?.prompt === "string" ? event.prompt : "",
    systemPrompt: typeof event?.systemPrompt === "string" ? event.systemPrompt : undefined,
    historyCount: Array.isArray(event?.historyMessages) ? event.historyMessages.length : 0,
  });
}

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
  // INPUT: consume what the llm_input hook stashed for this run (the llm_output event itself
  // carries no prompt). Falls back to event.prompt if ever populated. systemPrompt is kept too so
  // the detail view shows the FULL input (system + user), not just the user line.
  const captured = event?.runId ? pendingLlmInput.get(event.runId) : undefined;
  if (event?.runId) {
    pendingLlmInput.delete(event.runId);
  }
  const promptText =
    (captured?.prompt && captured.prompt.trim() ? captured.prompt : null) ??
    (typeof event?.prompt === "string" && event.prompt.trim() ? event.prompt : null);
  const inputText = promptText ? promptText.slice(0, LLM_INPUT_CAP) : null;
  const systemPrompt =
    captured?.systemPrompt && captured.systemPrompt.trim()
      ? captured.systemPrompt.slice(0, LLM_INPUT_CAP)
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
  // Structured prompt (system + user) so the LlmDetailPanel renders it uniformly with the
  // backend internal-LLM records (which use the same {role, content}[] shape).
  const promptMessages = inputText
    ? [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        { role: "user", content: inputText },
      ]
    : undefined;

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
        prompt: promptMessages,
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
          prompt: promptMessages,
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

/**
 * Delivery confirmation. `message_sending` logs the PRODUCED draft BEFORE the
 * channel send; this records whether the channel actually delivered it, so the
 * flow trace no longer goes silent at the last hop (a send that failed/timed out
 * was previously invisible). Attributed structurally — message_sent carries runId
 * + sessionKey on this fork; unbound → fl-unbound + WARN (never a re-minted id).
 */
export async function onMessageSent(
  pipeline: PryvaPipeline,
  event: PluginHookMessageSentEvent,
  ctx: PluginHookMessageContext,
): Promise<void> {
  const success = event?.success === true;
  logFlowStep(
    pipeline,
    { runId: event?.runId ?? ctx?.runId, sessionKey: event?.sessionKey ?? ctx?.sessionKey },
    {
      step_name: success ? "ocw_outbound_delivered" : "ocw_outbound_failed",
      step_type: "outbound",
      status: success ? "ok" : "error",
      output_text: event?.content ? event.content.slice(0, 500) : null,
      error: success ? null : (event?.error ?? "delivery failed"),
      metadata: {
        channel: ctx?.channelId ?? null,
        to: event?.to ?? null,
        message_id: event?.messageId ?? null,
        delivered: success,
      },
    },
  );
}

/**
 * Transport-level telemetry for EVERY model call (completed AND error). This is
 * the complement to `ocw_llm_turn` (from llm_output), NOT a duplicate:
 *  - `ocw_llm_turn` carries the SEMANTIC record — token usage, prompt, response,
 *    reasoning effort. `model_call_ended` has NO token usage.
 *  - `ocw_model_call` (here) carries the PHYSICAL record — wall-clock latency,
 *    time-to-first-byte, request/response byte sizes, transport/api, and the
 *    failure classification on errors. `llm_output` has NONE of these, and it
 *    fires ONLY for completed calls — so without this step every call's latency,
 *    and every errored/timed-out/aborted call in full, was invisible in the trace.
 * The two cannot be cleanly merged: `model_call_ended` has `callId` but
 * `llm_output` does not, and one run can make several model calls (iterations,
 * retries, compaction). A distinct step per call is the honest, complete shape;
 * it also captures calls that produce no assistant text (planning-only, empty,
 * retried) which `ocw_llm_turn` never sees. `callId` is kept in metadata so a
 * downstream join to the semantic turn stays possible.
 */
export async function onModelCallEnded(
  pipeline: PryvaPipeline,
  event: PluginHookModelCallEndedEvent,
): Promise<void> {
  const isError = event?.outcome === "error";
  logFlowStep(
    pipeline,
    { runId: event?.runId, sessionId: event?.sessionId, sessionKey: event?.sessionKey },
    {
      step_name: "ocw_model_call",
      step_type: "llm_call",
      status: isError ? "error" : "ok",
      error: isError ? (event?.failureKind ?? event?.errorCategory ?? "model_call_error") : null,
      latency_ms: event?.durationMs ?? null,
      metadata: {
        provider: event?.provider ?? "unknown",
        model: event?.model ?? "unknown",
        outcome: event?.outcome ?? "unknown",
        call_id: event?.callId ?? null,
        api: event?.api ?? null,
        transport: event?.transport ?? null,
        time_to_first_byte_ms: event?.timeToFirstByteMs ?? null,
        request_payload_bytes: event?.requestPayloadBytes ?? null,
        response_stream_bytes: event?.responseStreamBytes ?? null,
        context_token_budget: event?.contextTokenBudget ?? null,
        // Populated only on error; null on the common completed path.
        failure_kind: event?.failureKind ?? null,
        error_category: event?.errorCategory ?? null,
        upstream_request_id_hash: event?.upstreamRequestIdHash ?? null,
      },
    },
  );
}

/**
 * Context-window compaction telemetry. Compaction silently drops older history to
 * stay under the token budget — a frequent "why did it forget X" cause and a token
 * event worth seeing in the trace. `after_compaction`'s ctx is the agent context
 * (carries runId + sessionKey), so it attributes to the running turn's flow.
 */
export async function onAfterCompaction(
  pipeline: PryvaPipeline,
  event: PluginHookAfterCompactionEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  logFlowStep(
    pipeline,
    { runId: ctx?.runId, sessionId: ctx?.sessionId, sessionKey: ctx?.sessionKey },
    {
      step_name: "ocw_context_compacted",
      step_type: "internal",
      status: "ok",
      metadata: {
        messages_remaining: event?.messageCount ?? null,
        compacted_count: event?.compactedCount ?? null,
        token_count: event?.tokenCount ?? null,
      },
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
