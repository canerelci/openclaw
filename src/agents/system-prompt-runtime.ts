import {
  normalizePromptCapabilityIds,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "@openclaw/ai/internal/shared";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import type { SystemPromptRuntimeInfo } from "./system-prompt.types.js";

export function buildRuntimeLine(
  runtimeInfo?: SystemPromptRuntimeInfo,
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
): string {
  const normalizedRuntimeCapabilities = normalizePromptCapabilityIds(runtimeCapabilities);
  // Transcript ids rotate on rewind; isolated cron keys also carry per-run ids.
  // Keep only stable session identity in the cached Runtime line.
  const { baseSessionKey } = parseCronRunScopeSuffix(runtimeInfo?.sessionKey);
  const fields = {
    name: runtimeInfo?.agentName,
    agent: runtimeInfo?.agentId,
    session: baseSessionKey && sanitizeForPromptLiteral(baseSessionKey),
    sessionUrl: runtimeInfo?.sessionUrl && sanitizeForPromptLiteral(runtimeInfo.sessionUrl),
    // Host/dev fields (host, repo, os/arch, node, shell) are omitted: a messaging
    // assistant runs no shell on the host, so they are pure noise in its prompt.
    active_node: runtimeInfo?.activeNode && sanitizeForPromptLiteral(runtimeInfo.activeNode),
    active_node_identity: runtimeInfo?.activeNodeIdentity,
    model: runtimeInfo?.model,
    default_model: runtimeInfo?.defaultModel,
    channel: runtimeChannel,
    capabilities: runtimeChannel && (normalizedRuntimeCapabilities.join(",") || "none"),
  };
  return `Runtime: ${Object.entries(fields)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(" | ")}`;
}
/** Complete only the renderer-owned runtime region with the executing host's facts. */
export function completeSystemPromptRuntime(
  systemPrompt: string,
  environment: SystemPromptRuntimeInfo,
): string {
  return systemPrompt.replace(
    SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
    () =>
      ` | ${buildRuntimeLine(environment).slice("Runtime: ".length)}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`,
  );
}
