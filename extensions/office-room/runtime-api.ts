/**
 * Public runtime injection surface used by the bundled Office Room entry.
 */
export {
  type OfficeRoomAccountConfig,
  type OfficeRoomEvent,
  type OfficeRoomMessage,
  type OfficeRoomParticipant,
  type OfficeRoomTarget,
  type ResolvedOfficeRoomAccount,
  createOfficeRoomClient,
  parseOfficeRoomTarget,
  resolveOfficeRoomAccount,
  setOfficeRoomRuntime,
} from "./api.js";
