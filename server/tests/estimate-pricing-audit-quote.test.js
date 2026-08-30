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
              tier: 'enhanced', visitsPerYear: 9, perTreatment: 64,
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
    expect(audit.quote.property.fieldVerifyFlags).toEqual([{ field: 'pool', priority: 'LOW', reason: 'x' }]);
    expect(audit.quote.marginWarnings).toEqual([{ service: 'lawn_care', message: 'thin' }]);
  });

  test('per-line quoted passthroughs survive on recurring, one-time, and spec lines', async () => {
    const audit = await buildEstimatePricingAudit(fixtureEstimate());
    const lawn = audit.lines.find((l) => l.serviceKey === 'lawn_care');
    expect(lawn.quoted).toMatchObject({
      tier: 'enhanced', visitsPerYear: 9, perTreatment: 64,
      floorPa: 55, floorAnn: 495, floorMo: 41.25,
      waveGuardDiscountEligible: true, countsTowardWaveGuardTier: true,
    });
    const flea = audit.lines.find((l) => l.serviceKey === 'flea_treatment');
    expect(flea.quoted).toMatchObject({ setupCharge: 25, taxable: true });
    const wdo = audit.lines.find((l) => l.serviceKey === 'wdo_inspection');
    expect(wdo.quoted).toMatchObject({ quoteRequired: false });
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
    const idx = src.indexOf("trigger: 'group_send'");
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(idx - 900, idx + 400)).toMatch(/pricing audit snapshot failed \(send stands\)/);
  });
  test('click-mint delivery saves a cta_mint snapshot after commit, fail-soft', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');
    const idx = src.indexOf("trigger: 'cta_mint'");
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(idx - 900, idx + 400)).toMatch(/pricing audit snapshot failed \(mint .* stands\)/);
  });
});
