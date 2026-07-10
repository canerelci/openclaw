import { describe, expect, it } from "vitest";
import { fastAckText, isFastAck } from "./ack.js";

const TR_CHECK_HINTS = ["bak", "kontrol"];
const TR_WORK_HINTS = ["Anla", "Not ", "Tamam", "Hallediyorum"];

describe("fastAckText registers", () => {
  it("stays silent on trivial messages", () => {
    expect(fastAckText("tamam")).toBeNull();
    expect(fastAckText("ok")).toBeNull();
    expect(fastAckText("merhaba")).toBeNull();
  });

  it("uses the CHECKING register when the owner asks a question (TR)", () => {
    const ack = fastAckText("Monomoment için hazırladığın plan nasıl gidiyor, bitti mi?");
    expect(ack).not.toBeNull();
    expect(TR_CHECK_HINTS.some((h) => (ack as string).toLowerCase().includes(h))).toBe(true);
  });

  it("uses the WORKING register for a brief/directive/answer (TR) — the owner incident", () => {
    // Owner 2026-07-11: this got "Hemen bakıyorum…" — there is nothing to look at.
    const ack = fastAckText(
      "Bunların hiçbiri yok. Her şey sana ait olacak bu hesapta. İstediğin gibi şekillendir. " +
        "Amacın maksimum takipçiye sahip olmak, insanları yakalayan içerikler üretmen gerekiyor",
    );
    expect(ack).not.toBeNull();
    expect(TR_WORK_HINTS.some((h) => ((ack as string) ? (ack as string).includes(h) : false))).toBe(
      true,
    );
    expect((ack as string).toLowerCase()).not.toContain("bakıyorum");
    expect((ack as string).toLowerCase()).not.toContain("bakayım");
    expect((ack as string).toLowerCase()).not.toContain("kontrol");
  });

  it("uses the CHECKING register for an English question", () => {
    const ack = fastAckText("Can you check what happened to the weekly plan we discussed?");
    expect(ack).not.toBeNull();
    expect(/look|check/i.test(ack as string)).toBe(true);
  });

  it("uses the WORKING register for an English brief", () => {
    const ack = fastAckText(
      "The account is fully yours going forward. Aim for maximum follower growth with catchy content.",
    );
    expect(ack).not.toBeNull();
    expect(/look into|checking|let me check/i.test(ack as string)).toBe(false);
  });

  it("every produced ack is recognized by isFastAck", () => {
    for (const msg of [
      "Monomoment planı ne durumda, paylaşır mısın?",
      "Bunların hiçbiri yok. Her şey sana ait olacak bu hesapta, istediğin gibi şekillendir.",
      "Can you check what happened to the weekly plan?",
      "The account is fully yours going forward. Aim for maximum follower growth please.",
    ]) {
      const ack = fastAckText(msg);
      expect(ack).not.toBeNull();
      expect(isFastAck(ack as string)).toBe(true);
    }
  });
});
