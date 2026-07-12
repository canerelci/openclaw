/**
 * Resolves Office Room account configuration from root channel config, named
 * account overrides, and secret-provider references.
 */
import {
  createAccountListHelpers,
  hasConfiguredAccountValue,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import {
  normalizeSecretInputString,
  normalizeResolvedSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig, OfficeRoomAccountConfig, ResolvedOfficeRoomAccount } from "./types.js";

const DEFAULT_RECONNECT_MS = 1_500;
const MIN_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 100;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 500;
const DEFAULT_PARTICIPANT_KIND = "openclaw";
const DEFAULT_ROLE = "product-owner";

const {
  listAccountIds: listOfficeRoomAccountIds,
  resolveDefaultAccountId: resolveDefaultOfficeRoomAccountId,
} = createAccountListHelpers("office-room", {
  normalizeAccountId,
  hasImplicitDefaultAccount: (cfg) => {
    const channel = cfg.channels?.["office-room"];
    return Boolean(
      channel?.baseUrl?.trim() && channel.projectId?.trim() && channel.participantName?.trim(),
    );
  },
});

export { DEFAULT_ACCOUNT_ID, listOfficeRoomAccountIds, resolveDefaultOfficeRoomAccountId };

function resolveMergedOfficeRoomAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): OfficeRoomAccountConfig {
  return resolveMergedAccountConfig<OfficeRoomAccountConfig>({
    channelConfig: cfg.channels?.["office-room"] as OfficeRoomAccountConfig | undefined,
    accounts: cfg.channels?.["office-room"]?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

/**
 * Resolves the optional bearer token. The engine ships without auth, so an
 * absent token is a valid configuration — only a *misconfigured* secret ref
 * throws.
 */
function resolveOfficeRoomToken(params: {
  cfg: CoreConfig;
  value: unknown;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (!hasConfiguredAccountValue(params.value)) {
    return "";
  }
  const resolved = resolveSecretInputString({
    value: params.value,
    path:
      params.accountId === DEFAULT_ACCOUNT_ID
        ? "channels.office-room.token"
        : `channels.office-room.accounts.${params.accountId}.token`,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status !== "available") {
    if (resolved.status === "configured_unavailable" && resolved.ref.source === "env") {
      const providerConfig = params.cfg.secrets?.providers?.[resolved.ref.provider];
      if (providerConfig) {
        if (providerConfig.source !== "env") {
          throw new Error(
            `Secret provider "${resolved.ref.provider}" has source "${providerConfig.source}" but ref requests "env".`,
          );
        }
        if (providerConfig.allowlist && !providerConfig.allowlist.includes(resolved.ref.id)) {
          throw new Error(
            `Environment variable "${resolved.ref.id}" is not allowlisted in secrets.providers.${resolved.ref.provider}.allowlist.`,
          );
        }
      } else if (
        resolved.ref.provider !==
        resolveDefaultSecretProviderAlias({ secrets: params.cfg.secrets }, "env")
      ) {
        throw new Error(
          `Secret provider "${resolved.ref.provider}" is not configured (ref: env:${resolved.ref.provider}:${resolved.ref.id}).`,
        );
      }
      return normalizeSecretInputString((params.env ?? process.env)[resolved.ref.id]) ?? "";
    }
    return "";
  }
  return (
    normalizeResolvedSecretInputString({
      value: resolved.value,
      path: "channels.office-room.token",
    }) ?? ""
  );
}

/**
 * Builds the normalized account snapshot used by gateway, outbound delivery,
 * status reporting, and channel routing.
 */
export function resolveOfficeRoomAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedOfficeRoomAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = resolveMergedOfficeRoomAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.["office-room"]?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const baseUrl = merged.baseUrl?.trim().replace(/\/$/, "") ?? "";
  const token = resolveOfficeRoomToken({
    cfg: params.cfg,
    value: merged.token,
    accountId,
    env: params.env,
  });
  const projectId = merged.projectId?.trim() ?? "";
  const participantName = merged.participantName?.trim() ?? "";
  const leadName = normalizeOptionalString(merged.leadName);
  return {
    accountId,
    enabled,
    // Token is intentionally absent from the configured check: the engine has no
    // auth layer, so requiring one would leave the channel permanently unstarted.
    configured: Boolean(baseUrl && projectId && participantName),
    name: normalizeOptionalString(merged.name),
    baseUrl,
    token,
    projectId,
    participantName,
    participantKind: merged.participantKind?.trim() || DEFAULT_PARTICIPANT_KIND,
    role: merged.role?.trim() || DEFAULT_ROLE,
    repoPath: normalizeOptionalString(merged.repoPath),
    purpose: normalizeOptionalString(merged.purpose),
    leadName,
    summonedBy: normalizeOptionalString(merged.summonedBy),
    joinNotice: normalizeOptionalString(merged.joinNotice),
    agentId: normalizeOptionalString(merged.agentId),
    timeoutSeconds: merged.timeoutSeconds,
    toolsAllow: merged.toolsAllow,
    // Product Owner contract: an unaddressed reply goes to the lead when one is
    // configured, otherwise it is a plain room broadcast.
    defaultTo: merged.defaultTo?.trim() || (leadName ? `dm:${leadName}` : "room"),
    allowFrom: merged.allowFrom ?? ["*"],
    reconnectMs: resolveIntegerOption(merged.reconnectMs, DEFAULT_RECONNECT_MS, {
      min: MIN_RECONNECT_MS,
      max: MAX_RECONNECT_MS,
    }),
    historyLimit: resolveIntegerOption(merged.historyLimit, DEFAULT_HISTORY_LIMIT, {
      min: MIN_HISTORY_LIMIT,
      max: MAX_HISTORY_LIMIT,
    }),
    config: {
      ...merged,
      allowFrom: merged.allowFrom ?? ["*"],
    },
  };
}

/**
 * Returns all enabled accounts, including the implicit default account when
 * top-level Office Room config is present.
 */
export function listEnabledOfficeRoomAccounts(cfg: CoreConfig): ResolvedOfficeRoomAccount[] {
  return listOfficeRoomAccountIds(cfg)
    .map((accountId) => resolveOfficeRoomAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
