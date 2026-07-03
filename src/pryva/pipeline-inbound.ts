/**
 * Inbound pipeline hooks: message_received (mint flow id, run Ear analysis) and
 * before_prompt_build (inject current time + Ear action plan). Also the
 * before_agent_start mint point — the second of the ONLY two places a flow id is
 * minted (the first being message_received). Flavor-agnostic — flavor-specific
 * prompt context (brand kit, identity, persona) is injected by the per-flavor
 * extensions in their own before_prompt_build hooks, and conversation-message
 * logging stays in those extensions too.
 */

import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
} from "../plugins/types.js";
import { fastAckText } from "./ack.js";
import { pryvaFetch } from "./backend.js";
import type { PipelineInboundContext } from "./context.js";
import { generateFlowId, normalizeTrigger, type FlowSource } from "./flow-registry.js";
import { logFlowStep, sleep, type PryvaPipeline } from "./pipeline.js";
import { currentTimeContext } from "./time.js";

// Inbound dedup — REQUIRED, not an optimization. Two dispatch paths re-fire
// message_received for the SAME message: (a) the plugin loads in more than one
// runtime context, and (b) when the reply session is held by a slow prior turn,
// the Telegram ingress spooler retries the SAME update on a backoff of up to
// ~60s — each retry fires the hook again. Without this guard every retry minted
// a fresh flow id and re-ran Ear (observed live: 5 duplicate flows + 5 Ear LLM
// calls for one message). Keyed on channel:sender:content; the 5 min window
// covers the full spool backoff.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const recentInbound = new Map<string, number>();

function seenRecently(key: string): boolean {
  const now = Date.now();
  if (recentInbound.size > 500) {
    for (const [k, t] of recentInbound) {
      if (now - t > DEDUP_WINDOW_MS) {
        recentInbound.delete(k);
      }
    }
  }
  const prev = recentInbound.get(key);
  if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) {
    return true;
  }
  recentInbound.set(key, now);
  return false;
}

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

/**
 * Deliver a native fast-ack (D3) via the channel layer's core `sendMessage` —
 * NOT by spawning the CLI. Lazy-imported so the inbound path never pays the
 * outbound-module load cost unless a fast-ack actually fires. Resolves the
 * gateway from the captured raw cfg. Fire-and-forget at every call site: a
 * delivery failure is logged at debug level and swallowed (best-effort) — the
 * ack is a courtesy greeting, never a load-bearing message.
 */
async function deliverFastAck(
  pipeline: PryvaPipeline,
  opts: { to: string; content: string; channel: string; accountId?: string },
): Promise<void> {
  if (!pipeline.rawCfg) {
    return;
  }
  try {
    const { sendMessage } = await import("../infra/outbound/message.js");
    await sendMessage({
      to: opts.to,
      content: opts.content,
      channel: opts.channel,
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      cfg: pipeline.rawCfg,
      bestEffort: true,
    });
  } catch (err) {
    pipeline.log.debug(`fast-ack delivery failed: ${String(err)}`);
  }
}

/**
 * Log a `flow_start` trigger marker (C2). Called once per mint — from
 * message_received for message-triggered flows, and from before_agent_start for
 * non-message-triggered runs (heartbeat/cron/system/followup).
 */
function logFlowStart(
  pipeline: PryvaPipeline,
  flowId: string,
  source: FlowSource,
  opts: {
    trigger?: string;
    runId?: string;
    sessionKey?: string;
    channel?: string;
    sender?: string;
    parentFlowId?: string;
  },
): string {
  return logFlowStep(
    pipeline,
    { flowId },
    {
      step_name: "flow_start",
      step_type: "trigger",
      status: "ok",
      metadata: {
        source,
        trigger: opts.trigger ?? null,
        channel: opts.channel ?? null,
        sender: opts.sender ?? null,
        ...(opts.runId ? { run_id: opts.runId } : {}),
        ...(opts.sessionKey ? { session_key: opts.sessionKey } : {}),
        ...(opts.parentFlowId ? { parent_flow_id: opts.parentFlowId } : {}),
      },
    },
  );
}

/**
 * Log a `flow_resume` marker (C2) — a run that RE-ENTERS an existing flow rather
 * than starting a new one. The only producer today is an NCW completion
 * (D5, source="ncw_completion"); the seam is generic so future same-flow
 * continuations reuse it.
 */
function logFlowResume(
  pipeline: PryvaPipeline,
  flowId: string,
  source: FlowSource,
  opts: {
    agent?: string;
    jobId?: string;
    runId?: string;
    sessionKey?: string;
    parentFlowId?: string;
  },
): string {
  return logFlowStep(
    pipeline,
    { flowId },
    {
      step_name: "flow_resume",
      step_type: "trigger",
      status: "ok",
      metadata: {
        source,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.jobId ? { job_id: opts.jobId } : {}),
        ...(opts.runId ? { run_id: opts.runId } : {}),
        ...(opts.sessionKey ? { session_key: opts.sessionKey } : {}),
        ...(opts.parentFlowId ? { parent_flow_id: opts.parentFlowId } : {}),
      },
    },
  );
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

  // Same message re-dispatched (spool retry / dual runtime context) → the first
  // firing already minted the flow and ran Ear; the stored context serves the
  // eventual agent turn. Skip everything.
  if (content && seenRecently(`${channel}:${from}:${content}`)) {
    return;
  }

  const conversationId = ctx?.conversationId ?? null;
  // ctx.sessionKey is the SAME value the agent run sees as params.sessionKey
  // (hook-message.types.ts), so binding it here lets before_agent_start + every
  // telemetry/outbound step resolve back to THIS flow structurally.
  const sessionKey = ctx?.sessionKey ?? pipeline.ctxStore.key(conversationId, channel, from);
  const runId = ctx?.runId;
  const flowId = generateFlowId();

  // Provisional source: internal channel → internal_chat; otherwise contact by
  // default and refine to owner_message after Ear resolves is_owner. Bind
  // IMMEDIATELY (before Ear) so the agent run — whenever it starts — resolves to
  // this flow. Both runId (populated for message_received) and sessionKey are
  // bound; message_received is fire-and-forget, so the runId binding may not win
  // every race, which is exactly why before_agent_start also bridges via
  // sessionKey (race-safe).
  const provisionalSource: FlowSource =
    channel === "internal" ? "internal_chat" : "contact_message";
  const binding = pipeline.registry.bindFlow(flowId, provisionalSource, {
    runId,
    sessionKey,
    channel,
    sender: from,
  });

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
  pipeline.ctxStore.set(pipeline.ctxStore.key(conversationId, channel, from), entry);
  pipeline.ctxStore.cleanupStale();

  // Fast-ack (D3): a canned, instant "I'm on it" BEFORE any slow work — never
  // blocks. Delivered via the channel layer's core sendMessage (deliverFastAck),
  // never by spawning the CLI. fastAckText returns null for trivial messages
  // (greetings/acks), so those get no ack. Fires on every channel including
  // internal (I5); internal delivery becomes real once D4 registers it.
  const ack = content ? fastAckText(content) : null;
  if (ack) {
    logFlowStep(
      pipeline,
      { flowId },
      {
        step_name: "fast_ack",
        step_type: "outbound",
        status: "ok",
        output_text: ack,
        metadata: { pryva_ack: true, channel, sender: from },
      },
    );
    void deliverFastAck(pipeline, { to: from, content: ack, channel });
  }

  // flow_start finalizer (C2): the flow is ALREADY bound structurally (above), so
  // nothing is orphaned during the Ear window. We log the flow_start STEP after
  // Ear so `source` reflects is_owner — but ALWAYS log it (finally), even if Ear
  // throws/times out, so a flow can never end up without its trigger marker.
  const finalizeFlowStart = (refineFromEar: boolean) => {
    if (refineFromEar && channel !== "internal") {
      binding.source = entry.earPlan?.is_owner === true ? "owner_message" : "contact_message";
    }
    logFlowStart(pipeline, flowId, binding.source, {
      trigger: "user",
      runId,
      sessionKey,
      channel,
      sender: from,
    });
  };

  // Ear is FIRE-AND-FORGET (D3): before_prompt_build has its own wait-loop for the
  // plan, so message_received must not block on Ear latency. flow_start is logged
  // when Ear settles (finally); if Ear is disabled/empty, log it immediately.
  if (content && !pipeline.cfg.pipeline.disableEar) {
    void (async () => {
      try {
        await runEar(pipeline, entry);
        const intent = typeof entry.earPlan?.intent === "string" ? entry.earPlan.intent : "";
        pipeline.log.debug(`ear intent=${intent} [${flowId}]`);
      } catch (err) {
        pipeline.log.debug(`ear failed: ${String(err)}`);
      } finally {
        finalizeFlowStart(true);
      }
    })();
  } else {
    finalizeFlowStart(false);
  }
}

/**
 * The second mint point (parent §D1.2). Fires once per agent run, at run start,
 * with the run's full structural ctx (runId + sessionKey + trigger). Binds every
 * non-message-triggered run to a flow, and consumes external-flow attachments
 * (D5 NCW continuation) / source hints (D6 followup drain). Idempotent across
 * the multiple times before_agent_start can fire per run (model-resolve +
 * prompt-build phases) via the "already bound → no-op" guard.
 */
export async function onBeforeAgentStart(
  pipeline: PryvaPipeline,
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeAgentStartResult | void> {
  const runId = ctx?.runId ?? event?.runId;
  // Without a runId we cannot bind structurally, and minting an unattributable
  // flow would only hide the gap — leave it; the run's telemetry resolves via
  // sessionKey or surfaces honestly as fl-unbound.
  if (!runId) {
    return;
  }

  // 1. Already bound (message_received bound this run, or an earlier fire of
  //    this same hook did) → nothing to do. This is the idempotent guard.
  if (pipeline.registry.getFlowForRun(runId)) {
    return;
  }

  const sessionKey = ctx?.sessionKey;
  const sessionId = ctx?.sessionId;
  const channel = ctx?.channel;
  const sender = ctx?.senderId;

  // 2. External flow attached (D5 NCW continuation): bind the EXISTING parent
  //    flow to this run and log a flow_resume — never a new flow (invariant I4).
  const external = pipeline.registry.consumeExternalFlow(runId);
  if (external) {
    pipeline.registry.bindFlow(external.flowId, external.source, {
      runId,
      sessionKey,
      sessionId,
      ...(external.parentFlowId ? { parentFlowId: external.parentFlowId } : {}),
    });
    logFlowResume(pipeline, external.flowId, external.source, {
      agent: external.agent,
      jobId: external.jobId,
      runId,
      sessionKey,
      parentFlowId: external.parentFlowId,
    });
    return;
  }

  // 3. Forced source hint (D6 followup drain): mint a NEW flow tagged followup,
  //    ahead of any session bridge, so a queued followup in the same
  //    conversation does NOT silently fold into the original message's flow.
  const hint = pipeline.registry.consumeSourceHint(runId);
  if (hint) {
    const flowId = generateFlowId();
    pipeline.registry.bindFlow(flowId, hint, { runId, sessionKey, sessionId, channel, sender });
    logFlowStart(pipeline, flowId, hint, {
      trigger: ctx?.trigger,
      runId,
      sessionKey,
      channel,
      sender,
    });
    return;
  }

  // 4. Race-safe bridge: message_received is fire-and-forget and may not have
  //    bound this runId yet, but it DID bind the sessionKey (same value the run
  //    sees). If a binding exists for this run/session, this turn belongs to it
  //    — bridge runId onto it, no mint, no new flow_start (invariant I2).
  const existing = pipeline.registry.resolve(runId, sessionId, sessionKey);
  if (existing) {
    pipeline.registry.bindFlow(existing.flowId, existing.source, {
      runId,
      sessionKey,
      sessionId,
      ...(existing.parentFlowId ? { parentFlowId: existing.parentFlowId } : {}),
    });
    return;
  }

  // 5. Genuine non-message-triggered run (heartbeat / cron / system) → mint a
  //    new flow with the normalized trigger source.
  const source = normalizeTrigger(ctx?.trigger);
  const flowId = generateFlowId();
  pipeline.registry.bindFlow(flowId, source, { runId, sessionKey, sessionId, channel, sender });
  logFlowStart(pipeline, flowId, source, {
    trigger: ctx?.trigger,
    runId,
    sessionKey,
    channel,
    sender,
  });
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
