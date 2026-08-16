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
const CORRECTION_HINT_RE = /\b(wrong|incorrect|misspell\w*|spell\w*|typo|not my|isn'?t my|fix (?:my|the)|correct(?:ion)?|update (?:my|the)|change (?:my|the)|actually|new (?:address|email))\b[\s\S]{0,80}\b(name|email|e-?mail|address|street|city|zip|unit|apt|apartment)\b|\b(name|email|e-?mail|address|street|city|zip|unit|apt|apartment)\b[\s\S]{0,40}\b(wrong|incorrect|misspell\w*|is\b)|\b(?:we|i)(?:'ve| have)?\s+(?:just\s+)?moved\b|\bnew (?:e-?mail|email|address)\s*(?:\bis\b|:)|\b(?:name|email|e-?mail|address)\b[\s\S]{0,30}\bshould be\b|\b(?:update|change)\b[\s\S]{0,25}\b(?:name|email|e-?mail|address)\b[\s\S]{0,10}\bto\b|\b(?:my|our|the|your)\s+old\s+(?:e-?mail|email|address|apartment|unit)\b|\bno\s+(?:unit|apt|apartment)\b[\s\S]{0,40}\bold\b|\b(?:remove|drop|delete)\b[\s\S]{0,30}\b(?:unit|apt|apartment|suite)\b|\b(?:unit|apt|apartment|suite)\b[\s\S]{0,30}\b(?:no longer|removed|gone)\b/i;

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
const ADDR_TOPIC_SRC = '(?:address|street|city|zip|unit|apt|apartment|suite|lot)';
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
 * high-confidence, format-valid corrections only. Never throws.
 */
async function extractSmsContactCorrections({ body }) {
  try {
    const text = normValue(body);
    if (!text || !detectContactCorrectionIntent(text)) return [];
    const res = await callAnthropic({
      model: MODELS.FAST,
      system: EXTRACT_SYSTEM,
      text: `Inbound customer SMS:\n"""${text.slice(0, 1500)}"""`,
      jsonMode: true,
      maxTokens: 500,
    });
    const list = res?.ok && Array.isArray(res.json?.corrections) ? res.json.corrections : [];
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
      && quoteInBody(c.quote) && valueEvidenceOk(c) && clearEvidenceOk(c));
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
    // sentence. Message-level MOVE evidence still licenses the whole
    // message (a stated move IS one statement about where the customer
    // lives).
    const moveLicensed = MOVE_EVIDENCE_RE.test(text);
    const sentences = text.split(CLAUSE_SPLIT_RE)
      .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
    const sentenceIdxOf = (q) => {
      const needle = normValue(q).replace(/\s+/g, ' ').toLowerCase();
      return needle ? sentences.findIndex((s) => s.includes(needle)) : -1;
    };
    const licensedSentences = new Set();
    for (const c of base) {
      if (ADDRESS_FIELDS.includes(c.field) && quoteCarriesFieldIntent(c.field, c.quote)) {
        const idx = sentenceIdxOf(c.quote);
        if (idx >= 0) licensedSentences.add(idx);
      }
    }
    const addressLicensed = (c) => {
      if (moveLicensed) return true;
      if (quoteCarriesFieldIntent(c.field, c.quote)) return true;
      const idx = sentenceIdxOf(c.quote);
      return idx >= 0 && licensedSentences.has(idx);
    };
    return base
      .filter((c) => (ADDRESS_FIELDS.includes(c.field)
        ? addressLicensed(c)
        : quoteCarriesFieldIntent(c.field, c.quote)))
      // Component binding for name fields, same rule as the call lane: a
      // grounded quote naming only the LAST name ("my last name is Rivers,
      // not Riverz") is not evidence for a first_name entry the model
      // returned alongside it — the quote must bind to the component it
      // would mutate. Ownership disclaimers never count as name evidence.
      .filter((c) => !(c.field === 'first_name' || c.field === 'last_name')
        || (quoteBindsNameField(c.field, c.quote)
          && !NAME_OWNERSHIP_DISCLAIMER_RE.test(String(c.quote || ''))))
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
      .map((c) => ({ field: c.field, newValue: normValue(c.new_value), quote: normValue(c.quote) }));
  } catch (err) {
    logger.warn(`[contact-correction] sms extraction failed: ${errTag(err)}`);
    return [];
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
const MOVE_EVIDENCE_RE = /\b(?:we|i)(?:'ve| have)?\s+(?:just\s+|recently\s+)?(?:moved|(?:are|will be)\s+moving)\s+(?:to|into)\b|\bmoving\s+(?:to|into)\b|\bnew address\b/i;

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
    for (const entry of Array.from(byField.values())) {
      if (!ADDRESS_FIELDS.includes(entry.field)) {
        entry.newValue = entry.newValue === '' ? '' : normValue(canonicalizeValue(entry.field, entry.newValue));
      }
      if (!FIELD_VALIDATORS[entry.field](entry.newValue)) {
        skipped.push({ field: entry.field, reason: 'invalid' });
        byField.delete(entry.field);
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
      if (moveContext && byField.has('address_line1') && !byField.has('address_line2') && normValue(before.address_line2)) {
        updates.address_line2 = null;
        applied.push({ field: 'address_line2', oldValue: normValue(before.address_line2), newValue: null, quote: byField.get('address_line1')?.quote || null });
      }
      if (!Object.keys(updates).length) return;

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
        // Stale coords must not survive an address change — clear them in
        // the same statement window; the canonical admin path then
        // re-geocodes post-commit (mirrored below).
        await trx('customers').where({ id: customerId }).update({ latitude: null, longitude: null });
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

async function runSmsContactCorrectionInner({ customer, body, smsLogId = null, knex = db, senderPhone = null, matchedSnapshot = null }) {
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
    if (!corrections.length) return { applied: [], skipped: [], reason: 'none_detected' };
    return await applyContactCorrections({
      customerId: customer.id,
      corrections,
      source: 'sms',
      sourceId: smsLogId,
      knex,
      expectedValues: expectedValues || null,
      // The number the webhook matched this message FROM — binds the batch
      // to the original sender even if the customer's phone is reassigned
      // between the webhook match and the snapshot read above.
      senderPhone,
      // Message-level move evidence tightens the address-group requirement:
      // a stated move must carry street+city+zip, not locality alone.
      moveContext: MOVE_EVIDENCE_RE.test(String(body || '')),
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

async function runCallContactCorrection({ callId, customerId, knex = db, procToken = null, candidateIds = null }) {
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
        knex('call_log').where({ id: callId }).first('from_phone', 'transcription', 'processing_token'),
        knex('customers').where({ id: customerId }).first('phone', 'first_name', 'last_name'),
      ]);
      const callerTail = tail10(call?.from_phone);
      callerIsPrimary = Boolean(callerTail) && callerTail === tail10(owner?.phone);
      // Snapshot for the compare-and-set in the apply transaction — a name
      // an admin corrected between this read and the commit must not be
      // overwritten by this pass's staged (older) extraction; the phone is
      // the identity anchor and stales the whole batch if reassigned.
      if (owner) expectedValues = { first_name: owner.first_name, last_name: owner.last_name, phone: owner.phone };
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
    const callerLines = String(call?.transcription || '')
      .split(/\r?\n/)
      .filter((line) => /^\s*caller\s*:/i.test(line))
      .map((line) => line.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
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
      if (!quoteGrounded(c.evidence_quote)) return false;
      if (seenFields.has(c.field_name)) return false;
      seenFields.add(c.field_name);
      return true;
    });
    if (!candidates.length) return { applied: [], skipped: [], reason: 'no_candidates' };

    // Email/address: propose, never write. One bell for the batch; the
    // candidate rows stay pending for review on the customer page.
    const proposals = candidates.filter((c) => CALL_PROPOSE_FIELDS.includes(c.field_name));
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

    const nameCandidates = (callerIsPrimary
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
      // The number the call actually came FROM (captured at processing time)
      // — same original-sender batch binding as the SMS lane.
      senderPhone: call?.from_phone || null,
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
