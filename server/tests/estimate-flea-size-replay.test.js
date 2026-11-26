'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const { fleaSizeBasisSignalForReplay, fleaSizeReplayOverrides } = require('../services/estimate-flea-size-replay');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

// A sent flea quote must keep the price it was sent at when the size rule changes (owner ruling 2026-11-26 "whole home"):
// every replay re-runs generateEstimate, so the stored row's size-basis stamp (or its absence) decides the rule.
describe('flea size basis replay', () => {
  const inputs = { homeSqFt: 3000, stories: 2, lotSqFt: 7500, propertyType: 'single_family', services: { flea: {} } };

  test('a row quoted before the change (no stamp) replays the ground-floor size and keeps its price', () => {
    const legacyRow = { service: 'flea_package', name: 'Flea Elimination Package — 2 visits', price: 342 };
    const estData = { engineInputs: inputs, result: { oneTime: { items: [legacyRow] } } };
    expect(fleaSizeBasisSignalForReplay(estData)).toBe('ground_floor');
    const replayed = generateEstimate({ ...inputs, ...fleaSizeReplayOverrides(estData) });
    expect(replayed.lineItems.find((line) => line.service === 'flea_package').total).toBe(342);
  });

  test('a raw engine row without a stamp is legacy too, and a ground_floor stamp stays legacy', () => {
    expect(fleaSizeBasisSignalForReplay({ engineResult: { lineItems: [{ service: 'flea_package', serviceKey: 'flea', total: 342 }] } })).toBe('ground_floor');
    expect(fleaSizeBasisSignalForReplay({ result: { oneTime: { specItems: [{ service: 'flea_package', fleaSizeBasis: 'ground_floor' }] } } })).toBe('ground_floor');
  });

  test('a row quoted whole-home replays live, and the stamp survives the legacy mapper', () => {
    const fresh = generateEstimate(inputs);
    const mapped = mapV1ToLegacyShape(fresh);
    const rows = [...(mapped.oneTime.items || []), ...(mapped.oneTime.specItems || [])].filter((row) => row.service === 'flea_package');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.fleaSizeBasis === 'total_living_area')).toBe(true);
    expect(fleaSizeBasisSignalForReplay({ result: mapped, engineInputs: inputs })).toBeNull();
    expect(fleaSizeBasisSignalForReplay({ engineResult: fresh })).toBeNull();
  });

  test('an estimate with no flea row injects nothing, and the key is always present so stored inputs cannot price', () => {
    const estData = { engineInputs: { ...inputs, services: { dethatching: {} }, fleaSizeBasisReplay: 'ground_floor' }, result: { oneTime: { items: [{ service: 'dethatching', price: 100 }] } } };
    expect(fleaSizeBasisSignalForReplay(estData)).toBeNull();
    const overrides = fleaSizeReplayOverrides(estData);
    expect(Object.prototype.hasOwnProperty.call(overrides, 'fleaSizeBasisReplay')).toBe(true);
    expect(overrides.fleaSizeBasisReplay).toBeUndefined();
    expect({ ...estData.engineInputs, ...overrides }.fleaSizeBasisReplay).toBeUndefined();
  });

  test('stored JSON strings and empty data are handled', () => {
    expect(fleaSizeBasisSignalForReplay(null)).toBeNull();
    expect(fleaSizeBasisSignalForReplay(JSON.stringify({ result: { oneTime: { items: [{ service: 'flea_package' }] } } }))).toBe('ground_floor');
  });

  test('both authoritative replay paths inject the signal, and the save path strips a browser-posted copy', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    expect(read('../routes/estimate-public.js')).toMatch(/estimate-flea-size-replay'\)\.fleaSizeReplayOverrides\(estData\)/);
    const persistence = read('../services/admin-estimate-persistence.js');
    expect(persistence).toMatch(/estimate-flea-size-replay'\)\.fleaSizeReplayOverrides\(estimateData\)/);
    // The save path strips a browser-posted copy through the shared identity-field sanitizer.
    const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
    expect(CLIENT_IDENTITY_FIELDS).toContain('fleaSizeBasisReplay');
    expect(sanitizeClientIdentityFields({ homeSqFt: 3000, fleaSizeBasisReplay: 'ground_floor' })).toEqual({ homeSqFt: 3000 });
  });

  test('the deprecated client row (name only) is read as a flea row; a stamped client row replays live', () => {
    expect(fleaSizeBasisSignalForReplay({ result: { oneTime: { specItems: [{ name: 'Flea (2-visit)', price: 342 }] } } })).toBe('ground_floor');
    expect(fleaSizeBasisSignalForReplay({ result: { oneTime: { specItems: [{ name: 'Flea (2-visit)', price: 390, fleaSizeBasis: 'total_living_area' }] } } })).toBeNull();
  });

  test('compact draft writers keep the stamp, so a new quote is not read as legacy', () => {
    const fs = require('fs');
    const path = require('path');
    const { compactLineItem } = require('../services/lead-estimate-automation');
    const fresh = generateEstimate(inputs).lineItems.find((line) => line.service === 'flea_package');
    const compact = compactLineItem(fresh);
    expect(compact.fleaSizeBasis).toBe('total_living_area');
    expect(fleaSizeBasisSignalForReplay({ engineResult: { lineItems: [compact] } })).toBeNull();
    // The public quote's compact writer carries the whole record (stamp, size used, size source, posted size).
    expect(fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8')).toMatch(/item\.fleaSizeBasis \? \{ fleaSizeBasis: item\.fleaSizeBasis, footprintUsed: item\.footprintUsed \?\? null, footprintSource: item\.footprintSource \?\? null/);
    expect(compact).toMatchObject({ footprintUsed: 3000, footprintSource: 'homeSqFt' });
  });

  test('an aggregate (footprintUnknown) with a measured footprint prices the footprint, not the summed living area', () => {
    const flea = (extra) => generateEstimate({
      homeSqFt: 90000, stories: 1, lotSqFt: 200000, propertyType: 'single_family', footprintUnknown: true,
      services: { flea: {} }, ...extra,
    }).lineItems.find((line) => line.service === 'flea_package');
    expect(flea({ footprintSqFt: 1200 })).toMatchObject({ footprintUsed: 1200, total: 325 });
    expect(flea({})).toMatchObject({ footprintUsed: 2000, footprintWasDefaulted: true, requiresManualReview: true });
  });

  test('an inputs-only estimate (no stored row) replays ground-floor unless the save stamped it whole-home', () => {
    expect(fleaSizeBasisSignalForReplay({ engineInputs: inputs })).toBe('ground_floor');
    expect(fleaSizeBasisSignalForReplay({ engineInputs: { ...inputs, services: { fleaExterior: true } } })).toBe('ground_floor');
    expect(fleaSizeBasisSignalForReplay({ engineInputs: { ...inputs, fleaSizeBasisStamp: 'total_living_area' } })).toBeNull();
    expect(fleaSizeBasisSignalForReplay({ engineInputs: { ...inputs, fleaSizeBasisStamp: 'ground_floor' } })).toBe('ground_floor');
    expect(fleaSizeBasisSignalForReplay({ engineInputs: { homeSqFt: 3000, stories: 2, services: { pest: {} } } })).toBeNull();
    const replayed = generateEstimate({ ...inputs, ...fleaSizeReplayOverrides({ engineInputs: inputs }) });
    expect(replayed.lineItems.find((line) => line.service === 'flea_package').total).toBe(342);
  });

  test('the server-priced save stamps the basis into the replayable inputs', () => {
    const fs = require('fs');
    const path = require('path');
    expect(fs.readFileSync(path.join(__dirname, '../services/admin-estimate-persistence.js'), 'utf8'))
      .toMatch(/engineInputs\.fleaSizeBasisStamp = fleaBasisLine\.fleaSizeBasis/);
  });

  test('a freshly calculated client result (every copy of its flea row) replays live', () => {
    const esbuild = require('esbuild');
    const path = require('path');
    const clientPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');
    const out = esbuild.buildSync({
      stdin: { contents: require('fs').readFileSync(clientPath, 'utf8'), resolveDir: path.dirname(clientPath), sourcefile: 'estimateEngine.js', loader: 'js' },
      bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    });
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
    const estimate = mod.exports.calculateEstimate({
      homeSqFt: 3000, stories: 2, lotSqFt: 7500, propertyType: 'single_family', svcFlea: true, urgency: 'NONE', isAfterHours: false, isRecurringCustomer: false,
    });
    expect(estimate.error).toBeUndefined();
    expect(fleaSizeBasisSignalForReplay({ result: estimate })).toBeNull();
    // The same row without its stamp (a result saved before the change) replays ground-floor.
    const legacy = JSON.parse(JSON.stringify(estimate));
    for (const list of [legacy.specItems, legacy.oneTime.specItems]) for (const row of list) delete row.fleaSizeBasis;
    expect(fleaSizeBasisSignalForReplay({ result: legacy })).toBe('ground_floor');
  });

  test('buildingSqFt alone (the Intelligence Bar draft path) prices like its homeSqFt alias, with the same review reason', () => {
    const flea = (extra) => generateEstimate({ lotSqFt: 7500, propertyType: 'single_family', stories: 2, services: { flea: {} }, ...extra }).lineItems.find((line) => line.service === 'flea_package');
    const draft = flea({ buildingSqFt: 1500 });
    const compute = flea({ homeSqFt: 1500, buildingSqFt: 1500 });
    expect(draft).toMatchObject({ footprintUsed: 1500, total: 342, requiresManualReview: true });
    expect(draft.manualReviewReasons).toContain('flea_home_size_source_unclear');
    expect({ total: compute.total, used: compute.footprintUsed, reasons: compute.manualReviewReasons }).toEqual({ total: draft.total, used: draft.footprintUsed, reasons: draft.manualReviewReasons });
  });

  test('a request-only Admin V2 estimate (engineRequest.selectedServices) replays ground-floor on both replay paths', () => {
    const estData = { engineRequest: { profile: { homeSqFt: 3000, stories: 2 }, selectedServices: ['PEST', 'FLEA'] } };
    expect(fleaSizeBasisSignalForReplay(estData)).toBe('ground_floor');
    expect(fleaSizeBasisSignalForReplay({ engineRequest: { profile: {}, selectedServices: ['PEST'] } })).toBeNull();
    // The signal reads the stored blob, so the public replay and the authoritative recompute agree whatever the translated inputs hold.
    expect(fleaSizeReplayOverrides(estData)).toEqual({ fleaSizeBasisReplay: 'ground_floor' });
  });

  test('a mixed estimate (recurring lines in result, the only flea line in engineResult.lineItems) keeps the flea stamp', () => {
    const fresh = generateEstimate(inputs);
    const fleaLine = fresh.lineItems.find((line) => line.service === 'flea_package');
    expect(fleaLine.total).toBe(390);
    const mixed = { engineInputs: inputs, result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', monthly: 40 }] }, oneTime: { items: [] } }, engineResult: { lineItems: [fleaLine] } };
    // Before: only the chosen container was read, the flea row was invisible, and the inputs-only fallback replayed ground-floor ($342).
    expect(fleaSizeBasisSignalForReplay(mixed)).toBeNull();
    expect(generateEstimate({ ...inputs, ...fleaSizeReplayOverrides(mixed) }).lineItems.find((line) => line.service === 'flea_package').total).toBe(390);
    // A legacy unstamped flea line in the same shape still replays ground-floor ($342).
    const legacy = { ...mixed, engineResult: { lineItems: [{ ...fleaLine, fleaSizeBasis: undefined }] } };
    expect(fleaSizeBasisSignalForReplay(legacy)).toBe('ground_floor');
    // After a SERVER reprice the other container's flea row is not an extra: the stamp it carries is not read.
    const repriced = { ...mixed, pricingAuthorityAtLock: 'SERVER' };
    expect(fleaSizeBasisSignalForReplay(repriced)).toBe('ground_floor');
  });

  test('a published website quote keeps its measured whole home through the authoritative recompute (service-mix change on a published quote)', async () => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    // The website quote priced the flea package off the server lookup's measured 3,000 sq ft home beside the synthetic 2,000 default.
    const website = { homeSqFt: 2000, stories: 2, lotSqFt: 7500, propertyType: 'single_family', services: { flea: {} }, fleaMeasuredHomeSqFt: 3000, homeSqFtIsDefault: true };
    const fresh = generateEstimate(website);
    const row = fresh.lineItems.find((line) => line.service === 'flea_package');
    expect(row).toMatchObject({ total: 390, footprintUsed: 3000, footprintSource: 'lookup_measured_home' });
    const published = { engineInputs: website, engineResult: { lineItems: [row] } };

    const replayed = await serverRecomputeFromEstimateData(published, { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(replayed.recomputed).toBe(true);
    const replayedRow = replayed.rawEngineResult.lineItems.find((line) => line.service === 'flea_package');
    expect(replayedRow.total).toBe(390);
    // A copy that is not backed by a whole-home-stamped flea row never restores (and a fresh save strips it).
    expect(fleaSizeReplayOverrides({ engineInputs: website }).fleaMeasuredHomeSqFt).toBeUndefined();
    const unreplayed = await serverRecomputeFromEstimateData({ engineInputs: website }, { needsSync: () => false });
    expect(unreplayed.rawEngineResult.lineItems.find((line) => line.service === 'flea_package').total).toBe(350);
  });

  test('a browser-supplied measurement in any stored input carrier never changes a replayed price (only the stored row restores one)', () => {
    const forged = { ...inputs, homeSqFt: 2000, fleaMeasuredHomeSqFt: 5000, homeSqFtIsDefault: true };
    const ordinary = generateEstimate({ ...inputs, homeSqFt: 2000 }).lineItems.find((line) => line.service === 'flea_package');
    const stored = { engineInputs: forged, engineInput: forged, inputs: forged, result: { oneTime: { items: [ordinary] } }, engineResult: { lineItems: [ordinary] } };
    expect(fleaSizeReplayOverrides(stored).fleaMeasuredHomeSqFt).toBeUndefined();
    // The public replay and the add-service draft spread the overrides over the RAW stored inputs: both keys must clear.
    const overrides = fleaSizeReplayOverrides(stored);
    expect(overrides).toHaveProperty('fleaMeasuredHomeSqFt', undefined);
    expect(overrides).toHaveProperty('homeSqFtIsDefault', undefined);
    const replayed = generateEstimate({ ...forged, ...overrides }).lineItems.find((line) => line.service === 'flea_package');
    expect(replayed.total).toBe(ordinary.total);
  });
});

// A delivered legacy flea quote keeps its ground-floor price through a revision, until staff correct the home size: then the
// line prices on today's whole-home rule. The size comparison must see every carrier and field the legacy pricer read.
describe('flea price record: a size correction on a delivered legacy quote moves it to the whole-home rule', () => {
  const { fleaPriceRecord, generateWithFleaRecord } = require('../services/estimate-flea-size-replay');
  const sent = { sent_at: '2026-11-20T15:00:00Z', status: 'sent', address: '1 Example Way' };
  const fleaLine = (estimate) => estimate.lineItems.find((line) => line.service === 'flea_package');
  const base = { lotSqFt: 7500, propertyType: 'single_family', services: { flea: {} } };

  test('an inputs-only quote (legacy inputs carrier) re-prices when the living area changes', () => {
    const record = fleaPriceRecord(sent, { inputs: { ...base, homeSqFt: 3000, stories: 2 } });
    expect(record).toMatchObject({ basis: 'ground_floor', priorSize: { living: 3000, stories: 2 } });
    const revised = { ...base, homeSqFt: 4000, stories: 2 };
    expect(fleaLine(generateWithFleaRecord(generateEstimate, revised, record))).toEqual(fleaLine(generateEstimate(revised)));
  });

  test('an inputs-only quote with the size unchanged keeps the ground-floor price', () => {
    const record = fleaPriceRecord(sent, { inputs: { ...base, homeSqFt: 3000, stories: 2 } });
    const same = { ...base, homeSqFt: 3000, stories: 2 };
    expect(fleaLine(generateWithFleaRecord(generateEstimate, same, record)))
      .toEqual(fleaLine(generateEstimate({ ...same, fleaSizeBasisReplay: 'ground_floor' })));
  });

  test('a footprint correction re-prices even when a living area is present', () => {
    const prior = { ...base, homeSqFt: 3000, stories: 2, footprintSqFt: 1500 };
    const data = { engineInputs: prior, result: { lineItems: [{ service: 'flea_package', footprintUsed: 1500 }] } };
    const record = fleaPriceRecord(sent, data);
    expect(record).toMatchObject({ basis: 'ground_floor', priorSize: { living: 3000, footprint: 1500, stories: 2 } });
    const revised = { ...prior, footprintSqFt: 1800 };
    expect(fleaLine(generateWithFleaRecord(generateEstimate, revised, record))).toEqual(fleaLine(generateEstimate(revised)));
  });
});
