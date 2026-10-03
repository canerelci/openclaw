/**
 * Group-session privacy switch for the Pryva pipeline.
 *
 * When the pipeline resolves, a group or channel session keeps its final
 * assistant text private. Posting requires the message tool. Non-Pryva
 * installs stay on the upstream automatic group reply.
 */

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { resolvePryvaConfig } from "./config.js";

export function isGroupSessionKey(sessionKey: string | undefined | null): boolean {
  if (!sessionKey?.trim()) {
    return false;
  }
  return classifySessionKind(sessionKey) === "group";
}

/** True only when this install runs the pipeline and the session is a group. */
export function pryvaGroupSessionKeepsFinalPrivate(
  cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined | null,
): boolean {
  return resolvePryvaConfig(cfg) != null && isGroupSessionKey(sessionKey);
}
