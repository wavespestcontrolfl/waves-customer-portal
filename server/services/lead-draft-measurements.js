'use strict';

// Real home and lot size for website lead drafts (owner 2026-10-24, option A
// of the lead draft page). The website forms collect no size, so a lead draft
// is priced on the default home (2,000 sq ft) and lot (8,000 sq ft) and
// flagged `property_measurements_defaulted`. This module gives it the county-
// assessed sizes instead, in two steps:
//
//   1. When the draft is built, a free cache-only read of the property lookup
//      (cachedLeadMeasurements). Only about 1 lead in 15 has a cached lookup
//      at that moment (production, 10-24).
//   2. For a draft still on the default, one live lookup in the background
//      after the lead is saved (scheduleLeadDraftPropertyLookup): a full
//      lookup takes about 10 s, up to a minute, so it never runs inside the
//      webhook's request or its phone-lock transaction. It then re-prices
//      the draft through the caller's own builder, only while the row is
//      exactly as it was created: never written since (updated_at =
//      created_at) and the same whole-row witness (estimateEditVersion)
//      before and after the lookup. A staff member with the draft open is
//      protected by the send and save checks on that same witness.
//
// Only a county-assessed home AND lot for a single-family home at an address
// with no unit line, inside residential ranges, and only when the lookup did
// not snap to a different house; anything else keeps the default and the
// flag for staff. Imputed sizes are never written to the customer or the
// property row: they stay on the draft's engine input, with provenance.
// Dark behind GATE_LEAD_DRAFT_PROPERTY_LOOKUP (read at call time). Logs carry
// ids and outcomes only, never an address.

const db = require('../models/db');
const logger = require('./logger');
const { leadDraftPropertyLookupLive, isEnabled } = require('../config/feature-gates');
const { lookupOptionsFor } = require('./property-lookup/lookup-callers');
const { resolvePropertyFacts, SQFT_SOURCES } = require('./estimator-engine/source-arbitration');
const { hasWrongPremiseFlag } = require('./lookup-confidence');
const { unitAnywhereOnLine } = require('../utils/address-normalizer');

const MEASUREMENTS_SOURCE = 'county_assessed';
const DEFAULTED_REVIEW = 'property_measurements_defaulted';
const FROM_COUNTY_REVIEW = 'property_measurements_from_county';
// Residential bounds: a county figure outside them (a whole condo building,
// a farm parcel) is not a house to price from a lead form.
const HOME_SQFT_RANGE = [400, 10000];
const LOT_SQFT_RANGE = [1000, 435600];
const REPRICE_STATUSES = new Set(['generated', 'manual_review_required']);

const inRange = (value, [low, high]) => Number.isFinite(value) && value >= low && value <= high;

// An address the lookup can describe as one house: a street number and no
// unit in any position ("Apt 4", "#4", "Unit B", "Bldg 9", unit-first).
function wholeHomeAddress(address) {
  if (typeof address !== 'string' || !/\d/.test(address)) return false;
  return !unitAnywhereOnLine(address);
}

// The county-assessed home and lot size a lookup result proves for a single-
// family home, or null. Same arbitration as the estimator engine
// (resolvePropertyFacts), held to its county-assessed source only.
function countyMeasurements(lookup) {
  const propertyRecord = lookup?.propertyRecord;
  if (!propertyRecord) return null;
  // The geocoder snapped to a different premise: the county figures describe
  // another parcel (estimator-engine parcelSignalsDescribeGatheredAddress).
  if (hasWrongPremiseFlag(lookup.enriched) || propertyRecord._addressAudit?.snappedRecord) return null;
  const facts = resolvePropertyFacts({ extraction: null, propertyRecord, customer: null, isCommercial: false });
  if (facts.propertyType !== 'single_family' || facts.newConstruction) return null;
  if (facts.home?.source !== SQFT_SOURCES.COUNTY_ASSESSED || facts.lot?.source !== SQFT_SOURCES.COUNTY_ASSESSED) return null;
  const homeSqFt = Math.round(Number(facts.home.value));
  const lotSqFt = Math.round(Number(facts.lot.value));
  if (!inRange(homeSqFt, HOME_SQFT_RANGE) || !inRange(lotSqFt, LOT_SQFT_RANGE)) return null;
  return { homeSqFt, lotSqFt, source: MEASUREMENTS_SOURCE };
}

// The draft builder's read: cache only, never spends, never throws.
async function cachedLeadMeasurements(address) {
  if (!leadDraftPropertyLookupLive() || !wholeHomeAddress(address)) return null;
  try {
    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    const lookup = await performPropertyLookup(address, lookupOptionsFor('lead_draft', { cacheOnly: true, persist: false }));
    return countyMeasurements(lookup);
  } catch (err) {
    logger.warn(`[lead-draft-measurements] cache read failed (${err.code || err.name || 'error'})`);
    return null;
  }
}

function parsedData(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

// A lead draft the automation priced on the default size (the lead gave no
// home or lot size) that nobody has written since: the only row the
// background step may re-price.
function untouchedDefaultedDraft(row) {
  if (!row || row.source !== 'lead_webhook' || row.status !== 'draft') return false;
  if (row.archived_at || row.sent_at || row.price_locked_at) return false;
  if (!row.created_at || !row.updated_at || new Date(row.updated_at).getTime() !== new Date(row.created_at).getTime()) return false;
  const draft = parsedData(row.estimate_data)?.automation?.draftEstimateAutomation;
  return !!draft && draft.source === 'lead_webhook_automation' && REPRICE_STATUSES.has(draft.status)
    && draft.sizeSource === 'default';
}

/**
 * The background step. `rebuild(measurements)` is the caller's own draft
 * builder bound to the lead's inputs; it returns the builder's result.
 * Resolves { skipped } or { outcome }: repriced | no_trusted_size | changed |
 * not_rebuilt | lookup_failed. A database error rejects (the scheduler
 * logs it); the draft then stays as it was.
 */
async function runLeadDraftPropertyLookup({ estimateId, address, rebuild, conn = db }) {
  if (!leadDraftPropertyLookupLive() || !isEnabled('leadEstimateAutomation')) return { skipped: 'disabled' };
  if (!estimateId || typeof rebuild !== 'function' || !wholeHomeAddress(address)) return { skipped: 'not_eligible' };
  const { estimateEditVersion } = require('./admin-estimate-persistence');
  const before = await conn('estimates').where({ id: estimateId }).first();
  if (!untouchedDefaultedDraft(before)) return { skipped: 'not_eligible' };
  const witness = estimateEditVersion(before);

  let lookup;
  try {
    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    lookup = await performPropertyLookup(address, lookupOptionsFor('lead_draft'));
  } catch (err) {
    logger.warn(`[lead-draft-measurements] lookup failed for estimate ${estimateId} (${err.code || err.name || 'error'})`);
    return { outcome: 'lookup_failed' };
  }
  const measurements = countyMeasurements(lookup);
  if (!measurements) return { outcome: 'no_trusted_size' };

  // Priced before the row lock: the builder reads only the lead's in-memory
  // inputs and the catalog, and the witness below proves the row is still
  // the one those inputs priced.
  const draft = await rebuild(measurements);
  const status = draft?.automation?.status;
  if (!draft?.estimateData || !REPRICE_STATUSES.has(status)
      || draft.automation.sizeSource !== MEASUREMENTS_SOURCE) return { outcome: 'not_rebuilt' };

  return conn.transaction(async (trx) => {
    const row = await trx('estimates').where({ id: estimateId }).forUpdate().first();
    if (!untouchedDefaultedDraft(row) || estimateEditVersion(row) !== witness) return { outcome: 'changed' };
    await trx('estimates').where({ id: estimateId }).update({
      monthly_total: draft.monthly || null,
      annual_total: draft.annual || null,
      onetime_total: draft.oneTimeTotal || null,
      // Same stamp as the webhook's insert: an engine-generated price is
      // SERVER, a parked draft stays unstamped (the auto-send lane fails
      // closed on anything but SERVER).
      pricing_authority: status === 'generated' ? 'SERVER' : null,
      estimate_data: JSON.stringify(draft.estimateData),
      updated_at: trx.fn.now(),
    });
    return { outcome: 'repriced' };
  });
}

// Fire-and-forget from the lead webhook: the website's answer never waits on
// the lookup, and a failure only leaves the draft flagged, as before.
function scheduleLeadDraftPropertyLookup(args) {
  if (!leadDraftPropertyLookupLive()) return;
  setImmediate(() => {
    runLeadDraftPropertyLookup(args)
      .then((result) => logger.info(`[lead-draft-measurements] estimate ${args.estimateId}: ${result.outcome || result.skipped}`))
      .catch((err) => logger.warn(`[lead-draft-measurements] estimate ${args.estimateId} failed (${err.code || err.name || 'error'})`));
  });
}

module.exports = {
  cachedLeadMeasurements,
  runLeadDraftPropertyLookup,
  scheduleLeadDraftPropertyLookup,
  MEASUREMENTS_SOURCE,
  DEFAULTED_REVIEW,
  FROM_COUNTY_REVIEW,
  _private: { countyMeasurements, wholeHomeAddress, untouchedDefaultedDraft },
};
