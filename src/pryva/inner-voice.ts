/**
 * Inner voice — the agent waking ITSELF with a self-originated thought.
 *
 * The backend decides WHEN a self-thought is warranted and authors the impulse
 * (the `thought`, in the owner's language); this fork owns the MECHANISM (schedule
 * a one-shot self-wake) and the FRAMING (wrap the impulse so the agent reads it as
 * its own private monologue, not a system prompt firing). Its first customer is the
 * first-contact silence follow-up: greet-only, let it breathe, then — if the owner
 * stayed quiet — ease into the work on the assistant's own initiative.
 *
 * Wiring:
 *  - The backend emits an optional `inner_voice` directive on a first-contact claim
 *    (`/pipeline/quick-reply`) or Ear plan (`/pipeline/ear`). `parseInnerVoiceDirective`
 *    validates it; `scheduleInnerVoice` schedules the wake; `cancelInnerVoice` drops it
 *    when the owner re-engages first. Everything is FAIL-OPEN — a missing/invalid
 *    directive, or a missing scheduler, simply schedules nothing.
 *  - The wake is a cron-backed one-shot AGENT TURN (not a canned announce): the framed
 *    thought is the turn prompt, so the model THINKS and decides what (if anything) to
 *    say. Delivery + Cortex/Mouth stay the normal outbound path.
 *  - It mints a NEW flow tagged `inner_voice` (a genuine new trigger, never a resume of
 *    the completed greeting flow): we pre-set a session source hint so the wake's
 *    before_agent_start mints `inner_voice` (with the greeting flow as parent) ahead of
 *    the race-safe session bridge — see onBeforeAgentStart step 3b.
 */

import type { PluginSessionTurnScheduleParams } from "../plugins/types.js";
import type { FlowSource } from "./flow-registry.js";
import { logFlowStep, type PryvaPipeline } from "./pipeline.js";

/** Cron-name tag for the scheduled wake; cancel-on-inbound removes by this tag. No `:` allowed. */
export const INNER_VOICE_TAG = "pryva-inner-voice";

const INNER_VOICE_SOURCE: FlowSource = "inner_voice";

/** Fallback delay when the backend omits/blanks `delay_seconds` (mirrors the backend default). */
const DEFAULT_DELAY_SECONDS = 60;
/** Cron timing is minute-granular; a floor keeps a bad/zero value from firing instantly. */
const MIN_DELAY_MS = 1000;
const DEFAULT_REASON = "inner_voice";

/** A validated inner-voice directive (the backend's optional `inner_voice` object, normalized). */
export type InnerVoiceDirective = {
  delaySeconds: number;
  thought: string;
  reason: string;
  cancelOnInbound: boolean;
};

/**
 * Validate the backend's optional `inner_voice` object into a typed directive, or null when absent
 * / malformed / missing an impulse. Conservative: only a non-empty `thought` yields a directive.
 */
export function parseInnerVoiceDirective(raw: unknown): InnerVoiceDirective | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const thought = typeof obj.thought === "string" ? obj.thought.trim() : "";
  if (!thought) {
    return null;
  }
  const rawDelay = Number(obj.delay_seconds);
  const delaySeconds = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : DEFAULT_DELAY_SECONDS;
  const reason =
    typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : DEFAULT_REASON;
  // Default to cancelling on inbound (the impulse is moot once the owner re-engages); only an
  // explicit `false` keeps the wake alive regardless.
  const cancelOnInbound = obj.cancel_on_inbound !== false;
  return { delaySeconds, thought, reason, cancelOnInbound };
}

/**
 * Wrap the raw impulse so the agent experiences it as its OWN private thought — self-aware framing,
 * not an unlabeled line a weak model might narrate out loud. Only the assistant's message to the
 * owner leaves its mouth; the thought itself stays inside. The impulse is in the owner's language;
 * the persona (SOUL) governs the outgoing message's voice.
 */
export function buildInnerVoiceMessage(thought: string): string {
  return [
    "(Your own thought — no one messaged you. This is you, thinking to yourself.)",
    `"${thought}"`,
    "",
    "Act on this thought. Do any needed work silently. If there is a single, natural thing to say " +
      "to your owner, say it in ONE short message, in your own voice (per your persona / SOUL). If " +
      "your owner has already written since your last message, or there is nothing worth saying, " +
      "reply with exactly NO_REPLY.",
  ].join("\n");
}

/** sessionKeys with a live cancel-on-inbound wake pending. Gates the cron-list cost of a cancel to
 *  the rare sessions that actually scheduled one, so normal inbound traffic never pays for it.
 *  Module-scoped (like the inbound dedup maps) so it survives plugin hot-reloads within a process. */
const pendingCancelOnInbound = new Set<string>();

/**
 * Schedule a one-shot inner-voice self-wake for a session. Fail-open at every step: no scheduler
 * (non-bundled api / tests) or a failed schedule simply does nothing. On success, pre-sets the
 * session source hint so the wake mints a NEW `inner_voice` flow (parented to the greeting flow).
 */
export async function scheduleInnerVoice(
  pipeline: PryvaPipeline,
  opts: {
    sessionKey: string;
    directive: InnerVoiceDirective;
    parentFlowId?: string;
    channel?: string;
    agentId?: string;
  },
): Promise<void> {
  const { sessionKey, directive, parentFlowId } = opts;
  if (!sessionKey || !pipeline.scheduleSessionTurn) {
    pipeline.log.debug(
      `inner-voice: scheduling skipped (no ${sessionKey ? "scheduler" : "session"})`,
    );
    return;
  }

  const delayMs = Math.max(MIN_DELAY_MS, Math.round(directive.delaySeconds * 1000));
  const message = buildInnerVoiceMessage(directive.thought);
  const params: PluginSessionTurnScheduleParams = {
    sessionKey,
    message,
    delayMs,
    deleteAfterRun: true,
    deliveryMode: "announce",
    tag: INNER_VOICE_TAG,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };

  let handle: unknown;
  try {
    handle = await pipeline.scheduleSessionTurn(params);
  } catch (err) {
    pipeline.log.debug(`inner-voice: schedule failed: ${String(err)}`);
    return;
  }
  if (!handle) {
    // Scheduler declined (cron unavailable / not committed) — do NOT set the hint, so no stale
    // source hint can be picked up by a later unrelated run on this session.
    pipeline.log.debug("inner-voice: scheduler returned no handle; not armed");
    return;
  }

  // Armed: tag the wake's future run as a NEW inner_voice flow (parented to the greeting), ahead of
  // the session bridge, and use `reason` as the logged trigger (e.g. `first_contact_followup`).
  pipeline.registry.setSourceHintBySession(
    sessionKey,
    INNER_VOICE_SOURCE,
    parentFlowId,
    directive.reason,
  );
  if (directive.cancelOnInbound) {
    pendingCancelOnInbound.add(sessionKey);
  }

  logFlowStep(
    pipeline,
    { sessionKey, ...(parentFlowId ? { flowId: parentFlowId } : {}) },
    {
      step_name: "ocw_inner_voice_scheduled",
      step_type: "trigger",
      status: "ok",
      metadata: {
        reason: directive.reason,
        delay_seconds: directive.delaySeconds,
        cancel_on_inbound: directive.cancelOnInbound,
        session_key: sessionKey,
        ...(opts.channel ? { channel: opts.channel } : {}),
      },
    },
  );
  pipeline.log.debug(
    `inner-voice: armed (${directive.reason}, +${Math.round(delayMs / 1000)}s) [${sessionKey}]`,
  );
}

/**
 * Cancel a pending inner-voice wake for a session because the owner re-engaged before it fired.
 * Cheap fast-path: does nothing unless this session actually armed a cancel-on-inbound wake. Drops
 * both the scheduled cron turn and the pending source hint so neither can fire/leak.
 */
export async function cancelInnerVoice(pipeline: PryvaPipeline, sessionKey: string): Promise<void> {
  if (!sessionKey || !pendingCancelOnInbound.has(sessionKey)) {
    return;
  }
  pendingCancelOnInbound.delete(sessionKey);
  // Drop the source hint first so even if the unschedule races the fire, the run won't mint a stale
  // inner_voice flow.
  pipeline.registry.clearSourceHintBySession(sessionKey);
  if (pipeline.unscheduleSessionTurnsByTag) {
    try {
      await pipeline.unscheduleSessionTurnsByTag({ sessionKey, tag: INNER_VOICE_TAG });
    } catch (err) {
      pipeline.log.debug(`inner-voice: cancel failed: ${String(err)}`);
    }
  }
  logFlowStep(
    pipeline,
    { sessionKey },
    {
      step_name: "ocw_inner_voice_cancelled",
      step_type: "trigger",
      status: "ok",
      metadata: { reason: "owner_re_engaged", session_key: sessionKey },
    },
  );
  pipeline.log.debug(`inner-voice: cancelled (owner re-engaged) [${sessionKey}]`);
}
