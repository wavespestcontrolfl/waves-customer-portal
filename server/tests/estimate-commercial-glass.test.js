// Commercial estimate glass parity (GATE_ESTIMATE_COMMERCIAL_GLASS) + the
// estimate-document render pin (GATE_ESTIMATE_DOC_PDF plumbing).
//
// Gates resolve ON in the test env (config/feature-gates.js: non-prod
// defaults), so these tests exercise the gated-on rendering; the gate-off
// path is the pre-existing suites' unchanged assertions.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Deterministic browser stand-in for the concurrency test: the real
// launchBrowser hangs or succeeds depending on whether Playwright is
// installed (it IS on CI), so the test controls a shared gate instead —
// parked renders hold their semaphore slots until the gate rejects.
jest.mock('../services/service-report/pdf-puppeteer', () => {
  const real = jest.requireActual('../services/service-report/pdf-puppeteer');
  let release;
  const gate = new Promise((resolve, reject) => { release = reject; });
  // Swallow the shared gate's rejection at definition time — every caller
  // attaches its own handler, but Node flags the bare promise otherwise.
  gate.catch(() => {});
  return {
    ...real,
    launchBrowser: jest.fn(() => gate),
    __releaseLaunchGate: () => release(new Error('mock launch failed')),
  };
});

const { renderPage } = require('../routes/estimate-public');
const {
  signEstimateDocPin,
  verifyEstimateDocPin,
  estimateDocumentUrl,
  renderEstimateDocumentPdf,
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
      description: 'Quarterly pest control — recurring service plan',
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
    expect(html).toContain('Quarterly pest control — recurring service plan');
    expect(html).toContain('First-year total');
    // 120 × 4 = 480.00 annual; the card itemizes the year total.
    expect(html).toContain('480.00');
    expect(html).toContain('What your commercial pest service includes');
    expect(html).toContain('No long-term contract');
    // The proposal hero copy still leads the page.
    expect(html).toContain('your formal proposal is ready');
  });

  test('commercial inclusions carry no residential guarantee claims', () => {
    const html = renderPage('proposal-claims-token', BASE_ESTIMATE, { proposal: AUTHORED_PROPOSAL });
    const included = html.slice(html.indexOf('What your commercial pest service includes'));
    const inclusionsBlock = included.slice(0, included.indexOf('</section>'));
    expect(inclusionsBlock).not.toMatch(/90-day/i);
    expect(inclusionsBlock).not.toMatch(/money-back/i);
    expect(inclusionsBlock).not.toMatch(/\$99/);
  });

  test('an enabled flag with no authored buildings renders no proposal card', () => {
    const html = renderPage('proposal-degenerate-token', BASE_ESTIMATE, { proposal: { enabled: true } });
    expect(html).not.toContain('What your commercial pest service includes');
    // The degenerate flag still gets the formal-proposal hero (pre-existing
    // behavior) — only the itemized card requires authored buildings.
    expect(html).toContain('your formal proposal is ready');
  });

  test('a non-pest commercial proposal renders its lines with NO pest inclusions or plan terms', () => {
    const termiteProposal = {
      ...AUTHORED_PROPOSAL,
      buildings: [{
        name: '600 Sample Plaza Dr',
        note: null,
        lineItems: [{
          description: 'Termite bait station monitoring',
          quantity: 1,
          unitPrice: 200,
          frequency: 'quarterly',
          taxable: false,
        }],
      }],
    };
    const html = renderPage('proposal-termite-token', BASE_ESTIMATE, { proposal: termiteProposal });
    // The line items still itemize…
    expect(html).toContain('Termite bait station monitoring');
    // …but the pest inclusions/terms stack stays out (truth-scope rule).
    expect(html).not.toContain('What your commercial pest service includes');
    expect(html).not.toContain('Tenant-reported pests handled between visits');
  });

  test('non-proposal estimates render no proposal card', () => {
    const html = renderPage('no-proposal-token', {
      ...BASE_ESTIMATE, quoteRequired: false, status: 'sent',
    }, {
      result: { recurring: { services: [{ name: 'Quarterly Pest Control', mo: 60, annual: 720 }] } },
    });
    expect(html).not.toContain('What your commercial pest service includes');
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

  test('render concurrency is bounded — excess renders throw busy for the pdfkit fallback', async () => {
    // Saturate the semaphore with renders parked inside the mocked browser
    // launch gate — the cap is what matters: the (cap+1)th caller must fail
    // FAST with the busy code, before any browser work.
    const cap = Math.max(1, Number(process.env.ESTIMATE_DOC_PDF_MAX_CONCURRENT || 2));
    const estimate = { token: 'c'.repeat(64) };
    const parked = Array.from({ length: cap }, () => renderEstimateDocumentPdf(estimate).catch((e) => e));
    // Slots are claimed synchronously before the first await, so the next
    // call sees a full house immediately.
    await expect(renderEstimateDocumentPdf(estimate)).rejects.toMatchObject({ code: 'estimate_doc_render_busy' });
    // Release the gate: the parked renders fail on the (mock) launch error,
    // never on the semaphore — and their slots free afterwards.
    require('../services/service-report/pdf-puppeteer').__releaseLaunchGate();
    const settled = await Promise.all(parked);
    for (const err of settled) expect(err.code).not.toBe('estimate_doc_render_busy');
  });

  test('fails closed when no signing secret is available — never an unpinned render URL', () => {
    const savedDoc = process.env.ESTIMATE_DOC_PIN_SECRET;
    const savedJwt = process.env.JWT_SECRET;
    delete process.env.ESTIMATE_DOC_PIN_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => estimateDocumentUrl(TOKEN)).toThrow(/cannot be signed/);
      expect(signEstimateDocPin(TOKEN)).toBeNull();
    } finally {
      if (savedDoc !== undefined) process.env.ESTIMATE_DOC_PIN_SECRET = savedDoc;
      if (savedJwt !== undefined) process.env.JWT_SECRET = savedJwt;
    }
  });

  test('render errors are sanitized before logging — no bearer token, dpin, or hex runs', () => {
    const { sanitizeRenderError } = require('../services/pdf/estimate-doc-pdf');
    const token = 'ab'.repeat(32);
    const msg = `page.goto: net::ERR_FAILED at https://portal.internal/estimate/${token}?mode=pdf&dpin=deadbeef1234deadbeef1234.99999 (30s timeout)`;
    const out = sanitizeRenderError(new Error(msg));
    expect(out).not.toContain(token);
    expect(out).not.toContain('dpin=');
    expect(out).not.toContain('deadbeef1234deadbeef1234');
    expect(out).toContain('/estimate/[redacted-token]');
    expect(out).toContain('ERR_FAILED');
    // Bounded — a giant browser stack can't flood the log line.
    expect(sanitizeRenderError(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(300);
    // Non-Error inputs degrade safely.
    expect(sanitizeRenderError(null)).toBe('');
  });
});
