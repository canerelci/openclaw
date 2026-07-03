/**
 * D6 steering ROUTE — the fork half.
 *
 * When a message arrives during an ACTIVE run, the queue would (in `steer` mode) steer it straight
 * into the running turn. That's right for a message that CONTINUES/corrects the current work, but
 * wrong for an unrelated new topic — it derails the active task. This asks the backend to decide.
 *
 * SAFE BY DESIGN: returns `true` (steer, i.e. current behavior) on ANY failure — pryva not
 * configured, backend down, timeout, malformed response. A steering hiccup can NEVER change how a
 * normal message is handled; the ONLY behavior change is that an explicit `related:false` from the
 * backend makes the caller defer the message as a followup instead of steering it in. The backend
 * also sends a quick ack for the deferred message and aborts any NCW job it invalidated.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pryvaFetch } from "./backend.js";
import { resolvePryvaConfig } from "./config.js";

const STEER_ROUTE_TIMEOUT_MS = 3000;

/** True → steer into the active run (default/safe). False → defer as a followup. */
export async function pryvaSteerIsRelated(
  cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined,
  message: string,
): Promise<boolean> {
  try {
    if (!sessionKey || !message.trim()) {
      return true;
    }
    const resolved = resolvePryvaConfig(cfg);
    if (!resolved) {
      return true; // pryva not configured → keep native OCW queue behavior
    }
    const out = await pryvaFetch(
      resolved,
      "POST",
      "/pipeline/steer-route",
      { session_key: sessionKey, new_message: message },
      { timeoutMs: STEER_ROUTE_TIMEOUT_MS },
    );
    // Only an explicit related:false defers; everything else steers (safe default).
    const related = !(
      out &&
      typeof out === "object" &&
      (out as { related?: unknown }).related === false
    );
    if (!related) {
      // Tag the deferred followup so its run mints a NEW `followup` flow (behind the active flow)
      // instead of folding into the parent via the session bridge (D6).
      try {
        const reg = (globalThis as Record<string, unknown>).__pryvaFlowRegistry as
          | {
              getFlowForSession?: (k: string) => { flowId: string } | null;
              setSourceHintBySession?: (k: string, s: string, parent?: string) => void;
            }
          | undefined;
        const parent = reg?.getFlowForSession?.(sessionKey)?.flowId;
        reg?.setSourceHintBySession?.(sessionKey, "followup", parent);
      } catch {
        /* hint is best-effort */
      }
    }
    return related;
  } catch {
    return true;
  }
}
