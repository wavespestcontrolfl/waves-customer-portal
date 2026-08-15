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
const CORRECTION_HINT_RE = /\b(wrong|incorrect|misspell\w*|spell\w*|typo|not my|isn'?t my|fix (?:my|the)|correct(?:ion)?|update (?:my|the)|change (?:my|the)|actually|new (?:address|email))\b[\s\S]{0,80}\b(name|email|e-?mail|address|street|city|zip|unit|apt|apartment)\b|\b(name|email|e-?mail|address)\b[\s\S]{0,40}\b(wrong|incorrect|misspell\w*|is\b)|\b(?:we|i)(?:'ve| have)?\s+(?:just\s+)?moved\b|\bnew (?:e-?mail|email|address)\s*(?:\bis\b|:)|\b(?:name|email|e-?mail|address)\b[\s\S]{0,30}\bshould be\b|\b(?:update|change)\b[\s\S]{0,25}\b(?:name|email|e-?mail|address)\b[\s\S]{0,10}\bto\b|\b(?:my|our|the|your)\s+old\s+(?:e-?mail|email|address|apartment|unit)\b|\bno\s+(?:unit|apt|apartment)\b[\s\S]{0,40}\bold\b/i;

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
const CW_SRC = '(?:wrong|incorrect|misspell\\w*|spell\\w*|typo|actually|correct\\w*|fix\\w*|updat\\w*|chang\\w*|should\\s+be|not\\b|new\\b|old\\b)';
const NAME_CLAUSE_RE = new RegExp(`\\b(?:name|surname)\\b[\\s\\S]{0,60}${CW_SRC}|${CW_SRC}[\\s\\S]{0,60}\\b(?:name|surname)\\b`, 'i');
const EMAIL_CLAUSE_RE = new RegExp(`\\be-?mail\\b[\\s\\S]{0,60}${CW_SRC}|${CW_SRC}[\\s\\S]{0,60}\\be-?mail\\b`, 'i');
const ADDR_TOPIC_SRC = '(?:address|street|city|zip|unit|apt|apartment|suite|lot)';
const ADDRESS_CLAUSE_RE = new RegExp(`\\b${ADDR_TOPIC_SRC}\\b[\\s\\S]{0,60}${CW_SRC}|${CW_SRC}[\\s\\S]{0,60}\\b${ADDR_TOPIC_SRC}\\b`, 'i');
const CLAUSE_SPLIT_RE = /[;!?\n]+|\.(?=\s|$)/;
function quoteCarriesFieldIntent(field, quote) {
  const clauses = normValue(quote).split(CLAUSE_SPLIT_RE);
  if (field === 'email') return clauses.some((cl) => EMAIL_CLAUSE_RE.test(cl));
  if (ADDRESS_FIELDS.includes(field)) {
    // A stated move IS address-correction language even without the word
    // "address" ("we just moved to 99 Pine Ave").
    return clauses.some((cl) => MOVE_EVIDENCE_RE.test(cl) || ADDRESS_CLAUSE_RE.test(cl));
  }
  return clauses.some((cl) => NAME_CLAUSE_RE.test(cl));
}

// Post-extraction format guards — the model proposes, these dispose.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L}][\p{L}'. -]{0,79}$/u;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const ADDRESS_RE = /^[\p{L}\p{N}][\p{L}\p{N}#'.,/ -]{0,119}$/u;

const FIELD_VALIDATORS = {
  first_name: (v) => NAME_RE.test(v),
  last_name: (v) => NAME_RE.test(v),
  email: (v) => EMAIL_RE.test(v) && v.length <= 254,
  address_line1: (v) => ADDRESS_RE.test(v),
  // Empty = explicit clear ("no unit, that was our old apartment") — the
  // only field where an empty replacement is a valid correction.
  address_line2: (v) => v === '' || ADDRESS_RE.test(v),
  city: (v) => NAME_RE.test(v),
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
    // value the customer never typed never applies. Empty = explicit clear,
    // which carries no text by definition.
    const valueInBody = (v) => {
      const needle = normValue(v).replace(/\s+/g, ' ').toLowerCase();
      return needle === '' || haystack.includes(needle);
    };
    const base = list.filter((c) => c && c.confidence === 'high' && APPLYABLE_FIELDS.includes(c.field)
      && quoteInBody(c.quote) && valueInBody(c.new_value));
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
    const addressGroupLicensed = MOVE_EVIDENCE_RE.test(text)
      || base.some((c) => ADDRESS_FIELDS.includes(c.field) && quoteCarriesFieldIntent(c.field, c.quote));
    return base
      .filter((c) => (ADDRESS_FIELDS.includes(c.field)
        ? addressGroupLicensed
        : quoteCarriesFieldIntent(c.field, c.quote)))
      // Component binding for name fields, same rule as the call lane: a
      // grounded quote naming only the LAST name ("my last name is Rivers,
      // not Riverz") is not evidence for a first_name entry the model
      // returned alongside it — the quote must bind to the component it
      // would mutate. Ownership disclaimers never count as name evidence.
      .filter((c) => !(c.field === 'first_name' || c.field === 'last_name')
        || (quoteBindsNameField(c.field, c.quote)
          && !NAME_OWNERSHIP_DISCLAIMER_RE.test(String(c.quote || ''))))
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
async function applyContactCorrections({ customerId, corrections, source, sourceId = null, knex = db, postApply = null, moveContext = false, expectedValues = null }) {
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
      // A full new street implies the old unit is gone unless the message
      // restated one — clear address_line2 alongside the group.
      if (updates.address_line1 !== undefined && !byField.has('address_line2') && normValue(before.address_line2)) {
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
        // explicitLine2: this lane's line2 writes are deliberate (explicit
        // unit clear, whole-street move auto-clear, promoted inline unit) —
        // a null must CLEAR the primary property's unit, not fall back to it.
        await require('./customer-properties').syncPrimaryAddress(after, trx, {
          explicitLine2: updates.address_line2 !== undefined,
        });
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
async function runSmsContactCorrection({ customer, body, smsLogId = null, knex = db }) {
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) return { applied: [], skipped: [], reason: 'gate_off' };
    if (!customer?.id) return { applied: [], skipped: [], reason: 'unlinked' };
    // Pre-extraction snapshot for the compare-and-set inside the apply
    // transaction: extraction is an in-flight LLM call, and a field an admin
    // (or a newer message) changed underneath it must not be overwritten by
    // this pass's stale proposal.
    // Includes phone (round-10): the sender's number is the batch's identity
    // anchor — a concurrent phone change/reassignment stales the whole batch.
    const expectedValues = await knex('customers')
      .where({ id: customer.id })
      .whereNull('deleted_at')
      .first([...APPLYABLE_FIELDS, 'phone']);
    const corrections = await extractSmsContactCorrections({ body });
    if (!corrections.length) return { applied: [], skipped: [], reason: 'none_detected' };
    return await applyContactCorrections({
      customerId: customer.id,
      corrections,
      source: 'sms',
      sourceId: smsLogId,
      knex,
      expectedValues: expectedValues || null,
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
const CALL_NAME_CORRECTION_RE = /\b(?:name|surname)\b[\s\S]{0,60}\b(?:wrong|incorrect|misspell\w*|typo|actually|correct\w*|not\b)|\b(?:wrong|incorrect|misspell\w*|typo|actually|correct\w*|not(?:\s+(?:my|the))?)\b[\s\S]{0,60}\b(?:name|surname)\b/i;

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

async function runCallContactCorrection({ callId, customerId, knex = db, procToken = null }) {
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) return { applied: [], skipped: [], reason: 'gate_off' };
    if (!callId || !customerId) return { applied: [], skipped: [], reason: 'unlinked' };
    if (!(await knex.schema.hasTable('customer_field_candidates'))) {
      return { applied: [], skipped: [], reason: 'no_table' };
    }
    const rows = await knex('customer_field_candidates')
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
    const tail10 = (p) => String(p || '').replace(/[^0-9]/g, '').slice(-10);
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

    const seenFields = new Set();
    const candidates = rows.filter((c) => {
      // Name candidates take the stricter explicit-correction bar — routine
      // calls state names constantly. Email/address proposals take the same
      // clause-bound field predicate as the SMS lane (round-10): "my email
      // is jane@example.com" while booking is identity collection, and a
      // bell claiming corrected info was stated would be a false proposal.
      const intentOk = CALL_AUTO_FIELDS[c.field_name]
        ? (CALL_NAME_CORRECTION_RE.test(String(c.evidence_quote || ''))
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

    const nameCandidates = callerIsPrimary
      ? candidates.filter((c) => CALL_AUTO_FIELDS[c.field_name]
        && quoteBindsNameField(c.field_name, c.evidence_quote))
      : [];
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
  runCallContactCorrection,
  APPLYABLE_FIELDS,
  _private: { FIELD_VALIDATORS, CORRECTION_HINT_RE, CALL_CONFIDENCE_FLOOR, CALL_AUTO_FIELDS, CALL_PROPOSE_FIELDS, sameValue, addressGroupComplete },
};
