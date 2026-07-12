/**
 * Zod-backed config schema for Office Room channel accounts.
 */
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const OfficeRoomAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    // The engine is a project-local service and ships without auth today. The
    // token stays optional so the channel works now and starts sending a bearer
    // header the moment an operator sets one.
    token: buildSecretInputSchema().optional(),
    projectId: z.string().optional(),
    participantName: z.string().optional(),
    participantKind: z.string().optional(),
    role: z.string().optional(),
    repoPath: z.string().optional(),
    purpose: z.string().optional(),
    leadName: z.string().optional(),
    summonedBy: z.string().optional(),
    joinNotice: z.string().optional(),
    agentId: z.string().optional(),
    timeoutSeconds: z.number().int().min(1).max(3_600).optional(),
    toolsAllow: z.array(z.string()).optional(),
    defaultTo: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    reconnectMs: z.number().int().min(100).max(60_000).optional(),
    historyLimit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const OfficeRoomConfigSchema = OfficeRoomAccountConfigSchema.extend({
  accounts: z.record(z.string(), OfficeRoomAccountConfigSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

/**
 * Config schema exported to core so `openclaw doctor` and config validation
 * understand both default and named Office Room accounts.
 */
export const officeRoomConfigSchema = buildChannelConfigSchema(OfficeRoomConfigSchema);
