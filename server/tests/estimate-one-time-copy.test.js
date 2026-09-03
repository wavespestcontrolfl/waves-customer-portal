process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// One-time service copy pack (owner directive 2026-09-03): every one-time
// row reads like a recurring plan card — outcome line, "what the visit
// includes" bullets, terms — and a one-time-ONLY estimate's Waves AI card +
// Ask Waves chips describe the service actually quoted. One pack, resolved
// server-side, delivered to BOTH render paths (SSR directly, React via the
// /data contract) so they cannot drift.

const {
  oneTimeCopyKeyFor,
  resolveOneTimeServiceCopy,
  resolveOneTimeRowCopies,
  oneTimeOnlyIntelligenceCopy,
  ONE_TIME_SERVICE_COPY,
} = require('../services/estimate-one-time-copy');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const {
  attachPublicPricingContract,
  buildWaveGuardIntelligencePayload,
  renderPage,
} = require('../routes/estimate-public');

const roach2 = { service: 'german_roach', label: 'German Roach Cleanout Service — 2 Visit Program', amount: 350, visits: 2 };
const roach3 = { service: 'german_roach', label: 'German Roach Cleanout Service — 3 Visit Program', amount: 450, visits: 3 };

describe('oneTimeCopyKeyFor', () => {
  test('classifies every one-time service the pack covers, by service key and by name', () => {
    expect(oneTimeCopyKeyFor(roach2)).toBe('german_roach');
    expect(oneTimeCopyKeyFor({ name: 'German Roach Cleanout — 4 Visit Program' })).toBe('german_roach');
    expect(oneTimeCopyKeyFor({ name: 'Initial German Roach Knockdown' })).toBeNull();
    expect(oneTimeCopyKeyFor({ label: 'Flea Elimination Package' })).toBe('flea');
    expect(oneTimeCopyKeyFor({ service: 'flea_knockdown_single', label: 'Flea Knockdown' })).toBe('flea');
    expect(oneTimeCopyKeyFor({ service: 'flea_package', label: 'Flea Elimination Package', offerKey: 'flea_elimination_two_visit' })).toBe('flea');
    expect(oneTimeCopyKeyFor({ service: 'bed_bug', label: 'Bed Bug Heat Treatment — 2 room(s)' })).toBe('bed_bug');
    expect(oneTimeCopyKeyFor({ service: 'wasp', label: 'Wasp / Hornet Nest Treatment' })).toBe('wasp');
    expect(oneTimeCopyKeyFor({ service: 'stinging_insect', label: 'Yellowjacket Ground Nest' })).toBe('wasp');
    expect(oneTimeCopyKeyFor({ service: 'rodent_exclusion', label: 'Full Rodent Exclusion' })).toBe('rodent_exclusion');
    expect(oneTimeCopyKeyFor({ service: 'stinging_insect_v2', label: 'Stinging Insect — Paper wasp' })).toBe('wasp');
    // Component rodent work (N entry points / measured mesh) is NOT the whole-home exclusion pack.
    expect(oneTimeCopyKeyFor({ service: 'rodent_plugging', label: 'Rodent Entry-Point Plugging' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'rodent_wire_mesh', label: 'Rodent Wire Mesh Exclusion Service' })).toBeNull();
    // …and keyless legacy rows with those component labels stay bare too (codex r7 P1).
    expect(oneTimeCopyKeyFor({ name: 'Rodent Wire Mesh Exclusion' })).toBeNull();
    expect(oneTimeCopyKeyFor({ name: 'Rodent Entry-Point Plugging' })).toBeNull();
    expect(oneTimeCopyKeyFor({ label: 'Full Rodent Exclusion' })).toBe('rodent_exclusion');
    expect(oneTimeCopyKeyFor({ service: 'rodent_trapping', label: 'Rodent Trapping' })).toBe('rodent_trapping');
    // Only the retainer row carries the monitoring pack; component fees stay bare.
    expect(oneTimeCopyKeyFor({ service: 'trap_only_setup', label: 'Trap-Only Setup / Inspection' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'trap_only_extra_callback', label: 'Extra callback' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'trap_only_retainer', label: 'Standard Trap-Only Retainer Service' })).toBe('trap_only');
    expect(oneTimeCopyKeyFor({ service: 'termite_foam', label: 'Termidor Foam Spot Treatment' })).toBe('termite_foam');
    expect(oneTimeCopyKeyFor({ service: 'trenching', label: 'Termite Trenching' })).toBe('termite_trenching');
    expect(oneTimeCopyKeyFor({ service: 'one_time_pest', label: 'One-Time Pest Control' })).toBe('one_time_pest');
    expect(oneTimeCopyKeyFor({ service: 'pest_initial_cleanout', label: 'Initial Pest Cleanout' })).toBe('one_time_pest');
    expect(oneTimeCopyKeyFor({ service: 'one_time_mosquito', label: 'One-Time Mosquito Treatment' })).toBe('one_time_mosquito');
    expect(oneTimeCopyKeyFor({ service: 'one_time_lawn', label: 'One-Time Lawn Treatment' })).toBe('one_time_lawn');
    expect(oneTimeCopyKeyFor({ service: 'rodent_inspection', label: 'Rodent Inspection' })).toBe('rodent_inspection');
    expect(oneTimeCopyKeyFor({ service: 'rodent_sanitation', label: 'Rodent Sanitation' })).toBe('rodent_sanitation');
    expect(oneTimeCopyKeyFor({ service: 'rodent_bait_setup', label: 'Rodent Bait Station Setup' })).toBe('rodent_bait_setup');
    expect(oneTimeCopyKeyFor({ service: 'termite_bait', label: 'Termite Bait Station Installation' })).toBe('termite_bait');
    expect(oneTimeCopyKeyFor({ service: 'termite_bait_installation', label: 'Sentricon Installation' })).toBe('termite_bait');
    expect(oneTimeCopyKeyFor({ service: 'exclusion_v2', label: 'Full Rodent Exclusion' })).toBe('rodent_exclusion');
    // Pre-slab is a regulated certificate surface like WDO — never a pack.
    expect(oneTimeCopyKeyFor({ service: 'pre_slab_termiticide', label: 'Pre-Slab Termite Treatment' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'bora_care', label: 'Bora-Care Wood Treatment' })).toBe('bora_care');
    expect(oneTimeCopyKeyFor({ service: 'plugging', label: 'Lawn Plugging Service' })).toBe('plugging');
    expect(oneTimeCopyKeyFor({ service: 'dethatching', label: 'Lawn Dethatching' })).toBe('dethatching');
    expect(oneTimeCopyKeyFor({ service: 'top_dressing', label: 'Lawn Top Dressing' })).toBe('top_dressing');
    expect(oneTimeCopyKeyFor({ service: 'palm_injection', label: 'Palm Injection' })).toBe('palm_injection');
    expect(oneTimeCopyKeyFor({ service: 'tree_shrub', label: 'One-Time Tree & Shrub Visit' })).toBe('tree_shrub_one_time');
  });

  test('rows that must NOT inherit a pack: knockdown add-on, guarantee/bond rows, setup fee, discounts, quote-required', () => {
    expect(oneTimeCopyKeyFor({ service: 'pest_initial_roach', label: 'Initial German Roach Knockdown' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'rodent_guarantee', label: 'Annual Rodent Guarantee' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'termite_bond', label: 'Termite Bond' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'waveguard_setup', label: 'WaveGuard Setup' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'one_time_adjustment', label: 'WaveGuard Member Discount', amount: -50, kind: 'discount' })).toBeNull();
    expect(oneTimeCopyKeyFor({ ...roach2, kind: 'quote_required', quoteRequired: true, amount: null })).toBeNull();
    // The service key is authoritative: label/detail text never overrides it.
    expect(oneTimeCopyKeyFor({ service: 'one_time_pest', label: 'One-Time Pest Control', detail: 'roach cleanout + fleas requested' })).toBe('one_time_pest');
    expect(oneTimeCopyKeyFor({ service: 'rodent_exclusion', label: 'Rodent Exclusion', detail: 'after trapping' })).toBe('rodent_exclusion');
    // An unrecognized service key gets NO pack (fail-safe), even with a matching label.
    expect(oneTimeCopyKeyFor({ service: 'rodent_bird_box', label: 'Rodent Bird Box' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'pest_control', label: 'One-Time Pest Control' })).toBeNull();
    // WDO is a regulated certificate surface — never a pack, by key or by name.
    expect(oneTimeCopyKeyFor({ service: 'wdo_inspection', label: 'WDO Inspection' })).toBeNull();
    expect(oneTimeCopyKeyFor({ label: 'WDO Inspection' })).toBeNull();
  });
});

describe('resolveOneTimeServiceCopy', () => {
  test('German roach copy adapts its outcome and follow-up bullet to the severity tier visit count', () => {
    const two = resolveOneTimeServiceCopy(roach2);
    expect(two.key).toBe('german_roach');
    expect(two.outcome).toMatch(/Two targeted visits/);
    expect(two.includes).toContain('Visit 2 about 10–14 days later — re-fog, re-bait, and confirm zero live activity');
    expect(two.includes.some((line) => /ULV fogging with a non-repellent plus an insect growth regulator/.test(line))).toBe(true);
    expect(two.includes.some((line) => /prep email before your first visit/.test(line))).toBe(true);
    expect(two.outcome).not.toMatch(/^Your kitchen back/);
    // Assurance rides as the LAST bullet, like the recurring card's guarantee line.
    expect(two.includes[two.includes.length - 1]).toBe(two.assurance);
    expect(two.assurance).toMatch(/100% guaranteed with the Waves Guarantee/);
    expect(two.terms).toBe('Pay on service day. No recurring schedule, no contract.');

    // A legacy row with no visits field reads the count from its label.
    const legacyThree = resolveOneTimeServiceCopy({ name: 'German Roach Cleanout — 3 Visit Program', price: 450 });
    expect(legacyThree.outcome).toMatch(/Three targeted visits/);
    // …or from a word-number detail ("Two visits").
    expect(resolveOneTimeServiceCopy({ service: 'german_roach', name: 'German Roach Cleanout', price: 350, detail: 'Two visits' }).outcome).toMatch(/Two targeted visits/);
    expect(oneTimeOnlyIntelligenceCopy([{ name: 'German Roach Cleanout — 3 Visit Program', price: 450 }]).hero.sub).toMatch(/^Three targeted visits/);
    const three = resolveOneTimeServiceCopy(roach3);
    expect(three.outcome).toMatch(/Three targeted visits/);
    expect(three.includes).toContain('Follow-up visits every 10–14 days — re-fog, re-bait, and confirm zero live activity — three visits in total');
    expect(three.includes).not.toContain('Visit 2 about 10–14 days later — re-fog, re-bait, and confirm zero live activity');
  });

  test('flea: copy follows the priced row — warranty from warrantyType, yard bullet only when the exterior was priced', () => {
    const two = resolveOneTimeServiceCopy({ service: 'flea_package', label: 'Flea Elimination Package', offerKey: 'flea_elimination_two_visit', warrantyType: 'conditional_retreat', exteriorStatus: 'priced' });
    expect(two.includes).toContain('Follow-up visit at the 14-day egg-hatch window');
    expect(two.includes).toContain('Yard treatment focused on shaded harborage where flea larvae develop');
    expect(two.assurance).toMatch(/retreat guaranteed with the Waves Guarantee once the prep checklist and pet treatment are done/);
    expect(two.outcome).toMatch(/house and the yard/);

    const one = resolveOneTimeServiceCopy({ service: 'flea_knockdown_single', label: 'Flea Knockdown', visits: 1, warrantyType: 'none', exteriorStatus: 'not_included' });
    expect(one.includes.some((line) => line.startsWith('Single knockdown visit'))).toBe(true);
    expect(one.includes).not.toContain('Yard treatment focused on shaded harborage where flea larvae develop');
    expect(one.assurance).toBeNull();
    expect(one.includes.join(' ')).not.toMatch(/guarantee/i);
    expect(one.outcome).toBe('Fleas out of the house, with the egg cycle broken so they don’t come back.');
    expect(one.terms).toMatch(/no retreat warranty/);
    // A legacy row with no warrantyType fails closed: no guarantee line, default terms.
    const legacy = resolveOneTimeServiceCopy({ service: 'flea_package', label: 'Flea Elimination Package', visits: 2 });
    expect(legacy.assurance).toBeNull();
    expect(legacy.terms).toBe('Pay on service day. No recurring schedule, no contract.');
    // Hero subline follows the same scope.
    const singleHero = oneTimeOnlyIntelligenceCopy([{ service: 'flea_knockdown_single', label: 'Flea Knockdown', amount: 200, visits: 1, exteriorStatus: 'not_included' }]).hero.sub;
    expect(singleHero).toMatch(/^Interior treatment priced from your home — approve/);
    expect(singleHero).not.toMatch(/follow-up/);
    const twoHero = oneTimeOnlyIntelligenceCopy([{ service: 'flea_package', label: 'Flea Elimination Package', amount: 350, visits: 2, exteriorStatus: 'priced' }]).hero.sub;
    expect(twoHero).toMatch(/^Interior and yard treatment priced from your home, with the follow-up built in/);
    // Scope comes from every row of the key, not whichever row is first.
    const dupHero = oneTimeOnlyIntelligenceCopy([
      { service: 'flea_package', label: 'Flea Elimination Package — exterior', amount: 95, exteriorStatus: 'not_included' },
      { service: 'flea_package', label: 'Flea Elimination Package', amount: 350, visits: 2, exteriorStatus: 'priced' },
    ]).hero.sub;
    expect(dupHero).toBe(twoHero);
  });

  test('wasp: physical removal is promised only when the removal add-on was priced', () => {
    const treated = resolveOneTimeServiceCopy({ service: 'wasp', label: 'Wasp Nest Treatment', nestRemovalSelected: false });
    expect(treated.includes[0]).toBe('Nest treatment — physical nest removal is available as an add-on');
    expect(treated.outcome).toMatch(/^The nest knocked out/);
    const removed = resolveOneTimeServiceCopy({ service: 'wasp', label: 'Wasp Nest Treatment', nestRemovalSelected: true });
    expect(removed.includes[0]).toBe('Nest treatment and physical removal');
    expect(removed.outcome).toMatch(/^The nest gone/);
  });

  test('stinging-v2 rows never offer removal as an add-on, and the AI body / hero describe only the v2 pricer inputs', () => {
    const v2 = resolveOneTimeServiceCopy({ service: 'stinging_insect_v2', name: 'Stinging Insect — wasp', price: 120 });
    expect(v2.includes[0]).toBe(ONE_TIME_SERVICE_COPY.wasp.noRemovalBulletV2);
    expect(v2.includes.join(' ')).not.toMatch(/add-on|removal/i);
    const legacy = resolveOneTimeServiceCopy({ service: 'wasp', label: 'Wasp Nest Treatment', amount: 150 });
    expect(legacy.includes[0]).toBe(ONE_TIME_SERVICE_COPY.wasp.noRemovalBullet);
    const ai = oneTimeOnlyIntelligenceCopy([{ service: 'stinging_insect_v2', name: 'Stinging Insect — wasp', price: 120 }]);
    expect(ai.aiBody).toBe(ONE_TIME_SERVICE_COPY.wasp.aiBodyV2);
    expect(ai.aiBody).not.toMatch(/aggressive|removal|how high/i);
    expect(ai.hero.sub).toBe(ONE_TIME_SERVICE_COPY.wasp.hero.subV2);
    expect(ai.hero.sub).not.toMatch(/removal|hard to reach/i);
    const legacyAi = oneTimeOnlyIntelligenceCopy([{ service: 'wasp', label: 'Wasp Nest Treatment', amount: 150 }]);
    expect(legacyAi.aiBody).toBe(ONE_TIME_SERVICE_COPY.wasp.aiBody);
    expect(legacyAi.hero.sub).toBe(ONE_TIME_SERVICE_COPY.wasp.hero.sub);
  });

  test('trap-only terms disclose the billing mode: monthly = 12-month agreement, annual = prepaid, unknown = generic', () => {
    const pack = ONE_TIME_SERVICE_COPY.trap_only;
    expect(resolveOneTimeServiceCopy({ service: 'trap_only_retainer', label: 'Trap-Only Monitoring Retainer', retainerBilling: 'monthly' }).terms).toBe(pack.termsMonthly);
    expect(pack.termsMonthly).toMatch(/12-month agreement/);
    expect(resolveOneTimeServiceCopy({ service: 'trap_only_retainer', label: 'Trap-Only Monitoring Retainer', retainerBilling: 'annual' }).terms).toBe(pack.termsAnnual);
    // Legacy rows carry the mode only in the pricer's own row text.
    expect(resolveOneTimeServiceCopy({ service: 'trap_only_retainer', name: 'Standard - Monthly, 12-month agreement', price: 49 }).terms).toBe(pack.termsMonthly);
    expect(resolveOneTimeServiceCopy({ service: 'trap_only_retainer', name: 'Standard - Annual prepaid', price: 499 }).terms).toBe(pack.termsAnnual);
    expect(resolveOneTimeServiceCopy({ service: 'trap_only_retainer', label: 'Trap-Only Monitoring Retainer' }).terms).toBe(pack.terms);
  });

  test('Bora-Care bullets and hero follow the measured area — a surface-only quote never promises attic framing', () => {
    const pack = ONE_TIME_SERVICE_COPY.bora_care;
    const surface = { service: 'bora_care', label: 'Bora-Care Wood Treatment', price: 450, atticSqFt: null, surfaceSqFt: 640 };
    const attic = { service: 'bora_care', label: 'Bora-Care Wood Treatment', price: 900, atticSqFt: 1800, surfaceSqFt: null };
    const both = { service: 'bora_care', label: 'Bora-Care Wood Treatment', price: 1200, atticSqFt: 1800, surfaceSqFt: 640 };
    const legacy = { service: 'bora_care', label: 'Bora-Care Wood Treatment', price: 700 };
    expect(resolveOneTimeServiceCopy(surface).includes[0]).toBe(pack.woodBulletSurface);
    expect(resolveOneTimeServiceCopy(surface).includes.join(' ')).not.toMatch(/attic/i);
    expect(resolveOneTimeServiceCopy(attic).includes[0]).toBe(pack.woodBulletAttic);
    expect(resolveOneTimeServiceCopy(both).includes[0]).toBe(pack.woodBullet);
    expect(resolveOneTimeServiceCopy(legacy).includes[0]).toBe(pack.woodBulletNeutral);
    expect(oneTimeOnlyIntelligenceCopy([surface]).hero.sub).toMatch(/measured wood surfaces/);
    expect(oneTimeOnlyIntelligenceCopy([surface]).hero.sub).not.toMatch(/attic|\{Areas\}/);
    expect(oneTimeOnlyIntelligenceCopy([attic]).hero.sub).toMatch(/measured attic framing/);
    expect(oneTimeOnlyIntelligenceCopy([both]).hero.sub).toMatch(/measured attic and surface areas/);
    expect(oneTimeOnlyIntelligenceCopy([legacy]).hero.sub).toMatch(/measured treatment area/);
  });

  test('standalone-safe wording: sanitation, dethatching, and top dressing promise no companion service or season the engine cannot enforce', () => {
    const san = ONE_TIME_SERVICE_COPY.rodent_sanitation;
    expect(`${san.outcome} ${san.hero.sub}`).not.toMatch(/coordinated|timed with|exclusion/i);
    expect(san.includes.join(' ')).not.toMatch(/coordinated with exclusion/i);
    const de = ONE_TIME_SERVICE_COPY.dethatching;
    expect(`${de.outcome} ${de.includes.join(' ')} ${de.hero.sub}`).not.toMatch(/right time of year|timed so/i);
    const td = ONE_TIME_SERVICE_COPY.top_dressing;
    expect(`${td.outcome} ${td.includes.join(' ')} ${td.hero.sub}`).not.toMatch(/coordinated with/i);
  });

  test('one-time pest: a unit-band (interior-only) row swaps the exterior-perimeter bullet for the interior-unit bullet', () => {
    const whole = resolveOneTimeServiceCopy({ service: 'one_time_pest', label: 'One-Time Pest Control' });
    expect(whole.includes[0]).toMatch(/^Full exterior perimeter/);
    const unit = resolveOneTimeServiceCopy({ service: 'one_time_pest', label: 'One-Time Pest Control', includedScope: 'interior_unit_general_pest' });
    expect(unit.includes[0]).toMatch(/^Interior of your unit treated/);
    expect(unit.includes.join(' ')).not.toMatch(/exterior perimeter/i);
  });

  test('AI provenance copy describes only inputs the pricer actually uses (wasp: no species; trapping: the flat standard plan)', () => {
    expect(ONE_TIME_SERVICE_COPY.wasp.aiBody).not.toMatch(/species/i);
    expect(ONE_TIME_SERVICE_COPY.wasp.hero.sub).not.toMatch(/species/i);
    expect(ONE_TIME_SERVICE_COPY.rodent_trapping.aiBody).not.toMatch(/not a flat fee|sized to/i);
    expect(ONE_TIME_SERVICE_COPY.rodent_trapping.aiBody).toMatch(/standard plan/i);
    expect(ONE_TIME_SERVICE_COPY.one_time_pest.hero.sub).not.toMatch(/priced from your actual property/i);
  });

  test('trenching: the colony-transfer claim only rides non-repellent chemistry', () => {
    const fipronil = resolveOneTimeServiceCopy({ service: 'trenching', label: 'Termite Trenching', chemistryType: 'non_repellent' });
    expect(fipronil.outcome).toMatch(/carry it back to the colony/);
    const pyrethroid = resolveOneTimeServiceCopy({ service: 'trenching', label: 'Termite Trenching', chemistryType: 'repellent_pyrethroid' });
    expect(pyrethroid.outcome).toBe('A continuous liquid barrier around your foundation — a treated zone termites will not cross.');
    // Unknown chemistry fails closed to the barrier wording.
    expect(resolveOneTimeServiceCopy({ service: 'trenching', label: 'Termite Trenching' }).outcome).toBe(pyrethroid.outcome);
    // The warranty-period inspection bullet rides a sold warranty tier only.
    expect(resolveOneTimeServiceCopy({ service: 'trenching', label: 'Termite Trenching', chemistryType: 'non_repellent', warrantyTier: 'one_year_retreat' }).includes).toContain('Annual inspection during the warranty period');
    expect(resolveOneTimeServiceCopy({ service: 'trenching', label: 'Termite Trenching', chemistryType: 'repellent_pyrethroid', warrantyTier: 'none' }).includes).not.toContain('Annual inspection during the warranty period');
    expect(resolveOneTimeServiceCopy({ service: 'trenching', label: 'Termite Trenching' }).includes).not.toContain('Annual inspection during the warranty period');
  });

  test('dethatching: debris hauling is a bullet only when the row includes it', () => {
    expect(resolveOneTimeServiceCopy({ service: 'dethatching', label: 'Lawn Dethatching', debrisRemovalIncluded: true }).includes).toContain('Removal and disposal of thatch debris');
    expect(resolveOneTimeServiceCopy({ service: 'dethatching', label: 'Lawn Dethatching', debrisRemovalIncluded: false }).includes).not.toContain('Removal and disposal of thatch debris');
    expect(resolveOneTimeServiceCopy({ service: 'dethatching', label: 'Lawn Dethatching' }).includes).not.toContain('Removal and disposal of thatch debris');
    expect(ONE_TIME_SERVICE_COPY.dethatching.hero.sub).not.toMatch(/debris/);
  });

  test('rodent inspection: the fee-credit bullet carries the row\'s configured window, or is absent', () => {
    const with14 = resolveOneTimeServiceCopy({ service: 'rodent_inspection', label: 'Rodent Inspection', creditableWithinDays: 14 });
    expect(with14.includes).toContain('Inspection fee credited toward the recommended service when you book it within 14 days');
    const noWindow = resolveOneTimeServiceCopy({ service: 'rodent_inspection', label: 'Rodent Inspection' });
    expect(noWindow.includes.join(' ')).not.toMatch(/credited/);
  });

  test('exclusion: vent screening is promised only when priced (flag, or the legacy "+screening" detail via the normalizer)', () => {
    const screened = resolveOneTimeServiceCopy({ service: 'exclusion_v2', label: 'Full Rodent Exclusion', includesScreening: true });
    expect(screened.includes).toContain('Vent screening on dryer, attic, gable, and soffit vents');
    const bare = resolveOneTimeServiceCopy({ service: 'exclusion_v2', label: 'Full Rodent Exclusion', includesScreening: false });
    expect(bare.includes).not.toContain('Vent screening on dryer, attic, gable, and soffit vents');
    expect(resolveOneTimeServiceCopy({ service: 'rodent_exclusion', label: 'Rodent Exclusion' }).includes).not.toContain('Vent screening on dryer, attic, gable, and soffit vents');
  });

  test('sanitation never promises insulation replacement; termite bait spacing is system-neutral', () => {
    expect(resolveOneTimeServiceCopy({ service: 'rodent_sanitation', label: 'Rodent Sanitation' }).includes.join(' ')).not.toMatch(/insulation/i);
    expect(resolveOneTimeServiceCopy({ service: 'termite_bait', label: 'Termite Bait Station Installation' }).includes.join(' ')).not.toMatch(/8–10 feet/);
  });

  test('resolveOneTimeRowCopies: one copy per logical job, included rows bare', () => {
    const rows = [
      { service: 'rodent_exclusion', label: 'Exclusion — wire mesh', amount: 400 },
      { service: 'rodent_exclusion', label: 'Exclusion — job minimum', amount: 150 },
      { service: 'rodent_exclusion', label: 'Inspection fee', amount: 0, serviceSpecificDiscountApplied: true },
      { service: 'wasp', label: 'Wasp Nest Treatment', amount: 150, nestRemovalSelected: true },
    ];
    const copies = resolveOneTimeRowCopies(rows);
    expect(copies.map((c) => (c ? c.key : null))).toEqual(['rodent_exclusion', null, null, 'wasp']);
  });

  test('legacy mapper carries the sold-scope flags the pack reads (bed bug warranty, wasp removal, dethatching debris)', () => {
    const shaped = mapV1ToLegacyShape({
      lineItems: [
        { service: 'bed_bug', name: 'Bed Bug Heat Treatment — 2 room(s)', price: 1450, warrantyEligible: true },
        { service: 'wasp', name: 'Wasp Nest Treatment', price: 225, pricingBreakdown: { subtotal: 225, removal: 75 } },
        { service: 'dethatching', name: 'Lawn Dethatching', price: 300, debrisRemovalIncluded: false, cleanupLevel: 'none' },
        { service: 'rodent_inspection', name: 'Rodent Inspection', price: 149, creditableWithinDays: 14 },
        { service: 'exclusion_v2', name: 'Full Rodent Exclusion', price: 895, includesScreening: true },
        { service: 'one_time_pest', name: 'One-Time Pest Control', price: 189, includedScope: 'interior_unit_general_pest', scopeExclusions: ['interior only'], scopeNote: 'Interior of your unit only' },
        { service: 'trap_only_retainer', name: 'Standard', price: 49, trapOnlyRetainerBilling: 'monthly', retainerBilling: 'monthly' },
        { service: 'bora_care', name: 'Bora-Care Wood Treatment', price: 450, atticSqFt: null, surfaceSqFt: 640 },
      ],
      total: { oneTime: 2164, monthly: 0, annual: 0 },
    });
    // Specialty rows land in specItems, lawn one-time rows in items — both projections carry the flags.
    const items = [...(shaped?.oneTime?.specItems || []), ...(shaped?.oneTime?.items || [])];
    const byService = Object.fromEntries(items.map((it) => [it.service, it]));
    expect(byService.bed_bug.warrantyEligible).toBe(true);
    expect(byService.wasp.nestRemovalSelected).toBe(true);
    expect(byService.dethatching.debrisRemovalIncluded).toBe(false);
    expect(byService.rodent_inspection.creditableWithinDays).toBe(14);
    expect(byService.exclusion_v2.includesScreening).toBe(true);
    expect(byService.one_time_pest.includedScope).toBe('interior_unit_general_pest');
    expect(byService.trap_only_retainer.retainerBilling).toBe('monthly');
    expect(byService.bora_care.atticSqFt).toBeNull();
    expect(byService.bora_care.surfaceSqFt).toBe(640);
  });

  test('bed bug: the treatment-method bullet leads and follows the priced method', () => {
    const heat = resolveOneTimeServiceCopy({ service: 'bed_bug', label: 'Bed Bug Heat Treatment — 2 room(s) — trailer' });
    expect(heat.includes[0]).toMatch(/Whole-room heat to 120°F\+/);
    const chem = resolveOneTimeServiceCopy({ service: 'bed_bug', label: 'Bed Bug Chemical Treatment — 2 room(s), 2 visit(s)', warrantyEligible: true });
    expect(chem.includes[0]).toMatch(/Liquid and dust treatment/);
    // Owner ruling 2026-09-03: bed bug IS guaranteed — the pricer stamps
    // warrantyEligible:true on priced results and the copy reads it.
    expect(chem.assurance).toBe('Written 30-day guarantee on the treated areas');
    // A quote-required / legacy row without the flag fails closed.
    expect(resolveOneTimeServiceCopy({ service: 'bed_bug', label: 'Bed Bug Heat Treatment — 2 room(s)' }).assurance).toBeNull();
  });

  test('one-time pest keeps the 30-day callback; termite and rodent exclusion/trapping carry NO guarantee line', () => {
    expect(resolveOneTimeServiceCopy({ service: 'one_time_pest', label: 'One-Time Pest Control' }).assurance).toMatch(/^30-day callback/);
    for (const row of [
      { service: 'termite_bait', label: 'Termite Bait Station Installation' },
      { service: 'bora_care', label: 'Bora-Care Wood Treatment' },
      { service: 'termite_foam', label: 'Termite Foam Treatment' },
      { service: 'trenching', label: 'Termite Trenching' },
      { service: 'rodent_exclusion', label: 'Rodent Exclusion' },
      { service: 'rodent_trapping', label: 'Rodent Trapping' },
    ]) {
      const copy = resolveOneTimeServiceCopy(row);
      expect(copy.assurance).toBeNull();
      expect(copy.includes.join(' ')).not.toMatch(/guarantee/i);
    }
  });

  test('every pack entry ships an outcome, at least three bullets, terms, and a service-specific hero', () => {
    for (const entry of Object.values(ONE_TIME_SERVICE_COPY)) {
      expect(typeof entry.outcome).toBe('string');
      expect(entry.outcome.length).toBeGreaterThan(0);
      expect(entry.includes.length).toBeGreaterThanOrEqual(3);
      expect(typeof entry.terms).toBe('string');
      expect(typeof entry.hero.eyebrow).toBe('string');
      expect(entry.hero.h1).toMatch(/\{first\}/);
      expect(typeof entry.hero.sub).toBe('string');
    }
  });
});

describe('oneTimeOnlyIntelligenceCopy', () => {
  test('a single-service one-time quote gets that service\'s hero, Waves AI copy, and chips', () => {
    const ai = oneTimeOnlyIntelligenceCopy([roach2]);
    expect(ai.key).toBe('german_roach');
    expect(ai.hero.eyebrow).toBe('Your German roach cleanout');
    expect(ai.hero.h1).toBe('Hello {first}, your German roach cleanout quote is ready!');
    expect(ai.hero.sub).toMatch(/^Two targeted visits/);
    expect(ai.aiTitle).toBe('Waves AI sized this cleanout to your infestation');
    expect(ai.askChips[0]).toBe('How do you get rid of German roaches?');
    expect(ai.askChips).toContain('What precautions should I follow for pets and children?');
  });

  test('discount rows do not break the single-key rule; mixed services return null; hero-only packs carry no AI copy', () => {
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'one_time_adjustment', kind: 'discount', amount: -50 }]).key).toBe('german_roach');
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'one_time_adjustment', label: 'WaveGuard Member Discount', price: -110 }]).key).toBe('german_roach');
    // A POSITIVE adjustment is the residual "Other one-time services" charge — a second, unknown service (codex r8 P0).
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'one_time_adjustment', label: 'Other one-time services', amount: 200 }])).toBeNull();
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'one_time_adjustment', label: 'Other one-time services', price: 200 }])).toBeNull();
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'wasp', label: 'Wasp Nest Treatment', amount: 150 }])).toBeNull();
    // Included (service-credit) and quote-required rows are services too — their presence makes the quote mixed.
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'wasp', label: 'Wasp Nest Treatment', amount: 0, kind: 'included', serviceSpecificDiscountApplied: true }])).toBeNull();
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'trenching', label: 'Termite Trenching', amount: null, kind: 'quote_required', quoteRequired: true }])).toBeNull();
    const foam = oneTimeOnlyIntelligenceCopy([{ service: 'termite_foam', label: 'Termite Foam', amount: 180 }]);
    expect(foam.hero.eyebrow).toBe('Your termite foam treatment');
    expect(foam.aiTitle).toBeUndefined();
    expect(foam.askChips).toEqual([]);
    expect(oneTimeOnlyIntelligenceCopy([])).toBeNull();
  });
});

describe('React /data contract', () => {
  const roachEstData = { result: { recurring: { services: [] }, oneTime: { items: [{ ...roach2, price: 350, name: roach2.label }] } } };

  test('one-time-only roach estimate: rows carry item.copy, the page carries oneTimeServiceCopy, chips are the roach set', () => {
    const contract = attachPublicPricingContract(
      { frequencies: [], oneTimeBreakdown: { total: 350, items: [roach2] } },
      { status: 'sent' },
      roachEstData,
    );
    expect(contract.oneTimeBreakdown.items[0].copy.key).toBe('german_roach');
    expect(contract.oneTimeBreakdown.items[0].copy.outcome).toMatch(/Two targeted visits/);
    expect(contract.oneTimeServiceCopy.aiTitle).toBe('Waves AI sized this cleanout to your infestation');
    expect(contract.askChips[0]).toBe('How do you get rid of German roaches?');
    expect(contract.askChips.length).toBeLessThanOrEqual(6);
  });

  test('recurring pest plan with a roach cleanout add-on: the row keeps its copy, the page keeps the plan copy', () => {
    const contract = attachPublicPricingContract(
      {
        frequencies: [{ key: 'quarterly', label: 'Quarterly', price: 117, visitsPerYear: 4, billingKey: 'quarterly' }],
        oneTimeBreakdown: { total: 350, items: [roach2] },
      },
      { status: 'sent' },
      { result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 39 }] }, oneTime: { items: [roach2] } } },
    );
    expect(contract.oneTimeBreakdown.items[0].copy.key).toBe('german_roach');
    expect(contract.oneTimeServiceCopy).toBeUndefined();
  });

  test('a WDO quote (regulated certificate surface) gets no chips and no row copy', () => {
    const wdo = { service: 'wdo_inspection', label: 'WDO Inspection', amount: 125 };
    const contract = attachPublicPricingContract(
      { frequencies: [], oneTimeBreakdown: { total: 125, items: [wdo] } },
      { status: 'sent' },
      { result: { recurring: { services: [] }, oneTime: { items: [{ ...wdo, price: 125, name: wdo.label }] } } },
    );
    expect(contract.askChips).toEqual([]);
    expect(contract.oneTimeBreakdown.items[0].copy).toBeUndefined();
    expect(contract.oneTimeServiceCopy).toBeUndefined();
  });

  test('a mixed quote whose aligned breakdown dropped the second service still mints no page copy', () => {
    const contract = attachPublicPricingContract(
      { frequencies: [], oneTimeBreakdown: { total: 350, items: [roach2] } },
      { status: 'sent' },
      { result: { recurring: { services: [] }, oneTime: { items: [
        { ...roach2, price: 350, name: roach2.label },
        { service: 'wasp', label: 'Wasp Nest Treatment', name: 'Wasp Nest Treatment', price: 150 },
      ] } } },
    );
    expect(contract.oneTimeServiceCopy).toBeUndefined();
    expect(contract.oneTimeBreakdown.items[0].copy.key).toBe('german_roach');
  });

  test('a hero-only pack (termite foam) echoes the category chips it renders — oneTimeServiceCopy.askChips === askChips', () => {
    const foam = { service: 'termite_foam', label: 'Termite Foam Treatment', amount: 180 };
    const contract = attachPublicPricingContract(
      { frequencies: [], oneTimeBreakdown: { total: 180, items: [foam] } },
      { status: 'sent' },
      { result: { recurring: { services: [] }, oneTime: { items: [{ ...foam, price: 180, name: foam.label }] } } },
    );
    expect(contract.oneTimeServiceCopy.hero.eyebrow).toBe('Your termite foam treatment');
    expect(contract.oneTimeServiceCopy.aiTitle).toBeUndefined();
    expect(contract.askChips.length).toBeGreaterThan(0);
    expect(contract.oneTimeServiceCopy.askChips).toEqual(contract.askChips);
  });

  test('a regulated surface whose aligned breakdown dropped the WDO row still mints no page copy', () => {
    const contract = attachPublicPricingContract(
      { frequencies: [], oneTimeBreakdown: { total: 350, items: [roach2] } },
      { status: 'sent' },
      { result: { recurring: { services: [] }, oneTime: { items: [
        { ...roach2, price: 350, name: roach2.label },
        { service: 'wdo_inspection', label: 'WDO Inspection', name: 'WDO Inspection', price: 125 },
      ] } } },
    );
    expect(contract.askChips).toEqual([]);
    expect(contract.oneTimeServiceCopy).toBeUndefined();
    // …and the roach row carries no narrative copy either.
    expect(contract.oneTimeBreakdown.items[0].copy).toBeUndefined();
  });
});

describe('Waves AI intelligence payload', () => {
  test('one-time-only roach estimate describes the cleanout; a recurring plan keeps the generic title', () => {
    const solo = buildWaveGuardIntelligencePayload(
      { address: '1 Main St, Bradenton, FL 34203' },
      { result: { recurring: { services: [] }, oneTime: { items: [{ ...roach2, price: 350, name: roach2.label }] } } },
      { recurringServices: [] },
    );
    expect(solo.title).toBe('Waves AI sized this cleanout to your infestation');
    expect(solo.body).toMatch(/visit count fits the job/);

    const plan = buildWaveGuardIntelligencePayload(
      { address: '1 Main St, Bradenton, FL 34203' },
      { result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 39 }] }, oneTime: { items: [{ ...roach2, price: 350, name: roach2.label }] } } },
      { recurringServices: [{ name: 'Pest Control', service: 'pest_control', mo: 39 }] },
    );
    expect(plan.title).toBe('Waves AI reviewed your property before pricing this estimate');

    // A plan estimate handed in with an EMPTY recurringServices option is
    // still a plan — the stored recurring rows decide, not the caller's list.
    const planEmptyOpt = buildWaveGuardIntelligencePayload(
      { address: '1 Main St, Bradenton, FL 34203' },
      { result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 39 }] }, oneTime: { items: [{ ...roach2, price: 350, name: roach2.label }] } } },
      { recurringServices: [] },
    );
    expect(planEmptyOpt.title).toBe('Waves AI reviewed your property before pricing this estimate');
  });
});

describe('server-rendered page', () => {
  test('one-time-only roach estimate renders the outcome, the visit bullets, the terms, and the roach chips', () => {
    const est = {
      id: 'estimate-roach-ssr',
      status: 'sent',
      customerName: 'Test Customer',
      address: '1 Main St, Bradenton, FL 34203',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 350,
      quoteRequired: false,
    };
    const html = renderPage('roach-token', est, {
      result: { recurring: { services: [] }, oneTime: { items: [{ ...roach2, price: 350, name: roach2.label }] } },
    });
    expect(html).toContain('class="onetime-outcome"');
    expect(html).toContain('Two targeted visits');
    // Bullets ride a native <details> dropdown, collapsed by default.
    expect(html).toContain('<details class="onetime-includes-wrap"><summary>See everything included (7)</summary>');
    // A closed <details> prints nothing — the page opens every inclusion list on beforeprint (codex r6).
    expect(html).toContain("window.addEventListener('beforeprint', () => { document.querySelectorAll('details.onetime-includes-wrap')");
    expect(html).toContain('Gel bait placed where German roaches actually live');
    expect(html).toContain('ULV fogging with a non-repellent plus an insect growth regulator (IGR)');
    expect(html).toContain('Visit 2 about 10–14 days later');
    // Hero names the service, with the first name and the visit count filled.
    expect(html).toContain('<div class="eyebrow">Your German roach cleanout</div>');
    expect(html).toContain('<h1>Hello Test, your German roach cleanout quote is ready!</h1>');
    expect(html).toContain('<p class="hero-sub">Two targeted visits, priced from your home');
    expect(html).toContain('100% guaranteed with the Waves Guarantee');
    expect(html).toContain('Pay on service day. No recurring schedule, no contract.');
    expect(html).toContain('Waves AI sized this cleanout to your infestation');
    expect(html).toContain('data-estimate-ask-prompt="How do you get rid of German roaches?"');
    expect(html).toContain('data-estimate-ask-prompt="What should I do before the first visit?"');
  });

  test('a mixed one-time quote keeps the generic hero and per-row copy only', () => {
    const est = {
      id: 'estimate-mixed-ssr',
      status: 'sent',
      customerName: 'Test Customer',
      address: '1 Main St, Bradenton, FL 34203',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 500,
      quoteRequired: false,
    };
    const html = renderPage('mixed-token', est, {
      result: { recurring: { services: [] }, oneTime: { items: [
        { ...roach2, price: 350, name: roach2.label },
        { service: 'wasp', label: 'Wasp Nest Treatment', name: 'Wasp Nest Treatment', price: 150 },
      ] } },
    });
    expect(html).toContain('<h1>Hello Test, your estimate is ready!</h1>');
    expect(html).not.toContain('class="hero-sub"');
    expect(html).toContain('Gel bait placed where German roaches actually live');
    expect(html).toContain('Nest treatment — physical nest removal is available as an add-on');
    expect(html).not.toContain('Waves AI sized this cleanout to your infestation');
  });

  test('an engine-backed estimate (no result.oneTime rows) keeps its sold-scope flags on the SSR page', () => {
    const est = {
      id: 'estimate-engine-ssr',
      status: 'sent',
      customerName: 'Test Customer',
      address: '1 Main St, Bradenton, FL 34203',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 300,
      quoteRequired: false,
    };
    const html = renderPage('engine-token', est, {
      engineResult: { lineItems: [
        { service: 'wasp', name: 'Wasp Nest Treatment', price: 300, pricingBreakdown: { subtotal: 300, removal: 75 } },
      ] },
    });
    expect(html).toContain('Nest treatment and physical removal');
    expect(html).not.toContain('physical nest removal is available as an add-on');
  });

  test('a regulated WDO surface renders no row copy at all, even for a roach row beside it', () => {
    const est = {
      id: 'estimate-wdo-ssr',
      status: 'sent',
      customerName: 'Test Customer',
      address: '1 Main St, Bradenton, FL 34203',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 475,
      quoteRequired: false,
    };
    const html = renderPage('wdo-token', est, {
      result: { recurring: { services: [] }, oneTime: { items: [
        { ...roach2, price: 350, name: roach2.label },
        { service: 'wdo_inspection', label: 'WDO Inspection', name: 'WDO Inspection', price: 125 },
      ] } },
    });
    expect(html).not.toContain('class="onetime-outcome"');
    expect(html).not.toContain('<details class="onetime-includes-wrap"');
    expect(html).not.toContain('class="hero-sub"');
  });
});
