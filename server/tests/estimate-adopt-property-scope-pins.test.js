// Source pins for the property-scope widening (cross-property accept
// incident, 08-15):
// the adopt selector's property check and the converter's duplicate-series
// scope were both armed ONLY for grouped estimates, leaving ordinary
// estimates property-blind — a new-property accept adopted the old
// property's visit AND the old property's series suppressed seeding the new
// one. These pins keep both armed for every estimate with property
// evidence, and keep the under-lock recheck mirroring the preflight's
// coverage (skip explicitly-linked/claimed rows — owner ruling 2026-08-15:
// the under-lock recheck must never reject a row the preflight admitted).
const fs = require('fs');

const routeSrc = fs.readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
const converterSrc = fs.readFileSync(require.resolve('../services/estimate-converter'), 'utf8');

describe('adopt selector property scope', () => {
  test('the grouped-only arming is gone — every estimate with an address is scoped', () => {
    expect(routeSrc).not.toContain("estimate.estimate_group_id ? adoptStreetOf(estimate.address) : ''");
    expect(routeSrc).toContain('function makeAdoptionPropertyScope(conn, estimate)');
    // The customer-wide fallback consumes the shared factory.
    expect(routeSrc).toContain('const candidateAtQuotedProperty = makeAdoptionPropertyScope(conn, estimate);');
  });

  test('the under-lock recheck re-applies the scope to still-unclaimed adoptions only', () => {
    const lockIdx = routeSrc.indexOf('const lockedRowExplicitlyLinked =');
    const abortIdx = routeSrc.indexOf('|| !lockedFamilyOk || !lockedPropertyOk');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(lockIdx);
    // Explicit-link/claim shapes skip the check — preflight never applied
    // it to them, and the recheck must not reject what preflight admitted.
    const block = routeSrc.slice(lockIdx, abortIdx);
    expect(block).toContain('estData?.scheduled_service_id');
    expect(block).toContain('lockedAdoptRow.source_estimate_id');
    expect(block).toContain('makeAdoptionPropertyScope(trx, estimate)');
  });
});

describe('converter duplicate-series scope', () => {
  test('seriesAddressScope arms for every estimate with an address, not only grouped', () => {
    expect(converterSrc).not.toContain('if (estimate?.estimate_group_id && estimate.address) {');
    const armIdx = converterSrc.indexOf('let seriesAddressScope = null;');
    expect(armIdx).toBeGreaterThan(-1);
    expect(converterSrc.indexOf('if (estimate?.address || estimate?.property_id) {', armIdx)).toBeGreaterThan(armIdx);
  });
});

// The r1 trio (codex #3431): every other consumer that keyed property
// behavior on estimate_group_id had the same ungrouped blind spot the
// selector did — pin each widening.
describe('ungrouped cross-property companions (codex #3431 r1)', () => {
  const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');

  test('add-on replace evidence is property-scoped for every addressed estimate', () => {
    const fnIdx = converterSrc.indexOf('async function scopePlanRowsToEstimateProperty(rows)');
    expect(fnIdx).toBeGreaterThan(-1);
    const gateIdx = converterSrc.indexOf('if (!estimate?.address && !estimatePid) return rows;', fnIdx);
    expect(gateIdx).toBeGreaterThan(fnIdx);
    expect(converterSrc).not.toContain("if (!(estimate?.estimate_group_id && estimate.address)) return rows;");
  });

  test('ledger attribution bypass covers ungrouped cross-property accepts', () => {
    expect(converterSrc).toContain('const crossPropertyAccept =');
    // Narrowed in r2: the bypass fires only for the merged-component hazard
    // (same family provably at another property, or unknown) — see the r2
    // describe below.
    expect(converterSrc).toContain('const groupedEstimateAccept = !!estimate?.estimate_group_id');
    expect(converterSrc).toContain('(crossPropertyAccept && addOnContext.sameFamilyAtOtherProperty !== false)');
  });

  test('gate-off visit-address stamping covers ungrouped different-property accepts', () => {
    // The gate-off branch no longer bails on !estimate_group_id outright —
    // it compares the quoted address to the primary and stamps when they
    // differ (unknown primary keeps the legacy no-stamp default).
    expect(linkageSrc).not.toContain("if (!grouped?.estimate_group_id) return null;");
    const off = linkageSrc.indexOf('if (!grouped?.estimate_group_id) {');
    expect(off).toBeGreaterThan(-1);
    const block = linkageSrc.slice(off, linkageSrc.indexOf('logger.info', off));
    expect(block).toContain('sameScopeKey(estKey, primaryKey)');
  });

  test('parseEstimateAddress accepts the one-comma "street, City ST ZIP" shape', () => {
    expect(linkageSrc).toContain('|| line.match(/^(.*),\\s*([^,]+?)\\s+([A-Za-z]{2})\\.?\\s*(\\d{5})(?:-\\d{4})?$/)');
  });
});

// The r2 quartet (codex #3431 r2): unit-aware scope keys everywhere, the
// gate-on partial ungrouped stamp, and the narrowed ledger-attribution
// bypass that preserves unrelated family slices.
describe('unit-aware scope + attribution narrowing (codex #3431 r2)', () => {
  const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');
  const seederSrc = fs.readFileSync(require.resolve('../services/recurring-appointment-seeder'), 'utf8');

  test('every estimate-vs-candidate compare keys through makeEstimateScopeKeys', () => {
    // Adoption scope (route), plan-row scope + cross-property detection +
    // series scope (converter) all consume the shared unit-aware factory.
    expect(routeSrc).toContain('makeEstimateScopeKeys, sameScopeKey, scopeKeyLacksLocality');
    expect(converterSrc).toContain('const { makeEstimateScopeKeys, sameScopeKey, scopeKeyLacksLocality }');
    expect(converterSrc).toContain('makeEstimateScopeKeys: acceptScopeKeysOf');
    // The series scope hands its key builders to the seeder so parents are
    // keyed in the same mode as the estimate key.
    expect(converterSrc).toContain('candidateKey: scopeKeys ? scopeKeys.candidateKey : null,');
    expect(seederSrc).toContain('serviceAddressScope.candidateKey');
    expect(seederSrc).toContain('serviceAddressScope.candidateKeyFromRaw');
  });

  test('the classifier reports same-family-at-another-property for the bypass decision', () => {
    expect(converterSrc).toContain('const droppedOtherPropertyRows = [];');
    expect(converterSrc).toContain('else droppedOtherPropertyRows.push(row);');
    expect(converterSrc).toContain('const sameFamilyAtOtherProperty = droppedOtherPropertyRows');
  });

  test('gate-on partial-address stamping covers ungrouped different-property accepts', () => {
    expect(linkageSrc).toContain('let stampUngrouped = false;');
    expect(linkageSrc).toContain('if (estimate.estimate_group_id || stampUngrouped) {');
  });
});

// makeEstimateScopeKeys is pure — pin its unit semantics directly.
describe('makeEstimateScopeKeys unit semantics', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');

  test('a unitless estimate matches the unit-bearing PRIMARY but not an independently stamped unit (codex r9)', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Venice, FL 34285');
    expect(keys.estimateHasUnit).toBe(false);
    // primaryKey: unitless-compat vs the customer's own primary.
    const primary = keys.primaryKey('100 Primary Home St', 'Apt 4', 'Venice', '34285');
    expect(sameScopeKey(primary, keys.estimateKey)).toBe(true);
    // candidateKey: stamped candidates RETAIN unit identity — a unitless
    // estimate must not blanket-match every unit at a multi-unit street.
    const cand = keys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285');
    expect(sameScopeKey(cand, keys.estimateKey)).toBe(false);
    // The blind keys still agree — consumers use this to classify the
    // mismatch as unit-only (unprovable) rather than another property.
    expect(sameScopeKey(keys.blindKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.blindEstimateKey)).toBe(true);
  });

  test('an estimate WITH a unit keeps unit identity: Apt 5 != Apt 4, Apt 4 == Apt 4', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St Apt 5, Venice, FL 34285');
    expect(keys.estimateHasUnit).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.estimateKey)).toBe(false);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 5', 'Venice', '34285'), keys.estimateKey)).toBe(true);
  });

  test('unit-blind mode still separates genuinely different streets and localities', () => {
    const keys = makeEstimateScopeKeys('200 Second Home Rd, Venice, FL 34285');
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.estimateKey)).toBe(false);
    expect(sameScopeKey(keys.candidateKey('200 Second Home Rd', null, 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
    expect(sameScopeKey(keys.candidateKey('200 Second Home Rd', null, 'Venice', '34285'), keys.estimateKey)).toBe(true);
  });

  test('candidateKeyFromRaw retains unit identity; blindKeyFromRaw strips it (codex r9)', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Venice, FL 34285');
    expect(sameScopeKey(keys.candidateKeyFromRaw('100 Primary Home St Apt 4, Venice, FL 34285'), keys.estimateKey)).toBe(false);
    expect(sameScopeKey(keys.blindKeyFromRaw('100 Primary Home St Apt 4, Venice, FL 34285'), keys.blindEstimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKeyFromRaw('100 Primary Home St, Venice, FL 34285'), keys.estimateKey)).toBe(true);
  });

  // codex #3431 r3: partial parses are property evidence only when they look
  // like a street address — free text must not arm any scope consumer.
  test('non-address free text yields NO scope keys (partial evidence bar)', () => {
    expect(makeEstimateScopeKeys('the yellow house behind the marina')).toBe(null);
    expect(makeEstimateScopeKeys('call before arriving')).toBe(null);
    // A street-only partial WITH a house number still qualifies.
    expect(makeEstimateScopeKeys('100 Primary Home St')).not.toBe(null);
    expect(makeEstimateScopeKeys('Unit 4, 100 Beach Rd')).not.toBe(null);
  });

  test('the adoption scope guards street-only estimate keys with the primary locality', () => {
    const routeSrc2 = fs.readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    expect(routeSrc2).toContain('if (scopeKeyLacksLocality(estimateStreet)) {');
    expect(routeSrc2).toContain('scopeKeysShareLocality(candStreet, primary)');
  });
});

// The r4 set (codex #3431 r4): the "street, City" producer shape parses,
// the evidence bar covers raw source-estimate recovery, converter/seeder
// compares borrow the primary locality instead of wildcarding, and
// property_id travels through the classifier and duplicate-series guard.
describe('two-segment parse + pid-first scope (codex #3431 r4)', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');
  const seederSrc = fs.readFileSync(require.resolve('../services/recurring-appointment-seeder'), 'utf8');

  test('the booking-predraft "street, City" shape parses with a real city segment', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Venice');
    expect(keys).not.toBe(null);
    // City compares; missing zip wildcards.
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
    // A trailing state token folds away; the leading-unit form is untouched.
    expect(sameScopeKey(makeEstimateScopeKeys('100 Primary Home St, Venice FL').estimateKey, keys.estimateKey)).toBe(true);
    const unitForm = makeEstimateScopeKeys('Unit 4, 100 Beach Rd');
    expect(unitForm.estimateHasUnit).toBe(true);
  });

  test('raw source-estimate recovery applies the same partial evidence bar', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Venice, FL 34285');
    expect(keys.candidateKeyFromRaw('the yellow house behind the marina')).toBe('');
    expect(keys.candidateKeyFromRaw('200 Second Home Rd, Venice, FL 34285')).not.toBe('');
  });

  test('converter and seeder borrow the primary locality instead of wildcard-matching', () => {
    expect(converterSrc).toContain('let effectiveEstimateStreet = estimateStreet;');
    expect(converterSrc).toContain('sameScopeKey(street, effectiveEstimateStreet)');
    expect(seederSrc).toContain('if (primary && streetSegment(parentBlind) === streetSegment(primaryBlind)) {');
  });

  test('property_id travels through the classifier, series scope, and seeder', () => {
    expect(converterSrc).toContain('if (estimatePid) {');
    expect(converterSrc).toContain('if (rowPid === estimatePid) kept.push(row);');
    expect(converterSrc).toContain("'scheduled_services.property_id',");
    expect(converterSrc).toContain('estimatePropertyId: estimate?.property_id');
    expect(seederSrc).toContain('serviceAddressScope.estimatePropertyId && columns.property_id');
  });

  test('proven same-family-elsewhere bypasses attribution even without a street-detected cross-property accept', () => {
    expect(converterSrc).toContain('|| addOnContext.sameFamilyAtOtherProperty === true');
  });
});

// The r5 set (codex #3431 r5): the engine's stateless three-segment shape
// parses as a full address, pid-linked addressless estimates fail closed
// in adoption, a plainly different street token stays property proof even
// without locality, and partial property reconciliation is city-aware.
describe('three-segment parse + evidence refinements (codex #3431 r5)', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');
  const seederSrc = fs.readFileSync(require.resolve('../services/recurring-appointment-seeder'), 'utf8');

  test('the intent-composer "street, City, 34285" shape parses as a FULL address', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Venice, 34285');
    expect(keys).not.toBe(null);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
    // Equivalent to the stateful full shape.
    expect(sameScopeKey(makeEstimateScopeKeys('100 Primary Home St, Venice, FL 34285').estimateKey, keys.estimateKey)).toBe(true);
  });

  test('adoption fails closed for pid-linked estimates with no usable address', () => {
    const routeSrc3 = fs.readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    expect(routeSrc3).toContain('if (!estimateStreet) {');
    expect(routeSrc3).toContain('if (estimate.property_id) return false;');
  });

  test('a plainly different street token stays property proof when locality is unavailable', () => {
    expect(converterSrc).toContain('} else if (streetSegment(rowBlind) !== streetSegment(effectiveEstimateBlind)) {');
    expect(seederSrc).toContain('} else if (streetSegment(parentBlind) !== streetSegment(effectiveEstimateBlind)) {');
  });

  test('partial property reconciliation is city-aware', () => {
    const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');
    expect(linkageSrc).toContain('&& (!parsedCity || !normCity(p.city) || normCity(p.city) === parsedCity)');
  });
});

// The r6 set (codex #3431 r6): supported house-number shapes count as
// evidence, the composer's street+ZIP fallback parses, adoption requires
// SHARED locality evidence, and the converter/seeder fail-directions on
// disjoint evidence are pinned as deliberate.
describe('house-number evidence + shared locality (codex #3431 r6)', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');
  const seederSrc = fs.readFileSync(require.resolve('../services/recurring-appointment-seeder'), 'utf8');

  test('alphanumeric / ranged / slashed house numbers count as street evidence (hasPrimaryStreetNumber)', () => {
    expect(makeEstimateScopeKeys('123A Main St')).not.toBe(null);
    expect(makeEstimateScopeKeys('123-125 Main St')).not.toBe(null);
    expect(makeEstimateScopeKeys('123/2 Main St')).not.toBe(null);
    expect(makeEstimateScopeKeys('the yellow house behind the marina')).toBe(null);
  });

  test('the composer\'s "street, 34285" fallback parses with the zip as locality', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, 34285');
    expect(keys).not.toBe(null);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
  });

  test('the adoption predicate requires SHARED locality evidence on the final compare', () => {
    const routeSrc4 = fs.readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    expect(routeSrc4).toContain('return sameScopeKey(candStreet, estimateStreet) && scopeKeysShareLocality(candStreet, estimateStreet);');
  });

  test('converter and seeder disjoint-evidence fail-directions are deliberate and documented', () => {
    expect(converterSrc).toContain('DELIBERATE divergence from the adoption predicate');
    expect(seederSrc).toContain('DELIBERATE divergence from the adoption predicate');
  });
});

// The r7 set (codex #3431 r7): the fully comma-delimited producer shape
// parses (with its interposed unit line), partial reconciliation is
// ZIP-aware, and the linkage stamp decisions treat disjoint locality
// evidence as NOT-the-primary so fresh rows get stamped.
describe('comma-delimited producer shape + stamp evidence (codex #3431 r7)', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');
  const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');

  test('the "street, City, ST, 34285" pricing-ai shape parses as a FULL address', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Venice, FL, 34285');
    expect(keys).not.toBe(null);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
  });

  test('the interposed unit line survives as the unit ("street, Apt 4, City, ST, ZIP")', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Apt 4, Venice, FL, 34285');
    expect(keys.estimateHasUnit).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 5', 'Venice', '34285'), keys.estimateKey)).toBe(false);
  });

  test('partial property reconciliation is ZIP-aware', () => {
    expect(linkageSrc).toContain('&& (!parsedZip || !normalizeZip(p.zip) || normalizeZip(p.zip) === parsedZip));');
  });

  test('both linkage stamp decisions treat disjoint locality evidence as NOT the primary', () => {
    expect(linkageSrc).toContain('const estimateMatchesPrimary = sameScopeKey(estKey, primaryKey)');
    expect(linkageSrc).toContain('&& (scopeKeyLacksLocality(estKey) || scopeKeysShareLocality(estKey, primaryKey));');
    expect(linkageSrc).toContain('&& (scopeKeyLacksLocality(keys.estimateKey) || scopeKeysShareLocality(keys.estimateKey, primaryKey))));');
  });

  test('partial reconciliation prefers exact locality matches and treats plural wildcard survivors as ambiguous (codex r8)', () => {
    expect(linkageSrc).toContain('const exact = (parsedCity || parsedZip)');
    expect(linkageSrc).toContain('const matched = exact.length === 1 ? exact[0]');
  });
});

// The r9 set (codex #3431 r9): filtered producer combos parse without
// shifting state into city, and exact-locality matches must be unique.
describe('filtered producer combos + unique exact match (codex #3431 r9)', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');
  const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');

  test('the city-less "street, FL, 34285" join parses with FL as the STATE (zip locality, partial)', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, FL, 34285');
    expect(keys).not.toBe(null);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
  });

  test('the city-less unit variant keeps the unit line ("street, Apt 4, FL, 34285")', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Apt 4, FL, 34285');
    expect(keys.estimateHasUnit).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 5', 'Venice', '34285'), keys.estimateKey)).toBe(false);
  });

  test('plural exact-locality matches are ambiguous — linkage requires a UNIQUE exact match', () => {
    expect(linkageSrc).toContain('const matched = exact.length === 1 ? exact[0]');
    expect(linkageSrc).toContain(': (exact.length === 0 && candidates.length === 1 ? candidates[0] : null);');
  });
});

// The r10 set (codex #3431 r10): blind compatibility only for unitless
// estimates, evidence bar on full parses, the no-ZIP producer shape, and
// property-id recovery from source estimates.
describe('unit-strict blind keys + no-ZIP shapes + pid recovery (codex #3431 r10)', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');
  const seederSrc = fs.readFileSync(require.resolve('../services/recurring-appointment-seeder'), 'utf8');

  test('an estimate that explicitly quotes a unit keeps other units DISTINCT even under blind keys', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St Apt 5, Venice, FL 34285');
    expect(keys.estimateHasUnit).toBe(true);
    // blindKey degrades to the unit-retaining builder — Apt 4 is another
    // property, never a unit-only-mismatch duplicate.
    expect(sameScopeKey(keys.blindKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.blindEstimateKey)).toBe(false);
    expect(sameScopeKey(keys.blindKey('100 Primary Home St', 'Apt 5', 'Venice', '34285'), keys.blindEstimateKey)).toBe(true);
  });

  test('locality-suffixed prose fails the evidence bar despite a full structured parse', () => {
    expect(makeEstimateScopeKeys('the yellow house behind the marina, Venice, FL, 34285')).toBe(null);
    expect(makeEstimateScopeKeys('the yellow house behind the marina, Venice, FL 34285')).toBe(null);
  });

  test('the no-ZIP "street, City, ST" join parses (and keeps an interposed unit line)', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Venice, FL');
    expect(keys).not.toBe(null);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', null, 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
    const unitKeys = makeEstimateScopeKeys('100 Primary Home St, Apt 4, Venice, FL');
    expect(unitKeys.estimateHasUnit).toBe(true);
    expect(sameScopeKey(unitKeys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), unitKeys.estimateKey)).toBe(true);
  });

  test('converter and seeder recover a source estimate\'s property_id for unstamped rows', () => {
    expect(converterSrc).toContain(".first('address', 'property_id')");
    expect(converterSrc).toContain('if (src?.property_id) rowPid = String(src.property_id);');
    expect(seederSrc).toContain("const srcRow = await conn('estimates').where({ id: parent.source_estimate_id }).first('property_id');");
  });
});

// The r11 set (codex #3431 r11): state-only filtered shapes, the gate-off
// pid-linked fallback stamp, and blind compatibility restricted to the
// primary's own unit.
describe('state-only shapes + pid fallback stamp + primary-unit proof (codex #3431 r11)', () => {
  const { makeEstimateScopeKeys, sameScopeKey } = require('../services/estimate-property-linkage');
  const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');
  const seederSrc = fs.readFileSync(require.resolve('../services/recurring-appointment-seeder'), 'utf8');

  test('the state-only "street, FL" join parses with FL as the STATE, not the city', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, FL');
    expect(keys).not.toBe(null);
    expect(keys.estimateKey).not.toContain('|fl|');
    const unitKeys = makeEstimateScopeKeys('100 Primary Home St, Apt 4, FL');
    expect(unitKeys.estimateHasUnit).toBe(true);
    expect(sameScopeKey(unitKeys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), unitKeys.estimateKey)).toBe(true);
  });

  test('gate-off stamping falls back to the LINKED property row when the estimate address is unusable', () => {
    expect(linkageSrc).toContain("first('estimate_group_id', 'address', 'property_id')");
    expect(linkageSrc).toContain('stamped from linked property');
  });

  test('blind unit compatibility requires the row/parent to be the PRIMARY\'s own unit', () => {
    expect(converterSrc).toContain('&& customerPrimaryRetained && sameScopeKey(street, customerPrimaryRetained)) kept.push(row);');
    expect(seederSrc).toContain('&& primaryRetained && sameScopeKey(parentStreet, primaryRetained)) {');
    expect(converterSrc).toContain('customerPrimaryRetained,');
  });
});

// The r12 set (codex #3431 r12): structured numberless addresses fail
// CLOSED in adoption, the unit-and-city-only shape parses, and an explicit
// estimate unit requires a matching property-row unit.
describe('numberless fail-closed + unit-city shape + explicit unit match (codex #3431 r12)', () => {
  const { makeEstimateScopeKeys, sameScopeKey, parseEstimateAddress } = require('../services/estimate-property-linkage');
  const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');

  test('a structured locality-bearing numberless address parses as FULL but yields no keys', () => {
    const parts = parseEstimateAddress('Harbor Plaza Building, Venice, FL 34285');
    expect(parts.partial).toBe(false);
    expect(makeEstimateScopeKeys('Harbor Plaza Building, Venice, FL 34285')).toBe(null);
    // Adoption distinguishes this from free text — pinned in the route.
    const routeSrc5 = fs.readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    expect(routeSrc5).toContain('return !(parts && parts.partial === false);');
  });

  test('the unit-and-city-only "street, Apt 4, Venice" join parses with the unit and city separated', () => {
    const keys = makeEstimateScopeKeys('100 Primary Home St, Apt 4, Venice');
    expect(keys).not.toBe(null);
    expect(keys.estimateHasUnit).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 5', 'Venice', '34285'), keys.estimateKey)).toBe(false);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 4', 'Nokomis', '34275'), keys.estimateKey)).toBe(false);
  });

  test('an explicit estimate unit requires the property row to carry AND match it in reconciliation', () => {
    expect(linkageSrc).toContain('&& (!unit || normalizeStreet(p.address_line2) === unit)');
    expect(linkageSrc).not.toContain('(!unit || !normalizeStreet(p.address_line2) || normalizeStreet(p.address_line2) === unit)');
  });
});

// The r13 set (codex #3431 r13): punctuated unit designators, address
// notes never promoted to cities, and ID-matched adopted rows get their
// missing service address stamped.
describe('punctuated units + note-vs-city + id-matched stamping (codex #3431 r13)', () => {
  const { makeEstimateScopeKeys, sameScopeKey, parseEstimateAddress } = require('../services/estimate-property-linkage');
  const linkageSrc = fs.readFileSync(require.resolve('../services/estimate-property-linkage'), 'utf8');

  test('punctuated unit designators ("Apt. 5") extract into the unit line everywhere', () => {
    const parts = parseEstimateAddress('100 Primary Home St, Apt. 5, Venice, FL 34285');
    expect(parts.address_line2).toBe('Apt. 5');
    const keys = makeEstimateScopeKeys('100 Primary Home St, Apt. 5, Venice, FL 34285');
    expect(keys.estimateHasUnit).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 5', 'Venice', '34285'), keys.estimateKey)).toBe(true);
    expect(sameScopeKey(keys.candidateKey('100 Primary Home St', 'Apt 4', 'Venice', '34285'), keys.estimateKey)).toBe(false);
  });

  test('a free-text note after the street is NOT a city — the street half alone survives', () => {
    expect(parseEstimateAddress('100 Primary Home St, yellow house').city).toBe('');
    expect(parseEstimateAddress('100 Primary Home St, yellow house').address_line1).toBe('100 Primary Home St');
    expect(parseEstimateAddress('100 Primary Home St, yellow house, FL').city).toBe('');
    // Real Title-Cased producer cities still promote.
    expect(parseEstimateAddress('100 Primary Home St, North Port').city).toBe('North Port');
  });

  test('ID-matched adopted rows with no service address get stamped in both linkage paths', () => {
    expect(linkageSrc).toContain('// ID-MATCHED but address-less rows too (codex #3431 r13 P1)');
    expect(linkageSrc).toContain(".where({ source_estimate_id: estimateId, property_id: propertyId })");
    expect(linkageSrc).toContain("builder.whereNull('property_id').orWhere('property_id', grouped.property_id);");
  });
});
