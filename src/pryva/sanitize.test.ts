import { describe, expect, it } from "vitest";
import { stripTrailingFillerQuestion } from "./sanitize.js";

describe("stripTrailingFillerQuestion", () => {
  it("strips a recognized content-free filler question (TR)", () => {
    expect(stripTrailingFillerQuestion("Planı gönderdim. Başka bir şey istedin mi?")).toBe(
      "Planı gönderdim.",
    );
  });

  it("strips a recognized content-free filler question (EN)", () => {
    expect(stripTrailingFillerQuestion("Done, it's live now. Anything else?")).toBe(
      "Done, it's live now.",
    );
    expect(
      stripTrailingFillerQuestion("Fixed the logo. How can I help you with anything else?"),
    ).toBe("Fixed the logo.");
  });

  it(
    "keeps a REAL on-topic question the assistant is asking — regression for the owner-observed" +
      " 2026-07-11 bug where a genuine proactive question got silently deleted as if it were" +
      " filler, so the owner never saw the assistant asking which way to proceed",
    () => {
      const msg =
        "Marka bilgilerini ve yeni hesabın için içerik stratejisini gözden geçiriyorum. " +
        "Haftalık planı çıkaralım mı, yoksa direkt ilk postları mı hazırlayayım?";
      expect(stripTrailingFillerQuestion(msg)).toBe(msg);
    },
  );

  it("keeps other real on-topic questions (TR and EN)", () => {
    const tr = "Logoyu yeniledim. Hangi rengi tercih edersin, maviyi mi yoksa yeşili mi?";
    expect(stripTrailingFillerQuestion(tr)).toBe(tr);

    const en = "I drafted the caption. Should I schedule it for tomorrow morning or tonight?";
    expect(stripTrailingFillerQuestion(en)).toBe(en);
  });

  it("leaves text with no trailing question untouched", () => {
    const msg = "Planı hazırladım, onayına sunuyorum.";
    expect(stripTrailingFillerQuestion(msg)).toBe(msg);
  });

  it("leaves a body that's too short even with a filler trailing question", () => {
    const msg = "Tamam. Başka bir şey var mı?";
    expect(stripTrailingFillerQuestion(msg)).toBe(msg);
  });
});
