import { describe, expect, it } from "vitest";
import { FlowRegistry } from "./flow-registry.js";
import { buildInnerVoiceMessage, parseInnerVoiceDirective } from "./inner-voice.js";

describe("parseInnerVoiceDirective", () => {
  it("returns null for absent / non-object / impulse-less input", () => {
    expect(parseInnerVoiceDirective(undefined)).toBeNull();
    expect(parseInnerVoiceDirective(null)).toBeNull();
    expect(parseInnerVoiceDirective("nope")).toBeNull();
    expect(parseInnerVoiceDirective({})).toBeNull();
    expect(parseInnerVoiceDirective({ thought: "   " })).toBeNull();
  });

  it("normalizes a full directive", () => {
    const d = parseInnerVoiceDirective({
      delay_seconds: 90,
      thought: "  Selam gibi bir şey sorayım.  ",
      reason: "first_contact_followup",
      cancel_on_inbound: true,
    });
    expect(d).toEqual({
      delaySeconds: 90,
      thought: "Selam gibi bir şey sorayım.",
      reason: "first_contact_followup",
      cancelOnInbound: true,
    });
  });

  it("applies defaults for missing/invalid fields and defaults cancelOnInbound to true", () => {
    const d = parseInnerVoiceDirective({ thought: "hi", delay_seconds: 0 });
    expect(d).toMatchObject({ delaySeconds: 60, reason: "inner_voice", cancelOnInbound: true });
  });

  it("keeps the wake alive only on an explicit cancel_on_inbound:false", () => {
    expect(
      parseInnerVoiceDirective({ thought: "hi", cancel_on_inbound: false })?.cancelOnInbound,
    ).toBe(false);
  });
});

describe("buildInnerVoiceMessage", () => {
  it("frames the impulse as the agent's own thought and keeps the NO_REPLY guard", () => {
    const msg = buildInnerVoiceMessage("bir şey sorayım mı");
    expect(msg).toContain("Your own thought");
    expect(msg).toContain('"bir şey sorayım mı"');
    expect(msg).toContain("NO_REPLY");
    expect(msg).toContain("ONE short message");
  });
});

describe("FlowRegistry session source hint (inner-voice attribution)", () => {
  it("round-trips source + parent + trigger and consumes once", () => {
    const r = new FlowRegistry();
    r.setSourceHintBySession("sk-1", "inner_voice", "fl-parent", "first_contact_followup");
    const hint = r.consumeSourceHintBySession("sk-1");
    expect(hint).toEqual({
      source: "inner_voice",
      parentFlowId: "fl-parent",
      trigger: "first_contact_followup",
    });
    // consume-once: gone on the second read
    expect(r.consumeSourceHintBySession("sk-1")).toBeUndefined();
  });

  it("clearSourceHintBySession drops a pending hint (cancel-on-inbound)", () => {
    const r = new FlowRegistry();
    r.setSourceHintBySession("sk-2", "inner_voice", "fl-parent", "first_contact_followup");
    r.clearSourceHintBySession("sk-2");
    expect(r.consumeSourceHintBySession("sk-2")).toBeUndefined();
  });
});
