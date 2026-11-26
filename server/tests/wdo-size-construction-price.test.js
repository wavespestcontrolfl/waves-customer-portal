// WDO inspection by home size and construction (owner 2026-11-26): $150 floor up to $275, NEW quotes only.
// A saved quote replays under the estimate-level rule stamp pricingMetadata.legacyWdoFlat (estimate-floor-signal-replay.js
// readRuleStamp): a priced estimate with no stamp, or inputs-only that ask for WDO, was saved before the rule and keeps $250.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The send-snapshot builder's pricing bundle build is captured (the test reads the estimate data it is handed).
jest.mock('../routes/estimate-public', () => {
  const actual = jest.requireActual('../routes/estimate-public');
  actual.buildPricingBundle = jest.fn(async () => ({ captured: true }));
  return actual;
});

const { generateEstimate, priceWDO } = require('../services/pricing-engine');
const { SPECIALTY } = require('../services/pricing-engine/constants');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { savedLegacyWdoFlatSignal, savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
const { sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const publicRoute = require('../routes/estimate-public');
const { extractEngineInputs, invalidateSendSnapshotPricingBundle } = publicRoute;

const MARK = SPECIALTY.wdo.sizeTable.staffNoteMarker;
// The staff note on a priced line (undefined when none).
const staffNote = (line) => (line.warnings || []).find((w) => typeof w === 'string' && w.startsWith(MARK));
const LEGACY = SPECIALTY.wdo.brackets[0].price;
const baseInput = (overrides = {}) => ({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
  features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
  ...overrides,
});
const estimate = (overrides = {}) => generateEstimate(baseInput({ services: { wdo: {} }, ...overrides }));
const wdoLine = (est) => est.lineItems.find((li) => li.service === 'wdo_inspection');
const price = (overrides) => wdoLine(estimate(overrides)).price;
const strip = (value) => JSON.parse(JSON.stringify(value), (key, v) => (key === 'legacyWdoFlat' ? undefined : v));

describe('priceWDO: the size + construction table', () => {
  const BLOCK = ['CBS', 'BLOCK', 'STUCCO', 'concrete block', 'masonry', 'BRICK'];
  const FRAME = ['WOOD_FRAME', 'frame', 'mixed', 'Wood Frame'];

  test('the legacy flat price is unchanged: $250 at every size', () => {
    for (const homeSqFt of [900, 2500, 2501, 4000, 6000]) expect(priceWDO({ homeSqFt, footprint: homeSqFt }, { legacyWdoFlat: true }).price).toBe(LEGACY);
    expect(LEGACY).toBe(250);
  });

  test.each([
    [1500, 150, 175, 200], [2000, 150, 175, 200],
    [2001, 175, 200, 225], [3000, 175, 200, 225],
    [3001, 200, 225, 250], [4000, 200, 225, 250],
    [4001, 225, 250, 275], [6000, 225, 250, 275],
  ])('home %i sq ft: block $%i, frame $%i, crawl space $%i', (homeSqFt, block, frame, crawl) => {
    for (const c of BLOCK) {
      const r = priceWDO({ homeSqFt, constructionMaterial: c, foundationType: 'SLAB' });
      expect(r.price).toBe(block);
      expect(staffNote(r)).toBeUndefined();
    }
    for (const c of FRAME) {
      const r = priceWDO({ homeSqFt, constructionMaterial: c });
      expect(r.price).toBe(frame);
      expect(staffNote(r)).toBeUndefined();
    }
    for (const foundationType of ['CRAWLSPACE', 'RAISED', 'crawl space']) {
      for (const constructionMaterial of ['CBS', 'WOOD_FRAME', undefined]) {
        const r = priceWDO({ homeSqFt, constructionMaterial, foundationType });
        expect(r.price).toBe(crawl);
        // A known crawl space is a stated fact: no construction note even when the walls are unknown.
        expect(staffNote(r)).toBeUndefined();
      }
    }
  });

  test('the size is the home living area; the footprint stands in only when none is known', () => {
    expect(priceWDO({ homeSqFt: 3500, footprint: 1750, constructionMaterial: 'CBS' }).price).toBe(200);
    expect(priceWDO({ footprint: 3500, constructionMaterial: 'CBS' }).price).toBe(200);
    expect(priceWDO({ homeSqFt: 3500, footprint: 1750, constructionMaterial: 'CBS' }).sizeUsed).toBe(3500);
  });

  test('slab and basement foundations do not take the crawl-space column', () => {
    expect(priceWDO({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: 'SLAB' }).price).toBe(175);
    expect(priceWDO({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: 'BASEMENT' }).price).toBe(175);
  });

  test('unknown or untrusted construction prices as block and adds the internal staff note, never a guess up', () => {
    for (const constructionMaterial of [undefined, null, '', 'UNKNOWN', 'METAL']) {
      const r = priceWDO({ homeSqFt: 3000, constructionMaterial });
      expect(r.price).toBe(175);
      expect(staffNote(r)).toBeTruthy();
    }
    // A lookup value the record's evidence marks weak is treated as unknown: wood frame untrusted stays on the block price.
    const weak = priceWDO({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', constructionTrusted: false });
    expect(weak.price).toBe(175);
    expect(staffNote(weak)).toBeTruthy();
    // A weak crawl-space read is dropped (priced as a slab) and the staff note says so.
    const weakCrawl = priceWDO({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: 'CRAWLSPACE', foundationTrusted: false });
    expect(weakCrawl.price).toBe(175);
    expect(staffNote(weakCrawl)).toBeTruthy();
    // Only an explicit false distrusts: no verdict reads as trusted.
    expect(priceWDO({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', constructionTrusted: undefined }).price).toBe(200);
  });

  // Trust applies per field: a weak foundation prices as a slab (walls then pick the column), a weak construction reads as unknown.
  describe.each([
    ['WOOD_FRAME', 'SLAB'], ['WOOD_FRAME', 'CRAWLSPACE'], ['CBS', 'SLAB'], ['CBS', 'CRAWLSPACE'], ['UNKNOWN', 'SLAB'], ['UNKNOWN', 'CRAWLSPACE'],
  ])('walls %s on a %s foundation, 3,000 sq ft (block $175, frame $200, crawl $225)', (walls, foundation) => {
    test.each([
      [undefined, undefined], [false, undefined], [undefined, false], [false, false],
    ])('constructionTrusted=%s foundationTrusted=%s', (constructionTrusted, foundationTrusted) => {
      const r = priceWDO({ homeSqFt: 3000, constructionMaterial: walls, foundationType: foundation, constructionTrusted, foundationTrusted });
      const crawl = foundation === 'CRAWLSPACE' && foundationTrusted !== false;
      const wallsKnown = walls !== 'UNKNOWN' && constructionTrusted !== false;
      const price = crawl ? 225 : (wallsKnown && walls === 'WOOD_FRAME' ? 200 : 175);
      const noted = (!wallsKnown && !crawl) || (foundation === 'CRAWLSPACE' && foundationTrusted === false);
      expect(r.price).toBe(price);
      expect(!!staffNote(r)).toBe(noted);
    });
  });

  test('the reported case: wood frame trusted, crawl space untrusted, 3,000 sq ft = frame on slab $200 plus the note', () => {
    const r = priceWDO({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', foundationTrusted: false });
    expect(r.price).toBe(200);
    expect(r.wdoConstructionClass).toBe('frame');
    expect(staffNote(r)).toBeTruthy();
  });

  test('every living-area input the engine accepts sizes the table before the footprint', () => {
    // 4,000 sq ft of living area over two stories is a 2,000 sq ft footprint: the table reads the living area ($200 block).
    expect(priceWDO({ livingAreaSqFt: 4000, stories: 2, constructionMaterial: 'CBS' }).price).toBe(200);
    expect(priceWDO({ livingAreaSqFt: 4000, stories: 2, constructionMaterial: 'CBS' }).sizeUsed).toBe(4000);
    expect(priceWDO({ homeSqFt: 4000, stories: 2, constructionMaterial: 'CBS' }).price).toBe(200);
    // homeSqFt wins when both are given; a footprint alone still sizes it.
    expect(priceWDO({ homeSqFt: 1800, livingAreaSqFt: 4000, constructionMaterial: 'CBS' }).sizeUsed).toBe(1800);
    expect(priceWDO({ footprint: 4000, constructionMaterial: 'CBS' }).price).toBe(200);
    expect(price({ livingAreaSqFt: 4000, homeSqFt: undefined, stories: 2, constructionMaterial: 'CBS' })).toBe(200);
  });

  test('a staff-entered construction on the service wins and is trusted', () => {
    expect(price({ homeSqFt: 3000, constructionMaterial: 'CBS', constructionTrusted: false, services: { wdo: { constructionType: 'WOOD_FRAME' } } })).toBe(200);
  });
});

describe('estimate engine: fresh quotes', () => {
  test('3 sizes x 2 constructions + unknown, through the engine inputs', () => {
    const at = (homeSqFt, constructionMaterial, foundationType) => price({ homeSqFt, constructionMaterial, foundationType });
    expect([at(2000, 'CBS'), at(3000, 'CBS'), at(3500, 'CBS'), at(5000, 'CBS')]).toEqual([150, 175, 200, 225]);
    expect([at(2000, 'WOOD_FRAME'), at(3000, 'WOOD_FRAME'), at(3500, 'WOOD_FRAME'), at(5000, 'WOOD_FRAME')]).toEqual([175, 200, 225, 250]);
    expect([at(2000, 'CBS', 'CRAWLSPACE'), at(3000, 'CBS', 'RAISED'), at(3500, 'WOOD_FRAME', 'CRAWLSPACE'), at(5000, 'CBS', 'CRAWLSPACE')]).toEqual([200, 225, 250, 275]);
    const unknown = estimate({ homeSqFt: 3000 });
    expect(wdoLine(unknown).price).toBe(175);
    expect(staffNote(wdoLine(unknown))).toBeTruthy();
  });

  test('the lookup trust verdict on the input reaches the price', () => {
    expect(price({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', constructionTrusted: false })).toBe(175);
    const weakFoundation = wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', foundationTrusted: false }));
    expect(weakFoundation.price).toBe(200);
    expect(staffNote(weakFoundation)).toBeTruthy();
    expect(price({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME' })).toBe(200);
  });

  test('every fresh run stamps the metadata and the WDO line false; a legacy run stamps true and prices $250', () => {
    const fresh = estimate({ constructionMaterial: 'CBS' });
    expect(fresh.pricingMetadata.legacyWdoFlat).toBe(false);
    expect(wdoLine(fresh).legacyWdoFlat).toBe(false);
    const legacy = estimate({ constructionMaterial: 'CBS', legacyWdoFlat: true });
    expect(legacy.pricingMetadata.legacyWdoFlat).toBe(true);
    expect(wdoLine(legacy).legacyWdoFlat).toBe(true);
    expect(wdoLine(legacy).price).toBe(250);
    // Legacy equals the old pricer line for line.
    expect(wdoLine(legacy)).toEqual(expect.objectContaining(priceWDO({ footprint: wdoLine(legacy).footprintUsed, homeSqFt: 2000 }, { legacyWdoFlat: true })));
  });

  test('the legacy rule does not touch other services', () => {
    const withLegacy = generateEstimate(baseInput({ legacyWdoFlat: true, services: { wdo: {}, pest: { frequency: 'quarterly' } } }));
    const without = generateEstimate(baseInput({ services: { wdo: {}, pest: { frequency: 'quarterly' } } }));
    const pest = (est) => est.lineItems.find((li) => li.service === 'pest_control').price;
    expect(pest(withLegacy)).toBe(pest(without));
  });
});

describe('replay: the estimate-level rule stamp decides the price', () => {
  const REQUEST = (extra = {}) => baseInput({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', services: { wdo: {} }, ...extra });
  // A quote sold BEFORE this change: priced at the flat $250, so it carries no WDO stamp.
  function preChangeQuote() {
    const priced = generateEstimate({ ...REQUEST(), legacyWdoFlat: true });
    return { engineInputs: REQUEST(), engineResult: strip(priced), result: strip(mapV1ToLegacyShape(priced)) };
  }
  const freshQuote = () => {
    const priced = generateEstimate(REQUEST());
    return { engineInputs: REQUEST(), engineResult: priced, result: mapV1ToLegacyShape(priced) };
  };
  const publicReplayPrice = (saved) => wdoLine(generateEstimate(extractEngineInputs(saved))).price;
  const recomputePrice = async (saved) => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const out = await serverRecomputeFromEstimateData(saved, { needsSync: () => false, replaySavedPricingKnobs: true });
    expect(out.recomputed).toBe(true);
    return wdoLine({ lineItems: out.rawEngineResult.lineItems }).price;
  };

  test('a pre-change quote (no stamp) replays at $250, public and authoritative, on every saved shape', async () => {
    const saved = preChangeQuote();
    expect(wdoLine(saved.engineResult).price).toBe(250);
    expect(savedLegacyWdoFlatSignal(saved)).toEqual({ legacyWdoFlat: true });
    expect(savedFloorReplaySignals(saved).legacyWdoFlat).toBe(true);
    expect(extractEngineInputs(saved).legacyWdoFlat).toBe(true);
    expect(publicReplayPrice(saved)).toBe(250);
    expect(await recomputePrice(saved)).toBe(250);
    for (const shape of [{ engineResult: saved.engineResult }, { result: saved.result }]) {
      expect(savedLegacyWdoFlatSignal(shape)).toEqual({ legacyWdoFlat: true });
    }
  });

  test('a fresh quote replays at the table price and survives a stale posted value; the key is identity-stripped', async () => {
    const saved = freshQuote();
    expect(wdoLine(saved.engineResult).price).toBe(200);
    expect(savedLegacyWdoFlatSignal(saved)).toEqual({ legacyWdoFlat: false });
    expect(publicReplayPrice(saved)).toBe(200);
    expect(await recomputePrice(saved)).toBe(200);
    const forged = { ...saved, engineInputs: { ...saved.engineInputs, legacyWdoFlat: true } };
    expect(publicReplayPrice(forged)).toBe(200);
    expect(sanitizeClientIdentityFields({ legacyWdoFlat: true })).toEqual({});
  });

  test('the size and construction replayed are the stored inputs, never a live lookup', () => {
    const saved = freshQuote();
    const line = wdoLine(generateEstimate(extractEngineInputs(saved)));
    expect(line.sizeUsed).toBe(3000);
    expect(line.wdoConstructionClass).toBe('frame');
    // A stored quote that sold block keeps block (the replay reads only its own stored inputs).
    const block = { ...saved, engineInputs: REQUEST({ constructionMaterial: 'CBS' }) };
    expect(publicReplayPrice(block)).toBe(175);
  });

  test('a snapshot-only quote keeps its sold price after its pricing bundle is invalidated', async () => {
    const bundle = (amount) => ({ oneTimeBreakdown: { items: [{ service: 'wdo_inspection', price: amount }] } });
    const invalidated = (saved) => { const copy = JSON.parse(JSON.stringify(saved)); invalidateSendSnapshotPricingBundle(copy); return copy; };
    // Sold before the rule: the bundle prices it and no stamp exists anywhere; the invalidation freezes it first.
    const before = { engineInputs: REQUEST(), sendSnapshot: { pricingBundle: bundle(250) } };
    expect(savedLegacyWdoFlatSignal(before)).toEqual({ legacyWdoFlat: true });
    expect(invalidated(before).sendSnapshot).toEqual(expect.objectContaining({ legacyWdoFlat: true }));
    expect(publicReplayPrice(invalidated(before))).toBe(250);
    expect(await recomputePrice(invalidated(before))).toBe(250);
    // Sold under the rule: the snapshot builder froze the stamp beside the bundle, so the bundle can go.
    const after = { engineInputs: REQUEST(), sendSnapshot: { legacyWdoFlat: false, pricingBundle: bundle(200) } };
    expect(savedLegacyWdoFlatSignal(after)).toEqual({ legacyWdoFlat: false });
    expect(publicReplayPrice(invalidated(after))).toBe(200);
    expect(await recomputePrice(invalidated(after))).toBe(200);
  });

  test('an inputs-only estimate that asks for WDO replays at $250, every request carrier; one that does not pins nothing', async () => {
    const inputsOnly = () => ({ engineInputs: REQUEST() });
    expect(savedLegacyWdoFlatSignal(inputsOnly())).toEqual({ legacyWdoFlat: true });
    expect(extractEngineInputs(inputsOnly()).legacyWdoFlat).toBe(true);
    expect(publicReplayPrice(inputsOnly())).toBe(250);
    expect(await recomputePrice(inputsOnly())).toBe(250);
    const carrier = { services: { wdo: {} } };
    for (const saved of [
      { inputs: carrier }, { engineInput: carrier }, { result: { inputs: carrier } },
      { engineRequest: { profile: {}, selectedServices: ['PEST', 'WDO'] } },
      JSON.stringify({ engineInputs: carrier }),
    ]) expect(savedFloorReplaySignals(saved).legacyWdoFlat).toBe(true);
    expect(savedFloorReplaySignals({ engineInputs: baseInput({ services: { flea: {} } }) }).legacyWdoFlat).toBeUndefined();
    expect(savedFloorReplaySignals({ engineRequest: { profile: {}, selectedServices: ['PEST'] } }).legacyWdoFlat).toBeUndefined();
    // A fresh stamped quote is untouched by the fallback.
    expect(publicReplayPrice(freshQuote())).toBe(200);
  });

  test('a first send and a resend of an inputs-only quote both read $250; a fresh stamped draft reads the table price', async () => {
    const { buildEstimateSendSnapshot } = require('../routes/admin-estimates');
    const { buildPricingBundle } = publicRoute;
    const data = { engineInputs: REQUEST() };
    const build = async (estimateData, row = {}) => {
      buildPricingBundle.mockClear();
      const out = await buildEstimateSendSnapshot({ id: 'est-1', status: 'sending', estimate_data: estimateData, ...row }, () => new Date('2026-11-26T12:00:00Z'), { delivered: false });
      return { handed: buildPricingBundle.mock.calls[0][0].estimate_data, snapshot: out.sendSnapshot };
    };
    for (const row of [{}, { sent_at: '2026-11-20T15:00:00Z', status: 'sent' }]) {
      const built = await build(data, row);
      expect(built.handed.sendSnapshot).toEqual(expect.objectContaining({ legacyWdoFlat: true }));
      expect(publicReplayPrice(built.handed)).toBe(250);
      expect(built.snapshot.legacyWdoFlat).toBe(true);
    }
    buildPricingBundle.mockImplementationOnce(async () => { throw new Error('bundle failed'); });
    const failed = await buildEstimateSendSnapshot({ id: 'est-1', status: 'sending', estimate_data: data }, () => new Date('2026-11-26T12:00:00Z'), { delivered: false });
    expect(failed.sendSnapshot.pricingBundleError).toBe('bundle failed');
    expect(publicReplayPrice({ ...data, sendSnapshot: failed.sendSnapshot })).toBe(250);
    const builtFresh = await build(freshQuote());
    expect(builtFresh.snapshot.legacyWdoFlat).toBe(false);
    expect(publicReplayPrice(builtFresh.handed)).toBe(200);
  });

  test('the stamp is threaded through the add-service rail, rate review and the compaction paths', () => {
    const fs = require('fs');
    const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');
    expect(read('../routes/admin-estimates')).toContain('sendSnapshot.legacyWdoFlat = priorWdoFlat === true;');
    expect(read('../services/estimate-add-service-request')).toContain("'legacyWdoFlat'");
    expect(read('../services/rate-review')).toContain("'legacyWdoFlat'");
    expect(read('../routes/public-quote')).toContain('legacyWdoFlat: estimate.pricingMetadata.legacyWdoFlat');
    expect(read('../services/lead-estimate-automation')).toContain('legacyWdoFlat: estimate.pricingMetadata.legacyWdoFlat');
    expect(read('../services/lead-estimate-automation')).toContain('legacyWdoFlat: item.legacyWdoFlat');
  });
});

describe('the staff review note', () => {
  const NOTES = {
    unknownWalls: () => staffNote(wdoLine(estimate({ homeSqFt: 3000 }))),
    untrustedCrawl: () => staffNote(wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', foundationTrusted: false }))),
    both: () => staffNote(wdoLine(estimate({ homeSqFt: 3000, foundationType: 'CRAWLSPACE', foundationTrusted: false }))),
  };

  test('each case names the price chosen and what a confirmed alternative costs', () => {
    // 3,000 sq ft: block $175, wood frame $200, crawl space $225.
    expect(NOTES.unknownWalls()).toBe(`${MARK} priced as concrete block on a slab ($175): the home construction is not verified. If confirmed, wood frame on a slab would be $200; a confirmed crawl space or raised foundation would be $225. Confirm before sending.`);
    expect(NOTES.untrustedCrawl()).toBe(`${MARK} priced as wood frame on a slab ($200): the crawl space or raised foundation read is not verified. If confirmed, a confirmed crawl space or raised foundation would be $225. Confirm before sending.`);
    expect(NOTES.both()).toBe(`${MARK} priced as concrete block on a slab ($175): the home construction and the crawl space or raised foundation read are not verified. If confirmed, wood frame on a slab would be $200; a confirmed crawl space or raised foundation would be $225. Confirm before sending.`);
  });

  test('staff see it on the stored line; the customer one-time breakdown and deep strip drop it', () => {
    const priced = estimate({ homeSqFt: 3000 });
    const result = mapV1ToLegacyShape(priced);
    expect(staffNote(wdoLine(priced))).toBeTruthy();
    // The mapped (stored) one-time row carries it for staff.
    const mapped = [].concat(result.oneTime?.specItems || [], result.oneTime?.items || []).find((r) => r.service === 'wdo_inspection');
    expect(mapped).toBeTruthy();
    expect(JSON.stringify(mapped)).toContain(MARK);
    // The customer payload: the one-time sanitizer, and the deep strip as a second line of defense.
    const breakdown = { items: [{ ...mapped, amount: mapped.price }] };
    expect(JSON.stringify(publicRoute.sanitizePublicOneTimeBreakdown(breakdown))).not.toContain(MARK);
    const deep = publicRoute.stripInternalMarginFieldsDeep({ rows: [{ warnings: [NOTES.unknownWalls(), 'other'], reason: NOTES.both(), keep: 'x' }] });
    expect(JSON.stringify(deep)).not.toContain(MARK);
    expect(JSON.stringify(deep)).toContain('other');
    expect(JSON.stringify(deep)).toContain('"keep":"x"');
  });

  test('the public projection: normalizeOneTimeBreakdown copies no staff note into the row reason, for every case', () => {
    for (const make of Object.values(NOTES)) {
      expect(make()).toBeTruthy();
    }
    for (const overrides of [
      { homeSqFt: 3000 },
      { homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', foundationTrusted: false },
      { homeSqFt: 3000, foundationType: 'CRAWLSPACE', foundationTrusted: false },
    ]) {
      const priced = estimate(overrides);
      const saved = { engineResult: priced, result: mapV1ToLegacyShape(priced) };
      const rows = publicRoute.normalizeOneTimeBreakdown(saved).items;
      const row = rows.find((r) => r.service === 'wdo_inspection');
      expect(row).toBeTruthy();
      // The projection helper takes the unsanitized row: the reason must not carry the note even before the sanitizer runs.
      expect(String(row.reason || '')).not.toContain(MARK);
      const projected = publicRoute.sanitizePublicOneTimeBreakdown(publicRoute.stripInternalMarginFieldsDeep({ items: rows }));
      expect(JSON.stringify(projected)).not.toContain(MARK);
      expect(JSON.stringify(projected)).not.toContain('WDO staff note');
    }
  });

  test('a known construction carries no note at all', () => {
    const priced = estimate({ homeSqFt: 3000, constructionMaterial: 'CBS' });
    expect(JSON.stringify(priced.lineItems)).not.toContain(MARK);
  });
});

describe('staff revisions re-price on current rules; customer replays keep the sent price', () => {
  // Owner 09-26 ruling, same decision as #8626: a staff member who revises a delivered estimate and sends a fresh quote prices off
  // the current rules. The estimate tool posts the stored inputs back (identity fields stripped), so the saved stamp never rides it.
  test('a delivered $250 quote, revised by staff, prices off the table; its customer replay still reads $250', () => {
    const sentInputs = baseInput({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', services: { wdo: {} } });
    const delivered = { engineInputs: sentInputs, engineResult: strip(generateEstimate({ ...sentInputs, legacyWdoFlat: true })) };
    expect(wdoLine(delivered.engineResult).price).toBe(250);
    // Customer replay: the saved stamp (legacy) decides.
    expect(wdoLine(generateEstimate(extractEngineInputs(delivered))).price).toBe(250);
    // Staff revision: the posted body, even carrying a stale stamp, is stripped of server-owned keys and re-prices on the table.
    const posted = sanitizeClientIdentityFields({ ...sentInputs, legacyWdoFlat: true });
    expect(posted.legacyWdoFlat).toBeUndefined();
    expect(wdoLine(generateEstimate(posted)).price).toBe(200);
    expect(generateEstimate(posted).pricingMetadata.legacyWdoFlat).toBe(false);
  });
});

describe('public price list', () => {
  const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
  const services = () => computePublicPricingRanges({ refresh: true }).services;

  test('WDO shows $150-$275 by home size and construction', () => {
    const row = services().find((r) => r.key === 'wdo_inspection');
    expect(row.low).toBe(150);
    expect(row.high).toBe(275);
    expect(row.notes).toContain('by home size and construction');
  });

  test('the lawn program names no retired 6-visit option', () => {
    const row = services().find((r) => r.key === 'lawn_care_program');
    expect(row.notes).toContain('9x or 12x');
    expect(row.notes).not.toMatch(/\b6x\b/);
  });
});

describe('a saved profile with field evidence but no trust flag', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
  const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
  const profile = (extra = {}) => ({ homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St', constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', ...extra });
  const priceOf = (input) => wdoLine(generateEstimate(input));
  const translate = (p) => translateV2CallToV1Input(p, ['WDO'], { urgency: 'ROUTINE' });

  test('the translator derives the verdicts from fieldVerify evidence', () => {
    // Trusted (no evidence, or evidence without fieldVerify): disputed-free wood frame prices as frame ($200), no note.
    for (const fieldEvidence of [undefined, {}, { constructionMaterial: { fieldVerify: false } }]) {
      const trusted = priceOf(translate(profile({ fieldEvidence })));
      expect(trusted.price).toBe(200);
      expect(staffNote(trusted)).toBeUndefined();
    }
    // Disputed walls: block price plus the note.
    const disputed = priceOf(translate(profile({ fieldEvidence: { constructionMaterial: { fieldVerify: true } } })));
    expect(disputed.price).toBe(175);
    expect(staffNote(disputed)).toBeTruthy();
    // Disputed crawl-space read on trusted walls: frame on a slab plus the note.
    const crawl = priceOf(translate(profile({ foundationType: 'CRAWLSPACE', fieldEvidence: { foundationType: { fieldVerify: true } } })));
    expect(crawl.price).toBe(200);
    expect(staffNote(crawl)).toBeTruthy();
    // Both disputed.
    const both = priceOf(translate(profile({ foundationType: 'CRAWLSPACE', fieldEvidence: { constructionMaterial: { fieldVerify: true }, foundationType: { fieldVerify: true } } })));
    expect(both.price).toBe(175);
    // An explicit posted flag still wins.
    expect(translate(profile({ constructionTrusted: false })).constructionTrusted).toBe(false);
  });

  test('the estimator builder (call pipeline and revision path) carries the same verdicts', () => {
    const facts = { home: { value: 3000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] }, lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] }, newConstruction: false, tenant: false };
    const intent = { decision: 'draft', category: 'RESIDENTIAL', is_commercial: false, services: { wdo: {} }, address: '1 Test St' };
    const build = (lookupEnriched) => buildEngineInput({ intent, propertyFacts: facts, context: {}, lookupEnriched });
    const trusted = build({ constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', fieldEvidence: {} });
    expect(trusted.constructionTrusted).toBeUndefined();
    expect(priceOf(trusted).price).toBe(200);
    const disputed = build({ constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', fieldEvidence: { constructionMaterial: { fieldVerify: true } } });
    expect(disputed.constructionTrusted).toBe(false);
    expect(priceOf(disputed).price).toBe(175);
    expect(staffNote(priceOf(disputed))).toBeTruthy();
    const crawl = build({ constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', fieldEvidence: { foundationType: { fieldVerify: true } } });
    expect(crawl.foundationTrusted).toBe(false);
    expect(priceOf(crawl).price).toBe(200);
  });
});

describe('tech-verified phrasings reach the WDO line', () => {
  const verify = require('../services/property-lookup/lookup-cache').sanitizeVerifiedValue;
  // [typed text, verified value, WDO price at 3,000 sq ft on block-class walls (block $175, frame $200, crawl $225), staff note]
  test.each([
    ['CBS', 'CBS', 175, false],
    ['block', 'CBS', 175, false],
    ['masonry', 'CBS', 175, false],
    ['stucco', 'CBS', 175, false],
    ['concrete block and stucco', 'CBS', 175, false],
    ['CBS with metal roof', 'CBS', 175, false],
    ['brick', 'BRICK', 175, false],
    ['wood frame', 'WOOD_FRAME', 200, false],
    ['wood', 'WOOD_FRAME', 200, false],
    ['timber frame', 'WOOD_FRAME', 200, false],
    ['mixed', 'MIXED', 200, false],
    ['frame/stucco', 'MIXED', 200, false],
    ['stucco over wood frame', 'MIXED', 200, false],
    ['block with wood frame addition', 'MIXED', 200, false],
    ['brick veneer over frame', 'MIXED', 200, false],
    ['steel frame', 'METAL', 175, true],
    ['metal frame', 'METAL', 175, true],
    ['metal building', 'METAL', 175, true],
    ['prefab steel', 'METAL', 175, true],
  ])('walls %j -> %s: $%i, note %s', (text, expected, expectedPrice, note) => {
    expect(verify('constructionMaterial', text)).toBe(expected);
    const line = wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: verify('constructionMaterial', text) }));
    expect(line.price).toBe(expectedPrice);
    expect(!!staffNote(line)).toBe(note);
  });

  test('an unrecognised construction is dropped, not stored', () => {
    expect(verify('constructionMaterial', 'vinyl siding')).toBeUndefined();
    expect(verify('constructionMaterial', '')).toBeUndefined();
  });

  test.each([
    ['slab', 'SLAB', 175], ['monolithic slab', 'SLAB', 175], ['slab on grade', 'SLAB', 175], ['concrete slab', 'SLAB', 175],
    ['poured concrete', 'SLAB', 175], ['basement', 'BASEMENT', 175],
    ['crawl space', 'CRAWLSPACE', 225], ['crawl', 'CRAWLSPACE', 225], ['vented crawlspace', 'CRAWLSPACE', 225],
    ['concrete piers', 'RAISED', 225], ['concrete pilings', 'RAISED', 225], ['pilings', 'RAISED', 225], ['piers and beams', 'RAISED', 225],
    ['raised', 'RAISED', 225], ['raised floor', 'RAISED', 225], ['raised slab', 'RAISED', 225], ['stem wall', 'RAISED', 225],
    ['elevated on stilts', 'RAISED', 225],
  ])('foundation %j -> %s: $%i on block walls', (text, expected, expectedPrice) => {
    expect(verify('foundationType', text)).toBe(expected);
    const line = wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: verify('foundationType', text) }));
    expect(line.price).toBe(expectedPrice);
    expect(staffNote(line)).toBeUndefined();
  });
});

describe('a profile with no verdict flag and no evidence', () => {
  const { structuralTrustVerdicts } = require('../services/lookup-confidence');

  test('a satellite-only profile (no property record, no field evidence) is untrusted; a record-backed or source-less one is trusted', () => {
    const satellite = { constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', dataSources: { propertyRecord: false, satellite: true, fieldEvidence: false } };
    expect(structuralTrustVerdicts(satellite)).toEqual({ constructionTrusted: false, foundationTrusted: false });
    expect(structuralTrustVerdicts({ ...satellite, dataSources: { propertyRecord: true } })).toEqual({});
    expect(structuralTrustVerdicts({ constructionMaterial: 'WOOD_FRAME' })).toEqual({});
    // Evidence for the field (a tech verified it) keeps it trusted even with no record.
    expect(structuralTrustVerdicts({ ...satellite, fieldEvidence: { constructionMaterial: { sourceType: 'verified', fieldVerify: false } } }))
      .toEqual({ foundationTrusted: false });
  });

  test('through the translator: a satellite-only wood frame prices block with the note', () => {
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const input = translateV2CallToV1Input({ homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St', constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', dataSources: { propertyRecord: false, satellite: true } }, ['WDO'], { urgency: 'ROUTINE' });
    const line = wdoLine(generateEstimate(input));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeTruthy();
  });
});

describe('public price list range comes from the table', () => {
  test('low and high are the min and max over every table cell', () => {
    const { tiers } = SPECIALTY.wdo.sizeTable;
    const cells = tiers.flatMap((t) => [t.block, t.frame, t.crawl]);
    const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
    const row = computePublicPricingRanges({ refresh: true }).services.find((r) => r.key === 'wdo_inspection');
    expect(row.low).toBe(Math.min(...cells));
    expect(row.high).toBe(Math.max(...cells));
  });
});
