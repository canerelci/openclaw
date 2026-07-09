/**
 * Customer-facing copy for a sanitized assistant error reply (billing,
 * rate-limit, provider outage, etc.). Core's `formatUserFacingAssistantErrorText`
 * already strips raw exception text, but its copy is written for a developer/
 * operator running their own OpenClaw instance ("check your API key", "top up
 * your billing dashboard") — wrong register for an end customer talking to a
 * business's assistant. Replace it with brand-neutral copy instead of
 * forwarding operator language to the customer.
 */

const NEUTRAL_ERROR_TR =
  "Şu anda küçük bir teknik aksaklık yaşıyorum, en kısa sürede size dönüş yapacağım.";
const NEUTRAL_ERROR_EN = "I'm having a temporary issue right now — I'll get back to you shortly.";

const TR_HINT_RE = /[ığşçöüİĞŞÇÖÜ]/;

/**
 * Replace a sanitized-but-operator-facing assistant error message with
 * brand-neutral customer copy. Language follows the Ear plan's
 * `response_language` when available, else a lightweight heuristic over the
 * original error text (same approach as `ack.ts`'s fast-ack language pick).
 */
export function neutralizeErrorReply(originalText: string, responseLanguage?: string): string {
  const lang = responseLanguage?.trim().toLowerCase();
  const turkish = lang
    ? lang.startsWith("tr") || lang.startsWith("tür") || lang.startsWith("tur")
    : TR_HINT_RE.test(originalText);
  return turkish ? NEUTRAL_ERROR_TR : NEUTRAL_ERROR_EN;
}
