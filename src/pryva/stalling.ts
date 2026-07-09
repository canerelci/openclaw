/**
 * Zero-tool stalling ("empty promise") detection.
 *
 * The failure this exists to stop: the agent replies "Hemen yenisini hazırlıyorum,
 * birkaç dakika içinde geliyor" and then does NOTHING — no tool call, no delegation,
 * no job, no follow-up flow. The owner waits for content that was never started.
 * The SOUL prompt already forbids it and the model ignored it, so this is the
 * deterministic backstop.
 *
 * A turn is stalling when BOTH hold:
 *  1. the reply promises a deliverable soon (a produce/send verb in progressive or
 *     future tense, TOGETHER WITH an immediacy marker), and
 *  2. the run that produced it called no WORK tool.
 *
 * Neither signal is sufficient alone: a promise backed by a real tool call is honest
 * work-in-progress, and a tool-less turn that promises nothing is ordinary chat. The
 * conjunction is what makes the detector safe to act on.
 *
 * Enforcement is two-stage, mirroring the role-break guard (`sanitize.ts` +
 * `pipeline-finalize.ts`), which shares this same detector-plus-backstop shape:
 *  - `pipeline-finalize.ts` forces ONE model pass ("do it, or say you couldn't").
 *  - `pipeline-outbound.ts` demotes the promise to an honest line if the model
 *    stalls again — the harness caps the finalize retry budget and then delivers the
 *    draft regardless (lifecycle-hook-helpers.ts: `nextCount > maxAttempts` →
 *    `continue`), so the finalize gate alone cannot guarantee the promise never ships.
 */

/** Tools that deliver text rather than do the promised work — sending the promise is not doing it. */
const MESSAGING_TOOLS = new Set(["message"]);

/**
 * runId → last work-tool-call timestamp. Pruned by age rather than cleared wholesale:
 * `after_tool_call` fires during the run but `message_sending` fires AFTER `agent_end`
 * (the reply is delivered once `getReply` returns), so the tally must outlive the run.
 * An evicted entry reads as "no work", which can only ever matter for a reply that also
 * promises a deliverable — and by then the run is far older than any live turn.
 */
const workToolRuns = new Map<string, number>();
const WORK_TOOL_TTL_MS = 10 * 60 * 1000;

function pruneWorkToolRuns(now: number): void {
  if (workToolRuns.size < 256) {
    return;
  }
  for (const [runId, at] of workToolRuns) {
    if (now - at > WORK_TOOL_TTL_MS) {
      workToolRuns.delete(runId);
    }
  }
}

/** Record that `runId` called a tool that does real work (anything but pure messaging). */
export function noteToolCall(runId: string | undefined, toolName: string): void {
  if (!runId || MESSAGING_TOOLS.has(toolName)) {
    return;
  }
  const now = Date.now();
  pruneWorkToolRuns(now);
  workToolRuns.set(runId, now);
}

/** Did this run actually do something beyond talking? Unknown/evicted run → false. */
export function runUsedWorkTools(runId: string | undefined): boolean {
  return Boolean(runId && workToolRuns.has(runId));
}

// A produce/send/fix verb in Turkish progressive (-ıyorum/-iyoruz) or future (-acağım/-eceğiz).
// Past tense is deliberately excluded: "hemen düzelttim" reports work, it does not promise it.
const TR_PROMISE_VERB =
  /\b(?:hazırl|oluştur|üret|çiz|tasarl|gönder|yolla|ilet|at|güncell|düzelt|revize\s*ed|yenile|halled|bak|başl|yap|paylaş)\w*(?:ıyorum|iyorum|uyorum|üyorum|ıyoruz|iyoruz|uyoruz|üyoruz|acağım|eceğim|acağız|eceğiz)\b/i;

// "in a few minutes", "right now", "it's coming" — the deliverable is imminent.
const TR_IMMEDIACY =
  /\b(?:hemen|birazdan|az\s+sonra|şimdi|yakında|geliyor|gelecek|birkaç\s+(?:dakika|dk|saniye)|dakika\s+içinde|dakikaya|kısa\s+süre\s+içinde|birazcık\s+sonra)\b/i;

const EN_PROMISE_VERB =
  /\b(?:i'?ll|i\s+am|i'?m)\s+(?:going\s+to\s+|about\s+to\s+)?(?:prepar\w*|mak\w*|creat\w*|generat\w*|design\w*|draw\w*|send\w*|fix\w*|redo\w*|rework\w*|updat\w*|put\w*|get\w*|work\w*)\b|\bgetting\s+(?:it|this|that|one)\s+ready\b|\bon\s+it\b/i;

const EN_IMMEDIACY =
  /\b(?:right\s+away|right\s+now|in\s+a\s+(?:few|couple|minute|moment|sec)\w*|shortly|momentarily|soon|coming\s+(?:right\s+)?up|any\s+minute|just\s+a\s+(?:sec|moment|minute))\b/i;

/**
 * Does this reply promise a deliverable imminently? Requires a promise verb AND an
 * immediacy marker in the SAME message, in one language family, so ordinary sentences
 * ("yarın konuşuruz", "I'll think about it") do not trip the gate.
 */
export function hasEmptyPromise(content: string): boolean {
  if (!content) {
    return false;
  }
  const tr = TR_PROMISE_VERB.test(content) && TR_IMMEDIACY.test(content);
  const en = EN_PROMISE_VERB.test(content) && EN_IMMEDIACY.test(content);
  return tr || en;
}

/**
 * Is this run stalling — promising a deliverable it never started?
 *
 * Requires a KNOWN runId. Without one we cannot prove the turn did nothing, and a send that
 * owns no agent run (a proactive backend notification: "your image lands in a few minutes")
 * is usually backed by real work happening elsewhere. Absent proof, never accuse.
 */
export function isStallingTurn(runId: string | undefined, content: string): boolean {
  return Boolean(runId) && hasEmptyPromise(content) && !runUsedWorkTools(runId);
}

export const STALL_REVISE_INSTRUCTION =
  "Your last reply promised the owner a deliverable ('I'm preparing it', 'it'll be there in a " +
  "few minutes'), but this turn called no tool: nothing was created, delegated, scheduled, or " +
  "started. Never promise work you have not started. Either DO the work now by calling the " +
  "appropriate tool (generate/delegate/schedule), or reply honestly that you could not do it " +
  "right now and say what you need — no promise, no time estimate.";

const HONEST_TR = "Kusura bakma, bunu şu an yapamadım.";
const HONEST_EN = "Sorry — I wasn't able to do that just now.";

// Sentence-level: either half of the promise is enough to drop the sentence, because
// "Hemen yenisini hazırlıyorum." and "Birkaç dakika içinde geliyor." each carry only one half.
const SENTENCES = /[^.!?\n]+[.!?]?/g;

function isPromiseSentence(sentence: string): boolean {
  return (
    TR_PROMISE_VERB.test(sentence) ||
    TR_IMMEDIACY.test(sentence) ||
    EN_PROMISE_VERB.test(sentence) ||
    EN_IMMEDIACY.test(sentence)
  );
}

/**
 * Last-resort rewrite: strip the promise sentences and state plainly that the work was not
 * done. Any real content the reply carried (an acknowledgement of the complaint, a question)
 * survives — only the lie is removed. Language follows `responseLanguage` when the Ear plan
 * supplied one, else the promise family that matched.
 */
export function demoteEmptyPromise(content: string, responseLanguage?: string): string {
  const kept = content
    .replace(SENTENCES, (sentence) => (isPromiseSentence(sentence) ? "" : sentence))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lang = responseLanguage?.trim().toLowerCase();
  const turkish = lang
    ? lang.startsWith("tr") || lang.startsWith("tür") || lang.startsWith("tur")
    : TR_PROMISE_VERB.test(content) || TR_IMMEDIACY.test(content);
  const honest = turkish ? HONEST_TR : HONEST_EN;
  return kept && /[\p{L}\p{N}]/u.test(kept) ? `${kept}\n\n${honest}` : honest;
}
