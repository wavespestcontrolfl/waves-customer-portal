'use strict';

// The server copy resolver, Ask Waves, and the browser's saved-copy filter
// must use the same purchase evidence. Read the existing authored JSON pack
// for its exact bullet instead of maintaining a second customer-facing string.
const { warrantyBullet: PURCHASED_TRENCHING_WARRANTY_BULLET } = require('../server/services/estimate-one-time-copy.json').termite_trenching;

function trenchingServiceIdentity(item = {}) {
  if (!item || typeof item !== 'object') return '';
  const value = [item.service, item.serviceKey, item.service_key, item.key]
    .find((candidate) => candidate != null && String(candidate).trim() !== '');
  const service = String(value || '').toLowerCase().trim();
  return ['trenching', 'termite_trenching'].includes(service) ? 'termite_trenching' : service;
}

function trenchingWarrantyTier(item = {}) {
  return String(item?.warrantyTier || '').toLowerCase().trim();
}

// Zero is valid for the included one-year tier. Labels and detail prose
// cannot establish purchased coverage.
function hasPurchasedTrenchingWarranty(item = {}) {
  if (!item || typeof item !== 'object') return false;
  const tier = trenchingWarrantyTier(item);
  const adderPresent = item.warrantyAdder !== '' && item.warrantyAdder != null;
  const adder = Number(item.warrantyAdder);
  return trenchingServiceIdentity(item) === 'termite_trenching'
    && tier !== '' && tier !== 'none'
    && adderPresent && Number.isFinite(adder) && adder >= 0;
}

// A current saved row can explicitly remove an older raw-engine warranty.
// A tier without an adder is incomplete legacy projection data, so it may
// still borrow the matching raw purchase evidence.
function trenchingWarrantyDecision(item = {}) {
  if (!item || typeof item !== 'object') return 'unset';
  if (trenchingServiceIdentity(item) !== 'termite_trenching') return 'unset';
  if (hasPurchasedTrenchingWarranty(item)) return 'purchased';
  if (Object.prototype.hasOwnProperty.call(item, 'warrantyAdder')) return 'none';
  if (Object.prototype.hasOwnProperty.call(item, 'warrantyTier')) {
    const tier = trenchingWarrantyTier(item);
    if (tier === '' || tier === 'none') return 'none';
    return 'incomplete';
  }
  return 'unset';
}

function rawOneTimeWarrantyEvidenceItems(result = {}) {
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nested = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  return [...new Set([
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(nested.items) ? nested.items : []),
    ...(Array.isArray(result.specItems) ? result.specItems : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
    ...(Array.isArray(nested.specItems) ? nested.specItems : []),
    ...(Array.isArray(result.lineItems) ? result.lineItems : []),
  ].filter((item) => item && typeof item === 'object'))];
}

function matchingTrenchingWarrantyRow(target, rows = []) {
  const identity = trenchingServiceIdentity(target);
  if (identity !== 'termite_trenching') return { row: null, ambiguous: false };
  const candidates = rows.filter((row) => trenchingServiceIdentity(row) === identity);
  if (candidates.length < 2) return { row: candidates[0] || null, ambiguous: false };
  const label = String(target?.label || target?.displayName || target?.name || '').trim().toLowerCase();
  const sameLabel = candidates.filter((row) => (
    String(row.label || row.displayName || row.name || '').trim().toLowerCase() === label
  ));
  if (sameLabel.length === 1) return { row: sameLabel[0], ambiguous: false };
  const amount = Number(target?.amount ?? target?.price ?? target?.total);
  const sameAmount = sameLabel.filter((row) => Number(row.amount ?? row.price ?? row.total) === amount);
  if (sameAmount.length === 1) return { row: sameAmount[0], ambiguous: false };
  return { row: null, ambiguous: true };
}

// Evidence groups are ordered newest to oldest. A current explicit decision
// wins; incomplete current data may borrow only matching, unambiguous proof.
function reconcileTrenchingWarrantyEvidence(target, evidenceGroups = []) {
  if (trenchingServiceIdentity(target) !== 'termite_trenching') return null;
  let current = null;
  let currentDecision = 'unset';
  for (const rows of evidenceGroups) {
    const match = matchingTrenchingWarrantyRow(target, rows);
    if (match.ambiguous) return current;
    if (!match.row) continue;
    const decision = trenchingWarrantyDecision(match.row);
    if (!current) {
      current = match.row;
      currentDecision = decision;
      if (decision === 'purchased' || decision === 'none') return current;
      continue;
    }
    if (decision === 'purchased') {
      const currentTier = trenchingWarrantyTier(current);
      if (currentTier && currentTier !== trenchingWarrantyTier(match.row)) return current;
      return {
        ...match.row,
        ...current,
        warrantyTier: match.row.warrantyTier,
        warrantyAdder: match.row.warrantyAdder,
      };
    }
    if (decision === 'none') return current;
    if (currentDecision === 'unset' && decision === 'incomplete') {
      current = match.row;
      currentDecision = decision;
      continue;
    }
    if (currentDecision === 'incomplete' && decision === 'incomplete'
      && trenchingWarrantyTier(current) !== trenchingWarrantyTier(match.row)) return current;
  }
  return current;
}

// A replayed engine bundle is current unless it came from a sent snapshot.
// Otherwise neither a priced removal nor a current saved removal may be
// overwritten by purchased metadata in the other, unversioned projection.
function reconcilePricedTrenchingWarrantyEvidence(target, evidenceGroups = [], pricing = {}) {
  const [current = [], ...fallback] = evidenceGroups;
  const liveEnginePricing = pricing.source === 'engine_invocation' && pricing.snapshotHit !== true;
  const pricedRemoval = trenchingWarrantyDecision(target) === 'none';
  const ordered = liveEnginePricing || pricedRemoval
    ? [[target], current, ...fallback]
    : [current, [target], ...fallback];
  return reconcileTrenchingWarrantyEvidence(target, ordered);
}

module.exports = {
  hasPurchasedTrenchingWarranty,
  rawOneTimeWarrantyEvidenceItems,
  reconcileTrenchingWarrantyEvidence,
  reconcilePricedTrenchingWarrantyEvidence,
  trenchingServiceIdentity,
  trenchingWarrantyDecision,
  PURCHASED_TRENCHING_WARRANTY_BULLET,
};
