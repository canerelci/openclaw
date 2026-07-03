/**
 * Outbound pipeline hook: message_sending (sanitize → Cortex quality gate →
 * Mouth polish). Flavor-agnostic; the backend Cortex/Mouth stages resolve any
 * flavor/recipient specifics. Each stage is attributed STRUCTURALLY to the
 * message's flow — resolved from the outbound session's sessionKey (the same
 * value message_received bound), never by heuristic. message_sending carries no
 * runId on this fork, so sessionKey is the key; an unbound outbound surfaces as
 * `fl-unbound` + WARN rather than a re-minted fake id.
 */

import type {
  PluginHookMessageContext,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
} from "../plugins/types.js";
import { isFastAck } from "./ack.js";
import { pryvaFetch } from "./backend.js";
import type { PipelineInboundContext } from "./context.js";
import { UNBOUND_FLOW_ID } from "./flow-registry.js";
import type { PryvaPipeline } from "./pipeline.js";
import { baseStripOutbound, guardRoleBreak } from "./sanitize.js";

/**
 * Find the inbound context for an outbound recipient — USED ONLY to fetch the
 * Ear plan + original message text for Cortex/Mouth context, NEVER for flow
 * attribution (flow identity is resolved structurally from sessionKey below).
 */
function matchInboundContext(
  pipeline: PryvaPipeline,
  to: string | undefined,
  channelId: string | undefined,
): PipelineInboundContext | null {
  return pipeline.ctxStore.findByRecipient(to, channelId) ?? pipeline.ctxStore.findLatest();
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

  const channel = ctx?.channelId;
  const to = event?.to;
  const sessionKey = ctx?.sessionKey;
  const matched = matchInboundContext(pipeline, to, channel);
  const original = matched?.originalMessage || "";
  const earPlan = matched?.earPlan;

  // Structural flow attribution. message_sending has no runId on this fork, so
  // resolve via sessionKey (the message's flow, bound at message_received). If
  // nothing binds, use the reserved fl-unbound id + WARN — never re-mint.
  const binding = pipeline.registry.resolve(undefined, undefined, sessionKey);
  const flowId = binding?.flowId ?? UNBOUND_FLOW_ID;
  if (!binding) {
    pipeline.log.warn(
      `outbound unbound: no flow for session=${sessionKey ?? "?"} to=${to ?? "?"} [${flowId}]`,
    );
  }

  // Cortex quality gate. Never cancel a deliberate send — media captions and
  // proactive notifications travel through this same hook; on "block" we prefer
  // Cortex's rewrite and otherwise let the sanitized content pass. Skipped for
  // short messages: canned acks ("Hemen bakıyorum…") were burning a ~7s LLM QA
  // call on 16 characters — nothing that short needs a quality gate.
  if (!isAck && !pipeline.cfg.pipeline.disableCortex && content.length > 40) {
    const payload: Record<string, unknown> = {
      draft: content,
      original_message: original,
      channel: channel ?? "unknown",
      recipient_id: to ?? null,
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
  }

  // Mouth polish when the draft needs formatting help.
  const needsMouth =
    content.length > 80 ||
    /[|#*`[\]{}]/.test(content) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}\b/i.test(content);
  if (!isAck && !pipeline.cfg.pipeline.disableMouth && needsMouth) {
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

  if (content !== event.content) {
    return { content };
  }
}
