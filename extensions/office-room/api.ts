/**
 * Public Office Room runtime API barrel used by plugin tests, docs, and
 * integration code that should not reach into src internals.
 */
export {
  DEFAULT_ACCOUNT_ID,
  listEnabledOfficeRoomAccounts,
  listOfficeRoomAccountIds,
  resolveDefaultOfficeRoomAccountId,
  resolveOfficeRoomAccount,
} from "./src/accounts.js";
export { isAddressedToParticipant } from "./src/access.js";
export { officeRoomPlugin } from "./src/channel.js";
export { officeRoomConfigSchema } from "./src/config-schema.js";
export { createOfficeRoomClient } from "./src/http-client.js";
export { buildRoomMessageBody, sendOfficeRoomText } from "./src/outbound.js";
export { getOfficeRoomRuntime, setOfficeRoomRuntime } from "./src/runtime.js";
export { buildOfficeRoomTarget, parseOfficeRoomTarget } from "./src/target.js";
export type {
  CoreConfig,
  OfficeRoomAccountConfig,
  OfficeRoomEvent,
  OfficeRoomMessage,
  OfficeRoomParticipant,
  OfficeRoomTarget,
  ResolvedOfficeRoomAccount,
} from "./src/types.js";
