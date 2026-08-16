/**
 * Technician AI-report copy — the bridge between the completion form's
 * "Generate AI report" output and the customer-facing report summary.
 *
 * The generate-report endpoint (admin-schedule.js) drafts customer-facing
 * prose in a fixed two-section shape that the technician reviews (and may
 * edit) in the notes box before completing:
 *
 *   WHAT WE DID
 *
 *   [2-3 sentences]
 *
 *   WHAT WE FOUND
 *
 *   [2-3 sentences]
 *
 * That shape is the intent signal: notes carrying BOTH section headers, each
 * followed by exactly ONE line of prose, are the drafted customer report,
 * not free-form internal notes, so the copy can take the report's summary
 * text slot (typed Today's Result body, recurring Visit Summary / Pest V2
 * hero). Anything else parses to null and every consumer keeps its
 * deterministic template — AI is never in the critical path.
 *
 * Free text around the report is NOT reviewed customer copy: a prefix above
 * WHAT WE DID, or ANY extra line inside/after a section, rejects the whole
 * parse (Codex P1/P2 #2709). The endpoint emits each section as a single
 * line, and a textarea only inserts a real newline when the tech presses
 * Enter — so an appended access-code / billing / office note (with or
 * without a blank line) is always a second line and always rejects, while
 * in-place sentence edits still pass.
 *
 * Banned-copy policy: the generate endpoint rejects unsafe output at
 * generation, but the tech can edit the text afterward, so the parse
 * re-screens with every guard the summary slot already enforces elsewhere:
 * the shared BANNED_CUSTOMER_COPY list, premium-experience's
 * validateCustomerCopy, and the visit-summary narrative's EXTRA_FORBIDDEN
 * vocabulary (bare/plural "infestation(s)", "safe", "solved", … — Codex P1
 * #2709). Violations return `body: null` with the matched terms so callers
 * can log and fall back — a completion is never blocked on this copy.
 */

const crypto = require('crypto');
const { findBannedCustomerCopy } = require('./activity-indicators');

// Code-noun anchored credential detector (shared with the generate-report
// output gate): a token counts as a credential only beside an actual
// code/PIN noun — location keywords alone ("120 linear feet around the
// garage") never trip it. Post-generation inline edits go through THIS
// parser at completion, so the screen lives here (codex r36 #3420). The
// shapes mirror the canonical scrubber: digit codes either side of the
// noun, quoted or digit-bearing tokens, bare UPPERCASE tokens
// (case-sensitive by design — /i would match ordinary words), and
// lowercase word codes behind an explicit is/:/= linker (codex r37).
const REPORT_ACCESS_CODE_RES = [
  /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b[^\n.!?]{0,25}\b[a-z]?\d{2,8}\b/i,
  /\b[a-z]?\d{2,8}\b[^\n.!?]{0,15}\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b/i,
  // quote classes accept Unicode smart quotes — mobile keyboards curl them
  // (codex r40)
  // quoted credentials may span up to four tokens ("blue waves",
  // 'open sesame') — the shared scrubber's multi-token posture (codex r48)
  /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b\s*(?:is|:|=|-|was|were|remains?|remained|stays?|stayed|became|becomes|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?become|(?:(?:was|were|is|are|has|have|had)\s+(?:been\s+)?(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?)?(?:changed|switched|updated|reset|set)\s+to)?\s*(?:(?:now|currently|still|today|temporarily|again)\s+)?(?:["'‘’“”][A-Za-z0-9#*]{2,12}(?:\s+[A-Za-z0-9#*]{1,12}){0,3}["'‘’“”]|[A-Za-z]*\d[A-Za-z0-9#*]*\b)/i,
  // was/were are credential linkers for a bounded UPPERCASE/quoted token —
  // "The gate code was BLUE" (codex r51); bare lowercase after was/were
  // stays out ("the code was updated" is ordinary copy)
  // continuing-state verbs (remains/stays/became) link a bounded
  // UPPERCASE/quoted credential the same way is/was do (codex r52)
  // bounded temporal adverbs may sit between linker and credential —
  // "The gate code is now BLUE" (codex r53)
  /\b(?:[Cc]ode|PIN|[Pp]in|[Cc]ombo|[Cc]ombination|[Pp]asscode|[Pp]assword|[Pp]assphrase|[Kk]eypad|[Ll]ock\s?box)\b\s*(?:is|:|=|-|was|were|remains?|remained|stays?|stayed|became|becomes|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?become|(?:(?:was|were|is|are|has|have|had)\s+(?:been\s+)?(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?)?(?:changed|switched|updated|reset|set)\s+to)?\s*(?:(?:now|currently|still|today|temporarily|again)\s+)?["'‘’“”]?[A-Z0-9#*]{2,12}\b/,
  /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b\s*(?:is|:|=)\s*["'‘’“”]?[a-z][a-z0-9#*]{1,11}["'‘’“”]?(?=[\s.,!?‘’“”]|$)/i,
  // reverse order ("blue is the gate password") — a leading stopword
  // ("this is the code") never counts as the credential itself (codex r38)
  // device nouns join the reverse shape ("WAVES is the lockbox") and
  // UPPERCASE/quoted tokens get the same short positional window the digit
  // shapes already have before keypad/lockbox ("Use BLUE at the keypad") —
  // the uncovered reverse-alphabetic × device-noun intersection (codex r46)
  /\b(?!(?:this|that|it|here|there|what|which|below|above)\b)["'‘’“”]?[a-z0-9#*]{2,12}["'‘’“”]?\s+(?:is|=|was|were|remains?|remained|stays?|stayed|became|becomes|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?become)\s+(?:(?:now|currently|still|today|temporarily|again)\s+)?(?:the\s+)?(?:[a-z]+\s+){0,2}(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b/i,
  // ... and the positional window covers the ordinary code nouns too
  // ("Use BLUE for the gate code" / "for the password") — device nouns
  // alone left that intersection open (codex r47)
  /(?:["'‘’“”][A-Za-z0-9#*]{2,12}(?:\s+[A-Za-z0-9#*]{1,12}){0,3}["'‘’“”]|\b[A-Z0-9#*]{2,12})\s+(?:at|for|to|on|in|into|near|by|opens?|unlocks?)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:[Cc]ode|PIN|[Pp]in|[Cc]ombo|[Cc]ombination|[Pp]asscode|[Pp]assword|[Pp]assphrase|[Kk]eypad|[Ll]ock\s?box)\b/,
  // spoken number-word codes ("gate code four five four five") — two or
  // more number words after a code noun, mirroring the canonical scrubber's
  // multi-token shape (codex r41)
  /\b(?:code|pin|combo|combination|passcode|password|passphrase)\b\s*(?:is|:|=|-)?\s*(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*){2,6}\b/i,
  // unlinked positional word codes (codex r42): "gate code blue waves" —
  // a physical-access context word anchors the ambiguous nouns, while the
  // credential-specific nouns (passphrase/passcode/password) need no
  // anchor; a leading verb/stopword ("gate code was updated") never counts.
  /\b(?:gate|garage|door|lock\s?box|keypad|alarm|entry|access)\s+(?:code|combo|combination|pin)\b\s*:?\s*(?!(?:is|was|were|for|the|we|to|that|this|will|should|of|and|or|in|on|at|has|have|had|used|works?|worked|changed|updated|remains?|stays?|near|by)\b)[a-z][a-z0-9#*]{1,11}\b/i,
  /\b(?:passphrase|passcode|password|keypad|lock\s?box)\b\s*:?\s*(?!(?:is|was|were|for|the|we|to|that|this|will|should|of|and|or|in|on|at|has|have|had|used|works?|worked|changed|updated|remains?|stays?|near|by)\b)[a-z][a-z0-9#*]{1,11}\b/i,
];
function containsReportAccessCode(text) {
  const value = String(text || '');
  return REPORT_ACCESS_CODE_RES.some((re) => re.test(value));
}
const { validateCustomerCopy } = require('./premium-experience');
const { EXTRA_FORBIDDEN } = require('./visit-summary-narrative');

// Longest legitimate generate-report output is ~140 words (≈1,000 chars);
// anything far beyond that is not the drafted report (a paste, a runaway
// edit) and must not become an unbounded customer summary.
const MAX_REPORT_CHARS = 1600;

const WHAT_WE_DID_HEADER = /^\s*WHAT WE DID:?\s*$/;
const WHAT_WE_FOUND_HEADER = /^\s*WHAT WE FOUND:?\s*$/;

function contentLines(lines) {
  return lines
    .map((line) => String(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Parse the two-section AI report shape out of completion notes.
 * Returns null when the notes are not the drafted report (missing header,
 * out-of-order headers, leading free text, any section ≠ exactly one line,
 * over-length). On a shape match returns
 * { whatWeDid, whatWeFound, body, violations }: `body` is the
 * customer-ready single paragraph, nulled when a banned-copy screen matched
 * (violations then lists the offending terms).
 */
function technicianReportCustomerCopy(notes) {
  const text = String(notes || '');
  if (!text.trim() || text.length > MAX_REPORT_CHARS) return null;

  const lines = text.split(/\r?\n/);
  const didIndex = lines.findIndex((line) => WHAT_WE_DID_HEADER.test(line));
  const foundIndex = lines.findIndex((line) => WHAT_WE_FOUND_HEADER.test(line));
  if (didIndex === -1 || foundIndex === -1 || foundIndex <= didIndex) return null;

  // Any free text ABOVE the report is not reviewed customer copy (the draft
  // replaces the notes wholesale, so a clean draft has nothing there) — a
  // prefixed internal note must not drag the whole blob onto the report.
  if (contentLines(lines.slice(0, didIndex)).length) return null;

  // The generated shape is exactly ONE prose line per section. Any second
  // line — blank-separated paragraph or an internal note typed directly on
  // the next line — is unreviewed free text and rejects the whole parse
  // rather than being joined into the customer copy.
  const didLines = contentLines(lines.slice(didIndex + 1, foundIndex));
  const foundLines = contentLines(lines.slice(foundIndex + 1));
  if (didLines.length !== 1 || foundLines.length !== 1) return null;
  const [whatWeDid] = didLines;
  const [whatWeFound] = foundLines;

  const body = `${whatWeDid} ${whatWeFound}`.trim();
  // Union of every screen the summary slot enforces elsewhere: the shared
  // snapshot ban list, premium-experience's forbidden patterns, and the
  // narrative's extra vocabulary (plural "infestations", "safe", "solved").
  const violations = [
    ...findBannedCustomerCopy(body),
    ...EXTRA_FORBIDDEN.map((rx) => body.match(rx)?.[0] || null).filter(Boolean),
    ...(containsReportAccessCode(body) ? ['access_code'] : []),
  ];
  if (!violations.length && !validateCustomerCopy(body)) violations.push('forbidden_language');
  return {
    whatWeDid,
    whatWeFound,
    body: violations.length ? null : body,
    violations,
  };
}

/**
 * PDF cache-key component. Stored report PDFs are keyed on the Pest
 * Pressure visibility signature only, so a summary now driven by the
 * technician report needs its own key component — otherwise a recurring
 * report that already has a cached PDF keeps serving the old generic
 * summary after this feature lands (Codex P2 #2709).
 *
 * Returns '' when the summary is recap/template-driven (keys unchanged, so
 * every existing cached PDF stays a valid hit) and a content-hashed suffix
 * when the technician report drives the rendered summary. Mirrors
 * report-data's summary-source decision: non-typed reports use the parsed
 * copy directly; typed reports only when the frozen snapshot's Today's
 * Result body came from the technician report.
 */
function summaryCopySignature(service = {}) {
  let snapshot = null;
  let companionSnapshots = [];
  try {
    const data = typeof service.service_data === 'string'
      ? JSON.parse(service.service_data)
      : service.service_data;
    snapshot = data && typeof data === 'object' && !Array.isArray(data)
      && data.typedReportSnapshot && typeof data.typedReportSnapshot === 'object'
      && data.typedReportSnapshot.type
      ? data.typedReportSnapshot
      : null;
    // Companion-only completions govern through their customer-visible
    // companion snapshots (PDFs are customer-facing → auto_send only).
    companionSnapshots = !snapshot && data && Array.isArray(data.companionReportSnapshots)
      ? data.companionReportSnapshots.filter((snap) => snap
        && typeof snap === 'object' && snap.delivery === 'auto_send')
      : [];
  } catch {
    snapshot = null;
    companionSnapshots = [];
  }
  const parsed = technicianReportCustomerCopy(service.technician_notes);
  // Mirrors report-data's promotion gate exactly (codex r35 #3420): the
  // governing typed story must have ACCEPTED the body — bodySource stamped
  // or a frozen reconcileConfirmed (the person's override) — else the PDF
  // signature would diverge from the live summary and serve a stale cache.
  const governing = [snapshot, ...(snapshot ? [] : companionSnapshots)]
    .filter((snap) => snap?.todaysResult);
  const typedStoryAcceptedBody = !governing.length
    || governing.some((snap) => snap.todaysResult?.bodySource === 'technician_report'
      // mirror report-data: a reconcile confirmation never accepts the body
      // on a zero-state snapshot (codex r42)
      || (snap.todaysResult?.reconcileConfirmed === true
        && snap.activity?.score !== 0));
  const drivesSummary = !!parsed?.body && typedStoryAcceptedBody;
  if (!drivesSummary) return '';
  return `-tr${crypto.createHash('sha256').update(parsed.body).digest('hex').slice(0, 8)}`;
}

module.exports = {
  technicianReportCustomerCopy,
  containsReportAccessCode,
  summaryCopySignature,
  MAX_REPORT_CHARS,
};
