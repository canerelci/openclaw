/**
 * Fast acknowledgement (native, flavor-agnostic).
 *
 * Greets non-trivial work within ~1s so the owner never stares at silence while
 * the (slow) Ear pipeline runs. Fired from message_received, independent of Ear.
 *
 * KNOWN LIMITATION: language selection is a lightweight heuristic (Turkish
 * diacritics + a diacritic-free fallback word list). It only picks WHICH canned
 * pool to draw from; a wrong guess degrades to an English ack, never a broken
 * message. A real language detector would replace the heuristic.
 */

const TRIVIAL_ACK_RE =
  /^\s*(ok(ay)?|tamam(d[ıi]r)?|teşekkür\w*|sa[ğg]\s?ol\w*|eyvallah|thx|thanks?|thank you|merhaba|selam|sa|g[üu]nayd[ıi]n|hi|hello|hey|evet|yok|hay[ıi]r|yes|no|👍|👌|🙏|\.\.\.)\s*[.!]*\s*$/i;

const TR_HINT_RE =
  /[ığşçöüİĞŞÇÖÜ]|\b(bir|bunu|için|nas[ıi]l|gönderi|görsel|hikaye|istiyorum|olsun|şöyle|öneri|haz[ıi]rla|lütfen)\b/i;

// Deliberately varied so a real person shows through, not a bot repeating one
// stock line. TWO registers, picked by what the owner's message actually is:
//  - CHECKING ("bir bakayım / let me look"): the owner ASKED something — we go find the
//    answer, so "looking into it" is literally true.
//  - WORKING ("anladım, çalışayım / got it, I'll work with that"): the owner gave
//    information, an answer, or direction — there is nothing to "look at"; saying
//    "hemen bakıyorum" to a brief reads like a toy robot (owner incident 2026-07-11).
// Each pool means the same thing in many natural registers; the picker never repeats
// back-to-back.
const ACK_CHECK_TR = [
  "Bir bakayım…",
  "Hemen bakıyorum…",
  "Tamam, bakıyorum…",
  "Anladım, bir bakayım…",
  "Bir saniye, kontrol ediyorum…",
  "Şuna bir bakıp döneyim…",
  "Bir dakika, kontrol edeyim…",
  "Kontrol ediyorum, az bekle…",
  "Bakıyorum, biraz zaman ver…",
];
const ACK_CHECK_EN = [
  "Let me look into this…",
  "Checking, back in a moment…",
  "Got it, taking a look…",
  "One moment, let me check…",
  "Sure, looking into it…",
  "Let me take a look…",
  "Hang on, checking…",
  "Give me a moment to check…",
];
const ACK_WORK_TR = [
  "Anladım. Biraz çalışayım…",
  "Anladım, buna göre ilerliyorum…",
  "Tamam, not aldım — çalışmaya başlıyorum…",
  "Anlaşıldı, ben ilgileniyorum…",
  "Tamam, bu netleşti. Devam ediyorum…",
  "Not ettim, üzerinde çalışıyorum…",
  "Anladım. Gerisini bana bırak…",
  "Tamam, buradan ben alıyorum…",
  "Hallediyorum, bir saniye…",
];
const ACK_WORK_EN = [
  "Got it. Let me work on this…",
  "Understood — proceeding with that…",
  "Noted, I'll take it from here…",
  "Makes sense. On it…",
  "Got it, I'll shape things accordingly…",
  "Understood. Give me a bit…",
  "Noted — working with that…",
  "Alright, on it…",
];

// Is the owner ASKING us something (→ CHECKING register)? A question mark anywhere, a
// Turkish interrogative particle/word, or an English wh-/aux-inversion opener. Anything
// else — statements, answers, briefs, directives — takes the WORKING register: for those
// there is nothing to "check", only work to absorb and act on.
const QUESTION_RE =
  /\?|(^|\s)(mi|mı|mu|mü|midir|mıdır|musun|müsün|misin|mısın|nasıl|neden|niye|niçin|hangi|hangisi|ne zaman|nerede|nereden|kaç|kim|var m[ıi])(\s|$|[.,!…])|(^|\s)(what|how|why|when|where|which|who|can you|could you|would you|will you|do you|did you|are you|is it|is there|any idea)\b/i;

// Last ack we emitted (across both pools). Kept process-local so consecutive
// messages don't draw the same line twice in a row — the single most visible
// "this is a bot" tell. Best-effort only; not persisted across restarts.
let lastAck: string | null = null;

function pickAck(pool: readonly string[]): string {
  let choice = pool[Math.floor(Math.random() * pool.length)];
  // One deterministic step-over is enough to break an immediate repeat without
  // biasing the distribution toward any particular neighbour.
  if (choice === lastAck && pool.length > 1) {
    choice = pool[(pool.indexOf(choice) + 1) % pool.length];
  }
  lastAck = choice;
  return choice;
}

/** Short localized ack for a non-trivial message, or null to stay silent. */
export function fastAckText(content: string): string | null {
  const s = (content || "").trim();
  if (s.length < 25) {
    return null;
  }
  if (TRIVIAL_ACK_RE.test(s)) {
    return null;
  }
  const turkish = TR_HINT_RE.test(s);
  const asking = QUESTION_RE.test(s);
  const pool = asking
    ? turkish
      ? ACK_CHECK_TR
      : ACK_CHECK_EN
    : turkish
      ? ACK_WORK_TR
      : ACK_WORK_EN;
  return pickAck(pool);
}

/**
 * Is this text one of our canned fast-acks? `message_sending` uses this to skip
 * the Cortex/Mouth quality gate for an ack (D3) — the ack is a pre-approved
 * instant greeting; QA-ing it would burn an LLM call and add latency to the one
 * message meant to be instant. Membership check (not a regex) so it stays exact
 * and robust to the canned pools changing.
 */
export function isFastAck(content: string): boolean {
  const s = (content || "").trim();
  return (
    s.length > 0 &&
    (ACK_CHECK_TR.includes(s) ||
      ACK_CHECK_EN.includes(s) ||
      ACK_WORK_TR.includes(s) ||
      ACK_WORK_EN.includes(s))
  );
}
