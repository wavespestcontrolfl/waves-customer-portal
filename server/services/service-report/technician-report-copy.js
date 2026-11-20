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
const { findBannedCustomerCopy, REENTRY_VERB_SRC } = require('./activity-indicators');
const { COMPLETION_ACCESS_CODE_RE } = require('../completion-access-code');
const { formatTechnicianForCustomer, isGenericTechnicianLabel } = require('../../utils/technician-name');

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
  // digits directly before a positional prep + device noun are the same
  // credential without any action verb ("Use 4417 at the side gate",
  // codex r87) — mirrors the canonical redactor's digit-to-location form;
  // ≥3 digits keeps counts ("12 at the gate") out
  /\b\d{3,8}\b\s+(?:at|for|to|on|in|into|near|by)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b/i,
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
  // plain lowercase word codes count in the positional window when a USAGE
  // verb hands them to the reader ("Use blue at the keypad", codex r88) —
  // the verb anchor is what separates a handed-over credential from
  // ordinary prose ("damage to the keypad", "use caution near the keypad"
  // stay legal via the token exclusions)
  /\b(?:use|using|enter|entering|type|typing|press|pressing|punch(?:ing)?|input(?:ting)?|provide[sd]?|providing|give|giving|say|saying|try|trying)\s+(?!(?:the|a|an|this|that|it|them|these|those|your|our|my|his|her|their|any|some|each|every|all|extra|proper|special|standard|normal|good|great|due|care|caution|gloves|only|again|notes?|details?|information|numbers?|keys?|data|values?|entries|it['’]s)\b)(?![a-z]+ly\b)["'‘’“”]?[a-z][a-z0-9#*]{1,11}(?:\s+(?!(?:and|or|but|the|a|an|of|in|on|at|by|with|to|for|as|is|was|were|when|while|if)\b)[a-z][a-z0-9#*]{1,11}){0,2}["'‘’“”]?\s+(?:at|for|on|into|near|by)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)\b/i,
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

// The four-section report the writer produces under GATE_REPORT_WRITER_RULES
// (owner "ok go" 2026-10-01): these titles, once each, in this order, each
// followed by exactly ONE line (the same boundary the two-section shape
// keeps: a note typed on a line under the report rejects the parse instead
// of publishing). Longer than the two-section paragraph, so it carries its
// own cap.
const FOUR_SECTION_HEADERS = Object.freeze([
  ['whatWeFound', 'What we found', /^\s*WHAT WE FOUND:?\s*$/],
  ['whatWeDid', 'What we did and why', /^\s*WHAT WE DID AND WHY:?\s*$/],
  ['whatToExpect', 'What to expect', /^\s*WHAT TO EXPECT:?\s*$/],
  ['whatsNext', 'What’s next', /^\s*WHAT['’]S NEXT:?\s*$/],
]);
const MAX_FOUR_SECTION_CHARS = 3200;
// Read at call time: with the switch off (never on, or turned off as the
// kill switch) a four-section note is not reviewed report copy, so saved
// four-section reports fall back like any unparsed note (Codex #5500).
const { reportWriterRulesLive } = require('../../config/feature-gates');
const ANY_REPORT_HEADER_RE = /^\s*WHAT (?:WE DID(?: AND WHY)?|WE FOUND|TO EXPECT|['’]S NEXT):?\s*$/;

// A title written inline ("WHAT WE FOUND: You mentioned…") is the same
// shape as a title on its own line followed by its text.
const INLINE_FOUR_SECTION_TITLE_RE = /^\s*(WHAT WE FOUND|WHAT WE DID AND WHY|WHAT TO EXPECT|WHAT['’]S NEXT):\s*(\S.*)$/;

function parseFourSections(text) {
  const lines = text.split(/\r?\n/).flatMap((line) => {
    const inline = INLINE_FOUR_SECTION_TITLE_RE.exec(line);
    return inline ? [inline[1], inline[2]] : [line];
  });
  const starts = FOUR_SECTION_HEADERS.map(([, , header]) => lines.findIndex((line) => header.test(line)));
  if (starts.some((index) => index === -1)) return null;
  if (starts.some((index, i) => i > 0 && index <= starts[i - 1])) return null;
  // Free text above the report is not reviewed customer copy.
  if (contentLines(lines.slice(0, starts[0])).length) return null;
  const sections = FOUR_SECTION_HEADERS.map(([key, title], i) => ({
    key,
    title,
    paragraphs: contentLines(lines.slice(starts[i] + 1, i + 1 < starts.length ? starts[i + 1] : lines.length)),
  }));
  // Exactly one line per section: any second line (an internal note typed
  // under the report, a stray title) is unreviewed free text and rejects
  // the whole parse.
  if (sections.some((section) => section.paragraphs.length !== 1
    || ANY_REPORT_HEADER_RE.test(section.paragraphs[0]))) return null;
  return sections;
}

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
// Hoisted from the parser so the shared screen below applies the same
// approved-idiom normalization to every customer-copy consumer.
const SAFE_IDIOM_RE = /(?<![-\w])(?<!\b(?:pets?|kids?|child|children|family)\s)safe\s+(?:once|when|after|as\s+soon\s+as)\s+(?:it\s+is\s+|everything\s+is\s+|the\s+(?:product|application|treatment|area)\s+is\s+)?(?:fully\s+|completely\s+)?dry\b/gi;
const TIMING_CONFIRM_RE = /\b(?:technician|tech)\b(?:(?!\b(?:not|never|no|didn['’]t|doesn['’]t|don['’]t|won['’]t|cannot|can['’]t|couldn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t|hadn['’]t|shouldn['’]t|wouldn['’]t|fail(?:s|ed|ing)?|unable|without|refus(?:es|ed|ing)?|forg(?:ot|ets?|etting)|neglect(?:s|ed|ing)?|omit(?:s|ted|ting)?|declin(?:es|ed|ing)?|miss(?:es|ed|ing)?|need(?:s|ed|ing)?|yet|wait(?:s|ed|ing)?|await(?:s|ed|ing)?|pending|remain(?:s|ed|ing)?|plan(?:s|ned|ning)?|intend(?:s|ed|ing)?|expect(?:s|ed|ing)?|hop(?:es|ed|ing)?|tr(?:y|ies|ied|ying)|attempt(?:s|ed|ing)?|schedul(?:es|ed|ing)?|going|will|would|should|must|supposed)\b)[^.!?]){0,40}\bconfirm(?:s|ed|ing)?\b(?:(?!\b(?:not|nothing|neither|never|no)\b)[^.!?]){0,25}(?<!\b(?!(?:the|its|confirm(?:s|ed|ing)?|re-?entry|entry|reentry|drying|dry(?:ing)?|dry[-\s]?time|time|treatment)\b)[a-z][a-z'’-]*\s+)\btiming\b(?![^.!?]{0,30}\b(?:not|never|no|nothing|unavailable|unknown|unconfirmed|undetermined|pending|(?:wasn|weren|isn|aren|won|didn|doesn|hasn|haven|hadn|couldn|shouldn|wouldn)['’]t|cannot|can['’]t)\b)/i;

// The four-section shape of the notes, whatever the switch: the sections, or
// null. The PDF key reads it in both states (reportDependsOnWriterRules).
function fourSectionShape(notes) {
  const text = String(notes || '');
  return text.trim() && text.length <= MAX_FOUR_SECTION_CHARS ? parseFourSections(text) : null;
}

// The four-section report's structure and its customer-copy violations,
// whether or not it would publish (the edit heads-up names what an edit
// added even when a refused word would drop the whole body). Null unless
// the switch is live and the shape holds.
function fourSectionReport(notes) {
  const sections = reportWriterRulesLive() ? fourSectionShape(notes) : null;
  if (!sections) return null;
  const body = sections.map((section) => section.paragraphs.join(' ')).join(' ').trim();
  return { sections, body, violations: customerCopyViolations(body) };
}

function technicianReportCustomerCopy(notes) {
  const text = String(notes || '');
  if (!text.trim()) return null;

  // Four-section report: the same screens over the joined text; `sections`
  // keeps the titles for surfaces that render them.
  const fourSectionCopy = fourSectionReport(text);
  if (fourSectionCopy) {
    const { sections: fourSections, body, violations } = fourSectionCopy;
    const sectionText = (key) => fourSections.find((section) => section.key === key).paragraphs.join(' ');
    return {
      whatWeDid: sectionText('whatWeDid'),
      whatWeFound: sectionText('whatWeFound'),
      sections: violations.length ? null : fourSections,
      body: violations.length ? null : body,
      violations,
    };
  }

  if (text.length > MAX_REPORT_CHARS) return null;

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
  // AFFIRMATIVE technician confirmation only (codex r66/r67): the subject
  // must be the technician and the tempered gaps refuse to cross a
  // negation, so "the technician did not confirm timing" (and a homeowner
  // claiming to confirm) never unlock the exemption. Failure and inability
  // predicates are negations too — "the technician failed to confirm
  // timing" is an explicitly UNCONFIRMED claim (codex r71), and so are
  // pending-obligation forms — "still needs to / has yet to / is waiting
  // to / will confirm timing" describe a confirmation that has NOT
  // happened (codex r73).
  // Idiom normalization now lives INSIDE customerCopyViolations so every
  // consumer (this parser, report recommendations, visual-moment captions)
  // enforces the identical approved-idiom policy (codex inline on #3516).
  const violations = customerCopyViolations(body);
  return {
    whatWeDid,
    whatWeFound,
    body: violations.length ? null : body,
    violations,
  };
}

// The technician's own note (owner 2026-11-19): a report whose summary is the
// note the technician gave, cleaned up, in place of the titled report. The
// completion will write it to structured_notes.reportNote = { v: 1, text,
// source } after its own screens; technician_notes then holds the raw note,
// which is internal. `source` is 'cleaned' (the technician's words: the
// report signs it with their first name) or 'fixed' (the standard sentence
// code wrote: no signature). Read from the record alone, never from a gate:
// a report that went out keeps its note. The customer-copy screens run again
// on every read.
const REPORT_NOTE_VERSION = 1;
const REPORT_NOTE_SOURCES = Object.freeze(['cleaned', 'fixed']);
const MAX_REPORT_NOTE_CHARS = 900;

// Stored notes that cannot be read (a string that does not parse, or any
// value but an object: a number or boolean as pg decodes a JSONB scalar, an
// array) may hold a note: they count as one, so the raw column beside them
// is never customer copy.
const UNREADABLE_NOTES = Symbol('unreadable structured_notes');

// The record's stored note, in whatever shape: undefined = it carries none
// (no notes, blank notes, JSON null, or an object without the key).
function storedReportNote(structuredNotes) {
  let notes = structuredNotes;
  if (typeof notes === 'string') {
    if (!notes.trim()) return undefined;
    try { notes = JSON.parse(notes); } catch { return UNREADABLE_NOTES; }
  }
  if (notes === null || notes === undefined) return undefined;
  if (typeof notes !== 'object' || Array.isArray(notes)) return UNREADABLE_NOTES;
  return notes.reportNote;
}

// A record that carries a note (in any shape), or notes that cannot be read,
// keeps the technician's raw note in technician_notes: no line of that
// column is customer copy.
function carriesReportNote(structuredNotes) {
  return storedReportNote(structuredNotes) !== undefined;
}

// Any line or paragraph break: a note is one paragraph, and the text after a
// break is not part of it.
const REPORT_NOTE_LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

// null = the record carries no note, so the titled report may stand. A record
// that carries one gets that note or nothing: a note in any other shape, or
// one the screens refuse, reads as { body: null }, because the raw notes
// column beside it holds the technician's raw note.
function reportNoteCustomerCopy(structuredNotes) {
  const note = storedReportNote(structuredNotes);
  if (note === undefined) return null;
  if (note === UNREADABLE_NOTES) return { body: null, violations: ['report_note_unreadable'], source: null };
  // One paragraph: a note is never titled, and a second line is not part of it.
  const valid = Boolean(note) && note.v === REPORT_NOTE_VERSION && REPORT_NOTE_SOURCES.includes(note.source)
    && typeof note.text === 'string' && !REPORT_NOTE_LINE_BREAK.test(note.text.trim());
  const text = valid ? note.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > MAX_REPORT_NOTE_CHARS) return { body: null, violations: ['report_note_shape'], source: null };
  const violations = noteRecordCopyViolations(text);
  return { body: violations.length ? null : text, violations, source: note.source };
}

// The words of the generic technician labels (utils/technician-name): a
// signature that is one of them names no technician.
const GENERIC_SIGNER_WORDS = new Set(['your', 'waves', 'technician', 'tech', 'team']);

// The first name a report prints for its technician (the signature on a
// technician's own note): the record's technician row as its identity
// snapshot froze it. A generic label in any name field signs nothing: the
// first name alone, the first and last name together, the name column, or
// one word of a label.
function reportTechnicianFirstName(service = {}) {
  // Required here: the identity snapshot loads the address helpers and the
  // db module, which the copy rules do not need.
  const { applyReportIdentitySnapshot } = require('./report-identity-snapshot');
  const row = applyReportIdentitySnapshot(service || {});
  const first = String(row.technician_first_name || '').trim();
  const last = String(row.technician_last_name || '').trim();
  const full = first ? `${first} ${last}`.trim() : formatTechnicianForCustomer({ name: row.technician_name });
  if (isGenericTechnicianLabel(first) || isGenericTechnicianLabel(full)) return null;
  const signer = first || full.split(/\s+/)[0];
  return GENERIC_SIGNER_WORDS.has(signer.toLowerCase()) ? null : signer;
}

// The summary a visit's report text prints as: a note in the technician's
// own words ('cleaned') signed " — <first name>" when the record names its
// technician; the standard sentence ('fixed') and the titled report as they
// are.
function printedReportSummary(parsed, service = {}) {
  if (!parsed?.body) return null;
  const signer = parsed.source === 'cleaned' ? reportTechnicianFirstName(service) : null;
  return signer ? `${parsed.body} — ${signer}` : parsed.body;
}

// The 8-hex digest of a summary as it prints. The PDF key's `-tr` part
// (summaryCopySignature) and a shown note's state (reportNoteRenderState)
// name the same digest of the same string.
function printedSummaryDigest(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8);
}

// The service lines whose report may print the technician's own note. Phase 1
// of the report speed plan (owner 2026-11-19) is the pest report alone: the
// lawn and tree & shrub reports take the note in their own later step, with
// its own place on their page (*lawn note*), and termite, rodent, mosquito
// and palm visits come with the typed visits.
const REPORT_NOTE_SERVICE_LINES = new Set(['pest']);

// The line a record's report renders as, by the rule report-data.js uses to
// pick the layout: the stored service_line, else the line its service type
// names (a record with no line and no type renders as pest). A row read
// without the service_line column cannot tell a lawn visit with a generic
// type from a pest visit, so it has no line, and a note on it is no text.
function reportServiceLine(record) {
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'service_line')) return null;
  // Required here: the line table loads the service-type normalizer, which
  // the copy rules do not need.
  const { detectServiceLine } = require('./service-line-configs');
  return record.service_line || detectServiceLine(record.service_type);
}

// The customer copy of a visit record's report text: the technician's own
// note when the record carries one (a refused or malformed note shows
// nothing: the raw notes column is never the fallback), else the titled
// report parsed from technician_notes. One rule for every reader that holds
// the record. A note on a record of any other line reads as no text, as a
// refused one does: no lawn or tree & shrub page edits it, and the raw notes
// column beside it stays internal. A visit whose recorded outcome applied
// nothing (inspection_only, customer_declined) shows no note either: on a
// callback its report leads with the outcome copy and its PDF prints no
// summary (ServiceReportDocument), and a note can name a treatment the visit
// did not make. The outcome is the one the callback copy reads
// (reservice-report.js: the stored service_data and structured notes), on
// any record, so no reader needs the is_callback column. service_data that is
// present but cannot be read (serviceDataUnreadable) shows no note either: it
// hides the outcome and the frozen typed cards the note rule checks, so no
// reader can show that the note may stand (the voice reader's parse refused
// it before; now every reader does). Absent service_data reads as none.
function visitReportCustomerCopy(record) {
  const note = reportNoteCustomerCopy(record?.structured_notes);
  if (note && !REPORT_NOTE_SERVICE_LINES.has(reportServiceLine(record))) {
    return { body: null, violations: ['report_note_service_line'], source: null };
  }
  if (note && serviceDataUnreadable(record || {})) {
    return { body: null, violations: ['report_note_unreadable_service_data'], source: null };
  }
  // Required here: the callback copy loads the card and asks modules, which
  // the copy rules do not need.
  if (note && require('./reservice-report').recordedOutcomeAppliedNothing(record || {})) {
    return { body: null, violations: ['report_note_no_application'], source: null };
  }
  return note || technicianReportCustomerCopy(record?.technician_notes);
}

// A value stored as an object or as its JSON: { data } when it reads as an
// object (not an array), { absent: true } when it is null, undefined or an
// empty string, and null when it cannot be read.
function readStoredObject(value) {
  if (value === null || value === undefined || value === '') return { absent: true };
  let data = value;
  if (typeof value === 'string') {
    try { data = JSON.parse(value); } catch { return null; }
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? { data } : null;
}

// Whether a record's service_data is present but cannot be read: a string
// that does not parse to an object, or any value that is not one (an array,
// a number, a JSON string inside the column), or an object whose `protocol`
// (the visit outcome's first source, reservice-report.js outcomeOf, which
// reads it as JSON too) is present but cannot be read. Production
// (2026-11-20, read-only): 654 of 654 completed visits store an object, and
// each protocol is an object or absent.
function serviceDataUnreadable(service = {}) {
  const stored = readStoredObject(service?.service_data);
  if (!stored) return true;
  return !stored.absent && readStoredObject(stored.data.protocol) === null;
}

// A record's service_data as an object ({} when absent or unreadable).
function recordServiceData(service = {}) {
  try {
    const data = typeof service.service_data === 'string'
      ? JSON.parse(service.service_data)
      : service.service_data;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// Whether a record's customer render depends on GATE_REPORT_WRITER_RULES.
// The switch acts on a render in two places only: notes with the four-section
// shape print as the summary only while it is on (fourSectionReport), and a
// Today's Result card the render prints (the primary card and auto_send
// companions) loses a four-section body while it is off (activity-indicators
// withoutDarkFourSectionBody). Every other record renders the same in both
// states. Read in both states: the shape, never the gated parse.
function reportDependsOnWriterRules(service = {}) {
  const serviceData = recordServiceData(service);
  const cards = [
    serviceData.typedReportSnapshot,
    ...(Array.isArray(serviceData.companionReportSnapshots)
      ? serviceData.companionReportSnapshots.filter((snap) => snap?.delivery === 'auto_send')
      : []),
  ];
  return cards.some((snap) => snap && typeof snap === 'object' && snap.type
    && snap.todaysResult?.bodyFormat === 'four_section')
    || Boolean(fourSectionShape(service.technician_notes));
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
 * when the technician report drives the rendered summary, by the report's
 * own rule (technicianReportDrivesSummary). A record whose render depends on
 * GATE_REPORT_WRITER_RULES (reportDependsOnWriterRules) also gets '-fson' or
 * '-fsoff': a flip changes its key both ways, and neither state matches a key
 * stored before this suffix existed (that render's state is unknown, also
 * when the parse is null in the state it was stored in). Every other record
 * keeps its key.
 */

// The writer-rules state, as a PDF key and a PDF payload name it. The browser
// that renders a PDF fetches its own /data from the web process, so /data in
// PDF mode names the state it built the payload in (`writerRules`), the
// PDF document shows it on its root element (data-writer-rules), and for a
// record whose render depends on the switch (reportDependsOnWriterRules) the
// renderer prints only once the page shows the state the key was computed
// under (pdf.js reportPdfReadySelector). A page built in the other state (a
// rolling restart's overlap), or by a page bundle or server from before this
// rule, never shows it: the render times out and nothing is stored. Every
// other record renders the same in both states and waits for the root alone.
function renderWriterRulesState() {
  return reportWriterRulesLive() ? 'on' : 'off';
}

// The note state, in the same way. A record that carries the technician's own
// note (carriesReportNote, stored notes that cannot be read included) keys
// its PDF with `-rn` (summaryCopySignature), and the page it prints must be
// built by the note reader in the same state: /data in PDF mode names it
// (`reportNote`), the PDF document shows it on its root element
// (data-report-note), and the renderer prints only once the page shows the
// state of its own build (pdf.js reportPdfReadySelector). 'shown:<digest>'
// when the summary is the note (summaryIsOwnNote): the digest of the signed
// note as it prints, the one the key's `-tr` part names, so a page built from
// another read of the record (the note or the signing name changed between
// the two reads) never matches either. 'withheld' when it is not (a refused
// note, a typed visit, another line). A page bundle or server from before
// the note reader never shows it, so the render times out and nothing is
// stored. null on every other record, which renders the same either way.
function reportNoteRenderState(service, payload) {
  if (!carriesReportNote(service?.structured_notes)) return null;
  return payload?.summaryIsOwnNote === true ? `shown:${printedSummaryDigest(payload.summary)}` : 'withheld';
}

function summaryCopySignature(service = {}) {
  const serviceData = recordServiceData(service);
  const parsed = visitReportCustomerCopy(service);
  const ownNote = carriesReportNote(service.structured_notes);
  // THE summary rule, as the report runs it for a customer (a PDF is
  // customer-facing): technicianReportDrivesSummary on the frozen snapshots,
  // through the dark four-section transform, with the completion's rejection
  // and the trapping screens. The key then changes whenever the printed
  // summary does, a gate flip included, and a cached PDF never keeps a
  // summary the live report dropped (codex r35 #3420).
  let state = '';
  if (reportDependsOnWriterRules(service)) state = reportWriterRulesLive() ? '-fson' : '-fsoff';
  // A record that carries the technician's own note (or stored notes that
  // cannot be read) prints its cards without report text and its actions
  // from the form alone (report-data.js), with or without a summary. Its key
  // always says so: a PDF cached before the record carried a note never
  // stands after it.
  if (ownNote) state = `-rn${state}`;
  if (!parsed?.body || !require('./activity-indicators').technicianReportDrivesSummary({
    serviceData, body: parsed.body, ownNote,
  })) return state;
  // The key hashes the summary as the report prints it (a note in the
  // technician's own words signed), so every other summary keeps its key:
  // its body.
  return `-tr${printedSummaryDigest(printedReportSummary(parsed, service))}${state}`;
}

// The full customer-copy screen the notes parser applies — shared banned
// list, the summary slot's extra forbidden vocabulary ("safe", bare
// "infestation", …), access-code shapes, and premium-experience's
// validateCustomerCopy. Exported so other verbatim customer surfaces
// (report recommendations, auto-published visual-moment captions) screen
// with exactly the same rules instead of a subset (codex P1 2026-08-27).
// Returns the matched violations; an empty array means the text may render.
function customerCopyViolations(text) {
  const raw = String(text || '');
  // The approved conditional re-entry idiom ("safe once dry" WITH an
  // affirmative technician timing confirmation) is normalized away before
  // the vocabulary screens run — the one sanctioned "safe" never rejects
  // the copy, every unconditional safety claim still does.
  const value = TIMING_CONFIRM_RE.test(raw) ? raw.replace(SAFE_IDIOM_RE, 'once dry') : raw;
  const violations = [
    ...findBannedCustomerCopy(value),
    ...EXTRA_FORBIDDEN.map((rx) => value.match(rx)?.[0] || null).filter(Boolean),
    ...(containsReportAccessCode(value) ? ['access_code'] : []),
  ];
  if (!violations.length && !validateCustomerCopy(value)) violations.push('forbidden_language');
  return violations;
}

// The copy screen for a record that carries the technician's own note: the
// note, and every list value and finding field such a record prints
// (report-data.js buildProtocolPayload, finding-provenance.js). The complete
// screen above; the completion access-code check (COMPLETION_ACCESS_CODE_RE,
// which also names "Side access 4417 for the yard", a shape the report check
// above does not); and any time a technician can give for re-entry or drying:
// any word that names hours, minutes or seconds, with or without a figure
// ("30+ minutes", "eighteen minutes", "½ hour", "a few minutes", "30min"); a
// figure with h or m ("2h"); a clock time, written in any of its marked forms
// ("3:30", any pm or a.m., "4am" or "four am", "3 o'clock", "half past three",
// "four in the afternoon") or as an hour after at, after, until, till, by,
// before, around, past, between or from ("after four", "until 4"), the
// hour written as a 24-hour clock too ("at 1600", "after 0830"); or
// overnight, tonight, tomorrow, noon or midnight. AGENTS.md bans a fixed
// re-entry or drying time in customer copy. A figure can be written in more
// ways than any list names (each pre-push audit round on this PR found one
// more: "dries", a hyphen, a plus, a number word, a fraction, a spelled-out
// hour), so a marker alone decides: the unit word, or the clock marker, or a
// time word before an hour. On such a record each match withholds the copy: a
// refused note shows nothing, and a refused list value or finding field is
// left out. Days stay legal: they name the next visit and when results show.
// The one exception is a sentence that names drying or re-entry ("dry",
// "re-enter", "keep … off", "stay … inside", "off-limits", "avoid") or the
// people and pets a re-entry line is about: there any figure or number word
// decides ("pets can return 11/22", "keep off 2d"), and so does a day word: a
// unit ("dries in half a day", "keep pets off for two days"), a weekday,
// "today", a part of the day ("dry by this evening"), a month or a season.
// Inside such a sentence the only time a note may give is the idiom "until
// dry". The re-entry verbs the complete screen pairs with minutes and hours
// (REENTRY_VERB_SRC) withhold a sentence with a day word as well ("You can
// return to the treated area in two days"), but not after I, we, the
// technician or the team: that is a follow-up. A full
// stop ends a sentence only before a capital letter or the end of the text,
// so "1.5 days" and "approx. 2 days" stay in their sentence; a line break
// does not end one. Singular "second" stays legal: it is the ordinal ("second visit"), and no
// re-entry time is one second. So do "am" after anything but a number ("I am")
// and, outside a drying or re-entry sentence, a part of the day with no hour
// ("Have a great afternoon!"). A count
// after one of those time words ("at 3 stations") is withheld too: nothing
// tells it from a clock time. A read-only production count of this rule
// (2026-11-20): a match in 47 of 474 pest customer recaps (2 clock times; in
// 41 a drying word and a day unit share a sentence) and in 56 of 401
// technician notes, none in the form lists or the finding fields. The
// access-code check matched none of them.
const NOTE_HOUR_SRC = '(?:\\p{N}{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
// A 24-hour clock with no colon: 3 or 4 digits, hour 0 to 23 and minutes 00
// to 59, or 2400 (midnight).
const NOTE_24H_CLOCK_SRC = '(?:(?:[01]?\\p{Nd}|2[0-3])[0-5]\\p{Nd}|2400)';
// The number words of a clock's hour and minutes (0 to 59: "four thirty am").
const NOTE_CLOCK_WORD_SRC = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|oh)';
// One sentence: a question or exclamation mark or a semicolon ends it; a
// full stop ends it only before a capital letter or the end of the text.
const NOTE_SENTENCE_CHAR_SRC = '(?:[^.!?;]|\\.(?!\\s*(?:\\p{Lu}|$)))';
// What marks a drying or re-entry sentence: a drying word, re-entry, keep or
// stay with off, out, away, inside, indoors or clear ("keep an eye out" is
// not one), off-limits, avoid, or the people and pets a re-entry line names.
const NOTE_DRY_REENTRY_SRC = `(?<!\\p{L})(?:${[
  '(?:dry|dries|drying|dried|wet|damp)',
  're-?\\s?ent(?:er|ers|ered|ering|ry|ries|rance)',
  `(?:keep|keeps|keeping|kept)(?!\\s+an\\s+eye)${NOTE_SENTENCE_CHAR_SRC}{0,40}?(?<!\\p{L})(?:off|out|outside|away|inside|indoors|clear)`,
  `(?:stay|stays|staying|stayed)${NOTE_SENTENCE_CHAR_SRC}{0,40}?(?<!\\p{L})(?:off|out|outside|away|inside|indoors|clear)`,
  'off[\\s-]?limits',
  '(?:avoid|avoids|avoiding|avoided)',
  '(?:pets?|dogs?|cats?|pupp(?:y|ies)|kittens?|kids?|child(?:ren)?|toddlers?|bab(?:y|ies)|people|family|anyone|everyone|guests?)',
].join('|')})(?!\\p{L})`;
// A day word: a unit from a day up, a weekday, today, a part of the day or a
// meal, a month (not "may", the verb), a season (not "fall", the verb), a
// date written with a slash ("11/22"), or a figure with d or w ("2d").
const NOTE_DAY_WORD_SRC = `(?:(?<!\\p{L})(?:${[
  'days?|nights?|weeks?|weekends?|fortnights?|months?|today',
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday',
  'mornings?|afternoons?|evenings?|sunset|sundown|sunrise|dawn|dusk|lunch(?:time)?|dinner(?:time)?|bedtime|breakfast',
  'january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec',
  'spring|summer|autumn|winter',
].join('|')})(?!\\p{L})|(?<!\\p{N})\\p{N}{1,2}\\s*\\/\\s*\\p{N}{1,2}(?!\\p{N})|\\p{N}\\s*(?:d|w|wks?)(?!\\p{L}))`;
// What withholds a drying or re-entry sentence: a day word, any figure, or
// any number word.
const NOTE_MARKED_TIME_SRC = `(?:${NOTE_DAY_WORD_SRC}|\\p{N}|(?<!\\p{L})(?:${[
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen',
  'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen|half|couple',
].join('|')})(?!\\p{L}))`;
// The re-entry verbs the complete screen already pairs with minutes and hours
// (activity-indicators.js REENTRY_VERB_SRC: return, come back, walk on, use the
// treated area, ready for use, …) pair with a day word here. A follow-up says
// the same verbs with the technician as the one who comes back ("I will
// return in two weeks to check the stations"), so a verb after I, we, the
// technician or the team, with or without a modal, is no re-entry.
const NOTE_REENTRY_VERB_SRC = `(?<!\\b(?:i|we|technician|tech|team)(?:\\s*['\u2019]ll|\\s+will|\\s+can|\\s+would|\\s+should|\\s+may|\\s+might|\\s+plan\\s+to)?\\s+)\\b(?:${REENTRY_VERB_SRC})\\b`;
const NOTE_RECORD_TIME_RE = new RegExp([
  '(?<!\\p{L})(?:half-?|quarter-?)?(?:hours?|minutes?|mins?|hrs?|secs?|seconds)(?!\\p{L})',
  '\\p{N}\\s*[hm](?!\\p{L})',
  '(?<!\\p{N})\\p{N}{1,2}\\s*:\\s*\\p{N}{2}(?!\\p{N})',
  '(?<!\\p{L})p\\.?\\s?m\\.?(?!\\p{L})',
  '(?<!\\p{L})a\\.\\s?m\\.?(?!\\p{L})',
  `(?:\\p{N}|(?<!\\p{L})${NOTE_CLOCK_WORD_SRC})[\\s-]*a\\.?\\s?m(?!\\p{L})`,
  "(?<!\\p{L})o['\\u2019]?\\s*clock(?!\\p{L})",
  '\\bhalf\\s+past\\b|\\bquarter\\s+(?:past|to|after|till|til)\\b',
  `(?<!\\p{L})${NOTE_HOUR_SRC}\\s+(?:in\\s+the\\s+(?:morning|afternoon|evening|night)|at\\s+night|this\\s+(?:morning|afternoon|evening))`,
  `(?<!\\p{L})(?:at|after|until|till|til|by|before|around|past|between|from)\\s+(?:about\\s+|around\\s+)?(?:${NOTE_HOUR_SRC}|${NOTE_24H_CLOCK_SRC})(?![\\p{L}\\p{N}])`,
  '\\b(?:overnight|tonight|tomorrow|noon|midnight)\\b',
  `${NOTE_DRY_REENTRY_SRC}${NOTE_SENTENCE_CHAR_SRC}*?${NOTE_MARKED_TIME_SRC}`,
  `${NOTE_MARKED_TIME_SRC}${NOTE_SENTENCE_CHAR_SRC}*?${NOTE_DRY_REENTRY_SRC}`,
  `${NOTE_REENTRY_VERB_SRC}${NOTE_SENTENCE_CHAR_SRC}*?${NOTE_DAY_WORD_SRC}`,
  `${NOTE_DAY_WORD_SRC}${NOTE_SENTENCE_CHAR_SRC}*?${NOTE_REENTRY_VERB_SRC}`,
].join('|'), 'iu');

function noteRecordCopyViolations(text) {
  const value = String(text || '');
  const violations = customerCopyViolations(value);
  if (COMPLETION_ACCESS_CODE_RE.test(value)) violations.push('note_record_access_code');
  if (NOTE_RECORD_TIME_RE.test(value)) violations.push('note_record_time');
  return violations;
}

module.exports = {
  technicianReportCustomerCopy,
  reportNoteCustomerCopy,
  visitReportCustomerCopy,
  carriesReportNote,
  printedReportSummary,
  reportTechnicianFirstName,
  REPORT_NOTE_VERSION,
  REPORT_NOTE_SOURCES,
  MAX_REPORT_NOTE_CHARS,
  fourSectionReport,
  containsReportAccessCode,
  customerCopyViolations,
  noteRecordCopyViolations,
  summaryCopySignature,
  renderWriterRulesState,
  reportNoteRenderState,
  reportDependsOnWriterRules,
  MAX_REPORT_CHARS,
};
