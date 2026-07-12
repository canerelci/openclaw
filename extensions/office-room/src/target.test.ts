// Office Room tests cover target parsing behavior.
import { describe, expect, it } from "vitest";
import {
  buildOfficeRoomTarget,
  looksLikeOfficeRoomTarget,
  normalizeOfficeRoomTarget,
  parseOfficeRoomTarget,
} from "./target.js";

describe("Office Room targets", () => {
  it("parses the room broadcast target", () => {
    expect(parseOfficeRoomTarget("room")).toEqual({
      chatType: "group",
      kind: "room",
      id: "room",
    });
    expect(normalizeOfficeRoomTarget("office-room")).toBe("room");
  });

  it("parses directed participant targets", () => {
    expect(parseOfficeRoomTarget("dm:Mira")).toEqual({
      chatType: "direct",
      kind: "dm",
      id: "Mira",
    });
    expect(normalizeOfficeRoomTarget("@Mira")).toBe("dm:Mira");
    expect(normalizeOfficeRoomTarget("Mira")).toBe("dm:Mira");
    expect(buildOfficeRoomTarget(parseOfficeRoomTarget("dm:Iris"))).toBe("dm:Iris");
  });

  it("strips the channel prefix from directed targets", () => {
    expect(normalizeOfficeRoomTarget("office-room:dm:Mira")).toBe("dm:Mira");
  });

  it("rejects empty targets", () => {
    expect(() => parseOfficeRoomTarget("  ")).toThrow(/target is required/);
    expect(looksLikeOfficeRoomTarget("")).toBe(false);
  });
});
