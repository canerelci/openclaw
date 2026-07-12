// Office Room tests cover the room mention contract on outbound messages.
import { describe, expect, it } from "vitest";
import { buildRoomMessageBody } from "./outbound.js";

describe("buildRoomMessageBody", () => {
  it("prepends the mention when the agent forgot it", () => {
    expect(buildRoomMessageBody({ text: "Checking T42 now.", mentionName: "Mira" })).toEqual({
      body: "@Mira Checking T42 now.",
      mentions: ["Mira"],
    });
  });

  it("keeps an existing mention in place instead of duplicating it", () => {
    expect(buildRoomMessageBody({ text: "@Mira Checking T42 now.", mentionName: "Mira" })).toEqual({
      body: "@Mira Checking T42 now.",
      mentions: ["Mira"],
    });
  });

  it("carries additional mentions written by the agent", () => {
    const result = buildRoomMessageBody({
      text: "@Iris please retest once @Mira lands it.",
      mentionName: "Mira",
    });
    expect(result.body).toBe("@Iris please retest once @Mira lands it.");
    expect(result.mentions).toEqual(expect.arrayContaining(["Mira", "Iris"]));
  });

  it("broadcasts with no mention when no participant is targeted", () => {
    expect(buildRoomMessageBody({ text: "Deploy is green." })).toEqual({
      body: "Deploy is green.",
      mentions: [],
    });
  });
});
