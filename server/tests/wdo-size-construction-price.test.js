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
// A reading counts only with an explicit trust stamp true (owner 2026-11-26): the fixtures carry it, the trust cases override it.
const TRUSTED = { constructionTrusted: true, foundationTrusted: true };
const wdo = (property, options) => priceWDO({ ...TRUSTED, ...property }, options);
const baseInput = (overrides = {}) => ({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A', ...TRUSTED,
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
    for (const homeSqFt of [900, 2500, 2501, 4000, 6000]) expect(wdo({ homeSqFt, footprint: homeSqFt }, { legacyWdoFlat: true }).price).toBe(LEGACY);
    expect(LEGACY).toBe(250);
  });

  test.each([
    [1500, 150, 175, 200], [2000, 150, 175, 200],
    [2001, 175, 200, 225], [3000, 175, 200, 225],
    [3001, 200, 225, 250], [4000, 200, 225, 250],
    [4001, 225, 250, 275], [6000, 225, 250, 275],
  ])('home %i sq ft: block $%i, frame $%i, crawl space $%i', (homeSqFt, block, frame, crawl) => {
    for (const c of BLOCK) {
      const r = wdo({ homeSqFt, constructionMaterial: c, foundationType: 'SLAB' });
      expect(r.price).toBe(block);
      expect(staffNote(r)).toBeUndefined();
    }
    for (const c of FRAME) {
      const r = wdo({ homeSqFt, constructionMaterial: c });
      expect(r.price).toBe(frame);
      expect(staffNote(r)).toBeUndefined();
    }
    for (const foundationType of ['CRAWLSPACE', 'RAISED', 'crawl space']) {
      for (const constructionMaterial of ['CBS', 'WOOD_FRAME', undefined]) {
        const r = wdo({ homeSqFt, constructionMaterial, foundationType });
        expect(r.price).toBe(crawl);
        // A known crawl space is a stated fact: no construction note even when the walls are unknown.
        expect(staffNote(r)).toBeUndefined();
      }
    }
  });

  test('the size is the home living area; the footprint stands in only when none is known', () => {
    expect(wdo({ homeSqFt: 3500, footprint: 1750, constructionMaterial: 'CBS' }).price).toBe(200);
    expect(wdo({ footprint: 3500, constructionMaterial: 'CBS' }).price).toBe(200);
    expect(wdo({ homeSqFt: 3500, footprint: 1750, constructionMaterial: 'CBS' }).sizeUsed).toBe(3500);
  });

  test('slab and basement foundations do not take the crawl-space column', () => {
    expect(wdo({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: 'SLAB' }).price).toBe(175);
    expect(wdo({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: 'BASEMENT' }).price).toBe(175);
  });

  test('unknown or untrusted construction prices as block and adds the internal staff note, never a guess up', () => {
    for (const constructionMaterial of [undefined, null, '', 'UNKNOWN', 'METAL']) {
      const r = wdo({ homeSqFt: 3000, constructionMaterial });
      expect(r.price).toBe(175);
      expect(staffNote(r)).toBeTruthy();
    }
    // A lookup value the record's evidence marks weak is treated as unknown: wood frame untrusted stays on the block price.
    const weak = wdo({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', constructionTrusted: false });
    expect(weak.price).toBe(175);
    expect(staffNote(weak)).toBeTruthy();
    // A weak crawl-space read is dropped (priced as a slab) and the staff note says so.
    const weakCrawl = wdo({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: 'CRAWLSPACE', foundationTrusted: false });
    expect(weakCrawl.price).toBe(175);
    expect(staffNote(weakCrawl)).toBeTruthy();
    // Only an explicit true trusts: no stamp reads untrusted (block price + the note), never a guess up.
    const unstamped = wdo({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', constructionTrusted: undefined });
    expect(unstamped.price).toBe(175);
    expect(staffNote(unstamped)).toBeTruthy();
    expect(wdo({ homeSqFt: 3000, constructionMaterial: 'CBS', foundationType: 'CRAWLSPACE', foundationTrusted: undefined }).price).toBe(175);
  });

  // Trust applies per field and only an explicit true counts: an untrusted or unstamped foundation prices as a slab (walls then pick
  // the column), an untrusted or unstamped construction reads as unknown.
  describe.each([
    ['WOOD_FRAME', 'SLAB'], ['WOOD_FRAME', 'CRAWLSPACE'], ['CBS', 'SLAB'], ['CBS', 'CRAWLSPACE'], ['UNKNOWN', 'SLAB'], ['UNKNOWN', 'CRAWLSPACE'],
  ])('walls %s on a %s foundation, 3,000 sq ft (block $175, frame $200, crawl $225)', (walls, foundation) => {
    test.each([
      [true, true], [false, true], [true, false], [false, false], [undefined, undefined], [true, undefined], [undefined, true],
    ])('constructionTrusted=%s foundationTrusted=%s', (constructionTrusted, foundationTrusted) => {
      const r = wdo({ homeSqFt: 3000, constructionMaterial: walls, foundationType: foundation, constructionTrusted, foundationTrusted });
      const crawl = foundation === 'CRAWLSPACE' && foundationTrusted === true;
      const wallsKnown = walls !== 'UNKNOWN' && constructionTrusted === true;
      const price = crawl ? 225 : (wallsKnown && walls === 'WOOD_FRAME' ? 200 : 175);
      const noted = (!wallsKnown && !crawl) || (foundation === 'CRAWLSPACE' && foundationTrusted !== true);
      expect(r.price).toBe(price);
      expect(!!staffNote(r)).toBe(noted);
      // A conservative rule can only lower a quote versus the frame / crawl cells, never raise it.
      expect(r.price).toBeLessThanOrEqual(wdo({ homeSqFt: 3000, constructionMaterial: walls, foundationType: foundation }).price);
    });
  });

  test('the reported case: wood frame trusted, crawl space untrusted, 3,000 sq ft = frame on slab $200 plus the note', () => {
    const r = wdo({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', foundationTrusted: false });
    expect(r.price).toBe(200);
    expect(r.wdoConstructionClass).toBe('frame');
    expect(staffNote(r)).toBeTruthy();
  });

  test('every living-area input the engine accepts sizes the table before the footprint', () => {
    // 4,000 sq ft of living area over two stories is a 2,000 sq ft footprint: the table reads the living area ($200 block).
    expect(wdo({ livingAreaSqFt: 4000, stories: 2, constructionMaterial: 'CBS' }).price).toBe(200);
    expect(wdo({ livingAreaSqFt: 4000, stories: 2, constructionMaterial: 'CBS' }).sizeUsed).toBe(4000);
    expect(wdo({ homeSqFt: 4000, stories: 2, constructionMaterial: 'CBS' }).price).toBe(200);
    // homeSqFt wins when both are given; a footprint alone still sizes it.
    expect(wdo({ homeSqFt: 1800, livingAreaSqFt: 4000, constructionMaterial: 'CBS' }).sizeUsed).toBe(1800);
    expect(wdo({ footprint: 4000, constructionMaterial: 'CBS' }).price).toBe(200);
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
    // No stamp on the engine input reads untrusted: block price + the note.
    const unstamped = wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: 'WOOD_FRAME', constructionTrusted: undefined, foundationTrusted: undefined }));
    expect(unstamped.price).toBe(175);
    expect(staffNote(unstamped)).toBeTruthy();
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
    expect(wdoLine(legacy)).toEqual(expect.objectContaining(wdo({ footprint: wdoLine(legacy).footprintUsed, homeSqFt: 2000 }, { legacyWdoFlat: true })));
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

  const COUNTY = { sourceType: 'county', fieldVerify: false };

  test('the translator trusts only a stamp true or field-specific non-satellite evidence', () => {
    // County evidence without fieldVerify: wood frame prices as frame ($200), no note.
    const trusted = priceOf(translate(profile({ fieldEvidence: { constructionMaterial: COUNTY, foundationType: COUNTY } })));
    expect(trusted.price).toBe(200);
    expect(staffNote(trusted)).toBeUndefined();
    // An explicit true stamp also trusts.
    expect(priceOf(translate(profile({ constructionTrusted: true, foundationTrusted: true }))).price).toBe(200);
    // Everything else is untrusted: no evidence, empty evidence, evidence with no source, a satellite / AI source.
    for (const fieldEvidence of [undefined, {}, { constructionMaterial: { fieldVerify: false } }, { constructionMaterial: { sourceType: 'satellite', fieldVerify: false } }, { constructionMaterial: { sourceType: 'generic', fieldVerify: false } }]) {
      const untrusted = priceOf(translate(profile({ fieldEvidence })));
      expect(untrusted.price).toBe(175);
      expect(staffNote(untrusted)).toBeTruthy();
    }
    // A tech-verified value is trusted.
    expect(priceOf(translate(profile({ fieldEvidence: { constructionMaterial: { sourceType: 'verified', fieldVerify: false } } }))).price).toBe(200);
    // Disputed walls (fieldVerify) override a true stamp: block price plus the note.
    const disputed = priceOf(translate(profile({ constructionTrusted: true, fieldEvidence: { constructionMaterial: { ...COUNTY, fieldVerify: true } } })));
    expect(disputed.price).toBe(175);
    expect(staffNote(disputed)).toBeTruthy();
    // Disputed crawl-space read on trusted walls: frame on a slab plus the note.
    const crawl = priceOf(translate(profile({ foundationType: 'CRAWLSPACE', fieldEvidence: { constructionMaterial: COUNTY, foundationType: { ...COUNTY, fieldVerify: true } } })));
    expect(crawl.price).toBe(200);
    expect(staffNote(crawl)).toBeTruthy();
    // Trusted crawl space prices as crawl.
    expect(priceOf(translate(profile({ foundationType: 'CRAWLSPACE', fieldEvidence: { constructionMaterial: COUNTY, foundationType: COUNTY } }))).price).toBe(225);
    // An explicit posted false wins over evidence.
    expect(translate(profile({ constructionTrusted: false, fieldEvidence: { constructionMaterial: COUNTY } })).constructionTrusted).toBe(false);
  });

  test('the estimator builder (call pipeline and revision path) carries the same verdicts', () => {
    const facts = { home: { value: 3000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] }, lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] }, newConstruction: false, tenant: false };
    const intent = { decision: 'draft', category: 'RESIDENTIAL', is_commercial: false, services: { wdo: {} }, address: '1 Test St' };
    const build = (lookupEnriched) => buildEngineInput({ intent, propertyFacts: facts, context: {}, lookupEnriched });
    const trusted = build({ constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', fieldEvidence: { constructionMaterial: COUNTY, foundationType: COUNTY } });
    expect(trusted.constructionTrusted).toBe(true);
    expect(priceOf(trusted).price).toBe(200);
    // No stamp and no evidence: untrusted.
    const bare = build({ constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', fieldEvidence: {} });
    expect(bare.constructionTrusted).toBe(false);
    expect(priceOf(bare).price).toBe(175);
    const disputed = build({ constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', fieldEvidence: { constructionMaterial: { ...COUNTY, fieldVerify: true } } });
    expect(disputed.constructionTrusted).toBe(false);
    expect(priceOf(disputed).price).toBe(175);
    expect(staffNote(priceOf(disputed))).toBeTruthy();
    const crawl = build({ constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE', fieldEvidence: { constructionMaterial: COUNTY, foundationType: { ...COUNTY, fieldVerify: true } } });
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
  const COUNTY = { sourceType: 'county', fieldVerify: false };

  test('only a stamp true or field-specific non-satellite evidence is trusted; old, record-only and source-less profiles are not', () => {
    const base = { constructionMaterial: 'WOOD_FRAME', foundationType: 'CRAWLSPACE' };
    const untrusted = { constructionTrusted: false, foundationTrusted: false, homeSizeTrusted: true };
    expect(structuralTrustVerdicts(base)).toEqual(untrusted);
    expect(structuralTrustVerdicts({ ...base, dataSources: { propertyRecord: true } })).toEqual(untrusted);
    expect(structuralTrustVerdicts({ ...base, dataSources: { propertyRecord: false, satellite: true } })).toEqual(untrusted);
    expect(structuralTrustVerdicts({ ...base, fieldEvidence: { constructionMaterial: { sourceType: 'satellite', fieldVerify: false } } })).toEqual(untrusted);
    expect(structuralTrustVerdicts({ ...base, constructionTrusted: true, foundationTrusted: true })).toEqual({ constructionTrusted: true, foundationTrusted: true, homeSizeTrusted: true });
    expect(structuralTrustVerdicts({ ...base, fieldEvidence: { constructionMaterial: COUNTY } })).toEqual({ constructionTrusted: true, foundationTrusted: false, homeSizeTrusted: true });
    expect(structuralTrustVerdicts({ ...base, fieldEvidence: { constructionMaterial: { sourceType: 'verified', fieldVerify: false } } }).constructionTrusted).toBe(true);
    // fieldVerify beats a true stamp; a false stamp beats evidence.
    expect(structuralTrustVerdicts({ ...base, constructionTrusted: true, fieldEvidence: { constructionMaterial: { ...COUNTY, fieldVerify: true } } }).constructionTrusted).toBe(false);
    expect(structuralTrustVerdicts({ ...base, constructionTrusted: false, fieldEvidence: { constructionMaterial: COUNTY } }).constructionTrusted).toBe(false);
  });

  test('evidence sources are an allowlist: model_inference, listing and other non-record sources are untrusted, raw arrays too', () => {
    const { structuralFactIsRecordBacked } = require('../services/lookup-confidence');
    const base = { constructionMaterial: 'WOOD_FRAME', foundationType: 'RAISED' };
    for (const sourceType of ['model_inference', 'listing', 'aggregator', 'ai', 'vision', 'generic', 'unknown', '']) {
      // single object and raw array shapes, with fieldVerify omitted
      expect(structuralTrustVerdicts({ ...base, fieldEvidence: { foundationType: { sourceType } } }).foundationTrusted).toBe(false);
      expect(structuralTrustVerdicts({ ...base, _fieldEvidence: { foundationType: [{ sourceType, value: 'RAISED' }] } }).foundationTrusted).toBe(false);
      // a machine stamp true does not survive non-accepted evidence for the same field
      expect(structuralTrustVerdicts({ ...base, foundationTrusted: true, _fieldEvidence: { foundationType: [{ sourceType }] } }).foundationTrusted).toBe(false);
      // the lookup's own record stamp refuses it as well
      expect(structuralFactIsRecordBacked({ record: { foundationType: 'RAISED', _fieldEvidence: { foundationType: [{ sourceType }] } }, field: 'foundationType' })).toBe(false);
    }
    for (const sourceType of ['county', 'cadastral', 'permit', 'builder', 'verified']) {
      expect(structuralTrustVerdicts({ ...base, _fieldEvidence: { foundationType: [{ sourceType }] } }).foundationTrusted).toBe(true);
      expect(structuralFactIsRecordBacked({ record: { foundationType: 'RAISED', _fieldEvidence: { foundationType: { sourceType } } }, field: 'foundationType' })).toBe(true);
    }
    // a value a person typed still wins
    expect(structuralTrustVerdicts({ ...base, _manualFields: ['foundationType'], _fieldEvidence: { foundationType: [{ sourceType: 'model_inference' }] } }).foundationTrusted).toBe(true);
  });

  test('the lookup stamps a record value trusted only with field evidence from an accepted source: a value with none is untrusted', () => {
    const { structuralFactIsRecordBacked } = require('../services/lookup-confidence');
    for (const _fieldEvidence of [undefined, {}, { foundationType: [] }, { foundationType: null }]) {
      expect(structuralFactIsRecordBacked({ record: { foundationType: 'RAISED', _source: 'listing', _fieldEvidence }, field: 'foundationType' })).toBe(false);
    }
    expect(structuralFactIsRecordBacked({ record: { foundationType: 'RAISED', _fieldEvidence: { foundationType: { sourceType: 'county' } } }, field: 'foundationType' })).toBe(true);
    // The reported case, rebuilt by the lookup's own profile build: a cached listing record with an inferred raised foundation and
    // no field evidence. The stamp is false, so the WDO prices the slab cell ($175 at 3,000 sq ft) with the note, not the crawl $225.
    const { buildEnrichedProfile, translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const enriched = buildEnrichedProfile({ squareFootage: 3000, lotSize: 9000, yearBuilt: 2004, constructionMaterial: 'CBS', foundationType: 'RAISED', _source: 'listing' }, null, 27.1, -82.4);
    expect(enriched.foundationTrusted).toBe(false);
    const line = wdoLine(generateEstimate(translateV2CallToV1Input({ ...enriched, homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St' }, ['WDO'], { urgency: 'ROUTINE' })));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeTruthy();
  });

  test('through the translator: an AI-inferred raised foundation on block walls prices the slab cell with the note', () => {
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const input = translateV2CallToV1Input({ homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St', constructionMaterial: 'CBS', foundationType: 'RAISED', constructionTrusted: true, foundationTrusted: true, fieldEvidence: { foundationType: [{ sourceType: 'model_inference' }] } }, ['WDO'], { urgency: 'ROUTINE' });
    const line = wdoLine(generateEstimate(input));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeTruthy();
  });

  test('through the translator: a satellite-only wood frame prices block with the note', () => {
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const input = translateV2CallToV1Input({ homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St', constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', dataSources: { propertyRecord: false, satellite: true } }, ['WDO'], { urgency: 'ROUTINE' });
    const line = wdoLine(generateEstimate(input));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeTruthy();
  });
});

describe('a value a person types in is trusted; a machine reading is not', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const translate = (p) => translateV2CallToV1Input({ homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St', ...p }, ['WDO'], { urgency: 'ROUTINE' });
  const satellite = { dataSources: { propertyRecord: false, satellite: true }, constructionTrusted: false, foundationTrusted: false };

  test('staff-typed wood frame on the WDO service prices $200 with no note', () => {
    const line = wdoLine(estimate({ homeSqFt: 3000, constructionTrusted: undefined, foundationTrusted: undefined, services: { wdo: { constructionType: 'wood frame' } } }));
    expect(line.price).toBe(200);
    expect(staffNote(line)).toBeUndefined();
  });

  test('staff-typed concrete piers on the WDO service price the crawl column ($225) with no note', () => {
    const line = wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: 'CBS', constructionTrusted: false, foundationTrusted: false, services: { wdo: { foundationType: 'concrete piers' } } }));
    expect(line.price).toBe(225);
    expect(staffNote(line)).toBeUndefined();
  });

  test('values the estimator form marks manual (_manualFields) are trusted over a stale machine stamp', () => {
    const wood = wdoLine(generateEstimate(translate({ ...satellite, constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', _manualFields: ['constructionMaterial'] })));
    expect(wood.price).toBe(200);
    expect(staffNote(wood)).toBeUndefined();
    const piers = wdoLine(generateEstimate(translate({ ...satellite, constructionMaterial: 'CBS', foundationType: 'CRAWLSPACE', _manualFields: ['constructionMaterial', 'foundationType'] })));
    expect(piers.price).toBe(225);
    expect(staffNote(piers)).toBeUndefined();
  });

  test('a satellite wood frame stays untrusted: block price plus the note', () => {
    const line = wdoLine(generateEstimate(translate({ ...satellite, constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB' })));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeTruthy();
    // An unrelated manual field does not trust the machine reading.
    expect(wdoLine(generateEstimate(translate({ ...satellite, constructionMaterial: 'WOOD_FRAME', _manualFields: ['bedArea'] }))).price).toBe(175);
  });
});

describe('MIXED construction moves no termite, pest or inspection-time price (it reads as wood frame, as county "frame stucco" did)', () => {
  const { deriveModifiers } = require('../services/pricing-engine/modifiers');
  const { normalizeCountyConstruction } = require('../services/property-lookup/ai-property-lookup')._private;
  const { calcConstructionModifier, calcTermiteConstructionMult, calcWDOTimeMult } = require('../routes/property-lookup-v2')._private;
  const MAIN = 'WOOD_FRAME'; // what a county "FRAME STUCCO" read as on main

  test('a county FRAME STUCCO home still reads WOOD_FRAME, and every consumer prices MIXED exactly as WOOD_FRAME', () => {
    expect(normalizeCountyConstruction('FRAME STUCCO')).toBe(MAIN);
    expect(normalizeCountyConstruction('CONCRETE BLOCK/FRAME')).toBe('MIXED');
    expect(deriveModifiers({ constructionMaterial: 'MIXED' }).termiteConstructionMult).toBe(deriveModifiers({ constructionMaterial: MAIN }).termiteConstructionMult);
    expect(deriveModifiers({ constructionMaterial: 'MIXED' }).wdoConstructionMult).toBe(1.15);
    expect(calcTermiteConstructionMult('MIXED')).toBe(calcTermiteConstructionMult(MAIN));
    expect(calcConstructionModifier('MIXED')).toBe(calcConstructionModifier(MAIN));
    expect(calcWDOTimeMult('MIXED', 'SLAB')).toBe(calcWDOTimeMult(MAIN, 'SLAB'));
    expect(calcTermiteConstructionMult(MAIN)).toBe(1.25);
    // The estimator's termite notes also treat it as wood frame.
    const notes = (material) => deriveModifiers({ constructionMaterial: material }).notes;
    expect(JSON.stringify(notes('MIXED') ?? '')).toBe(JSON.stringify(notes(MAIN) ?? ''));
  });

  test('the engine prices the same termite bait quote for MIXED and WOOD_FRAME homes', () => {
    const quote = (constructionMaterial) => generateEstimate(baseInput({ homeSqFt: 2400, footprintSqFt: 2400, constructionMaterial, services: { termite: {} } }));
    const termiteLines = (est) => est.lineItems.filter((li) => /termite/.test(li.service));
    expect(termiteLines(quote('WOOD_FRAME')).length).toBeGreaterThan(0);
    expect(termiteLines(quote('MIXED'))).toEqual(termiteLines(quote('WOOD_FRAME')));
  });
});

describe('a wrong-premise lookup makes machine readings untrusted; a person typing still wins', () => {
  const { structuralTrustVerdicts } = require('../services/lookup-confidence');
  const COUNTY = { sourceType: 'county', fieldVerify: false };
  const trustedProfile = { constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB', constructionTrusted: true, foundationTrusted: true, fieldEvidence: { constructionMaterial: COUNTY, foundationType: COUNTY } };
  const wrongPremise = [{ field: 'address', reason: 'geocoder snapped to a different parcel', priority: 'HIGH' }];

  test('the address wrong-premise flag distrusts stamped and evidenced machine readings', () => {
    expect(structuralTrustVerdicts(trustedProfile)).toEqual({ constructionTrusted: true, foundationTrusted: true, homeSizeTrusted: true });
    expect(structuralTrustVerdicts({ ...trustedProfile, fieldVerifyFlags: wrongPremise })).toEqual({ constructionTrusted: false, foundationTrusted: false, homeSizeTrusted: false });
    // Operational risk flags on the same field are not distrust (a wood-frame note is a risk notice, not a doubt).
    expect(structuralTrustVerdicts({ ...trustedProfile, fieldVerifyFlags: [{ field: 'constructionMaterial', reason: 'Wood frame construction' }] }))
      .toEqual({ constructionTrusted: true, foundationTrusted: true, homeSizeTrusted: true });
  });

  test('a manually typed field still wins over the wrong-premise flag; the other field stays untrusted', () => {
    expect(structuralTrustVerdicts({ ...trustedProfile, fieldVerifyFlags: wrongPremise, _manualFields: ['constructionMaterial'] }))
      .toEqual({ constructionTrusted: true, foundationTrusted: false, homeSizeTrusted: false });
  });

  test("a technician's saved confirmation for this address survives the flag; it vouches only for the value it carries", () => {
    const { applyVerifiedOverrides } = require('../services/property-lookup/lookup-cache');
    // The cache applies the override to the record; the profile carries the record's field evidence (fieldEvidence).
    const record = applyVerifiedOverrides({ constructionMaterial: 'CBS', foundationType: 'SLAB', _fieldEvidence: { foundationType: COUNTY } }, { foundationType: { value: 'RAISED' } });
    const profile = { constructionMaterial: record.constructionMaterial, foundationType: record.foundationType, constructionTrusted: true, foundationTrusted: true, fieldEvidence: record._fieldEvidence, fieldVerifyFlags: wrongPremise };
    expect(structuralTrustVerdicts(profile)).toMatchObject({ constructionTrusted: false, foundationTrusted: true });
    // Another value than the one confirmed, or a confirmation marked for a check, is not vouched for.
    expect(structuralTrustVerdicts({ ...profile, foundationType: 'CRAWLSPACE' }).foundationTrusted).toBe(false);
    expect(structuralTrustVerdicts({ ...profile, fieldEvidence: { foundationType: { ...record._fieldEvidence.foundationType, fieldVerify: true } } }).foundationTrusted).toBe(false);
    // Through the translator, on a size a person typed: the confirmed raised foundation prices the crawl column ($225 at 3,000 sq ft).
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const line = wdoLine(generateEstimate(translateV2CallToV1Input({ homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St', _homeSqFtManuallyEdited: true, ...profile }, ['WDO'], { urgency: 'ROUTINE' })));
    expect(line.price).toBe(225);
    expect(line.requiresManualReview).toBe(false);
  });

  test('through the translator: a wrong-premise wood frame prices block + the note; typed in, it prices frame', () => {
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    // The size is typed in (a wrong-premise size alone is no size: see the next group), so only the construction verdict moves the price.
    const translate = (extra) => translateV2CallToV1Input({ homeSqFt: 3000, lotSqFt: 9000, address: '1 Test St', _homeSqFtManuallyEdited: true, ...trustedProfile, fieldVerifyFlags: wrongPremise, ...extra }, ['WDO'], { urgency: 'ROUTINE' });
    const machine = wdoLine(generateEstimate(translate({})));
    expect(machine.price).toBe(175);
    expect(staffNote(machine)).toBeTruthy();
    const typed = wdoLine(generateEstimate(translate({ _manualFields: ['constructionMaterial'] })));
    expect(typed.price).toBe(200);
    expect(staffNote(typed)).toBeUndefined();
  });
});

describe("a wrong-premise lookup's home size is no size until a person confirms it", () => {
  const { structuralTrustVerdicts } = require('../services/lookup-confidence');
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const wrongPremise = [{ field: 'address', reason: 'geocoder snapped to a different parcel', priority: 'HIGH' }];
  // The reported case: the record describes a neighbouring 4,500 sq ft block home; the customer's own home is 1,800 sq ft.
  const neighbour = { homeSqFt: 4500, squareFootage: 4500, lotSqFt: 9000, address: '1 Test St', constructionMaterial: 'CBS', foundationType: 'SLAB', fieldEvidence: { squareFootage: { sourceType: 'county', fieldVerify: false } }, fieldVerifyFlags: wrongPremise };
  const translate = (extra = {}) => translateV2CallToV1Input({ ...neighbour, ...extra }, ['WDO'], { urgency: 'ROUTINE' });
  const sizeNote = (line) => (line.warnings || []).some((w) => typeof w === 'string' && w.startsWith(MARK) && /address needs confirmation/.test(w));

  test('the looked-up size and the footprint from it do not price: the smallest size, sent to review with a note', () => {
    const input = translate();
    expect(input.homeSizeTrusted).toBe(false);
    const line = wdoLine(generateEstimate(input));
    expect(line.price).toBe(150);
    expect(line.sizeUsed).toBeNull();
    expect(line.requiresManualReview).toBe(true);
    expect(line.manualReviewReasons).toContain('wdo_home_size_unconfirmed');
    expect(sizeNote(line)).toBe(true);
    // The footprint fallback (no living area on the input, a footprint from the same parcel) does not price either.
    const footprintOnly = wdoLine(generateEstimate({ ...input, homeSqFt: undefined, footprintSqFt: 4500 }));
    expect(footprintOnly.price).toBe(150);
    expect(footprintOnly.requiresManualReview).toBe(true);
  });

  test('a size a person confirmed prices off the table, with no review', () => {
    // Typed into the estimator's Home Sq Ft box: 2,600 sq ft on block walls = $175.
    const typed = wdoLine(generateEstimate(translate({ homeSqFt: 2600, _homeSqFtManuallyEdited: true })));
    expect(typed.price).toBe(175);
    expect(typed.requiresManualReview).toBe(false);
    expect(sizeNote(typed)).toBe(false);
    // A technician's saved confirmation of the living area, for the size it confirmed: 4,500 sq ft on block walls = $225.
    const verified = { fieldEvidence: { squareFootage: { value: 4500, sourceType: 'verified', fieldVerify: false } } };
    expect(structuralTrustVerdicts({ ...neighbour, ...verified }).homeSizeTrusted).toBe(true);
    expect(wdoLine(generateEstimate(translate(verified))).price).toBe(225);
    expect(structuralTrustVerdicts({ ...neighbour, ...verified, homeSqFt: 3000 }).homeSizeTrusted).toBe(false);
  });

  test('no flag, no change; the call-draft builder never sees a flagged lookup; a legacy quote keeps its flat price', () => {
    const { fieldVerifyFlags: _flags, ...clean } = neighbour;
    expect(structuralTrustVerdicts(clean).homeSizeTrusted).toBe(true);
    expect(wdoLine(generateEstimate(translateV2CallToV1Input(clean, ['WDO'], { urgency: 'ROUTINE' }))).price).toBe(225);
    const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
    const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
    const facts = { home: { value: 3000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] }, lot: { value: 9000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] }, newConstruction: false, tenant: false };
    const intent = { decision: 'draft', category: 'RESIDENTIAL', is_commercial: false, services: { wdo: {} }, address: '1 Test St' };
    const drafted = buildEngineInput({ intent, propertyFacts: facts, context: {}, lookupEnriched: neighbour });
    expect(drafted.homeSizeTrusted).toBe(true);
    expect(wdoLine(generateEstimate(drafted)).price).toBe(175);
    expect(wdo({ homeSqFt: 4500, footprint: 4500, homeSizeTrusted: false }, { legacyWdoFlat: true }).price).toBe(LEGACY);
  });
});

describe('the public lookup payload never carries the trust verdicts', () => {
  test('publicEnrichedProfile strips constructionTrusted and foundationTrusted', () => {
    const { publicEnrichedProfile } = require('../routes/public-property-lookup')._test;
    const out = publicEnrichedProfile({ constructionMaterial: 'CBS', foundationType: 'SLAB', constructionTrusted: true, foundationTrusted: false, yearBuilt: 2001 });
    expect(out).not.toHaveProperty('constructionTrusted');
    expect(out).not.toHaveProperty('foundationTrusted');
    expect(out).toMatchObject({ constructionMaterial: 'CBS', foundationType: 'SLAB', yearBuilt: 2001 });
    // The lead snapshot and the response go through the same strip.
    expect(JSON.stringify(publicEnrichedProfile({ constructionTrusted: false, foundationTrusted: true }))).not.toMatch(/Trusted/);
  });
});

describe('one shared normalizer at every entry', () => {
  const { normalizeCountyConstruction } = require('../services/property-lookup/ai-property-lookup')._private;
  const { normalizeConstruction, normalizeFoundation } = require('../services/pricing-engine/structural-facts');
  const fs = require('fs');
  const path = require('path');

  test('county ingestion: "steel frame" is metal, so the quote is block + the staff note', () => {
    expect(normalizeCountyConstruction('STEEL FRAME')).toBe('METAL');
    expect(normalizeCountyConstruction('FRAME STUCCO')).toBe('WOOD_FRAME');
    expect(normalizeCountyConstruction('STUCCO')).toBeNull();
    expect(normalizeCountyConstruction('CONCRETE BLOCK')).toBe('CBS');
    expect(normalizeCountyConstruction('CMU')).toBe('CBS');
    expect(normalizeCountyConstruction('WOOD FRAME')).toBe('WOOD_FRAME');
    expect(normalizeCountyConstruction('vinyl')).toBeNull();
    const line = wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: normalizeCountyConstruction('STEEL FRAME') }));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeTruthy();
  });

  test('the WDO service override goes through the same normalizer: "concrete piers" prices as a raised foundation', () => {
    expect(price({ homeSqFt: 3000, constructionMaterial: 'CBS', services: { wdo: { foundationType: 'concrete piers' } } })).toBe(225);
    expect(price({ homeSqFt: 3000, services: { wdo: { constructionType: 'brick veneer over frame' } } })).toBe(200);
    expect(price({ homeSqFt: 3000, services: { wdo: { constructionType: 'steel frame' } } })).toBe(175);
    expect(price({ homeSqFt: 3000, services: { wdo: { constructionType: 'wood frame', foundationType: 'stem wall' } } })).toBe(225);
  });

  test('priceWDO normalizes whatever string arrives, as a last step', () => {
    expect(wdo({ homeSqFt: 3000, constructionMaterial: 'Concrete Block / Stucco', foundationType: 'Concrete Pilings' }).price).toBe(225);
    expect(wdo({ homeSqFt: 3000, constructionMaterial: 'steel frame' }).price).toBe(175);
    expect(staffNote(wdo({ homeSqFt: 3000, constructionMaterial: 'steel frame' }))).toBeTruthy();
  });

  test('no other non-test file in server/ keeps its own text matcher for construction or foundation', () => {
    const SHARED = path.join('services', 'pricing-engine', 'structural-facts.js');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return ['node_modules', 'tests', 'migrations', 'seeds'].includes(entry.name) ? [] : walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
    const serverDir = path.join(__dirname, '..');
    // A regex literal that tells wood frame / block / crawl / piling apart in free text is a matcher of its own.
    const matchers = [
      /\/[^/\n]*\bCRAWL[^/\n]*\//, /\/[^/\n]*(PILING|STILT)[^/\n]*\//,
      /\/[^/\n]*WOOD\|FRAME[^/\n]*\//, /\/[^/\n]*(CBS\|BLOCK|BLOCK\|CBS|MASONRY\|CONCRETE)[^/\n]*\//,
    ];
    const offenders = walk(serverDir)
      .filter((file) => !file.endsWith(SHARED))
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return matchers.some((rx) => rx.test(text.replace(/^\s*(\/\/|\*).*$/gm, '')));
      })
      .map((file) => path.relative(serverDir, file));
    expect(offenders).toEqual([]);
  });

  test('text that denies or doubts a feature never reads as its premium: a denied clause is dropped, a premium left beside it is unknown', () => {
    for (const [text, reading] of [
      ['concrete slab, no crawl space', 'SLAB'], ['slab (no crawl)', 'SLAB'], ['monolithic slab, no basement', 'SLAB'],
      ['crawl space: none', undefined], ['crawl space, none', undefined], ['crawl space (none)', undefined], ['crawl space not present', undefined],
      ['possible crawl space', undefined], ['crawl space ruled out', undefined], ['former crawl space', undefined], ['no slab, crawl space', undefined],
      ["isn't raised", undefined], ['raised?', undefined], ['N/A', undefined], ['UNKNOWN', undefined],
    ]) expect([text, normalizeFoundation(text)]).toEqual([text, reading]);
    for (const [text, reading] of [
      ['CBS, not wood frame', 'CBS'], ['block, no wood', 'CBS'], ['metal building, no wood', 'METAL'],
      ['non-wood frame', undefined], ['wood frame, not CBS', undefined], ['probably wood frame', undefined],
    ]) expect([text, normalizeConstruction(text)]).toEqual([text, reading]);
    // The reported case: a technician enters it for a 3,000 sq ft block home. The slab cell, $175, not the crawl column's $225.
    const cache = require('../services/property-lookup/lookup-cache');
    expect(cache.sanitizeVerifiedValue('foundationType', 'concrete slab, no crawl space')).toBe('SLAB');
    const line = wdoLine(estimate({ homeSqFt: 3000, constructionMaterial: 'CBS', services: { wdo: { foundationType: 'concrete slab, no crawl space' } } }));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeUndefined();
    expect(price({ homeSqFt: 3000, services: { wdo: { constructionType: 'CBS, not wood frame', foundationType: 'crawl space (none)' } } })).toBe(175);
  });

  test('both normalizers agree with the verified-entry wrappers', () => {
    const cache = require('../services/property-lookup/lookup-cache');
    for (const text of ['steel frame', 'brick veneer over frame', 'CBS']) expect(cache.sanitizeVerifiedValue('constructionMaterial', text)).toBe(normalizeConstruction(text));
    for (const text of ['concrete piers', 'slab']) expect(cache.sanitizeVerifiedValue('foundationType', text)).toBe(normalizeFoundation(text));
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

describe('no overcharge from hedged text, from evidence for another value, or from a price the server did not set', () => {
  const { normalizeConstruction, normalizeFoundation, readCountyConstruction } = require('../services/pricing-engine/structural-facts');
  const { structuralTrustVerdicts, structuralFactIsRecordBacked } = require('../services/lookup-confidence');

  test('a premium needs text that affirms it: hedged or qualified text reads unknown and keeps the $175 block price', () => {
    for (const text of ['crawl space excluded', 'may have a crawl space', 'has a crawl space', 'crawl or slab', 'crawl space per owner', 'could be raised', 'crawl space is a slab']) {
      expect([text, normalizeFoundation(text)]).toEqual([text, undefined]);
    }
    for (const text of ['wood frame excluded', 'wood frame per neighbour', 'frame stucco avg']) expect([text, normalizeConstruction(text)]).toEqual([text, undefined]);
    // The reported cases, typed in as the WDO option for a 3,000 sq ft block home: the block slab cell ($175), not the crawl column ($225).
    for (const foundationType of ['crawl space excluded', 'may have a crawl space']) {
      expect(price({ homeSqFt: 3000, constructionMaterial: 'CBS', services: { wdo: { foundationType } } })).toBe(175);
    }
    expect(price({ homeSqFt: 3000, constructionMaterial: 'CBS', services: { wdo: { constructionType: 'wood frame excluded' } } })).toBe(175);
    // A technician entering one saves nothing for the field (there is no reading to keep).
    expect(require('../services/property-lookup/lookup-cache').sanitizeVerifiedValue('foundationType', 'may have a crawl space')).toBeUndefined();
    // Plain descriptor text still affirms the premium.
    for (const [text, reading] of [
      ['crawl space', 'CRAWLSPACE'], ['raised on piers', 'RAISED'], ['pier and beam', 'RAISED'], ['stem wall', 'RAISED'], ['Concrete Pilings', 'RAISED'],
      ['slab and crawl space', 'CRAWLSPACE'], ['vented crawl space with vapor barrier', 'CRAWLSPACE'], ['2 story on stilts', 'RAISED'],
    ]) expect([text, normalizeFoundation(text)]).toEqual([text, reading]);
    for (const [text, reading] of [
      ['wood frame', 'WOOD_FRAME'], ['Frame/Stucco', 'MIXED'], ['brick veneer over frame', 'MIXED'], ['CBS first floor, frame second floor', 'MIXED'],
      ['frame w/ stucco', 'MIXED'], ['hardie board over frame', 'WOOD_FRAME'],
    ]) expect([text, normalizeConstruction(text)]).toEqual([text, reading]);
    expect(price({ homeSqFt: 3000, constructionMaterial: 'CBS', services: { wdo: { foundationType: 'raised on piers' } } })).toBe(225);
    // A county code is the appraiser's own word for the wall: it reads in full, as before ("AVG" is no structural term, and
    // stucco is only the finish there).
    expect(readCountyConstruction('FRAME STUCCO AVG')).toBe('WOOD_FRAME');
    expect(require('../services/property-lookup/ai-property-lookup')._private.normalizeCountyConstruction('FRAME STUCCO AVG')).toBe('WOOD_FRAME');
  });

  test("field evidence vouches only for the value it names: a profile reading RAISED beside a technician's SLAB prices $175, not $225", () => {
    const profile = {
      homeSqFt: 3000, squareFootage: 3000, lotSqFt: 9000, address: '1 Test St', constructionMaterial: 'CBS', foundationType: 'RAISED',
      constructionTrusted: true, foundationTrusted: true,
      fieldEvidence: { constructionMaterial: { sourceType: 'county', value: 'CBS' }, foundationType: { sourceType: 'verified', value: 'SLAB', fieldVerify: false } },
    };
    expect(structuralTrustVerdicts(profile)).toMatchObject({ constructionTrusted: true, foundationTrusted: false });
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const line = wdoLine(generateEstimate(translateV2CallToV1Input(profile, ['WDO'], { urgency: 'ROUTINE' })));
    expect(line.price).toBe(175);
    expect(staffNote(line)).toBeTruthy();
    // County evidence for block walls backs no wood frame reading, on the profile or on the record.
    expect(structuralTrustVerdicts({ ...profile, constructionMaterial: 'WOOD_FRAME' }).constructionTrusted).toBe(false);
    const countyBlock = { constructionMaterial: { sourceType: 'county', value: 'CBS' } };
    expect(structuralFactIsRecordBacked({ record: { constructionMaterial: 'WOOD_FRAME', _fieldEvidence: countyBlock }, field: 'constructionMaterial' })).toBe(false);
    expect(structuralFactIsRecordBacked({ record: { constructionMaterial: 'CBS', _fieldEvidence: countyBlock }, field: 'constructionMaterial' })).toBe(true);
    // The same value written another way still counts; evidence with no value names nothing to compare.
    expect(structuralTrustVerdicts({ ...profile, foundationType: 'CRAWLSPACE', fieldEvidence: { foundationType: { sourceType: 'county', value: 'Crawl space' } } }).foundationTrusted).toBe(true);
    expect(structuralFactIsRecordBacked({ record: { foundationType: 'RAISED', _fieldEvidence: { foundationType: { sourceType: 'county' } } }, field: 'foundationType' })).toBe(true);
  });

  test('a save the server cannot price may not carry a WDO row: the browser has no WDO price, so a $250 row there is an old one', () => {
    const { assertSpecialtyClientFallbackSave: assertFallback } = require('../services/admin-estimate-persistence');
    const refused = (data) => {
      let error = null;
      try { assertFallback(data); } catch (err) { error = err; }
      expect(error && error.statusCode).toBe(409);
      expect(error.message).toMatch(/WDO inspection price the browser cannot set/);
    };
    // The reported case: a staff revision carrying the old $250 preview, in each saved shape.
    refused({ result: { lineItems: [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 250 }] } });
    refused({ result: { oneTime: { items: [{ name: 'WDO Inspection', price: 250 }] } } });
    refused({ engineResult: { lineItems: [{ service: 'wdo_inspection', price: 250 }] } });
    refused({ sendSnapshot: { pricingBundle: { oneTimeBreakdown: { items: [{ label: 'Wood-Destroying Organism Inspection', price: 250 }] } } } });
    refused({ result: { results: { wdo: { price: 250 } } } });
    // The server's own result with a WDO line is refused as well; one with none passes, stamp key and all.
    const withWdo = estimate({ homeSqFt: 2000, constructionMaterial: 'CBS' });
    refused({ result: mapV1ToLegacyShape(withWdo), engineResult: withWdo });
    for (const services of [{ pest: { frequency: 'quarterly' } }, { pest: { frequency: 'quarterly' }, termiteBait: {} }, { treeShrub: { tier: 'standard' } }]) {
      const raw = generateEstimate(baseInput({ services }));
      expect(raw.lineItems.length).toBeGreaterThan(0);
      expect(raw.pricingMetadata.legacyWdoFlat).toBe(false);
      expect(() => assertFallback({ result: mapV1ToLegacyShape(raw), engineResult: raw })).not.toThrow();
    }
    // A WDO request that sits in the inputs only is not a row.
    expect(() => assertFallback({ inputs: { services: { wdo: {} } }, result: { lineItems: [] } })).not.toThrow();
  });
});
