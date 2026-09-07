import { describe, expect, it } from "vitest";
import {
  demoteEmptyPromise,
  hasEmptyPromise,
  hasResourceAdoptClaim,
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
    // Previously dead stems: üret and çiz now match after Unicode boundary fix.
    ["tr üret (was dead)", "Hemen üretiyorum, birkaç dakika içinde geliyor."],
    ["tr çiz (was dead)", "Hemen çiziyorum, birkaç dakika içinde geliyor."],
    // şimdi as immediacy marker was dead; now matches.
    ["tr şimdi (was dead)", "Gönderiyorum şimdi, birazdan geliyor."],
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

describe("hasResourceAdoptClaim", () => {
  it("flags the prod bot-token adopt claim (owner incident 2026-07-11)", () => {
    expect(
      hasResourceAdoptClaim(
        "Tamam, aldım. Bu token ile Monomoment Telegram hesabını sahiplenip yöneteceğim.",
      ),
    ).toBe(true);
  });

  it.each([
    ["tr connect", "Botu hemen bağlıyorum, kanalı yönetmeye başlıyorum."],
    ["tr configure account", "Hesabı ayarladım, artık ben yönetiyorum."],
    ["en manage account", "Great, I'll manage the account with this token now."],
    ["en connected", "I've connected the bot to your channel."],
    // şifre was dead due to \b; now matches with Unicode boundary.
    ["tr şifre (was dead)", "Şifreyi ayarladım, artık çalışıyor."],
  ])("flags %s", (_label, text) => {
    expect(hasResourceAdoptClaim(text)).toBe(true);
  });

  it.each([
    ["adopt verb, no resource object", "Bu fikri sahiplendim, çok güzel."],
    ["resource object, no adopt verb", "Token'ı aldım, teşekkürler."],
    ["plain growth talk", "Hesabını birlikte büyütelim, harika içerikler üretelim."],
    ["en no resource", "I'll manage the schedule for next week."],
    ["empty", ""],
  ])("does not flag %s", (_label, text) => {
    expect(hasResourceAdoptClaim(text)).toBe(false);
  });

  it.each([
    ["tr dün", "Onu dün ayarladım, token çalışıyor."],
    ["tr geçen hafta", "Evet, geçen hafta hesabı bağladım."],
    ["tr daha önce", "Bunu daha önce halletmiştim."],
    ["en yesterday", "I connected the account yesterday."],
    ["en last week", "I set up the token last week."],
    ["en already", "I already configured the channel."],
  ])("does not flag prior-turn reference: %s", (_label, text) => {
    expect(hasResourceAdoptClaim(text)).toBe(false);
  });

  it.each([
    ["tr -mış evidential", "Hesap ayarlanmış, token çalışıyor."],
    ["tr -miştim", "Bunu daha önce halletmiştim."],
    ["tr -muş", "Kanal kurulmuş görünüyor."],
  ])("does not flag evidential mood: %s", (_label, text) => {
    expect(hasResourceAdoptClaim(text)).toBe(false);
  });
});

describe("isStallingTurn", () => {
  it("flags a tool-less resource-adopt claim (bot-token sycophancy)", () => {
    const claim = "Bu token ile Telegram hesabını sahiplenip yöneteceğim.";
    expect(isStallingTurn("run-adopt-notool", claim)).toBe(true);
    noteToolCall("run-adopt-tool", "connect_channel");
    expect(isStallingTurn("run-adopt-tool", claim)).toBe(false);
  });

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
  it("strips the promise and adds uncertainty marker, keeping real content", () => {
    const out = demoteEmptyPromise(PROD_EMPTY_PROMISE, "tr");
    expect(out).not.toMatch(/hazırlıyorum|birkaç dakika/i);
    expect(out).toContain("emin değilim");
  });

  it("falls back to the uncertainty marker alone when the reply was nothing but promise", () => {
    expect(demoteEmptyPromise("Hemen hazırlıyorum.", "tr")).toBe(
      "Bu konuda bir güncelleme vermeye çalıştım ama emin değilim — lütfen kontrol eder misiniz?",
    );
  });

  it("honours the Ear plan response language", () => {
    expect(demoteEmptyPromise("Hemen hazırlıyorum.", "en")).toBe(
      "I tried to give you an update on this but I'm not sure of the status — could you check?",
    );
  });

  it("infers Turkish from the matched promise when no language is supplied", () => {
    expect(demoteEmptyPromise("Hemen hazırlıyorum.")).toContain("emin değilim");
  });

  it("keeps the acknowledgement sentence that carries no promise", () => {
    const out = demoteEmptyPromise("Logo oturmamış, haklısın. Hemen yenisini hazırlıyorum.", "tr");
    expect(out).toContain("Logo oturmamış, haklısın.");
    expect(out).not.toMatch(/hazırlıyorum/i);
  });
});
