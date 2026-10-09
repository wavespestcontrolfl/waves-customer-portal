/**
 * Profile-enrichment writer — owner directive (2026-07-10): every legitimate
 * call must WRITE what it captured. The 1,000-call audit found extraction
 * 1.4.0 already captures gate codes / access notes / pets / preferences on
 * ~50 calls and NOTHING persisted them — property_preferences sat unwired.
 *
 * Behind GATE_CALL_PROFILE_ENRICHMENT. Rules:
 *  - property_preferences upsert is admin-edit-preserving: only NULL/empty
 *    columns are filled; free-text columns APPEND with a dated provenance tag
 *    rather than overwrite. An admin's manual value always survives.
 *  - Internal color (DIY history, competitor context, health/safety context,
 *    referral source) APPENDS to customers.internal_notes with provenance.
 *  - Every write is best-effort: an enrichment failure never fails the call.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

// Pull a gate/lockbox/garage code out of free-form access notes when the model
// heard one ("front gate code is 4545", "lockbox 6214"). Conservative: 3-8
// digit codes with an explicit keyword only.
function extractCodes(accessNotes) {
  const text = String(accessNotes || '');
  const grab = (re) => (text.match(re) || [])[1] || null;
  const codes = {
    property_gate_code: grab(/(?:front |main |property )?gate(?: code)?(?: is|:)? #?(\d{3,8})\b/i),
    neighborhood_gate_code: grab(/(?:neighborhood|community|entrance) (?:gate )?code(?: is|:)? #?(\d{3,8})\b/i),
    garage_code: grab(/garage(?: code)?(?: is|:)? #?(\d{3,8})\b/i),
    lockbox_code: grab(/lock ?box(?: code)?(?: is|:)? #?(\d{3,8})\b/i),
  };
  // "community gate code is 1234" also substring-matches the property regex —
  // a community code must never be stored as a property-level code the
  // customer didn't give.
  if (codes.property_gate_code && codes.property_gate_code === codes.neighborhood_gate_code) {
    codes.property_gate_code = null;
  }
  return codes;
}


// Schema 1.4.0+ shapes pets as { present, species_notes }; older/looser
// payloads used details/description. Read all, schema field first.
function petDetailsFrom(pets) {
  if (!pets) return null;
  const raw = pets.species_notes || pets.details || pets.description
    || (Array.isArray(pets) ? pets.join('; ') : null);
  return raw ? String(raw).slice(0, 1000) : null;
}

function appendWithProvenance(existing, addition, callDate, separator = '\n') {
  const tag = `[call ${String(callDate).slice(0, 10)}]`;
  const line = `${tag} ${addition}`.trim();
  if (!existing || !String(existing).trim()) return line;
  if (String(existing).includes(addition)) return existing; // idempotent reprocess
  return `${existing}${separator}${line}`;
}

// The provider bit stays append-only, like every other line here. A reprocess
// under a changed label ("Switching from" → "Other provider named") must not
// add a second, contradicting statement, so a provider this day's line already
// names is not named again. The date tag is not unique to one call, so nothing
// already written is rewritten or removed: the earlier line stands.
const PROVIDER_NOTE_LABELS = ['Switching from', 'Other provider named'];
function providerAlreadyNoted(existing, callDate, name) {
  if (!existing || !name) return false;
  const tag = `[call ${String(callDate).slice(0, 10)}] `;
  const bits = PROVIDER_NOTE_LABELS.map((label) => `${label}: ${name}`);
  return String(existing).split('\n').some((line) => line.startsWith(tag)
    && line.slice(tag.length).split(' | ').some((part) => bits.includes(part)));
}

/**
 * Enrich a customer's profile from a processed call's extraction.
 * @returns {{ applied: string[] }} which fields were written (for the audit log)
 */
async function enrichFromCall({ customerId, extraction, legacy = null, callCreatedAt = new Date() }) {
  if (!isEnabled('callProfileEnrichment')) return { applied: [], skipped: 'gate_off' };
  if (!customerId || !extraction) return { applied: [] };
  const applied = [];
  const prop = extraction.property || {};
  const accessNotes = prop.access_notes || null;
  const pets = prop.pets_on_property || null;

  try {
    if (accessNotes || pets) {
      // Same customer preference lock every preference writer holds (portal
      // saves, merges, SMS capture): the row read below is then current, not
      // a snapshot a concurrent writer can invalidate before this update.
      await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customerId)]);
        const existing = await trx('property_preferences').where({ customer_id: customerId }).forUpdate().first();
        const codes = extractCodes(accessNotes);
        if (!existing) {
          await trx('property_preferences').insert({
            customer_id: customerId,
            ...Object.fromEntries(Object.entries(codes).filter(([, v]) => v)),
            ...(petDetailsFrom(pets) ? { pet_details: petDetailsFrom(pets) } : {}),
            ...(accessNotes ? { access_notes: appendWithProvenance(null, String(accessNotes).slice(0, 800), callCreatedAt) } : {}),
          });
          applied.push('property_preferences_created');
          return;
        }
        const updates = {};
        // Fill-only-when-empty for structured fields — admin edits win forever.
        for (const [col, val] of Object.entries(codes)) {
          if (val && !existing[col]) updates[col] = val;
        }
        if (pets) {
          // Append (with provenance) rather than fill-only-empty: new pets and
          // safety context from later calls must persist; admin text survives
          // because appendWithProvenance never overwrites and dedupes repeats.
          const details = petDetailsFrom(pets);
          if (details) {
            const appended = appendWithProvenance(existing.pet_details, details, callCreatedAt);
            if (appended !== existing.pet_details) updates.pet_details = appended;
          }
        }
        if (accessNotes) {
          const appended = appendWithProvenance(existing.access_notes, String(accessNotes).slice(0, 800), callCreatedAt);
          if (appended !== existing.access_notes) updates.access_notes = appended;
        }
        if (Object.keys(updates).length) {
          await trx('property_preferences').where({ customer_id: customerId }).update({ ...updates, updated_at: new Date() });
          applied.push(...Object.keys(updates));
        }
      });
    }

    // Internal color → customers.internal_notes (append-only, provenance-tagged).
    const colorBits = [];
    if (legacy?.referred_by) colorBits.push(`Referred by: ${legacy.referred_by}`);
    if (Array.isArray(legacy?.pain_points) && legacy.pain_points.length) colorBits.push(`Context: ${legacy.pain_points.slice(0, 3).join('; ')}`);
    // A V2 customer_history block governs the provider: its null (a home
    // inspector, a realtor — no pest or lawn provider named) must not be
    // refilled from the legacy extraction, whose JSON has no such contract.
    // "Switching from" only when the caller is leaving that provider; one they
    // used years ago or only got a quote from is named without that claim.
    const history = extraction.customer_history && typeof extraction.customer_history === 'object'
      ? extraction.customer_history
      : null;
    const compName = history ? history.competitor_name : legacy?.competitor_name;
    const providerBit = compName
      ? `${history?.status === 'switching_from_competitor' ? 'Switching from' : 'Other provider named'}: ${compName}`
      : null;
    if (colorBits.length || providerBit) {
      const cust = await db('customers').where({ id: customerId }).first('internal_notes');
      if (cust) {
        if (providerBit && !providerAlreadyNoted(cust.internal_notes, callCreatedAt, compName)) colorBits.push(providerBit);
        const appended = colorBits.length
          ? appendWithProvenance(cust.internal_notes, colorBits.join(' | ').slice(0, 500), callCreatedAt)
          : cust.internal_notes;
        if (appended !== cust.internal_notes) {
          await db('customers').where({ id: customerId }).update({ internal_notes: appended, updated_at: new Date() });
          applied.push('internal_notes');
        }
      }
    }
  } catch (err) {
    logger.warn(`[profile-enrichment] failed for customer ${customerId}: ${err.message}`);
  }
  return { applied };
}

module.exports = { enrichFromCall, appendWithProvenance, _test: { extractCodes, appendWithProvenance, providerAlreadyNoted } };
