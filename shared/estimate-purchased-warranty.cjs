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

function stableContentKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableContentKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableContentKey(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

// Mapped estimates mirror one specialty row into several containers (for
// example oneTime.specItems and top-level specItems) as separate objects once
// persisted, so rows collapse by content. Each distinct row appears as many
// times as the most any ONE container holds it: two identical jobs in one
// container stay two, while a cross-container mirror never adds a phantom
// peer that would make real purchase evidence look ambiguous.
function collapseMirroredRows(lists = []) {
  const containers = lists
    .map((list) => (Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : []));
  const byContent = new Map();
  for (const list of containers) {
    const inList = new Map();
    for (const item of list) {
      const key = stableContentKey(item);
      inList.set(key, [...(inList.get(key) || []), item]);
    }
    for (const [key, items] of inList) {
      if (!byContent.has(key) || items.length > byContent.get(key).length) byContent.set(key, items);
    }
  }
  return [...byContent.values()].flat();
}

function rawOneTimeWarrantyEvidenceItems(result = {}) {
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nested = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  return collapseMirroredRows([
    oneTime.items, nested.items, result.specItems, oneTime.specItems, nested.specItems, result.lineItems,
  ]);
}

function matchingTrenchingWarrantyRow(target, rows = [], targets = [target]) {
  const identity = trenchingServiceIdentity(target);
  if (identity !== 'termite_trenching') return { row: null, ambiguous: false };
  const candidates = rows.filter((row) => trenchingServiceIdentity(row) === identity);
  if (!candidates.length) return { row: null, ambiguous: false };
  // A priced engine row is its own authoritative evidence. It must not become
  // ambiguous merely because a sibling job has the same display identity.
  if (candidates.includes(target)) return { row: target, ambiguous: false };
  const peers = targets.filter((row) => trenchingServiceIdentity(row) === identity);
  const label = String(target?.label || target?.displayName || target?.name || '').trim().toLowerCase();
  const sameLabel = candidates.filter((row) => (
    String(row.label || row.displayName || row.name || '').trim().toLowerCase() === label
  ));
  const peerLabelCount = peers.filter((row) => (
    String(row.label || row.displayName || row.name || '').trim().toLowerCase() === label
  )).length;
  if (label && sameLabel.length === 1 && peerLabelCount === 1) {
    return { row: sameLabel[0], ambiguous: false };
  }
  const targetAmount = target?.amount ?? target?.price ?? target?.total;
  const amount = Number(targetAmount);
  const sameAmount = candidates.filter((row) => {
    const candidateLabel = String(row.label || row.displayName || row.name || '').trim().toLowerCase();
    const candidateLabelCount = candidateLabel ? candidates.filter((candidate) => (
      String(candidate.label || candidate.displayName || candidate.name || '').trim().toLowerCase() === candidateLabel
    )).length : 0;
    const boundPeerCount = candidateLabel ? peers.filter((peer) => (
      String(peer.label || peer.displayName || peer.name || '').trim().toLowerCase() === candidateLabel
    )).length : 0;
    // Reserve a unique exact-label row for that peer before considering amount
    // fallback. This makes the assignment independent of projection order.
    if (candidateLabel !== label && candidateLabelCount === 1 && boundPeerCount === 1) return false;
    const value = row.amount ?? row.price ?? row.total;
    return value !== '' && value != null && Number(value) === amount;
  });
  const peerAmountCount = peers.filter((row) => {
    const peerLabel = String(row.label || row.displayName || row.name || '').trim().toLowerCase();
    const candidateLabelCount = peerLabel ? candidates.filter((candidate) => (
      String(candidate.label || candidate.displayName || candidate.name || '').trim().toLowerCase() === peerLabel
    )).length : 0;
    const matchingPeerCount = peerLabel ? peers.filter((peer) => (
      String(peer.label || peer.displayName || peer.name || '').trim().toLowerCase() === peerLabel
    )).length : 0;
    // An exact one-to-one label assignment reserves both its evidence row and
    // its projected peer. Neither should make a remaining amount match look
    // ambiguous.
    if (row !== target && peerLabel && candidateLabelCount === 1 && matchingPeerCount === 1) return false;
    const value = row.amount ?? row.price ?? row.total;
    return value !== '' && value != null && Number(value) === amount;
  }).length;
  if (targetAmount !== '' && targetAmount != null && Number.isFinite(amount)
    && sameAmount.length === 1 && peerAmountCount === 1) {
    return { row: sameAmount[0], ambiguous: false };
  }
  // A single renamed job may borrow its one matching legacy row. With two
  // current jobs, the same fallback would otherwise be lent to both.
  if (candidates.length === 1 && peers.length === 1) return { row: candidates[0], ambiguous: false };
  if (candidates.length === 1) return { row: null, ambiguous: false };
  return { row: null, ambiguous: true };
}

// Evidence groups are ordered newest to oldest. A current explicit decision
// wins; incomplete current data may borrow only matching, unambiguous proof.
function reconcileTrenchingWarrantyEvidence(target, evidenceGroups = [], targets = [target]) {
  if (trenchingServiceIdentity(target) !== 'termite_trenching') return null;
  let current = null;
  let currentDecision = 'unset';
  for (const rows of evidenceGroups) {
    const match = matchingTrenchingWarrantyRow(target, rows, targets);
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
function reconcilePricedTrenchingWarrantyEvidence(target, evidenceGroups = [], pricing = {}, targets = [target]) {
  const [current = [], ...fallback] = evidenceGroups;
  const liveEnginePricing = pricing.source === 'engine_invocation' && pricing.snapshotHit !== true;
  const pricedRemoval = trenchingWarrantyDecision(target) === 'none';
  const ordered = liveEnginePricing || pricedRemoval
    ? [[target], current, ...fallback]
    : [current, [target], ...fallback];
  return reconcileTrenchingWarrantyEvidence(target, ordered, targets);
}

// A pre-slab termite soil treatment row (pricing engine priceSlabPretreat).
function isPreSlabTreatmentItem(item = {}) {
  if (!item || typeof item !== 'object') return false;
  const raw = [item.service, item.name, item.label, item.displayName, item.detail, item.det]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return (raw.includes('pre slab') || /\bslab pre ?treat/.test(raw))
    && (raw.includes('termite') || raw.includes('termiticide') || raw.includes('soil treatment') || raw.includes('termidor'));
}

// Whether the row's extended 5-year warranty was selected: the engine's own
// flag, else its warranty status text.
function preSlabExtendedWarrantySelected(item = {}) {
  if (!item || typeof item !== 'object') return false;
  // The engine's flag decides whenever the row carries it, true or false, so
  // stale prose never outlives a removal. Legacy rows without it fall back
  // to their status text.
  if (typeof item.warrantyExtendedSelected === 'boolean') return item.warrantyExtendedSelected;
  const raw = [item.warrantyStatus, item.detail, item.det]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (raw.includes('no extended')) return false;
  return raw.includes('extended 5') || raw.includes('5-year') || raw.includes('5yr');
}

// The detail part naming a pre-slab job's selected extended warranty
// ("Extended 5-yr warranty"). It is verified purchased coverage and survives
// the no-guarantee policy (owner ruling 2026-09-27). Any other row keeps
// nothing.
function preSlabSelectedWarrantyPart(item = {}) {
  if (!isPreSlabTreatmentItem(item) || !preSlabExtendedWarrantySelected(item)) return () => false;
  return (part) => /\bextended\b/i.test(part) && /\bwarrant/i.test(part);
}

// Only a boolean flag is a decision: the legacy mapper copies
// warrantyExtendedSelected through as an own property even when the row has
// none (undefined), and that must stay 'unset' so reconciliation can still
// read the saved row's decision (Codex #5195 r1).
function preSlabWarrantyDecision(item = {}) {
  if (!isPreSlabTreatmentItem(item)) return 'unset';
  if (typeof item.warrantyExtendedSelected === 'boolean') {
    return item.warrantyExtendedSelected ? 'extended' : 'basic';
  }
  const raw = [item.warrantyStatus, item.detail, item.det]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (raw.includes('no extended') || raw.includes('basic warranty')) return 'basic';
  if (raw.includes('extended 5') || raw.includes('5-year') || raw.includes('5yr')) return 'extended';
  return 'unset';
}

// The pre-slab counterpart of matchingTrenchingWarrantyRow, with the same
// result shape: a unique exact-label row, then a unique amount match with
// exact-label rows and their peers reserved first, then a lone legacy row
// for a lone job. Two candidates that cannot be told apart are `ambiguous`,
// and the reconciler stops there rather than borrowing older evidence.
function matchingPreSlabWarrantyRow(target, rows = [], targets = [target]) {
  if (!isPreSlabTreatmentItem(target)) return { row: null, ambiguous: false };
  const candidates = rows.filter(isPreSlabTreatmentItem);
  if (!candidates.length) return { row: null, ambiguous: false };
  if (candidates.includes(target)) return { row: target, ambiguous: false };
  const peers = targets.filter(isPreSlabTreatmentItem);
  const labelFor = (row) => String(row?.label || row?.displayName || row?.name || '').trim().toLowerCase();
  const label = labelFor(target);
  const sameLabel = candidates.filter((row) => labelFor(row) === label);
  if (label && sameLabel.length === 1 && peers.filter((row) => labelFor(row) === label).length === 1) {
    return { row: sameLabel[0], ambiguous: false };
  }
  const amountFor = (row) => row?.amount ?? row?.price ?? row?.total;
  const targetAmount = amountFor(target);
  const amount = Number(targetAmount);
  const hasAmount = (row) => amountFor(row) !== '' && amountFor(row) != null && Number(amountFor(row)) === amount;
  const labelCount = (list, value) => (value ? list.filter((row) => labelFor(row) === value).length : 0);
  // A unique exact-label row is reserved for the peer that carries that label
  // before amount fallback, and that peer is reserved with it, exactly as
  // matchingTrenchingWarrantyRow does: two priced jobs sharing a price must
  // never both inherit one job's warranty (pre-push audit P1 on d5f5cf244b).
  const reservedByLabel = (row, list, other) => {
    const value = labelFor(row);
    return Boolean(value) && labelCount(list, value) === 1 && labelCount(other, value) === 1;
  };
  const sameAmount = candidates.filter((row) => {
    if (labelFor(row) !== label && reservedByLabel(row, candidates, peers)) return false;
    return hasAmount(row);
  });
  const peerAmountCount = peers.filter((row) => {
    if (row !== target && reservedByLabel(row, peers, candidates)) return false;
    return hasAmount(row);
  }).length;
  if (targetAmount !== '' && targetAmount != null && Number.isFinite(amount)
    && sameAmount.length === 1 && peerAmountCount === 1) {
    return { row: sameAmount[0], ambiguous: false };
  }
  if (candidates.length === 1 && peers.length === 1) return { row: candidates[0], ambiguous: false };
  if (candidates.length === 1) return { row: null, ambiguous: false };
  return { row: null, ambiguous: true };
}

// The same order as reconcilePricedTrenchingWarrantyEvidence: a live engine
// row or an explicit priced removal decides first; otherwise the current
// saved rows, then the priced row, then historical fallback rows (an older
// engineResult). Historical evidence never outranks a priced snapshot's own
// removal (pre-push audit P1 on 41b0b242a9), and an ambiguous group ends the
// search with whatever is decided so far, as the trenching reconciler does:
// two current jobs that cannot be told apart never borrow an older row.
function reconcilePricedPreSlabWarrantyEvidence(target, evidenceGroups = [], pricing = {}, targets = [target]) {
  const [current = [], ...fallback] = evidenceGroups;
  const liveEnginePricing = pricing.source === 'engine_invocation' && pricing.snapshotHit !== true;
  const pricedRemoval = preSlabWarrantyDecision(target) === 'basic';
  const ordered = liveEnginePricing || pricedRemoval
    ? [[target], current, ...fallback]
    : [current, [target], ...fallback];
  let fallbackRow = target;
  for (const rows of ordered) {
    const { row: match, ambiguous } = matchingPreSlabWarrantyRow(target, rows, targets);
    if (ambiguous) return fallbackRow;
    if (!match) continue;
    fallbackRow = match;
    if (preSlabWarrantyDecision(match) !== 'unset') return match;
  }
  return fallbackRow;
}

module.exports = {
  collapseMirroredRows,
  isPreSlabTreatmentItem,
  matchingPreSlabWarrantyRow,
  preSlabExtendedWarrantySelected,
  preSlabSelectedWarrantyPart,
  preSlabWarrantyDecision,
  reconcilePricedPreSlabWarrantyEvidence,
  hasPurchasedTrenchingWarranty,
  matchingTrenchingWarrantyRow,
  rawOneTimeWarrantyEvidenceItems,
  reconcileTrenchingWarrantyEvidence,
  reconcilePricedTrenchingWarrantyEvidence,
  trenchingServiceIdentity,
  trenchingWarrantyDecision,
  PURCHASED_TRENCHING_WARRANTY_BULLET,
};
