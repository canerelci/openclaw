import { describe, expect, it } from "vitest";
import {
  demoteEmptyPromise,
  hasEmptyPromise,
  isStallingTurn,
  noteToolCall,
  runUsedWorkTools,
} from "./stalling.js";

// The prod reply that shipped an empty promise to the owner (flow fl-f17810d393c4).
const PROD_EMPTY_PROMISE =
  "Hemen yenisini hazırlıyorum, logo oturmamış olabilir. Birkaç dakika içinde geliyor.";

describe("hasEmptyPromise", () => {
  it("detects the promise that shipped to prod", () => {
    expect(hasEmptyPromise(PROD_EMPTY_PROMISE)).toBe(true);
  });

  it.each([
    ["tr progressive + immediacy", "Hemen düzeltiyorum, birazdan gönderiyorum."],
    ["tr future + immediacy", "Yeni görseli hazırlayacağım, birkaç dakikaya sende olur."],
    ["en progressive + immediacy", "I'm preparing a new one, it'll be there in a few minutes."],
    ["en future + immediacy", "I'll fix the logo right away."],
  ])("flags %s", (_label, text) => {
    expect(hasEmptyPromise(text)).toBe(true);
  });

  it.each([
    ["plain chat", "Logo gerçekten oturmamış, haklısın."],
    ["past tense report", "Hemen düzelttim, yeni görsel yukarıda."],
    ["future with no immediacy", "Yarın bu konuyu konuşuruz."],
    ["immediacy with no deliverable", "Hemen anladım seni."],
    ["en deliberation", "I'll think about it."],
    ["empty", ""],
  ])("does not flag %s", (_label, text) => {
    expect(hasEmptyPromise(text)).toBe(false);
  });
});

describe("isStallingTurn", () => {
  it("clears a promise backed by a real work tool call", () => {
    noteToolCall("run-work", "image_gen");
    expect(runUsedWorkTools("run-work")).toBe(true);
    expect(isStallingTurn("run-work", PROD_EMPTY_PROMISE)).toBe(false);
  });

  it("counts an errored tool call as work — the agent did act", () => {
    noteToolCall("run-errored", "image_gen");
    expect(isStallingTurn("run-errored", PROD_EMPTY_PROMISE)).toBe(false);
  });

  it("does not count the messaging tool as work — sending the promise is not doing it", () => {
    noteToolCall("run-msg-only", "message");
    expect(runUsedWorkTools("run-msg-only")).toBe(false);
    expect(isStallingTurn("run-msg-only", PROD_EMPTY_PROMISE)).toBe(true);
  });

  it("flags a tool-less promise", () => {
    expect(isStallingTurn("run-idle", PROD_EMPTY_PROMISE)).toBe(true);
  });

  it("leaves an honest tool-less reply alone", () => {
    expect(isStallingTurn("run-idle-2", "Haklısın, logo oturmamış.")).toBe(false);
  });

  it("never flags a run with no id when the text is innocent", () => {
    expect(isStallingTurn(undefined, "Merhaba.")).toBe(false);
  });

  it("never accuses a send that owns no run — a proactive notification promises real work", () => {
    // No runId means no proof the turn did nothing (backend job notifications land here).
    expect(hasEmptyPromise(PROD_EMPTY_PROMISE)).toBe(true);
    expect(isStallingTurn(undefined, PROD_EMPTY_PROMISE)).toBe(false);
    expect(isStallingTurn("", PROD_EMPTY_PROMISE)).toBe(false);
  });
});

describe("demoteEmptyPromise", () => {
  it("strips the promise and states the truth, keeping real content", () => {
    const out = demoteEmptyPromise(PROD_EMPTY_PROMISE, "tr");
    expect(out).not.toMatch(/hazırlıyorum|birkaç dakika/i);
    expect(out).toContain("Kusura bakma, bunu şu an yapamadım.");
  });

  it("falls back to the honest line alone when the reply was nothing but promise", () => {
    expect(demoteEmptyPromise("Hemen hazırlıyorum.", "tr")).toBe(
      "Kusura bakma, bunu şu an yapamadım.",
    );
  });

  it("honours the Ear plan response language", () => {
    expect(demoteEmptyPromise("Hemen hazırlıyorum.", "en")).toBe(
      "Sorry — I wasn't able to do that just now.",
    );
  });

  it("infers Turkish from the matched promise when no language is supplied", () => {
    expect(demoteEmptyPromise("Hemen hazırlıyorum.")).toContain("Kusura bakma");
  });

  it("keeps the acknowledgement sentence that carries no promise", () => {
    const out = demoteEmptyPromise("Logo oturmamış, haklısın. Hemen yenisini hazırlıyorum.", "tr");
    expect(out).toContain("Logo oturmamış, haklısın.");
    expect(out).not.toMatch(/hazırlıyorum/i);
  });
});
