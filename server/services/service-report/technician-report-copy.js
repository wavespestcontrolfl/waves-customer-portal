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

// Credential detector shared with the generate-report output gate: tokens
// need an explicit code/PIN noun or a device credential shape. Location
// keywords alone ("120 linear feet around the
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
  // Shorthand device credentials ("rear gate 2468", "rear gate #2468",
  // "rear gate A2468") need no linking verb. Direct adjacency and the unit
  // exclusion preserve treatment measurements.
  /\b(?:gate|door|garage|lock\s?box|alarm|entry|keypad)\s*[:=-]?\s*["'‘’“”]?[a-z#*]?\d{3,8}(?!\.\d)\b(?!\s*(?:feet|foot|ft|inch(?:es)?|yards?|yds?|meters?|metres?|sq|square|percent|%|min(?:utes?)?|h(?:ou)?rs?|days?|weeks?|months?|years?|dollars?|linear|gallons?|oz|ounces?|pounds?|lbs?)\b)/i,
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

// An explicit credential noun outranks a unit-shaped suffix: "gate code
// 2468ft" is still a credential, even though "400 ft" beside a gate can be
// legitimate work detail. Inspect the original text before measurement
// suppression and count digits in compact or grouped numeric tokens.
// Bound the number of digit-bearing groups in a candidate below. Compact
// groups retain both affixes and every digit: a long credential must not
// become safe merely because its token exceeds a matching-size limit.
// Assert the first digit once, then consume the compact group in one pass.
// Splitting the same run into "letters before a digit" and "anything after"
// gives the regex engine thousands of equivalent split points on long mixed
// or all-digit input, even though only the complete token can satisfy the
// surrounding boundary.
const REPORT_NUMERIC_CREDENTIAL_GROUP = String.raw`(?=[A-Za-z#*]*\d)[A-Za-z0-9#*]+`;
// Do not let the optional leading affix consume the device noun itself in
// suffix forms such as "rear gate 2468-AB"; the contextual detector still
// needs that noun after normalization.
const REPORT_CREDENTIAL_LEADING_AFFIX_GROUP = String.raw`(?!(?:[Gg][Aa][Tt][Ee]|[Dd][Oo][Oo][Rr]|[Gg][Aa][Rr][Aa][Gg][Ee]|[Ee][Nn][Tt][Rr][Yy]|[Kk][Ee][Yy][Pp][Aa][Dd]|[Ll][Oo][Cc][Kk][Bb][Oo][Xx]|[Aa][Ll][Aa][Rr][Mm])\b)(?=[A-Za-z0-9#*]{1,12}[\s–—-])(?=[A-Za-z0-9#*]*[A-Za-z#*])[A-Za-z0-9#*]{1,12}`;
// A separated suffix must be uppercase/symbolic. Lowercase words after a code
// are ordinary prose ("8842 after hours") and must remain available to the
// surrounding detector rather than being absorbed as part of the token.
// Uppercase relation/action words are context too: consuming "AT THE SIDE"
// or "TO OPEN THE" would erase the link between a credential and its device.
const REPORT_CREDENTIAL_TRAILING_AFFIX_GROUP = String.raw`(?!(?:AND|THEN|OR|BUT|BEFORE|AFTER|WHILE|WHEN|DURING|SINCE|UNTIL|UNLESS|IF|AT|FOR|TO|ON|IN|INTO|NEAR|BY|AS|WITH|USING|VIA|IS|WAS|WERE|REMAINS?|STAYS?|BECOMES?|OPEN(?:S|ED|ING)?|UNLOCK(?:S|ED|ING)?|ACCESS(?:ES|ED|ING)?|ENTER(?:S|ED|ING)?)\b)(?=[A-Z0-9#*]{1,12}(?![A-Za-z0-9#*]))(?=[A-Z0-9#*]*[A-Z#*])[A-Z0-9#*]{1,12}`;
// A suffix joined by a hyphen is part of the credential token even when it
// is lowercase ("24-68-ab"). Keep the uppercase-only rule for whitespace:
// lowercase words separated by spaces are ordinary surrounding prose.
const REPORT_CREDENTIAL_HYPHEN_TRAILING_AFFIX_GROUP = String.raw`(?=[A-Za-z0-9#*]{1,12}(?![A-Za-z0-9#*]))(?=[A-Za-z0-9#*]*[A-Za-z#*])[A-Za-z0-9#*]{1,12}`;
const REPORT_CREDENTIAL_TRAILING_AFFIX_RE = new RegExp(String.raw`^${REPORT_CREDENTIAL_TRAILING_AFFIX_GROUP}$`);
const REPORT_NUMERIC_CREDENTIAL_TOKEN = String.raw`(?:${REPORT_CREDENTIAL_LEADING_AFFIX_GROUP}[\s–—-]+){0,3}${REPORT_NUMERIC_CREDENTIAL_GROUP}(?:[\s–—-]+${REPORT_NUMERIC_CREDENTIAL_GROUP}){0,7}(?:(?:\s+${REPORT_CREDENTIAL_TRAILING_AFFIX_GROUP}|\s*[–—-]\s*${REPORT_CREDENTIAL_HYPHEN_TRAILING_AFFIX_GROUP})){0,3}`;
const REPORT_MEASUREMENT_UNIT_TEXT = String.raw`(?:feet|foot|ft|inch(?:es)?|yards?|yds?|meters?|metres?|acres?|linear\s+(?:feet|foot|ft|yards?|yds?|meters?|metres?)|square\s+(?:feet|foot|ft|yards?|yds?|meters?|metres?)|sqft|sq\.?\s*(?:ft|feet|foot|yds?|yards?|meters?|metres?)|percent|min(?:utes?)?|h(?:ou)?rs?|days?|weeks?|months?|years?|dollars?|gallons?|gal|ml|millilit(?:er|re)s?|lit(?:er|re)s?|fl\.?\s*oz|oz|ounces?|pounds?|lbs?|grams?|kg)`;
const REPORT_MEASURED_MATERIAL_TEXT = String.raw`(?:treatment|product|lubricant|oil|bait|granules?|dust|spray|seal(?:ant)?)`;
const REPORT_WORK_ACTION_TEXT = String.raw`(?:appl(?:y|ied|ying)|treat(?:s|ed|ing)?|found|observ(?:e|es|ed|ing)|count(?:s|ed|ing)?|not(?:e|es|ed|ing)|record(?:s|ed|ing)?|servic(?:e|es|ed|ing)|inspect(?:s|ed|ing)?|check(?:s|ed|ing)?|replac(?:e|es|ed|ing)|remov(?:e|es|ed|ing)?|install(?:s|ed|ing)?|mix(?:es|ed|ing)?|spray(?:s|ed|ing)?|dust(?:s|ed|ing)?|clean(?:s|ed|ing)?|spread(?:s|ing)?|broadcast(?:s|ed|ing)?|distribut(?:e|es|ed|ing))`;
const REPORT_PAST_ACCESS_WORK_ACTION_RE = new RegExp(String.raw`\b${REPORT_WORK_ACTION_TEXT}\b`, 'i');
const REPORT_EXPLICIT_CREDENTIAL_NOUN_TEXT = String.raw`(?:code|pin|combo(?!\s+(?:of|with)\b)|combination(?!\s+(?:of|with)\b)|passcode|password|passphrase|keypad|lock\s?box)`;
const REPORT_REVERSE_CREDENTIAL_STATE_ADVERB_TEXT = String.raw`(?:now|currently|still|today|temporarily|again|recently|just|always|previously|originally|briefly)`;
const REPORT_REVERSE_CREDENTIAL_MODAL_TEXT = String.raw`(?:will|would|should|shall|must|might|may|can|could|has|have|had)`;
const REPORT_REVERSE_CREDENTIAL_LINK_TEXT = String.raw`(?:is|=|was|were|remains?|remained|stays?|stayed|became|becomes|as|for|(?:${REPORT_REVERSE_CREDENTIAL_MODAL_TEXT}\s+)?continue[ds]?\s+to\s+(?:be|remain|stay)|(?:has|have|had)\s+(?:${REPORT_REVERSE_CREDENTIAL_STATE_ADVERB_TEXT}\s+)?(?:become|been|remained|stayed)|${REPORT_REVERSE_CREDENTIAL_MODAL_TEXT}\s+(?:${REPORT_REVERSE_CREDENTIAL_STATE_ADVERB_TEXT}\s+)?(?:be|remain|stay)|(?:is|are|was|were)\s+going\s+to\s+(?:be|remain|stay))`;
const REPORT_REVERSE_CREDENTIAL_POST_LINK_ADVERB_TEXT = String.raw`(?:(?:now|currently|still|today|temporarily|again)\s+)?`;
const REPORT_EXPLICIT_NUMERIC_CREDENTIAL_RE = new RegExp(
  String.raw`\b${REPORT_EXPLICIT_CREDENTIAL_NOUN_TEXT}\b[^\n.!?]{0,25}?["'‘’“”]?(${REPORT_NUMERIC_CREDENTIAL_TOKEN})`,
  'gi',
);
const REPORT_REVERSE_EXPLICIT_NUMERIC_CREDENTIAL_RE = new RegExp(
  String.raw`(${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?:\s*${REPORT_MEASUREMENT_UNIT_TEXT})?\s+${REPORT_REVERSE_CREDENTIAL_LINK_TEXT}\s+${REPORT_REVERSE_CREDENTIAL_POST_LINK_ADVERB_TEXT}(?:the\s+)?(?:[a-z]+\s+){0,2}${REPORT_EXPLICIT_CREDENTIAL_NOUN_TEXT}\b`,
  'gi',
);
const REPORT_REVERSE_DEVICE_WORK_PURPOSE_RE = new RegExp(
  String.raw`^\s*${REPORT_MEASUREMENT_UNIT_TEXT}\s+for\s+(?:(?:the|a|an)\s+)?(?:${REPORT_WORK_ACTION_TEXT}|treatment|application)\b(?:\s+(?:the|near|around|at|on|by|beside)){0,2}\s+(?:keypad|lock\s?box)\b`,
  'i',
);

function isReverseDeviceWorkMeasurement(value, match) {
  const tokenOffset = match[0].indexOf(match[1]);
  if (tokenOffset < 0) return false;
  const digitOffset = match[1].search(/\d/);
  if (digitOffset < 0) return false;
  const embeddedUnit = match[1].match(new RegExp(String.raw`\s+${REPORT_MEASUREMENT_UNIT_TEXT}$`, 'i'))?.[0] || '';
  const purpose = embeddedUnit + match[0].slice(tokenOffset + match[1].length);
  if (!REPORT_REVERSE_DEVICE_WORK_PURPOSE_RE.test(purpose)) return false;

  const before = value.slice(
    Math.max(value.lastIndexOf('.', match.index), value.lastIndexOf('!', match.index), value.lastIndexOf('?', match.index), value.lastIndexOf('\n', match.index)) + 1,
    match.index,
  ) + match[1].slice(0, digitOffset);
  if (!REPORT_PAST_ACCESS_WORK_ACTION_RE.test(before)) return false;
  if (/\b(?:use|using|enter(?:s|ed|ing)?|typ(?:e|es|ed|ing)|press(?:es|ed|ing)?|input(?:s|ted|ting)?|open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?)\b/i.test(before)) return false;

  const after = value.slice(match.index + match[0].length).match(/^[^\n.!?]*/)?.[0] || '';
  return !REPORT_POSITIONAL_INTERFACE_ACCESS_TAIL_RE.test(after);
}

function isExplicitDeviceWorkMeasurement(value, match) {
  if (!/^(?:keypad|lock\s?box)\b/i.test(match[0])) {
    return isReverseDeviceWorkMeasurement(value, match);
  }
  const digitIndex = match[0].search(/\d/);
  if (digitIndex < 0) return false;
  const beforeDigits = match[0].slice(0, digitIndex);
  const measurementTail = match[0].slice(digitIndex)
    + value.slice(match.index + match[0].length);
  return REPORT_PAST_ACCESS_WORK_ACTION_RE.test(beforeDigits)
    && !/\b(?:code|pin|combo|combination|passcode|password|passphrase)\b/i.test(beforeDigits)
    && !/\b(?:use|using|enter(?:s|ed|ing)?|typ(?:e|es|ed|ing)|press(?:es|ed|ing)?|input(?:s|ted|ting)?|open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?)\b/i.test(beforeDigits)
    && REPORT_MEASUREMENT_AT_START_RE.test(measurementTail);
}

function containsExplicitNumericCredential(text) {
  const value = String(text || '');
  for (const pattern of [REPORT_EXPLICIT_NUMERIC_CREDENTIAL_RE, REPORT_REVERSE_EXPLICIT_NUMERIC_CREDENTIAL_RE]) {
    for (const match of value.matchAll(pattern)) {
      const digitCount = match[1].replace(/\D/g, '').length;
      // A keypad or lockbox mention can precede unrelated treatment work.
      // Preserve a unit-backed quantity governed by that work unless a code
      // noun or access action explicitly reconnects the number to the device.
      if (isExplicitDeviceWorkMeasurement(value, match)) continue;
      // An explicit credential noun still governs a long token or several
      // numeric groups. A total above eight digits must not let unit-shaped
      // groups disappear during the later measurement masking.
      if (digitCount >= 2) return true;
    }
  }
  return false;
}

// Remove explicit measurements before looking for device-adjacent numbers.
// The access patterns intentionally treat bare numbers near a gate as private,
// so the unit is the evidence that quantities such as "400 sqft" and "100 ml"
// are treatment details. Bare "in" stays out because it is commonly a
// preposition ("2468 in the morning"), not reliable evidence of inches.
const REPORT_MEASUREMENT_NUMBER_TEXT = String.raw`(?:\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?|\d(?:[\s-]+\d){2,7})`;
const REPORT_MEASUREMENT_QUANTITY_RE = new RegExp(
  String.raw`\b${REPORT_MEASUREMENT_NUMBER_TEXT}\s*${REPORT_MEASUREMENT_UNIT_TEXT}(?=\s|[.,;:!?)]|$)`,
  'gi',
);
const REPORT_MEASUREMENT_AT_START_RE = new RegExp(
  String.raw`^${REPORT_MEASUREMENT_NUMBER_TEXT}\s*${REPORT_MEASUREMENT_UNIT_TEXT}\b`,
  'i',
);
const REPORT_MEASUREMENT_AFTER_NUMBER_RE = new RegExp(String.raw`^\s*${REPORT_MEASUREMENT_UNIT_TEXT}\b`, 'i');
// Past access actions can legitimately be followed by a service date or a
// labeled property/unit identifier. Inspect each bounded numeric candidate so
// those structured values stay legal without exempting an unlabeled number.
const REPORT_PAST_ACCESS_DEVICE_RE = /\b(?:opened|unlocked|accessed|entered)\b[^\n.!?]{0,25}\b(?:gate|door|garage|entry|lock)\b/gi;
const REPORT_PAST_ACCESS_CONTEXT_RE = /\b(?:opened|unlocked|accessed|entered)\b[^\n.!?]{0,25}\b(?:gate|door|garage|entry|lock)\b/i;
const REPORT_PAST_ACCESS_NUMBER_RE = /\b\d{3,8}\b(?!\.\d)/g;
const REPORT_STRUCTURED_DATE_TEXT = String.raw`(?:\d{4}\s*[/-]\s*\d{1,2}\s*[/-]\s*\d{1,2}|\d{1,2}\s*[/-]\s*\d{1,2}\s*[/-]\s*(?:\d{2}|\d{4}))`;
const REPORT_STRUCTURED_DATE_RE = new RegExp(String.raw`\b${REPORT_STRUCTURED_DATE_TEXT}\b`, 'g');
const REPORT_AFFIXED_OR_GROUPED_NUMBER_RE = /(?:\b[A-Za-z#*]+\d[A-Za-z0-9#*]*\b|\b\d[A-Za-z0-9#*]*[A-Za-z#*]\b|\b\d{1,2}(?:[\s–—-]+\d{1,2}){1,7}\b)/;
// A work verb plus a domain noun establishes only its adjacent count, including
// bounded species/state modifiers. A later credential remains available to the
// relationship scanners instead of inheriting this work-detail exemption.
const REPORT_PEST_COUNT_RE = /\b(?:found|saw|observ(?:e|es|ed|ing)|count(?:s|ed|ing)?|not(?:e|es|ed|ing)|record(?:s|ed|ing)?|remov(?:e|es|ed|ing))\s+\d{1,8}\s+(?:[a-z][a-z’'-]{0,23}\s+){0,3}(?:ants?|termites?|roaches?|cockroaches?|mosquitoes?|fleas?|ticks?|spiders?|rodents?|mice|rats?|wasps?|bees?|flies|beetles?|silverfish|earwigs?)\b/gi;
const REPORT_SERVICE_COUNT_RE = /\binstall(?:s|ed|ing)?\s+\d{1,8}\s+(?:[a-z][a-z’'-]{0,23}\s+){0,3}(?:traps?|stations?|devices?|units?)\b/gi;
const REPORT_SERVICE_IDENTIFIER_RE = /\b(?:treat(?:s|ed|ing)?|servic(?:e|es|ed|ing)|inspect(?:s|ed|ing)?|check(?:s|ed|ing)?)\s+(?:bait\s+)?(?:station|trap|device|unit)\s*#?\s*\d{3,8}\b/gi;

function isValidStructuredDate(value) {
  const parts = value.split(/\s*[/-]\s*/).map(Number);
  const yearFirst = /^\d{4}\s*[/-]/.test(value);
  const [year, month, day] = yearFirst
    ? parts
    : [parts[2] < 100 ? 2000 + parts[2] : parts[2], parts[0], parts[1]];
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12
    && day >= 1 && day <= 31
    && candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function isStructuredDateNumber(value, index, length) {
  for (const match of value.matchAll(REPORT_STRUCTURED_DATE_RE)) {
    const end = match.index + match[0].length;
    const before = value.slice(Math.max(0, match.index - 12), match.index);
    const dateContext = /\bon\s*:?\s*$/i.test(before);
    if (match.index <= index && index + length <= end
      && dateContext && isValidStructuredDate(match[0])) return true;
  }
  return false;
}

function maskStructuredDates(value) {
  return value.replace(REPORT_STRUCTURED_DATE_RE, (date, offset, source) => (
    isValidStructuredDate(date)
      && /\bon\s*:?\s*$/i.test(source.slice(Math.max(0, offset - 12), offset))
      ? '[structured-date]' : date
  ));
}

function maskPastAccessWorkDetails(value) {
  return value
    .replace(REPORT_PEST_COUNT_RE, (detail) => detail.replace(/\d{1,8}/, '[work-detail]'))
    .replace(REPORT_SERVICE_COUNT_RE, (detail) => detail.replace(/\d{1,8}/, '[work-detail]'))
    .replace(REPORT_SERVICE_IDENTIFIER_RE, (detail) => detail.replace(/\d{3,8}/, '[work-detail]'));
}

function isPastAccessWorkCountNumber(value, index, length) {
  for (const pattern of [REPORT_PEST_COUNT_RE, REPORT_SERVICE_COUNT_RE]) {
    for (const match of value.matchAll(pattern)) {
      const numberOffset = match[0].search(/\d/);
      if (match.index + numberOffset === index
        && match[0].slice(numberOffset).match(/^\d{1,8}/)?.[0].length === length) return true;
    }
  }
  return false;
}

function containsPastAccessCredential(text) {
  const value = String(text || '');
  for (const relationship of value.matchAll(REPORT_PAST_ACCESS_DEVICE_RE)) {
    const tailOffset = relationship.index + relationship[0].length;
    const relationshipTail = value.slice(tailOffset).match(/^(?:\.(?=\d)|[^\n.!?])*/)?.[0] || '';
    const workAction = relationshipTail.search(REPORT_PAST_ACCESS_WORK_ACTION_RE);
    const tail = workAction >= 0 ? relationshipTail.slice(0, workAction) : relationshipTail;
    for (const numeric of tail.matchAll(REPORT_PAST_ACCESS_NUMBER_RE)) {
      if (numeric.index > 20) break;
      const index = tailOffset + numeric.index;
      const before = value.slice(Math.max(0, index - 16), index);
      const after = value.slice(index + numeric[0].length);
      if (/\bunit\s*$/i.test(before)) continue;
      if (isStructuredDateNumber(value, index, numeric[0].length)) continue;
      if (REPORT_MEASUREMENT_AFTER_NUMBER_RE.test(after)) continue;
      if (isPastAccessWorkCountNumber(value, index, numeric[0].length)) continue;
      return true;
    }
  }
  return false;
}

// N-P-K fertilizer analyses use the same separated-number surface as an
// access token. Preserve only a complete three-part analysis directly governed
// by an application verb or identified as fertilizer. Loose proximity is not
// enough: a later fertilizer sentence must not license an earlier gate code.
// This masking runs after the original-text explicit code/PIN scan, including
// reverse assignments, so credential nouns always take priority.
const REPORT_FERTILIZER_ANALYSIS_RE = /\b\d{1,2}(?:\.\d+)?\s*[-–—]\s*\d{1,2}(?:\.\d+)?\s*[-–—]\s*\d{1,2}(?:\.\d+)?\b/g;
const REPORT_FERTILIZER_NOUN = String.raw`(?:fertili[sz]er|plant\s+food|nutrient(?:\s+blend)?|n\s*[-–—]\s*p\s*[-–—]\s*k|npk|analysis)`;
const REPORT_FERTILIZER_NOUN_BEFORE_RE = new RegExp(String.raw`\b${REPORT_FERTILIZER_NOUN}\b\s*(?::|=)?\s*$`, 'i');
const REPORT_FERTILIZER_NOUN_AFTER_RE = new RegExp(String.raw`^\s*(?:${REPORT_FERTILIZER_NOUN})\b`, 'i');
// Product names and formulation descriptors may sit between an application
// verb and the N-P-K analysis ("Applied Lesco 24-0-11", "Broadcast granular
// 24-0-11"). Admit a small, word-shaped qualifier span while refusing access
// verbs, device nouns, credential linkers, and clause transitions. That keeps
// "Applied product, then opened the gate with 24-0-11" on the credential path.
const REPORT_APPLICATION_QUALIFIER_WORD = String.raw`(?!(?:and|then|before|after|with|using|used|via|to|for|at|on|into|near|by|open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|enter(?:s|ed|ing)?|gate|door|garage|entry|keypad|lockbox|lock|alarm|code|pin|combo|combination|passcode|password|passphrase)\b)[a-z][a-z0-9&+'’./-]*`;
const REPORT_APPLICATION_BEFORE_RE = new RegExp(
  String.raw`\b(?:appl(?:y|ied|ying|ication(?:\s+of)?)|broadcast(?:ed|ing)?|spread(?:ing)?|distribut(?:e|ed|ing)|spray(?:ed|ing)?|us(?:e|ed|ing)|mix(?:ed|ing)?)\b\s+(?:(?:an?|the)\s+)?(?:${REPORT_APPLICATION_QUALIFIER_WORD}\s+){0,4}(?:${REPORT_FERTILIZER_NOUN}\s+)?$`,
  'i',
);
const REPORT_APPLICATION_AFTER_RE = /^\s*(?:was\s+|were\s+)?(?:applied|broadcast|spread|distributed|sprayed|used|mixed)\b/i;
const REPORT_CREDENTIAL_NOUN_IN_CLAUSE_RE = /\b(?:code|pin|combo|combination|passcode|password|passphrase|keypad|lock\s?box)\b/i;
const REPORT_ACCESS_BEFORE_ANALYSIS_RE = /\b(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|enter(?:s|ed|ing)?)\b[^\n.!?]{0,25}\b(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b[^\n.!?]{0,15}(?:with|using|via|code|pin|combo|combination|[:=])?\s*$/i;
const REPORT_DEVICE_BEFORE_ANALYSIS_RE = /\b(?:gate|door|garage|entry|keypad|lock\s?box|alarm)\b(?:\s+(?:is|was|were|reads?))?\s*[:=]?\s*$/i;
const REPORT_DEVICE_ACCESS_BEFORE_ANALYSIS_RE = /\b(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b[^\n.!?]{0,20}\b(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?)\b[^\n.!?]{0,15}(?:with|using|via|code|pin|combo|combination|[:=])?\s*$/i;
const REPORT_ACCESS_AFTER_ANALYSIS_RE = /^[^\n.!?]{0,20}\b(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|enter(?:s|ed|ing)?)\b[^\n.!?]{0,25}\b(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b/i;

function hasCredentialAffixAroundAnalysis(before, after, preserveLeading, preserveTrailing) {
  if (/(?:\d\s*[-–—]|[#*])\s*$/.test(before)) return true;
  if (/^\s*(?:[-–—]\s*\d|[#*])/.test(after)) return true;

  const leadingGroup = before.match(/([A-Za-z0-9#*]{1,12})([\s–—-]+)$/);
  if (leadingGroup && /[A-Za-z#*]/.test(leadingGroup[1])) {
    if (/[-–—]/.test(leadingGroup[2]) || !preserveLeading) return true;
  }

  const trailingGroup = after.match(/^([\s–—-]+)([A-Za-z0-9#*]{1,12})/);
  if (trailingGroup && /[-–—]/.test(trailingGroup[1])) return true;
  const uppercaseCredentialGroup = trailingGroup
    && REPORT_CREDENTIAL_TRAILING_AFFIX_RE.test(trailingGroup[2]);
  return Boolean(uppercaseCredentialGroup && !preserveTrailing);
}

function maskFertilizerAnalyses(text) {
  return String(text || '').replace(REPORT_FERTILIZER_ANALYSIS_RE, (analysis, offset, source) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + analysis.length);
    const clauseBefore = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1);
    const clauseEndOffsets = [after.indexOf('.'), after.indexOf('!'), after.indexOf('?'), after.indexOf('\n')]
      .filter((value) => value >= 0);
    const clauseAfter = clauseEndOffsets.length ? after.slice(0, Math.min(...clauseEndOffsets)) : after;
    const applicationBefore = REPORT_APPLICATION_BEFORE_RE.test(clauseBefore);
    const applicationAfter = REPORT_APPLICATION_AFTER_RE.test(clauseAfter);
    const fertilizerNounBefore = REPORT_FERTILIZER_NOUN_BEFORE_RE.test(clauseBefore);
    const fertilizerNounAfter = REPORT_FERTILIZER_NOUN_AFTER_RE.test(clauseAfter);

    const embeddedToken = hasCredentialAffixAroundAnalysis(
      before,
      after,
      applicationBefore || fertilizerNounBefore,
      applicationAfter || fertilizerNounAfter || /^\s+(?:adjacent|close|next)\s+to\b/i.test(after),
    );
    if (embeddedToken) return analysis;

    const directApplication = applicationBefore || applicationAfter;
    const credentialNoun = REPORT_CREDENTIAL_NOUN_IN_CLAUSE_RE.test(clauseBefore)
      || REPORT_CREDENTIAL_NOUN_IN_CLAUSE_RE.test(clauseAfter);
    const deviceAccess = REPORT_ACCESS_BEFORE_ANALYSIS_RE.test(clauseBefore)
      || REPORT_DEVICE_BEFORE_ANALYSIS_RE.test(clauseBefore)
      || REPORT_DEVICE_ACCESS_BEFORE_ANALYSIS_RE.test(clauseBefore)
      || REPORT_ACCESS_AFTER_ANALYSIS_RE.test(clauseAfter);
    const accessInstruction = credentialNoun || (!directApplication && deviceAccess);
    if (accessInstruction) return analysis;

    const treatmentEvidence = directApplication || fertilizerNounBefore || fertilizerNounAfter;
    return treatmentEvidence ? '[fertilizer-analysis]' : analysis;
  });
}

// Normalize numeric credential tokens to the digit-only shape already handled
// by every contextual detector above. This covers compact alphanumeric tokens
// on either side of the digits and individually separated digits without
// teaching each gate/action/shorthand branch another token spelling.
const REPORT_CREDENTIAL_TOKEN_RE = new RegExp(
  String.raw`(^|[^A-Za-z0-9])(${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?=$|[^A-Za-z0-9])`,
  'g',
);
const REPORT_CREDENTIAL_CONTEXT_PREFIX_RE = new RegExp(
  String.raw`^(?:(?:use|using|enter|entering|type|typing|press|pressing|punch(?:ing)?|input(?:ting)?|try|trying|open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|and|then|with|via|to|for|at|on|into|near|by|${REPORT_WORK_ACTION_TEXT})\s+)+`,
  'i',
);

function accessCodeDetectionText(text) {
  return text.replace(REPORT_CREDENTIAL_TOKEN_RE, (match, prefix, token) => {
    const digits = token.replace(/\D/g, '');
    const credentialShape = /[A-Za-z#*]/.test(token) || /[\s–—-]/.test(token);
    if (!credentialShape || digits.length < 3 || digits.length > 8) return match;
    // A labeled property/unit id governed by treatment or inspection work is
    // not an access token. Keep that whole relationship intact so
    // normalization cannot collapse "treated unit 2468" to "gate 2468".
    // Access relationships such as "using unit2468" must still normalize and
    // reach the credential checks below.
    if (/\b(?:treat(?:ed|ing)?|servic(?:ed|ing)?|inspect(?:ed|ing)?)\s+unit\s*\d/i.test(token)) return match;
    const compactDevice = token.match(/^(?:(rear|side|front|back|main|north|south|east|west)[\s–—-]*)?(gate|door|garage|entry|keypad|lockbox|alarm)(?=[\d#*\s–—-]|$)/i);
    if (compactDevice) {
      const direction = compactDevice[1] ? `${compactDevice[1]} ` : '';
      return `${prefix}${direction}${compactDevice[2]} ${digits}`;
    }
    // The token grammar accepts alphabetic prefixes for forms such as
    // "AB 2468". Preserve access verbs/connectors that happen to occupy that
    // slot so normalization cannot erase the credential/device relationship.
    // Keep clause transitions and work verbs for the inverse reason: removing
    // "and inspected" would collapse an ordinary count into "gate 100".
    const contextPrefix = token.match(REPORT_CREDENTIAL_CONTEXT_PREFIX_RE)?.[0] || '';
    return `${prefix}${contextPrefix}${digits}`;
  });
}

// Measurement-looking suffixes do not make a credential safe when the
// original sentence directly ties that token to opening or entering a device.
// Keep this relationship check narrow so later treatment detail remains legal:
// "Opened rear gate, applied 100 ml around hinges" has no access connector.
const REPORT_SUBORDINATE_ACCESS_CODE_RE = new RegExp(
  String.raw`\b(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|enter(?:s|ed|ing)?)\b[^\n.!?]{0,25}\b(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b[^\n.!?]{0,12}\b(?:by|after)\s+(?:entering|typing|inputting|pressing|using)\s+(${REPORT_STRUCTURED_DATE_TEXT}|${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?=$|[^A-Za-z0-9])`,
  'gi',
);

function containsSubordinateAccessCredential(text) {
  for (const match of String(text || '').matchAll(REPORT_SUBORDINATE_ACCESS_CODE_RE)) {
    const digitCount = match[1].replace(/\D/g, '').length;
    if (digitCount >= 3 && digitCount <= 8) return true;
  }
  return false;
}

const REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT = String.raw`(?:(?:the|a|an)\s+)?(?:(?:your|our|their|customer['’]s)\s+)?(?:(?!(?:turf|soil|lawn|area|ground|field|near|by|at|around|beside|along)\b)[a-z][a-z'’\-]*\s+){0,2}(?:gate|door|garage|entry|keypad|lock\s?box|lock)`;
const REPORT_ACCESS_ACTION_MANNER_TEXT = String.raw`(?:manually|easily|readily|directly|immediately|automatically|successfully)`;
const REPORT_NUMERIC_ACCESS_CAUSATIVE_TEXT = String.raw`(?:let(?:s|ting)?|allow(?:s|ed|ing)?|enable(?:s|d|ing)?)\s+(?:you|us|them|(?:the|your|our)\s+(?:technician|tech|team|crew|specialist))(?:\s+to)?`;
const REPORT_NUMERIC_ACCESS_ACTION_LINK_TEXT = String.raw`(?:(?:(?:to|for|will|would|should|shall|must|might|may|can|could)(?:\s+(?:now|currently|still|today|temporarily|again|recently|just|always|${REPORT_ACCESS_ACTION_MANNER_TEXT}|not|never))?(?:\s+${REPORT_NUMERIC_ACCESS_CAUSATIVE_TEXT})?|${REPORT_NUMERIC_ACCESS_CAUSATIVE_TEXT})\s+)?`;
// Access instructions can place a connector between the credential and the
// access action. Screen that whole relationship before measurement masking.
const REPORT_INPUT_ACTION_TEXT = String.raw`(?:enter(?:s|ed|ing)?|typ(?:e|es|ed|ing)|press(?:es|ed|ing)?|punch(?:es|ed|ing)?|input(?:s|ted|ting)?|tr(?:y|ies|ied|ying))`;
const REPORT_ACCESS_INSTRUCTION_ACTION_TEXT = String.raw`(?:us(?:e|es|ed|ing)|${REPORT_INPUT_ACTION_TEXT}|provid(?:e|es|ed|ing)|giv(?:e|es|ing)|gave|sa(?:y|ys|id|ying))`;
const REPORT_INPUT_ACCESS_LINK_TEXT = String.raw`(?:before|after|when|(?:and\s+)?then)`;
const REPORT_DIRECT_ACCESS_ACTION_TEXT = String.raw`(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|enter(?:s|ed|ing)?)`;
const REPORT_ACCESS_CONDITION_SUBJECT_TEXT = String.raw`(?:you|we|they|the\s*technician|the\s*customer)`;
const REPORT_ACCESS_CONDITION_FREQUENCY_TEXT = String.raw`(?:ever|still|again|now|later|occasionally|sometimes)`;
const REPORT_ACCESS_CONDITION_AUX_TEXT = String.raw`(?:can|could|will|would|should|may|might|must|need(?:s|ed)?(?:\s+to)?|want(?:s|ed)?(?:\s+to)?|(?:have|has|had)(?:\s+to)?|(?:am|are|is|was|were)\s+able\s+to)`;
const REPORT_ACCESS_CONNECTOR_TEXT = String.raw`(?:so(?:\s+that)?|if|when(?:ever)?|before|after|once|and(?:\s+then)?|then)`;
const REPORT_CONDITIONAL_ACCESS_LINK_TEXT = String.raw`\s*,?\s*${REPORT_ACCESS_CONNECTOR_TEXT}\s+(?:${REPORT_ACCESS_CONDITION_SUBJECT_TEXT}\s+)?(?:${REPORT_ACCESS_CONDITION_FREQUENCY_TEXT}\s+)?(?:${REPORT_ACCESS_CONDITION_AUX_TEXT}\s+)?(?:${REPORT_ACCESS_CONDITION_FREQUENCY_TEXT}\s+)?`;
const REPORT_ACTIVE_ACCESS_DEVICE_CODE_RE = new RegExp(
  String.raw`\b${REPORT_DIRECT_ACCESS_ACTION_TEXT}\b[^\n.!?]{0,25}\b${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b(?:\s+(?!${REPORT_WORK_ACTION_TEXT}\b)[a-z][a-z'’\-]*){0,5}(?:\s+(?:with|using|via|code|pin|combo|combination)\b|\s*[:=])\s*(?!${REPORT_WORK_ACTION_TEXT}\b)(${REPORT_STRUCTURED_DATE_TEXT}|${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?=$|[^A-Za-z0-9])`,
  'gi',
);
const REPORT_PASSIVE_ACCESS_DEVICE_CODE_RE = new RegExp(
  String.raw`\b${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b\s+(?:was|were|is|are|has|have|had)\s+(?:been\s+)?${REPORT_DIRECT_ACCESS_ACTION_TEXT}\s+by\s+(?:using|entering|typing|inputting|pressing)\s+(${REPORT_STRUCTURED_DATE_TEXT}|${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?=$|[^A-Za-z0-9])`,
  'gi',
);
const REPORT_CONDITIONAL_ACCESS_CODE_RE = new RegExp(
  String.raw`\b${REPORT_ACCESS_INSTRUCTION_ACTION_TEXT}\s+(${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?:\s+${REPORT_MEASUREMENT_UNIT_TEXT})?${REPORT_CONDITIONAL_ACCESS_LINK_TEXT}(?:${REPORT_ACCESS_ACTION_MANNER_TEXT}\s+)?${REPORT_DIRECT_ACCESS_ACTION_TEXT}\s+${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b`,
  'gi',
);
// The case-insensitive credential token intentionally accepts lowercase
// affixes, so it can absorb material words before a connector. Preserve only
// an ordinary use whose own candidate is a complete measured material or
// fertilizer analysis. Input verbs, affixed candidates, and code nouns never
// enter this exception, and later candidates remain independently visible.
const REPORT_USE_MATERIAL_ACCESS_RELATION_RE = new RegExp(
  String.raw`^\bus(?:e|es|ed|ing)\s+(?:(?:${REPORT_MEASUREMENT_NUMBER_TEXT}\s*${REPORT_MEASUREMENT_UNIT_TEXT}\s+(?:of\s+)?${REPORT_MEASURED_MATERIAL_TEXT})|(?:${REPORT_FERTILIZER_ANALYSIS_RE.source})\s+${REPORT_FERTILIZER_NOUN})${REPORT_CONDITIONAL_ACCESS_LINK_TEXT}(?:${REPORT_ACCESS_ACTION_MANNER_TEXT}\s+)?${REPORT_DIRECT_ACCESS_ACTION_TEXT}\s+${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b$`,
  'i',
);
// A numeric candidate can be named first, then referred to as a credential
// or as the input that opens a device. Check this relationship before
// fertilizer and measurement masking; the shared input/action fragments keep
// the connector grammar aligned with the direct access forms.
const REPORT_CREDENTIAL_REFERENCE_TEXT = String.raw`\s*,?\s*(?:(?:(?:and\s+)?then|and|before|after)\s+)?${REPORT_ACCESS_INSTRUCTION_ACTION_TEXT}\s+(?:it|that)`;
const REPORT_REFERENCED_CREDENTIAL_RE = new RegExp(
  String.raw`(${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?:\s*${REPORT_MEASUREMENT_UNIT_TEXT})?${REPORT_CREDENTIAL_REFERENCE_TEXT}(?:\s+as\s+(?:the\s+)?(?:[a-z]+\s+){0,2}${REPORT_EXPLICIT_CREDENTIAL_NOUN_TEXT}\b|\s+to\s+(?:${REPORT_ACCESS_ACTION_MANNER_TEXT}\s+)?${REPORT_DIRECT_ACCESS_ACTION_TEXT}\s+${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b)`,
  'gi',
);

// "Opening the gate requires 2468 ml" is an access credential even though
// it looks like a measurement. Mask only quantities owned by a bounded work
// action/material phrase, then inspect every remaining candidate in that
// access predicate so later credentials cannot inherit the exemption.
const REPORT_ACCESS_PREDICATE_RE = new RegExp(
  String.raw`\b${REPORT_DIRECT_ACCESS_ACTION_TEXT}\b[^\n.!?]{0,25}\b${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b(?:\s+(?!${REPORT_WORK_ACTION_TEXT}\b)[a-z][a-z'’\-]*){0,5}\s+(?:require[sd]?|need[sd]?|takes?|took)\b`,
  'gi',
);
const REPORT_ACCESS_PREDICATE_WORK_MEASUREMENT_RE = new RegExp(
  String.raw`\b${REPORT_WORK_ACTION_TEXT}\b\s*${REPORT_MEASUREMENT_NUMBER_TEXT}\s*${REPORT_MEASUREMENT_UNIT_TEXT}\b`,
  'gi',
);
const REPORT_ACCESS_PREDICATE_MATERIAL_RE = new RegExp(
  String.raw`\b${REPORT_MEASUREMENT_NUMBER_TEXT}\s*${REPORT_MEASUREMENT_UNIT_TEXT}\s+(?:of\s+)?${REPORT_MEASURED_MATERIAL_TEXT}\b`,
  'gi',
);
const REPORT_ACCESS_PREDICATE_INPUT_RE = new RegExp(
  String.raw`\b${REPORT_INPUT_ACTION_TEXT}\s+(${REPORT_STRUCTURED_DATE_TEXT}|${REPORT_NUMERIC_CREDENTIAL_TOKEN})(?=$|[^A-Za-z0-9])`,
  'gi',
);

function containsAccessPredicateCredential(text) {
  const value = String(text || '');
  for (const relationship of value.matchAll(REPORT_ACCESS_PREDICATE_RE)) {
    const tailOffset = relationship.index + relationship[0].length;
    const tail = value.slice(tailOffset).match(/^(?:\.(?=\d)|[^\n.!?])*/)?.[0] || '';
    // Explicit input owns its candidate even when a material-looking suffix
    // follows. Work/date exemptions only apply after that relationship check.
    for (const input of tail.matchAll(REPORT_ACCESS_PREDICATE_INPUT_RE)) {
      const digitCount = input[1].replace(/\D/g, '').length;
      if (digitCount >= 3 && digitCount <= 8) return true;
    }
    const screened = maskPastAccessWorkDetails(maskStructuredDates(tail))
      .replace(REPORT_ACCESS_PREDICATE_WORK_MEASUREMENT_RE, '[work-detail]')
      .replace(REPORT_ACCESS_PREDICATE_MATERIAL_RE, '[work-detail]');
    for (const candidate of screened.matchAll(new RegExp(REPORT_CREDENTIAL_TOKEN_RE.source, 'g'))) {
      const digitCount = candidate[2].replace(/\D/g, '').length;
      if (digitCount >= 3 && digitCount <= 8) return true;
    }
  }
  return false;
}

function containsRawAccessDeviceCredential(text) {
  const value = String(text || '');
  for (const pattern of [
    REPORT_ACTIVE_ACCESS_DEVICE_CODE_RE,
    REPORT_PASSIVE_ACCESS_DEVICE_CODE_RE,
    REPORT_CONDITIONAL_ACCESS_CODE_RE,
    REPORT_REFERENCED_CREDENTIAL_RE,
  ]) {
    for (const match of value.matchAll(pattern)) {
      if (pattern === REPORT_CONDITIONAL_ACCESS_CODE_RE
        && REPORT_USE_MATERIAL_ACCESS_RELATION_RE.test(match[0])) continue;
      const digitCount = match[1].replace(/\D/g, '').length;
      if (digitCount >= 3 && digitCount <= 8) return true;
    }
  }
  return false;
}

const REPORT_POSITIONAL_CREDENTIAL_INTERFACE_RE = new RegExp(
  String.raw`\bus(?:e|es|ed|ing)\s+(${REPORT_NUMERIC_CREDENTIAL_TOKEN})\s*${REPORT_MEASUREMENT_UNIT_TEXT}\s+(?:at|for|on|into|near|by)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:keypad|lock\s?box)\b`,
  'gi',
);
const REPORT_POSITIONAL_INTERFACE_WORK_TAIL_RE = new RegExp(
  String.raw`^\s*(?:,\s*)?(?:(?:to|for)\s+)?(?:(?:we|they|the\s+technician)\s+)?(?:${REPORT_WORK_ACTION_TEXT}|treatment|application)\b`,
  'i',
);
const REPORT_POSITIONAL_INTERFACE_ACCESS_TAIL_RE = new RegExp(
  String.raw`\b(?:(?:get(?:s|ting)?|got)\s+inside|gain(?:s|ed|ing)?\s+(?:access|entry)|(?:for|to)\s+access|${REPORT_DIRECT_ACCESS_ACTION_TEXT}\s+${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT})\b`,
  'i',
);

function containsPositionalCredentialInterface(text) {
  const value = String(text || '');
  for (const match of value.matchAll(REPORT_POSITIONAL_CREDENTIAL_INTERFACE_RE)) {
    const digitCount = match[1].replace(/\D/g, '').length;
    if (digitCount < 3 || digitCount > 8) continue;
    const tail = value.slice(match.index + match[0].length).match(/^[^\n.!?]*/)?.[0] || '';
    const treatmentEvidence = REPORT_POSITIONAL_INTERFACE_WORK_TAIL_RE.test(tail);
    if (REPORT_POSITIONAL_INTERFACE_ACCESS_TAIL_RE.test(tail) || !treatmentEvidence) return true;
  }
  return false;
}

const REPORT_DIRECT_ACCESS_CODE_RES = [
  /\b(?:gate|door|garage|entry|keypad|lock\s?box|lock|alarm)\b\s*(?:is|:|=|was|were|reads?)\s*\d{3,8}\s*(?:gallons?|gal|ml|millilit(?:er|re)s?|lit(?:er|re)s?|fl\.?\s*oz|oz|ounces?|pounds?|lbs?|grams?|kg)\b/i,
  new RegExp(String.raw`\b(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|enter(?:s|ed|ing)?)\b[^\n.!?]{0,25}\b(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b\s*(?:with|using|via|code|pin|combo|combination|[:=])\s*${REPORT_STRUCTURED_DATE_TEXT}\b`, 'i'),
  new RegExp(String.raw`\b\d{3,8}\b\s+(?:${REPORT_MEASUREMENT_UNIT_TEXT}\s+)?${REPORT_NUMERIC_ACCESS_ACTION_LINK_TEXT}(?:${REPORT_ACCESS_ACTION_MANNER_TEXT}\s+)?${REPORT_DIRECT_ACCESS_ACTION_TEXT}\s+${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b`, 'i'),
  new RegExp(String.raw`\b${REPORT_INPUT_ACTION_TEXT}\s+\d{3,8}\b\s+(?:${REPORT_MEASUREMENT_UNIT_TEXT}\s+)?(?:at|for|on|into|near|by)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b`, 'i'),
  new RegExp(String.raw`\b${REPORT_ACCESS_INSTRUCTION_ACTION_TEXT}\s+\d{3,8}\b\s+(?:${REPORT_MEASUREMENT_UNIT_TEXT}(?:\s+|(?=,)))?(?:,\s*)?${REPORT_INPUT_ACCESS_LINK_TEXT}\s+(?:(?:we|you|they|the\s+technician|the\s+customer)\s+)?${REPORT_DIRECT_ACCESS_ACTION_TEXT}\s+${REPORT_DIRECT_ACCESS_DEVICE_TARGET_TEXT}\b`, 'i'),
  new RegExp(String.raw`\b(?:use|using)\s+\d{3,8}\b\s+(?:${REPORT_MEASUREMENT_UNIT_TEXT}\s+)?(?:at|for|on|into|near|by)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b\s+(?:to|for)\s+(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?|enter(?:s|ed|ing)?)\b`, 'i'),
  /\b(?:use|using|enter|entering|type|typing|press|pressing|input(?:ting)?|try|trying)\s+unit\s*\d{3,8}\b[^\n.!?]{0,12}\b(?:at|for|on|into|near|by)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b/i,
  /\b(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b[^\n.!?]{0,20}\b(?:open(?:s|ed|ing)?|unlock(?:s|ed|ing)?|access(?:es|ed|ing)?)\b\s*(?:with|using|via|code|pin|combo|combination|[:=])\s*\d{3,8}\b/i,
];
const REPORT_POSITIONAL_USE_CODE_RE = /\b(?:use|using)\s+\d{3,8}\b\s+(?:at|for|on|into|near|by)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}(?:gate|door|garage|entry|keypad|lock\s?box|lock)\b/i;
const REPORT_LONG_COMPACT_TOKEN_RE = /[A-Za-z0-9#*]{65,}/g;

function boundedCredentialScanText(text) {
  return text.replace(REPORT_LONG_COMPACT_TOKEN_RE, (token) => {
    const digits = token.replace(/\D/g, '');
    if (!digits) return 'ordinary';
    if (digits.length < 3) return `A${digits}B`;
    // Relationship scanners intentionally accept three-to-eight digit access
    // values. Keep a long compact candidate in that conservative class rather
    // than making an access instruction safe because its token is enormous.
    return digits.slice(0, 8);
  });
}

function containsReportAccessCode(text) {
  const raw = String(text || '');
  // Direct callers also screen legacy recommendations, captions, and raw
  // visual-moment notes, so they do not inherit the drafted report's
  // 1,600-character parser cap. No single customer-copy field approaches
  // this ceiling (captions are capped at 1,500; custom tips at 240). Fail
  // closed before any credential regex on an implausibly large value.
  if (raw.length > MAX_CUSTOMER_COPY_SCREEN_CHARS) return true;
  // Regexes below deliberately retain complete compact credentials of normal
  // size. Collapse only pathological unbroken runs in one linear pass so a
  // contextual matcher never searches thousands of equivalent token endings.
  const scanText = boundedCredentialScanText(raw);
  if (containsExplicitNumericCredential(scanText)) return true;
  if (containsPositionalCredentialInterface(scanText)) return true;
  if (containsPastAccessCredential(scanText)) return true;
  if (containsAccessPredicateCredential(scanText)) return true;
  // Direct token-to-device relationships outrank fertilizer context. Check the
  // original copy before an application qualifier can mask an N-P-K-shaped
  // credential ("Applied override 24-0-11 to open the rear gate").
  const originalRelationship = accessCodeDetectionText(scanText);
  if (containsRawAccessDeviceCredential(scanText)) return true;
  if (containsSubordinateAccessCredential(scanText)) return true;
  if (REPORT_DIRECT_ACCESS_CODE_RES.some((re) => re.test(scanText) || re.test(originalRelationship))) return true;
  if (REPORT_PAST_ACCESS_CONTEXT_RE.test(scanText)) {
    const normalizedPastInput = maskPastAccessWorkDetails(maskFertilizerAnalyses(maskStructuredDates(scanText)))
      .replace(REPORT_MEASUREMENT_QUANTITY_RE, '[measurement]');
    if (REPORT_AFFIXED_OR_GROUPED_NUMBER_RE.test(normalizedPastInput)) {
      const normalizedPastRelationships = accessCodeDetectionText(normalizedPastInput);
      if (containsPastAccessCredential(normalizedPastRelationships)) return true;
    }
  }
  const fertilizerScreened = maskPastAccessWorkDetails(maskFertilizerAnalyses(scanText));
  const value = fertilizerScreened.replace(REPORT_MEASUREMENT_QUANTITY_RE, '[measurement]');
  const normalized = accessCodeDetectionText(value);
  if (REPORT_POSITIONAL_USE_CODE_RE.test(normalized)) return true;
  // Normalization adds grouped/affixed spellings; it must never remove an
  // access relationship that the original, measurement-screened copy exposes.
  return REPORT_ACCESS_CODE_RES.some((re) => re.test(value) || re.test(normalized));
}
const { validateCustomerCopy } = require('./premium-experience');
const { EXTRA_FORBIDDEN } = require('./visit-summary-narrative');

// Longest legitimate generate-report output is ~140 words (≈1,000 chars);
// anything far beyond that is not the drafted report (a paste, a runaway
// edit) and must not become an unbounded customer summary.
const MAX_REPORT_CHARS = 1600;
const MAX_CUSTOMER_COPY_SCREEN_CHARS = 16000;

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

// The four-section report's structure and its customer-copy violations,
// whether or not it would publish (the edit heads-up names what an edit
// added even when a refused word would drop the whole body). Null unless
// the switch is live and the shape holds.
function fourSectionReport(notes) {
  const text = String(notes || '');
  if (!text.trim() || !reportWriterRulesLive() || text.length > MAX_FOUR_SECTION_CHARS) return null;
  const sections = parseFourSections(text);
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

// The full customer-copy screen the notes parser applies — shared banned
// list, the summary slot's extra forbidden vocabulary ("safe", bare
// "infestation", …), access-code shapes, and premium-experience's
// validateCustomerCopy. Exported so other verbatim customer surfaces
// (report recommendations, auto-published visual-moment captions) screen
// with exactly the same rules instead of a subset (codex P1 2026-08-27).
// Returns the matched violations; an empty array means the text may render.
function customerCopyViolations(text) {
  const raw = String(text || '');
  if (raw.length > MAX_CUSTOMER_COPY_SCREEN_CHARS) return ['too_long'];
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

module.exports = {
  technicianReportCustomerCopy,
  fourSectionReport,
  containsReportAccessCode,
  customerCopyViolations,
  summaryCopySignature,
  MAX_REPORT_CHARS,
  MAX_CUSTOMER_COPY_SCREEN_CHARS,
};
