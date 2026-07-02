/**
 * Outbound pipeline hooks: message_sending (sanitize → Cortex quality gate →
 * Mouth polish) and message_sent (ingest the delivered message for the flow
 * trace). Flavor-agnostic; the backend Cortex/Mouth stages resolve any
 * flavor/recipient specifics.
 */

import type {
  PluginHookMessageContext,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
} from "../plugins/types.js";
import { pryvaFetch } from "./backend.js";
import type { PipelineInboundContext } from "./context.js";
import { generateFlowId } from "./flow.js";
import type { PryvaPipeline } from "./pipeline.js";
import { baseStripOutbound, guardRoleBreak } from "./sanitize.js";

function matchContext(
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

  const channel = ctx?.channelId;
  const to = event?.to;
  const matched = matchContext(pipeline, to, channel);
  const flowId = matched?.flowId || generateFlowId();
  pipeline.handoff.set(channel, to, flowId);

  const original = matched?.originalMessage || "";

  // Cortex quality gate. Never cancel a deliberate send — media captions and
  // proactive notifications travel through this same hook; on "block" we prefer
  // Cortex's rewrite and otherwise let the sanitized content pass.
  if (!pipeline.cfg.pipeline.disableCortex && content.length > 10) {
    const payload: Record<string, unknown> = {
      draft: content,
      original_message: original,
      channel: channel ?? "unknown",
      recipient_id: to ?? null,
    };
    const earPlan = matched?.earPlan;
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
  if (!pipeline.cfg.pipeline.disableMouth && needsMouth) {
    const earPlan = matched?.earPlan;
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

export async function onMessageSent(
  pipeline: PryvaPipeline,
  event: PluginHookMessageSentEvent,
  ctx: PluginHookMessageContext,
): Promise<void> {
  const channel = ctx?.channelId || "unknown";
  const to = event?.to || "";
  const content = event?.content || "";
  if (!to && !content) {
    return;
  }

  let flowId = pipeline.handoff.take(channel, to);
  if (!flowId) {
    for (const [key, ictx] of pipeline.ctxStore.entries()) {
      if (ictx.from === to && ictx.channel === channel) {
        flowId = ictx.flowId;
        pipeline.messageSentKeys.add(key);
        break;
      }
    }
  }
  if (!flowId) {
    flowId = generateFlowId();
  }

  await pryvaFetch(
    pipeline.cfg,
    "POST",
    "/messages/ingest",
    {
      channel,
      direction: "outbound",
      sender_id: "self",
      recipient_id: to,
      content,
      status: !event?.success ? "failed" : "sent",
      timestamp: new Date().toISOString(),
      metadata: {
        openclaw_channel: channel,
        flow_id: flowId,
        success: event?.success,
        error: event?.error ?? null,
      },
    },
    { flowId },
  );
}
