process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GET /:token/data projects the authored proposal field-by-field for the
// on-page glass render and the headless document. The reviewed unit label is
// part of the documented public contract (docs/public-route-contracts.md):
// without it a 14,768 sq ft × $0.0755 line renders as a bare number (GH codex
// P0 on #4305).
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((gate) => gate === 'estimateCommercialGlass' || gate === 'estimateDocPdf'),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({ enforced: false, required: false, slotRequired: false }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotIn: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    // dbRows.__update(row): a per-test hook for the served-evidence write
    // (returns the affected-row count; may mutate dbRows to simulate a race).
    update: jest.fn(async () => (typeof dbRows.__update === 'function' ? dbRows.__update(result) : 1)),
    insert: jest.fn().mockResolvedValue([1]),
    then: undefined,
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

const PROPOSAL = {
  enabled: true,
  title: 'Commercial Service Proposal',
  buildings: [{
    name: 'Synthetic slab',
    lineItems: [
      { description: 'Slab perimeter treatment', quantity: 14768, unit: 'sqft', unitPrice: 0.0755, frequency: 'quarterly', taxable: false },
      { description: 'Inspection', quantity: 1, unitPrice: 95, frequency: 'one_time', taxable: false },
    ],
  }],
};

function estimateRow() {
  return {
    id: 'est-unit-projection', token: 'unitprojectiontoken', status: 'sent', sent_at: null, viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: 'Bronze', bill_by_invoice: false,
    monthly_total: 0, annual_total: 4459.16, onetime_total: 95,
    estimate_data: { proposal: PROPOSAL },
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

describe('GET /:token/data — proposal line projection', () => {
  beforeEach(() => { dbRows = { estimates: estimateRow() }; });

  test('projects the reviewed unit with the decimal quantity, rate and cent-rounded amount', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const lines = body.proposal.buildings[0].lineItems;
      expect(lines[0]).toMatchObject({ description: 'Slab perimeter treatment', quantity: 14768, unit: 'sqft', unitPrice: 0.0755, amount: 1114.98, frequency: 'quarterly' });
      // Unit-less lines do not grow a null field.
      expect(lines[1]).not.toHaveProperty('unit');
      expect(lines[1]).toMatchObject({ quantity: 1, unitPrice: 95, amount: 95 });
    });
  });

  test('document mode classifies retained disabled itemization independently of the ordinary current rows', async () => {
    dbRows.estimates = {
      ...estimateRow(),
      id: 'est-disabled-termite',
      monthly_total: 55,
      annual_total: 660,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: 'Pest Control', monthlyPrice: 55 }],
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 55 }] } },
        proposal: {
          enabled: false,
          buildings: [{
            name: 'Service location',
            note: 'Retained inspection scope',
            lineItems: [{ description: 'Termite trenching', unitPrice: 1200, frequency: 'one_time', taxable: false }],
          }],
        },
      },
    };

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      expect(res.status).toBe(200);
      const body = await res.json();

      // The ordinary page policy still sees current pest pricing. Document
      // mode carries its own explicit verdict for the different normalized
      // rows it renders.
      expect(body.estimate).not.toHaveProperty('noGuaranteeClaims');
      expect(body.proposal.noGuaranteeClaims).toBe(true);
      // Termite work: no rate-review disclosure either (explicit boolean).
      expect(body.proposal.rateReviewTermsEligible).toBe(false);
      expect(body.proposal.enabled).toBe(false);
      expect(body.proposal.synthesized).toBe(false);
      expect(body.proposal.buildings[0]).toMatchObject({
        name: 'Service location',
        note: 'Retained inspection scope',
      });
      expect(body.proposal.buildings[0].lineItems).toEqual([
        expect.objectContaining({ description: 'Termite trenching', unitPrice: 1200, amount: 1200 }),
      ]);
      expect(body.documentRender).toBe(true);
    });
  });

  // codex #5434 r1 P1: the document's rate-review decision is the SERVER's
  // (proposalRateReviewTermsEligible), projected explicitly so the browser
  // renderer never re-classifies a row description with its own taxonomy —
  // "Ornamental Care Program" is tree & shrub work here and nothing to the
  // client's glassServiceSlug.
  test.each([
    ['an ornamental (tree & shrub) program the client cannot classify by name', 'Ornamental Care Program', 'tree_shrub', true],
    ['a rodent program', 'Rodent Bait Stations', 'rodent_bait', false],
  ])('document mode projects rateReviewTermsEligible for %s', async (_name, description, service, eligible) => {
    dbRows.estimates = {
      ...estimateRow(),
      id: `est-rate-review-${eligible}`,
      monthly_total: 85,
      annual_total: 1020,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: description, monthlyPrice: 85 }],
        result: { recurring: { services: [{ service, name: description, mo: 85 }] } },
        proposal: {
          enabled: false,
          buildings: [{
            name: 'Service location',
            lineItems: [{ description, unitPrice: 85, frequency: 'monthly', taxable: false }],
          }],
        },
      },
    };

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.documentRender).toBe(true);
      expect(body.proposal.rateReviewTermsEligible).toBe(eligible);
      expect(body.proposal.buildings[0].lineItems[0]).toMatchObject({
        description,
        termsScope: eligible ? 'all' : 'satisfaction',
      });
    });
  });

  test('document mode with GATE_ESTIMATE_DOC_PDF off renders no document and records no served evidence (codex local max-effort review on #5434)', async () => {
    const gates = require('../config/feature-gates');
    gates.isEnabled.mockImplementation((gate) => gate === 'estimateCommercialGlass');
    dbRows.estimates = {
      ...estimateRow(),
      id: 'est-rate-review-gate-off',
      sent_at: '2026-09-20T12:00:00.000Z',
      viewed_at: '2026-09-21T12:00:00.000Z',
      monthly_total: 85,
      annual_total: 1020,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: 'Ornamental Care Program', monthlyPrice: 85 }],
        result: { recurring: { services: [{ service: 'tree_shrub', name: 'Ornamental Care Program', mo: 85 }] } },
        proposal: {
          enabled: false,
          buildings: [{ name: 'Service location', lineItems: [{ description: 'Ornamental Care Program', unitPrice: 85, frequency: 'monthly', taxable: false }] }],
        },
      },
    };
    let writes = 0;
    dbRows.__update = () => { writes += 1; return 1; };
    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.documentRender).toBeUndefined();
        expect(writes).toBe(0);
      });
    } finally {
      dbRows.__update = null;
      gates.isEnabled.mockImplementation((gate) => gate === 'estimateCommercialGlass' || gate === 'estimateDocPdf');
    }
  });

  test('a signed-pin headless pass (the /pdf route\'s or the admin\'s capture) never writes served evidence — only a customer-facing render does (codex local review on #5434)', async () => {
    const { signEstimateDocPin } = require('../services/pdf/estimate-doc-pdf');
    dbRows.estimates = {
      ...estimateRow(),
      id: 'est-rate-review-pinned',
      // A customer-reachable row (sent, already opened): the counter's
      // definition of a customer view gates the evidence write.
      sent_at: '2026-09-20T12:00:00.000Z',
      viewed_at: '2026-09-21T12:00:00.000Z',
      monthly_total: 85,
      annual_total: 1020,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: 'Ornamental Care Program', monthlyPrice: 85 }],
        result: { recurring: { services: [{ service: 'tree_shrub', name: 'Ornamental Care Program', mo: 85 }] } },
        proposal: {
          enabled: false,
          buildings: [{ name: 'Service location', lineItems: [{ description: 'Ornamental Care Program', unitPrice: 85, frequency: 'monthly', taxable: false }] }],
        },
      },
    };
    let writes = 0;
    dbRows.__update = () => { writes += 1; return 1; };
    try {
      await withServer(async (baseUrl) => {
        const pin = signEstimateDocPin('unitprojectiontoken');
        const pinned = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf&dpin=${encodeURIComponent(pin)}`);
        expect(pinned.status).toBe(200);
        const body = await pinned.json();
        expect(body.documentRender).toBe(true);
        expect(body.proposal.rateReviewTermsEligible).toBe(true);
        expect(writes).toBe(0);
        // The same customer-facing (unpinned) pass does write.
        const bare = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
        expect(bare.status).toBe(200);
        expect(writes).toBe(1);
        // A non-customer request (bot / unfurler UA — the view the counter
        // ignores) never records evidence (local max-effort review on #5434).
        const bot = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`, { headers: { 'User-Agent': 'Twitterbot/1.0' } });
        expect(bot.status).toBe(200);
        expect(writes).toBe(1);
      });
    } finally {
      dbRows.__update = null;
    }
  });

  test('document mode: a row that freezes between the read and the evidence write restarts the payload from the frozen row (pre-push Codex on #5434)', async () => {
    dbRows.estimates = {
      ...estimateRow(),
      id: 'est-rate-review-race',
      sent_at: '2026-09-20T12:00:00.000Z',
      viewed_at: '2026-09-21T12:00:00.000Z',
      monthly_total: 85,
      annual_total: 1020,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: 'Ornamental Care Program', monthlyPrice: 85 }],
        result: { recurring: { services: [{ service: 'tree_shrub', name: 'Ornamental Care Program', mo: 85 }] } },
        proposal: {
          enabled: false,
          buildings: [{ name: 'Service location', lineItems: [{ description: 'Ornamental Care Program', unitPrice: 85, frequency: 'monthly', taxable: false }] }],
        },
      },
    };
    let writes = 0;
    dbRows.__update = () => {
      writes += 1;
      // The accept from another tab committed first: the guarded evidence
      // UPDATE matches nothing and the row is now accepted (no stamp).
      dbRows.estimates = { ...dbRows.estimates, status: 'accepted', price_locked_at: '2026-10-01T06:00:00.000Z' };
      return 0;
    };
    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(writes).toBe(1);
        // Composed from the frozen row, not the stale open snapshot.
        expect(body.estimate.status).toBe('accepted');
        expect(body.proposal.rateReviewTermsEligible).toBe(false);
      });
    } finally {
      dbRows.__update = null;
    }
  });

  // codex #5434 r2 P1: a frozen (accepted) document keeps the terms the
  // customer saw — the projected decision is true only when the recorded
  // acceptance carried the sentence.
  test.each([
    ['no acceptance snapshot carrying the sentence', 'Accepting authorizes these services at the price shown.\nServices — at the price and frequency shown, until you cancel. No contract.', false],
    ['a plan acceptance snapshot carrying the sentence', `Accepting authorizes these services at the price shown.\nServices — at the price and frequency shown, until you cancel. No contract. ${require('../services/acceptance-terms-text').RATE_REVIEW_SENTENCE}`, true],
  ])('an ACCEPTED pest plan with %s projects rateReviewTermsEligible=%s', async (_name, termsText, expected) => {
    dbRows.estimates = {
      ...estimateRow(),
      id: 'est-accepted-pest',
      status: 'accepted',
      terms_version: 'v2026-10',
      monthly_total: 55,
      annual_total: 660,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: 'Pest Control', monthlyPrice: 55 }],
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 55 }] } },
        proposal: {
          enabled: false,
          buildings: [{ name: 'Service location', lineItems: [{ description: 'Pest Control', unitPrice: 55, frequency: 'monthly', taxable: false }] }],
        },
      },
    };
    dbRows.estimate_acceptances = { id: 'acc-1', estimate_id: 'est-accepted-pest', terms_version: 'v2026-10', terms_text: termsText, accepted_at: '2026-09-30T20:00:00Z', ip: '203.0.113.9', user_agent: 'jest' };

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.proposal.rateReviewTermsEligible).toBe(expected);
      expect(body.acceptance?.termsText).toBe(termsText);
    });
  });

  test('a one-time-only document never carries the rate-review decision as true', async () => {
    dbRows.estimates = {
      ...estimateRow(),
      id: 'est-rate-review-one-time',
      sent_at: '2026-09-20T12:00:00.000Z',
      viewed_at: '2026-09-21T12:00:00.000Z',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 150,
      estimate_data: {
        result: {
          recurring: { services: [] },
          oneTime: { items: [{ service: 'pest_one_time', name: 'One-Time Pest Control', price: 150 }], membershipFee: 0 },
        },
        proposal: {
          enabled: false,
          buildings: [{
            name: 'Service location',
            lineItems: [{ description: 'One-Time Pest Control', unitPrice: 150, frequency: 'one_time', taxable: false }],
          }],
        },
      },
    };

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.proposal.rateReviewTermsEligible).toBe(false);
    });
  });
});
