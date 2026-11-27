'use strict';

/**
 * Flea interior size basis for estimate replay (owner ruling 2026-11-26 "whole home").
 *
 * From that date the interior flea package steps on the home's TOTAL living area. Before it, the pricer divided the
 * living area by the story count (the ground-floor footprint), so a 3,000 sq ft two-story home priced as 1,500.
 * Every replay path (estimate-public#savedFloorReplayOverrides, admin-estimate-persistence#serverRecomputeFromEstimateData)
 * re-runs generateEstimate under the code as it is NOW, so without a replay signal a flea quote sent before the change
 * would re-price on view or accept and lock the new amount. Same contract as the area add-on and termite knobs:
 *
 *  - a stored flea row stamped fleaSizeBasis 'total_living_area' was quoted whole-home: it replays live (nothing injected);
 *  - a stored flea row with any other stamp ('ground_floor') or NO stamp predates the change: it replays 'ground_floor';
 *  - with NO stored flea row (inputs-only data) a flea request in the inputs replays 'ground_floor' unless the save stamped
 *    engineInputs.fleaSizeBasisStamp 'total_living_area' (admin-estimate-persistence stamps it on every server-priced save);
 *  - an estimate that asks for no flea injects nothing.
 * The key is set on every replay (undefined when empty), so a value stored inside the browser-controlled inputs never prices.
 */
const { storedEstimateContainer } = require('./estimate-result-container');

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// The engine's flea line (service flea_package, serviceKey flea) and its customer-facing twins.
// The deprecated client estimator wrote its flea row with a name only ('Flea (2-visit)', no service, no serviceKey).
const isFleaPackageRow = (row) => isRecord(row)
  && (row.service === 'flea_package' || row.serviceKey === 'flea' || row.service === 'flea'
    || (!row.service && !row.serviceKey && row.name === 'Flea (2-visit)'));

// The other lines that record the whole-home size they priced on (owner 2026-11-26 "whole home"): the engine's cockroach treatment,
// bed bug treatment and rodent guarantee. Their legacy basis is the estimate's own stamp
// (estimate-floor-signal-replay savedLegacyWholeHomeSizingSignal), not this module; this module only restores a lookup-measured
// home from their rows.
const WHOLE_HOME_ROW_SERVICES = new Set(['pest_initial_roach', 'bed_bug', 'rodent_guarantee']);
const isWholeHomeSizedRow = (row) => isRecord(row) && WHOLE_HOME_ROW_SERVICES.has(row.service);

function rowsIn(container, isRow) {
  const nested = container.results && container.results.oneTime;
  return [
    container.oneTime && container.oneTime.items, container.oneTime && container.oneTime.specItems,
    nested && nested.items, nested && nested.specItems,
    container.specItems, container.quoteRequiredItems, container.lineItems,
  ].filter(Array.isArray).flat().filter(isRow);
}

function parseStored(raw) {
  if (typeof raw !== 'string') return isRecord(raw) ? raw : null;
  try { const parsed = JSON.parse(raw); return isRecord(parsed) ? parsed : null; } catch { return null; }
}

// Every stored row of one kind (isRow picks it; the notes below say flea, the rule is the same for any kind), by the merged-line
// rules of estimate-result-container.js (resolveEstimateLines): the authoritative
// container's rows first (a stale engineResult left by a revision is never read while the revision's own result prices
// flea); a flea line only the OTHER container priced is the legitimate mixed shape (recurring lines in result, the flea line
// in engineResult.lineItems) and is read too, unless a SERVER reprice rewrote result (then the other container's unmatched
// rows are removed or re-priced services, never extras).
function storedRows(estData, isRow) {
  const data = parseStored(estData);
  if (!data) return [];
  const containers = [data.result, data.engineResult].filter(isRecord);
  if (containers.length && !containers.some((container) => rowsIn(container, isRow).length)) return [];
  const chosen = storedEstimateContainer(data) || data;
  const rows = rowsIn(chosen, isRow);
  if (rows.length) return rows;
  const other = [data.result, data.engineResult].find((container) => isRecord(container) && container !== chosen);
  const serverRepriced = String(data.pricingAuthorityAtLock || '').toUpperCase() === 'SERVER'
    && isRecord(data.result) && data.result !== data.engineResult;
  return other && !serverRepriced ? rowsIn(other, isRow) : [];
}

const storedFleaRows = (estData) => storedRows(estData, isFleaPackageRow);

// Does the stored data ask for a flea package in its replayable inputs?
function inputsRequestFlea(inputs) {
  return !!(inputs && typeof inputs === 'object' && inputs.services && typeof inputs.services === 'object'
    && (inputs.services.flea || inputs.services.fleaExterior));
}

// 'ground_floor' when the stored estimate sold a flea package it did not quote whole-home, else null (replay live).
// Evidence, in order: the stored rows (all stamped total_living_area = live); with no stored flea row (an inputs-only
// estimate) a flea request in the inputs replays live only with the save-time stamp engineInputs.fleaSizeBasisStamp.
function fleaSizeBasisSignalForReplay(estData) {
  const rows = storedFleaRows(estData);
  if (rows.length) return rows.every((row) => row.fleaSizeBasis === 'total_living_area') ? null : 'ground_floor';
  const data = parseStored(estData);
  // An Admin V2 save can carry the request only (engineRequest.selectedServices, e.g. 'FLEA'): both replay paths read the stored
  // blob, so this reads the request itself rather than the translated inputs (the two paths translate differently).
  const requestedByRequest = !!(data && isRecord(data.engineRequest) && Array.isArray(data.engineRequest.selectedServices)
    && data.engineRequest.selectedServices.some((key) => /^flea/i.test(String(key || ''))));
  const inputs = data && (isRecord(data.engineInputs) ? data.engineInputs : (isRecord(data.inputs) ? data.inputs : null));
  if (!requestedByRequest && !inputsRequestFlea(inputs)) return null;
  return inputs && inputs.fleaSizeBasisStamp === 'total_living_area' ? null : 'ground_floor';
}

// The measured whole home a website quote priced with when it had no posted home size (public-quote.js sets fleaMeasuredHomeSqFt +
// homeSqFtIsDefault from the SERVER lookup, for flea, the cockroach and bed bug treatments and the rodent guarantee). The save path's identity sanitizer
// strips both from every replay, so the replay restores them from a stored ROW, the only record: the engine stamps footprintSource
// 'lookup_measured_home' and the measured area in footprintUsed on every row it priced with it, and the compact wizard writers carry
// both. A browser-supplied copy in any stored input carrier is never read. A flea row backs it only while every stored flea row is
// stamped whole-home; a cockroach, bed bug or rodent guarantee row carries that source only when it was priced on the whole home.
function storedMeasuredHomeRow(estData) {
  const fleaRows = storedFleaRows(estData);
  const backing = [
    ...(fleaRows.every((row) => row.fleaSizeBasis === 'total_living_area') ? fleaRows : []),
    ...storedRows(estData, isWholeHomeSizedRow),
  ];
  return backing.find((row) => row.footprintSource === 'lookup_measured_home' && Number(row.footprintUsed) > 0) || null;
}
function storedMeasuredHomeForReplay(estData) {
  const fromRow = storedMeasuredHomeRow(estData);
  return fromRow ? { fleaMeasuredHomeSqFt: Math.round(Number(fromRow.footprintUsed)), homeSqFtIsDefault: true } : {};
}

// The input fields a replay sets. The basis key is always present (undefined when empty) so the spread over the stored inputs wins.
function fleaSizeReplayOverrides(estData) {
  // Both measured-home keys are always present (undefined unless a stored row backs them), so a stored input carrier's copy never prices.
  return { fleaSizeBasisReplay: fleaSizeBasisSignalForReplay(estData) || undefined, fleaMeasuredHomeSqFt: undefined, homeSqFtIsDefault: undefined, ...storedMeasuredHomeForReplay(estData) };
}

// A revision keeps a retained flea line's stored price row as sent. The stored estimate is the record: the flea row's
// fleaSizeBasis / footprintSource say how the home was sized when it was priced (for a website quote that used the server lookup's
// measured home, also the posted size it replaced and the address it measured), and the stored request or inputs say what size it was
// quoted on. The revision keeps THAT SIZING while the operator leaves the home size (and, for a measured home, the address) alone;
// changing the flea selection, severity or exterior area re-prices the scope on the kept sizing, and changing the home size moves the
// line to today's rule. Two kinds of record:
//  - a measured whole home (website quote): kept for any estimate, delivered or not (the verified area is not an old rule);
//  - the legacy ground-floor basis: kept only for a DELIVERED estimate (an unsent draft prices today's rule).
const isDelivered = (row) => !!row && (!!row.sent_at || ['sent', 'viewed'].includes(String(row.status || '')));
const addressKeyOf = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// The home size a replayable input prices from, in one normal form (the V2 translator already folds squareFootage into homeSqFt):
// the living area, the explicit footprint (the legacy ground-floor pricer gives it precedence, so a footprint correction is a size
// edit even when a living area is present) and the story count. Compared across carriers only after both sides pass through the SAME
// translation, so an editor that normalizes a field is not mistaken for an edit.
function sizeKeyOf(v1) {
  if (!isRecord(v1)) return null;
  const living = Number(v1.homeSqFt) > 0 ? Number(v1.homeSqFt) : (Number(v1.livingAreaSqFt) > 0 ? Number(v1.livingAreaSqFt) : (Number(v1.buildingSqFt) > 0 ? Number(v1.buildingSqFt) : 0));
  const footprint = Number(v1.footprintSqFt) > 0 ? Number(v1.footprintSqFt) : (Number(v1.footprint) > 0 ? Number(v1.footprint) : 0);
  return { living: Math.round(living), footprint: Math.round(footprint), stories: Number(v1.stories) > 0 ? Number(v1.stories) : 1 };
}

// The size the STORED estimate was quoted on: its request translated like a recompute does, else its engine inputs, else the
// legacy inputs carrier (an inputs-only quote; the replay detector reads the same carrier).
function storedSizeKey(data, translate) {
  const req = isRecord(data.engineRequest) ? data.engineRequest : null;
  if (req && isRecord(req.profile) && typeof translate === 'function') {
    try { return sizeKeyOf(translate(req.profile, Array.isArray(req.selectedServices) ? req.selectedServices : [], req.options || {})); } catch { /* fall through */ }
  }
  if (isRecord(data.engineInputs)) return sizeKeyOf(data.engineInputs);
  return isRecord(data.inputs) ? sizeKeyOf(data.inputs) : null;
}
const sameSize = (a, b) => a.living === b.living && a.footprint === b.footprint && a.stories === b.stories;

function fleaPriceRecord(estimateRow, estData, { translate, nextAddress } = {}) {
  const data = parseStored(estData);
  if (!data) return null;
  const delivered = isDelivered(estimateRow);
  const common = {
    priorSize: storedSizeKey(data, translate),
    priorAddress: addressKeyOf(estimateRow && estimateRow.address),
    nextAddress: addressKeyOf(nextAddress === undefined ? (estimateRow && estimateRow.address) : nextAddress),
  };
  // A website quote priced on the server lookup's measured whole home (its flea, cockroach, bed bug or rodent guarantee row is the record).
  const measuredRow = storedMeasuredHomeRow(data);
  if (measuredRow) {
    return {
      ...common, basis: 'measured_home', measuredHomeSqFt: Math.round(Number(measuredRow.footprintUsed)),
      postedHomeSqFt: Number(measuredRow.fleaPostedHomeSqFt) > 0 ? Math.round(Number(measuredRow.fleaPostedHomeSqFt)) : null,
    };
  }
  const row = storedFleaRows(data)[0];
  if (!row) {
    // A delivered quote with no priced row (inputs-only, or a request-only Admin V2 save): its basis is the replay's legacy reading
    // of what it stored, and the stored inputs size the home the way it was quoted.
    return delivered && fleaSizeBasisSignalForReplay(data) === 'ground_floor' ? { ...common, basis: 'ground_floor', footprintUsed: null } : null;
  }
  // A whole-home row prices deterministically from its inputs; a legacy row is kept only once delivered.
  if (row.fleaSizeBasis === 'total_living_area' || !delivered) return null;
  return { ...common, basis: 'ground_floor', footprintUsed: Number(row.footprintUsed) > 0 ? Math.round(Number(row.footprintUsed)) : null };
}

const fleaLineOf = (estimate) => (estimate && Array.isArray(estimate.lineItems) ? estimate.lineItems : [])
  .find((line) => line && line.service === 'flea_package');
// The first line that reports the whole-home size it priced on (flea, cockroach, bed bug or rodent guarantee; they share one resolver).
const wholeHomeSizedLineOf = (estimate) => (estimate && Array.isArray(estimate.lineItems) ? estimate.lineItems : [])
  .find((line) => line && (line.service === 'flea_package' || isWholeHomeSizedRow(line)) && Number(line.footprintUsed) > 0);

// Runs the engine for a revision or its preview. With no record it is a plain run (today's rule). With a record it prices the retained
// line on the sizing it was sent with, and falls back to today's rule when the operator changed the home size (or, for a measured
// home, the address). Preview and save call this one function, so the editor shows the number the save persists.
function generateWithFleaRecord(generateEstimate, v1Input, record) {
  const fresh = generateEstimate(v1Input);
  if (!record) return fresh;
  if (record.basis === 'measured_home') {
    // The verified area belongs to the property it measured, and to the posted size it replaced.
    const sizedLine = wholeHomeSizedLineOf(fresh);
    if (!sizedLine) return fresh;
    if (record.priorAddress && record.nextAddress && record.priorAddress !== record.nextAddress) return fresh;
    if (record.postedHomeSqFt && Number(sizedLine.footprintUsed) === record.postedHomeSqFt) {
      return generateEstimate({ ...v1Input, fleaMeasuredHomeSqFt: record.measuredHomeSqFt, homeSqFtIsDefault: true });
    }
    return fresh;
  }
  const freshLine = fleaLineOf(fresh);
  if (!freshLine) return fresh;
  // Legacy ground-floor sizing: compare the stored quote's size (living area, footprint, stories) with the revised one.
  const nextSize = sizeKeyOf(v1Input);
  if (record.priorSize && nextSize && !sameSize(record.priorSize, nextSize)) return fresh;
  const kept = generateEstimate({ ...v1Input, fleaSizeBasisReplay: 'ground_floor' });
  const keptLine = fleaLineOf(kept);
  if (!keptLine) return fresh;
  // No stored request or inputs to compare (a compact row alone): the row's recorded footprint is the evidence of the size.
  if (!record.priorSize && record.footprintUsed && Number(keptLine.footprintUsed) !== Number(record.footprintUsed)) return fresh;
  return kept;
}

module.exports = { fleaSizeBasisSignalForReplay, fleaSizeReplayOverrides, fleaPriceRecord, generateWithFleaRecord, storedFleaRows };
