/**
 * Send-time QUOTE provenance in the pricing-audit snapshot (estimator
 * audit 2026-08-29 M4).
 *
 * Pins: auditVersion 2 blob carries a `quote` block (discount treatment,
 * setup-fee treatment incl. the operator waiver, property inputs with
 * verify flags, margin warnings) and per-line `quoted` passthroughs
 * (tier/cadence/floors/eligibility) — all read from the PERSISTED
 * estimate_data, never today's constants; the snapshot writer stores the
 * blob append-only with the caller's trigger; and the two once-missing
 * send paths (group siblings, click-mints) are wired in fail-soft.
 */

const mockState = { hasTable: false, inserted: [] };
jest.mock('../models/db', () => {
  const builder = {
    insert: jest.fn((row) => { mockState.inserted.push(row); return { returning: jest.fn(async () => [{ id: 'snap-1', ...row }]) }; }),
    join: jest.fn(() => builder),
    select: jest.fn(async () => []), // inventory COGS rows — empty is a valid degraded state
  };
  const fn = jest.fn(() => builder);
  fn.schema = { hasTable: jest.fn(async () => mockState.hasTable) };
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  fn.fn = { now: jest.fn(() => 'NOW') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  buildEstimatePricingAudit,
  saveEstimatePricingAuditSnapshot,
  quotedFieldsFrom,
  dimensionsFrom,
} = require('../services/estimate-pricing-audit');

function fixtureEstimate() {
  return {
    id: 'est-1',
    customer_name: 'Test Customer',
    address: '1 Test St',
    status: 'sent',
    source: 'manual',
    lead_source: 'google',
    monthly_total: '120.00',
    annual_total: '1440.00',
    onetime_total: '99.00',
    waveguard_tier: 'gold',
    pricing_version: 'v9.9-test',
    estimate_data: {
      operatorPriceAdjustment: { waiveSetupFee: true, reason: 'promo' },
      sendSnapshot: {
        renderedAt: '2026-08-30T12:00:00Z',
        pricingBundle: {
          manualDiscount: { amount: 10, kind: 'flat' },
          firstVisitFees: [{ service: 'waveguard_setup', price: 99, priceAfterDiscount: 0 }],
        },
      },
      engineRequest: {
        options: { cadence: 'quarterly', termiteOwnership: 'owner' },
        selectedServices: ['pest_control', 'lawn_care'],
        profile: {
          homeSqFt: 2000,
          lotSqFt: 8000,
          measuredTurfSf: 4500,
          stories: 1,
          propertyDataQuality: 'high',
          dataSources: { turf: 'measured' },
          fieldVerifyFlags: [{ field: 'pool', priority: 'LOW', reason: 'x' }],
        },
      },
      result: {
        marginWarnings: [{ service: 'lawn_care', message: 'thin' }],
        recurring: {
          tier: 'gold',
          discount: 0.15,
          savings: 216,
          services: [
            {
              service: 'lawn_care', name: 'Lawn Care', mo: 48, monthly: 48,
              tier: 'enhanced', cadence: 'every_6_weeks', visitsPerYear: 9, perTreatment: 64,
              floorPa: 55, floorAnn: 495, floorMo: 41.25,
              waveGuardDiscountEligible: true, countsTowardWaveGuardTier: true,
            },
          ],
        },
        oneTime: {
          items: [{ service: 'flea_treatment', name: 'Flea Treatment', price: 150, setupCharge: 25, taxable: true }],
          specItems: [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 75, quoteRequired: false }],
          membershipFee: 99,
        },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.inserted.length = 0;
  mockState.hasTable = false; // inventory tables absent → COGS degrades, audit still builds
});

describe('buildEstimatePricingAudit v2 quote provenance', () => {
  test('the quote block freezes discount, setup, property, and margin-warning provenance', async () => {
    const audit = await buildEstimatePricingAudit(fixtureEstimate());
    expect(audit.auditVersion).toBe(2);
    expect(audit.quote).toMatchObject({
      renderedAt: '2026-08-30T12:00:00Z',
      source: 'manual',
      leadSource: 'google',
      discount: { waveguardTier: 'gold', rate: 0.15, savingsAnnual: 216, manualDiscount: { amount: 10, kind: 'flat' } },
      setupFee: {
        membershipFee: 99,
        waived: true,
        firstVisitFees: [{ service: 'waveguard_setup', price: 99, priceAfterDiscount: 0 }],
      },
      operatorAdjustment: { waiveSetupFee: true, reason: 'promo' },
      property: {
        homeSqFt: 2000,
        lotSqFt: 8000,
        measuredTurfSf: 4500,
        stories: 1,
        propertyDataQuality: 'high',
      },
    });
    // The customer-shown bundle is frozen VERBATIM — never re-derived.
    expect(audit.quote.pricingBundle).toEqual(fixtureEstimate().estimate_data.sendSnapshot.pricingBundle);
    expect(audit.quote.property.fieldVerifyFlags).toEqual([{ field: 'pool', priority: 'LOW', reason: 'x' }]);
    expect(audit.quote.marginWarnings).toEqual([{ service: 'lawn_care', message: 'thin' }]);
    // Admin V2 request choices freeze verbatim too.
    expect(audit.quote.request).toEqual({
      options: { cadence: 'quarterly', termiteOwnership: 'owner' },
      selectedServices: ['pest_control', 'lawn_care'],
      inputs: null,
      services: null,
      priorQualifyingServices: null,
    });
  });

  test('per-line quoted passthroughs survive on recurring, one-time, and spec lines', async () => {
    const audit = await buildEstimatePricingAudit(fixtureEstimate());
    const lawn = audit.lines.find((l) => l.serviceKey === 'lawn_care');
    expect(lawn.quoted).toMatchObject({
      tier: 'enhanced', cadence: 'every_6_weeks', visitsPerYear: 9, perTreatment: 64,
      floorPa: 55, floorAnn: 495, floorMo: 41.25,
      waveGuardDiscountEligible: true, countsTowardWaveGuardTier: true,
    });
    const flea = audit.lines.find((l) => l.serviceKey === 'flea_treatment');
    expect(flea.quoted).toMatchObject({ setupCharge: 25, taxable: true });
    const wdo = audit.lines.find((l) => l.serviceKey === 'wdo_inspection');
    expect(wdo.quoted).toMatchObject({ quoteRequired: false });
  });

  test('quote-wizard raw-engine shape: waiver, discount, and services still freeze', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-wiz', status: 'sent', source: 'quote_wizard',
      monthly_total: '95.00', annual_total: '1140.00', onetime_total: null,
      waveguard_tier: null,
      estimate_data: {
        setupFeeQuote: { amount: 0, waived: true, reason: 'existing_member' },
        services: { pestControl: { frequencyKey: 'quarterly' }, mosquito: true },
        engineInput: { homeSqFt: 2100, measuredTurfSf: 5200, services: { lawn: { track: 'B' } } },
        priorQualifyingServices: [{ service: 'pest_control', mode: 'recurring' }],
        engineResult: {
          waveGuard: { tier: 'silver', discount: 0.1 },
          summary: { waveGuardSavings: 114 },
        },
      },
    });
    // The normalized priced input outranks the raw shapes for property
    // dimensions AND the verbatim freeze.
    expect(audit.quote.property.homeSqFt).toBe(2100);
    expect(audit.quote.property.inputs).toEqual({ homeSqFt: 2100, measuredTurfSf: 5200, services: { lawn: { track: 'B' } } });
    expect(audit.dimensions.homeSqFt).toBe(2100);
    expect(audit.dimensions.lawnSqFt).toBe(5200); // measuredTurfSf is authoritative
    expect(audit.quote.setupFee.waived).toBe(true);
    expect(audit.quote.setupFee.setupFeeQuote).toEqual({ amount: 0, waived: true, reason: 'existing_member' });
    expect(audit.quote.discount).toMatchObject({ waveguardTier: 'silver', rate: 0.1, savingsAnnual: 114 });
    expect(audit.quote.request.services).toEqual({ pestControl: { frequencyKey: 'quarterly' }, mosquito: true });
    // The wizard's normalized, actually-priced input wins the inputs slot.
    expect(audit.quote.request.inputs).toEqual({ homeSqFt: 2100, measuredTurfSf: 5200, services: { lawn: { track: 'B' } } });
    // The prior-service tier basis freezes verbatim.
    expect(audit.quote.request.priorQualifyingServices).toEqual([{ service: 'pest_control', mode: 'recurring' }]);
  });

  test('wizard rows with ONLY engineResult.lineItems still produce audit lines', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-li', status: 'sent', source: 'quote_wizard',
      monthly_total: '110.00', annual_total: '1320.00', onetime_total: '150.00',
      estimate_data: {
        engineResult: {
          lineItems: [
            { service: 'pest_control', name: 'Pest Control', monthly: 55, annual: 660, annualBeforeDiscount: 733.33, tier: 'quarterly', pricingVersion: 'v2' },
            { service: 'lawn_care', name: 'Lawn Care', monthly: 55, annual: null, frequency: 9 },
            { service: 'flea_package', name: 'Flea Treatment', price: 150, monthly: null },
            { service: 'palm_injection', name: 'Palm Injection', monthly: 30, annual: 360, appsPerYear: 2 },
            // Unpriced manual-quote rows never become $0 lines.
            { service: 'commercial_pest', name: 'Commercial Pest', quoteRequired: true, monthly: null, price: null },
            { service: 'ghost_row', name: 'Ghost', monthly: null, annual: null, price: null, total: null },
            // Per-application-only pricing is a real witness (perApp × visits).
            { service: 'stinging_insect', name: 'Wasp Program', perApp: 95, visitsPerYear: 3, monthly: null, annual: null, price: null },
            // Commercial rows: authoritative annual COGS rides costs.total.
            { service: 'commercial_lawn', name: 'Commercial Turf Program', monthly: 400, annual: 4800, costs: { total: 1900 } },
            // MAPPED residential rows also expose costs.total — inventory
            // COGS stays live for them, never the frozen engine figure.
            { service: 'tree_shrub', name: 'Tree & Shrub Program', monthly: 45, annual: 540, costs: { total: 200 } },
            // Termite specialties keep their raw id (honest unmapped beats
            // a bait-COGS mislabel), and adjustment rows skip COGS.
            { service: 'termite_foam', name: 'Termite Foam Treatment', price: 300, monthly: null },
            { service: 'rodent_bundle_discount', name: 'Rodent trap bundle', price: -50, monthly: null },
            // Manual discount lands ONLY in manualFinalAnnual — the audited
            // monthly must derive from it, not the stale monthlyAfterDiscount.
            { service: 'tree_shrub', name: 'Tree & Shrub', monthly: 40, monthlyAfterDiscount: 40, annual: 480, manualFinalAnnual: 420 },
            // RAW agent shape: gross annual, net in annualAfterDiscount.
            { service: 'mosquito', name: 'Mosquito', monthly: 80, monthlyAfterDiscount: 72, annual: 960, annualAfterDiscount: 864, visits: 12, program: 'precision', addOns: { stationCount: 3 } },
          ],
        },
      },
    });
    expect(audit.lines).toHaveLength(11); // quote-required + witness-less rows excluded
    expect(audit.lines.find((l) => l.serviceKey === 'stinging')).toMatchObject({ cadence: 'recurring', price: 285, visitsPerYear: 3 });
    expect(audit.lines.some((l) => /commercial_pest|ghost/.test(l.serviceKey))).toBe(false);
    expect(audit.lines.find((l) => l.serviceKey === 'termite_foam')).toBeTruthy(); // raw id kept
    const adj = audit.lines.find((l) => l.serviceKey === 'rodent_bundle_discount');
    expect(adj.cogs.status).toBe('not_applicable'); // adjustment rows never mint missing-COGS risk
    const ts = audit.lines.find((l) => l.serviceKey === 'tree_shrub' && l.quoted?.manualFinalAnnual === 420);
    expect(ts).toMatchObject({ price: 420, monthly: 35, priceBeforeDiscount: 480 });
    const cl = audit.lines.find((l) => l.serviceKey === 'commercial_lawn');
    expect(cl.cogs.estimatedCost).toBe(1900); // persisted commercial COGS, not unmapped-zero
    const tsRow = audit.lines.find((l) => /Program/.test(l.label) && l.serviceKey === 'tree_shrub');
    expect(tsRow.cogs.status).not.toBe('explicit'); // mapped services keep live inventory COGS
    const mq = audit.lines.find((l) => l.serviceKey === 'mosquito');
    // Net wins the price; gross survives as priceBeforeDiscount.
    expect(mq).toMatchObject({ price: 864, monthly: 72, priceBeforeDiscount: 960, discount: 0.1 });
    expect(mq.cogsServiceTypes).toEqual(expect.arrayContaining(['Mosquito Treatment - Stations']));
    expect(mq.cogsServiceTypeFixedMultipliers).toMatchObject({ 'Mosquito Treatment - Stations': 3 });
    const lawnLine = audit.lines.find((l) => l.serviceKey === 'lawn_care');
    expect(lawnLine.price).toBe(660); // annual:null falls through to monthly*12, never 0
    expect(lawnLine.visitsPerYear).toBe(9); // numeric frequency counts as cadence
    const palm = audit.lines.find((l) => l.serviceKey === 'palm_injection');
    expect(palm.visitsPerYear).toBe(2); // appsPerYear reaches the COGS visit count
    expect(palm.quoted).toMatchObject({ appsPerYear: 2 });
    expect(palm.cogs.visitsPerYear).toBe(2);
    const pest = audit.lines.find((l) => l.serviceKey === 'pest_control');
    expect(pest).toMatchObject({ cadence: 'recurring', monthly: 55, price: 660, priceBeforeDiscount: 733.33, discount: 0.1, priceSource: 'saved_estimate.engineResult.lineItems' });
    expect(pest.quoted).toMatchObject({ pricingVersion: 'v2' });
    // Verified engine-id alias resolves to its COGS family.
    const flea = audit.lines.find((l) => /flea/.test(l.serviceKey));
    expect(flea).toMatchObject({ serviceKey: 'flea', cadence: 'one_time', price: 150 });
  });

  test('annual-only and zero-monthly rows stay recurring; ancillary result does not hide engineResult lines', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-anc', status: 'sent', monthly_total: '0.00', annual_total: '500.00', onetime_total: null,
      estimate_data: {
        result: { someAncillary: true }, // truthy result WITHOUT priced lines
        engineResult: {
          lineItems: [
            { service: 'termite_bait', name: 'Termite Bait', annual: 500, monthly: null, visits: 4 },
            { service: 'lawn_care', name: 'Lawn Care', monthly: 0, monthlyAfterDiscount: 0, annual: 0, visitsPerYear: 9 },
          ],
        },
      },
    });
    const bait = audit.lines.find((l) => l.serviceKey === 'termite_bait');
    expect(bait).toMatchObject({ cadence: 'recurring', price: 500 });
    expect(audit.lines.find((l) => l.serviceKey === 'lawn_care')).toMatchObject({ cadence: 'recurring', price: 0 });
  });

  test('an authored proposal replaces engine lines and freezes verbatim', async () => {
    const proposal = {
      enabled: true,
      taxRate: 0.07,
      buildings: [{ name: 'Warehouse A', lineItems: [{ description: 'Exterior pest program', frequency: 'quarterly', unitPrice: 200, quantity: 1, taxable: false }] }],
      programs: [{ label: 'Turf Treatment Program', service: 'lawn', pricePerApplication: 300, frequencyPerYear: 6, taxable: true }],
      correctiveWork: [{ label: 'Door sweep install', amount: 450, taxable: true }],
    };
    const audit = await buildEstimatePricingAudit({
      id: 'est-prop', status: 'sent', monthly_total: '350.00', annual_total: '4200.00', onetime_total: '450.00',
      estimate_data: {
        proposal,
        result: { recurring: { services: [{ name: 'Stale Engine Line', mo: 999 }] } },
      },
    });
    // Proposal itemization is authoritative — the stale engine line is gone.
    expect(audit.lines.some((l) => /stale/i.test(l.label))).toBe(false);
    // Program family decides the COGS key — never the marketing label.
    expect(audit.lines.find((l) => /turf/i.test(l.label))).toMatchObject({ serviceKey: 'lawn_care', cadence: 'recurring', price: 1800, visitsPerYear: 6 });
    // quantity scales the COGS visit count (folded into revenue already).
    expect(audit.lines.find((l) => /exterior pest/i.test(l.label)).quoted.quantity).toBe(1);
    // Quarterly building line annualizes by its FREQUENCY (200 × 4), not ×12
    // — and its COGS visit count matches the same occurrences.
    expect(audit.lines.find((l) => /exterior pest/i.test(l.label))).toMatchObject({ cadence: 'recurring', price: 800, visitsPerYear: 4 });
    expect(audit.lines.find((l) => /door sweep/i.test(l.label))).toMatchObject({ cadence: 'one_time', price: 450 });
    expect(audit.quote.proposal).toEqual(proposal);
  });

  test('an enabled-but-empty proposal falls through to the engine lines', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-empty-prop', status: 'sent', monthly_total: '55.00', annual_total: '660.00', onetime_total: null,
      estimate_data: {
        proposal: { enabled: true, buildings: [] },
        result: { recurring: { services: [{ name: 'Pest Control', mo: 55 }] } },
      },
    });
    expect(audit.lines.find((l) => l.serviceKey === 'pest_control')).toMatchObject({ price: 660 });
  });

  test('net row witnesses beat the generic tier discount; hybrid installation splits out', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-net', status: 'sent', monthly_total: '100.00', annual_total: '1200.00', onetime_total: '350.00',
      estimate_data: {
        result: {
          recurring: {
            discount: 0.1,
            services: [
              // Floor-capped: the row's own net outranks 12*mo*(1-discount).
              { name: 'Lawn Care', mo: 50, annualAfterDiscount: 570 },
            ],
          },
          oneTime: { items: [{ service: 'flea', name: 'Flea Treatment', price: 200, manualFinalOneTime: 150 }] },
        },
      },
    });
    const lawn = audit.lines.find((l) => l.serviceKey === 'lawn_care');
    expect(lawn).toMatchObject({ price: 570, monthly: 47.5, priceBeforeDiscount: 600, discount: 0.05 });
    const flea = audit.lines.find((l) => l.serviceKey === 'flea');
    expect(flea).toMatchObject({ price: 150, priceBeforeDiscount: 200, discount: 0.25 });

    const hybrid = await buildEstimatePricingAudit({
      id: 'est-hy', status: 'sent', monthly_total: '30.00', annual_total: '360.00', onetime_total: '900.00',
      estimate_data: {
        engineResult: {
          lineItems: [{ service: 'termite_bait', name: 'Termite Bait', monthly: 30, annual: 360, installation: { price: 900, totalCost: 320 } }],
        },
      },
    });
    const install = hybrid.lines.find((l) => l.serviceKey === 'termite_bait_installation');
    expect(install).toMatchObject({ cadence: 'one_time', price: 900 });
    // Persisted installation cost is authoritative — no phantom 100% margin.
    expect(install.cogs.estimatedCost).toBe(320);
    expect(install.margin).toBeCloseTo((900 - 320) / 900, 2);
  });

  test('mixed shapes merge: extra lineItems join mapped result lines without duplicates', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-mix', status: 'sent', monthly_total: '90.00', annual_total: '1080.00', onetime_total: '350.00',
      estimate_data: {
        result: { recurring: { services: [{ name: 'Pest Control', mo: 60 }] } },
        engineResult: {
          lineItems: [
            { service: 'pest_control', name: 'Pest Control', monthly: 60, annual: 720 }, // duplicate — dropped
            { service: 'rodent_trapping', name: 'Rodent Trapping', price: 350, monthly: null }, // extra — merged
          ],
        },
      },
    });
    expect(audit.lines.filter((l) => l.serviceKey === 'pest_control')).toHaveLength(1);
    expect(audit.lines.find((l) => l.serviceKey === 'rodent_trapping')).toMatchObject({ cadence: 'one_time', price: 350 });
  });

  test('same-key different-price lines are distinct charges, not duplicates', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-multi', status: 'sent', monthly_total: null, annual_total: null, onetime_total: '800.00',
      estimate_data: {
        engineResult: {
          lineItems: [
            { service: 'exclusion', name: 'Exclusion — Building A', price: 500, monthly: null },
            { service: 'exclusion', name: 'Exclusion — Building B', price: 300, monthly: null },
          ],
        },
      },
    });
    expect(audit.lines.filter((l) => l.serviceKey === 'exclusion')).toHaveLength(2);
  });

  test('waived setup fee never emits a phantom membership line; charged fee does', async () => {
    const base = (extraData) => ({
      id: 'est-fee', status: 'sent', monthly_total: '55.00', annual_total: '660.00', onetime_total: null,
      estimate_data: {
        engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest Control', monthly: 55, annual: 660, initialFee: 99 }] },
        ...extraData,
      },
    });
    const waived = await buildEstimatePricingAudit(base({ setupFeeQuote: { amount: 0, waived: 'existing_member' } }));
    expect(waived.lines.some((l) => l.serviceKey === 'waveguard_membership')).toBe(false);
    const charged = await buildEstimatePricingAudit(base({}));
    expect(charged.lines.find((l) => l.serviceKey === 'waveguard_membership')).toMatchObject({ price: 99 });
    // Frozen firstVisitFees rows are the authority when present.
    const frozenWaived = await buildEstimatePricingAudit(base({
      sendSnapshot: { pricingBundle: { firstVisitFees: [{ service: 'waveguard_setup', price: 99, priceAfterDiscount: 0 }] } },
    }));
    expect(frozenWaived.lines.some((l) => l.serviceKey === 'waveguard_membership')).toBe(false);
    // Production rows carry the fee as { amount } — a charged bundle emits.
    const frozenCharged = await buildEstimatePricingAudit(base({
      sendSnapshot: { pricingBundle: { firstVisitFees: [{ service: 'waveguard_setup', amount: 99 }] } },
    }));
    expect(frozenCharged.lines.find((l) => l.serviceKey === 'waveguard_membership')).toMatchObject({ price: 99 });
    // A DISCOUNTED frozen fee audits at the customer-shown amount, not raw initialFee.
    const frozenDiscounted = await buildEstimatePricingAudit(base({
      sendSnapshot: { pricingBundle: { firstVisitFees: [{ service: 'waveguard_setup', price: 99, priceAfterDiscount: 49 }] } },
    }));
    expect(frozenDiscounted.lines.find((l) => l.serviceKey === 'waveguard_membership')).toMatchObject({ price: 49 });
  });

  test('one-time engine packages honor their explicit visit count in COGS', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-visits', status: 'sent', monthly_total: null, annual_total: null, onetime_total: '750.00',
      estimate_data: {
        engineResult: {
          lineItems: [{ service: 'german_roach', name: 'German Roach Package', price: 750, total: 750, monthly: null, visits: 3 }],
        },
      },
    });
    const roach = audit.lines.find((l) => l.serviceKey === 'german_roach');
    expect(roach).toMatchObject({ cadence: 'one_time', price: 750 });
    // Three treatments' inventory goes out the door — not one unit's.
    expect(roach.cogs.visitsPerYear).toBe(3);
  });

  test('authored one-time quantity scales COGS units (revenue already folds it in)', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-qty', status: 'sent', monthly_total: null, annual_total: null, onetime_total: '2000.00',
      estimate_data: {
        proposal: {
          enabled: true,
          buildings: [{ name: 'Grove', lineItems: [{ description: 'Palm injection', frequency: 'one_time', unitPrice: 50, quantity: 40, taxable: false }] }],
        },
      },
    });
    const palms = audit.lines.find((l) => /palm injection/i.test(l.label));
    expect(palms).toMatchObject({ cadence: 'one_time', price: 2000 });
    expect(palms.cogs.visitsPerYear).toBe(40);
  });

  test('a frozen setup discount reprices the MAPPED membership row too', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-mapped-fee', status: 'sent', monthly_total: '55.00', annual_total: '660.00', onetime_total: '49.00',
      estimate_data: {
        sendSnapshot: { pricingBundle: { firstVisitFees: [{ service: 'waveguard_setup', price: 99, priceAfterDiscount: 49 }] } },
        result: { recurring: { services: [{ name: 'Pest Control', mo: 55 }] }, oneTime: { membershipFee: 99 } },
        engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest Control', monthly: 55, annual: 660, initialFee: 99 }] },
      },
    });
    // ONE membership row, at the customer-shown frozen amount — the raw
    // $49 row price-matches and is consumed instead of dropped.
    const fees = audit.lines.filter((l) => l.serviceKey === 'waveguard_membership');
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ price: 49, priceBeforeDiscount: 99 });
  });

  test('a structured one-time container in engineResult merges (not just lineItems)', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-alt-onetime', status: 'sent', monthly_total: '55.00', annual_total: '660.00', onetime_total: '500.00',
      estimate_data: {
        result: { recurring: { services: [{ name: 'Pest Control', mo: 55 }] } },
        engineResult: { oneTime: { items: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500 }] } },
      },
    });
    expect(audit.lines.find((l) => l.serviceKey === 'bed_bug')).toMatchObject({ cadence: 'one_time', price: 500 });
  });

  test('termite specialty twins dedupe: name-mapped bait row consumes the raw specialty id', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-foam', status: 'sent', monthly_total: '92.33', annual_total: '1108.00', onetime_total: null,
      estimate_data: {
        result: { recurring: { services: [{ name: 'Recurring Termite Foam Service', mo: 92.33, annualAfterDiscount: 1108 }] } },
        engineResult: {
          lineItems: [{ service: 'foam_recurring', name: 'Recurring Termite Foam Service', monthly: 92.33, annual: 1108, costs: { total: 240 } }],
        },
      },
    });
    // One charge, two spellings — the raw specialty row is consumed, and
    // its authoritative cost transfers instead of bait inventory COGS.
    const foamRows = audit.lines.filter((l) => /foam/i.test(l.label));
    expect(foamRows).toHaveLength(1);
    expect(foamRows[0].cogs.estimatedCost).toBe(240);
  });

  test('automated-lead engineInput feeds dimensions and frozen request inputs', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-lead', status: 'sent', monthly_total: '55.00', annual_total: '660.00', onetime_total: null,
      estimate_data: {
        automation: { draftEstimateAutomation: { engineInput: { homeSqFt: 2400, lotSqFt: 9000 } } },
        engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest Control', monthly: 55, annual: 660, visitsPerYear: 4 }] },
      },
    });
    expect(audit.quote.request.inputs).toMatchObject({ homeSqFt: 2400, lotSqFt: 9000 });
  });

  test('textual cadence translates to a visit count instead of the 4-visit default', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-cadence', status: 'sent', monthly_total: '60.00', annual_total: '720.00', onetime_total: null,
      estimate_data: {
        engineResult: {
          lineItems: [{ service: 'pest_control', name: 'Pest Control', monthly: 60, annual: 720, frequency: 'monthly' }],
        },
      },
    });
    expect(audit.lines.find((l) => l.serviceKey === 'pest_control').cogs.visitsPerYear).toBe(12);
  });

  test('every persisted priced-input shape resolves COGS dimensions', () => {
    // Admin builder: the request profile is the only input container.
    expect(dimensionsFrom({ engineRequest: { profile: { homeSqFt: 2600, lotSqFt: 10000, measuredTurfSf: 5200 } } }))
      .toMatchObject({ homeSqFt: 2600, lotSqFt: 10000, lawnSqFt: 5200 });
    // Automated lead draft: nested automation engineInput.
    expect(dimensionsFrom({ automation: { draftEstimateAutomation: { engineInput: { homeSqFt: 2400, lotSqFt: 9000 } } } }))
      .toMatchObject({ homeSqFt: 2400, lotSqFt: 9000 });
    // Wizard engineInput outranks the raw shapes.
    expect(dimensionsFrom({ engineInput: { homeSqFt: 1800 }, engineRequest: { profile: { homeSqFt: 9999 } } }))
      .toMatchObject({ homeSqFt: 1800 });
    // The canonical priced profile outranks the RAW admin form inputs —
    // arbitration/clamping can change dimensions between them.
    expect(dimensionsFrom({ inputs: { homeSqFt: 3100 }, engineRequest: { profile: { homeSqFt: 2600 } } }))
      .toMatchObject({ homeSqFt: 2600 });
  });

  test('operator-authored proposal text never picks a COGS family; persisted service + visits do', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-authored', status: 'sent', monthly_total: null, annual_total: null, onetime_total: '1050.00',
      estimate_data: {
        proposal: {
          enabled: true,
          buildings: [{ name: 'Main', lineItems: [] }],
          correctiveWork: [
            // Operator text — must stay honestly unmapped, not bait.
            { label: 'Termite Foam Renewal', amount: 600 },
            // Derived row with persisted canonical id + package count.
            { label: 'German Roach Cleanout — 3 Visit Program', amount: 450, service: 'german_roach', visits: 3 },
          ],
        },
      },
    });
    expect(audit.lines.find((l) => /foam renewal/i.test(l.label)).serviceKey).toBe('termite_foam_renewal');
    const roach = audit.lines.find((l) => /roach cleanout/i.test(l.label));
    expect(roach.serviceKey).toBe('german_roach');
    expect(roach.cogs.visitsPerYear).toBe(3);
  });

  test('dedupe transfers cost metadata from the consumed raw row', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-xfer', status: 'sent', monthly_total: '400.00', annual_total: '4800.00', onetime_total: null,
      estimate_data: {
        result: { recurring: { services: [{ name: 'Commercial Turf Treatment Program', mo: 400 }] } },
        engineResult: { lineItems: [{ service: 'commercial_lawn', name: 'Commercial Turf Program', monthly: 400, annual: 4800, costs: { total: 1900 } }] },
      },
    });
    const rows = audit.lines.filter((l) => /lawn/.test(l.serviceKey));
    expect(rows).toHaveLength(1); // one charge, two spellings — deduped
    expect(rows[0].cogs.estimatedCost).toBe(1900); // the raw row's cost survived the dedupe
  });

  test('stale-revision guard: same-cadence engine extras are consume-only', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-consume', status: 'sent', monthly_total: null, annual_total: null, onetime_total: '500.00',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'exclusion', name: 'Exclusion', price: 500 }] } },
        engineResult: {
          lineItems: [
            { service: 'exclusion', name: 'Exclusion — old rev A', price: 500, monthly: null }, // matches → enriches, no new line
            { service: 'exclusion', name: 'Exclusion — old rev B', price: 900, monthly: null }, // stale revision price — dropped
            // A cadence the mapped result never priced still merges (the
            // legitimate mixed shape).
            { service: 'pest_control', name: 'Pest Control', monthly: 55, annual: 660 },
          ],
        },
      },
    });
    expect(audit.lines.filter((l) => l.serviceKey === 'exclusion')).toHaveLength(1);
    expect(audit.lines.find((l) => l.serviceKey === 'pest_control')).toMatchObject({ cadence: 'recurring', price: 660 });
  });

  test('a measured ZERO turf survives — never falls through to an estimate', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-zero', status: 'sent', monthly_total: '60.00', annual_total: '720.00', onetime_total: null,
      estimate_data: {
        engineInput: { homeSqFt: 1500, measuredTurfSf: 0, estimatedTurfSf: 3000 },
        engineResult: { property: { estimatedTurfSf: 3000 } },
      },
    });
    expect(audit.dimensions.lawnSqFt).toBe(0);
  });

  test('markerless engineInputs (click-mint / v1 shape) still freeze the price-bearing property facts', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-3', status: 'sent', source: 'service_report_cta',
      monthly_total: '80.00', annual_total: '960.00', onetime_total: null,
      estimate_data: { engineInputs: { homeSqFt: 1800, lotSqFt: 6000, stories: 2 } },
    });
    expect(audit.quote.property).toMatchObject({ homeSqFt: 1800, lotSqFt: 6000, stories: 2 });
    // The full input object is frozen verbatim — whitelist-free.
    expect(audit.quote.property.inputs).toEqual({ homeSqFt: 1800, lotSqFt: 6000, stories: 2 });
    // Missing fields are null, never a fabricated 0.
    expect(audit.quote.property.measuredTurfSf).toBeNull();
  });

  test('a bare legacy payload builds without a crash and with null-safe provenance', async () => {
    const audit = await buildEstimatePricingAudit({
      id: 'est-2', status: 'sent', monthly_total: null, annual_total: null,
      onetime_total: null, estimate_data: {},
    });
    expect(audit.auditVersion).toBe(2);
    expect(audit.quote.discount.rate).toBe(0);
    expect(audit.quote.setupFee.waived).toBe(false);
    expect(audit.quote.property.fieldVerifyFlags).toBeNull();
    expect(audit.quote.property.inputs).toBeNull();
    expect(audit.quote.pricingBundle).toBeNull();
    expect(audit.lines).toEqual([]);
  });

  test('quotedFieldsFrom returns null for rows with nothing to freeze', () => {
    expect(quotedFieldsFrom({ name: 'X', mo: 5 })).toBeNull();
    expect(quotedFieldsFrom(undefined)).toBeNull();
  });
});

describe('saveEstimatePricingAuditSnapshot', () => {
  test('append-only insert carries the caller trigger and the v2 blob', async () => {
    mockState.hasTable = true;
    const row = await saveEstimatePricingAuditSnapshot(fixtureEstimate(), { trigger: 'group_send' });
    expect(row).toBeTruthy();
    expect(mockState.inserted).toHaveLength(1);
    expect(mockState.inserted[0]).toMatchObject({ estimate_id: 'est-1', trigger: 'group_send', pricing_version: 'v9.9-test' });
    const blob = JSON.parse(mockState.inserted[0].audit);
    expect(blob.auditVersion).toBe(2);
    expect(blob.quote.discount.waveguardTier).toBe('gold');
  });
});

// The two once-missing send paths are wired (source contract — resilient
// anchors on the trigger literals; the behavior itself is exercised by the
// unit tests above and the send-path suites' pricing-audit mocks).
describe('coverage: every delivery path snapshots', () => {
  const fs = require('fs');
  const path = require('path');
  test('group-sibling publication saves a group_send snapshot fail-soft', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-estimates.js'), 'utf8');
    // TWO call sites: the accepted-mid-publication branch (state stands)
    // and the normal published branch (send stands) — both fail-soft.
    const first = src.indexOf("trigger: 'group_send'");
    const second = src.indexOf("trigger: 'group_send'", first + 1);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(src.slice(first - 1200, second + 400)).toMatch(/pricing audit snapshot failed \(state stands\)/);
    expect(src.slice(first - 1200, second + 400)).toMatch(/pricing audit snapshot failed \(send stands\)/);
  });
  test('click-mint delivery saves a cta_mint snapshot after commit, fail-soft', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');
    const idx = src.indexOf("'cta_reuse_backfill' : 'cta_mint'");
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(idx - 1400, idx + 600)).toMatch(/pricing audit snapshot failed \(mint .* stands\)/);
  });
});
