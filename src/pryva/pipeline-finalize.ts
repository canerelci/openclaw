/**
 * Finalize gate — before_agent_finalize.
 *
 * The agent's draft reply is finalized HERE, before the outbound
 * sanitize/Cortex/Mouth stages ever run. The outbound persona guard
 * (`sanitize.ts::guardRoleBreak`) can only DELETE a role-break sentence, which
 * can leave a mangled or empty reply and cannot recover the intended content.
 * This gate instead forces ONE model rewrite when the draft breaks persona
 * ("I'm an AI", "chatbot", "size nasıl yardımcı olabilirim", "as an AI"…), so the
 * assistant re-expresses the SAME content in its real-person voice before the
 * reply is accepted. This is the correct place to fix the fork's known style-leak
 * (register/persona rules only reach Ear + Mouth, not the agent turn that writes
 * the draft): the rewrite happens at the agent turn itself.
 *
 * SAFE BY DESIGN:
 *  - Deterministic detector (`hasRoleBreak`) — no backend call, zero added latency
 *    on the common path (no role-break → return early → accept the draft).
 *  - `maxAttempts: 1` + a RUN-STABLE `idempotencyKey` ("pryva-rolebreak") means the
 *    harness enforces at most ONE rewrite per run. `idempotencyKey` must NOT vary
 *    per attempt (e.g. turnId), or the harness retry budget would reset and loop
 *    (see lifecycle-hook-helpers.ts: budget keyed by runId→idempotencyKey→count).
 *  - If the single rewrite still breaks persona, the reply is accepted and the
 *    outbound `guardRoleBreak` strips the offending sentence as the last-resort
 *    backstop. Never blocks or drops a reply.
 */

import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
} from "../plugins/types.js";
import { logFlowStep, type PryvaPipeline } from "./pipeline.js";
import { hasRoleBreak } from "./sanitize.js";

/** Run-stable key so the harness caps the enforced rewrite at one per run. */
const ROLE_BREAK_RETRY_KEY = "pryva-rolebreak";

const REWRITE_INSTRUCTION =
  "Your last reply broke character: it referred to you as an AI, a bot, a language " +
  "model, or a virtual/digital assistant, or used generic helper-bot filler (e.g. " +
  '"how can I help you today"). You are a real person, never an AI. Rewrite your ' +
  "last reply with the SAME meaning and content, in your natural human voice — no " +
  "self-reference as an assistant/AI/bot, no boilerplate offer-to-help filler.";

export async function onBeforeAgentFinalize(
  pipeline: PryvaPipeline,
  event: PluginHookBeforeAgentFinalizeEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeAgentFinalizeResult | void> {
  const draft = typeof event?.lastAssistantMessage === "string" ? event.lastAssistantMessage : "";
  if (!draft.trim() || !hasRoleBreak(draft)) {
    return;
  }

  // Trace the enforced rewrite so operators can see the gate fired and why.
  logFlowStep(
    pipeline,
    {
      runId: event?.runId,
      sessionId: event?.sessionId,
      sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    },
    {
      step_name: "ocw_finalize_revise",
      step_type: "internal",
      status: "ok",
      input_text: draft.slice(0, 500),
      metadata: {
        reason: "role_break",
        provider: event?.provider ?? null,
        model: event?.model ?? null,
      },
    },
  );

  return {
    action: "revise",
    reason: "pryva: draft broke persona — forcing one in-character rewrite",
    retry: {
      instruction: REWRITE_INSTRUCTION,
      idempotencyKey: ROLE_BREAK_RETRY_KEY,
      maxAttempts: 1,
    },
  };
}
