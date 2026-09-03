// The composer's per-customer link builders: pay-balance anchor selection
// across account siblings (oldest open invoice wins; incomplete reads
// suppress the amount, never understate it), the estimate pick honoring
// isEstimateCustomerViewable, and the review builder's already-reviewed
// short-circuit. Route-level resolution is covered by
// admin-communications-customer-link.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (longUrl) => longUrl),
  invoiceShortCodePrefix: jest.fn(() => 'wpc-test'),
}));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/pay-combined', () => ({
  combinedEligibleSiblings: jest.fn(async () => null),
  amountDueCents: jest.fn((inv) => Math.round((inv.amount_due ?? 0) * 100)),
}));
jest.mock('../services/referral-engine', () => ({
  enrollPromoter: jest.fn(),
  getLiveSettings: jest.fn(async () => ({ program_active: true })),
}));
jest.mock('../routes/estimate-public', () => ({ isEstimateCustomerViewable: jest.fn() }));
jest.mock('../services/autopay-setup-link', () => ({ requestAutopaySetupLink: jest.fn(), setupLinkIneligibility: jest.fn(), KIND: 'customer' }));
// Only the Auto Pay customer-SMS gate reads true — every other gate (the
// pricing-authority send gate the estimate builder consults) stays off.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((g) => g === 'autopayCustomerSms') }));
jest.mock('../services/appointment-card-request', () => ({ renderTemplate: jest.fn() }));
jest.mock('../services/review-request', () => ({
  createInline: jest.fn(),
  checkUnscheduledAskGates: jest.fn(async () => ({ allowed: true })),
}));
// The builder runs gate+mint under the review advisory lock — run the body
// inline; the skipped path is exercised explicitly.
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, fn) => fn()) }));

let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

const { openBalanceSummary } = require('../services/open-balance');
const { combinedEligibleSiblings } = require('../services/pay-combined');
const { enrollPromoter, getLiveSettings } = require('../services/referral-engine');
const { isEstimateCustomerViewable } = require('../routes/estimate-public');
const { requestAutopaySetupLink, setupLinkIneligibility } = require('../services/autopay-setup-link');
const { isEnabled } = require('../config/feature-gates');
const { renderTemplate } = require('../services/appointment-card-request');
const ReviewService = require('../services/review-request');
const {
  buildPayBalanceLink,
  buildLatestEstimateLink,
  buildReviewRequestLink,
  buildReferralLink,
  buildAutopaySetupLink,
  autopayLinkSendCheck,
} = require('../services/composer-customer-links');

function chainBuilder({ firstRow = null, rows = [] } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereIn = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.join = jest.fn(() => b);
  b.orderBy = jest.fn(() => b);
  b.offset = jest.fn(() => b);
  b.limit = jest.fn(async () => rows);
  b.first = jest.fn(async () => firstRow);
  b.update = jest.fn(async () => 1);
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockClear();
});

describe('buildPayBalanceLink', () => {
  test('anchors on the oldest open invoice across siblings, amount scoped to the anchor customer', async () => {
    openBalanceSummary
      .mockResolvedValueOnce({
        total: 100,
        count: 1,
        invoices: [{ id: 'inv-new', due_date: '2026-08-20', created_at: '2026-08-01' }],
      })
      .mockResolvedValueOnce({
        total: 84,
        count: 1,
        invoices: [{ id: 'inv-old', due_date: '2026-07-01', created_at: '2026-06-15' }],
      });
    mockBuilders = {
      invoices: chainBuilder({ firstRow: { id: 'inv-old', token: 'tok-old', customer_id: 'c2', amount_due: 84 } }),
    };

    const r = await buildPayBalanceLink(['c1', 'c2']);
    expect(r.url).toContain('/pay/tok-old');
    expect(r.line).toContain(r.url);
    // NOT 184/2: combinedEligibleSiblings answered null (combined flow won't
    // engage), so the figure is the anchor invoice alone — exactly what the
    // linked page will display and charge.
    expect(r.balance).toEqual({ total: 84, count: 1 });
    expect(combinedEligibleSiblings).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-old' }));
  });

  test('the figure includes exactly the siblings the pay page will itemize', async () => {
    openBalanceSummary.mockResolvedValueOnce({
      total: 200,
      count: 3,
      invoices: [{ id: 'inv-a', due_date: '2026-07-01', created_at: '2026-06-15' }],
    });
    mockBuilders = {
      invoices: chainBuilder({ firstRow: { id: 'inv-a', token: 'tok-a', customer_id: 'c1', amount_due: 84 } }),
    };
    // Combined flow engages with ONE eligible sibling — the third open
    // invoice (stopped dunning / owned by a live PI) must not be announced.
    combinedEligibleSiblings.mockResolvedValueOnce([{ id: 'inv-b', amount_due: 30 }]);

    const r = await buildPayBalanceLink(['c1']);
    expect(r.balance).toEqual({ total: 114, count: 2 });
  });

  test('an incomplete read keeps the link but suppresses the amount', async () => {
    openBalanceSummary.mockImplementationOnce(async (_id, { onResolveFailure }) => {
      onResolveFailure(new Error('payer resolve failed'));
      return { total: 50, count: 1, invoices: [{ id: 'inv-1', due_date: '2026-08-01', created_at: '2026-08-01' }] };
    });
    mockBuilders = {
      invoices: chainBuilder({ firstRow: { id: 'inv-1', token: 'tok-1', customer_id: 'c1' } }),
    };
    const r = await buildPayBalanceLink(['c1']);
    expect(r.url).toContain('/pay/tok-1');
    expect(r.balance).toBeNull();
  });

  test('no open balance answers a plain reason, not a link', async () => {
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, invoices: [] });
    const r = await buildPayBalanceLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No open balance/);
  });
});

describe('buildLatestEstimateLink', () => {
  test('skips newer rows the customer cannot view and links the first viewable one', async () => {
    const rows = [
      { id: 'e-new', token: 'tk-new', customer_id: 'c1', status: 'sent', service_type: 'Termite' },
      { id: 'e-ok', token: 'tk-ok', customer_id: 'c1', status: 'viewed', service_type: 'Quarterly Pest Control' },
    ];
    mockBuilders = { estimates: chainBuilder({ rows }) };
    isEstimateCustomerViewable.mockImplementation((row) => row.id === 'e-ok');

    const r = await buildLatestEstimateLink(['c1']);
    expect(r.url).toContain('/estimate/tk-ok');
    expect(r.estimate).toEqual({ id: 'e-ok', serviceType: 'Quarterly Pest Control', status: 'viewed' });
  });

  test('pages past a full page of hidden estimates to an older viewable one', async () => {
    const hidden = Array.from({ length: 15 }, (_, i) => ({ id: `h${i}`, token: `tkh${i}`, customer_id: 'c1', status: 'sent' }));
    const b = chainBuilder({});
    b.limit
      .mockResolvedValueOnce(hidden)
      .mockResolvedValueOnce([{ id: 'e-old', token: 'tk-old', customer_id: 'c1', status: 'sent', service_type: 'Pest' }]);
    mockBuilders = { estimates: b };
    isEstimateCustomerViewable.mockImplementation((row) => row.id === 'e-old');

    const r = await buildLatestEstimateLink(['c1']);
    expect(r.url).toContain('/estimate/tk-old');
    expect(b.offset).toHaveBeenCalledWith(15);
  });

  test('no viewable open estimate answers a plain reason', async () => {
    mockBuilders = { estimates: chainBuilder({ rows: [] }) };
    const r = await buildLatestEstimateLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No open estimate/);
  });
});

describe('buildReviewRequestLink', () => {
  test('already-reviewed customers short-circuit before any mint', async () => {
    mockBuilders = { customers: chainBuilder({ firstRow: { id: 'c1', has_left_google_review: true } }) };
    const r = await buildReviewRequestLink('c1');
    expect(r.url).toBeNull();
    expect(ReviewService.createInline).not.toHaveBeenCalled();
  });

  test('a successful inline mint returns the url, clause, and requestId', async () => {
    mockBuilders = { customers: chainBuilder({ firstRow: { id: 'c1', has_left_google_review: false } }) };
    ReviewService.createInline.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/l/rv123',
      requestId: 'rr-1',
      token: 'tok',
    });
    const r = await buildReviewRequestLink('c1');
    expect(r.url).toContain('/l/rv123');
    expect(r.requestId).toBe('rr-1');
    expect(r.line).toContain(r.url);
  });

  test('a gate-blocked customer gets the reason, not a mint', async () => {
    mockBuilders = { customers: chainBuilder({ firstRow: { id: 'c1', has_left_google_review: false } }) };
    ReviewService.checkUnscheduledAskGates.mockResolvedValueOnce({ allowed: false, outcome: 'cooldown' });
    const r = await buildReviewRequestLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/last 30 days/);
    expect(ReviewService.createInline).not.toHaveBeenCalled();
  });

  test('a held advisory lock answers a retry reason instead of minting past it', async () => {
    mockBuilders = { customers: chainBuilder({ firstRow: { id: 'c1', has_left_google_review: false } }) };
    const { runExclusive } = require('../utils/cron-lock');
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    const r = await buildReviewRequestLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/already being sent/);
    expect(ReviewService.createInline).not.toHaveBeenCalled();
  });

  test('mints WITHOUT arming the safety net — the composer send is the only delivery', async () => {
    mockBuilders = { customers: chainBuilder({ firstRow: { id: 'c1', has_left_google_review: false } }) };
    ReviewService.createInline.mockResolvedValue({ url: 'https://x/l/rv1', requestId: 'rr-1', token: 't' });

    const r = await buildReviewRequestLink('c1');
    expect(r.requestId).toBe('rr-1');
    expect(ReviewService.createInline).toHaveBeenCalledWith({ customerId: 'c1', armSafetyNet: false });
  });
});

describe('buildReferralLink', () => {
  test('a 23505 unique-phone conflict falls back to the account-scoped household promoter', async () => {
    // Multi-property sibling: another sibling's promoter row already owns
    // the shared phone — same fallback as the report referral endpoint.
    enrollPromoter.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    mockBuilders = {
      customers: chainBuilder({ firstRow: { id: 'c2', phone: '(941) 555-0184', account_id: 'acct-1' } }),
      'referral_promoters as rp': chainBuilder({
        firstRow: { id: 'p1', referral_code: 'WAVES-ABC12345', referral_link: 'https://portal.wavespestcontrol.com/r/WAVES-ABC12345' },
      }),
    };
    const r = await buildReferralLink('c2');
    expect(r.url).toContain('/r/WAVES-ABC12345');
    expect(r.line).toContain(r.url);
  });

  test('a non-conflict enroll failure answers the plain reason', async () => {
    enrollPromoter.mockRejectedValue(new Error('db down'));
    const r = await buildReferralLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/Could not build/);
  });

  test('an inactive program refuses before any enrollment', async () => {
    getLiveSettings.mockResolvedValueOnce({ program_active: false });
    const r = await buildReferralLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/not active/);
    expect(enrollPromoter).not.toHaveBeenCalled();
  });

  test('an unavailable settings read fails closed — no enrollment, no link', async () => {
    getLiveSettings.mockRejectedValueOnce(new Error('db down'));
    const r = await buildReferralLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/not active/);
    expect(enrollPromoter).not.toHaveBeenCalled();
  });
});

describe('buildAutopaySetupLink', () => {
  beforeEach(() => {
    requestAutopaySetupLink.mockReset();
    isEnabled.mockReset().mockImplementation((g) => g === 'autopayCustomerSms');
    // The seeded autopay_setup_link template row, active; the customer's
    // first name for the render.
    mockBuilders = {
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
      customers: chainBuilder({ firstRow: { first_name: 'Pat' } }),
    };
    renderTemplate.mockReset().mockImplementation(async (vars, key) => (
      key === 'autopay_setup_link'
        ? `Hi ${vars.first_name}! Set up Auto Pay here: ${vars.secure_link}\nNothing is charged today. Reply STOP to opt out.`
        : null
    ));
  });

  test('the customer-SMS gate is enforced before anything mints (the composer send is an SMS)', async () => {
    isEnabled.mockReturnValue(false);
    const r = await buildAutopaySetupLink('c1');
    expect(isEnabled).toHaveBeenCalledWith('autopayCustomerSms');
    expect(requestAutopaySetupLink).not.toHaveBeenCalled();
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/GATE_AUTOPAY_CUSTOMER_SMS/);
  });

  test.each([
    ['inactive row', { is_active: false }],
    ['missing row', null],
  ])('an %s autopay_setup_link template refuses before anything mints', async (_label, row) => {
    mockBuilders = { sms_templates: chainBuilder({ firstRow: row }) };
    const r = await buildAutopaySetupLink('c1');
    expect(requestAutopaySetupLink).not.toHaveBeenCalled();
    expect(r.reason).toMatch(/inactive in Templates/);
  });

  test('an unreadable template row fails closed', async () => {
    const b = chainBuilder();
    b.first = jest.fn(async () => { throw new Error('db down'); });
    mockBuilders = { sms_templates: b };
    const r = await buildAutopaySetupLink('c1');
    expect(requestAutopaySetupLink).not.toHaveBeenCalled();
    expect(r.url).toBeNull();
  });

  test('delegates inline to the single entry point and inserts the secure link', async () => {
    requestAutopaySetupLink.mockResolvedValue({
      requested: true, action: 'link_created', reason: 'created',
      secureUrl: 'https://portal.wavespestcontrol.com/secure/tok123', expiresAt: '2026-09-10T00:00:00.000Z',
    });
    const r = await buildAutopaySetupLink('c1');
    expect(requestAutopaySetupLink).toHaveBeenCalledWith({ customerId: 'c1', delivery: 'inline', trigger: 'admin' });
    expect(r.url).toBe('https://portal.wavespestcontrol.com/secure/tok123');
    // The reviewed SMS template IS the copy — rendered with the real link
    // and the customer's name, collapsed to one line (the composer strips
    // newline-delimited lines carrying the tracked URL on a recipient
    // change — the whole message must go with it), inserted as-is.
    expect(renderTemplate).toHaveBeenCalledWith({ first_name: 'Pat', secure_link: r.url }, 'autopay_setup_link');
    expect(r.line).toBe('Hi Pat! Set up Auto Pay here: https://portal.wavespestcontrol.com/secure/tok123 Nothing is charged today. Reply STOP to opt out.\n\n');
    expect(r.standalone).toBe(true);
  });

  test('a reused live row (request_exists) still inserts — same link, no second mint', async () => {
    requestAutopaySetupLink.mockResolvedValue({
      requested: true, action: 'link_created', reason: 'request_exists',
      secureUrl: 'https://portal.wavespestcontrol.com/secure/tok123',
    });
    const r = await buildAutopaySetupLink('c1');
    expect(r.url).toContain('/secure/tok123');
  });

  test('auto_secured is a successful outcome with nothing to insert, not a refusal', async () => {
    requestAutopaySetupLink.mockResolvedValue({ requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' });
    const r = await buildAutopaySetupLink('c1');
    expect(r.url).toBeNull();
    expect(r.autoSecured).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  test('a template edited to drop {secure_link} refuses — never setup copy with no link', async () => {
    requestAutopaySetupLink.mockResolvedValue({ requested: true, action: 'link_created', reason: 'created', secureUrl: 'https://portal.wavespestcontrol.com/secure/tok123' });
    renderTemplate.mockResolvedValue('Hi Pat! Set up Auto Pay today. Reply STOP to opt out.');
    const r = await buildAutopaySetupLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/no \{secure_link\} placeholder/);
  });

  test('a template that stops rendering between the lever probe and the mint refuses (no hand-written fallback copy)', async () => {
    requestAutopaySetupLink.mockResolvedValue({ requested: true, action: 'link_created', reason: 'created', secureUrl: 'https://portal.wavespestcontrol.com/secure/tok123' });
    renderTemplate.mockResolvedValue(null);
    const r = await buildAutopaySetupLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/inactive in Templates/);
  });

  test.each([
    ['gate_off', /GATE_AUTOPAY_SETUP_LINK/],
    ['payer_billed', /third-party payer/],
    ['autopay_already_active', /already on Auto Pay/],
    ['autopay_paused', /paused/],
    ['unsupported_billing_lane', /per-visit/],
    ['completion_in_progress', /finishing/],
    ['enrollment_refused:weird', /enrollment_refused:weird/],
  ])('skip %s answers a plain reason and no url', async (reason, expected) => {
    requestAutopaySetupLink.mockResolvedValue({ requested: false, action: 'skipped', reason });
    const r = await buildAutopaySetupLink('c1');
    expect(r.url).toBeNull();
    expect(r.line).toBe('');
    expect(r.reason).toMatch(expected);
  });
});

describe('autopayLinkSendCheck (delivery seam)', () => {
  const BODY = 'Set it up here: https://portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY';
  const live = { id: 'r1', kind: 'customer', status: 'pending', expires_at: new Date(Date.now() + 86400e3), customer_id: 'c1' };
  beforeEach(() => {
    isEnabled.mockReset().mockImplementation((g) => g === 'autopayCustomerSms');
  });
  function wire({ row, owner = { phone: '(941) 555-0184' }, template = { is_active: true } }) {
    mockBuilders = {
      appointment_card_requests: chainBuilder({ firstRow: row }),
      sms_templates: chainBuilder({ firstRow: template }),
    };
    setupLinkIneligibility.mockReset().mockResolvedValue({ reason: null, customer: owner });
  }

  test('no /secure link in the body → not present, no lookups', async () => {
    mockBuilders = {};
    expect(await autopayLinkSendCheck('Hi there, see you Tuesday', '9415550184')).toEqual({ present: false });
  });

  test('a live pending link owned by the recipient passes and hands back the token', async () => {
    wire({ row: live });
    const r = await autopayLinkSendCheck(BODY, '9415550184');
    expect(r).toEqual({ present: true, ok: true, tokens: ['abcDEF123_-xyz789QWERTY'] });
  });

  test.each([
    ['expired', { ...live, expires_at: new Date(Date.now() - 1000) }],
    ['already completed', { ...live, status: 'completed' }],
    ['unknown token', null],
  ])('an %s row refuses the send', async (_label, row) => {
    wire({ row });
    const r = await autopayLinkSendCheck(BODY, '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired or no longer live/);
  });

  test('the customer-SMS gate and template lever are re-checked at send time', async () => {
    wire({ row: live });
    isEnabled.mockImplementation(() => false);
    expect((await autopayLinkSendCheck(BODY, '9415550184')).error).toMatch(/GATE_AUTOPAY_CUSTOMER_SMS/);
    isEnabled.mockImplementation((g) => g === 'autopayCustomerSms');
    wire({ row: live, template: { is_active: false } });
    expect((await autopayLinkSendCheck(BODY, '9415550184')).error).toMatch(/inactive in Templates/);
  });

  test('a link owned by a different customer refuses the send', async () => {
    wire({ row: live, owner: { phone: '+19998887777' } });
    expect((await autopayLinkSendCheck(BODY, '9415550184')).error).toMatch(/different customer/);
  });

  test('/sms must trust the link owner as the recipient customer — an unresolved customer refuses', async () => {
    wire({ row: live });
    const r = await autopayLinkSendCheck(BODY, '9415550184', { trustedCustomerId: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/search dropdown/);
    expect((await autopayLinkSendCheck(BODY, '9415550184', { trustedCustomerId: 'c1' })).ok).toBe(true);
    expect((await autopayLinkSendCheck(BODY, '9415550184', { trustedCustomerId: 'c9' })).ok).toBe(false);
  });

  test('the mint\'s own eligibility is re-run at send — a customer gone payer-billed since the insert refuses', async () => {
    wire({ row: live });
    setupLinkIneligibility.mockResolvedValue({ reason: 'payer_billed' });
    const r = await autopayLinkSendCheck(BODY, '9415550184');
    expect(setupLinkIneligibility).toHaveBeenCalledWith('c1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/third-party payer/);
  });

  test('a real token on a look-alike host is not a Waves link — refused before any lookup', async () => {
    wire({ row: live });
    const r = await autopayLinkSendCheck('Set it up: https://evil.example/secure/abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not on the Waves portal/);
    expect(mockDb).not.toHaveBeenCalledWith('appointment_card_requests');
  });

  test('a canonical host nested under another host is not a Waves link either', async () => {
    wire({ row: live });
    const r = await autopayLinkSendCheck('Set it up: https://evil.example/portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not on the Waves portal/);
    // Same body with a second, canonical link: the foreign one still refuses.
    const r2 = await autopayLinkSendCheck('https://evil.example/portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY ' + BODY, '9415550184');
    expect(r2.ok).toBe(false);
  });

  test('a differently-cased /Secure/ path is still detected and judged', async () => {
    wire({ row: { ...live, expires_at: new Date(Date.now() - 1000) } });
    const r = await autopayLinkSendCheck('Set it up here: portal.wavespestcontrol.com/Secure/abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.present).toBe(true);
    expect(r.ok).toBe(false);
  });

  test('the scheme-stripped form the composer inserts is accepted', async () => {
    wire({ row: live });
    const r = await autopayLinkSendCheck('Set it up here: portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.ok).toBe(true);
  });

  test('a visit-lane card request on the same page is not reclassified', async () => {
    wire({ row: { ...live, kind: 'visit' } });
    expect(await autopayLinkSendCheck(BODY, '9415550184')).toEqual({ present: false });
  });

  test('every /secure token is judged — a visit link first does not shadow an Auto Pay link after it', async () => {
    const rows = {
      visitTOKENvisitTOKEN00: { ...live, id: 'v1', kind: 'visit' },
      'abcDEF123_-xyz789QWERTY': { ...live, expires_at: new Date(Date.now() - 1000) },
    };
    const acr = chainBuilder();
    let lastToken = null;
    acr.where = jest.fn((q) => { lastToken = q?.token; return acr; });
    acr.first = jest.fn(async () => rows[lastToken] || null);
    mockBuilders = { appointment_card_requests: acr, sms_templates: chainBuilder({ firstRow: { is_active: true } }) };
    setupLinkIneligibility.mockReset().mockResolvedValue({ reason: null, customer: { phone: '(941) 555-0184' } });
    const body = 'Card: https://portal.wavespestcontrol.com/secure/visitTOKENvisitTOKEN00 and ' + BODY;
    const r = await autopayLinkSendCheck(body, '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired or no longer live/);
  });

  test('two Auto Pay links: one owned by another customer refuses the whole send', async () => {
    const rows = {
      'abcDEF123_-xyz789QWERTY': { ...live },
      otherCUSTOMERtoken0000: { ...live, id: 'r2', customer_id: 'c2' },
    };
    const owners = { c1: { phone: '(941) 555-0184' }, c2: { phone: '+19998887777' } };
    const acr = chainBuilder(); let lastToken = null;
    acr.where = jest.fn((q) => { lastToken = q?.token; return acr; });
    acr.first = jest.fn(async () => rows[lastToken] || null);
    setupLinkIneligibility.mockReset().mockImplementation(async (id) => ({ reason: null, customer: owners[id] }));
    mockBuilders = { appointment_card_requests: acr, sms_templates: chainBuilder({ firstRow: { is_active: true } }) };
    const body = BODY + ' or https://portal.wavespestcontrol.com/secure/otherCUSTOMERtoken0000';
    const r = await autopayLinkSendCheck(body, '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different customer/);
  });
});
