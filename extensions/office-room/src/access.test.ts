// Office Room tests cover which room messages wake the agent.
import { describe, expect, it } from "vitest";
import { isAddressedToParticipant } from "./access.js";
import type { OfficeRoomMessage } from "./types.js";

function message(overrides: Partial<OfficeRoomMessage>): OfficeRoomMessage {
  return {
    id: 1,
    projectId: "demo",
    fromName: "Mira",
    mentions: [],
    urgency: "normal",
    body: "",
    reactions: [],
    attachments: [],
    createdAt: "2026-07-12T18:00:00.000Z",
    ...overrides,
  };
}

describe("isAddressedToParticipant", () => {
  it("matches the explicit mentions array case-insensitively", () => {
    expect(isAddressedToParticipant(message({ mentions: ["pryva"] }), "Pryva")).toBe(true);
  });

  it("matches a visible @Name in the body when mentions are missing", () => {
    expect(isAddressedToParticipant(message({ body: "@Pryva take T42." }), "Pryva")).toBe(true);
  });

  it("ignores room chatter between other participants", () => {
    expect(
      isAddressedToParticipant(message({ mentions: ["Iris"], body: "@Iris retest T42." }), "Pryva"),
    ).toBe(false);
  });

  it("does not match a name that merely prefixes another mention", () => {
    expect(isAddressedToParticipant(message({ body: "@Pryvabot ping" }), "Pryva")).toBe(false);
  });
});
