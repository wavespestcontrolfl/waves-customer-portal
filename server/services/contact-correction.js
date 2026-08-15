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
const CORRECTION_HINT_RE = /\b(wrong|incorrect|misspell\w*|spell\w*|typo|not my|isn'?t my|fix (?:my|the)|correct(?:ion)?|update (?:my|the)|change (?:my|the)|actually|moved|new (?:address|email))\b[\s\S]{0,80}\b(name|email|e-?mail|address|street|city|zip|unit|apt|apartment)\b|\b(name|email|e-?mail|address)\b[\s\S]{0,40}\b(wrong|incorrect|misspell\w*|is\b)/i;

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
    logger.warn(`[contact-correction] sms extraction failed: ${err.message}`);
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
async function applyContactCorrections({ customerId, corrections, source, sourceId = null, knex = db }) {
  const applied = [];
  const skipped = [];
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) {
      return { applied, skipped, reason: 'gate_off' };
    }
    if (!customerId || !Array.isArray(corrections) || !corrections.length) {
      return { applied, skipped, reason: 'nothing_to_apply' };
    }

    // Dedupe to one proposal per field (first wins) and validate shape.
    const byField = new Map();
    for (const correction of corrections) {
      const { field } = correction || {};
      if (byField.has(field)) { skipped.push({ field, reason: 'duplicate_field' }); continue; }
      const newValue = normValue(correction?.newValue);
      const validator = FIELD_VALIDATORS[field];
      if (!validator || !validator(newValue)) { skipped.push({ field, reason: 'invalid' }); continue; }
      byField.set(field, { field, newValue, quote: correction?.quote || null });
    }
    if (!addressGroupComplete(byField)) {
      for (const f of ADDRESS_FIELDS) {
        if (byField.has(f)) { skipped.push({ field: f, reason: 'incomplete_address' }); byField.delete(f); }
      }
    }
    if (!byField.size) return { applied, skipped, reason: 'nothing_valid' };

    let customerName = null;
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
        await require('./customer-properties').syncPrimaryAddress(after, trx);
        await require('./customer-address-fanout').propagateCustomerAddressChange({ before, after }, trx);
      }
      if (updates.email !== undefined) {
        await require('./customer-email-fanout').propagateCustomerEmailChange(
          { before, after, source: `contact-correction (${source})` }, trx,
        );
      }
      if (updates.first_name !== undefined || updates.last_name !== undefined) {
        await require('./customer-contact-fanout').propagateCustomerNameChange({ before, after }, trx);
      }
    });

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
        logger.warn(`[contact-correction] FYI bell failed for ${customerId}: ${err.message}`);
      });
      logger.info(`[contact-correction] applied ${applied.length} field(s) for customer ${customerId} via ${source}`);
    }
    return { applied, skipped };
  } catch (err) {
    // Transaction rolled back — nothing half-applied. Report the batch as
    // skipped rather than throwing into a webhook/pipeline caller.
    logger.warn(`[contact-correction] apply failed for ${customerId}: ${err.message}`);
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
    logger.warn(`[contact-correction] sms run failed: ${err.message}`);
    return { applied: [], skipped: [], reason: 'error' };
  }
}

/**
 * Call entry point — consumes the already-staged customer_field_candidates
 * for a processed call (the existing extraction mechanism; no second LLM
 * pass), on LINKED customers only, and ONLY when the caller's quoted words
 * carry correction intent: the staging writer records ordinary extracted
 * identity fields from every call, and a routine mention is not a mandate
 * to rewrite the profile. Stamps exactly the candidate rows whose value
 * was applied.
 */
const CALL_CONFIDENCE_FLOOR = 0.85;
const CALL_FIELD_MAP = Object.freeze({
  first_name: 'first_name',
  last_name: 'last_name',
  email: 'email',
  address_line1: 'address_line1',
  city: 'city',
  state: 'state',
  zip: 'zip',
  // phone deliberately absent — never applied.
});

async function runCallContactCorrection({ callId, customerId, knex = db }) {
  try {
    if (!require('../config/feature-gates').isEnabled('contactCorrection')) return { applied: [], skipped: [], reason: 'gate_off' };
    if (!callId || !customerId) return { applied: [], skipped: [], reason: 'unlinked' };
    if (!(await knex.schema.hasTable('customer_field_candidates'))) {
      return { applied: [], skipped: [], reason: 'no_table' };
    }
    const rows = await knex('customer_field_candidates')
      .where({ call_log_id: callId, status: 'pending' })
      .whereIn('field_name', Object.keys(CALL_FIELD_MAP))
      .whereNotNull('evidence_quote')
      .where(function confidenceFloor() {
        // The staging writer's confidence map never scores email (it only
        // scores caller_identity / service_address / service category), so
        // email candidates carry NULL confidence by construction — for
        // email the evidence-quote intent check below is the bar.
        this.where('confidence', '>=', CALL_CONFIDENCE_FLOOR)
          .orWhere(function emailNullConfidence() {
            this.where('field_name', 'email').whereNull('confidence');
          });
      })
      .select('id', 'field_name', 'final_recommended_value', 'evidence_quote');
    const candidates = rows.filter((c) => detectContactCorrectionIntent(c.evidence_quote));
    if (!candidates.length) return { applied: [], skipped: [], reason: 'no_candidates' };

    const corrections = candidates.map((c) => ({
      field: CALL_FIELD_MAP[c.field_name],
      newValue: c.final_recommended_value,
      quote: c.evidence_quote,
    }));
    const result = await applyContactCorrections({
      customerId,
      corrections,
      source: 'call',
      sourceId: callId,
      knex,
    });
    // Stamp only the candidate whose VALUE was applied — two pending
    // candidates for one field with different values must not both read as
    // auto_applied.
    const appliedIds = candidates
      .filter((c) => result.applied.some((a) => a.field === CALL_FIELD_MAP[c.field_name]
        && sameValue(a.field, a.newValue, c.final_recommended_value)))
      .map((c) => c.id);
    if (appliedIds.length) {
      await knex('customer_field_candidates')
        .whereIn('id', appliedIds)
        .update({ status: 'auto_applied', reviewed_at: new Date(), updated_at: new Date() })
        .catch((err) => logger.warn(`[contact-correction] candidate stamp failed for call ${callId}: ${err.message}`));
    }
    return result;
  } catch (err) {
    logger.warn(`[contact-correction] call run failed for ${callId}: ${err.message}`);
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
  _private: { FIELD_VALIDATORS, CORRECTION_HINT_RE, CALL_CONFIDENCE_FLOOR, CALL_FIELD_MAP, sameValue, addressGroupComplete },
};
