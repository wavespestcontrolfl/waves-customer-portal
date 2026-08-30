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
    const idx = src.indexOf("trigger: 'cta_mint'");
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(idx - 900, idx + 400)).toMatch(/pricing audit snapshot failed \(mint .* stands\)/);
  });
});
