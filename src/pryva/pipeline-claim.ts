/**
 * Inbound claim hook: inbound_claim.
 *
 * For a TRIVIAL inbound message (greeting, thanks, a one-liner answerable with no
 * tools), skip the ENTIRE agent turn (Ear → main LLM → Cortex → Mouth) and reply
 * instantly from the backend. The backend owns the decision (it can reuse Ear or a
 * cheaper classifier) via `POST /pipeline/quick-reply`; the fork just asks and, on
 * a claim, delivers the returned reply and tells core it handled the message.
 *
 * SAFE / FAIL-OPEN by design:
 *  - Only SHORT messages are candidates (trivial turns are short); everything else
 *    passes straight through with NO backend call — so the extra round-trip never
 *    touches normal traffic.
 *  - `pryvaFetch` is fail-open with a tight timeout: backend down / 404 (endpoint
 *    not deployed yet) / timeout / malformed → treated as "not claimed" → the
 *    message runs the agent exactly as today. Shipping this before the backend
 *    endpoint exists changes nothing.
 *  - Conservative: only an explicit `{ claim:true, reply:<non-empty> }` short-circuits.
 */

import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from "../plugins/types.js";
import { pryvaFetch } from "./backend.js";
import { UNBOUND_FLOW_ID } from "./flow-registry.js";
import { parseInnerVoiceDirective, scheduleInnerVoice } from "./inner-voice.js";
import { logFlowStep, type PryvaPipeline } from "./pipeline.js";

/** Only consult the backend for short messages — trivial/short-circuitable turns
 *  are short, and this bounds the extra call so normal traffic never pays for it. */
const QUICK_REPLY_MAX_CHARS = 160;
/** Tight budget: a quick reply must be fast or we give up and run the agent. */
const QUICK_REPLY_TIMEOUT_MS = 3000;

export async function onInboundClaim(
  pipeline: PryvaPipeline,
  event: PluginHookInboundClaimEvent,
  ctx: PluginHookInboundClaimContext,
): Promise<PluginHookInboundClaimResult | void> {
  const message = (event?.content || "").trim();
  // Candidate gate: non-empty + short. Long messages are never trivial → pass with
  // no backend call.
  if (!message || message.length > QUICK_REPLY_MAX_CHARS) {
    return;
  }

  const sessionKey = event?.sessionKey ?? ctx?.sessionKey;
  const runId = event?.runId ?? ctx?.runId;
  const binding = pipeline.registry.resolve(runId, undefined, sessionKey);
  const flowId = binding?.flowId ?? UNBOUND_FLOW_ID;

  const result = (await pryvaFetch(
    pipeline.cfg,
    "POST",
    "/pipeline/quick-reply",
    {
      message,
      sender_id: event?.senderId ?? ctx?.senderId ?? null,
      channel: event?.channel ?? ctx?.channelId ?? null,
      conversation_id: event?.conversationId ?? ctx?.conversationId ?? null,
      is_group: event?.isGroup === true,
    },
    { flowId, timeoutMs: QUICK_REPLY_TIMEOUT_MS },
  )) as { claim?: unknown; reply?: unknown; inner_voice?: unknown } | null;

  const claimed = result?.claim === true;
  const reply = typeof result?.reply === "string" ? result.reply.trim() : "";
  if (!claimed || !reply) {
    return; // pass → the agent handles it as normal
  }

  // First-contact claim may carry an inner-voice directive: greet now, then wake ourselves a beat
  // later to ease into the work if the owner stays quiet. Present only on a FIRST-CONTACT claim;
  // fail-open (absent/invalid → nothing scheduled). Fire-and-forget so it never delays the reply.
  const directive = parseInnerVoiceDirective(result?.inner_voice);
  if (directive && sessionKey) {
    const channel = event?.channel ?? ctx?.channelId ?? undefined;
    void scheduleInnerVoice(pipeline, {
      sessionKey,
      directive,
      ...(binding?.flowId ? { parentFlowId: binding.flowId } : {}),
      ...(channel ? { channel } : {}),
    });
  }

  // Trace the short-circuit so operators can see a turn was answered without the agent.
  logFlowStep(
    pipeline,
    { flowId },
    {
      step_name: "ocw_inbound_claimed",
      step_type: "outbound",
      status: "ok",
      input_text: message.slice(0, 500),
      output_text: reply.slice(0, 500),
      metadata: {
        channel: event?.channel ?? ctx?.channelId ?? null,
        sender: event?.senderId ?? ctx?.senderId ?? null,
        pryva_quick_reply: true,
      },
    },
  );

  return { handled: true, reply: { text: reply } };
}
