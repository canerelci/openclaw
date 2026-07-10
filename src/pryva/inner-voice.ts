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
/** Cron-name tag for a backend-driven scheduled-todo self-turn — distinct from inner-voice so a
 *  cancel-on-inbound for one never removes the other. No `:` allowed. */
export const SCHEDULED_TODO_TAG = "pryva-scheduled-todo";

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
 * Schedule a one-shot self-originated turn on a session — the generic primitive behind BOTH the
 * first-contact inner-voice and a backend-driven scheduled-todo. Frames `thought` as the assistant's
 * own monologue and schedules a cron-backed agentTurn (NOT an inbound → no message_received, so no
 * Ear / contact_message / fast_ack), then pre-sets the session source hint so the wake mints a NEW
 * flow tagged `source` (parented to `parentFlowId`). Fail-open: no scheduler / failed schedule → does
 * nothing, returns false. Returns true when armed.
 */
export async function scheduleSelfWake(
  pipeline: PryvaPipeline,
  opts: {
    sessionKey: string;
    /** Raw first-person impulse; framed here into the self-thought wrapper (never pre-frame it). */
    thought: string;
    source: FlowSource;
    reason: string;
    tag: string;
    parentFlowId?: string;
    /** When set, the wake RE-ENTERS this existing (backend-minted) flow via flow_resume instead of
     *  minting a new child — for platform announcements whose flow the backend already started. */
    resumeFlowId?: string;
    delaySeconds?: number;
    cancelOnInbound?: boolean;
    channel?: string;
    agentId?: string;
  },
): Promise<boolean> {
  const { sessionKey, thought, source, reason, tag, parentFlowId } = opts;
  if (!sessionKey || !thought || !pipeline.scheduleSessionTurn) {
    pipeline.log.debug(
      `self-wake: skipped (no ${!sessionKey ? "session" : !thought ? "thought" : "scheduler"})`,
    );
    return false;
  }

  const delaySeconds = opts.delaySeconds ?? DEFAULT_DELAY_SECONDS;
  const delayMs = Math.max(MIN_DELAY_MS, Math.round(delaySeconds * 1000));
  const message = buildInnerVoiceMessage(thought);
  const params: PluginSessionTurnScheduleParams = {
    sessionKey,
    message,
    delayMs,
    deleteAfterRun: true,
    deliveryMode: "announce",
    tag,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };

  let handle: unknown;
  try {
    handle = await pipeline.scheduleSessionTurn(params);
  } catch (err) {
    pipeline.log.debug(`self-wake: schedule failed: ${String(err)}`);
    handle = undefined;
  }
  // H1 fallback: pipeline.scheduleSessionTurn may no-op when (a) pre-warm re-bound the API
  // without hostServices.cron, or (b) the first publisher's shouldCommit fails because a later
  // registry is now active. The gateway still owns cron on __pryvaHostCron — schedule directly.
  if (!handle) {
    const hostCron = getPublishedHostCron() as { add?: (job: unknown) => Promise<unknown> } | null;
    if (hostCron) {
      try {
        const { schedulePluginSessionTurn } =
          await import("../plugins/host-hook-scheduled-turns.js");
        handle = await schedulePluginSessionTurn({
          pluginId: "pryva-pipeline",
          pluginName: "pryva-pipeline",
          origin: "bundled",
          schedule: params,
          cron: hostCron as never,
          // Always commit: this is the live gateway cron, not a stale registry side-effect.
          shouldCommit: () => true,
        });
        if (handle) {
          pipeline.log.debug("self-wake: armed via __pryvaHostCron fallback");
        }
      } catch (err) {
        pipeline.log.debug(`self-wake: host-cron fallback failed: ${String(err)}`);
      }
    }
  }
  if (!handle) {
    // Scheduler declined (cron unavailable / not committed) — do NOT set the hint, so no stale
    // source hint can be picked up by a later unrelated run on this session.
    pipeline.log.debug("self-wake: scheduler returned no handle; not armed");
    return false;
  }

  // Armed. Attribute the wake's future run — two shapes:
  //  - RESUME an existing external flow (`resumeFlowId`, source `platform`): the backend already minted
  //    the flow and logged its flow_start, so the wake must RE-ENTER that SAME id (no fragmentation).
  //    Attach it by session → onBeforeAgentStart step 2 binds it + logs flow_resume. parentFlowId ==
  //    flowId records the linkage, matching the NCW/subagent attach convention.
  //  - MINT a NEW child flow tagged `source` (inner_voice / scheduled_todo): a genuinely new
  //    self-originated trigger; the session source hint → onBeforeAgentStart step 3b mints it, parented,
  //    with `reason` as the logged trigger (e.g. `first_contact_followup` / `todo:<id>`).
  if (opts.resumeFlowId) {
    pipeline.registry.attachExternalFlowBySession(
      sessionKey,
      opts.resumeFlowId,
      source,
      opts.resumeFlowId,
    );
  } else {
    pipeline.registry.setSourceHintBySession(sessionKey, source, parentFlowId, reason);
  }
  if (opts.cancelOnInbound) {
    pendingCancelOnInbound.add(sessionKey);
  }

  // Land the `ocw_<source>_scheduled` marker on the flow the wake will actually run under: the resumed
  // id when resuming, else the parent the child hangs off.
  const attributionFlowId = opts.resumeFlowId ?? parentFlowId;
  logFlowStep(
    pipeline,
    { sessionKey, ...(attributionFlowId ? { flowId: attributionFlowId } : {}) },
    {
      step_name: `ocw_${source}_scheduled`,
      step_type: "trigger",
      status: "ok",
      metadata: {
        reason,
        delay_seconds: delaySeconds,
        cancel_on_inbound: opts.cancelOnInbound === true,
        session_key: sessionKey,
        ...(opts.channel ? { channel: opts.channel } : {}),
      },
    },
  );
  pipeline.log.debug(
    `self-wake: armed (${source}/${reason}, +${Math.round(delayMs / 1000)}s) [${sessionKey}]`,
  );
  return true;
}

/**
 * Schedule a one-shot inner-voice self-wake (first-contact silence follow-up). Thin wrapper over
 * scheduleSelfWake with source=`inner_voice` + the inner-voice cron tag.
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
  await scheduleSelfWake(pipeline, {
    sessionKey: opts.sessionKey,
    thought: opts.directive.thought,
    source: INNER_VOICE_SOURCE,
    reason: opts.directive.reason,
    tag: INNER_VOICE_TAG,
    delaySeconds: opts.directive.delaySeconds,
    cancelOnInbound: opts.directive.cancelOnInbound,
    ...(opts.parentFlowId ? { parentFlowId: opts.parentFlowId } : {}),
    ...(opts.channel ? { channel: opts.channel } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  });
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

// ---- Gateway seam: a write-scoped in-process self-turn trigger for the backend ----
//
// The backend cannot use the `openclaw cron add` RPC (it needs operator.admin, which a headless
// tenant device can't be granted). It CAN call `sessions.send` (operator.write). So the pryva
// pipeline publishes this self-turn function on globalThis; the core gateway `sessions.send` handler
// invokes it for an `innerVoice` request instead of delivering an inbound — running the framed thought
// as a self-turn IN-PROCESS (via the host cron service scheduleSessionTurn), which needs no operator
// scope. Same globalThis pattern as `__pryvaFlowRegistry`; a no-op read when the plugin isn't loaded.

/** Request shape the gateway sessions.send innerVoice branch passes to the published surface. */
export type PryvaSelfTurnRequest = {
  sessionKey: string;
  /** Raw impulse; the surface frames it. */
  thought: string;
  /** Flow source for the turn (default `scheduled_todo`). A flow_resume source (e.g. `platform`) makes
   *  the turn RE-ENTER `parentFlowId` instead of minting a new flow — see FLOW_RESUME_SELF_TURN_SOURCES. */
  source?: string;
  reason?: string;
  parentFlowId?: string;
  /** Fire delay; defaults to 0 (→ the 1s cron floor) so a due todo fires promptly. */
  delaySeconds?: number;
  channel?: string;
};
export type PryvaSelfTurnFn = (req: PryvaSelfTurnRequest) => Promise<boolean>;

const SELF_TURN_GLOBAL_KEY = "__pryvaSelfTurn";
/** Process-global host cron service (gateway only). Schedule wrappers read this at CALL time so a
 *  later pre-warm registry without hostServices cannot deaden the seam even if it re-publishes. */
const HOST_CRON_GLOBAL_KEY = "__pryvaHostCron";
const SELF_TURN_META_KEY = "__pryvaSelfTurnMeta";

/**
 * Self-turn sources that RE-ENTER an externally-minted flow (flow_resume) instead of minting a new
 * self-originated flow. `platform` = a Pryva-platform → assistant announcement whose flow the backend
 * already started (and logged flow_start for); the wake must share that id, not fork a child. For these
 * the incoming pryvaFlowId (mapped to `parentFlowId` by the gateway) IS the flow to resume — see
 * scheduleSelfWake's resume branch.
 */
const FLOW_RESUME_SELF_TURN_SOURCES: ReadonlySet<FlowSource> = new Set<FlowSource>(["platform"]);

/**
 * Publish the gateway host cron on globalThis so scheduleSessionTurn callers can fall back to it
 * when a later plugin registry was loaded without hostServices (H1). Call from the gateway path
 * only — pre-warm must not clear it. Non-fatal in a locked-down runtime.
 */
export function publishHostCron(cron: unknown): void {
  if (!cron || typeof cron !== "object") {
    return;
  }
  try {
    const g = globalThis as Record<string, unknown>;
    // Prefer the first real cron; never let a null/undefined overwrite it.
    if (g[HOST_CRON_GLOBAL_KEY]) {
      return;
    }
    g[HOST_CRON_GLOBAL_KEY] = cron;
  } catch {
    // locked-down runtime
  }
}

export function getPublishedHostCron(): unknown {
  try {
    return (globalThis as Record<string, unknown>)[HOST_CRON_GLOBAL_KEY] ?? null;
  } catch {
    return null;
  }
}

/** Publish the self-turn trigger on globalThis, capturing the pipeline. Call after the pipeline (and
 *  its scheduleSessionTurn handle) exists. Non-fatal in a locked-down runtime.
 *
 *  H1 guard — two layers (the prior hasScheduler boolean was insufficient):
 *  1. FIRST publisher wins. The gateway's first plugin load has hostServices.cron; the post-ready
 *     agent-runtime pre-warm reloads plugins WITHOUT hostServices. scheduleSessionTurn is present on
 *     BOTH pipelines (the API always exposes the method) — the pre-warm's version just returns no
 *     handle at call time because getHostCronService() is empty. Checking Boolean(scheduleSessionTurn)
 *     therefore cannot tell them apart; never overwrite an already-published self-turn.
 *  2. The scheduleSessionTurn wrapper itself closes over the pipeline at publish time; first-wins
 *     keeps the gateway closure. Additionally, registry schedulePluginSessionTurn is patched via
 *     __pryvaHostCron so even a late publisher can still schedule if needed. */
export function publishSelfTurn(pipeline: PryvaPipeline): void {
  try {
    const g = globalThis as Record<string, unknown>;
    if (typeof g[SELF_TURN_GLOBAL_KEY] === "function") {
      // Keep the first (gateway) publisher; pre-warm / re-register no-op.
      return;
    }
  } catch {
    // ignore meta read failures
  }

  const fn: PryvaSelfTurnFn = async (req) => {
    if (!req?.sessionKey || !req?.thought) {
      return false;
    }
    const source = (req.source as FlowSource) || "scheduled_todo";
    // A flow_resume source (platform) RE-ENTERS the backend's flow: the incoming pryvaFlowId (mapped to
    // parentFlowId by the gateway) IS the flow to resume, not a parent to hang a child off. Route it to
    // resumeFlowId so the wake logs flow_resume on that ONE shared id instead of minting a child.
    const resumeFlowId =
      FLOW_RESUME_SELF_TURN_SOURCES.has(source) && req.parentFlowId ? req.parentFlowId : undefined;
    return scheduleSelfWake(pipeline, {
      sessionKey: req.sessionKey,
      thought: req.thought,
      source,
      reason:
        req.reason ||
        (typeof req.source === "string" && req.source ? req.source : "scheduled_todo"),
      tag: SCHEDULED_TODO_TAG,
      // A scheduled todo / platform announce is due work, not a greeting follow-up: never cancel on inbound.
      cancelOnInbound: false,
      delaySeconds: req.delaySeconds ?? 0,
      ...(resumeFlowId
        ? { resumeFlowId }
        : req.parentFlowId
          ? { parentFlowId: req.parentFlowId }
          : {}),
      ...(req.channel ? { channel: req.channel } : {}),
    });
  };
  try {
    const g = globalThis as Record<string, unknown>;
    g[SELF_TURN_GLOBAL_KEY] = fn;
    g[SELF_TURN_META_KEY] = {
      hasScheduler: Boolean(pipeline.scheduleSessionTurn),
      publishedAt: Date.now(),
    };
  } catch {
    // locked-down runtime — non-fatal; the seam just won't fire.
  }
}

export function getPryvaSelfTurn(): PryvaSelfTurnFn | null {
  return ((globalThis as Record<string, unknown>)[SELF_TURN_GLOBAL_KEY] as PryvaSelfTurnFn) ?? null;
}
