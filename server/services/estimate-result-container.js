// Which persisted container holds an estimate's CURRENT priced result, decided in one place
// for the pricing audit (estimate-pricing-audit.js) and the bermuda removal evidence reader
// (v1-legacy-mapper.js), so the two never disagree.
//
// The pick, in order:
//   1. Only one of `result` / `engineResult` exists, or they are the same object: that one.
//   2. A SERVER-authoritative reprice (estimate.pricing_authority 'SERVER') rewrote
//      `result` wholesale and left the earlier `engineResult` behind: `result` is the
//      authority, even when it prices nothing (an operator removed every service).
//   3. Otherwise `result` is the default, but an ancillary `result` that prices nothing
//      yields to a priced `engineResult` (a quote-wizard or agent-draft row persists its
//      priced services only at engineResult.lineItems and may carry a shadowing `result`).
//      "Prices something" is the caller's own detector (`hasPricedLines`): the audit passes
//      its line normalizers.
//   A revised draft that leaves a stale engineResult behind keeps `result`, because its
//   `result` prices something.
//
// With no detector (the proposal path, a caller that cannot detect) `result` wins whenever
// it exists.
function authoritativeEstimateResult(data, { pricingAuthority = null, hasPricedLines = null } = {}) {
  if (!data || typeof data !== 'object') return {};
  const { result, engineResult } = data;
  if (!result || !engineResult || result === engineResult) return result || engineResult || {};
  if (String(pricingAuthority || '').toUpperCase() === 'SERVER') return result;
  if (typeof hasPricedLines === 'function' && !hasPricedLines(result) && hasPricedLines(engineResult)) return engineResult;
  return result;
}

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const parseStoredData = (raw) => {
  if (typeof raw !== 'string') return isRecord(raw) ? raw : null;
  try { const parsed = JSON.parse(raw); return isRecord(parsed) ? parsed : null; } catch { return null; }
};

// The container a stored estimate's rows are read from, for the readers that look at ONE container (the
// area add-on readers and the one-time breakdown normalizer): the authoritative pick above, or null when
// the data carries neither `result` nor `engineResult`. Authority is the row's `pricing_authority`, or the
// one the blob froze at the price lock (`pricingAuthorityAtLock`), so a reader holding only the blob still
// sees a server reprice. `hasPricedLines` is the audit's own detector, required at call time (the audit
// module is not a load-time dependency of this file).
function storedEstimateContainer(estimateData, { pricingAuthority = null } = {}) {
  const data = parseStoredData(estimateData);
  const result = data && isRecord(data.result) ? data.result : null;
  const engineResult = data && isRecord(data.engineResult) ? data.engineResult : null;
  if (!result && !engineResult) return null;
  const serverPriced = [pricingAuthority, data.pricingAuthorityAtLock].some((value) => String(value || '').toUpperCase() === 'SERVER');
  return authoritativeEstimateResult({ result, engineResult }, {
    pricingAuthority: serverPriced ? 'SERVER' : null,
    hasPricedLines: (container) => require('./estimate-pricing-audit').hasPricedLines(container),
  });
}

// THE answer to "which area add-on rows does this stored estimate hold": every row of an area add-on in the
// authoritative container (storedEstimateContainer; the bare data itself when it holds neither container, a
// caller holding the bare mapped shape), under every shape a row rides in (mapped one-time items and spec
// items, the nested results.oneTime copy, top-level spec items, quote-required items, and the raw engine line
// items). A stale `engineResult` left behind by a revision is never read while the revision's own `result`
// prices something; an estimate whose only container is `engineResult` is read from it. Callers apply their
// own predicate (sold, priced, carried) to the rows.
const isAreaAddOnRow = (row) => isRecord(row) && row.service === 'area_addon';
function areaAddOnRowsIn(container) {
  const nested = container.results && container.results.oneTime;
  return [
    container.oneTime && container.oneTime.items, container.oneTime && container.oneTime.specItems,
    nested && nested.items, nested && nested.specItems,
    container.specItems, container.quoteRequiredItems, container.lineItems,
  ].filter(Array.isArray).flat().filter(isAreaAddOnRow);
}
function storedAreaAddOnRows(estimateData, options = {}) {
  const data = parseStoredData(estimateData);
  if (!data) return [];
  const containers = [data.result, data.engineResult].filter(isRecord);
  // No row in either container: nothing to pick between (and the audit's detector is never loaded).
  if (containers.length && !containers.some((container) => areaAddOnRowsIn(container).length)) return [];
  return areaAddOnRowsIn(storedEstimateContainer(data, options) || data);
}

// The commercial engine ids and their residential label-mapped twins are the SAME charge in two
// spellings: canonicalized for the duplicate key only (each line keeps its own serviceKey).
const DEDUPE_FAMILY = {
  commercial_pest: 'pest_control',
  commercial_lawn: 'lawn_care',
  commercial_tree_shrub: 'tree_shrub',
  commercial_mosquito: 'mosquito',
  commercial_termite_bait: 'termite_bait',
  commercial_rodent_bait: 'rodent_bait',
  // Termite SPECIALTY twins: the mapped normalizer only has names ("Recurring Termite Foam
  // Service", "Termite Bond") and keyFromName lands them on termite_bait, while the raw rows
  // keep their canonical engine ids: same charge, two spellings again.
  foam_recurring: 'termite_bait',
  termite_station_rental: 'termite_bait',
  termite_bond: 'termite_bait',
};

// Does a persisted result container price anything (a structured line or a raw engine line item)?
const containerPricesAnything = (container, collectors, setupOpts) => collectors.mapped(container, setupOpts).length > 0
  || collectors.raw(container, setupOpts).length > 0;

// What a discarded duplicate hands to the line retained in its place, as groups of fields that move
// together when the retained line lacks the first one: its own persisted cost, the usage-table
// multipliers, the visit count. The CURRENT container's raw line also hands over a stored bermuda
// removal cost (an older container's is stale and never transfers).
const OLDER_TRANSFER = [['explicitCogsCost'], ['cogsServiceTypes', 'cogsServiceTypeFixedMultipliers'], ['visitsPerYear']];
const CURRENT_TRANSFER = [...OLDER_TRANSFER, ['bermudaRemovalStored']];
function transferMetadata(retained, line, groups) {
  for (const [lead, ...rest] of groups) {
    if (retained[lead] !== undefined || line[lead] === undefined) continue;
    for (const field of [lead, ...rest]) retained[field] = line[field];
  }
  // Quoted fields merge, the retained line's own winning.
  if (line.quoted) retained.quoted = { ...line.quoted, ...(retained.quoted || {}) };
}

// The priced lines of an estimate and the container they came from, in one call.
//
//   collectors.mapped(container, setupOpts)  the container's structured recurring and one-time lines
//   collectors.raw(container, setupOpts)     the container's raw engine line items
//   collectors.engineIdAliases               engine id -> canonical service id (for the duplicate key)
//
// A proposal-authoritative estimate keeps its proposal lines and `result` whenever it exists.
// Otherwise the container is picked by authoritativeEstimateResult (above), the structured lines
// of that container come first, then its raw line items, then the OTHER container (an earlier
// engineResult left behind by a revision or reprice) as a consume-only source:
//   - Real rows can MIX shapes (mapped blocks plus extra rows only in lineItems): merge and dedupe by
//     service + cadence so no priced line is silently omitted. Duplicate = the SAME priced charge in
//     TWO containers (same service, cadence and net price); each remembered charge is CONSUMED by at
//     most one match, so two equal-priced lines in one container both survive.
//   - Stale-revision guard: a service the chosen container already priced is consume-only (an engine row
//     either price-matches and enriches, or is a stale revision of that service and drops); a service it
//     never priced is the legitimate mixed shape and merges.
//   - After a SERVER reprice the whole other container is consume-only (an unmatched row is a removed
//     or re-priced service, never an extra).
// A discarded duplicate may be the only carrier of cost and provenance metadata (explicitCogsCost,
// cogsServiceTypes, visitsPerYear, quoted fields): what the retained line lacks is transferred.
function resolveEstimateLines(data, { pricingAuthority = null, collectors, setupOpts, proposalLines = [] }) {
  const proposalAuthoritative = proposalLines.length > 0;
  const hasPricedLines = (container) => containerPricesAnything(container, collectors, setupOpts);
  const result = authoritativeEstimateResult(data, proposalAuthoritative ? {} : { pricingAuthority, hasPricedLines });
  if (proposalAuthoritative) return { result, rawLines: proposalLines };
  const rawLines = collectors.mapped(result, setupOpts);
  const covered = new Map();
  const priceKey = (l) => {
    const key = String(l.serviceKey || '');
    // termite_bond persists with its term baked in (termite_bond_5yr).
    const family = DEDUPE_FAMILY[key] || collectors.engineIdAliases[key] || (key.startsWith('termite_bond') ? 'termite_bait' : key);
    return `${family}|${l.cadence}`;
  };
  const remember = (l) => {
    const key = priceKey(l);
    if (!covered.has(key)) covered.set(key, []);
    covered.get(key).push({ price: Number(l.price) || 0, line: l });
  };
  rawLines.forEach(remember);
  const mappedServiceKeys = new Set(rawLines.map(priceKey));
  const serverRepriced = String(pricingAuthority || '').toUpperCase() === 'SERVER' && !!data.result && data.result !== data.engineResult;
  const merge = (extra, { consumeOnlyMappedServices = false, consumeOnly = false, transfer = OLDER_TRANSFER } = {}) => {
    const survivors = [];
    for (const line of extra) {
      const entries = covered.get(priceKey(line)) || [];
      const matchIdx = entries.findIndex((prev) => Math.abs(prev.price - (Number(line.price) || 0)) < 0.01);
      if (matchIdx < 0 && (consumeOnly || (consumeOnlyMappedServices && mappedServiceKeys.has(priceKey(line))))) continue;
      if (matchIdx >= 0) {
        const [{ line: retained }] = entries.splice(matchIdx, 1);
        transferMetadata(retained, line, transfer);
        continue;
      }
      survivors.push(line);
      rawLines.push(line);
    }
    // Intra-container siblings never dedupe against each other: they join the covered set only for LATER containers.
    survivors.forEach(remember);
  };
  merge(collectors.raw(result, setupOpts), { transfer: CURRENT_TRANSFER });
  // The current container's raw lines are priced services too: an older container's row for the same
  // service and cadence is a stale revision of them, never an extra.
  rawLines.forEach((line) => mappedServiceKeys.add(priceKey(line)));
  const other = data.engineResult;
  if (other && other !== result) {
    merge(collectors.mapped(other, setupOpts), { consumeOnlyMappedServices: true, consumeOnly: serverRepriced });
    merge(collectors.raw(other, setupOpts), { consumeOnlyMappedServices: true, consumeOnly: serverRepriced });
  }
  return { result, rawLines };
}

// An AUTHORED proposal is the accepted quote when it is enabled (estimate-public.js accept, which
// skips the retained engine rows for the same reason): its itemization, not result or engineResult,
// is what the customer agreed to. One test for every reader that must not look behind it.
const proposalIsAuthoritative = (data) => data?.proposal?.enabled === true;

module.exports = {
  proposalIsAuthoritative, authoritativeEstimateResult, resolveEstimateLines, containerPricesAnything, storedEstimateContainer, storedAreaAddOnRows,
};
