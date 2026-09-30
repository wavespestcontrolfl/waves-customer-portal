/**
 * SMS Draft Verifier — adversarial fact-check pass for the shadow drafter's
 * convergence loop (brand-voice loop, drafter v3).
 *
 * The single-pass drafter hallucinates ~a third of the time: it invents
 * dates, times, arrival windows, tech names, what-was-found, cadence, and
 * billing events not present in the context (judge verdict 'draft_unsafe').
 * Hardening the drafter prompt (v2) did NOT move that rate — negative
 * instructions lose to the model's drive to give a complete, confident
 * answer. So v3 adds a second, adversarial pass: a verifier whose ONLY job
 * is to catch claims the facts don't support, feeding the violations back to
 * force a rewrite toward deferral. This is the score-then-rewrite
 * convergence loop applied to fact-grounding — a separate check is far more
 * robust than asking the drafter to restrain itself.
 *
 * Pure prompt + parse helpers live here; the loop orchestration
 * (generateGroundedDraft) lives in the drafter so live + backfill share it.
 */
const MODELS = require('../config/models');

function buildVerifierSystemPrompt() {
  return `You are a STRICT, skeptical fact-checker for Waves Pest Control SMS draft replies. Your default stance: a draft is UNSAFE unless every specific detail in it is explicitly grounded. Most drafts you see DO contain a fabrication — your job is to find it, not to give the draft the benefit of the doubt.

You receive the FACTS available to the drafter, the customer's CURRENT MESSAGE, and a DRAFT reply.

Check EVERY concrete detail in the draft, one by one — each:
- pest type or problem ("spiders", "flying bugs", "rats")
- location ("exterior bushes", "kitchen", "attic")
- date, day, time, or arrival window ("tomorrow", "Tuesday", "2 PM", "9–10am")
- technician name, or who is coming / on the way
- specific action or commitment ("we'll pick up the trap", "we'll coordinate X", "we'll be there Wednesday")
- claim about what was found, caught, treated, or inspected
- service cadence/frequency, or a treatment-timing rule
- billing event (a payment, an auto-pay attempt, a charge)

A detail is GROUNDED only if it appears in the FACTS, or in what the customer LITERALLY wrote. It is a VIOLATION if you cannot point to the exact source. Rules:
- DEFAULT TO FLAGGING. If you are not certain a detail is grounded, flag it.
- The customer's message supports ONLY their literal words — never an inference. A message about "spiders" does NOT support "flying bugs"; a message that just gives a name does NOT support a "pickup" request; "the trap" does NOT support "the attic trap".
- Warm acknowledgments, generic brand voice, and offers to confirm/follow up are fine. But a SPECIFIC commitment, date, place, or job detail is a violation unless grounded.
- VALUE MATCHING — match the exact value, not just the category. A date, day, or time is grounded ONLY if that EXACT value is in the FACTS. A date that DIFFERS from the facts — even by one day — is a VIOLATION, never "close enough". Example: FACTS say next service 6/15, draft says "Tuesday June 16" → VIOLATION (wrong date, not the 6/15 on file). Seeing "there is a date in the facts" is NOT enough; the value must match.
- BILLING is high-stakes — any statement about billing status or resolution ("paid in full", "you're all set", "your payment went through", "that charge was an error", "it appears to be a mistake") is a VIOLATION unless that exact status is in BALANCE/FACTS. A reassurance the facts don't confirm is unsafe.
- For every specific date, time, technician name, or commitment in the draft, you must be able to QUOTE the exact FACTS or customer text that supports it. If you can't quote a source, it is a violation.

Respond with ONLY a JSON object, no prose, no code fences. Either:
{"supported": true, "violations": []}
or:
{"supported": false, "violations": ["draft says 'Wednesday' — not in facts or the customer's message", "assumes a 'pickup' the customer never requested", "says 'attic trap' but only 'trap' is grounded"]}`;
}

// `offeredTimes` (PR #5119, GATE_SMS_REAL_ANSWERS only): the drafter's own
// structured declaration of which OPEN TIMES (date, window) pairs the reply
// offers — already checked deterministically against the OPEN TIMES list
// (validateOfferedTimes). What that check CANNOT do without parsing prose
// is bind each declared DATE to the day the customer-visible text names
// ("Wednesday 9-11" written, Tuesday declared), so the mapping rides here
// for the verifier to check like any other fact. Empty/omitted → the prompt
// is byte-identical to before (every gate-off caller and pinned exam).
const OPEN_TIMES_HEADER = 'OPEN TIMES (real, bookable slots, ET'; // buildFactsBlock's section header, verbatim
const REAL_ANSWERS_MARKER = 'FOLLOW-UP SLA RIGHT NOW:'; // stamped into EVERY gate-on facts block, OPEN TIMES or not
function buildVerifierUserPrompt(factsBlock, inboundMessage, draftReply, offeredTimes = []) {
  const declared = Array.isArray(offeredTimes)
    ? offeredTimes.filter((e) => e && typeof e.date === 'string' && typeof e.window === 'string' && e.date && e.window)
    : [];
  // The section is present whenever OPEN TIMES was in play for this draft
  // (real-answers gate on, slots fetched) — INCLUDING when the drafter
  // declared nothing (pre-push audit P1: an empty declaration must still be
  // checked, or a raw undeclared offer that happens to share a booked
  // visit's window text passes the deterministic check AND reaches a
  // verifier that was never told offers need declaring, and then no
  // send-time snapshot exists to recheck it).
  // Every real-answers draft gets the section (pre-push audit P1 on r7):
  // when availability timed out, returned nothing, or had no city, OPEN
  // TIMES is omitted — and that is exactly when the model must offer NO
  // time at all, not even one the customer suggested (the base rules accept
  // a customer's literal words as grounding for a DATE, never as an OFFER).
  const facts = String(factsBlock || '');
  const realAnswersDraft = declared.length > 0 || facts.includes(OPEN_TIMES_HEADER) || facts.includes(REAL_ANSWERS_MARKER);
  const hasOpenTimes = facts.includes(OPEN_TIMES_HEADER);
  const noneLine = hasOpenTimes
    ? '(none — the drafter declares that this draft offers NO new appointment times)'
    : '(none — NO OPEN TIMES were available for this draft, so it must offer NO appointment time at all; a time the customer suggested is a request to confirm later, never an offer)';
  const declaredSection = realAnswersDraft
    ? `

DECLARED OFFERS (the drafter says these are the ONLY new appointment times the draft offers, each copied from OPEN TIMES):
${declared.length ? declared.map((e) => `- ${e.date}: ${e.window}`).join('\n') : noneLine}
Check the mapping: every appointment time the draft OFFERS must name the SAME day and window as one DECLARED OFFER (a draft that writes "Wednesday" for a Tuesday declaration, or offers a time with no declared entry — including ANY offer when the declaration is "none" — is a VIOLATION). A time in the draft that is NOT a declared offer may only restate an already-scheduled visit from UPCOMING SERVICES, on that visit's own day.`
    : '';
  return `FACTS:
${factsBlock}

CUSTOMER'S CURRENT MESSAGE:
"${inboundMessage}"

DRAFT REPLY:
"${draftReply}"${declaredSection}

Fact-check the draft now.`;
}

/**
 * Tolerant parse of the verifier verdict. Fails SAFE: a missing/ambiguous
 * 'supported' or any listed violation resolves to supported=false, so an
 * unclear verdict triggers a revision rather than waving a draft through.
 */
function parseVerifierResponse(text) {
  if (!text || typeof text !== 'string') return null;
  let candidate = text.trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }

  let parsed;
  try { parsed = JSON.parse(candidate); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  const raw = parsed.violations;

  // Did the model flag ANYTHING, in ANY shape? A clean pass is an explicit
  // empty/absent violations. Any content — a non-empty array (even of
  // objects or junk), a non-empty string, or a non-empty object — means it
  // flagged something and must NOT be waved through, whatever 'supported'
  // says. Converged drafts can publish to suggest mode, so an unreadable
  // verdict has to fail safe to a revision.
  const flaggedSomething =
    (Array.isArray(raw) && raw.length > 0) ||
    (typeof raw === 'string' && raw.trim().length > 0) ||
    (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0);

  // Pull human-readable strings out for the revise feedback, coping with
  // strings, {claim|violation|text} objects, and bare arrays.
  let violations = [];
  if (Array.isArray(raw)) {
    violations = raw
      .map((v) => {
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object') return v.claim || v.violation || v.text || '';
        return '';
      })
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim().slice(0, 200));
  } else if (typeof raw === 'string' && raw.trim()) {
    violations = [raw.trim().slice(0, 200)];
  }

  const supported = parsed.supported === true && !flaggedSomething;
  // Flagged something we couldn't extract cleanly — keep a placeholder so the
  // loop still revises rather than passing on an empty (but non-clean) verdict.
  if (!supported && violations.length === 0 && flaggedSomething) {
    violations = ['verifier flagged a violation in an unreadable format'];
  }
  return { supported, violations };
}

function buildReviseAddendum(violations) {
  const list = (violations || []).map((v) => `- ${v}`).join('\n');
  return `Your previous draft was REJECTED by fact-check for asserting details the facts above do NOT support:
${list}

Rewrite the reply now. State ONLY facts present in the context above. For anything you don't have — an exact time, a tech name, what was found, a billing detail — do NOT invent it: acknowledge warmly and say you'll confirm and get right back to them. Respond with the same JSON object format.`;
}

module.exports = {
  // DEEP (fable-5): the verify loop is the safety net behind a mini drafting
  // model, so it gets the deepest reasoner. Callers go through
  // services/llm/deep.js (thinking-strip + refusal fallback to FLAGSHIP).
  VERIFIER_MODEL: MODELS.DEEP,
  buildVerifierSystemPrompt,
  buildVerifierUserPrompt,
  parseVerifierResponse,
  buildReviseAddendum,
};
