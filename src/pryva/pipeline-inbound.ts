/**
 * Inbound pipeline hooks: message_received (mint flow id, run Ear analysis) and
 * before_prompt_build (inject current time + Ear action plan). Flavor-agnostic —
 * flavor-specific prompt context (brand kit, identity, persona) is injected by
 * the per-flavor extensions in their own before_prompt_build hooks, and
 * conversation-message logging stays in those extensions too.
 */

import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
} from "../plugins/types.js";
import { pryvaFetch } from "./backend.js";
import type { PipelineInboundContext } from "./context.js";
import { generateFlowId } from "./flow.js";
import { sleep, type PryvaPipeline } from "./pipeline.js";
import { currentTimeContext } from "./time.js";

/** Run the Ear analysis stage and store the plan on the context. */
async function runEar(pipeline: PryvaPipeline, entry: PipelineInboundContext): Promise<void> {
  entry.earStarted = true;
  const plan = await pryvaFetch(
    pipeline.cfg,
    "POST",
    "/pipeline/ear",
    {
      message: entry.originalMessage,
      sender_id: entry.from,
      channel: entry.channel,
      conversation_id: entry.conversationId,
    },
    { flowId: entry.flowId },
  );
  if (plan && typeof plan === "object") {
    entry.earPlan = plan as Record<string, unknown>;
  }
}

export async function onMessageReceived(
  pipeline: PryvaPipeline,
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
): Promise<void> {
  const channel = ctx?.channelId || "unknown";
  const from = event?.from || "";
  const content = event?.content || "";
  if (!from && !content) {
    return;
  }

  const conversationId = ctx?.conversationId ?? null;
  const key = pipeline.ctxStore.key(conversationId, channel, from);
  const flowId = generateFlowId();

  const entry: PipelineInboundContext = {
    from,
    channel,
    conversationId,
    flowId,
    originalMessage: content,
    earPlan: null,
    earStarted: false,
    timestamp: Date.now(),
  };
  pipeline.ctxStore.set(key, entry);
  pipeline.ctxStore.cleanupStale();

  // Ear analysis (awaited so before_prompt_build can pick up the plan this turn).
  if (content && !pipeline.cfg.pipeline.disableEar) {
    try {
      await runEar(pipeline, entry);
      const intent = typeof entry.earPlan?.intent === "string" ? entry.earPlan.intent : "";
      pipeline.log.debug(`ear intent=${intent} [${flowId}]`);
    } catch (err) {
      pipeline.log.debug(`ear failed: ${String(err)}`);
    }
  }
}

function buildEarPlanBlock(entry: PipelineInboundContext): string | null {
  const earPlan = entry.earPlan;
  if (!earPlan || earPlan.fallback === true) {
    return null;
  }
  const lines: string[] = ["[Action Plan (from message analysis):"];
  if (typeof earPlan.intent === "string") {
    lines.push(`  Intent: ${earPlan.intent}`);
  }
  if (typeof earPlan.urgency === "string" && earPlan.urgency !== "normal") {
    lines.push(`  Urgency: ${earPlan.urgency}`);
  }
  if (earPlan.short_circuit === true) {
    lines.push("  Note: Simple message — respond briefly, no tools needed.");
  }
  if (typeof earPlan.response_language === "string") {
    lines.push(`  Response language: ${earPlan.response_language}`);
  }
  if (typeof earPlan.response_style === "string") {
    lines.push(`  Response style: ${earPlan.response_style}`);
  }
  if (Array.isArray(earPlan.key_points) && earPlan.key_points.length > 0) {
    lines.push("  Key points to address:");
    for (const kp of earPlan.key_points) {
      lines.push(`    - ${String(kp)}`);
    }
  }
  if (Array.isArray(earPlan.warnings) && earPlan.warnings.length > 0) {
    lines.push("  Warnings:");
    for (const w of earPlan.warnings) {
      lines.push(`    - ${String(w)}`);
    }
  }
  const schedule = earPlan.schedule as { in_minutes?: unknown } | undefined;
  const schedMin = Number(schedule?.in_minutes);
  if (Number.isFinite(schedMin) && schedMin > 0) {
    const dueIso = new Date(entry.timestamp + schedMin * 60_000).toISOString();
    lines.push(
      `  Scheduling: the requested "${schedMin} min" resolves to EXACTLY ${dueIso}. ` +
        "Pass this verbatim as due_at — never compute timestamps yourself.",
    );
  }
  lines.push("]");
  return lines.join("\n");
}

export async function onBeforePromptBuild(
  pipeline: PryvaPipeline,
  _event: PluginHookBeforePromptBuildEvent,
): Promise<PluginHookBeforePromptBuildResult | void> {
  let best = pipeline.ctxStore.findLatest();

  // If Ear is in flight for the latest turn, wait briefly (up to ~15s).
  if (best && best.earStarted && !best.earPlan) {
    for (let i = 0; i < 150 && best && !best.earPlan; i++) {
      await sleep(100);
      best = pipeline.ctxStore.findLatest();
    }
  }

  const parts: string[] = [currentTimeContext(pipeline.timezone)];
  if (best) {
    const earBlock = buildEarPlanBlock(best);
    if (earBlock) {
      parts.push(earBlock);
    }
  }

  return { prependContext: parts.join("\n\n") };
}
