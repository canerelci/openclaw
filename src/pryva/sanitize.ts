/**
 * Outbound message sanitization (native, flavor-agnostic).
 *
 * Deterministic passes applied to every outbound message: strip control/sentinel
 * tokens, raw backend error leaks, timezone leaks, trailing filler questions, and
 * persona-integrity leaks (never "I'm an AI"). This is the last line of defense
 * after the SOUL prompt and the Cortex/Mouth stages; kept purely mechanical.
 */

// Recognized CONTENT-FREE filler questions — generic customer-service reflexes that add nothing
// regardless of what came before them. Deliberately a closed list, not "any short trailing
// question": a bare length/punctuation heuristic also matched real, on-topic questions the
// assistant asked as part of its answer (owner-observed 2026-07-11 — "Haftalık planı çıkaralım
// mı, yoksa direkt ilk postları mı hazırlayayım?" was silently deleted after a genuine status
// update, so the owner never saw the assistant asking which way to proceed. A real question is
// exactly the proactive behavior we want, never filler).
const FILLER_QUESTION_RE =
  /^başka\s+(?:bir\s+şey|bir\s+konuda|yardımcı\s+olabileceğim\s+bir\s+şey)?\s*(?:istedi|iste|var|ister|olsun|yardım)\w*\s*(?:mi|mı)?\??$|^(?:need|want)\s+anything\s+else\??$|^(?:anything|something)\s+else\??$|^(?:how\s+)?(?:can|may)\s+i\s+(?:help|assist)(?:\s+you)?(?:\s+with\s+anything\s+else)?\??$/i;

/** Strip a short trailing filler question ("Need anything else?") after real content — but ONLY
 *  a recognized content-free reflex, never a real on-topic question the assistant is asking. */
export function stripTrailingFillerQuestion(text: string): string {
  const match = text.match(/^([\s\S]+[.!?\n])\s*([^.!?\n]+\?)\s*$/);
  if (!match) {
    return text;
  }
  const body = match[1].trim();
  const trailing = match[2].trim();
  if (body.length >= 10 && FILLER_QUESTION_RE.test(trailing)) {
    return body;
  }
  return text;
}

/**
 * Strip sentinel tokens (NO_REPLY, HEARTBEAT_OK) at line edges. Returns null when
 * nothing meaningful remains (pure-sentinel output → cancel delivery).
 */
export function stripSentinelTokens(rawContent: string): string | null {
  if (!/NO_REPLY|HEARTBEAT_OK/i.test(rawContent)) {
    return rawContent;
  }
  const stripped = rawContent
    .split("\n")
    .map((rawLine: string) => {
      let line = rawLine;
      let prev: string;
      do {
        prev = line;
        line = line
          .replace(/^[\s.:…-]*(?:NO_REPLY|HEARTBEAT_OK)/i, "")
          .replace(/(?:NO_REPLY|HEARTBEAT_OK)[\s.:…-]*$/i, "");
      } while (line !== prev);
      return line;
    })
    .filter((l: string) => l.trim().length > 0)
    .join("\n")
    .trim();
  if (!stripped || !/[\p{L}\p{N}]/u.test(stripped)) {
    return null;
  }
  return stripped;
}

/** Remove leaked timezone annotations like "(22:31 TR)" / "(21:40 UTC)". */
export function stripTimezoneLeaks(text: string): string {
  let t = text;
  t = t.replace(
    /\s*\(\s*\d{1,2}[:.]\d{2}\s*(?:UTC|GMT[+-]?\d*|TR(?:\s+saat[ıi]\w*)?|yerel\s+saat\w*|local\s+time)\s*\)/gi,
    "",
  );
  t = t.replace(/\s*\([^)]*(?:UTC|GMT|TR saat[ıi]\w*|yerel saat\w*|local time)[^)]*\)/gi, "");
  t = t.replace(
    /(\d{1,2}[:.]\d{2})\s* ?(?:UTC|GMT(?:[+-]\d{1,2})?|TR(?:\s+saat[ıi]\w*)?|yerel\s*saat\w*)/gi,
    "$1",
  );
  t = t.replace(/\s*(?:TR|Türkiye|Istanbul|İstanbul)\s+saat[ıi]\w*/gi, "");
  return t;
}

/** Strip <|token|> control sequences, raw API-error sentences, internal file refs. */
export function stripInternalLeaks(text: string): string {
  let t = text;
  t = t.replace(/<\|[^|]*\|>/g, "");
  t = t.replace(
    /[^.!?\n]*\b(?:threw|returned|got|gave|raised)\b[^.!?\n]*\b[45]\d\d\b[^.!?\n]*[.!?]?/gi,
    "",
  );
  t = t.replace(
    /[^.!?\n]*\b(?:Internal Server Error|Traceback|asyncpg|HTTP\s*[45]\d\d|status\s*[45]\d\d|500\s*error|API\s+(?:error|threw|returned|call failed)|endpoint)\b[^.!?\n]*[.!?]?/gi,
    "",
  );
  t = t.replace(
    /[^.!?\n]*(?:USER\.md|_owner_profile\.md|SOUL\.md|_owner_soul\.md|CONTACT\.md|MEMORY\.md|SKILL\.md|openclaw|pryva_\w+)[^.!?\n]*[.!?]\s*/gi,
    "",
  );
  t = t.replace(/\s*MEDIA:\S+/g, "");
  t = t.replace(/\s*\[END\]\s*/gi, "").replace(/\s*\[DONE\]\s*/gi, "");
  t = t.replace(/^\s*\[[^\]]{1,30}\]\s*/g, "");
  return t;
}

/**
 * Persona-integrity guard — strip any whole sentence where the assistant refers
 * to itself as an AI / language model / bot, or uses generic helper-bot filler.
 * Every Pryva assistant presents as a real person, so this applies to all flavors.
 *
 * KNOWN LIMITATION: keyword/regex backstop, so language-dependent (EN + TR). It
 * is the deterministic last line of defense AFTER the SOUL prompt forbids
 * self-reference and Mouth rewrites — not the primary mechanism.
 */
const ROLE_BREAK_MARKERS = new RegExp(
  [
    "(?:ben\\s+)?(?:bir\\s+)?yapay\\s*zek[aâ]\\s*(?:asistan|model|yapay)?\\w*y[ıi]m",
    "yapay\\s*zek[aâ]\\s*asistan\\w*",
    "(?:bir\\s+)?dil\\s*modeli(?:y[ıi]m)?",
    "sanal\\s+asistan\\w*",
    "dijital\\s+asistan\\w*",
    "\\b(?:eğitildim|programland[ıi]m|geliştirildim|kodland[ıi]m|tasarland[ıi]m|yarat[ıi]ld[ıi]m)\\b",
    "beni\\s+(?:eğiten|programlayan|geliştiren|yapan|yaratan|kodlayan)",
    "geliştiricilerim",
    "size\\s+nas[ıi]l\\s+yard[ıi]mc[ıi]\\s+olabilir\\w*",
    "yard[ıi]mc[ıi]\\s+olmak\\s+için\\s+(?:burada|buraday[ıi]m)",
    "\\bI'?m\\s+(?:an?\\s+)?AI\\b",
    "\\bI\\s+am\\s+an?\\s+AI\\b",
    "\\bas\\s+an\\s+AI\\b",
    "\\bAI\\s+(?:language\\s+model|assistant)\\b",
    "\\b(?:large\\s+)?language\\s+model\\b",
    "\\bchat\\s?bot\\b",
    "\\bvirtual\\s+assistant\\b",
    "\\bdigital\\s+assistant\\b",
    "\\bI\\s+was\\s+(?:trained|programmed|built|created)\\b",
    "\\bmy\\s+developers\\b",
  ].join("|"),
  "i",
);

/**
 * Does this text contain a persona-integrity break — the assistant calling
 * itself an AI / bot / language model / virtual-digital assistant, or using
 * generic helper-bot filler? Shared detector so there is ONE source of truth:
 * the outbound strip (`guardRoleBreak` deletes the offending sentence) and the
 * finalize gate (`pipeline-finalize.ts` forces a full in-character rewrite before
 * the reply is ever accepted) both key off this same regex.
 */
export function hasRoleBreak(content: string): boolean {
  return content.length > 0 && ROLE_BREAK_MARKERS.test(content);
}

export function guardRoleBreak(content: string): string {
  if (!content) {
    return content;
  }
  const text = content.replace(/[^.!?\n]+[.!?]?/g, (sentence) =>
    ROLE_BREAK_MARKERS.test(sentence) ? "" : sentence,
  );
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Base outbound sanitization — applied to every outbound message.
 * Order: sentinels → internal leaks → timezone → filler question → role-break.
 * Returns null when nothing meaningful remains (cancel delivery).
 */
export function baseStripOutbound(content: string): string | null {
  const sentineled = stripSentinelTokens(content);
  if (sentineled === null) {
    return null;
  }
  let t = stripInternalLeaks(sentineled);
  t = stripTimezoneLeaks(t);
  t = stripTrailingFillerQuestion(t);
  t = guardRoleBreak(t);
  return t.trim() || null;
}
