'use strict';

// Auto-applied contact corrections — dark behind GATE_CONTACT_CORRECTION.
//
// Owner ruling 2026-08-15: a customer texted a spelling correction to their
// own name and email and the record was still wrong 30+ hours later, with
// every send in between using the bad values. When a customer STATES a
// correction to their own name, email, or address — over inbound SMS or on
// a recorded call — apply it to the customer record automatically instead
// of parking it on a bell nobody may read in time. Hands-off +
// exception-based (repo rule 14): the deterministic green path auto-applies
// with a full audit trail; anything that fails validation is dropped,
// never half-applied.
//
// Hard limits:
//   - Fields: first_name / last_name / email / address_line1 / address_line2
//     / city / state / zip ONLY. NEVER phone — the sender's number is their
//     identity anchor here; a message that could rewrite the phone it
//     arrived from is an account-takeover primitive, not a correction.
//   - Linked customers only. Shared/unknown numbers and unlinked calls are
//     skipped — guessing the record would apply a correction to the wrong
//     person.
//   - A NEW street (address_line1) only applies together with city and zip
//     from the same message — applying a new street onto the old city/zip
//     would fabricate a hybrid address nobody lives at. Typo-level fixes to
//     city/state/zip/unit alone are fine (same property, corrected copy).
//   - The whole batch runs in ONE transaction with the customer row locked:
//     the field updates, their agent_decisions audit rows, and the SAME
//     canonical fan-outs an admin Customer-360 edit runs (name/email/
//     address propagation + primary-property sync) commit together or not
//     at all.
//   - Each applied field writes an agent_decisions audit row (old → new,
//     evidence quote) and the batch rings ONE owner FYI bell.
//
// Fail-soft at the boundary: both call sites (Twilio webhook post-ack, call
// recording processor) run this fire-and-forget; nothing here may throw
// into a webhook or the call pipeline.

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { callAnthropic } = require('./llm/call');

const WORKFLOW = 'contact_correction';

const APPLYABLE_FIELDS = Object.freeze([
  'first_name', 'last_name', 'email',
  'address_line1', 'address_line2', 'city', 'state', 'zip',
]);
const ADDRESS_FIELDS = Object.freeze(['address_line1', 'address_line2', 'city', 'state', 'zip']);

// Cheap prefilter so the LLM only sees SMS that plausibly contain a
// correction — mirrors the hasRescheduleOrAwayIntent pattern (sms-intent.js).
// Also the CALL-side intent requirement: a staged call candidate only
// counts as a correction when the caller's own quoted words carry
// correction language — ordinary calls state identity fields all the time
// (a spouse booking, a different property) and none of that is a mandate
// to rewrite the profile.
const CORRECTION_HINT_RE = /\b(wrong|incorrect|misspell\w*|spell\w*|typo|not my|isn'?t my|fix (?:my|the)|correct(?:ion)?|update (?:my|the)|chang(?:e|ed|ing) (?:my|the)|actually|new (?:address|email))\b[\s\S]{0,80}\b(name|surname|email|e-?mail|address|street|city|state|zip|zipcode|postal ?code|unit|apt|apartment|suite)\b|\b(name|surname|email|e-?mail|address|street|city|state|zip|zipcode|postal ?code|unit|apt|apartment|suite)\b[\s\S]{0,40}\b(wrong|incorrect|misspell\w*|is\b)|\b(?:we|i)(?:'ve| have|'m| am|'re| are)?\s+(?:just\s+)?(?:moved|(?:will|going\s+to|about\s+to|plan(?:s|ning)?\s+to|intend\s+to)\s+move|moving)\b|\bnew (?:e-?mail|email|address)\s*(?:\bis\b|:)|\b(?:name|surname|email|e-?mail|address|street|city|state|zip|zipcode|postal ?code|unit|apt|apartment|suite)\b[\s\S]{0,30}\bshould be\b|\b(?:update|chang\w*)\b[\s\S]{0,25}\b(?:name|surname|email|e-?mail|address)\b[\s\S]{0,10}\bto\b|\b(?:name|surname|email|e-?mail|address|street|city|state|zip|zipcode|postal ?code|unit|apt|apartment|suite)\b[\s\S]{0,20}\b(?:has\s+)?chang\w*\s+to\b|\b(?:my|our|the|your)\s+old\s+(?:e-?mail|email|address|apartment|unit)\b|\bno\s+(?:unit|apt|apartment)\b[\s\S]{0,40}\bold\b|\b(?:remove|drop|delete)\b[\s\S]{0,30}\b(?:unit|apt|apartment|suite)\b|\b(?:unit|apt|apartment|suite)\b[\s\S]{0,30}\b(?:no longer|removed|gone)\b/i;

// Ownership disclaimers are NOT name corrections: "the account is not in my
// name — my name is Jane Smith" is a caller explaining the account belongs
// to someone else, not a mandate to rename its owner. Bare negation near
// "name" satisfies the correction regexes, so this rejects the disclaimer
// shape explicitly — checked on name candidates in BOTH lanes.
const NAME_OWNERSHIP_DISCLAIMER_RE = /\b(?:not|isn'?t|no longer|never|won'?t be)\s+(?:in|under)\s+(?:my|his|her|their|our)\s+name\b|\b(?:account|bill(?:ing)?|policy|service|property|house)\b[^.?!\n]{0,50}\b(?:not|isn'?t)\s+(?:mine\b|my\b)/i;

// Per-candidate intent binding (round-8): the message-level prefilter
// licenses the extraction CALL, not every candidate it returns — one SMS
// can carry a real email correction plus a routinely mentioned address, and
// a FAST-model over-extraction of the routine field must not auto-apply.
// Each candidate's OWN grounded quote must carry correction language AND
// name the field category it would mutate.
// Clause-bound (round-9): correction vocabulary and the field topic must
// co-occur in the SAME clause, at proximity — a quote spanning "my email is
// wrong; use x@example.com. My name is Jane Smith" has correction language
// in the email clause and only an ordinary identity statement in the name
// clause, and must not license a rename. The loose prefilter's bare
// "<field> … is" branch deliberately does NOT count here: "my email is
// jane@x.com" beside an address correction is identification, not a
// mandate. Clauses split on sentence boundaries (dot only when followed by
// whitespace, so emails and street abbreviations survive).
const CW_SRC = '(?:wrong|incorrect|misspell\\w*|spell\\w*|typo|actually|correct\\w*|fix\\w*|updat\\w*|chang\\w*|remov\\w*|drop\\w*|delet\\w*|no\\s+longer|should\\s+be|\\bnot\\b|\\bnew\\b|\\bold\\b)';
const ADDR_TOPIC_SRC = '(?:address|street|city|state|zip(?: ?code)?|zipcode|postal ?code|unit|apt|apartment|suite|lot)';
const CW_RE = new RegExp(CW_SRC, 'gi');
const TOPIC_RES = [
  ['name', /\b(?:name|surname)\b/gi],
  ['email', /\be-?mail\b/gi],
  ['address', new RegExp(`\\b${ADDR_TOPIC_SRC}\\b`, 'gi')],
];
// Nearest-topic pairing (round-11): within a clause, each correction word
// binds to its CLOSEST field-topic word — comma-joined independent clauses
// like "my email is wrong, my name is Jane Smith" leave "wrong" nearer
// "email" than "name", so the name candidate finds no correction word of
// its own. (Splitting on commas instead would break real corrections like
// "my last name is Rivers, not Riverz".)
function clauseBindsCategory(clause, cat, cwRe = CW_RE) {
  const topics = [];
  for (const [tcat, re] of TOPIC_RES) {
    re.lastIndex = 0;
    for (const m of clause.matchAll(re)) topics.push({ pos: m.index, cat: tcat });
  }
  if (!topics.some((t) => t.cat === cat)) return false;
  cwRe.lastIndex = 0;
  for (const m of clause.matchAll(cwRe)) {
    let best = null;
    for (const t of topics) {
      const d = Math.abs(t.pos - m.index);
      if (d <= 60 && (best === null || d < best.d)) best = { d, cat: t.cat };
    }
    if (best && best.cat === cat) return true;
  }
  return false;
}
const CLAUSE_SPLIT_RE = /[;!?\n]+|\.(?=\s|$)/;
function quoteCarriesFieldIntent(field, quote) {
  const cat = field === 'email' ? 'email' : ADDRESS_FIELDS.includes(field) ? 'address' : 'name';
  return normValue(quote).split(CLAUSE_SPLIT_RE).some((cl) =>
    // A stated move IS address-correction language even without the word
    // "address" ("we just moved to 99 Pine Ave").
    (cat === 'address' && MOVE_EVIDENCE_RE.test(cl)) || clauseBindsCategory(cl, cat));
}

// Post-extraction format guards — the model proposes, these dispose.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L}][\p{L}'. -]{0,79}$/u;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const ADDRESS_RE = /^[\p{L}\p{N}][\p{L}\p{N}#'.,/ -]{0,119}$/u;

// Length caps mirror the PERSISTED columns (initial_schema: first/last/city
// varchar(50), email varchar(150), line1 varchar(200), line2 varchar(100))
// — round-16: a syntactically valid value longer than its column used to
// pass validation and then blow up the customer UPDATE, rolling back the
// WHOLE batch into the fail-soft 'error' lane, so a valid sibling
// correction silently never applied. Over-long values are rejected here as
// invalid candidates instead; the rest of the batch survives.
const FIELD_VALIDATORS = {
  first_name: (v) => NAME_RE.test(v) && v.length <= 50,
  last_name: (v) => NAME_RE.test(v) && v.length <= 50,
  email: (v) => EMAIL_RE.test(v) && v.length <= 150,
  address_line1: (v) => ADDRESS_RE.test(v),
  // Empty = explicit clear ("no unit, that was our old apartment") — the
  // only field where an empty replacement is a valid correction.
  address_line2: (v) => v === '' || (ADDRESS_RE.test(v) && v.length <= 100),
  city: (v) => NAME_RE.test(v) && v.length <= 50,
  state: (v) => STATE_RE.test(v),
  zip: (v) => ZIP_RE.test(v),
};

const EXTRACT_SYSTEM = `You extract explicit contact-record corrections from a pest-control company's inbound customer messages.

A correction is the customer STATING that our record of their own name, email, or service address is wrong and giving the right value ("my last name is spelled Rivers, not Riverz", "email is jane@example.com not jan@example.com", "you have my old address — we're at 12 Oak St, Sarasota 34231 now").

NOT corrections (return an empty list):
- Scheduling, billing, service questions, or anything else.
- A customer merely mentioning an address or email in passing (e.g. giving an address to book a NEW quote, or asking us to email something).
- Corrections about ANOTHER person or a different property.
- Phone number changes — never extract phone.

For a MOVE / whole-new-address correction, include every part the message states (street as address_line1, unit as address_line2, city, state, zip). If the customer says a unit/apartment should be removed, return address_line2 with new_value "".

Respond with JSON only:
{"corrections":[{"field":"first_name|last_name|email|address_line1|address_line2|city|state|zip","new_value":"...","quote":"<the customer's words stating it>","confidence":"high|medium|low"}]}
Only include a correction when the message states it explicitly. When unsure, omit it.`;

function normValue(v) {
  return String(v == null ? '' : v).trim();
}

// Comparable phone identity: US numbers arrive in mixed formats
// (+1XXXXXXXXXX, (XXX) XXX-XXXX, bare 10-digit) — the trailing 10 digits
// are the identity.
function tail10(p) {
  return String(p || '').replace(/[^0-9]/g, '').slice(-10);
}

// Token-delimited phrase grounding (round-13, both lanes): the needle must
// appear word-bounded in the haystack — plain substring would let a
// hallucinated "Lee" ground on the word "please".
function tokenBoundedIncludes(haystack, needle) {
  const n = normValue(needle).replace(/\s+/g, ' ');
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, 'iu').test(String(haystack || ''));
}

// Explicit unit-REMOVAL language (round-11): an empty address_line2 is the
// one replacement value with no text to ground, so it needs affirmative
// removal evidence in the message — "my unit is wrong, please fix it" must
// not clear the unit on a model's empty-string guess.
const UNIT_REMOVAL_RE = /\b(?:no|without|remove[ds]?|removing|drop(?:ped)?|delete[ds]?)\s+(?:the\s+|an?\s+|my\s+|that\s+)?(?:unit|apt|apartment|suite)\b|\b(?:unit|apt|apartment|suite)\b[^.?!\n]{0,40}\b(?:removed?|gone|no longer|doesn'?t (?:exist|apply))\b|\b(?:was|were)\s+(?:our|my|the)\s+old\s+(?:apartment|unit)\b|\bold\s+(?:apartment|unit)\b/i;

// Value/intent CO-LOCATION with the correcting statement (round-16):
// message-wide value grounding let a grounded "my email is wrong; please
// fix it" quote pair with contact data stated elsewhere for someone ELSE
// ("send the receipt to my accountant at bookkeeper@example.com") — both
// halves genuinely appear in the message, but the replacement was never
// part of the correcting statement. Evaluated over the MESSAGE's clause
// sequence, anchored at the quote: intent clauses are the quote's own
// clauses that bind the field category; the value must sit in an intent
// clause itself, or in a clause IMMEDIATELY ADJACENT to one that is about
// the value — naming the field topic ("Email is jane@example.com") or
// consisting of essentially nothing but the value ("It is
// jane@example.com", "Use jane@example.com"). An adjacent clause with its
// own unrelated business ("Send the receipt to my accountant at …") never
// donates its value, and a clause further away never qualifies at all — a
// model widening its quote across statements gains nothing, because intent
// stays confined to clauses that actually carry correction language. A
// quote with NO intent clause (a licensed address fragment like "zip is
// 34231") is itself the value statement and must contain the value.
function valueCoLocated(field, quote, value, text) {
  const v = normValue(value);
  if (v === '') return true; // explicit clear — removal-language-gated separately
  const cat = field === 'email' ? 'email' : ADDRESS_FIELDS.includes(field) ? 'address' : 'name';
  const nq = normValue(quote).replace(/\s+/g, ' ').trim().toLowerCase();
  const clauses = normValue(text).split(CLAUSE_SPLIT_RE)
    .map((cl) => cl.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!nq || !clauses.length) return false;
  // A body clause belongs to the quote when either contains the other —
  // covers a fragment quote inside one clause and a quote spanning several.
  const inQuote = clauses.map((cl) => {
    const lc = cl.toLowerCase();
    return lc.includes(nq) || nq.includes(lc);
  });
  const isIntent = clauses.map((cl, i) => inQuote[i]
    && (clauseBindsCategory(cl, cat) || (cat === 'address' && MOVE_EVIDENCE_RE.test(cl))));
  if (!isIntent.some(Boolean)) return tokenBoundedIncludes(quote, v);
  const topicRe = TOPIC_RES.find(([c]) => c === cat)[1];
  for (let j = 0; j < clauses.length; j += 1) {
    if (!tokenBoundedIncludes(clauses[j], v)) continue;
    if (isIntent[j]) return true;
    const adjacent = (j > 0 && isIntent[j - 1]) || (j + 1 < clauses.length && isIntent[j + 1]);
    if (!adjacent) continue;
    topicRe.lastIndex = 0;
    if (topicRe.test(clauses[j])) return true;
    if (clauses[j].length - v.length <= 20) return true;
  }
  return false;
}

// PII-safe error tag for warn logs: database errors can embed the very
// contact values being written (e.g. a unique address_key collision quotes
// the street) — never log err.message from this lane.
function errTag(err) {
  return (err && (err.code || err.name)) || 'error';
}

// Canonical per-field normalization — the SAME normalizer every intake path
// uses (utils/intake-normalize CONTACT_FIELD_NORMALIZERS): proper-cased
// names/cities (Mc/O' preserved, so case-only corrections still register),
// canonical street shapes, uppercase state, lowercased email, zip cleanup.
const { normalizeContactRecord } = require('../utils/intake-normalize');
function canonicalizeValue(field, value) {
  const out = normalizeContactRecord({ [field]: value });
  return out[field] !== undefined && out[field] !== null ? String(out[field]) : String(value);
}

// Field-aware equality: email is case-insensitive (case never matters for
// delivery), but names/addresses are display text — "Mcdonald" → "McDonald"
// is a real correction and must not read as unchanged.
function sameValue(field, a, b) {
  const na = normValue(a);
  const nb = normValue(b);
  return field === 'email' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Fast, no-IO check used by the webhook to decide whether to bother. */
function detectContactCorrectionIntent(body) {
  return CORRECTION_HINT_RE.test(String(body || ''));
}

/**
 * LLM extraction for an inbound SMS. Returns [{field, newValue, quote}] —
 * high-confidence, format-valid corrections only — or NULL when the
 * provider call itself failed (unavailable, malformed output): the
 * durable queue retries only a distinguishable extraction failure, and
 * collapsing it into "no corrections" would permanently drop an explicit
 * customer correction on a transient LLM outage (codex #3413 r19).
 * Never throws.
 */
async function extractSmsContactCorrections({ body }) {
  try {
    const text = normValue(body);
    if (!text || !detectContactCorrectionIntent(text)) return [];
    // A sender disclaiming the linked customer's IDENTITY invalidates the
    // sender-to-customer binding for the whole message (codex #3413 r44):
    // "I'm not John anymore — my email is …" is the number's NEW holder,
    // and none of their corrections belong on the former owner's record.
    // The name form requires a capitalized token so "I'm not sure …"
    // stays harmless.
    if (WRONG_PERSON_RE.test(String(body || '').replace(/[\u2018\u2019]/g, "'"))) return [];
    const res = await callAnthropic({
      model: MODELS.FAST,
      system: EXTRACT_SYSTEM,
      text: `Inbound customer SMS:\n"""${text.slice(0, 1500)}"""`,
      jsonMode: true,
      maxTokens: 500,
      // Deadline WELL below the queue's 10-minute worker lease (codex
      // #3413 r31): with a timeoutMs budget the SDK makes a single bounded
      // attempt, so a stalled provider can never outlive the lease and
      // trigger a duplicate paid extraction via stale-lock recovery. A
      // timeout surfaces as ok:false → null → the queue's own retry.
      timeoutMs: 120_000,
    });
    if (!res?.ok || !Array.isArray(res.json?.corrections)) {
      logger.warn('[contact-correction] sms extraction provider failure (retryable)');
      return null;
    }
    const list = res.json.corrections;
    // Evidence check: the quote must actually appear in the customer's
    // message (whitespace/case-normalized). A model output with an omitted
    // or fabricated quote is not transcript-backed and never applies —
    // hallucinated "corrections" die here, not in prod data.
    const haystack = text.replace(/\s+/g, ' ').toLowerCase();
    const quoteInBody = (q) => {
      const needle = normValue(q).replace(/\s+/g, ' ').toLowerCase();
      return needle.length >= 4 && haystack.includes(needle);
    };
    // The REPLACEMENT value must be grounded too (round-10): "my email is
    // wrong, please fix it" is a genuine quote, but a model that invents
    // the new value alongside it would sail through quote grounding — a
    // value the customer never typed never applies. Token-delimited
    // (round-13): "Lee" must not ground on "please". CO-LOCATED with the
    // correction evidence inside the candidate's own quote (round-16) —
    // message-wide grounding let a real correction quote pair with contact
    // data the customer stated about someone else later in the message.
    // Empty = explicit clear, which carries no text by definition
    // (removal-language-gated below).
    const valueEvidenceOk = (c) => valueCoLocated(c.field, c.quote, c.new_value, text);
    // An empty address_line2 (explicit unit clear) has no value text to
    // ground — require affirmative removal language in the message instead
    // (round-11).
    const clearEvidenceOk = (c) => !(c.field === 'address_line2' && normValue(c.new_value) === '')
      || UNIT_REMOVAL_RE.test(text);
    const base = list.filter((c) => c && c.confidence === 'high' && APPLYABLE_FIELDS.includes(c.field)
      && quoteInBody(c.quote) && valueEvidenceOk(c) && clearEvidenceOk(c)
      // A third party's contact info is never the customer's correction,
      // no matter how much correction vocabulary surrounds it (r21
      // addresses; r22 email/name; r24 judged against the CONTAINING
      // source clause so a narrowed quote can't shed the possessive; r28
      // against EVERY occurrence of the quote, since co-location may
      // ground the value at any of them).
      && !sourceClausesFor(text, c.quote).some((p) => thirdPartyOwnedStatement(c.field, p))
      // A purpose-scoped address (billing/mailing/invoice/delivery) never
      // rewrites the SERVICE address (r41).
      && !(ADDRESS_FIELDS.includes(c.field)
        && sourceClausesFor(text, c.quote).some((p) => PURPOSE_ADDRESS_RE.test(p)))
      // A value marked OLD with no replacement direction is the value
      // being retired, not the correction (r41).
      && !(OLD_VALUE_RE.test(String(c.quote || ''))
        && (!REPLACEMENT_DIRECTION_RE.test(String(c.quote || ''))
          || NEGATED_DIRECTION_RE.test(String(c.quote || ''))))
      // A directly negated value never applies (r47).
      && !valueNegatedInQuote(c.quote, c.new_value)
      // A future-effective or CONDITION-scoped change waits for
      // present-tense confirmation (r48/r50).
      && !sourceClausesFor(text, c.quote).some((p) => FUTURE_CHANGE_RE.test(p)
        || CONDITIONAL_CHANGE_RE.test(p)));
    // Each candidate's own quote must carry correction intent bound to its
    // field category — the message-level prefilter is not per-field
    // evidence (see quoteCarriesFieldIntent). ADDRESS fields are one
    // statement spread across fragments ("we moved to 99 Pine Ave" +
    // "zip is 34231"), so the group is licensed as a unit: stated move
    // evidence or ANY address-bound correction quote licenses all address
    // candidates — a routine address mention beside an email correction
    // has neither and every address candidate drops. The license scans only
    // candidates that ALREADY passed confidence/allowlist/grounding
    // (round-9): a fabricated or low-confidence address entry in the raw
    // model output must not license the group it failed to join.
    // Statement scoping (round-14): a licensed address correction only
    // covers fragments of ITS OWN sentence — "my city is wrong; it should
    // be Sarasota" must not license a rental address mentioned in the next
    // sentence.
    const sentences = text.split(CLAUSE_SPLIT_RE)
      .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
    const sentenceIdxOf = (q) => {
      const needle = normValue(q).replace(/\s+/g, ' ').toLowerCase();
      return needle ? sentences.findIndex((s) => s.includes(needle)) : -1;
    };
    // MOVE licensing is scoped to the move STATEMENT, not the message
    // (codex #3413 r19): "We moved to Sarasota. Please service my tenant's
    // rental at 99 Pine Ave …" must not let the rental replace the
    // customer's primary address. A move licenses (a) address fragments in
    // the move sentence itself and (b) an IMMEDIATELY adjacent sentence
    // that is essentially nothing but the address — the natural "We moved.
    // New address is 12 Oak St, Sarasota 34299." split — measured by
    // stripping the staged address values and requiring only trivial
    // residue, so a sentence carrying its own business ("service my
    // tenant's rental at …") never rides the move license.
    const moveIdxs = new Set(sentences.map((s, i) => (MOVE_EVIDENCE_RE.test(s) ? i : -1)).filter((i) => i >= 0));
    const addressValueTexts = base
      .filter((c) => ADDRESS_FIELDS.includes(c.field))
      .map((c) => normValue(c.new_value).replace(/\s+/g, ' ').toLowerCase())
      .filter((v) => v.length >= 2);
    // After stripping the staged address values, EVERY residual token must
    // come from a closed address-introduction vocabulary — a length
    // threshold let short ownership/purpose labels through ("Rental: 99
    // Pine Ave …" leaves just "rental"), and a labeled property is exactly
    // the adjacent sentence that must NOT ride the move license
    // (codex #3413 r20).
    const essentiallyAddress = (s) => {
      let residue = s;
      for (const v of addressValueTexts) residue = residue.split(v).join(' ');
      const tokens = residue.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
      return tokens.every((t) => MOVE_INTRO_TOKENS.has(t));
    };
    const moveLicensedFor = (c) => {
      if (!moveIdxs.size) return false;
      const idx = sentenceIdxOf(c.quote);
      if (idx < 0) return false;
      if (moveIdxs.has(idx)) return true;
      return [...moveIdxs].some((m) => Math.abs(m - idx) === 1) && essentiallyAddress(sentences[idx]);
    };
    const licensedSentences = new Set();
    for (const c of base) {
      if (ADDRESS_FIELDS.includes(c.field) && quoteCarriesFieldIntent(c.field, c.quote)) {
        const idx = sentenceIdxOf(c.quote);
        if (idx >= 0) licensedSentences.add(idx);
      }
    }
    const addressLicensed = (c) => {
      if (moveLicensedFor(c)) return true;
      if (quoteCarriesFieldIntent(c.field, c.quote)) return true;
      const idx = sentenceIdxOf(c.quote);
      return idx >= 0 && licensedSentences.has(idx);
    };
    // A RETRACTION clause ("sorry actually use final@example.com") carries
    // no field topic of its own — it supersedes a same-field correction
    // stated moments earlier. It is licensed ONLY when (a) another
    // candidate of the SAME field carries explicit intent and (b) its own
    // quote carries retraction vocabulary — a bare same-field mention
    // ("for receipts, send to billing@vendor.com") licenses nothing
    // (codex #3413 r38; the r16 co-location attack stays closed).
    const RETRACTION_RE = /\b(?:actually|sorry|instead|i meant|make that|scratch that|correction|rather|no wait|oops)\b/i;
    // …and the clause must REFER BACK to the correction (codex #3413
    // r39): after stripping the replacement value, every residual token
    // must come from a closed retraction/connective vocabulary — a
    // discourse marker fronting unrelated business ("Actually, send the
    // receipt to billing@vendor…") licenses nothing.
    const RETRACTION_TOKENS = new Set([
      'actually', 'sorry', 'instead', 'i', 'meant', 'make', 'that', 'scratch',
      'correction', 'rather', 'no', 'wait', 'oops', 'use', 'it', 'its', 'is',
      'should', 'be', 'please', 'my', 'the', 'not', 'to', 'change', 'um', 'er',
    ]);
    const retractionLicensed = (c, arr) => {
      const q = String(c.quote || '').toLowerCase();
      if (!RETRACTION_RE.test(q)) return false;
      if (!arr.some((o) => o !== c && o.field === c.field && quoteCarriesFieldIntent(o.field, o.quote))) return false;
      const v = normValue(c.new_value).toLowerCase();
      const residue = (v ? q.split(v).join(' ') : q)
        .replace(/[^a-z0-9']+/g, ' ').trim();
      return residue.split(/\s+/).filter(Boolean).every((t) => RETRACTION_TOKENS.has(t));
    };
    return base
      .filter((c, _i, arr) => (ADDRESS_FIELDS.includes(c.field)
        ? addressLicensed(c)
        : (quoteCarriesFieldIntent(c.field, c.quote) || retractionLicensed(c, arr))))
      // Component binding for name fields, same rule as the call lane: a
      // grounded quote naming only the LAST name ("my last name is Rivers,
      // not Riverz") is not evidence for a first_name entry the model
      // returned alongside it — the quote must bind to the component it
      // would mutate. Ownership disclaimers never count as name evidence.
      .filter((c) => !(c.field === 'first_name' || c.field === 'last_name')
        || (quoteBindsNameField(c.field, c.quote)
          // The disclaimer is checked against the CONTAINING source
          // probes, not just the model-selected fragment (codex #3413
          // r34): "The account isn't mine. You have my name wrong; …"
          // can quote only the second sentence — the probes carry the
          // preceding disclaimer. Negated-name statements (r46) ride the
          // same probes.
          && !sourceClausesFor(text, c.quote).some((p) => NAME_OWNERSHIP_DISCLAIMER_RE.test(p)
            || NEGATED_NAME_RE.test(p))))
      // (round-14) An UNQUALIFIED whole-name quote ("you have my name
      // wrong; it is Jane Smith") corrects BOTH components — a model that
      // emits only first_name would graft Jane onto the record's old
      // surname. Single-component candidates survive only under explicitly
      // first-/last-scoped quotes.
      .filter((c, _i, arr) => {
        if (c.field !== 'first_name' && c.field !== 'last_name') return true;
        const q = String(c.quote || '');
        if (/\bfirst name\b/i.test(q) || /\b(?:last name|surname)\b/i.test(q)) return true;
        const other = c.field === 'first_name' ? 'last_name' : 'first_name';
        return arr.some((o) => o.field === other);
      })
      .map((c) => ({
        field: c.field,
        newValue: normValue(c.new_value),
        quote: normValue(c.quote),
        // Whether THIS candidate rode the move license (codex #3413 r24):
        // the apply path's moveContext (unit clearing + full-group
        // requirement) must key on the corrected address statement, not on
        // a move phrase anywhere in the SMS — "I moved to Sarasota last
        // year. You have my street misspelled; it is …" is a spelling fix
        // whose unit must survive.
        ...(ADDRESS_FIELDS.includes(c.field) && moveLicensedFor(c) ? { moveLicensed: true } : {}),
      }));
  } catch (err) {
    logger.warn(`[contact-correction] sms extraction failed: ${errTag(err)}`);
    return null;
  }
}

// A new STREET without the city+zip it belongs to would graft the new
// street onto the old locality — reject the whole address group instead.
function addressGroupComplete(byField) {
  if (!byField.has('address_line1')) return true;
  return byField.has('city') && byField.has('zip');
}

// Move evidence in the MESSAGE (not just the extracted fields): "we moved to
// Tampa, ZIP 33602" can extract as city+zip alone, which the street-anchored
// group check above would wave through — replacing the locality under the
// OLD street fabricates a hybrid address exactly like a street without its
// locality would. When the message says the customer MOVED, the whole
// street+city+zip group is required or every address field is rejected.
// Destination language required (round-10): bare "I/we moved" also covers
// "I moved the traps" — only a move WITH a destination ("moved to/into",
// "are moving to", "new address") is residential-move evidence that may
// license an address group.
// The bare "new address" alternative requires customer ownership
// (codex #3413 r21): sentence-start or a first-person/definite determiner
// DIRECTLY before it — "my accountant's new address" has a third-party
// possessive in between and licenses nothing.
const MOVE_EVIDENCE_RE = /\b(?:we|i)(?:'ve| have|'m| am|'re| are)?\s+(?:just\s+|recently\s+)?(?:moved|will\s+move|going\s+to\s+move|about\s+to\s+move|plan(?:s|ning)?\s+to\s+move|intend\s+to\s+move|(?:are|will be)\s+moving)\s+(?:to|into)\b|\b(?:i|we)\b[^.;!?\n]{0,30}\bmoving\s+(?:to|into)\b|(?:^|[.!?;\n]\s*|\b(?:my|our|the)\s+)new\s+address\b/i;
// The only words allowed to introduce a move's adjacent address fragment
// (codex #3413 r20): pure connective/address-introduction vocabulary. Any
// other residual token — "rental", "tenant", "service" — marks the
// sentence as being about something else and it never rides the move
// license.
// Third-party address possession (codex #3413 r21): "mail the invoice to
// my accountant's new address …" carries the address topic AND the "new"
// correction word, so the field-intent path would license it — but the
// address belongs to a third party, not the customer. His/her/their, an
// apostrophe-possessive noun, or a bare plural noun directly before
// "new address" (transcribed possessives drop the apostrophe) all mark
// the statement third-party; "previous/prior address" stays first-person.
// Every supported address topic, not just the literal word "address"
// (codex #3413 r26): "My tenant's city is wrong" and "My accountant's
// ZIP is wrong" are third-party statements too.
const TP_ADDR_TOPIC_SRC = "(?:address|street|city|state|zip(?: ?code)?|zipcode|postal ?code|unit|apt|apartment|suite)";
// Unicode-aware owner/modifier classes (codex #3413 r28): "My fiancé's
// email" is a third-party statement too — ASCII [a-z]/\w missed accented
// owners entirely.
// Words that can precede a verb WITHOUT naming a third-party subject
// (r41): first person, auxiliaries, adverbs, and household terms. Shared
// by the named-subject guards so "we have just moved to" and "I'm going
// to move" stay first-person while "John moved to" rejects.
const TP_NON_SUBJECT_SRC = "(?:i|we|m|re|s|ve|ll|d|am|is|are|was|were|will|be|been|being|has|have|had|do|does|did|going|about|to|just|recently|finally|officially|now|currently|also|and|all|both|plans?|planning|wants?|intends?|hopes?|family|household|everyone|everybody)";
const TP_OWNER_SRC = "[\\p{L}\\p{M}]+";
const TP_MODIFIER_SRC = "(?:[\\p{L}\\p{M}\\p{N}]+\\s+){0,3}";
// Inverse ownership forms (codex #3413 r29): "the email FOR my accountant"
// and "my accountant HAS a new email" name the owner after/around the
// topic instead of possessively before it. Self-referential and
// document-ish owners are excluded so "the email for me / the account /
// the invoice" stays first-person.
const TP_SELF_OWNERS = '(?:me|myself|mine|us|ours|account|file|record|records|invoice|invoices|receipt|receipts|statement|statements|service|billing|booking|appointment)';
// The determiner is consumed as a separate group and the owner class
// EXCLUDES bare determiners (codex #3413 r30): with only an optional
// determiner, "for my account" backtracked to owner='my' and the
// self-owner lookahead never saw the excluded word — silently discarding
// the customer's own correction.
const TP_NOT_OWNER = `(?:my|our|the|${TP_SELF_OWNERS.slice(3, -1)})`;
const tpOwnerAfter = `(?:(?:my|our|the)\\s+)?(?!${TP_NOT_OWNER}\\b)${TP_OWNER_SRC}\\b`;
const tpInverseForms = (topicSrc) => (
  // Optional copula (r32): "the email IS for my accountant".
  `|\\b${topicSrc}\\s+(?:(?:is|was|are|were)\\s+)?(?:for|of)\\s+${tpOwnerAfter}`
  // The has-subject takes the same determiner-safe self-owner exclusion
  // (r31): "My account has the wrong email" is the customer's own.
  + `|\\b(?:(?:my|our|the)\\s+)?(?!(?:i|we|${TP_NOT_OWNER.slice(3, -1)})\\b)${TP_OWNER_SRC}\\s+has\\s+${TP_MODIFIER_SRC}${topicSrc}\\b`
  // "The email belongs to my accountant …" (r30): explicit ownership
  // stated after the topic, within the same clause.
  + `|\\b${topicSrc}\\b[^.;!?\\n]{0,40}\\bbelongs?\\s+to\\s+${tpOwnerAfter}`
);
const THIRD_PARTY_ADDRESS_RE = new RegExp(
  `\\b(?:his|her|their)\\s+${TP_MODIFIER_SRC}${TP_ADDR_TOPIC_SRC}\\b`
  + `|\\b(?!(?:previous|prior)\\b)${TP_OWNER_SRC}(?:'s|s')\\s+${TP_MODIFIER_SRC}${TP_ADDR_TOPIC_SRC}\\b`
  + `|\\b(?!(?:previous|prior|business)\\b)[\\p{L}\\p{M}]{4,}s\\s+new\\s+address\\b`
  // ANY non-first-person subject before an auxiliary + move verb is
  // third-party (r40): "John is moving to …" names the mover, and the
  // named mover is not the customer. First-person forms and household
  // continuations stay licensed.
  + `|(?<![\\p{L}\\p{M}'])(?!${TP_NON_SUBJECT_SRC}\\b)[\\p{L}\\p{M}][\\p{L}\\p{M}']*\\s+(?:(?:is|are|was|were|will|has|have|had|plans?|planning|wants?|intends?|hopes?|going|about)\\s+(?:to\\s+)?){0,3}mov(?:e|ing|ed|es)\\s+(?:to|into)\\b`
  // Third-party MOVE subject (r35, past tense r36): "My tenant is moving
  // to / moved to 99 Pine Ave" — a possessed subject moving is not the
  // customer moving. Self-ish household subjects stay licensed.
  + `|\\b(?:my|our|the|his|her|their)\\s+(?!(?:new|old|own|current|next|family|household|whole)\\b)${TP_OWNER_SRC}\\s+(?:(?:is|are|was|were|will|will\\s+be|has|have|had|just|recently|going\\s+to|about\\s+to|plans?\\s+to|planning\\s+to|wants?\\s+to|intends?\\s+to|hopes?\\s+to)\\s+){0,3}mov(?:e|ing|ed|es)\\s+(?:to|into)\\b`
  + tpInverseForms(TP_ADDR_TOPIC_SRC),
  'iu',
);
// Same ownership doctrine for email and name (codex #3413 r22): "my
// accountant's email is wrong; change it to …" is grounded, co-located,
// and field-intent-bearing — but the mailbox belongs to a third party,
// and auto-replacing the CUSTOMER's email (plus its fan-out) with it is
// the exact poisoning the lane exists to prevent. Spouse/child name
// statements likewise never rename the account holder.
const THIRD_PARTY_CONTACT_RE = new RegExp(
  `\\b(?:his|her|their)\\s+${TP_MODIFIER_SRC}(?:e-?mail|name|surname)\\b`
  + `|\\b(?!(?:previous|prior)\\b)${TP_OWNER_SRC}(?:'s|s')\\s+${TP_MODIFIER_SRC}(?:e-?mail|name|surname)\\b`
  // Named subject performing a contact CHANGE (r41): "Jane changed to a
  // new email: …" names the changer, and the changer is not the
  // customer. First-person and auxiliary-led forms stay licensed.
  + `|(?<![\\p{L}\\p{M}'])(?!${TP_NON_SUBJECT_SRC}\\b)[\\p{L}\\p{M}][\\p{L}\\p{M}']*\\s+(?:(?:has|have|had|is|are|was|were|will|just|recently)\\s+){0,2}(?:chang\\w*|switch\\w*|updat\\w*|got|created)\\s+(?:to\\s+)?(?:[\\p{L}\\p{M}\\p{N}]+\\s+){0,3}(?:e-?mail|name|surname)\\b`
  + tpInverseForms('(?:e-?mail|name|surname)'),
  'iu',
);

// Purpose-scoped address statements (r41): a billing/mailing/invoice/
// delivery address is not the SERVICE address this lane maintains —
// "The new address for invoices is …" must never rewrite the property
// the techs route to.
const PURPOSE_ADDRESS_RE = /\b(?:address|street)\b[^.;!?\n]{0,30}\b(?:for|on|of|in)\s+(?:the\s+|my\s+|our\s+)?(?:invoices?|invoicing|billing|bills?|receipts?|mail(?:ing)?|delivery|deliveries|shipping|correspondence|statements?|paperwork|payments?)\b|\b(?:invoices?|invoicing|billing|bills?|receipts?|correspondence|statements?|paperwork|payments?)\b[^.;!?\n]{0,30}\b(?:to|at)\s+(?:this\s+|the\s+|my\s+|our\s+|a\s+)?(?:new\s+)?address\b|\baddress\b[^.;!?\n]{0,30}\b(?:to\s+)?(?:send|mail|forward|deliver|use)\b[^.;!?\n]{0,20}\b(?:invoices?|invoicing|billing|bills?|receipts?|statements?|correspondence|paperwork|payments?)\b|\b(?:billing|mailing|shipping|delivery|invoice|correspondence|postal)\s+address\b/i;

// A value marked as OLD contact data with no replacement direction is the
// value being RETIRED, not the correction (r41): "for reference, my old
// email is old@example.com" must never overwrite the current mailbox.
const OLD_VALUE_RE = /\b(?:old|former|previous|prior)\s+(?:[\p{L}\p{M}\p{N}]+\s+){0,2}(?:e-?mail|name|surname|address|street|city|state|zip|zipcode|number)\b/iu;
// A value the customer NEGATES is not the correction (r47): "my email
// is not jane@example.com" states the wrong value — writing it would
// commit exactly what was rejected. The negator must sit DIRECTLY
// before the value in the quote.
function valueNegatedInQuote(quote, value) {
  const q = String(quote || '').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').toLowerCase();
  const v = String(value || '').replace(/\s+/g, ' ').toLowerCase();
  if (!v) return false;
  let from = 0;
  while (true) {
    const i = q.indexOf(v, from);
    if (i < 0) return false;
    const before = q.slice(Math.max(0, i - 34), i);
    // Up to two intervening adverbs/modifiers (r48): "not actually jane@…".
    if (/(?:\bis\s+not|\bisn'?t|\bnot|\bnever|\bwas)\s+(?:[a-z]+\s+){0,2}$/.test(before)) return true;
    from = i + 1;
  }
}

// A FUTURE-effective change is not a present correction (r48):
// "Starting next month, my email will change to …" must wait for the
// customer's present-tense confirmation, not switch fan-outs weeks
// early.
const FUTURE_CHANGE_RE = /\b(?:starting|beginning|effective|as\s+of)\s+(?:on\s+|in\s+|from\s+)?(?:next|this\s+coming|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d)|\bwill\s+(?:change|be\s+changing|switch)\s+to\b|\b(?:will\s+move|will\s+be\s+moving|going\s+to\s+move|about\s+to\s+move|plan(?:s|ning)?\s+to\s+move|intend\s+to\s+move)\s+(?:to|into)\b|(?:\b(?:am|are|is)|['’](?:m|re))\s+moving\s+(?:to|into)\b[^.;!?\n]{0,80}(?:next\s+(?:week(?:end)?|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|this\s+(?:coming\s+)?(?:week(?:end)?|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+(?:a|an|two|three|four|five|six|seven|eight|nine|ten|a\s+couple(?:\s+of)?|a\s+few|\d+)\s+(?:day|week|month|year)s?\b|on\s+(?:the\s+\d{1,2}(?:st|nd|rd|th)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|(?:later|at\s+the\s+end\s+of)\s+(?:the\s+|this\s+)?(?:week|month|year)|\d{1,2}\/\d{1,2})|(?:next\s+(?:week(?:end)?|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|this\s+(?:coming\s+)?(?:week(?:end)?|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+(?:a|an|two|three|four|five|six|seven|eight|nine|ten|a\s+couple(?:\s+of)?|a\s+few|\d+)\s+(?:day|week|month|year)s?\b|on\s+(?:the\s+\d{1,2}(?:st|nd|rd|th)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|(?:later|at\s+the\s+end\s+of)\s+(?:the\s+|this\s+)?(?:week|month|year)|\d{1,2}\/\d{1,2})[^.;!?\n]{0,60}(?:\b(?:am|are|is)|['’](?:m|re))\s+moving\s+(?:to|into)\b|\bnext\s+(?:week|month|year)\b[^.;!?\n]{0,40}\bchang/i;

// A CONDITION-scoped change is not a present correction (r50): "if I
// accept the offer, my new email is …" must not switch anything before
// the condition occurs. The conditional token must lead into a
// subject/determiner so polite framings ("when you get a chance, fix my
// email") stay licensed.
const CONDITIONAL_CHANGE_RE = /\b(?:if|unless|in\s+case|assuming|once|should)\s+(?:i|we|they|he|she|it|the|my|that|things?|everything)\b|\b(?:if|unless|in\s+case|assuming|once)\s+[\p{L}][^,;.!?\n]{0,40}(?:,|\bthen\b)|\b(?:if|unless|once|assuming)\s+(?:it\s+is\s+|it'?s\s+|all\s+is\s+|everything\s+is\s+)?(?:approved|accepted|confirmed|completed|finali[sz]ed|done|signed|processed|paid|settled|closed|granted)\b/iu;

// A NEGATED name statement is not a correction (r46): "my name is not
// Jane Smith anymore" states the OLD name — staging its components would
// rename the customer to the very value being rejected.
const NEGATED_NAME_RE = /\b(?:name|surname)\s+(?:is\s+not|isn'?t|was|used\s+to\s+be)\b|\bnot\s+my\s+name\b|\b(?:name|surname)\b[^.;!?\n]{0,40}\banymore\b/i;

// Sender identity disclaimers (r44): the texter says they are NOT the
// person this number links to — every correction in the message belongs
// to the number's new holder, not the linked customer. The bare "I'm not
// <Name>" form requires a CAPITALIZED name token, so "I'm not sure" and
// "I am not happy" never trip it.
const WRONG_PERSON_RE = /\b(?:I'?m\s+not|I\s+am\s+not|[Tt]his\s+is\s+not|[Tt]his\s+isn'?t|[Ii]t\s+is\s+not|[Ii]t\s+isn'?t|[Nn]o\s+longer)\s+(?:[A-Z][a-z]+|[A-Z]{2,})\b|\bwrong\s+person\b|\bnew\s+(?:owner|holder)\s+of\s+this\s+(?:number|phone)\b|\b(?:just\s+)?got\s+this\s+(?:number|phone)\b|\bthis\s+(?:number|phone)\s+used\s+to\s+belong\b|\bno\s+longer\s+(?:his|her|their)\s+(?:number|phone)\b|\b(?:[A-Z][a-z]+|[A-Z]{2,})\s+(?:no\s+longer\s+(?:has|uses)|doesn'?t\s+(?:have|use)|does\s+not\s+(?:have|use)|used\s+to\s+have|stopped\s+using)\s+this\s+(?:number|phone)(?:\s+anymore)?\b/;

// Negated direction verbs never count as replacement direction (r42):
// "do not use my old email …" is a retirement, not a correction.
const NEGATED_DIRECTION_RE = /\b(?:do\s+not|don'?t|no\s+longer|stop|never|cannot|can'?t|won'?t|must\s+not|mustn'?t|should\s+not|shouldn'?t|may\s+not|will\s+not)\b[^.;!?\n]{0,25}\b(?:us(?:e|ing)|send|reply|email|contact|write)\b/i;
const REPLACEMENT_DIRECTION_RE = /\b(?:wrong|incorrect|misspell\w*|should\s+be|is\s+now|now\s+is|use|chang\w*\s+(?:it\s+)?to|updat\w*\s+(?:it\s+)?to|instead|new|correct)\b/i;

// Ownership is judged against the SOURCE CLAUSE containing the quote, not
// the extractor-controlled fragment (codex #3413 r24): a model can narrow
// its quote to "email is wrong; change it to …", dropping the "My
// accountant's" prefix that marks the statement third-party — grounding
// accepts any substring, so the containing clause span of the original
// text is the authority. Falls back to the quote itself when it cannot be
// located (grounding rejects unlocatable quotes anyway).
function sourceClausesFor(text, quote) {
  // Typographic apostrophes normalize to ASCII (codex #3413 r25): the
  // ownership predicates match 's-possessives, and "My wife’s email" with
  // a curly quote must not slip past them.
  const deQuote = (s) => String(s).replace(/[‘’]/g, "'");
  const hay = deQuote(normValue(text).replace(/\s+/g, ' ').toLowerCase());
  const nq = deQuote(normValue(quote).replace(/\s+/g, ' ').toLowerCase());
  // EVERY occurrence of the quote yields a probe (codex #3413 r28): a
  // short quote like "email is wrong" can appear in both a first-person
  // sentence and a third-party one, and value co-location may ground at
  // the later occurrence — ownership must hold at all of them, since the
  // extractor's fragment doesn't say which statement it came from.
  // Each probe includes the immediately PRECEDING clause too (r27): the
  // possessive antecedent may live one sentence earlier. A clause about
  // unrelated business can only make a probe MORE conservative.
  const probes = [];
  let from = 0;
  while (nq) {
    const qs = hay.indexOf(nq, from);
    if (qs < 0) break;
    const qe = qs + nq.length;
    const delims = /[;!?\n]|\.(?=\s|$)/g;
    let prevLeft = 0;
    let left = 0;
    let right = hay.length;
    let nextRight = hay.length;
    let m;
    while ((m = delims.exec(hay))) {
      if (m.index < qs) { prevLeft = left; left = m.index + 1; }
      if (m.index >= qe) {
        if (right === hay.length) { right = m.index; } else { nextRight = m.index; break; }
      }
    }
    // The probe spans preceding AND following clauses (r27/r35): the
    // possessive can trail the correction too — "The email is wrong; use
    // …. That's my accountant's email."
    probes.push(hay.slice(prevLeft, right === hay.length ? right : nextRight));
    from = qs + 1;
  }
  if (!probes.length) probes.push(deQuote(String(quote || '').toLowerCase()));
  return probes;
}

function thirdPartyOwnedStatement(field, sourceClause) {
  if (ADDRESS_FIELDS.includes(field)) return THIRD_PARTY_ADDRESS_RE.test(sourceClause);
  if (field === 'email' || field === 'first_name' || field === 'last_name') return THIRD_PARTY_CONTACT_RE.test(sourceClause);
  return false;
}

// Whole-ADDRESS replacement language (codex #3413 r21) — the quote must
// call the ADDRESS wrong, not a component ("my street is spelled wrong"
// is a spelling fix and keeps the unit).
const ADDRESS_REPLACEMENT_RE = /\b(?:wrong|incorrect|bad|old)\s+address\b|\baddress\s+(?:is|was|'?s)?\s*(?:wrong|incorrect|not\s+(?:the\s+)?right)\b/i;

const MOVE_INTRO_TOKENS = new Set([
  'it', 'is', 'its', 'now', 'new', 'our', 'my', 'the', 'address', 'at', 'in', 'to', 'we', 'are', 'live', 'here', 'and',
  // Address field-topic words — "Zip is 34231" is a licensed fragment of
  // the move statement; ownership/purpose labels (rental, tenant,
  // service) are deliberately NOT here.
  'zip', 'zipcode', 'postal', 'code', 'city', 'state', 'street', 'unit', 'apt', 'suite', 'apartment',
]);

/**
 * Apply validated corrections to a linked customer record.
 *
 * One transaction, customer row locked: updates + per-field audit rows +
 * the canonical Customer-360 fan-outs (name/email/address propagation,
 * primary-property sync) commit together or roll back together. One FYI
 * bell per applied batch (outside the transaction — advisory only).
 * Returns { applied: [...], skipped: [...] } and never throws.
 *
 * @param {object} args
 * @param {string} args.customerId
 * @param {Array<{field: string, newValue: string, quote?: string|null}>} args.corrections
 * @param {'sms'|'call'} args.source
 * @param {string|null} [args.sourceId]  sms_log id or call_log id
 * @param {object} [args.knex]           injectable (tests)
 */
async function applyContactCorrections({ customerId, corrections, source, sourceId = null, knex = db, postApply = null, moveContext = false, expectedValues = null, senderPhone = null }) {
  const applied = [];
  const skipped = [];
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) {
      return { applied, skipped, reason: 'gate_off' };
    }
    if (!customerId || !Array.isArray(corrections) || !corrections.length) {
      return { applied, skipped, reason: 'nothing_to_apply' };
    }

    // Dedupe to one proposal per field (first wins — callers order newest
    // first); canonicalization + validation run on the surviving set below.
    const byField = new Map();
    for (const correction of corrections) {
      const { field } = correction || {};
      if (!FIELD_VALIDATORS[field]) { skipped.push({ field: field || null, reason: 'invalid' }); continue; }
      if (byField.has(field)) { skipped.push({ field, reason: 'duplicate_field' }); continue; }
      byField.set(field, { field, newValue: normValue(correction?.newValue), quote: correction?.quote || null });
    }
    const rejectAddressGroup = (reason) => {
      for (const f of ADDRESS_FIELDS) {
        if (byField.has(f)) { skipped.push({ field: f, reason }); byField.delete(f); }
      }
    };
    // A stated MOVE must carry the full street+city+zip group: "we moved to
    // Tampa, 33602" extracting as city+zip alone would put the new locality
    // under the OLD street — the same hybrid-address fabrication a new
    // street without its locality would be (which the street-anchored check
    // below can't see, since no street was staged).
    if (moveContext && ADDRESS_FIELDS.some((f) => byField.has(f))
      && !(byField.has('address_line1') && byField.has('city') && byField.has('zip'))) {
      rejectAddressGroup('incomplete_address');
    }
    if (!addressGroupComplete(byField)) rejectAddressGroup('incomplete_address');
    // Whether the surviving group stages a NEW street — if it does and any
    // of street/city/zip is dropped by canonicalization/validation below,
    // the whole group must go with it (re-checked after the validators).
    const hadNewStreet = byField.has('address_line1');
    // Whether a real unit was STATED (codex #3413 r25): if the parser or
    // validator later drops it, the move/replacement logic must not read
    // the absence as "no unit at the new property" and clear the old one —
    // a group whose stated unit cannot be represented fails closed.
    const line2WasStated = byField.has('address_line2') && byField.get('address_line2').newValue !== '';
    // Canonicalize. Address fields parse as ONE address through the same
    // normalizeAdminAddressInput the Customer-360 admin edit uses (unit
    // canonicalization "4b" → "Unit 4B", inline-unit vs line2 conflict
    // detection) — never independently per field. Only fields the message
    // STAGED are adopted from the parser (it defaults state to FL for its
    // admin-form callers, and this lane must not invent unstaged fields).
    const stagedAddressFields = ADDRESS_FIELDS.filter((f) => byField.has(f));
    if (stagedAddressFields.length) {
      const { normalizeAdminAddressInput } = require('../utils/intake-normalize');
      const line2Entry = byField.get('address_line2');
      const explicitUnitClear = Boolean(line2Entry) && line2Entry.newValue === '';
      const parsed = normalizeAdminAddressInput({
        addressLine1: byField.get('address_line1')?.newValue,
        addressLine2: explicitUnitClear ? undefined : line2Entry?.newValue,
        city: byField.get('city')?.newValue,
        state: byField.get('state')?.newValue,
        zip: byField.get('zip')?.newValue,
      });
      // Lone inline unit (round-8): extraction can return
      // "99 Pine Ave Apt 4" as address_line1 with no separate line2, and
      // normalizeLeadAddress only peels the inline copy when a dedicated
      // line2 is also present — promote it here so line1 stays street-only
      // and the unit lands in address_line2 (otherwise the group would clear
      // the old line2 AND strand the new unit inside line1, breaking
      // exact-unit matching). An explicit unit CLEAR alongside a street that
      // embeds a unit is a contradiction — reject like a unit conflict.
      const { splitStreetLineUnit, normalizeUnitLine } = require('../utils/address-normalizer');
      const inlineSplit = !parsed.unitConflict && byField.has('address_line1') && (!line2Entry || explicitUnitClear)
        ? splitStreetLineUnit(normValue(parsed.addressLine1))
        : { street: null, unit: null };
      if (parsed.unitConflict || (inlineSplit.unit && explicitUnitClear)) {
        // Street line embeds one unit, line2 (or an explicit clear) states
        // another — no deterministic winner; reject the group, don't guess.
        for (const f of stagedAddressFields) { skipped.push({ field: f, reason: 'unit_conflict' }); byField.delete(f); }
      } else {
        if (inlineSplit.unit) {
          parsed.addressLine1 = inlineSplit.street;
          byField.set('address_line2', {
            field: 'address_line2',
            newValue: normValue(normalizeUnitLine(inlineSplit.unit)),
            quote: byField.get('address_line1')?.quote || null,
          });
        }
        const PARSED_KEY = { address_line1: 'addressLine1', address_line2: 'addressLine2', city: 'city', state: 'state', zip: 'zip' };
        for (const f of stagedAddressFields) {
          if (f === 'address_line2' && explicitUnitClear) continue; // '' = explicit clear, preserved
          const canonical = normValue(parsed[PARSED_KEY[f]]);
          if (!canonical && byField.get(f).newValue !== '') {
            // Parser produced nothing for a non-empty staged value — an
            // empty write would CLEAR a field the customer didn't ask to
            // clear; fail the field closed instead.
            skipped.push({ field: f, reason: 'invalid' });
            byField.delete(f);
            continue;
          }
          byField.get(f).newValue = canonical;
        }
      }
    }
    // Per-field canonicalization for the rest, then validate every
    // CANONICAL value — "Georgia" must become GA before STATE_RE sees it,
    // not be discarded raw.
    const namesBeforeValidation = ['first_name', 'last_name'].filter((f) => byField.has(f));
    for (const entry of Array.from(byField.values())) {
      if (!ADDRESS_FIELDS.includes(entry.field)) {
        entry.newValue = entry.newValue === '' ? '' : normValue(canonicalizeValue(entry.field, entry.newValue));
      }
      if (!FIELD_VALIDATORS[entry.field](entry.newValue)) {
        skipped.push({ field: entry.field, reason: 'invalid' });
        byField.delete(entry.field);
      }
    }
    // Whole-name pair re-check AFTER validation (codex #3413 r19): the
    // extractor's pair guard runs pre-validation, so an unqualified
    // whole-name correction ("you have my name wrong, it is Jane Smith")
    // whose surname later dies here (invalid/overlong) would apply the
    // surviving component against the stored counterpart — the exact
    // hybrid name the pair rule exists to prevent. A survivor under an
    // explicitly first-/last-scoped quote stands on its own and stays.
    if (namesBeforeValidation.length === 2 && byField.has('first_name') !== byField.has('last_name')) {
      const survivor = byField.has('first_name') ? 'first_name' : 'last_name';
      const q = String(byField.get(survivor).quote || '');
      if (!(/\bfirst name\b/i.test(q) || /\b(?:last name|surname)\b/i.test(q))) {
        skipped.push({ field: survivor, reason: 'name_pair_incomplete' });
        byField.delete(survivor);
      }
    }
    // Post-normalization group re-check (round-8): a component that passed
    // the raw completeness check can still die in canonicalization or
    // validation ("3423O" → ∅), and the survivors of a new-street or move
    // group would then commit against the OLD locality — the exact hybrid
    // address the pre-check exists to prevent.
    if ((hadNewStreet || moveContext) && ADDRESS_FIELDS.some((f) => byField.has(f))
      && !(byField.has('address_line1') && byField.has('city') && byField.has('zip'))) {
      rejectAddressGroup('incomplete_address');
    }
    // State agreement for new-address groups (codex #3413 r21): a stated
    // move that omits the state would keep the STORED state and commit a
    // cross-state hybrid ("Savannah, FL 31401"). The ZIP determines the
    // state deterministically (USPS prefix allocation) — derive and stage
    // it; a same-state move skips as 'unchanged', an unresolvable ZIP
    // fails the whole group closed.
    // A stated unit that died in canonicalization/validation poisons the
    // whole new-address group (codex #3413 r25) — committing the new
    // street while silently dropping (and for moves, CLEARING) the unit
    // the customer explicitly supplied corrupts the address.
    if (line2WasStated && !byField.has('address_line2') && (hadNewStreet || moveContext)
      && ADDRESS_FIELDS.some((f) => byField.has(f))) {
      rejectAddressGroup('unit_invalid');
    }
    if ((hadNewStreet || moveContext) && byField.has('zip')) {
      const { stateForZip } = require('./data-hygiene/normalizers');
      const derived = stateForZip(byField.get('zip').newValue);
      if (!derived) {
        rejectAddressGroup('state_unresolved');
      } else if (byField.has('state') && byField.get('state').newValue !== derived) {
        // An explicitly stated state that CONTRADICTS the ZIP (codex
        // #3413 r22): "Savannah, FL 31401" — one of them is wrong and
        // there is no deterministic winner; the whole group fails closed.
        rejectAddressGroup('state_mismatch');
      } else if (!byField.has('state')) {
        byField.set('state', { field: 'state', newValue: derived, quote: byField.get('zip').quote || null });
      }
    }
    if (!byField.size) return { applied, skipped, reason: 'nothing_valid' };

    let customerName = null;
    let emailSync = null;
    let addressApplied = false;
    await knex.transaction(async (trx) => {
      // Row lock makes read → update → fan-out atomic against a concurrent
      // admin edit — the later writer waits and then sees committed state.
      const before = await trx('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .forUpdate()
        .first();
      if (!before) { skipped.push({ field: null, reason: 'no_customer' }); return; }
      customerName = [before.first_name, before.last_name].filter(Boolean).join(' ') || 'Customer';

      // (round-11) Bind the batch to the ORIGINAL sender: the snapshot
      // below is read post-ack, so a reassignment landing between the
      // webhook's phone match and that read would self-compare. The number
      // the message actually ARRIVED from is the anchor of record — if the
      // locked row's phone no longer matches it, this is no longer the
      // sender's record and the whole batch is stale.
      if (senderPhone && tail10(before.phone) !== tail10(senderPhone)) {
        for (const { field } of byField.values()) skipped.push({ field, reason: 'concurrent_change' });
        byField.clear();
        return;
      }
      // (round-10) The sender's phone is the identity anchor for the WHOLE
      // batch: if it was changed or reassigned while extraction was in
      // flight, the correction may no longer come from this customer at all
      // — stale the entire batch, not just a field. (phone is never an
      // applyable field, so the per-field CAS below can't see this.)
      if (expectedValues && Object.prototype.hasOwnProperty.call(expectedValues, 'phone')
        && normValue(before.phone) !== normValue(expectedValues.phone)) {
        for (const { field } of byField.values()) skipped.push({ field, reason: 'concurrent_change' });
        byField.clear();
        return;
      }

      // (round-9) A concurrent change to ANY address component stales a
      // staged address group AS A WHOLE: skipping just the changed field and
      // applying the survivors would graft them onto the concurrently
      // changed component — the same hybrid-address fabrication the group
      // completeness checks exist to prevent.
      if (expectedValues && ADDRESS_FIELDS.some((f) => byField.has(f))) {
        const addressCasMiss = ADDRESS_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(expectedValues, f)
          && !sameValue(f, before[f], expectedValues[f]));
        if (addressCasMiss) {
          for (const f of ADDRESS_FIELDS) {
            if (byField.has(f)) { skipped.push({ field: f, reason: 'concurrent_change' }); byField.delete(f); }
          }
        }
      }

      // (round-12) A whole-name batch is ONE statement: when both
      // components are staged and either hits a compare-and-set miss,
      // applying the survivor would commit a hybrid name nobody stated
      // (admin's "James" + the message's "Doe" from a proposed "Jane Doe").
      // State/ZIP pair coherence for PARTIAL corrections (codex #3413
      // r26): a state-only or ZIP-only fix must agree with the OTHER
      // component as it will stand after the write — "my state is GA"
      // against a stored FL ZIP (or a GA ZIP against a stored FL state)
      // would commit an internally inconsistent address and re-key the
      // property on it. Full new-address groups were validated pre-
      // transaction; this covers the partial case using the stored row.
      // City/ZIP coherence via the service-area authority (r54, extended
      // to FULL replacement/move groups in r55): neither a ZIP-only fix
      // NOR a stated full address may commit "Bradenton, FL 34231" — when
      // the effective ZIP is a KNOWN service-area ZIP, its USPS city must
      // match the effective city; unknown ZIPs stay state-checked only.
      if (byField.has('zip') || byField.has('city')) {
        const cohZip = byField.has('zip') ? byField.get('zip').newValue : normValue(before.zip);
        const cohCity = byField.has('city') ? byField.get('city').newValue : normValue(before.city);
        if (cohZip && cohCity) {
          const { zipToCity } = require('../utils/zip-to-city');
          const knownCity = zipToCity(cohZip);
          if (knownCity && knownCity.toLowerCase() !== cohCity.toLowerCase()) {
            rejectAddressGroup('city_zip_mismatch');
          }
        }
      }
      if ((byField.has('state') || byField.has('zip') || byField.has('city')) && !(hadNewStreet || moveContext)) {
        const effState = byField.has('state') ? byField.get('state').newValue : normValue(before.state);
        const effZip = byField.has('zip') ? byField.get('zip').newValue : normValue(before.zip);
        if (byField.size && effZip && effState) {
          const { stateForZip } = require('./data-hygiene/normalizers');
          const derived = stateForZip(effZip);
          if (!derived || derived !== effState) {
            // The WHOLE staged address batch falls with the mismatch
            // (r33): "my city and state should be Atlanta, GA" against a
            // stored FL ZIP must not write the city alone — the surviving
            // component would commit a hybrid locality the customer never
            // stated.
            rejectAddressGroup('state_zip_mismatch');
          }
        }
      }
      const NAME_GROUP = ['first_name', 'last_name'];
      if (expectedValues && NAME_GROUP.every((f) => byField.has(f))) {
        const nameCasMiss = NAME_GROUP.some((f) => Object.prototype.hasOwnProperty.call(expectedValues, f)
          && !sameValue(f, before[f], expectedValues[f]));
        if (nameCasMiss) {
          for (const f of NAME_GROUP) { skipped.push({ field: f, reason: 'concurrent_change' }); byField.delete(f); }
        }
      }

      const updates = {};
      for (const { field, newValue, quote } of byField.values()) {
        // Compare-and-set (round-8): the caller snapshots the row BEFORE its
        // extraction runs; if an admin edit or a newer correction committed
        // a different value while extraction was in flight, this pass is
        // stale for that field — skip it rather than overwrite the fresher
        // write (the row lock serializes writers, it does not order them).
        if (expectedValues && Object.prototype.hasOwnProperty.call(expectedValues, field)
          && !sameValue(field, before[field], expectedValues[field])) {
          skipped.push({ field, reason: 'concurrent_change' });
          continue;
        }
        if (sameValue(field, before[field], newValue)) { skipped.push({ field, reason: 'unchanged' }); continue; }
        // A corrected email that already belongs to ANOTHER account is not a
        // correction we may auto-apply — fanning queued sends out to a
        // mailbox owned by a different customer is the failure mode the
        // canonical Customer-360 path blocks with its cross-account conflict
        // check. Same semantics here (email only; phone is never applied).
        if (field === 'email') {
          // Shared email claim lock (same key customer-dedupe's merge-undo
          // and the email-fanout claim guard take) — serializes this write
          // against a concurrent merge/undo re-claiming the same address.
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
            [`customer-email:${newValue.toLowerCase().trim()}`],
          );
          // ALL matches, not .first() — with the email on both a sibling
          // profile and an unrelated account, an unordered first() could
          // return the sibling and mask the real conflict.
          const matches = await trx('customers')
            .whereNull('deleted_at')
            .whereNot({ id: customerId })
            .whereRaw('LOWER(email) = ?', [newValue.toLowerCase()])
            .select('id', 'account_id');
          const ownAccount = before.account_id ? String(before.account_id) : String(before.id);
          if (matches.some((m) => String(m.account_id || m.id) !== ownAccount)) {
            skipped.push({ field, reason: 'email_in_use' });
            continue;
          }
        }
        updates[field] = newValue === '' ? null : newValue;
        applied.push({ field, oldValue: normValue(before[field]) || null, newValue: newValue || null, quote: quote || null });
      }
      // A MOVE implies the old unit is gone unless the message restated one
      // — clear address_line2 alongside the group. Only on stated moves
      // (round-12): a street-SPELLING fix ("123 Mane St" → "123 Main St")
      // that carries city+zip for the group check is the same property, and
      // silently dropping its unit would corrupt the address; without move
      // evidence the unit stays unless explicitly replaced or removed.
      // Keyed to the STAGED street group, not the diff (round-13): a move
      // where the new street text happens to equal the old one ("123 Main
      // St" in a different city) skips the street as unchanged, but the old
      // unit is still gone.
      // Whole-address REPLACEMENT language counts like a move
      // (codex #3413 r21): "you have the wrong address, it should be 99
      // Pine Ave, Sarasota 34231" is a complete replacement with no unit —
      // leaving the old property's Unit attached would commit the same
      // hybrid a move would. Component spelling fixes ("my street is
      // spelled wrong") name the component, not the address, and still
      // preserve the unit.
      const addressReplacementContext = byField.has('address_line1') && byField.has('city') && byField.has('zip')
        && ['address_line1', 'city', 'zip'].some((f) => ADDRESS_REPLACEMENT_RE.test(String(byField.get(f)?.quote || '')));
      if ((moveContext || addressReplacementContext) && byField.has('address_line1') && !byField.has('address_line2') && normValue(before.address_line2)) {
        updates.address_line2 = null;
        applied.push({ field: 'address_line2', oldValue: normValue(before.address_line2), newValue: null, quote: byField.get('address_line1')?.quote || null });
      }
      if (!Object.keys(updates).length) return;

      // Stale coordinates fall with the address (codex #3413 r29, same as
      // the canonical admin edit path): the post-commit regeocode is
      // best-effort, and if it fails the null coords are what the
      // geocoder's backstop selects for retry — coords left pointing at
      // the OLD property would route the tech there indefinitely.
      // Only GEOCODED components clear coords (r42): buildAddress ignores
      // the unit, so a line2-only fix keeps the still-valid coordinates —
      // a failed post-commit lookup must not drop the customer from
      // routing over a unit edit.
      if (['address_line1', 'city', 'state', 'zip'].some((f) => updates[f] !== undefined)) {
        updates.latitude = null;
        updates.longitude = null;
      }
      await trx('customers').where({ id: customerId }).update({ ...updates, updated_at: new Date() });
      const after = { ...before, ...updates };

      for (const a of applied) {
        await trx('agent_decisions').insert({
          workflow: WORKFLOW,
          agent_name: 'contact-correction',
          decision_version: 'v1',
          mode: 'auto',
          status: 'auto_applied',
          entity_type: 'customer',
          entity_id: customerId,
          customer_id: customerId,
          source_channel: source,
          detected_intent: 'contact_correction',
          confidence: 0.9,
          confidence_label: 'high',
          input_snapshot: JSON.stringify({
            field: a.field,
            old_value: a.oldValue,
            new_value: a.newValue,
            quote: a.quote,
            source_id: sourceId,
          }),
          reasoning_summary: `Customer stated a ${a.field} correction over ${source}; auto-applied (${a.oldValue || '∅'} → ${a.newValue || '∅'}).`,
        });
      }

      // Same fan-outs as an admin Customer-360 edit (admin-customers.js) —
      // open leads/estimates/newsletter/property copies snapshot these
      // fields and never re-read customers.*, so a corrected record without
      // the fan-out keeps sending the wrong values from the copies.
      const addressChanged = ADDRESS_FIELDS.some((f) => updates[f] !== undefined);
      if (addressChanged) {
        // Stale-coord clearing rides the main update itself (r29/r42, see
        // the geocoded-component guard above) — a unit-only fix keeps its
        // still-valid coordinates.
        // Sparse-mirror guard (round-15): syncPrimaryAddress derives the
        // primary property's street/zip/key from the CUSTOMER row, so when
        // the mirror is incomplete (e.g. recordCallProperty created the
        // property but its fail-soft customer-mirror update failed) a
        // permitted city/zip/unit-only correction would clear the property's
        // real street/zip and rekey it off the partial row. Leave the
        // property untouched until the mirror carries a complete address —
        // same fail-closed shape as the blank-line1 re-geocode guard.
        const mirrorComplete = ['address_line1', 'city', 'zip']
          .every((f) => normValue(after[f]) !== '');
        if (mirrorComplete) {
          // explicitLine2: this lane's line2 writes are deliberate (explicit
          // unit clear, whole-street move auto-clear, promoted inline unit) —
          // a null must CLEAR the primary property's unit, not fall back to it.
          await require('./customer-properties').syncPrimaryAddress(after, trx, {
            explicitLine2: updates.address_line2 !== undefined,
            // Unit-only edits keep the property's still-valid coordinates
            // (r43) — the building did not move, and a failed best-effort
            // re-geocode must not leave property-linked flows copying
            // nulls.
            preserveCoords: !['address_line1', 'city', 'state', 'zip'].some((f) => updates[f] !== undefined),
          });
        }
        await require('./customer-address-fanout').propagateCustomerAddressChange({ before, after }, trx);
        addressApplied = true;
      }
      if (updates.email !== undefined) {
        emailSync = await require('./customer-email-fanout').propagateCustomerEmailChange(
          { before, after, source: `contact-correction (${source})` }, trx,
        );
      }
      if (updates.first_name !== undefined || updates.last_name !== undefined) {
        await require('./customer-contact-fanout').propagateCustomerNameChange({ before, after }, trx);
      }
      // Caller-supplied same-transaction follow-through (e.g. the call lane
      // stamping consumed candidate rows) — commits or rolls back WITH the
      // correction, so an applied field can never leave its bookkeeping
      // behind.
      if (postApply && applied.length) await postApply(trx, applied);
    });

    // Post-commit continuations, mirroring the canonical Customer-360 edit
    // path — all fire-and-forget, never failing the applied correction:
    //   - re-geocode the corrected address and mirror fresh coords onto the
    //     primary property (syncPrimaryAddress cleared them in-transaction);
    //   - deferred email fan-out actions (double-opt-in re-confirmation to
    //     the corrected address, held newsletter resume) that must only run
    //     once the new email is committed.
    if (addressApplied) {
      // Address-guarded re-geocode (writes coords + the primary-property
      // mirror only if the address is still the one it geocoded) — a slow
      // provider response for THIS correction can never overwrite the
      // coordinates of a later correction that committed while it was in
      // flight.
      require('./geocoder').regeocodeCustomerAddressGuarded(customerId).catch(() => {});
    }
    if (emailSync?.heldNewsletterResume) {
      require('./lead-first-touch-resume').resumeHeldNewsletterPostCommit(emailSync.heldNewsletterResume)
        .catch((err) => logger.warn(`[contact-correction] held newsletter resume failed for ${customerId}: ${errTag(err)}`));
    }
    if (emailSync?.pendingConfirmation) {
      require('./customer-email-fanout').resendPendingConfirmation(emailSync.pendingConfirmation)
        .catch((err) => logger.warn(`[contact-correction] pending confirmation resend failed for ${customerId}: ${errTag(err)}`));
    }

    if (applied.length) {
      const lines = applied
        .map((a) => `${a.field}: ${a.oldValue || '(empty)'} → ${a.newValue || '(cleared)'}`)
        .join('; ');
      await require('./notification-service').notifyAdmin(
        'customer',
        `Customer record corrected from ${source === 'call' ? 'a call' : 'SMS'}: ${customerName}`,
        `${customerName} stated corrected contact info and it was auto-applied — ${lines}. `
          + 'FYI only; revert from the customer page if wrong.',
        {
          link: `/admin/customers?customerId=${customerId}`,
          bell: true,
          metadata: { customerId, source, sourceId, applied },
        },
      ).catch((err) => {
        logger.warn(`[contact-correction] FYI bell failed for ${customerId}: ${errTag(err)}`);
      });
      logger.info(`[contact-correction] applied ${applied.length} field(s) for customer ${customerId} via ${source}`);
    }
    return { applied, skipped };
  } catch (err) {
    // Transaction rolled back — nothing half-applied. Report the batch as
    // skipped rather than throwing into a webhook/pipeline caller.
    logger.warn(`[contact-correction] apply failed for ${customerId}: ${errTag(err)}`);
    return { applied: [], skipped, reason: 'error' };
  }
}

/**
 * SMS entry point — webhook post-ack, fire-and-forget, linked customer only.
 */
// Per-customer in-process run chain (round-12): two runners for the same
// customer in ONE process must not snapshot concurrently — with parallel
// runs, both snapshot the ORIGINAL value and whichever transaction commits
// first wins, so an older message's slow extraction could beat (and then
// CAS-reject) the customer's newer correction. Cross-instance ordering and
// crash durability are NOT this chain's job (round-17): the webhook path
// runs through contact-correction-queue, whose DB-backed per-sender fence
// serializes across overlapping deploy instances; this chain remains as
// same-process defense for direct callers.
const customerRunChain = new Map();
function serializePerCustomer(customerId, fn) {
  const prev = customerRunChain.get(customerId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  customerRunChain.set(customerId, tail);
  tail.then(() => {
    if (customerRunChain.get(customerId) === tail) customerRunChain.delete(customerId);
  });
  return run;
}

// Webhook arrival ordering + crash durability moved to the DB-backed
// contact-correction-queue (round-17): the rounds 13–15 in-memory
// reservation slot preserved Twilio arrival order within one process, but
// Railway runs overlapping instances during deploys — a process-local
// fence cannot order two rapid corrections routed to different instances,
// and a detached run died with the process while the MessageSid claim
// stayed durable (Twilio's retry was then ignored, losing the correction).
// The queue keeps the same shape — reserve at entry, enqueue on the branch
// that fires, cancel on every other exit path — as durable rows.

// CAS baseline captured at webhook match time (round-15): the fields the
// apply transaction compare-and-sets, taken from the customer row AS THE
// WEBHOOK MATCHED IT so an admin edit made while the message waits in the
// queue reads as a concurrent change. Persisted on the job row (round-17)
// so the baseline survives a deploy.
function snapshotContactCasFields(row) {
  if (!row) return null;
  const fields = [...APPLYABLE_FIELDS, 'phone'];
  if (!fields.every((f) => f in row)) return null;
  return Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
}

async function runSmsContactCorrection(args) {
  const customerId = args?.customer?.id;
  if (!customerId) return { applied: [], skipped: [], reason: 'unlinked' };
  return serializePerCustomer(customerId, () => runSmsContactCorrectionInner(args));
}

async function runSmsContactCorrectionInner({ customer, body, smsLogId = null, knex = db, senderPhone = null, matchedSnapshot = null, ownerFence = null }) {
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) return { applied: [], skipped: [], reason: 'gate_off' };
    if (!customer?.id) return { applied: [], skipped: [], reason: 'unlinked' };
    // Snapshot for the compare-and-set inside the apply transaction:
    // extraction is an in-flight LLM call, and a field an admin (or a newer
    // message) changed underneath it must not be overwritten by this pass's
    // stale proposal.
    // The baseline is the customer row AS THE WEBHOOK MATCHED IT (round-15):
    // a runner-start read would post-date an admin edit made while this
    // message waited in the queue, so the CAS would accept the older SMS as
    // a valid overwrite of the admin's newer value. Callers pass the matched
    // row; the runner-start read remains only as a fallback for callers that
    // have no match-time row. All CAS fields must be present on the passed
    // row or it is ignored (a partial row would read as concurrent change).
    // Includes phone (round-10): the sender's number is the batch's identity
    // anchor — a concurrent phone change/reassignment stales the whole batch.
    const casFields = [...APPLYABLE_FIELDS, 'phone'];
    const snapshotRow = (matchedSnapshot && casFields.every((f) => f in matchedSnapshot))
      ? matchedSnapshot
      : await knex('customers')
        .where({ id: customer.id })
        .whereNull('deleted_at')
        .first(casFields);
    const expectedValues = snapshotRow
      ? Object.fromEntries(casFields.map((f) => [f, snapshotRow[f]]))
      : null;
    const corrections = await extractSmsContactCorrections({ body });
    // null = provider failure, not "no corrections" — surfaced as the
    // retryable 'error' shape so the durable queue re-runs the extraction
    // instead of marking the job done (codex #3413 r19).
    if (corrections === null) return { applied: [], skipped: [], reason: 'error' };
    if (!corrections.length) return { applied: [], skipped: [], reason: 'none_detected' };
    // Same-field retraction resolution (codex #3413 r38): "use
    // first@example.com, sorry actually use final@example.com" yields two
    // grounded candidates for one field, and a first-wins dedupe would
    // apply the RETRACTED value. The later statement in the MESSAGE wins —
    // ordered by each quote's grounded position in the body, never by
    // model-array order. Conflicting values whose positions cannot be
    // distinguished fail the field closed.
    const normBody = normValue(body).replace(/\s+/g, ' ').toLowerCase();
    const quotePos = (c) => {
      const nq = normValue(c.quote).replace(/\s+/g, ' ').toLowerCase();
      return nq ? normBody.lastIndexOf(nq) : -1;
    };
    const byFieldLast = new Map();
    const conflicted = new Set();
    for (const c of corrections) {
      const cur = byFieldLast.get(c.field);
      if (!cur) { byFieldLast.set(c.field, c); continue; }
      const curPos = quotePos(cur);
      const newPos = quotePos(c);
      if (sameValue(c.field, cur.newValue, c.newValue)) {
        // Equal values keep the LATER-positioned statement (r40): its
        // licensing context (move vs spelling fix) is the operative one —
        // a historical move mention must not ride an equal-value dedupe
        // into clearing the unit of a later spelling correction.
        if (newPos > curPos) byFieldLast.set(c.field, c);
        continue;
      }
      if (newPos > curPos) byFieldLast.set(c.field, c);
      else if (newPos === curPos) conflicted.add(c.field);
    }
    for (const f of conflicted) byFieldLast.delete(f);
    const resolved = [...byFieldLast.values()];
    if (!resolved.length) return { applied: [], skipped: [...conflicted].map((f) => ({ field: f, reason: 'conflicting_values' })), reason: 'nothing_valid' };
    return await applyContactCorrections({
      customerId: customer.id,
      corrections: resolved,
      source: 'sms',
      sourceId: smsLogId,
      knex,
      expectedValues: expectedValues || null,
      // The number the webhook matched this message FROM — binds the batch
      // to the original sender even if the customer's phone is reassigned
      // between the webhook match and the snapshot read above.
      senderPhone,
      // Move evidence scoped to the corrected statement (codex #3413 r24)
      // and derived from the SURVIVING candidates after duplicate
      // resolution (r40): a historical move mention whose components lost
      // the dedupe must not make the final batch a move.
      moveContext: resolved.some((c) => c.moveLicensed === true),
      // Queue lock-owner fence (codex #3413 r20): runs INSIDE the apply
      // transaction, so a worker whose job was reclaimed after the
      // stale-lock threshold rolls its customer write back instead of
      // committing a mutation its terminal mark can no longer own — the
      // same in-trx pattern as the call lane's processing-token fence.
      // BOTH callback arguments forward (r23): the fence seals the job
      // done with the applied chain, and a wrapper that dropped `applied`
      // reduced it to a lease refresh — losing the atomic seal entirely.
      postApply: ownerFence || null,
    });
  } catch (err) {
    logger.warn(`[contact-correction] sms run failed: ${errTag(err)}`);
    return { applied: [], skipped: [], reason: 'error' };
  }
}

/**
 * Call entry point — consumes the already-staged customer_field_candidates
 * for a processed call (the existing extraction mechanism; no second LLM
 * pass), on LINKED customers only, and ONLY when the caller's quoted words
 * carry correction intent: the staging writer records ordinary extracted
 * identity fields from every call, and a routine mention is not a mandate
 * to rewrite the profile.
 *
 * Trust model — SPOKEN values pass through transcription, so per-field
 * fidelity differs:
 *   - NAMES auto-apply (the evidence paths for name candidates are
 *     name-scoped, and a name typo has no delivery/routing blast radius).
 *   - EMAIL and ADDRESS candidates are NEVER auto-applied from a call: a
 *     transcribed email must not resolve read-back review cards or release
 *     held sends as operator-asserted truth, and a transcribed address has
 *     no address-validation verdict attached here. Instead they surface as
 *     ONE owner FYI "proposed corrections" bell and stay `pending` in
 *     customer_field_candidates for review. (SMS corrections — typed by
 *     the customer — keep full auto-apply.)
 *
 * Candidates are scoped to the LINKED customer id — a relinked call whose
 * staged rows still carry the old/null linkage must not write to the newly
 * linked record. Applied candidates are stamped in the SAME transaction as
 * the correction.
 */
const CALL_CONFIDENCE_FLOOR = 0.85;
const CALL_AUTO_FIELDS = Object.freeze({
  first_name: 'first_name',
  last_name: 'last_name',
});
const CALL_PROPOSE_FIELDS = Object.freeze(['email', 'address_line1', 'address_line2', 'city', 'state', 'zip']);

// Explicit-correction bar for CALL name candidates. The SMS hint regex keeps
// a weak "name … is" branch (a customer-initiated correction text has that
// shape), but callers state their names on practically every call — "my name
// is Jane" while booking is identification, not a mandate to rewrite the
// record. A name candidate only counts when the quote carries an ERROR/
// correction claim NEAR the word "name" (either order): wrong, incorrect,
// misspelled, typo, actually, not, correct(ion). Bare spelling language is
// NOT in the set — "let me spell my name" is routine identity collection
// (agents ask callers to spell names on ordinary calls), not a claim that
// the stored name is wrong.
// Clause-bound with nearest-topic pairing like the SMS lane (round-14) —
// proximity alone let "my email is wrong, my name is Jane Smith" pass
// ("wrong" within 60 chars of "name"). Call names keep the STRICTER
// vocabulary: no bare spell/new/old ("let me spell my name" is routine
// identity collection, round-7).
// `not`/`new`/`old` carry BOTH boundaries (round-15): with only the trailing
// one, "cannot spell my name" matched `not\b` and a routine spelling exchange
// read as an error claim (same for "renew"/"bold" in the SMS vocabulary).
const CALL_NAME_CW_RE = /wrong|incorrect|misspell\w*|typo|actually|correct\w*|\bnot\b/gi;
function callNameCorrectionIntent(quote) {
  return normValue(quote).split(CLAUSE_SPLIT_RE)
    .some((cl) => clauseBindsCategory(cl, 'name', CALL_NAME_CW_RE));
}

// Quote-component binding for shared name_full evidence: the staging writer
// assigns one quote to BOTH name candidates, but "my last name is spelled
// Rivers" is not a mandate to touch the first name (and vice versa). A quote
// naming neither component is a whole-name correction and binds to both.
function quoteBindsNameField(field, quote) {
  const q = String(quote || '');
  const saysFirst = /\bfirst name\b/i.test(q);
  const saysLast = /\b(last name|surname)\b/i.test(q);
  if (field === 'first_name' && saysLast && !saysFirst) return false;
  if (field === 'last_name' && saysFirst && !saysLast) return false;
  return true;
}

async function runCallContactCorrection({ callId, customerId, knex = db, procToken = null, candidateIds = null, expectedValuesSnapshot = null, allowNameAutoApply = true }) {
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) return { applied: [], skipped: [], reason: 'gate_off' };
    if (!callId || !customerId) return { applied: [], skipped: [], reason: 'unlinked' };
    if (!(await knex.schema.hasTable('customer_field_candidates'))) {
      return { applied: [], skipped: [], reason: 'no_table' };
    }
    // Provenance scope (round-14): when the caller passes the ids its own
    // staging pass produced, consume ONLY those — the fence protects the
    // runner and the final write, but pending rows carry no token, and a
    // stale worker's late inserts must not ride this pass's valid token.
    if (Array.isArray(candidateIds) && !candidateIds.length) {
      return { applied: [], skipped: [], reason: 'no_candidates' };
    }
    const rows = await knex('customer_field_candidates')
      .modify((q) => { if (Array.isArray(candidateIds)) q.whereIn('id', candidateIds); })
      .where({ call_log_id: callId, status: 'pending', customer_id: customerId })
      .whereIn('field_name', [...Object.keys(CALL_AUTO_FIELDS), ...CALL_PROPOSE_FIELDS])
      .whereNotNull('evidence_quote')
      .where(function confidenceFloor() {
        // The staging writer's confidence map never scores email (only
        // caller_identity / service_address / service category), so email
        // candidates carry NULL confidence by construction; they only ever
        // feed the proposal bell, where the intent-quote check is the bar.
        this.where('confidence', '>=', CALL_CONFIDENCE_FLOOR)
          .orWhere(function emailNullConfidence() {
            this.where('field_name', 'email').whereNull('confidence');
          });
      })
      // Deterministic under re-staging: a forced reprocess can leave two
      // pending candidates for one field — newest first, and the per-field
      // dedupe below keeps the newest.
      .orderBy('created_at', 'desc')
      .select('id', 'field_name', 'final_recommended_value', 'evidence_quote');
    if (!rows.length) return { applied: [], skipped: [], reason: 'no_candidates' };

    // Caller-identity guard inputs + the transcript itself: a call from a
    // service_contact*_phone links to the OWNING customer, but the caller
    // correcting their own name is not a mandate to rename the account
    // owner. Name auto-apply requires the call to have come from the
    // customer's PRIMARY phone; everything else stays in the
    // proposal/pending lane.
    let callerIsPrimary = false;
    let call = null;
    let expectedValues = null;
    try {
      let owner = null;
      [call, owner] = await Promise.all([
        knex('call_log').where({ id: callId }).first('from_phone', 'to_phone', 'direction', 'transcription', 'processing_token'),
        knex('customers').where({ id: customerId }).first('phone', 'first_name', 'last_name'),
      ]);
      // The EXTERNAL leg is the caller identity (codex #3413 r19): on a
      // recorded outbound callback from_phone is a Waves number and the
      // customer is to_phone. Same external-leg doctrine as the
      // processor's resolveCallContactPhone — used for batch binding and
      // proposals. Outbound calls NEVER auto-apply (r22): live outbound
      // recordings can label the WAVES AGENT as "Caller:" (see the
      // inbound-only guard in call-recording-processor), so the
      // Caller-line grounding this lane trusts is not speaker-reliable
      // there — an agent's read-back of the old value could ground a
      // rewrite. Outbound corrections stay proposal-only.
      const isOutbound = String(call?.direction || '').toLowerCase().startsWith('outbound');
      const externalPhone = isOutbound ? call?.to_phone : call?.from_phone;
      if (call) call.external_phone = externalPhone || null;
      const callerTail = tail10(externalPhone);
      callerIsPrimary = !isOutbound && Boolean(callerTail) && callerTail === tail10(owner?.phone);
      // The caller number must map to a UNIQUE active customer (codex
      // #3413 r29) — same doctrine as the SMS lane's
      // findSingleCustomerByPhone: a number shared by two active accounts
      // (or a historical link predating a duplicate) means the corrector
      // could be the OTHER customer, and renaming this one on their word
      // is exactly the misattribution the primary-caller gate exists to
      // prevent.
      if (callerIsPrimary) {
        const sharedMatches = await knex('customers')
          .whereNull('deleted_at')
          .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [callerTail])
          .limit(2)
          .select('id');
        callerIsPrimary = sharedMatches.length === 1 && String(sharedMatches[0].id) === String(customerId);
      }
      // Snapshot for the compare-and-set in the apply transaction — a name
      // an admin corrected must not be overwritten by this pass's staged
      // (older) extraction; the phone is the identity anchor and stales the
      // whole batch if reassigned. Baseline preference (codex #3413 r19):
      // the CLAIM-TIME snapshot the processor captured before its long
      // transcription/extraction — a read taken here would adopt an admin
      // edit made DURING processing as the baseline and let the older
      // call-stated value overwrite it. The late read remains only for
      // callers with no early snapshot (customer linked mid-processing,
      // where the window is negligible).
      const casKeys = ['first_name', 'last_name', 'phone'];
      if (expectedValuesSnapshot && casKeys.every((f) => f in expectedValuesSnapshot)) {
        expectedValues = Object.fromEntries(casKeys.map((f) => [f, expectedValuesSnapshot[f] ?? null]));
      } else if (owner) {
        expectedValues = { first_name: owner.first_name, last_name: owner.last_name, phone: owner.phone };
      }
    } catch { callerIsPrimary = false; call = null; }

    // Processing-pass fence: the call processor lets a peer reclaim a stuck
    // `processing` row after its timeout by replacing processing_token. A
    // stale worker that lost that claim must not apply its (older)
    // extraction — when the caller supplied its token, verify the row still
    // carries it (re-checked inside the apply transaction below; this
    // pre-check also fences the proposal bell). Unverifiable = fail closed.
    if (procToken && (!call || call.processing_token !== procToken)) {
      return { applied: [], skipped: [], reason: 'fence_lost' };
    }

    // Transcript grounding — the diarized transcript ("Agent:"/"Caller:"
    // turns) is the source of record, and only lines EXPLICITLY labeled
    // "Caller:" can evidence a correction: an agent reading back the OLD
    // (wrong) value must not ground a rewrite, and the transcription
    // pipeline's supported unlabeled fallback ("Speaker 1:"/"Speaker 2:",
    // call-recording-processor openai_unlabeled_fallback) never attributes
    // speech to the caller — a transcript without Caller labels (or with no
    // transcript at all) grounds nothing (fail closed). Applies to BOTH
    // lanes — name auto-apply and the proposal bell.
    const rawCallerLines = String(call?.transcription || '')
      .split(/\r?\n/)
      .filter((line) => /^\s*caller\s*:/i.test(line))
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    // A caller disclaiming the linked customer's identity kills the WHOLE
    // batch (codex #3413 r45): "I'm not John anymore" means every stated
    // correction — names AND proposals — belongs to the number's new
    // holder. Checked on the ORIGINAL-CASE lines, since the name form
    // requires a capitalized token.
    if (rawCallerLines.some((line) => WRONG_PERSON_RE.test(line.replace(/[\u2018\u2019]/g, "'")))) {
      return { applied: [], skipped: [{ field: null, reason: 'identity_disclaimed' }], reason: 'identity_disclaimed' };
    }
    const callerLines = rawCallerLines.map((line) => line.toLowerCase());
    const quoteGrounded = (q) => {
      const needle = normValue(q).replace(/\s+/g, ' ').toLowerCase();
      return needle.length >= 4 && callerLines.some((line) => line.includes(needle));
    };
    // The replacement VALUE must be caller speech too (round-11): the
    // staging writer derives the recommended value independently of the
    // evidence quote, so a grounded "my last name is wrong" quote could
    // otherwise carry a hallucinated surname into auto-apply. Matching is
    // token-delimited (round-12) — plain substring would let "Lee" ground
    // on the word "please". CO-LOCATED with the quote (round-16): the value
    // must appear on the SAME caller line that grounds the evidence quote —
    // a caller statement is one line of the diarized transcript, and a value
    // spoken in different, unrelated caller speech (a mailing address for
    // someone else, say) is not part of the correcting statement.
    const valueGroundedWithQuote = (c) => {
      const needle = normValue(c.evidence_quote).replace(/\s+/g, ' ').toLowerCase();
      if (needle.length < 4 || normValue(c.final_recommended_value) === '') return false;
      return callerLines.some((line) => line.includes(needle)
        && tokenBoundedIncludes(line, c.final_recommended_value));
    };

    const seenFields = new Set();
    const candidates = rows.filter((c) => {
      // Name candidates take the stricter explicit-correction bar — routine
      // calls state names constantly. Email/address proposals take the same
      // clause-bound field predicate as the SMS lane (round-10): "my email
      // is jane@example.com" while booking is identity collection, and a
      // bell claiming corrected info was stated would be a false proposal.
      const intentOk = CALL_AUTO_FIELDS[c.field_name]
        ? (callNameCorrectionIntent(c.evidence_quote)
          && !NAME_OWNERSHIP_DISCLAIMER_RE.test(String(c.evidence_quote || '')))
        : quoteCarriesFieldIntent(c.field_name, c.evidence_quote);
      if (!intentOk) return false;
      // Third-party ownership doctrine, same as the SMS extractor (r22
      // SMS / r23 calls): "my wife's name is wrong, it is Janet Smith" on
      // a primary-number call passes every intent/grounding/pair check —
      // but the name belongs to a third party and must neither rename the
      // customer nor ring a proposal bell. Judged against the FULL caller
      // line that grounds the quote (r24): a narrowed evidence quote must
      // not shed the possessive that marks the statement third-party.
      // EVERY caller line matching the quote is probed (codex #3413 r28):
      // with repeated evidence text across turns, value grounding may
      // accept the replacement from a LATER matching line — ownership
      // must hold on all of them.
      const tpNeedle = normValue(c.evidence_quote).replace(/\s+/g, ' ').toLowerCase();
      // Each probe includes the immediately PRECEDING caller line (r33):
      // "Caller: My wife's name is wrong." / "Caller: The name should be
      // Janet Smith." grounds on the second line while the possessive
      // lives in the first — same adjacency the SMS lane's clause probes
      // carry.
      const tpMatchIdx = tpNeedle.length >= 4
        ? callerLines.map((line, i) => (line.includes(tpNeedle) ? i : -1)).filter((i) => i >= 0)
        : [];
      const tpProbes = (tpMatchIdx.length
        ? tpMatchIdx.map((i) => [
          i > 0 ? callerLines[i - 1] : '',
          callerLines[i],
          // The FOLLOWING caller turn joins the probe too (r35): "the
          // name should be Janet Smith" / "that's my wife's name".
          i + 1 < callerLines.length ? callerLines[i + 1] : '',
        ].filter(Boolean).join(' ; '))
        : [String(c.evidence_quote || '')])
        .map((l) => l.replace(/[‘’]/g, "'"));
      const tpField = CALL_AUTO_FIELDS[c.field_name] || c.field_name;
      if (tpProbes.some((p) => thirdPartyOwnedStatement(tpField, p))) return false;
      // Ownership DISCLAIMERS and NEGATED-name statements ride the same
      // adjacent-line probes for name candidates (r34/r46): "the account
      // is not in my name" or "my name is not Jane Smith anymore" one
      // caller turn away must still stand down the rename.
      if (CALL_AUTO_FIELDS[c.field_name]
        && tpProbes.some((p) => NAME_OWNERSHIP_DISCLAIMER_RE.test(p)
          || NEGATED_NAME_RE.test(p)
          // Future/condition-scoped statements hold on calls too (r53):
          // "if the court approves it, my name is …" is not a present
          // correction.
          || FUTURE_CHANGE_RE.test(p)
          || CONDITIONAL_CHANGE_RE.test(p))) return false;
      if (!quoteGrounded(c.evidence_quote)) return false;
      if (seenFields.has(c.field_name)) return false;
      seenFields.add(c.field_name);
      return true;
    });
    if (!candidates.length) return { applied: [], skipped: [], reason: 'no_candidates' };

    // Email/address: propose, never write. One bell for the batch; the
    // candidate rows stay pending for review on the customer page.
    // Proposed VALUES take the same value/quote co-location bar as name
    // auto-writes (codex #3413 r19): "my email is wrong" grounded on one
    // caller line must not pair with an accountant's address spoken in
    // unrelated caller speech — a bell presenting that value as the
    // customer-stated correction is a false proposal even though nothing
    // auto-applies. Spoken values are DERIVED ("jordan dot rivers at
    // example dot com" → jordan.rivers@example.com), so the line is also
    // compared in spoken-form normalization — the co-location requirement
    // (same caller line as the quote) is what the check enforces.
    const spokenNormalize = (s) => String(s || '').toLowerCase()
      .replace(/\s+dot\s+/g, '.')
      .replace(/\s+at\s+/g, '@')
      .replace(/\s+dash\s+/g, '-')
      .replace(/\s+underscore\s+/g, '_');
    const valueGroundedForProposal = (c) => {
      const needle = normValue(c.evidence_quote).replace(/\s+/g, ' ').toLowerCase();
      const v = normValue(c.final_recommended_value).replace(/\s+/g, ' ').toLowerCase();
      if (needle.length < 4 || !v) return false;
      // Token-bounded on BOTH forms (codex #3413 r21): a bare substring on
      // the normalized line let a hallucinated short value ground inside a
      // longer word ("IN" inside "incorrect").
      return callerLines.some((line) => line.includes(needle)
        && (tokenBoundedIncludes(line, v) || tokenBoundedIncludes(spokenNormalize(line), v)));
    };
    const proposals = candidates.filter((c) => CALL_PROPOSE_FIELDS.includes(c.field_name)
      && valueGroundedForProposal(c));
    // One proposal bell per call, ever — force-reprocessing a call (or a
    // pipeline retry) leaves the candidates pending by design and must not
    // re-ring. The bell row itself is the dedupe anchor.
    if (proposals.length) {
      const dedupeKey = `contact-correction-proposal:${callId}`;
      const lines = proposals.map((p) => `${p.field_name}: ${normValue(p.final_recommended_value)}`).join('; ');
      const ringProposalBell = async (runner) => {
        // (round-9) The fence pre-check above is unlocked, so a pass that
        // crosses the reclaim threshold here could ring from its OLDER
        // extraction and the per-call dedupe would then suppress the owning
        // pass's newer values. With a procToken, hold the token-conditioned
        // call_log row FOR UPDATE across the dedupe check + emission so a
        // reclaim serializes with the bell; a pass that already lost the
        // fence rings nothing.
        if (procToken) {
          const owned = await runner('call_log')
            .where({ id: callId, processing_token: procToken })
            .forUpdate()
            .first('id');
          if (!owned) return;
        }
        let alreadyRung = false;
        try {
          alreadyRung = Boolean(await runner('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
            .first('id'));
        } catch { alreadyRung = false; }
        if (alreadyRung) return;
        await require('./notification-service').notifyAdmin(
          'customer',
          'Contact corrections proposed from a call',
          `The caller stated corrected contact info on a recorded call — ${lines}. `
            + 'Spoken email/address values are not auto-applied; review and apply from the customer page.',
          {
            link: `/admin/customers?customerId=${customerId}`,
            bell: true,
            metadata: { customerId, source: 'call', sourceId: callId, dedupeKey, proposed: proposals.map((p) => p.field_name) },
          },
        );
      };
      try {
        if (procToken) await knex.transaction((trx) => ringProposalBell(trx));
        else await ringProposalBell(knex);
      } catch (err) {
        logger.warn(`[contact-correction] proposal bell failed for call ${callId}: ${errTag(err)}`);
      }
    }

    // Historical/forced passes never auto-apply (codex #3413 r22): a
    // force-reprocess of an old call captures TODAY's customer values as
    // its claim-time baseline, so an admin edit made since the call would
    // pass the CAS and be overwritten by the old transcript. Without a
    // source-time baseline the write cannot be proven non-stale — names
    // stay in the review lane.
    const nameCandidates = (callerIsPrimary && allowNameAutoApply
      ? candidates.filter((c) => CALL_AUTO_FIELDS[c.field_name]
        && quoteBindsNameField(c.field_name, c.evidence_quote)
        && valueGroundedWithQuote(c))
      : [])
      // (round-15) Same unqualified whole-name pair rule as the SMS
      // extractor: a quote correcting the whole name ("you have my name
      // wrong; it is Jane Smith") corrects BOTH components — a staging pass
      // that emitted only first_name would graft the new first name onto
      // the record's old surname, a hybrid nobody stated. Single-component
      // candidates survive only under explicitly first-/last-scoped quotes.
      .filter((c, _i, arr) => {
        const q = String(c.evidence_quote || '');
        if (/\bfirst name\b/i.test(q) || /\b(?:last name|surname)\b/i.test(q)) return true;
        const other = c.field_name === 'first_name' ? 'last_name' : 'first_name';
        return arr.some((o) => o.field_name === other);
      });
    if (!nameCandidates.length) {
      if (callerIsPrimary && !allowNameAutoApply && candidates.some((c) => CALL_AUTO_FIELDS[c.field_name])) {
        return { applied: [], skipped: [{ field: 'name', reason: 'historical_pass' }], reason: proposals.length ? 'proposed_only' : 'historical_pass' };
      }
      if (!callerIsPrimary && candidates.some((c) => CALL_AUTO_FIELDS[c.field_name])) {
        return { applied: [], skipped: [{ field: 'name', reason: 'caller_not_primary' }], reason: proposals.length ? 'proposed_only' : 'caller_not_primary' };
      }
      return { applied: [], skipped: [], reason: proposals.length ? 'proposed_only' : 'no_candidates' };
    }
    const corrections = nameCandidates.map((c) => ({
      field: CALL_AUTO_FIELDS[c.field_name],
      newValue: c.final_recommended_value,
      quote: c.evidence_quote,
    }));
    return await applyContactCorrections({
      customerId,
      corrections,
      source: 'call',
      sourceId: callId,
      knex,
      expectedValues,
      // The caller's EXTERNAL number (to_phone on outbound callbacks) —
      // same original-sender batch binding as the SMS lane.
      senderPhone: call?.external_phone || null,
      // Same-transaction stamp of exactly the candidate rows whose VALUE was
      // applied — two pending candidates for one field with different values
      // must not both read as auto_applied, and an applied field can never
      // commit without its stamp.
      postApply: async (trx, applied) => {
        // In-transaction fence re-check: the pre-check above races the
        // peer's reclaim; this one commits or rolls back WITH the customer
        // write, so losing the fence mid-apply aborts the whole correction.
        if (procToken) {
          // Row-locked (round-8): a plain SELECT leaves the reclaim window
          // open between this check and commit — a peer crossing the
          // 10-minute threshold could still replace processing_token and
          // the stale pass would commit anyway. .forUpdate() holds the
          // call_log row through the correction commit so a reclaim
          // serializes with the customer write, mirroring the fenced
          // writers in call-recording-processor.
          const owned = await trx('call_log')
            .where({ id: callId, processing_token: procToken })
            .forUpdate()
            .first('id');
          if (!owned) throw new Error('processing_fence_lost');
        }
        // Compare against the CANONICALIZED candidate value — applyContact-
        // Corrections canonicalizes before writing (raw "MCGOWAN" is stored
        // as "McGowan"), so a raw-value compare would leave the very
        // candidate that was applied stranded in pending.
        const appliedIds = nameCandidates
          .filter((c) => applied.some((a) => a.field === CALL_AUTO_FIELDS[c.field_name]
            && sameValue(a.field, a.newValue, canonicalizeValue(a.field, normValue(c.final_recommended_value)))))
          .map((c) => c.id);
        if (appliedIds.length) {
          await trx('customer_field_candidates')
            .whereIn('id', appliedIds)
            .update({ status: 'auto_applied', reviewed_at: new Date(), updated_at: new Date() });
        }
      },
    });
  } catch (err) {
    logger.warn(`[contact-correction] call run failed for ${callId}: ${errTag(err)}`);
    return { applied: [], skipped: [], reason: 'error' };
  }
}

module.exports = {
  detectContactCorrectionIntent,
  extractSmsContactCorrections,
  applyContactCorrections,
  runSmsContactCorrection,
  snapshotContactCasFields,
  runCallContactCorrection,
  APPLYABLE_FIELDS,
  _private: { FIELD_VALIDATORS, CORRECTION_HINT_RE, CALL_CONFIDENCE_FLOOR, CALL_AUTO_FIELDS, CALL_PROPOSE_FIELDS, sameValue, addressGroupComplete },
};
