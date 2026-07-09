/**
 * Finalize gate — before_agent_finalize.
 *
 * Two deterministic gates run here, each forcing at most ONE model rewrite:
 *  - role-break: the draft calls itself an AI / bot / language model.
 *  - zero-tool stalling: the draft promises a deliverable the run never started
 *    (see stalling.ts). Cortex cannot catch this — its payload carries no tool-call
 *    information and its "block" verdict never cancels a send — so the gate lives here,
 *    where the run's tool history is known and the harness can force another pass.
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
import { STALL_REVISE_INSTRUCTION, isStallingTurn } from "./stalling.js";

/** Run-stable keys so the harness caps each enforced rewrite at one per run. */
const ROLE_BREAK_RETRY_KEY = "pryva-rolebreak";
const STALL_RETRY_KEY = "pryva-empty-promise";

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
  if (!draft.trim()) {
    return;
  }

  const runId = event?.runId ?? ctx?.runId;
  const gate = hasRoleBreak(draft)
    ? {
        reason: "role_break",
        summary: "pryva: draft broke persona — forcing one in-character rewrite",
        instruction: REWRITE_INSTRUCTION,
        key: ROLE_BREAK_RETRY_KEY,
      }
    : isStallingTurn(runId, draft)
      ? {
          reason: "empty_promise",
          summary: "pryva: draft promised work the run never started — forcing one rewrite",
          instruction: STALL_REVISE_INSTRUCTION,
          key: STALL_RETRY_KEY,
        }
      : null;
  if (!gate) {
    return;
  }

  // Trace the enforced rewrite so operators can see the gate fired and why.
  logFlowStep(
    pipeline,
    {
      runId,
      sessionId: event?.sessionId,
      sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    },
    {
      step_name: "ocw_finalize_revise",
      step_type: "internal",
      status: "ok",
      input_text: draft.slice(0, 500),
      metadata: {
        reason: gate.reason,
        provider: event?.provider ?? null,
        model: event?.model ?? null,
      },
    },
  );

  return {
    action: "revise",
    reason: gate.summary,
    retry: {
      instruction: gate.instruction,
      idempotencyKey: gate.key,
      maxAttempts: 1,
    },
  };
}
