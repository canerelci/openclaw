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
// stock line. Each pool means the same thing ("got it — checking, give me a
// moment") in many natural registers; the picker never repeats back-to-back.
const ACK_TR = [
  "Bir bakayım…",
  "Hemen bakıyorum…",
  "Tamam, bakıyorum…",
  "Anladım, bir bakayım…",
  "Bir saniye, kontrol ediyorum…",
  "Şuna bir bakıp döneyim…",
  "Hemen ilgileniyorum…",
  "Bir dakika, kontrol edeyim…",
  "Tamam, birazdan dönerim…",
  "Hallediyorum, bir saniye…",
  "Kontrol ediyorum, az bekle…",
  "Bakıyorum, biraz zaman ver…",
];
const ACK_EN = [
  "Let me look into this…",
  "On it — one sec…",
  "Checking, back in a moment…",
  "Give me a sec…",
  "Got it, taking a look…",
  "One moment, let me check…",
  "Sure, looking into it…",
  "On it — back shortly…",
  "Let me take a look…",
  "Hang on, checking…",
  "Alright, on it…",
  "Give me a moment to check…",
];

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
  const pool = TR_HINT_RE.test(s) ? ACK_TR : ACK_EN;
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
  return s.length > 0 && (ACK_TR.includes(s) || ACK_EN.includes(s));
}
