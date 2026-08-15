/**
 * property-role-proposals.js — classify each property a call discusses
 * (primary residence / rental / seasonal / …) and turn the classification
 * into either a SAFE direct fill or a parked one-click confirm, never a
 * silent guess (owner directive 2026-08-15,
 * after a 2026-08-13 multi-property call left a customer's portfolio inverted: the new primary residence recorded as a
 * secondary property, the rental still flagged primary, and the mirror +
 * pending quarterlies needing a by-hand swap).
 *
 * Two lanes, both behind GATE_CALL_PROPERTY_ROLE:
 *  - FILL (applied directly): a classified occupancy lands on a row whose
 *    occupancy_type is still 'unknown' — fill-only, same doctrine as the
 *    #3399 enrichment COALESCE writes, trivially reversible in admin.
 *  - PROPOSAL (parked): anything that CHANGES existing facts — a stored
 *    occupancy that contradicts the call, or a primary-residence flip —
 *    parks a 'property_role_confirm' triage card. The office applies it
 *    with one click (applyPropertyRoleProposals) or dismisses it.
 *
 * The apply path executes the same runbook that inversion's manual
 * correction used, in one transaction: pin unstamped pending visits to the OLD primary
 * (they were booked when it was the service address), demote it, promote
 * the new primary, then re-mirror customers.address_* — the mirror
 * invariant (customers.address_* = primary property) survives the flip.
 */

const logger = require('./logger');
const {
  OCCUPANCY_TYPES,
  addressKey,
  normalizeOccupancy,
} = require('./customer-properties');
const { resolveLocation } = require('../config/locations');

const REASON_CODE = 'property_role_confirm';
// Visit statuses that are already settled — never re-pin those.
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped'];
// Occupancies that earn a human-readable label suggestion on a flip/change.
const LABEL_BY_OCCUPANCY = { rental_investment: 'Rental', seasonal: 'Seasonal' };

function knownOccupancy(value) {
  const norm = normalizeOccupancy(value);
  return norm && norm !== 'unknown' ? norm : null;
}

function shortAddress(row) {
  return [row.address_line1, row.address_line2, row.city].filter(Boolean).join(', ');
}

/**
 * Build the classified-property list from a call's extraction. Each entry:
 * { address_line1, address_line2, city, zip, occupancy|null,
 *   is_primary_residence: true|false|null, evidence|null }
 * Only entries with a street survive; occupancy is normalized to the enum.
 */
function classifiedPropertiesFromExtraction(extracted = {}, additionalProps = []) {
  const out = [];
  if (String(extracted.address_line1 || '').trim()) {
    out.push({
      address_line1: extracted.address_line1,
      address_line2: extracted.address_line2 || null,
      city: extracted.city || null,
      zip: extracted.zip || null,
      occupancy: knownOccupancy(extracted.service_address_occupancy),
      is_primary_residence: typeof extracted.service_address_is_primary_residence === 'boolean'
        ? extracted.service_address_is_primary_residence
        : null,
      evidence: null,
    });
  }
  for (const extra of Array.isArray(additionalProps) ? additionalProps : []) {
    if (!extra || !String(extra.address_line1 || '').trim()) continue;
    out.push({
      address_line1: extra.address_line1,
      address_line2: extra.address_line2 || null,
      city: extra.city || null,
      zip: extra.zip || null,
      occupancy: knownOccupancy(extra.occupancy) || (extra.is_rental === true ? 'rental_investment' : null),
      is_primary_residence: typeof extra.is_primary_residence === 'boolean' ? extra.is_primary_residence : null,
      evidence: extra.notes || null,
    });
  }
  return out;
}

/**
 * The extraction schema does not enforce unique addresses — one property can
 * appear both as the main entry and again in additional_properties. Merge
 * duplicates by addressKey so a single address yields ONE classification
 * (codex #3418 r6): agreeing signals combine; a conflicting occupancy or
 * primary-residence claim across duplicates means the model contradicted
 * itself about that address, so that signal is DROPPED (logged), never
 * resolved by array order. Keyless entries can't be grouped (or matched to
 * rows) and pass through untouched.
 */
function dedupeClassified(classified) {
  const out = [];
  const byKey = new Map();
  for (const entry of classified) {
    const key = addressKey(entry);
    if (!key) { out.push(entry); continue; }
    const prev = byKey.get(key);
    if (!prev) {
      const merged = { ...entry };
      byKey.set(key, merged);
      out.push(merged);
      continue;
    }
    if (entry.occupancy) {
      if (prev._occupancy_conflict || (prev.occupancy && prev.occupancy !== entry.occupancy)) {
        logger.warn('[property-role] one address classified with conflicting occupancies across duplicate entries — occupancy signal dropped for that address');
        prev.occupancy = null;
        prev._occupancy_conflict = true;
      } else if (!prev.occupancy) {
        prev.occupancy = entry.occupancy;
      }
    }
    if (typeof entry.is_primary_residence === 'boolean') {
      if (prev._primary_conflict
        || (typeof prev.is_primary_residence === 'boolean' && prev.is_primary_residence !== entry.is_primary_residence)) {
        logger.warn('[property-role] one address carries conflicting primary-residence claims across duplicate entries — claim dropped for that address');
        prev.is_primary_residence = null;
        prev._primary_conflict = true;
      } else if (prev.is_primary_residence === null) {
        prev.is_primary_residence = entry.is_primary_residence;
      }
    }
    if (!prev.evidence && entry.evidence) prev.evidence = entry.evidence;
  }
  return out;
}

/**
 * Pure core: match classified properties to the customer's current rows and
 * split into direct fills vs parked proposals.
 *
 * Returns { fills: [{property_id, occupancy}],
 *           proposals: [occupancy_change|primary_flip entries] }.
 * A primary flip is proposed only when EXACTLY ONE mentioned property is
 * classified as the caller's primary residence and it is not already the
 * primary row — two claimants is a model contradiction, so nothing flips.
 */
function buildPropertyRoleProposals({ classified: rawClassified = [], properties = [] }) {
  const classified = dedupeClassified(rawClassified);
  const fills = [];
  const proposals = [];
  const rowsByKey = new Map();
  for (const row of properties) {
    const key = addressKey(row);
    if (key) rowsByKey.set(key, row);
  }
  const currentPrimary = properties.find((p) => p.is_primary) || null;

  // Contradiction is judged across ALL classified entries, matched or not
  // (codex #3418 r4): an unmatched claimant — e.g. an extra whose
  // incomplete city/ZIP meant no row was persisted — still proves the
  // extraction contradicts itself, and a flip must not ride the one claim
  // that happened to match a row.
  const claimedPrimaryTotal = classified.filter((c) => c.is_primary_residence === true
    && (!c.occupancy || c.occupancy === 'owner_occupied')).length;

  const primaryClaims = [];
  for (const entry of classified) {
    const key = addressKey(entry);
    const row = key ? rowsByKey.get(key) : null;
    if (!row) continue; // nothing durable to label — the persistence step records rows first

    if (entry.occupancy) {
      const stored = knownOccupancy(row.occupancy_type);
      if (!stored) {
        fills.push({ property_id: row.id, occupancy: entry.occupancy });
      } else if (stored !== entry.occupancy) {
        proposals.push({
          kind: 'occupancy_change',
          property_id: row.id,
          address: shortAddress(row),
          current_occupancy: stored,
          proposed_occupancy: entry.occupancy,
          proposed_label: !row.label ? (LABEL_BY_OCCUPANCY[entry.occupancy] || null) : null,
          evidence: entry.evidence || null,
        });
      }
    }
    // A primary-residence claim contradicted by the SAME entry's occupancy
    // (a rental/seasonal/commercial/vacant property is by definition not
    // the home the caller lives in) is a model inconsistency — drop the
    // claim rather than let it drive a flip (codex #3418 r2).
    if (entry.is_primary_residence === true) {
      if (entry.occupancy && entry.occupancy !== 'owner_occupied') {
        logger.warn('[property-role] primary-residence claim contradicts its own occupancy classification — claim dropped');
      } else {
        primaryClaims.push({ entry, row });
      }
    }
  }

  if (claimedPrimaryTotal > 1) {
    logger.warn(`[property-role] ${claimedPrimaryTotal} properties classified as primary residence on one call — skipping flip proposal (contradiction)`);
  } else if (primaryClaims.length === 1) {
    const { entry, row } = primaryClaims[0];
    if (!row.is_primary) {
      // The demoted row's suggested role: the call's classification of it if
      // given, else what's already stored, else no change.
      const oldRow = currentPrimary;
      const oldClassified = oldRow
        ? classified.find((c) => addressKey(c) === addressKey(oldRow)) || null
        : null;
      const oldOccupancy = oldClassified?.occupancy || (oldRow ? knownOccupancy(oldRow.occupancy_type) : null);
      proposals.push({
        kind: 'primary_flip',
        new_primary_property_id: row.id,
        new_primary_address: shortAddress(row),
        old_primary_property_id: oldRow ? oldRow.id : null,
        old_primary_address: oldRow ? shortAddress(oldRow) : null,
        old_primary_occupancy: oldOccupancy,
        old_primary_label: oldRow && !['Primary', null, ''].includes(oldRow.label || null)
          ? null // already has a meaningful label — keep it
          : (LABEL_BY_OCCUPANCY[oldOccupancy] || null),
        evidence: entry.evidence || null,
      });
    }
  }

  return { fills, proposals };
}

/**
 * Pipeline entry point (fail-soft, gated by the caller): apply fills
 * directly, and park a triage card when there are proposals. `db` is the
 * shared knex instance; `buildTriageItem` is injected to avoid a require
 * cycle with call-routing-gates.
 */
// A reprocessed extraction that no longer supports any proposal must not
// leave a stale open card presenting superseded evidence (codex #3418 r3).
// Resolving our own advisory card is the same self-cleanup shape as the
// transcript-rejection path's stale-card dismissal; single row by the
// open-unique index, under the shared per-call triage lock.
async function resolveSupersededCard(db, callLogId) {
  try {
    const { lockTriageCall } = require('../utils/triage-locks');
    await db.transaction(async (trx) => {
      await lockTriageCall(trx, callLogId);
      const resolved = await trx('triage_items')
        .where({ call_log_id: callLogId, reason_code: REASON_CODE })
        .whereIn('status', ['open', 'in_progress'])
        .update({
          status: 'resolved',
          resolution_note: 'Superseded — the reprocessed extraction proposes no property-role changes.',
          resolved_at: new Date(),
          updated_at: new Date(),
        });
      // Same call_log.review_status aggregation as the triage transitions
      // (codex #3418 r4): resolving the call's last live card must move the
      // aggregate off 'open'.
      if (resolved > 0) {
        const stillOpen = await trx('triage_items')
          .where({ call_log_id: callLogId })
          .whereIn('status', ['open', 'in_progress'])
          .count('* as n')
          .first();
        const remaining = parseInt(stillOpen?.n || 0, 10);
        await trx('call_log')
          .where({ id: callLogId })
          .update({ review_status: remaining > 0 ? 'open' : 'resolved', updated_at: new Date() });
      }
    });
  } catch (e) {
    logger.warn(`[property-role] superseded-card cleanup skipped: ${e.code || e.name || 'db_error'}`);
  }
}

async function stagePropertyRoleReview({
  db, customerId, callLogId, extracted, additionalProps, extraction, buildTriageItem,
}) {
  const classified = classifiedPropertiesFromExtraction(extracted, additionalProps);
  if (!classified.some((c) => c.occupancy || c.is_primary_residence === true)) {
    await resolveSupersededCard(db, callLogId);
    return { fills: 0, parked: false };
  }

  const properties = await db('customer_properties')
    .where({ customer_id: customerId, active: true })
    .select('id', 'address_line1', 'address_line2', 'city', 'zip', 'occupancy_type', 'is_primary', 'label');
  const { fills, proposals } = buildPropertyRoleProposals({ classified, properties });

  for (const fill of fills) {
    // Fill-only fence: the row must still be unlabeled — a concurrent admin
    // edit wins over the call's classification.
    await db('customer_properties')
      .where({ id: fill.property_id, customer_id: customerId, active: true })
      .whereIn('occupancy_type', ['unknown'])
      .update({ occupancy_type: fill.occupancy, updated_at: new Date() });
  }

  let parked = false;
  if (!proposals.length) {
    await resolveSupersededCard(db, callLogId);
  } else {
    const card = buildTriageItem({
      callLogId,
      flag: REASON_CODE,
      extraction,
      severity: 'advisory',
      extraPayload: { customer_id: customerId, property_role_proposals: proposals },
    });
    // MERGE, not ignore, on the open-card unique (codex #3418 r1): a
    // force-reprocessed call re-derives its classification, and the open
    // card must present the NEWEST proposals. The write runs under the
    // shared per-call triage lock (codex #3418 r5) so it serializes with
    // Apply's locked read-then-resolve — a refresh can no longer land
    // between Apply's payload read and its resolve.
    const { lockTriageCall } = require('../utils/triage-locks');
    await db.transaction(async (trx) => {
      await lockTriageCall(trx, callLogId);
      await trx('triage_items')
        .insert(card)
        .onConflict(trx.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
        .merge({ payload: card.payload, summary: card.summary, updated_at: new Date() });
    });
    parked = true;
  }
  return { fills: fills.length, parked };
}

/**
 * One-click apply (admin route): execute every proposal on the card inside
 * the caller's transaction. Proposals are re-validated against CURRENT rows
 * — a row that changed hands, deactivated, or already matches is skipped,
 * never guessed at. Returns { applied, skipped } counts.
 *
 * Primary-flip runbook (the 2026-08-14 manual correction, mechanized):
 *  1. pin the customer's unstamped non-terminal visits to the OLD primary
 *     (property_id + service_address_*) — they were booked when it was the
 *     service address, and must not silently follow the mirror;
 *  2. demote the old primary (one_primary partial unique: demote BEFORE
 *     promote), applying its proposed occupancy/label;
 *  3. promote the new primary (occupancy owner_occupied, label 'Primary');
 *  4. re-mirror customers.address_* / coords / nearest_location_id from the
 *     new primary (city-first resolver, same as the call pipeline).
 * No customer communications fire from any of these writes.
 */
async function applyPropertyRoleProposals(trx, { customerId, proposals = [] }) {
  let applied = 0;
  let skipped = 0;

  // LOCK ORDER: the customers row FIRST, then customer_properties — the
  // same order admin-customers' address save uses (customer → primary
  // property). Locking properties first here could deadlock against a
  // concurrent Customer 360 save (codex #3418 r5).
  await trx('customers').where({ id: customerId }).forUpdate().first();

  for (const p of proposals) {
    if (p.kind === 'occupancy_change') {
      const occupancy = normalizeOccupancy(p.proposed_occupancy);
      if (!OCCUPANCY_TYPES.includes(occupancy) || occupancy === 'unknown') { skipped += 1; continue; }
      // Compare-and-swap on the occupancy the card was judged against — an
      // admin edit that landed after the card was parked wins; the stale
      // proposal skips rather than overwriting the newer human fact.
      const n = await trx('customer_properties')
        .where({
          id: p.property_id,
          customer_id: customerId,
          active: true,
          occupancy_type: p.current_occupancy,
        })
        .update({ occupancy_type: occupancy, updated_at: new Date() });
      // The label suggestion lands only on a still-empty label, fenced in
      // the predicate — an admin's label-only edit after staging survives
      // (codex #3418 r4 P2).
      if (n > 0 && p.proposed_label) {
        await trx('customer_properties')
          .where({ id: p.property_id, customer_id: customerId, active: true })
          .whereNull('label')
          .update({ label: p.proposed_label, updated_at: new Date() });
      }
      if (n > 0) applied += 1; else skipped += 1;
      continue;
    }

    if (p.kind === 'primary_flip') {
      const newPrimary = await trx('customer_properties')
        .where({ id: p.new_primary_property_id, customer_id: customerId, active: true })
        .first();
      if (!newPrimary) { skipped += 1; continue; }
      if (newPrimary.is_primary) { applied += 1; continue; } // already done — idempotent re-click

      const oldPrimary = await trx('customer_properties')
        .where({ customer_id: customerId, is_primary: true, active: true })
        .first();
      // Stale-state fence: the flip was judged against the portfolio the
      // card recorded. If the CURRENT primary is a different row than the
      // card's old_primary (someone re-arranged the portfolio since the
      // call), skip rather than reinterpret the click against state the
      // reviewer never saw.
      if ((oldPrimary ? oldPrimary.id : null) !== (p.old_primary_property_id || null)) {
        skipped += 1;
        continue;
      }

      if (oldPrimary) {
        // Estimate-born visits are excluded: their effective address comes
        // from the creating estimate (which may target another property),
        // so blanket-pinning them to the old primary could re-home them —
        // the estimate-property-linkage pass owns those (codex #3418 r4).
        await trx('scheduled_services')
          .where({ customer_id: customerId })
          .whereNull('property_id')
          .whereNull('service_address_line1')
          .whereNull('source_estimate_id')
          .whereNotIn('status', TERMINAL_VISIT_STATUSES)
          .update({
            property_id: oldPrimary.id,
            service_address_line1: oldPrimary.address_line1,
            service_address_line2: oldPrimary.address_line2 || null,
            service_address_city: oldPrimary.city,
            service_address_state: oldPrimary.state || 'FL',
            service_address_zip: oldPrimary.zip,
            // Coordinates ride the stamp (codex #3418 r5): once the
            // customer mirror flips, stampedDivergesSql disables the
            // customer-coord fallback for these rows — without their own
            // lat/lng, dispatch and route optimization would go blind.
            lat: oldPrimary.latitude ?? null,
            lng: oldPrimary.longitude ?? null,
            updated_at: new Date(),
          });

        // Coordinate backfill for visits ALREADY identified as the old
        // primary (codex #3418 r6): a non-terminal row linked by
        // property_id or address-stamped to the old primary but carrying
        // NULL lat/lng was relying on the customer-coordinate fallback —
        // valid while its stamp matched the mirror. After the flip,
        // stampedDivergesSql disables that fallback and the stop goes
        // coordless. Stamp the old primary's own coords onto exactly those
        // rows; real coordinates are never overwritten (NULL-only fence).
        if (oldPrimary.latitude != null && oldPrimary.longitude != null) {
          await trx('scheduled_services')
            .where({ customer_id: customerId })
            .whereNotIn('status', TERMINAL_VISIT_STATUSES)
            .whereNull('lat')
            .whereNull('lng')
            .where((qb) => qb
              .where({ property_id: oldPrimary.id })
              .orWhere((qb2) => qb2
                .whereRaw('lower(service_address_line1) = lower(?)', [oldPrimary.address_line1 || ''])
                .andWhere((qb3) => qb3
                  .whereNull('service_address_zip')
                  .orWhere('service_address_zip', oldPrimary.zip))))
            .update({
              lat: oldPrimary.latitude,
              lng: oldPrimary.longitude,
              updated_at: new Date(),
            });
        }

        // The demote NEVER writes occupancy — the old row's reclassification
        // rides the sibling occupancy_change proposal, whose compare-and-swap
        // yields to any newer admin edit (codex #3418 r2). The label
        // suggestion lands only on the vacated 'Primary' or an empty label,
        // fenced IN THE PREDICATE so an admin label edit between staging
        // and apply always wins (codex #3418 r4 P2).
        await trx('customer_properties')
          .where({ id: oldPrimary.id })
          .update({ is_primary: false, updated_at: new Date() });
        if (p.old_primary_label) {
          const relabeled = await trx('customer_properties')
            .where({ id: oldPrimary.id, label: 'Primary' })
            .update({ label: p.old_primary_label, updated_at: new Date() });
          if (relabeled === 0) {
            await trx('customer_properties')
              .where({ id: oldPrimary.id })
              .whereNull('label')
              .update({ label: p.old_primary_label, updated_at: new Date() });
          }
        }
      }

      // Promote in fenced steps: the flags land unconditionally, while
      // owner_occupied is adopted via an ATOMIC update predicated on the
      // occupancy still being 'unknown' (a read-time check was a TOCTOU
      // race against the admin PATCH — codex #3418 r4), and the 'Primary'
      // label lands only on an unlabeled row so an admin's own name for
      // the property survives.
      await trx('customer_properties')
        .where({ id: newPrimary.id })
        .update({ is_primary: true, updated_at: new Date() });
      await trx('customer_properties')
        .where({ id: newPrimary.id, occupancy_type: 'unknown' })
        .update({ occupancy_type: 'owner_occupied', updated_at: new Date() });
      const primaryLabeled = await trx('customer_properties')
        .where({ id: newPrimary.id })
        .whereNull('label')
        .update({ label: 'Primary', updated_at: new Date() });
      if (primaryLabeled === 0 && LABEL_BY_OCCUPANCY[knownOccupancy(newPrimary.occupancy_type)]) {
        // A stale suggestion label ('Rental'/'Seasonal') on the row now
        // becoming primary is corrected; a bespoke admin name is kept.
        await trx('customer_properties')
          .where({ id: newPrimary.id })
          .whereIn('label', Object.values(LABEL_BY_OCCUPANCY))
          .update({ label: 'Primary', updated_at: new Date() });
      }

      const mirror = {
        address_line1: newPrimary.address_line1,
        address_line2: newPrimary.address_line2 || null,
        city: newPrimary.city,
        state: newPrimary.state || 'FL',
        zip: newPrimary.zip,
        latitude: newPrimary.latitude ?? null,
        longitude: newPrimary.longitude ?? null,
        // Property-grained attributes follow the primary too — estimator
        // inputs (e.g. customers.property_sqft = measured turf) must
        // describe the NEW primary, and a null here is better than a value
        // describing the demoted property (same doctrine as the coords in
        // syncPrimaryAddress). Field set mirrors ensurePrimaryProperty's.
        property_type: newPrimary.property_type ?? null,
        lawn_type: newPrimary.lawn_type ?? null,
        property_sqft: newPrimary.property_sqft ?? null,
        lot_sqft: newPrimary.lot_sqft ?? null,
        bed_sqft: newPrimary.bed_sqft ?? null,
        linear_ft_perimeter: newPrimary.linear_ft_perimeter ?? null,
        palm_count: newPrimary.palm_count ?? null,
        canopy_type: newPrimary.canopy_type ?? null,
        updated_at: new Date(),
      };
      const loc = resolveLocation(newPrimary.city || '');
      if (loc?.id) mirror.nearest_location_id = loc.id;
      await trx('customers').where({ id: customerId }).update(mirror);
      applied += 1;
      continue;
    }

    skipped += 1; // unknown proposal kind — never guess
  }

  return { applied, skipped };
}

module.exports = {
  REASON_CODE,
  classifiedPropertiesFromExtraction,
  buildPropertyRoleProposals,
  stagePropertyRoleReview,
  applyPropertyRoleProposals,
  _test: {
    knownOccupancy,
    classifiedPropertiesFromExtraction,
    dedupeClassified,
    buildPropertyRoleProposals,
  },
};
