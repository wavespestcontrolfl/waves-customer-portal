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
  oneTimeOnlyIntelligenceCopy,
  ONE_TIME_SERVICE_COPY,
} = require('../services/estimate-one-time-copy');
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
    expect(oneTimeCopyKeyFor({ service: 'flea_knockdown_single', label: 'Flea Knockdown' })).toBe('flea');
    expect(oneTimeCopyKeyFor({ service: 'flea_package', label: 'Flea Elimination Package', offerKey: 'flea_elimination_two_visit' })).toBe('flea');
    expect(oneTimeCopyKeyFor({ service: 'bed_bug', label: 'Bed Bug Heat Treatment — 2 room(s)' })).toBe('bed_bug');
    expect(oneTimeCopyKeyFor({ service: 'wasp', label: 'Wasp / Hornet Nest Treatment' })).toBe('wasp');
    expect(oneTimeCopyKeyFor({ service: 'stinging_insect', label: 'Yellowjacket Ground Nest' })).toBe('wasp');
    expect(oneTimeCopyKeyFor({ service: 'rodent_exclusion', label: 'Full Rodent Exclusion' })).toBe('rodent_exclusion');
    expect(oneTimeCopyKeyFor({ service: 'rodent_plugging', label: 'Rodent Entry-Point Plugging' })).toBe('rodent_exclusion');
    expect(oneTimeCopyKeyFor({ service: 'rodent_wire_mesh', label: 'Rodent Wire Mesh Exclusion Service' })).toBe('rodent_exclusion');
    expect(oneTimeCopyKeyFor({ service: 'rodent_trapping', label: 'Rodent Trapping' })).toBe('rodent_trapping');
    expect(oneTimeCopyKeyFor({ service: 'trap_only_setup', label: 'Trap-Only Setup / Inspection' })).toBe('trap_only');
    expect(oneTimeCopyKeyFor({ service: 'trap_only_retainer', label: 'Standard Trap-Only Retainer Service' })).toBe('trap_only');
    expect(oneTimeCopyKeyFor({ service: 'termite_foam', label: 'Termidor Foam Spot Treatment' })).toBe('termite_foam');
    expect(oneTimeCopyKeyFor({ service: 'trenching', label: 'Termite Trenching' })).toBe('termite_trenching');
    expect(oneTimeCopyKeyFor({ service: 'wdo_inspection', label: 'WDO Inspection' })).toBe('wdo_inspection');
    expect(oneTimeCopyKeyFor({ service: 'one_time_pest', label: 'One-Time Pest Control' })).toBe('one_time_pest');
    expect(oneTimeCopyKeyFor({ service: 'pest_initial_cleanout', label: 'Initial Pest Cleanout' })).toBe('one_time_pest');
    expect(oneTimeCopyKeyFor({ service: 'one_time_mosquito', label: 'One-Time Mosquito Treatment' })).toBe('one_time_mosquito');
    expect(oneTimeCopyKeyFor({ service: 'one_time_lawn', label: 'One-Time Lawn Treatment' })).toBe('one_time_lawn');
  });

  test('rows that must NOT inherit a pack: knockdown add-on, pre-slab, Bora-Care, setup fee, discounts, quote-required', () => {
    expect(oneTimeCopyKeyFor({ service: 'pest_initial_roach', label: 'Initial German Roach Knockdown' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'pre_slab_termiticide', label: 'Pre-Slab Termite Treatment' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'bora_care', label: 'Bora-Care Wood Treatment' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'waveguard_setup', label: 'WaveGuard Setup' })).toBeNull();
    expect(oneTimeCopyKeyFor({ service: 'one_time_adjustment', label: 'WaveGuard Member Discount', amount: -50, kind: 'discount' })).toBeNull();
    expect(oneTimeCopyKeyFor({ ...roach2, kind: 'quote_required', quoteRequired: true, amount: null })).toBeNull();
    // A one-time pest row whose DETAIL mentions roaches is still general pest.
    expect(oneTimeCopyKeyFor({ service: 'one_time_pest', label: 'One-Time Pest Control', detail: 'roach cleanout requested' })).toBe('one_time_pest');
  });
});

describe('resolveOneTimeServiceCopy', () => {
  test('German roach copy adapts its outcome and follow-up bullet to the severity tier visit count', () => {
    const two = resolveOneTimeServiceCopy(roach2);
    expect(two.key).toBe('german_roach');
    expect(two.outcome).toMatch(/^Your kitchen back\. Two targeted visits/);
    expect(two.includes).toContain('Visit 2 about 10–14 days later — confirm zero live activity and treat anything that surfaced');
    // Assurance rides as the LAST bullet, like the recurring card's guarantee line.
    expect(two.includes[two.includes.length - 1]).toBe(two.assurance);
    expect(two.assurance).toMatch(/100% guaranteed with the Waves Guarantee/);
    expect(two.terms).toBe('Pay on service day. No recurring schedule, no contract.');

    const three = resolveOneTimeServiceCopy(roach3);
    expect(three.outcome).toMatch(/^Your kitchen back\. Three targeted visits/);
    expect(three.includes).toContain('Follow-up visits every 10–14 days until the monitors read zero — three visits in total');
    expect(three.includes).not.toContain('Visit 2 about 10–14 days later — confirm zero live activity and treat anything that surfaced');
  });

  test('flea: two-visit package gets the follow-up bullet, single knockdown does not; both 100% guaranteed (owner 2026-09-03)', () => {
    const two = resolveOneTimeServiceCopy({ service: 'flea_package', label: 'Flea Elimination Package', offerKey: 'flea_elimination_two_visit' });
    expect(two.includes).toContain('Follow-up visit at the 14-day egg-hatch window');
    expect(two.assurance).toMatch(/100% guaranteed/);
    const one = resolveOneTimeServiceCopy({ service: 'flea_knockdown_single', label: 'Flea Knockdown', visits: 1 });
    expect(one.includes.some((line) => line.startsWith('Single knockdown visit'))).toBe(true);
    expect(one.assurance).toMatch(/100% guaranteed/);
  });

  test('bed bug: the treatment-method bullet leads and follows the priced method', () => {
    const heat = resolveOneTimeServiceCopy({ service: 'bed_bug', label: 'Bed Bug Heat Treatment — 2 room(s) — trailer' });
    expect(heat.includes[0]).toMatch(/Whole-room heat to 120°F\+/);
    const chem = resolveOneTimeServiceCopy({ service: 'bed_bug', label: 'Bed Bug Chemical Treatment — 2 room(s), 2 visit(s)' });
    expect(chem.includes[0]).toMatch(/Liquid and dust treatment/);
    expect(chem.assurance).toBe('Written 30-day guarantee on the treated areas');
  });

  test('one-time pest keeps the 30-day callback; termite, WDO, rodent exclusion/trapping carry NO guarantee line', () => {
    expect(resolveOneTimeServiceCopy({ service: 'one_time_pest', label: 'One-Time Pest Control' }).assurance).toMatch(/^30-day callback/);
    for (const row of [
      { service: 'termite_foam', label: 'Termite Foam Treatment' },
      { service: 'trenching', label: 'Termite Trenching' },
      { service: 'wdo_inspection', label: 'WDO Inspection' },
      { service: 'rodent_exclusion', label: 'Rodent Exclusion' },
      { service: 'rodent_trapping', label: 'Rodent Trapping' },
    ]) {
      const copy = resolveOneTimeServiceCopy(row);
      expect(copy.assurance).toBeNull();
      expect(copy.includes.join(' ')).not.toMatch(/guarantee/i);
    }
  });

  test('every pack entry ships an outcome, at least three bullets, and terms', () => {
    for (const entry of Object.values(ONE_TIME_SERVICE_COPY)) {
      expect(typeof entry.outcome).toBe('string');
      expect(entry.outcome.length).toBeGreaterThan(0);
      expect(entry.includes.length).toBeGreaterThanOrEqual(3);
      expect(typeof entry.terms).toBe('string');
    }
  });
});

describe('oneTimeOnlyIntelligenceCopy', () => {
  test('a single-service one-time quote gets that service\'s Waves AI copy and chips', () => {
    const ai = oneTimeOnlyIntelligenceCopy([roach2]);
    expect(ai.key).toBe('german_roach');
    expect(ai.aiTitle).toBe('Waves AI sized this cleanout to your infestation');
    expect(ai.askChips[0]).toBe('How do you get rid of German roaches?');
    expect(ai.askChips).toContain('What precautions should I follow for pets and children?');
  });

  test('discount rows do not break the single-key rule; mixed services and no-AI packs return null', () => {
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'one_time_adjustment', kind: 'discount', amount: -50 }]).key).toBe('german_roach');
    expect(oneTimeOnlyIntelligenceCopy([roach2, { service: 'wasp', label: 'Wasp Nest Treatment', amount: 150 }])).toBeNull();
    expect(oneTimeOnlyIntelligenceCopy([{ service: 'wdo_inspection', label: 'WDO Inspection', amount: 125 }])).toBeNull();
    expect(oneTimeOnlyIntelligenceCopy([{ service: 'termite_foam', label: 'Termite Foam', amount: 180 }])).toBeNull();
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

  test('a WDO quote (regulated certificate surface) still surfaces no chips', () => {
    const wdo = { service: 'wdo_inspection', label: 'WDO Inspection', amount: 125 };
    const contract = attachPublicPricingContract(
      { frequencies: [], oneTimeBreakdown: { total: 125, items: [wdo] } },
      { status: 'sent' },
      { result: { recurring: { services: [] }, oneTime: { items: [{ ...wdo, price: 125, name: wdo.label }] } } },
    );
    expect(contract.askChips).toEqual([]);
    expect(contract.oneTimeBreakdown.items[0].copy.key).toBe('wdo_inspection');
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
    expect(html).toContain('Visit 1 — gel bait where German roaches actually live');
    expect(html).toContain('Visit 2 about 10–14 days later');
    expect(html).toContain('100% guaranteed with the Waves Guarantee');
    expect(html).toContain('Pay on service day. No recurring schedule, no contract.');
    expect(html).toContain('Waves AI sized this cleanout to your infestation');
    expect(html).toContain('data-estimate-ask-prompt="How do you get rid of German roaches?"');
    expect(html).toContain('data-estimate-ask-prompt="What should I do before the first visit?"');
  });
});
