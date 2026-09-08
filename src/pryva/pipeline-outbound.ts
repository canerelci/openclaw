/**
 * Outbound pipeline hook: message_sending (sanitize → Cortex quality gate → Mouth
 * polish → empty-promise backstop). Flavor-agnostic; the backend Cortex/Mouth
 * stages resolve any flavor/recipient specifics. Each stage is attributed
 * STRUCTURALLY to the message's flow — resolved from the run that produced the
 * payload (`runId`, per-turn exact) and falling back to the outbound session's
 * sessionKey (the same value message_received bound), never by heuristic.
 *
 * `runId` is present for every agent-turn reply (routeReply threads it through
 * deliver.ts). Proactive/notification sends own no run and bind by sessionKey alone;
 * when neither binds, the step surfaces as `fl-unbound` + WARN rather than a
 * re-minted fake id. Preferring runId also stops a reply from being attributed to a
 * NEWER inbound's flow when the owner sends a second message mid-turn.
 */

import type {
  PluginHookMessageContext,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
} from "../plugins/types.js";
import { isFastAck } from "./ack.js";
import { pryvaFetch } from "./backend.js";
import type { PipelineInboundContext } from "./context.js";
import { neutralizeErrorReply } from "./error-reply.js";
import { UNBOUND_FLOW_ID } from "./flow-registry.js";
import { logFlowStep, type PryvaPipeline } from "./pipeline.js";
import { baseStripOutbound, guardRoleBreak } from "./sanitize.js";
import {
  demoteEmptyPromise,
  getToolCallsCount,
  getToolEvidence,
  isStallingTurn,
} from "./stalling.js";

/**
 * Find the inbound context for an outbound recipient — USED ONLY to fetch the
 * Ear plan + original message text for Cortex/Mouth context, NEVER for flow
 * attribution (flow identity is resolved structurally from runId/sessionKey below).
 */
// Message-origin sources whose outbound genuinely answers an inbound turn.
// Cortex QA ("does this reply address the question?") is only meaningful for these.
const MESSAGE_REPLY_SOURCES = new Set(["owner_message", "contact_message", "internal_chat"]);

// T496: proactive/self-turn sources whose outbound reaches the owner WITHOUT a
// matched inbound. The T245 AND-gate's matchedFlowId conjunct fails for all of
// these (no inbound to match), so they never reach Cortex via the reply path.
// Cortex judges the draft on its own merit (false completion, stalling, tool
// evidence) — the backend handles the absent original_message at pipeline.py:2628.
const CORTEX_PROACTIVE_SOURCES = new Set([
  "heartbeat",
  "cron",
  "followup",
  "system",
  "inner_voice",
  "scheduled_todo",
  "platform",
  "ncw_completion",
  "subagent",
  "tool_completion",
]);

function matchInboundContext(
  pipeline: PryvaPipeline,
  to: string | undefined,
  channelId: string | undefined,
): PipelineInboundContext | null {
  // T245: NEVER fall back to findLatest() — that borrows an unrelated inbound
  // (e.g. a concurrent office-room turn) and makes Cortex mis-judge system pushes
  // / proactive owner delivery. Recipient match only; no match → no original_message.
  return pipeline.ctxStore.findByRecipient(to, channelId) ?? null;
}

export async function onMessageSending(
  pipeline: PryvaPipeline,
  event: PluginHookMessageSendingEvent,
  ctx: PluginHookMessageContext,
): Promise<PluginHookMessageSendingResult | void> {
  if (!event?.content || typeof event.content !== "string") {
    return;
  }

  // Base sanitization (sentinels, error/timezone leaks, filler, role-break).
  const sanitized = baseStripOutbound(event.content);
  if (sanitized === null) {
    return { cancel: true };
  }
  let content = sanitized;

  // A canned fast-ack (D3) is pre-approved — skip Cortex AND Mouth so the one
  // message meant to be instant never pays an LLM QA/polish round-trip. The
  // length checks below already skip most acks; this makes it explicit + exact.
  const isAck = isFastAck(content);

  // A sanitized provider/system error reply (billing, rate-limit, etc.) must
  // reach the customer byte-for-byte. Cortex and Mouth both operate as if
  // content were normal assistant output — Cortex can rewrite it, Mouth can
  // translate/reformat it (or even reintroduce a stalling promise, see the
  // empty-promise backstop below) — so both are skipped for error text same
  // as a fast-ack, treating it as pre-approved rather than a draft to polish.
  const isErrorReply = event.isError === true;

  const channel = ctx?.channelId;
  const to = event?.to;
  // Prefer ctx (hook context from deliver), then event fields if harness put them there.
  const sessionKey = ctx?.sessionKey || (event as { sessionKey?: string })?.sessionKey || undefined;
  const runId = ctx?.runId || (event as { runId?: string })?.runId || undefined;
  const matched = matchInboundContext(pipeline, to, channel);
  const original = matched?.originalMessage || "";
  const earPlan = matched?.earPlan;

  // Structural flow attribution: the producing run's id is per-turn exact and always
  // wins; sessionKey is the fallback for sends that own no run. I1: when resolve fails
  // but the inbound matched by recipient already carries a flowId (same message tree),
  // bind that — structural, not findLatest roulette. If nothing binds, fl-unbound + WARN.
  const binding = pipeline.registry.resolve(runId, undefined, sessionKey);
  const matchedFlowId =
    matched && typeof (matched as { flowId?: string }).flowId === "string"
      ? (matched as { flowId?: string }).flowId
      : undefined;
  const flowId = binding?.flowId ?? matchedFlowId ?? UNBOUND_FLOW_ID;
  if (!binding && !matchedFlowId) {
    pipeline.log.warn(
      `outbound unbound: no flow for run=${runId ?? "?"} session=${sessionKey ?? "?"} ` +
        `to=${to ?? "?"} [${flowId}]`,
    );
  }

  // T245 AND-gate (design of record): run Cortex+Mouth ONLY when BOTH
  // (1) binding.source is a genuine inbound-message source, AND
  // (2) the outbound's flow is the same as the matched inbound's flow.
  // Fail-open toward delivery — never cancel.
  const isReplyToMatchedInbound = Boolean(
    binding?.source &&
    MESSAGE_REPLY_SOURCES.has(binding.source) &&
    matchedFlowId &&
    binding.flowId &&
    matchedFlowId === binding.flowId,
  );

  // T496: proactive owner-facing source — Cortex reviews even without an inbound
  // match. Mouth stays gated on isReplyToMatchedInbound (Sinan 2026-07-11).
  const isOwnerFacingProactive = Boolean(
    binding?.source && CORTEX_PROACTIVE_SOURCES.has(binding.source) && !isReplyToMatchedInbound,
  );
  const shouldRunCortex = isReplyToMatchedInbound || isOwnerFacingProactive;

  if (isErrorReply) {
    const responseLanguage =
      typeof earPlan?.response_language === "string" ? earPlan.response_language : undefined;
    content = neutralizeErrorReply(content, responseLanguage);
    pipeline.log.warn(`outbound error reply neutralized (to=${to ?? "?"}) [${flowId}]`);
    logFlowStep(
      pipeline,
      { flowId },
      {
        step_name: "ocw_error_reply_neutralized",
        step_type: "internal",
        status: "ok",
        input_text: sanitized.slice(0, 500),
        output_text: content,
        metadata: { channel: channel ?? null, to: to ?? null },
      },
    );
    if (content !== event.content) {
      return { content };
    }
    return;
  }

  // Cortex quality gate. Never cancel a deliberate send — media captions and
  // proactive notifications travel through this same hook; on "block" we prefer
  // Cortex's rewrite and otherwise let the sanitized content pass. Skipped for
  // short messages: canned acks ("Hemen bakıyorum…") were burning a ~7s LLM QA
  // call on 16 characters — nothing that short needs a quality gate.
  // H2/H3: always send real tool evidence so Cortex cannot demote tool-backed truth;
  // log when we skip so operators can see why a turn had no pipeline_cortex step.
  // H2: always record that message_sending saw this outbound (proves deliver.ts path ran).
  logFlowStep(
    pipeline,
    { flowId },
    {
      step_name: "ocw_message_sending",
      step_type: "internal",
      status: "ok",
      input_text: content.slice(0, 300),
      metadata: {
        is_ack: isAck,
        length: content.length,
        cortex:
          !isAck && !pipeline.cfg.pipeline.disableCortex && content.length > 40 && shouldRunCortex,
        channel: channel ?? null,
        to: to ?? null,
        is_reply_to_matched_inbound: isReplyToMatchedInbound,
        is_owner_facing_proactive: isOwnerFacingProactive,
        binding_source: binding?.source ?? null,
      },
    },
  );

  if (!isAck && !pipeline.cfg.pipeline.disableCortex && content.length > 40 && shouldRunCortex) {
    const toolEvidence = getToolEvidence(runId);
    const toolCallsCount = getToolCallsCount(runId);
    // Proactive sources always deliver to the owner; reply path uses earPlan.
    const recipientIsOwner =
      isOwnerFacingProactive || earPlan?.is_owner === true || binding?.source === "owner_message";
    const payload: Record<string, unknown> = {
      draft: content,
      original_message: original,
      channel: channel ?? "unknown",
      recipient_id: to ?? null,
      recipient_is_owner: recipientIsOwner,
      tool_calls_count: toolCallsCount,
      tool_evidence: toolEvidence.map((t) => ({
        name: t.name,
        summary: t.summary,
        status: t.status,
      })),
    };
    if (earPlan) {
      payload.intent = earPlan.intent;
      payload.key_points = earPlan.key_points;
      payload.needs_tools = earPlan.needs_tools;
      payload.response_style = earPlan.response_style;
      payload.response_language = earPlan.response_language;
    }
    const result = (await pryvaFetch(pipeline.cfg, "POST", "/pipeline/cortex", payload, {
      flowId,
    })) as { action?: string; content?: string } | null;
    if (result?.content) {
      content = guardRoleBreak(result.content);
    } else if (result?.action === "block") {
      pipeline.log.warn(`cortex flagged outbound to ${to ?? "?"} (passing through) [${flowId}]`);
    }
  } else if (!isAck && content.length > 40 && pipeline.cfg.pipeline.disableCortex) {
    pipeline.log.warn(`cortex skipped (disabled) for outbound to ${to ?? "?"} [${flowId}]`);
  } else if (!isAck && content.length > 40 && !shouldRunCortex) {
    pipeline.log.warn(
      `cortex skipped (no matched inbound and not a proactive source) to ${to ?? "?"} ` +
        `source=${binding?.source ?? "none"} matched=${matchedFlowId ?? "none"} [${flowId}]`,
    );
  }

  // Mouth polish ONLY when the draft needs formatting help — not merely because it is long.
  // Length alone used to force Mouth on clean prose ("Tamam Caner, anladım…"), and Mouth then
  // free-rewrote it into a mid-conversation greeting (Sinan 2026-07-11). Greeting policy and
  // substance belong to the agent + backend, not a formatter. Triggers are structural only:
  // markdown / tables / code fences / list markup / UUID-shaped tokens.
  const needsMouth = /[|#*`[\]{}]/.test(content) || /\b[0-9a-f]{8}-[0-9a-f]{4}\b/i.test(content);
  if (!isAck && !pipeline.cfg.pipeline.disableMouth && needsMouth && isReplyToMatchedInbound) {
    const result = (await pryvaFetch(
      pipeline.cfg,
      "POST",
      "/pipeline/mouth",
      {
        draft: content,
        original_message: original,
        channel: channel ?? "unknown",
        response_style: earPlan?.response_style,
        language: earPlan?.response_language,
      },
      { flowId },
    )) as { polished?: string } | null;
    if (result?.polished) {
      content = guardRoleBreak(result.polished);
    }
  }

  // Zero-tool stalling backstop — LAST, after Cortex and Mouth.
  //
  // Ordering is load-bearing. The finalize gate (pipeline-finalize.ts) already forced one model
  // rewrite, but the harness caps that retry budget and then delivers the draft regardless
  // (lifecycle-hook-helpers.ts: `nextCount > maxAttempts` → `continue`), so a promise can still
  // arrive here. Cortex cannot stop it either: it is blind to tool calls and its "block" verdict
  // never cancels a send. And Mouth — nominally a formatter that never adds content — has been
  // observed REINTRODUCING a promise into an honest draft (flow fl-6cb0e7d6fda4: honest
  // "logo dosyasını atabilir misin?" in, "Hemen yenisini hazırlıyorum…" out, changed=true).
  // Running this before those stages would let either of them put the lie back. Last word wins.
  if (!isAck && isStallingTurn(runId, content)) {
    const responseLanguage =
      typeof earPlan?.response_language === "string" ? earPlan.response_language : undefined;
    const demoted = demoteEmptyPromise(content, responseLanguage);
    pipeline.log.warn(
      `outbound empty promise demoted (run=${runId ?? "?"} to=${to ?? "?"}) [${flowId}]`,
    );
    logFlowStep(
      pipeline,
      { flowId },
      {
        step_name: "ocw_empty_promise_blocked",
        step_type: "internal",
        status: "ok",
        input_text: content.slice(0, 500),
        output_text: demoted.slice(0, 500),
        metadata: { reason: "zero_tool_stalling", channel: channel ?? null, to: to ?? null },
      },
    );
    content = demoted;
  }

  if (content !== event.content) {
    return { content };
  }
}
