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
const CORRECTION_HINT_RE = /\b(wrong|incorrect|misspell\w*|spell\w*|typo|not my|isn'?t my|fix (?:my|the)|correct(?:ion)?|update (?:my|the)|change (?:my|the)|actually|new (?:address|email))\b[\s\S]{0,80}\b(name|email|e-?mail|address|street|city|zip|unit|apt|apartment)\b|\b(name|email|e-?mail|address)\b[\s\S]{0,40}\b(wrong|incorrect|misspell\w*|is\b)|\b(?:we|i)(?:'ve| have)?\s+(?:just\s+)?moved\b/i;

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

// Canonical normalization (same utilities the Customer-360 path uses) so an
// extracted "fl" / "RIVERS" / double-spaced street stores in house shape.
// properCase preserves deliberate mixed casing (McDonald, O'Brien), so this
// composes with the case-sensitive compare rather than fighting it.
const { normalizeEmail, properCaseName, collapseWhitespace } = require('../utils/contact-normalize');
function canonicalizeValue(field, value) {
  const v = collapseWhitespace(value);
  if (field === 'email') return normalizeEmail(v);
  if (field === 'first_name' || field === 'last_name' || field === 'city') return properCaseName(v);
  if (field === 'state') return String(v).toUpperCase();
  return v;
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
    return list
      .filter((c) => c && c.confidence === 'high' && APPLYABLE_FIELDS.includes(c.field))
      .map((c) => ({ field: c.field, newValue: normValue(c.new_value), quote: normValue(c.quote) || null }));
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
async function applyContactCorrections({ customerId, corrections, source, sourceId = null, knex = db, postApply = null }) {
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
    // first), validate shape, then canonicalize into house form.
    const byField = new Map();
    for (const correction of corrections) {
      const { field } = correction || {};
      if (byField.has(field)) { skipped.push({ field, reason: 'duplicate_field' }); continue; }
      const rawValue = normValue(correction?.newValue);
      const validator = FIELD_VALIDATORS[field];
      if (!validator || !validator(rawValue)) { skipped.push({ field, reason: 'invalid' }); continue; }
      const newValue = rawValue === '' ? '' : normValue(canonicalizeValue(field, rawValue));
      byField.set(field, { field, newValue, quote: correction?.quote || null });
    }
    if (!addressGroupComplete(byField)) {
      for (const f of ADDRESS_FIELDS) {
        if (byField.has(f)) { skipped.push({ field: f, reason: 'incomplete_address' }); byField.delete(f); }
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

      const updates = {};
      for (const { field, newValue, quote } of byField.values()) {
        if (sameValue(field, before[field], newValue)) { skipped.push({ field, reason: 'unchanged' }); continue; }
        // A corrected email that already belongs to ANOTHER account is not a
        // correction we may auto-apply — fanning queued sends out to a
        // mailbox owned by a different customer is the failure mode the
        // canonical Customer-360 path blocks with its cross-account conflict
        // check. Same semantics here (email only; phone is never applied).
        if (field === 'email') {
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
        await require('./customer-properties').syncPrimaryAddress(after, trx);
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
      require('./geocoder').ensureCustomerGeocoded(customerId)
        .then((coords) => coords && require('./customer-properties').syncPrimaryCoordsFromCustomer(customerId))
        .catch(() => {});
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
async function runSmsContactCorrection({ customer, body, smsLogId = null }) {
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) return { applied: [], skipped: [], reason: 'gate_off' };
    if (!customer?.id) return { applied: [], skipped: [], reason: 'unlinked' };
    const corrections = await extractSmsContactCorrections({ body });
    if (!corrections.length) return { applied: [], skipped: [], reason: 'none_detected' };
    return await applyContactCorrections({
      customerId: customer.id,
      corrections,
      source: 'sms',
      sourceId: smsLogId,
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
const CALL_PROPOSE_FIELDS = Object.freeze(['email', 'address_line1', 'city', 'state', 'zip']);

async function runCallContactCorrection({ callId, customerId, knex = db }) {
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
    const seenFields = new Set();
    const candidates = rows.filter((c) => {
      if (!detectContactCorrectionIntent(c.evidence_quote)) return false;
      if (seenFields.has(c.field_name)) return false;
      seenFields.add(c.field_name);
      return true;
    });
    if (!candidates.length) return { applied: [], skipped: [], reason: 'no_candidates' };

    // Caller-identity guard: a call from a service_contact*_phone links to
    // the OWNING customer, but the caller correcting their own name is not
    // a mandate to rename the account owner. Name auto-apply requires the
    // call to have come from the customer's PRIMARY phone; everything else
    // stays in the proposal/pending lane.
    const tail10 = (p) => String(p || '').replace(/[^0-9]/g, '').slice(-10);
    let callerIsPrimary = false;
    try {
      const [call, owner] = await Promise.all([
        knex('call_log').where({ id: callId }).first('from_phone'),
        knex('customers').where({ id: customerId }).first('phone'),
      ]);
      const callerTail = tail10(call?.from_phone);
      callerIsPrimary = Boolean(callerTail) && callerTail === tail10(owner?.phone);
    } catch { callerIsPrimary = false; }

    // Email/address: propose, never write. One bell for the batch; the
    // candidate rows stay pending for review on the customer page.
    const proposals = candidates.filter((c) => CALL_PROPOSE_FIELDS.includes(c.field_name));
    if (proposals.length) {
      const lines = proposals.map((p) => `${p.field_name}: ${normValue(p.final_recommended_value)}`).join('; ');
      await require('./notification-service').notifyAdmin(
        'customer',
        'Contact corrections proposed from a call',
        `The caller stated corrected contact info on a recorded call — ${lines}. `
          + 'Spoken email/address values are not auto-applied; review and apply from the customer page.',
        {
          link: `/admin/customers?customerId=${customerId}`,
          bell: true,
          metadata: { customerId, source: 'call', sourceId: callId, proposed: proposals.map((p) => p.field_name) },
        },
      ).catch((err) => logger.warn(`[contact-correction] proposal bell failed for call ${callId}: ${errTag(err)}`));
    }

    const nameCandidates = callerIsPrimary
      ? candidates.filter((c) => CALL_AUTO_FIELDS[c.field_name])
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
      // Same-transaction stamp of exactly the candidate rows whose VALUE was
      // applied — two pending candidates for one field with different values
      // must not both read as auto_applied, and an applied field can never
      // commit without its stamp.
      postApply: async (trx, applied) => {
        const appliedIds = nameCandidates
          .filter((c) => applied.some((a) => a.field === CALL_AUTO_FIELDS[c.field_name]
            && sameValue(a.field, a.newValue, c.final_recommended_value)))
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
