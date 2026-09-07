// Admin builder → tree & shrub service line (estimator pricing audit
// INP-001, INP-002, INP-004). translateV2CallToV1Input used to emit the
// literal services.treeShrub = { tier: 'standard' }: program and access were
// never selectable, property-level palms never reached the per-tree terms
// (30 palms priced $0 on the admin path and $505/yr on the website form for
// the same home), and a blank tree count posted an explicit 0 that priced
// the treeDensity fallback away.
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { generateEstimate } = require('../services/pricing-engine');
const {
  treeShrubPalmProvenanceForReplay,
  applyTreeShrubPalmReplay,
} = require('../services/estimate-tree-shrub-knob-replay');

function baseProfile(extra = {}) {
  return {
    address: 'TEST-TREE-SHRUB-INPUTS',
    propertyType: 'single_family',
    category: 'residential',
    homeSqFt: 2400,
    lotSqFt: 9000,
    stories: 1,
    footprint: 2400,
    serviceZone: 'A',
    shrubDensity: 'MODERATE',
    treeDensity: 'MODERATE',
    landscapeComplexity: 'MODERATE',
    pool: 'NO',
    poolCage: 'NO',
    hasLargeDriveway: false,
    nearWater: 'NO',
    ...extra,
  };
}

const treeShrubLine = (input) => generateEstimate(input).lineItems.find((li) => li.service === 'tree_shrub');

describe('admin tree & shrub service-line inputs (audit INP-001/002/004)', () => {
  test('preserves an operator-confirmed bed area instead of stamping it inferred', () => {
    const manual = translateV2CallToV1Input(baseProfile({ estimatedBedAreaSf: 900, bedAreaSource: 'manual' }), ['TREE_SHRUB'], {});
    const inferred = translateV2CallToV1Input(baseProfile({ estimatedBedAreaSf: 900 }), ['TREE_SHRUB'], {});
    expect(manual).toMatchObject({ bedArea: 900, bedAreaSource: 'manual' });
    expect(inferred).toMatchObject({ bedArea: 900, bedAreaSource: 'estimated' });
    expect(treeShrubLine(manual).bedAreaSource).toBe('explicit');
    expect(treeShrubLine(inferred).bedAreaSource).toBe('estimated');
  });

  test('defaults: standard program, easy access, no count fabricated (INP-002)', () => {
    const input = translateV2CallToV1Input(baseProfile(), ['TREE_SHRUB'], {});
    expect(input.services.treeShrub).toEqual({ tier: 'standard', access: 'easy' });
    // The property block carries NO treeCount either — the pricer's
    // treeDensity fallback must run instead of pricing zero trees.
    expect(input.features).not.toHaveProperty('treeCount');
    const line = treeShrubLine(input);
    expect(line.treeCountSource).toBe('density_estimate');
    expect(line.treeCount).toBeGreaterThan(0);
  });

  test('program and access selections ride the service line (INP-004)', () => {
    const input = translateV2CallToV1Input(baseProfile(), ['TREE_SHRUB'], {
      treeShrubTier: 'enhanced',
      treeShrubAccess: 'difficult',
    });
    expect(input.services.treeShrub).toMatchObject({ tier: 'enhanced', access: 'difficult' });
    const line = treeShrubLine(input);
    expect(line.tier).toBe('enhanced');
    expect(line.frequency).toBe(9);
    expect(line.access).toBe('difficult');
    // Case-insensitive, whitespace-tolerant — the select posts lowercase
    // but a replayed engineRequest is data, not a contract.
    expect(translateV2CallToV1Input(baseProfile(), ['TREE_SHRUB'], { treeShrubTier: ' Light ', treeShrubAccess: 'MODERATE' })
      .services.treeShrub).toMatchObject({ tier: 'light', access: 'moderate' });
  });

  test('a malformed program or access is refused at the boundary, never defaulted', () => {
    // Present-but-falsy values are malformed, not defaults.
    for (const options of [
      { treeShrubTier: 'premium' }, { treeShrubTier: 'gold' }, { treeShrubAccess: 'impossible' },
      { treeShrubTier: false }, { treeShrubTier: 0 }, { treeShrubAccess: false }, { treeShrubAccess: 0 }, { treeShrubTier: ['standard'] },
    ]) {
      let caught;
      try { translateV2CallToV1Input(baseProfile(), ['TREE_SHRUB'], options); } catch (err) { caught = err; }
      expect(caught).toBeTruthy();
      expect(caught.statusCode).toBe(400);
      expect(caught.code).toBe('TREE_SHRUB_INPUT_INVALID');
      // The save-time replay rethrows this marker instead of persisting the
      // browser preview as CLIENT_FALLBACK (serverRecomputeFromEstimateData).
      expect(caught.failClosed).toBe(true);
    }
    // Blank means default, never a rejection.
    expect(translateV2CallToV1Input(baseProfile(), ['TREE_SHRUB'], { treeShrubTier: '', treeShrubAccess: null })
      .services.treeShrub).toMatchObject({ tier: 'standard', access: 'easy' });
    // Not selected ⇒ the options are inert, never validated.
    expect(() => translateV2CallToV1Input(baseProfile(), ['PEST'], { treeShrubTier: 'gold' })).not.toThrow();
  });

  test('typed tree count wins, an explicit 0 is a real answer, the vision estimate backstops (INP-002)', () => {
    const typed = translateV2CallToV1Input(baseProfile({ treeCount: 7, estimatedTreeCount: 20 }), ['TREE_SHRUB'], {});
    expect(typed.services.treeShrub.treeCount).toBe(7);
    expect(typed.features.treeCount).toBe(7);

    const zero = translateV2CallToV1Input(baseProfile({ treeCount: 0, estimatedTreeCount: 20 }), ['TREE_SHRUB'], {});
    expect(zero.services.treeShrub.treeCount).toBe(0);
    expect(zero.features.treeCount).toBe(0);
    expect(treeShrubLine(zero).treeCountSource).toBe('explicit');

    const estimated = translateV2CallToV1Input(baseProfile({ treeCount: '', estimatedTreeCount: 12 }), ['TREE_SHRUB'], {});
    expect(estimated.services.treeShrub.treeCount).toBe(12);
    expect(estimated.features.treeCount).toBe(12);

    // A zero/absent estimate is "unknown", not a count.
    const unknown = translateV2CallToV1Input(baseProfile({ treeCount: null, estimatedTreeCount: 0 }), ['TREE_SHRUB'], {});
    expect(unknown.services.treeShrub).not.toHaveProperty('treeCount');
    expect(unknown.features).not.toHaveProperty('treeCount');
  });

  test('a blank tree count prices MORE than a fabricated zero would have (INP-002 repro direction)', () => {
    const blank = treeShrubLine(translateV2CallToV1Input(baseProfile({ treeCount: '' }), ['TREE_SHRUB'], {}));
    const zero = treeShrubLine(translateV2CallToV1Input(baseProfile({ treeCount: 0 }), ['TREE_SHRUB'], {}));
    expect(blank.annual).toBeGreaterThan(zero.annual);
  });

  test('a malformed tree count is refused (INP-005), not clamped', () => {
    // Shape is strict: Number() coercion would admit true, [], '1e2', '0x10'
    // and unsafe magnitudes.
    for (const treeCount of ['abc', -3, 2.5, true, [], {}, '1e2', '0x10', ' 12 3', 1e21, Number.MAX_SAFE_INTEGER + 2, NaN]) {
      let caught;
      try { translateV2CallToV1Input(baseProfile({ treeCount }), ['TREE_SHRUB'], {}); } catch (err) { caught = err; }
      expect(caught?.statusCode).toBe(400);
      expect(caught?.code).toBe('TREE_SHRUB_INPUT_INVALID');
    }
  });

  test('a malformed tree count is inert while Tree & Shrub is NOT selected (hidden field never 400s another service)', () => {
    for (const treeCount of ['abc', -3, 2.5]) {
      const input = translateV2CallToV1Input(baseProfile({ treeCount }), ['PEST'], {});
      expect(input.features).not.toHaveProperty('treeCount');
    }
    expect(translateV2CallToV1Input(baseProfile({ treeCount: 6 }), ['PEST'], {}).features.treeCount).toBe(6);
    // Digit strings with surrounding whitespace are the one tolerated shape.
    expect(translateV2CallToV1Input(baseProfile({ treeCount: ' 6 ' }), ['TREE_SHRUB'], {}).services.treeShrub.treeCount).toBe(6);
  });

  test('commercial keeps the commercial pricer contract: zero is omitted, a positive count is passed through', () => {
    const commercial = (extra) => baseProfile({
      category: 'commercial', isCommercial: 'YES', propertyType: 'office', commercialSubtype: 'office', ...extra,
    });
    // A blank field on every pre-v4.8 commercial engineRequest is a stored
    // 0 — honouring it would reprice those replays to zero plants.
    const zero = translateV2CallToV1Input(commercial({ treeCount: 0 }), ['TREE_SHRUB'], {});
    expect(zero.services.treeShrub).not.toHaveProperty('treeCount');
    expect(zero.features).not.toHaveProperty('treeCount');

    const typed = translateV2CallToV1Input(commercial({ treeCount: 12 }), ['TREE_SHRUB'], {});
    expect(typed.services.treeShrub.treeCount).toBe(12);
    expect(typed.features.treeCount).toBe(12);
  });

  test('property palms reach the tree & shrub service line and the price (INP-001)', () => {
    const withPalms = translateV2CallToV1Input(baseProfile({ palmCount: 30 }), ['TREE_SHRUB'], {});
    expect(withPalms.services.treeShrub.palmCount).toBe(30);
    const palmLine = treeShrubLine(withPalms);
    expect(palmLine.palmCount).toBe(30);
    expect(palmLine.palmCountSource).toBe('service_line');

    const noPalms = treeShrubLine(translateV2CallToV1Input(baseProfile(), ['TREE_SHRUB'], {}));
    expect(palmLine.annual).toBeGreaterThan(noPalms.annual);
  });

  test('palm resolution mirrors the property block: inventory count, else a TRUSTED vision estimate', () => {
    const inventory = translateV2CallToV1Input(
      baseProfile({ palmInventory: { palmCount: 4 }, estimatedPalmCount: 40 }), ['TREE_SHRUB'], {},
    );
    expect(inventory.services.treeShrub.palmCount).toBe(4);

    const trusted = translateV2CallToV1Input(baseProfile({ estimatedPalmCount: 9 }), ['TREE_SHRUB'], {});
    expect(trusted.services.treeShrub.palmCount).toBe(9);

    const untrusted = translateV2CallToV1Input(
      baseProfile({ estimatedPalmCount: 9, palmCountTrusted: false }), ['TREE_SHRUB'], {},
    );
    expect(untrusted.services.treeShrub).not.toHaveProperty('palmCount');
  });

  describe('replaying a persisted engineRequest keeps the sold palm terms (pre-push r2 P0)', () => {
    const legacyRequest = () => ({
      profile: baseProfile({ palmCount: 30 }),
      selectedServices: ['TREE_SHRUB'],
      options: {},
    });
    const stored = (tsMeta) => ({ engineRequest: legacyRequest(), result: { results: { ts: [{ tier: 'standard', selected: true }], tsMeta } } });

    test('stored-result provenance: service_line keeps, anything else on a priced line is legacy, no line is null', () => {
      expect(treeShrubPalmProvenanceForReplay(stored({ eb: 1200, et: 3, palmCount: 30, palmCountSource: 'service_line' }))).toBe('service_line');
      expect(treeShrubPalmProvenanceForReplay(stored({ eb: 1200, et: 3, palmCount: 30, palmCountSource: 'property' }))).toBe('legacy');
      expect(treeShrubPalmProvenanceForReplay(stored({ eb: 1200, et: 3, palmCount: 0, palmCountSource: 'none' }))).toBe('legacy');
      // Pre-stamp tsMeta (no palm keys at all) is a legacy line.
      expect(treeShrubPalmProvenanceForReplay(stored({ eb: 1200, et: 3 }))).toBe('legacy');
      // Raw agent-draft line without a mapped envelope.
      expect(treeShrubPalmProvenanceForReplay({ engineResult: { lineItems: [{ service: 'tree_shrub', palmCountSource: 'service_line' }] } })).toBe('service_line');
      // The mapped envelope is EXCLUSIVE: a stale raw draft line marked
      // service_line never outranks a mapped result that priced none (a
      // revision replaces result but keeps the draft's engineResult).
      expect(treeShrubPalmProvenanceForReplay({
        ...stored({ eb: 1200, et: 3 }),
        engineResult: { lineItems: [{ service: 'tree_shrub', palmCountSource: 'service_line' }] },
      })).toBe('legacy');
      expect(treeShrubPalmProvenanceForReplay({
        ...stored({ eb: 1200, et: 3, palmCountSource: 'property' }),
        engineResult: { lineItems: [{ service: 'tree_shrub', palmCountSource: 'service_line' }] },
      })).toBe('legacy');
      // Mapped ts rows with no tsMeta at all are a legacy line too.
      expect(treeShrubPalmProvenanceForReplay({
        result: { results: { ts: [{ tier: 'standard', selected: true }] } },
        engineResult: { lineItems: [{ service: 'tree_shrub', palmCountSource: 'service_line' }] },
      })).toBe('legacy');
      // No T&S sold at all → the translator output stands.
      expect(treeShrubPalmProvenanceForReplay({ result: { results: { pestTiers: [] } } })).toBeNull();
      expect(treeShrubPalmProvenanceForReplay({})).toBeNull();
    });

    test('applyTreeShrubPalmReplay strips ONLY the legacy-promoted count', () => {
      const translated = () => translateV2CallToV1Input(baseProfile({ palmCount: 30 }), ['TREE_SHRUB'], {});
      expect(applyTreeShrubPalmReplay(translated(), stored({ palmCountSource: 'property' })).services.treeShrub).not.toHaveProperty('palmCount');
      expect(applyTreeShrubPalmReplay(translated(), stored({ palmCountSource: 'service_line' })).services.treeShrub.palmCount).toBe(30);
      expect(applyTreeShrubPalmReplay(translated(), {}).services.treeShrub.palmCount).toBe(30);
      // Tier, access and the property-level palm inventory are untouched.
      const stripped = applyTreeShrubPalmReplay(translated(), stored({}));
      expect(stripped.services.treeShrub).toMatchObject({ tier: 'standard', access: 'easy' });
    });

    test('the server-authoritative recompute strips it on a DECLARED replay and prices the legacy job unchanged', async () => {
      const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
      const run = async (estData, replay) => {
        let seenInput = null;
        await serverRecomputeFromEstimateData(estData, {
          needsSync: () => false,
          generateEstimate: (input) => { seenInput = input; return { lineItems: [], totals: {} }; },
          mapV1ToLegacyShape: () => ({ results: {} }),
          ...(replay ? { replaySavedPricingKnobs: true } : {}),
        });
        return seenInput;
      };
      // Membership reconcile / opt-out / public mutation of a pre-v4.8 row.
      const legacy = await run(stored({ eb: 1200, et: 3, palmCount: 30, palmCountSource: 'property' }), true);
      expect(legacy.services.treeShrub).not.toHaveProperty('palmCount');
      // A row sold WITH service-line palms keeps them.
      const sold = await run(stored({ eb: 1200, et: 3, palmCount: 30, palmCountSource: 'service_line' }), true);
      expect(sold.services.treeShrub.palmCount).toBe(30);
      // A browser-posted save (not a declared replay) prices what the
      // operator just regenerated and saw.
      const fresh = await run(stored({ eb: 1200, et: 3, palmCount: 30, palmCountSource: 'service_line' }), false);
      expect(fresh.services.treeShrub.palmCount).toBe(30);
    });
  });

  test('lookup palm sentinels are ABSENT, never rejected: estimatedPalmCount 0, an empty inventory, a cleared operator field', () => {
    for (const extra of [
      { estimatedPalmCount: 0 },
      { estimatedPalmCount: 0, palmInventory: { palmCount: 0 } },
      { palmCount: 0, estimatedPalmCount: 0 },
      { palmCount: '', estimatedPalmCount: 0 },
      { palmInventory: {}, estimatedPalmCount: null },
    ]) {
      const input = translateV2CallToV1Input(baseProfile(extra), ['TREE_SHRUB'], {});
      expect(input.services.treeShrub).not.toHaveProperty('palmCount');
    }
    // An operator ZERO ends the resolution: no inventory or vision leg may
    // resurrect a count the operator rejected.
    for (const extra of [
      { palmCount: 0, estimatedPalmCount: 9 },
      { palmCount: '0', palmInventory: { palmCount: 4 }, estimatedPalmCount: 9 },
    ]) {
      expect(translateV2CallToV1Input(baseProfile(extra), ['TREE_SHRUB'], {})
        .services.treeShrub).not.toHaveProperty('palmCount');
    }
    // A zero inventory does not fall through to a positive estimate (same
    // first-present rule the palmInventory block uses).
    expect(translateV2CallToV1Input(baseProfile({ palmInventory: { palmCount: 0 }, estimatedPalmCount: 9 }), ['TREE_SHRUB'], {})
      .services.treeShrub).not.toHaveProperty('palmCount');
    // A garbage vision leg is absent, not a 400.
    expect(translateV2CallToV1Input(baseProfile({ estimatedPalmCount: 'lots' }), ['TREE_SHRUB'], {})
      .services.treeShrub).not.toHaveProperty('palmCount');
  });

  test('a present-but-invalid OPERATOR palm count is refused under the 1–200 contract', () => {
    for (const palmCount of [-1, 201, 'many', 3.5, true, [], '1e1', '0x10']) {
      let caught;
      try { translateV2CallToV1Input(baseProfile({ palmCount }), ['TREE_SHRUB'], {}); } catch (err) { caught = err; }
      expect(caught?.statusCode).toBe(400);
      expect(caught?.code).toBe('TREE_SHRUB_INPUT_INVALID');
    }
  });
});
