// Commercial estimate glass parity (GATE_ESTIMATE_COMMERCIAL_GLASS) + the
// estimate-document render pin (GATE_ESTIMATE_DOC_PDF plumbing).
//
// Gates resolve ON in the test env (config/feature-gates.js: non-prod
// defaults), so these tests exercise the gated-on rendering; the gate-off
// path is the pre-existing suites' unchanged assertions.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { renderPage } = require('../routes/estimate-public');
const {
  signEstimateDocPin,
  verifyEstimateDocPin,
  estimateDocumentUrl,
} = require('../services/pdf/estimate-doc-pdf');

const AUTHORED_PROPOSAL = {
  enabled: true,
  title: 'Commercial Service Proposal',
  taxRate: 0.07,
  taxLabel: 'Sales tax',
  buildings: [{
    name: '600 Sample Plaza Dr',
    note: null,
    lineItems: [{
      description: 'Recurring service plan',
      quantity: 1,
      unitPrice: 120,
      frequency: 'quarterly',
      taxable: true,
    }],
  }],
};

const BASE_ESTIMATE = {
  status: 'sent',
  quoteRequired: true,
  customerName: 'Pat Example',
  address: '600 Sample Plaza Dr, Sarasota, FL 34299',
  monthlyTotal: 40.00,
  annualTotal: 480.00,
  onetimeTotal: 0,
  tier: 'Bronze',
};

describe('SSR commercial proposal card (GATE_ESTIMATE_COMMERCIAL_GLASS)', () => {
  test('authored proposal itemizes on-page: line items, totals, commercial inclusions', () => {
    const html = renderPage('proposal-card-token', BASE_ESTIMATE, { proposal: AUTHORED_PROPOSAL });
    expect(html).toContain('Recurring service plan');
    expect(html).toContain('First-year total');
    // 120 × 4 = 480.00 annual; the card itemizes the year total.
    expect(html).toContain('480.00');
    expect(html).toContain('What your commercial service includes');
    expect(html).toContain('No long-term contract');
    // The proposal hero copy still leads the page.
    expect(html).toContain('your formal proposal is ready');
  });

  test('commercial inclusions carry no residential guarantee claims', () => {
    const html = renderPage('proposal-claims-token', BASE_ESTIMATE, { proposal: AUTHORED_PROPOSAL });
    const included = html.slice(html.indexOf('What your commercial service includes'));
    const inclusionsBlock = included.slice(0, included.indexOf('</section>'));
    expect(inclusionsBlock).not.toMatch(/90-day/i);
    expect(inclusionsBlock).not.toMatch(/money-back/i);
    expect(inclusionsBlock).not.toMatch(/\$99/);
  });

  test('an enabled flag with no authored buildings renders no proposal card', () => {
    const html = renderPage('proposal-degenerate-token', BASE_ESTIMATE, { proposal: { enabled: true } });
    expect(html).not.toContain('What your commercial service includes');
    // The degenerate flag still gets the formal-proposal hero (pre-existing
    // behavior) — only the itemized card requires authored buildings.
    expect(html).toContain('your formal proposal is ready');
  });

  test('non-proposal estimates render no proposal card', () => {
    const html = renderPage('no-proposal-token', {
      ...BASE_ESTIMATE, quoteRequired: false, status: 'sent',
    }, {
      result: { recurring: { services: [{ name: 'Quarterly Pest Control', mo: 60, annual: 720 }] } },
    });
    expect(html).not.toContain('What your commercial service includes');
  });
});

describe('estimate document render pin', () => {
  const TOKEN = 'a'.repeat(64);
  const VALID_THROUGH = '2026-09-15T00:00:00.000Z';

  test('round-trips validThrough for the token it was signed for', () => {
    const pin = signEstimateDocPin(TOKEN, { validThrough: VALID_THROUGH });
    expect(pin).toBeTruthy();
    expect(verifyEstimateDocPin(pin, TOKEN)).toEqual({ validThrough: VALID_THROUGH });
  });

  test('rejects a pin presented for a different token', () => {
    const pin = signEstimateDocPin(TOKEN, { validThrough: VALID_THROUGH });
    expect(verifyEstimateDocPin(pin, 'b'.repeat(64))).toBeNull();
  });

  test('rejects garbage, absent, and unsignable inputs', () => {
    expect(verifyEstimateDocPin('not-a-jwt', TOKEN)).toBeNull();
    expect(verifyEstimateDocPin(null, TOKEN)).toBeNull();
    expect(signEstimateDocPin(TOKEN, { validThrough: 'not-a-date' })).toBeNull();
  });

  test('document URL always carries mode=pdf and a signed render pin', () => {
    // Every server-driven render is pinned — that signature is what lets
    // /:token/data suppress view side effects; a bare public ?mode=pdf
    // still counts as a customer view.
    const plain = estimateDocumentUrl(TOKEN);
    expect(plain).toContain(`/estimate/${TOKEN}?mode=pdf`);
    expect(plain).toContain('dpin=');
    const pinNoOverride = signEstimateDocPin(TOKEN);
    expect(verifyEstimateDocPin(pinNoOverride, TOKEN)).toEqual({ validThrough: null });
    const pinned = estimateDocumentUrl(TOKEN, { validThrough: VALID_THROUGH });
    expect(pinned).toContain('mode=pdf');
    expect(pinned).toContain('dpin=');
  });
});
