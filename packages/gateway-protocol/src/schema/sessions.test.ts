// Gateway Protocol tests cover sessions.send schema behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsSendParamsSchema } from "./sessions.js";

describe("SessionsSendParamsSchema — Pryva innerVoice self-wake", () => {
  it("accepts innerVoice without a delay (immediate self-turn)", () => {
    expect(
      Value.Check(SessionsSendParamsSchema, {
        key: "agent:main:main",
        message: "a self-originated thought",
        innerVoice: true,
      }),
    ).toBe(true);
  });

  it(
    "accepts innerVoice with delaySeconds (a scheduled self-wake) — regression for the owner-observed" +
      " 2026-07-11 bug where the backend's delaySeconds was rejected as an unexpected property, so every" +
      " delayed self-wake silently failed with INVALID_REQUEST and never fired.",
    () => {
      expect(
        Value.Check(SessionsSendParamsSchema, {
          key: "agent:main:main",
          message: "a self-originated thought",
          innerVoice: true,
          delaySeconds: 60,
        }),
      ).toBe(true);
    },
  );

  it("rejects a negative delaySeconds", () => {
    expect(
      Value.Check(SessionsSendParamsSchema, {
        key: "agent:main:main",
        message: "a self-originated thought",
        innerVoice: true,
        delaySeconds: -5,
      }),
    ).toBe(false);
  });

  it("accepts innerVoice with mustSpeak (a required owner notification like a plan-ready)", () => {
    expect(
      Value.Check(SessionsSendParamsSchema, {
        key: "agent:main:main",
        message: "your weekly plan is ready — tell the owner",
        innerVoice: true,
        mustSpeak: true,
      }),
    ).toBe(true);
  });

  it("still rejects a truly unknown property", () => {
    expect(
      Value.Check(SessionsSendParamsSchema, {
        key: "agent:main:main",
        message: "hello",
        notARealField: true,
      }),
    ).toBe(false);
  });

  it("accepts the base send with no Pryva fields at all", () => {
    expect(
      Value.Check(SessionsSendParamsSchema, {
        key: "agent:main:main",
        message: "hello",
      }),
    ).toBe(true);
  });
});
