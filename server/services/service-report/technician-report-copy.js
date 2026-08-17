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
  // partitive "combination of 12 bait stations" / "in combination with" is
  // ordinary treatment prose, not a credential — the proximity shapes skip
  // combo/combination when a partitive follows; the linker shapes below
  // still catch "the combination is 4417" (codex r86)
  /\b(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)\b[^\n.!?]{0,25}\b[a-z]?\d{2,8}\b/i,
  /\b[a-z]?\d{2,8}\b[^\n.!?]{0,15}\b(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)\b/i,
  // a direct device assignment is a credential too ("The side gate is
  // 4417", codex r84) — ≥3 digits, and a trailing measurement unit keeps
  // dimensional prose legal ("the gate is 100 feet from the lanai")
  /\b(?:gate|door|garage|lock\s?box|alarm|entry)\b[^\n.!?]{0,12}\b(?:is|:|=|was|were|reads?)\s*["'‘’“”]?\d{3,8}\b(?!\s*(?:feet|foot|ft|inch(?:es)?|in\b|yards?|yds?|meters?|metres?|sq|square|percent|%|min(?:utes?)?|h(?:ou)?rs?|days?|weeks?|months?|years?|dollars?|linear|gallons?|oz|ounces?|pounds?|lbs?)\b)/i,
  // digits + an access action on a gate/door/garage are a credential even
  // WITHOUT a code noun ("Use 4417 to open the side gate", codex r83) —
  // ≥3 digits so counts ("2 doors") never trip
  /\b\d{3,8}\b[^\n.!?]{0,20}\b(?:open(?:s|ing)?|unlock(?:s|ing)?|access(?:es|ing)?)\b[^\n.!?]{0,20}\b(?:gate|door|garage|entry|lock)\b/i,
  /\b(?:open(?:s|ing)?|unlock(?:s|ing)?|access(?:es|ing)?|enter(?:s|ing)?)\b[^\n.!?]{0,25}\b(?:gate|door|garage|entry|lock)\b[^\n.!?]{0,15}\b\d{3,8}\b/i,
  // a device followed by its own action and digits is the same credential
  // ("The gate opens with 4417", codex r85) — the trailing measurement-unit
  // lookahead keeps dimensional prose legal ("opens onto 400 square feet")
  /\b(?:gate|door|garage|entry|lock)\b[^\n.!?]{0,20}\b(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?)\b[^\n.!?]{0,20}\b\d{3,8}\b(?!\s*(?:feet|foot|ft|inch(?:es)?|in\b|yards?|yds?|meters?|metres?|sq|square|percent|%|min(?:utes?)?|h(?:ou)?rs?|days?|weeks?|months?|years?|dollars?|linear|gallons?|oz|ounces?|pounds?|lbs?)\b)/i,
  // individually separated digits ("PIN is 1 2 3 4", "1-2-3-4") are the
  // same credential the contiguous shapes catch (codex r74) — three or
  // more single digits joined by spaces/hyphens beside a code noun
  /\b(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)\b[^\n.!?]{0,25}\b\d(?:[\s-]+\d){2,7}\b/i,
  /\b\d(?:[\s-]+\d){2,7}\b[^\n.!?]{0,15}\b(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)\b/i,
  // quote classes accept Unicode smart quotes — mobile keyboards curl them
  // (codex r40)
  // quoted credentials may span up to four tokens ("blue waves",
  // 'open sesame') — the shared scrubber's multi-token posture (codex r48)
  /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b\s*(?:is|:|=|-|was|were|remains?|remained|stays?|stayed|became|becomes|(?:(?:will|would|should|shall|must|might|may|can|could|has|have|had)\s+)?continue[ds]?\s+to\s+(?:be|remain|stay)|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always|previously|originally|briefly)\s+)?(?:become|been|remained|stayed)|(?:will|would|should|shall|must|might|may|can|could)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always)\s+)?(?:be|remain|stay)|(?:is|are|was|were)\s+going\s+to\s+(?:be|remain|stay)|(?:(?:was|were|is|are|has|have|had)\s+(?:been\s+)?(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?)?(?:changed|switched|updated|reset|set)\s+to)?\s*(?:(?:now|currently|still|today|temporarily|again)\s+)?(?:["'‘’“”][A-Za-z0-9#*][A-Za-z0-9#*-]{1,14}(?:\s+[A-Za-z0-9#*][A-Za-z0-9#*-]{0,11}){0,3}["'‘’“”]|[A-Za-z]*\d[A-Za-z0-9#*]*\b)/i,
  // was/were are credential linkers for a bounded UPPERCASE/quoted token —
  // "The gate code was BLUE" (codex r51); bare lowercase after was/were
  // stays out ("the code was updated" is ordinary copy)
  // continuing-state verbs (remains/stays/became) link a bounded
  // UPPERCASE/quoted credential the same way is/was do (codex r52)
  // bounded temporal adverbs may sit between linker and credential —
  // "The gate code is now BLUE" (codex r53)
  /\b(?:[Cc]ode|PIN|[Pp]in|[Cc]ombo|[Cc]ombination|[Pp]asscode|[Pp]assword|[Pp]assphrase|[Kk]eypad|[Ll]ock\s?box)\b\s*(?:is|:|=|-|was|were|remains?|remained|stays?|stayed|became|becomes|(?:(?:will|would|should|shall|must|might|may|can|could|has|have|had)\s+)?continue[ds]?\s+to\s+(?:be|remain|stay)|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always|previously|originally|briefly)\s+)?(?:become|been|remained|stayed)|(?:will|would|should|shall|must|might|may|can|could)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always)\s+)?(?:be|remain|stay)|(?:is|are|was|were)\s+going\s+to\s+(?:be|remain|stay)|(?:(?:was|were|is|are|has|have|had)\s+(?:been\s+)?(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?)?(?:changed|switched|updated|reset|set)\s+to)?\s*(?:(?:now|currently|still|today|temporarily|again)\s+)?["'‘’“”]?[A-Z0-9#*]{2,12}\b/,
  // hyphen-linked lowercase word codes ("the gate code is blue-waves")
  // count like the space-linked forms — bounded segments, so ordinary
  // hyphenated prose never chains past four tokens (codex r70)
  /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b\s*(?:is|:|=)\s*["'‘’“”]?[a-z][a-z0-9#*]{1,11}(?:-[a-z0-9#*]{1,11}){0,3}["'‘’“”]?(?=[\s.,!?‘’“”]|$)/i,
  // the explicit password nouns accept LONG alphabetic tokens too
  // ("the gate password is sunshineflorida") — concatenated-word
  // credentials routinely exceed the 12-char bound above (codex r78)
  /\b(?:passcode|password|passphrase)\b\s*(?:is|:|=)\s*["'‘’“”]?[a-z][a-z0-9#*]{1,31}(?:-[a-z0-9#*]{1,15}){0,3}["'‘’“”]?(?=[\s.,!?‘’“”]|$)/i,
  // ... and behind the continuing-state linkers too ("the gate password
  // remains sunshineflorida") — descriptor prose is screened by the same
  // stopword + -ly/-ed/-ing exclusions the multiword branch uses
  // (codex r81)
  /\b(?:passcode|password|passphrase)\b\s*(?:was|were|remains?|remained|stays?|stayed|became|becomes|(?:(?:will|would|should|shall|must|might|may|can|could|has|have|had)\s+)?continue[ds]?\s+to\s+(?:be|remain|stay)|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always|previously|originally|briefly)\s+)?(?:become|been|remained|stayed)|(?:will|would|should|shall|must|might|may|can|could)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always)\s+)?(?:be|remain|stay)|(?:is|are|was|were)\s+going\s+to\s+(?:be|remain|stay)|(?:(?:was|were|is|are|has|have|had)\s+(?:been\s+)?(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?)?(?:changed|switched|updated|reset|set)\s+to)\s+(?:(?:now|currently|still|today|temporarily|again)\s+)?(?!(?:the|a|an|same|not|no|still|confidential|private|secure|secured|protected|hidden|unchanged|active|valid|current|correct|operational|functional|effective|intact|okay|fine|good|stable|consistent|working|case|known|unknown|required|optional)\b)(?![a-z]+(?:ly|ed|ing)\b)["'‘’“”]?[a-z][a-z0-9#*]{3,31}["'‘’“”]?(?=[\s.,!?‘’“”]|$)/i,
  // continuing-state linkers (was/remains/stays/became/continue-to-be/
  // has-been/modal-be/going-to-be/changed-to) bind lowercase tokens too
  // (codex r72) — but ONLY hyphenated ones: after "was"/"remains" a plain
  // lowercase word is overwhelmingly a participle or descriptor ("the
  // keypad was scheduled", "the code remains unchanged"), so the hyphen is
  // the distinctive signal here, and participle-shaped hyphenated words
  // ("was re-keyed", "double-checked") are excluded by their -ed/-ing tail
  /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b\s*(?:was|were|remains?|remained|stays?|stayed|became|becomes|(?:(?:will|would|should|shall|must|might|may|can|could|has|have|had)\s+)?continue[ds]?\s+to\s+(?:be|remain|stay)|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always|previously|originally|briefly)\s+)?(?:become|been|remained|stayed)|(?:will|would|should|shall|must|might|may|can|could)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always)\s+)?(?:be|remain|stay)|(?:is|are|was|were)\s+going\s+to\s+(?:be|remain|stay)|(?:(?:was|were|is|are|has|have|had)\s+(?:been\s+)?(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?)?(?:changed|switched|updated|reset|set)\s+to)\s+(?:(?:now|currently|still|today|temporarily|again)\s+)?(?!(?:up-to-date|state-of-the-art|day-to-day|one-time)\b)(?!(?:[a-z0-9#*]+-)+[a-z0-9#*]*(?:ed|ing)\b)["'‘’“”]?[a-z][a-z0-9#*]{0,11}(?:-[a-z0-9#*]{1,11}){1,3}["'‘’“”]?(?=[\s.,!?‘’“”]|$)/i,
  // unquoted MULTIWORD lowercase values after credential linkers ("the
  // gate passphrase remains open sesame") — two to four bounded tokens
  // (codex r76). Ordinary status prose is screened out three ways: a
  // first-token stopword/descriptor list, an -ly/-ed/-ing first-token
  // exclusion ("fully functional", "recently updated"), and chaining that
  // stops at function words so "remains open sesame for the side gate"
  // still captures the credential pair.
  /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b\s*(?:was|were|remains?|remained|stays?|stayed|became|becomes|(?:(?:will|would|should|shall|must|might|may|can|could|has|have|had)\s+)?continue[ds]?\s+to\s+(?:be|remain|stay)|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always|previously|originally|briefly)\s+)?(?:become|been|remained|stayed)|(?:will|would|should|shall|must|might|may|can|could)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always)\s+)?(?:be|remain|stay)|(?:is|are|was|were)\s+going\s+to\s+(?:be|remain|stay)|(?:(?:was|were|is|are|has|have|had)\s+(?:been\s+)?(?:(?:now|currently|still|today|temporarily|again|recently|just)\s+)?)?(?:changed|switched|updated|reset|set)\s+to)\s+(?:(?:now|currently|still|today|temporarily|again)\s+)?(?!(?:this|that|it|same|the|a|an|to|for|not|no|still|now|very|quite|too|also|being|never|always|once|twice|briefly|previously|originally|recently|just|already|well|reset|secure|active|valid|functional|unchanged|confidential|private|protected|hidden|effective|intact|correct|current|working|operational|okay|fine|good|stable|consistent|case|in|on|at|off|out|up|down|back|about|only|prevent|avoid|ensure|allow|improve|match|reflect|comply|align|support|keep|make|meet|address|require|deter|stop|block|restrict|limit|discourage)\b)(?![a-z]+(?:ly|ed|ing)\b)[a-z][a-z0-9#*]{1,11}(?:\s+(?!(?:and|or|but|so|for|to|the|a|an|of|in|on|at|by|with|from|until|unless|if|when|while|as|is|was|were|will|would|should|that|this|it|not|be|been|being|than|after|before|during|since|per|via|off|out|up|down)\b)[a-z][a-z0-9#*]{1,11}){1,3}\b/i,
  // reverse order ("blue is the gate password") — a leading stopword
  // ("this is the code") never counts as the credential itself (codex r38)
  // device nouns join the reverse shape ("WAVES is the lockbox") and
  // UPPERCASE/quoted tokens get the same short positional window the digit
  // shapes already have before keypad/lockbox ("Use BLUE at the keypad") —
  // the uncovered reverse-alphabetic × device-noun intersection (codex r46)
  /\b(?!(?:this|that|it|here|there|what|which|below|above)\b)["'‘’“”]?[a-z0-9#*]{2,12}["'‘’“”]?\s+(?:is|=|was|were|remains?|remained|stays?|stayed|became|becomes|(?:(?:will|would|should|shall|must|might|may|can|could|has|have|had)\s+)?continue[ds]?\s+to\s+(?:be|remain|stay)|(?:has|have|had)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always|previously|originally|briefly)\s+)?(?:become|been|remained|stayed)|(?:will|would|should|shall|must|might|may|can|could)\s+(?:(?:now|currently|still|today|temporarily|again|recently|just|always)\s+)?(?:be|remain|stay)|(?:is|are|was|were)\s+going\s+to\s+(?:be|remain|stay))\s+(?:(?:now|currently|still|today|temporarily|again)\s+)?(?:the\s+)?(?:[a-z]+\s+){0,2}(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)\b/i,
  // ... and the positional window covers the ordinary code nouns too
  // ("Use BLUE for the gate code" / "for the password") — device nouns
  // alone left that intersection open (codex r47)
  /(?:["'‘’“”][A-Za-z0-9#*][A-Za-z0-9#*-]{1,14}(?:\s+[A-Za-z0-9#*][A-Za-z0-9#*-]{0,11}){0,3}["'‘’“”]|\b[A-Z0-9#*]{2,12})\s+(?:at|for|to|on|in|into|near|by|as|opens?|unlocks?)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:[Cc]ode|PIN|[Pp]in|[Cc]ombo(?!\s+(?:of|with)\b)|[Cc]ombination(?!\s+(?:of|with)\b)|[Pp]asscode|[Pp]assword|[Pp]assphrase|[Kk]eypad|[Ll]ock\s?box)\b/,
  // unquoted lowercase positional credentials (codex r71): hyphenated
  // tokens are distinctive enough to take the full positional window like
  // UPPERCASE does ("Use blue-waves at the keypad") — plain prose words
  // carry no hyphen, and the domain's ordinary hyphenated vocabulary
  // (follow-up, touch-up, re-entry, …) is excluded, so "a follow-up for
  // the keypad" and "use caution near the keypad" stay legal ...
  /\b(?!(?:this|that|it|same|the|a|an|to|for|follow-up|touch-up|tune-up|clean-up|walk-through|check-in|move-in|move-out|drop-off|pick-up|on-site|re-entry|re-service|re-treat(?:ment)?|one-time|day-to-day|up-to-date|state-of-the-art)\b)[a-z][a-z0-9#*]*(?:-[a-z0-9#*]+){1,3}\s+(?:at|for|to|on|in|into|near|by|as|opens?|unlocks?)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)\b/i,
  // ... while ANY bounded lowercase token counts before an as-linked code
  // noun ("use bluewaves as the gate code") — the as-linker names the token
  // AS the credential, so only descriptive verbs/stopwords are excluded
  /\b(?!(?:this|that|it|same|the|a|an|to|for|known|listed|used|posted|saved|stored|set|entered|kept|noted|labell?ed|marked|recorded|serves?|acts?|works?|functions?|doubles?)\b)[a-z][a-z0-9#*-]{1,14}\s+as\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase)\b/i,
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
  // The repository's APPROVED conditional re-entry idiom — "safe once
  // dry" (AGENTS.md compliance-language rule) — is stripped from the text
  // the vocabulary screens see, so the one sanctioned use of "safe" never
  // rejects the body while every unconditional safety claim still does
  // (codex r65). The idiom carries no figure, so the timing screens are
  // unaffected either way.
  // The exemption requires the COMPLETE idiom: the timing-confirmation
  // clause must be present too, or a bare "safe once dry" would publish
  // without the required technician confirmation (codex r66).
  // STANDALONE "safe" only (codex r79): "pet-safe once dry" must keep its
  // compound intact so the vocabulary screens still see the banned claim —
  // stripping from the hyphen onward would hide the only "safe" token.
  const SAFE_IDIOM_RE = /(?<![-\w])(?<!\b(?:pets?|kids?|child|children|family)\s)safe\s+(?:once|when|after|as\s+soon\s+as)\s+(?:it\s+is\s+|everything\s+is\s+|the\s+(?:product|application|treatment|area)\s+is\s+)?(?:fully\s+|completely\s+)?dry\b/gi;
  // AFFIRMATIVE technician confirmation only (codex r66/r67): the subject
  // must be the technician and the tempered gaps refuse to cross a
  // negation, so "the technician did not confirm timing" (and a homeowner
  // claiming to confirm) never unlock the exemption. Failure and inability
  // predicates are negations too — "the technician failed to confirm
  // timing" is an explicitly UNCONFIRMED claim (codex r71), and so are
  // pending-obligation forms — "still needs to / has yet to / is waiting
  // to / will confirm timing" describe a confirmation that has NOT
  // happened (codex r73).
  const TIMING_CONFIRM_RE = /\b(?:technician|tech)\b(?:(?!\b(?:not|never|no|didn['’]t|doesn['’]t|don['’]t|won['’]t|cannot|can['’]t|couldn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t|hadn['’]t|shouldn['’]t|wouldn['’]t|fail(?:s|ed|ing)?|unable|without|refus(?:es|ed|ing)?|forg(?:ot|ets?|etting)|neglect(?:s|ed|ing)?|omit(?:s|ted|ting)?|declin(?:es|ed|ing)?|miss(?:es|ed|ing)?|need(?:s|ed|ing)?|yet|wait(?:s|ed|ing)?|await(?:s|ed|ing)?|pending|remain(?:s|ed|ing)?|plan(?:s|ned|ning)?|intend(?:s|ed|ing)?|expect(?:s|ed|ing)?|hop(?:es|ed|ing)?|tr(?:y|ies|ied|ying)|attempt(?:s|ed|ing)?|schedul(?:es|ed|ing)?|going|will|would|should|must|supposed)\b)[^.!?]){0,40}\bconfirm(?:s|ed|ing)?\b(?:(?!\b(?:not|nothing|neither|never|no)\b)[^.!?]){0,25}(?<!\b(?:appointment|arrival|visit|schedule|scheduling|billing|invoice|payment|callback|follow[- ]?up)\s)\btiming\b(?![^.!?]{0,30}\b(?:not|never|no|nothing|unavailable|unknown|unconfirmed|undetermined|pending|(?:wasn|weren|isn|aren|won|didn|doesn|hasn|haven|hadn|couldn|shouldn|wouldn)['’]t|cannot|can['’]t)\b)/i;
  const screenText = TIMING_CONFIRM_RE.test(body)
    ? body.replace(SAFE_IDIOM_RE, 'once dry')
    : body;
  const violations = [
    ...findBannedCustomerCopy(screenText),
    ...EXTRA_FORBIDDEN.map((rx) => screenText.match(rx)?.[0] || null).filter(Boolean),
    ...(containsReportAccessCode(screenText) ? ['access_code'] : []),
  ];
  if (!violations.length && !validateCustomerCopy(screenText)) violations.push('forbidden_language');
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
