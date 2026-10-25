// Report/track egress (AGENTS.md): entry-code shapes that must never persist
// into customer-visible completion text. Three shapes: a code word near a
// location word ("gate ... code"), a code word followed by digits
// ("pin 9921"), and the bare shorthand of a code-carrying location word
// followed directly by a code-shaped number ("Gate 1234", "lockbox is
// 2468" — codex r3). Ordinary copy ("entry points treated", "gate was
// open") never trips; a street address near the word "gate" may — that
// false positive fails closed and the tech rephrases.
//
// Its own module so the report builder (service-report/report-data.js) can
// screen stored lines too: complete-scheduled-service.js already requires
// report-data, so report-data cannot require it back.
const COMPLETION_ACCESS_CODE_RE = /(?:\b(?:gate|garage|door|lock\s?box|keypad|alarm|entry|access)\b[^\n.!?]{0,40}\b(?:code|pin|combo|combination)\b|\b(?:code|pin|combo|combination)\b[^\n.!?]{0,15}[a-z]?\d{2,4}(?:[-\s]\d{2,4}){0,2}|\b(?:gate|garage|door|lock\s?box|keypad|alarm|entry|access)\b[^\n.!?]{0,12}\b(?:[a-z]?\d{3,8}|[a-z]?\d{2,4}(?:[-\s]\d{2,4}){1,2})\b)/i;

module.exports = { COMPLETION_ACCESS_CODE_RE };
