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
  existingShortUrlFor: jest.fn(async () => null),
  invoiceShortCodePrefix: jest.fn(() => 'wpc-test'),
}));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/pay-combined', () => ({
  combinedEligibleSiblings: jest.fn(async () => null),
  amountDueCents: jest.fn((inv) => Math.round((inv.amount_due ?? 0) * 100)),
}));
jest.mock('../services/referral-engine', () => ({
  resolvePromoter: jest.fn(),
  getLiveSettings: jest.fn(async () => ({ program_active: true })),
}));
jest.mock('../routes/estimate-public', () => ({
  isEstimateCustomerViewable: jest.fn(),
  findLinkedUpcomingAppointment: jest.fn(),
  adoptionServiceModesForContract: jest.fn(() => ['recurring']),
}));
jest.mock('../services/autopay-setup-link', () => ({ requestAutopaySetupLink: jest.fn(), setupLinkIneligibility: jest.fn(), KIND: 'customer' }));
// Only the Auto Pay customer-SMS gate reads true — every other gate (the
// pricing-authority send gate the estimate builder consults) stays off.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((g) => g === 'autopayCustomerSms') }));
jest.mock('../services/appointment-card-request', () => ({ renderTemplate: jest.fn() }));
// getTemplate strips https:// from owned portal hosts before returning —
// the mocked render mirrors that, and the comparison helper is the real
// contract the builder must use.
jest.mock('../routes/admin-sms-templates', () => ({
  stripPortalUrlScheme: (b) => String(b).replace(/https?:\/\/(portal\.wavespestcontrol\.com)/g, '$1'),
}));
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
const { resolvePromoter, getLiveSettings } = require('../services/referral-engine');
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
  b.select = jest.fn(async () => rows);
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

  test('short-link purpose defaults to the composer insert and a caller can label its own send', async () => {
    const { shortenOrPassthrough } = require('../services/short-url');
    const rows = [{ id: 'e-ok', token: 'tk-ok', customer_id: 'c1', status: 'sent', service_type: 'Pest' }];
    mockBuilders = { estimates: chainBuilder({ rows }) };
    isEstimateCustomerViewable.mockReturnValue(true);

    await buildLatestEstimateLink(['c1']);
    expect(shortenOrPassthrough).toHaveBeenLastCalledWith(
      expect.stringContaining('/estimate/tk-ok'),
      expect.objectContaining({ purpose: 'composer_insert' }),
    );

    mockBuilders = { estimates: chainBuilder({ rows }) };
    await buildLatestEstimateLink(['c1'], { purpose: 'call_booking_confirmation' });
    expect(shortenOrPassthrough).toHaveBeenLastCalledWith(
      expect.stringContaining('/estimate/tk-ok'),
      expect.objectContaining({ purpose: 'call_booking_confirmation' }),
    );
  });

  test('findLatestOpenEstimate resolves the row without minting a short link', async () => {
    const { findLatestOpenEstimate } = require('../services/composer-customer-links');
    const { shortenOrPassthrough } = require('../services/short-url');
    shortenOrPassthrough.mockClear();
    const rows = [{ id: 'e-ok', token: 'tk-ok', customer_id: 'c1', status: 'sent', service_type: 'Pest' }];
    mockBuilders = { estimates: chainBuilder({ rows }) };
    isEstimateCustomerViewable.mockReturnValue(true);

    const r = await findLatestOpenEstimate(['c1']);
    expect(r.estimate).toEqual(expect.objectContaining({ id: 'e-ok', token: 'tk-ok' }));
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
  });

  test('mintEstimateLink reuses the estimate\'s existing short code when asked, else mints', async () => {
    const { mintEstimateLink } = require('../services/composer-customer-links');
    const { shortenOrPassthrough, existingShortUrlFor } = require('../services/short-url');
    shortenOrPassthrough.mockClear();
    const estimate = { id: 'e-ok', token: 'tk-ok', customer_id: 'c1', status: 'sent', service_type: 'Pest' };

    existingShortUrlFor.mockResolvedValueOnce('https://l.example/abc');
    const reused = await mintEstimateLink(estimate, { purpose: 'call_booking_confirmation', reuseExisting: true });
    expect(reused.url).toBe('https://l.example/abc');
    // Scoped to THIS workflow's codes — never a composer/campaign link.
    expect(existingShortUrlFor).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'estimate', entityId: 'e-ok', purpose: 'call_booking_confirmation' }),
    );
    expect(shortenOrPassthrough).not.toHaveBeenCalled();

    existingShortUrlFor.mockResolvedValueOnce(null);
    const minted = await mintEstimateLink(estimate, { purpose: 'call_booking_confirmation', reuseExisting: true });
    expect(minted.url).toContain('/estimate/tk-ok');
    expect(shortenOrPassthrough).toHaveBeenCalledTimes(1);
  });

  test('no viewable open estimate answers a plain reason', async () => {
    mockBuilders = { estimates: chainBuilder({ rows: [] }) };
    const r = await buildLatestEstimateLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No open estimate/);
  });
});

describe('resolveConfirmationEstimate (call-booking confirmation accept line)', () => {
  const { findLinkedUpcomingAppointment } = require('../routes/estimate-public');
  const row = { id: 'e-ok', token: 'tk-ok', customer_id: 'c1', status: 'sent', service_type: 'Pest', estimate_data: '{"x":1}' };

  beforeEach(() => {
    mockBuilders = { estimates: chainBuilder({ rows: [row] }) };
    isEstimateCustomerViewable.mockReturnValue(true);
    findLinkedUpcomingAppointment.mockReset();
  });

  test('answers the newest open estimate only when the accept would adopt THIS visit', async () => {
    const { resolveConfirmationEstimate } = require('../services/composer-customer-links');
    findLinkedUpcomingAppointment.mockResolvedValueOnce({ id: 'v1' });
    const hit = await resolveConfirmationEstimate({ customerId: 'c1', scheduledServiceId: 'v1' });
    expect(hit).toEqual(expect.objectContaining({ id: 'e-ok' }));
    // Pinned to the booked visit, with the parsed estimate_data.
    expect(findLinkedUpcomingAppointment).toHaveBeenCalledWith(row, { x: 1 }, expect.objectContaining({ appointmentId: 'v1' }));

    findLinkedUpcomingAppointment.mockResolvedValueOnce({ id: 'v-other' });
    expect(await resolveConfirmationEstimate({ customerId: 'c1', scheduledServiceId: 'v1' })).toBeNull();
  });

  test('a pinned estimate id that is no longer the newest open estimate yields no line — never a different estimate', async () => {
    const { resolveConfirmationEstimate } = require('../services/composer-customer-links');
    findLinkedUpcomingAppointment.mockResolvedValue({ id: 'v1' });
    expect(await resolveConfirmationEstimate({ customerId: 'c1', scheduledServiceId: 'v1', estimateId: 'e-stale' })).toBeNull();
    expect(findLinkedUpcomingAppointment).not.toHaveBeenCalled();
    expect(await resolveConfirmationEstimate({ customerId: 'c1', scheduledServiceId: 'v1', estimateId: 'e-ok' }))
      .toEqual(expect.objectContaining({ id: 'e-ok' }));
  });

  test('appendEstimateAcceptLine mints at send time and falls back to the plain body on a mint failure', async () => {
    const { appendEstimateAcceptLine } = require('../services/composer-customer-links');
    const { shortenOrPassthrough, existingShortUrlFor } = require('../services/short-url');
    existingShortUrlFor.mockResolvedValueOnce(null);
    const out = await appendEstimateAcceptLine('Booked for Monday.', row, { scheduledServiceId: 'v1' });
    expect(out).toMatch(/^Booked for Monday\.\n\nYou can accept your estimate and choose your plan here: .*\/estimate\/tk-ok$/);
    expect(await appendEstimateAcceptLine('Booked for Monday.', null)).toBe('Booked for Monday.');
    shortenOrPassthrough.mockRejectedValueOnce(new Error('short-url down'));
    existingShortUrlFor.mockResolvedValueOnce(null);
    expect(await appendEstimateAcceptLine('Booked for Monday.', row, { scheduledServiceId: 'v1' })).toBe('Booked for Monday.');
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
  test('a household-resolved promoter (multi-property sibling) links like a fresh enrollment', async () => {
    // The account-scoped 23505 fallback lives in referral-engine.resolvePromoter.
    resolvePromoter.mockResolvedValue({
      promoter: { id: 'p1', referral_code: 'WAVES-ABC12345', referral_link: 'https://portal.wavespestcontrol.com/r/WAVES-ABC12345' },
      alreadyEnrolled: true,
      household: true,
    });
    const r = await buildReferralLink('c2');
    expect(r.url).toContain('/r/WAVES-ABC12345');
    expect(r.line).toContain(r.url);
  });

  test('a non-conflict enroll failure answers the plain reason', async () => {
    resolvePromoter.mockRejectedValue(new Error('db down'));
    const r = await buildReferralLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/Could not build/);
  });

  test('an inactive program refuses before any enrollment', async () => {
    getLiveSettings.mockResolvedValueOnce({ program_active: false });
    const r = await buildReferralLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/not active/);
    expect(resolvePromoter).not.toHaveBeenCalled();
  });

  test('an unavailable settings read fails closed — no enrollment, no link', async () => {
    getLiveSettings.mockRejectedValueOnce(new Error('db down'));
    const r = await buildReferralLink('c1');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/not active/);
    expect(resolvePromoter).not.toHaveBeenCalled();
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
        ? `Hi ${vars.first_name}! Set up Auto Pay here: ${vars.secure_link.replace(/^https:\/\//, '')}\nNothing is charged today. Reply STOP to opt out.`
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
    // Scheme-stripped in the rendered body (getTemplate's owned-host rule) —
    // the minted-URL presence check compares the same way.
    expect(r.line).toBe('Hi Pat! Set up Auto Pay here: portal.wavespestcontrol.com/secure/tok123 Nothing is charged today. Reply STOP to opt out.\n\n');
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
  const TOKEN = 'abcDEF123_-xyz789QWERTY';
  const live = { id: 'r1', kind: 'customer', token: TOKEN, status: 'pending', expires_at: new Date(Date.now() + 86400e3), customer_id: 'c1' };
  beforeEach(() => {
    isEnabled.mockReset().mockImplementation((g) => g === 'autopayCustomerSms');
  });
  function wire({ row, rows, owner = { phone: '(941) 555-0184' }, template = { is_active: true } }) {
    mockBuilders = {
      appointment_card_requests: chainBuilder({ rows: rows || (row ? [row] : []) }),
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

  test('a percent-encoded /secur%65/ path is still detected and judged', async () => {
    wire({ row: { ...live, expires_at: new Date(Date.now() - 1000) } });
    const r = await autopayLinkSendCheck('Set it up here: portal.wavespestcontrol.com/secur%65/abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.present).toBe(true);
    expect(r.ok).toBe(false);
  });

  test('a differently-cased /Secure/ path is still detected and judged', async () => {
    wire({ row: { ...live, expires_at: new Date(Date.now() - 1000) } });
    const r = await autopayLinkSendCheck('Set it up here: portal.wavespestcontrol.com/Secure/abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.present).toBe(true);
    expect(r.ok).toBe(false);
  });

  test.each([
    ['colon', 'Link:portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY'],
    ['quote', 'Here "portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY"'],
    ['comma', 'now,https://portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY'],
  ])('ordinary punctuation before a canonical link (%s) is accepted', async (_label, body) => {
    wire({ row: live });
    expect((await autopayLinkSendCheck(body, '9415550184')).ok).toBe(true);
  });

  test.each([
    ['query', 'https://evil.example/?next=portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY'],
    ['fragment', 'https://evil.example/#portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY'],
    ['userinfo', 'https://portal.wavespestcontrol.com@evil.example/secure/abcDEF123_-xyz789QWERTY'],
    ['secure path in the query, not the path', 'https://portal.wavespestcontrol.com/?r=/secure/abcDEF123_-xyz789QWERTY'],
    ['explicit http', 'http://portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY'],
    ['encoded newline inside a hostile outer URL', 'https://evil.example/%0Aportal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY'],
    ['encoded space inside a hostile outer URL', 'https://evil.example/%20portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY'],
  ])('the secure path inside a hostile or non-path position (%s) is refused — the run is parsed, not substring-matched', async (_label, body) => {
    wire({ row: live });
    const r = await autopayLinkSendCheck(body, '9415550184');
    expect(r.present).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not on the Waves portal/);
  });

  test('a backslash-separated path still opens the page — it is normalized and judged', async () => {
    wire({ row: { ...live, expires_at: new Date(Date.now() - 1000) } });
    const r = await autopayLinkSendCheck('https://portal.wavespestcontrol.com\\secure\\abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.present).toBe(true);
    expect(r.ok).toBe(false);
  });

  test('TOKEN-FIRST: a live bearer token anywhere in the text outside a canonical link refuses the send', async () => {
    wire({ row: live });
    for (const body of [
      'Your code: abcDEF123_-xyz789QWERTY',
      'https://evil.example/go?t=abcDEF123_-xyz789QWERTY',
      'portal.wavespestcontrol.com/anything/abcDEF123_-xyz789QWERTY',
    ]) {
      const r = await autopayLinkSendCheck(body, '9415550184');
      expect(r.present).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not a plain Waves portal link/);
    }
  });

  test('a token-shaped run that is no bearer (no row) is not present — one lookup, no refusal', async () => {
    wire({ rows: [] });
    expect(await autopayLinkSendCheck('Ref ABCDEFGHIJKLMNOPQRSTUV thanks', '9415550184')).toEqual({ present: false });
  });

  test('a subdomain look-alike is not a Waves link', async () => {
    wire({ row: live });
    const r = await autopayLinkSendCheck('x.portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY', '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not on the Waves portal/);
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
    wire({ rows: [
      { ...live, id: 'v1', kind: 'visit', token: 'visitTOKENvisitTOKEN00' },
      { ...live, expires_at: new Date(Date.now() - 1000) },
    ] });
    const body = 'Card: https://portal.wavespestcontrol.com/secure/visitTOKENvisitTOKEN00 and ' + BODY;
    const r = await autopayLinkSendCheck(body, '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired or no longer live/);
  });

  test('two Auto Pay links: one owned by another customer refuses the whole send', async () => {
    const owners = { c1: { phone: '(941) 555-0184' }, c2: { phone: '+19998887777' } };
    wire({ rows: [{ ...live }, { ...live, id: 'r2', customer_id: 'c2', token: 'otherCUSTOMERtoken0000' }] });
    setupLinkIneligibility.mockReset().mockImplementation(async (id) => ({ reason: null, customer: owners[id] }));
    const body = BODY + ' or https://portal.wavespestcontrol.com/secure/otherCUSTOMERtoken0000';
    const r = await autopayLinkSendCheck(body, '9415550184');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different customer/);
  });
});
