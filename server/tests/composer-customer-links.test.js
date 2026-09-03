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
  shortLinkBaseUrl: () => 'https://wavespest.co',
}));
jest.mock('../services/payer-statement-email', () => ({ markStatementSent: jest.fn() }));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/pay-combined', () => ({
  combinedEligibleSiblings: jest.fn(async () => null),
  amountDueCents: jest.fn((inv) => Math.round((inv.amount_due ?? 0) * 100)),
}));
jest.mock('../services/referral-engine', () => ({
  enrollPromoter: jest.fn(),
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
// The Auto Pay builder renders its reviewed SMS template through the card
// request module's renderer (the card request row itself: PR 2b).
jest.mock('../services/appointment-card-request', () => ({ renderTemplate: jest.fn() }));
jest.mock('../services/appointment-link', () => ({ buildAppointmentLink: jest.fn() }));
jest.mock('../services/prep-guide-sender', () => ({
  PREP_CONFIG: {
    flea: { label: 'Flea Treatment', serviceKeyword: 'flea', emailTemplateKey: 'prep.flea' },
    bed_bug: { label: 'Bed Bug Treatment Service', serviceKeyword: 'bed bug', emailTemplateKey: 'prep.bed_bug' },
  },
  nextUpcomingVisit: jest.fn(),
}));
jest.mock('../services/project-email', () => ({ ensureServicePrepToken: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ loadTemplateByKey: jest.fn() }));
// The real predicate: typedReportDelivery set to anything but auto_send is
// suppressed (internal_only / disabled typed reports 404 publicly).
jest.mock('../routes/reports-public', () => ({
  suppressedTypedReport: (record) => {
    let notes = record?.structured_notes;
    if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = null; } }
    const mode = notes && typeof notes === 'object' ? notes.typedReportDelivery : null;
    return Boolean(mode) && mode !== 'auto_send';
  },
}));
// The public prep page's own resolver (token → source; expiry enforced there).
jest.mock('../routes/prep-public', () => ({ resolvePrepSource: jest.fn() }));
jest.mock('../services/payer-statement-settle', () => ({
  PAYABLE_STATEMENT_STATUSES: new Set(['finalized', 'sent', 'viewed']),
  isPayableStatementStatus: (s) => ['finalized', 'sent', 'viewed'].includes(s),
}));
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
const { enrollPromoter, getLiveSettings } = require('../services/referral-engine');
const { isEstimateCustomerViewable } = require('../routes/estimate-public');
const { requestAutopaySetupLink, setupLinkIneligibility } = require('../services/autopay-setup-link');
const { isEnabled } = require('../config/feature-gates');
const { renderTemplate } = require('../services/appointment-card-request');
const { buildAppointmentLink } = require('../services/appointment-link');
const { nextUpcomingVisit } = require('../services/prep-guide-sender');
const { ensureServicePrepToken } = require('../services/project-email');
const { loadTemplateByKey } = require('../services/email-template-library');
const ReviewService = require('../services/review-request');
const {
  buildPayBalanceLink,
  buildLatestEstimateLink,
  buildReviewRequestLink,
  buildReferralLink,
  buildAutopaySetupLink,
  autopayLinkSendCheck,
  buildAppointmentPageLink,
  buildPrepGuideLink,
  buildServiceReportLink,
  buildStatementLink,
  markStatementsSent,
} = require('../services/composer-customer-links');

function chainBuilder({ firstRow = null, rows = [] } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereIn = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.whereNotNull = jest.fn(() => b);
  b.whereRaw = jest.fn(() => b);
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

// ---------------------------------------------------------------------------
// Step 2 rows: appointment page, prep guide, latest service report, payer
// statement (card request + contract signing: PR 2b). Each builder is mint-only and
// answers the composer's { url, line } / reason contract; the gate-off and
// nothing-to-link paths are pinned alongside the happy path.
// ---------------------------------------------------------------------------

const VISIT = { id: 'v1', customer_id: 'c1', scheduled_date: '2026-09-08', service_type: 'Flea Treatment', status: 'confirmed' };

describe('buildAppointmentPageLink', () => {
  const gate = process.env.GATE_APPOINTMENT_PAGE;
  afterEach(() => {
    if (gate === undefined) delete process.env.GATE_APPOINTMENT_PAGE;
    else process.env.GATE_APPOINTMENT_PAGE = gate;
  });

  test('no picked visit → plain reason, nothing minted', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    const r = await buildAppointmentPageLink(null);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No upcoming appointment/);
    expect(buildAppointmentLink).not.toHaveBeenCalled();
  });

  test('gate off → reason names GATE_APPOINTMENT_PAGE and the builder is never called', async () => {
    delete process.env.GATE_APPOINTMENT_PAGE;
    const r = await buildAppointmentPageLink(VISIT);
    expect(r.reason).toMatch(/GATE_APPOINTMENT_PAGE/);
    expect(buildAppointmentLink).not.toHaveBeenCalled();
  });

  test('delegates to appointment-link with the visit owner and returns the visit context', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    buildAppointmentLink.mockResolvedValue({ url: 'https://wavespest.co/a/abc', line: 'Everything about your visit: https://wavespest.co/a/abc\n\n' });
    const r = await buildAppointmentPageLink(VISIT);
    expect(buildAppointmentLink).toHaveBeenCalledWith('v1', { customerId: 'c1' });
    expect(r.url).toBe('https://wavespest.co/a/abc');
    expect(r.line).toContain(r.url);
    expect(r.appointment).toEqual({ id: 'v1', scheduledDate: '2026-09-08', serviceType: 'Flea Treatment' });
  });

  test('a legacy row with no token (builder answers null) → reason, no link', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    buildAppointmentLink.mockResolvedValue({ url: null, line: '' });
    const r = await buildAppointmentPageLink(VISIT);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/no appointment link/);
  });
});

describe('buildPrepGuideLink', () => {
  beforeEach(() => {
    nextUpcomingVisit.mockReset();
    ensureServicePrepToken.mockReset().mockResolvedValue('a'.repeat(32));
    loadTemplateByKey.mockReset().mockResolvedValue({ template: { id: 't1' }, activeVersion: { id: 'tv1' } });
  });

  test('a guide with no active version refuses — the public page would 404 (same predicate as prep-public)', async () => {
    nextUpcomingVisit.mockImplementation(async (_ids, keyword) => (
      keyword === 'flea' ? { id: 'v-flea', customer_id: 'c1', scheduled_date: '2026-09-20', prep_expires_at: null } : null
    ));
    loadTemplateByKey.mockResolvedValue({ template: { id: 't1' }, activeVersion: null });
    const r = await buildPrepGuideLink(['c1']);
    expect(loadTemplateByKey).toHaveBeenCalledWith('prep.flea');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/no active version/);
    expect(ensureServicePrepToken).not.toHaveBeenCalled();
  });

  test('no prep-family visit on the account → reason, nothing minted', async () => {
    nextUpcomingVisit.mockResolvedValue(null);
    const r = await buildPrepGuideLink(['c1', 'c2']);
    expect(nextUpcomingVisit).toHaveBeenCalledWith(['c1', 'c2'], 'flea');
    expect(nextUpcomingVisit).toHaveBeenCalledWith(['c1', 'c2'], 'bed bug');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No upcoming flea, bed bug, or cockroach visit/);
    expect(ensureServicePrepToken).not.toHaveBeenCalled();
  });

  test('picks the soonest visit across pest families (date, then window) and mints that visit\'s token with its family key', async () => {
    nextUpcomingVisit.mockImplementation(async (_ids, keyword) => (
      keyword === 'flea'
        ? { id: 'v-flea', customer_id: 'c2', scheduled_date: '2026-09-10', window_start: '13:00:00', service_type: 'Flea Treatment', prep_expires_at: null }
        : { id: 'v-bb', customer_id: 'c1', scheduled_date: '2026-09-10', window_start: '09:00:00', service_type: 'Bed Bug Treatment', prep_expires_at: null }
    ));
    const r = await buildPrepGuideLink(['c1', 'c2']);
    expect(ensureServicePrepToken).toHaveBeenCalledWith('v-bb', 'prep.bed_bug');
    expect(r.url).toBe(`https://portal.wavespestcontrol.com/prep/${'a'.repeat(32)}`);
    expect(r.line).toContain('Bed Bug Treatment Service');
    expect(r.line).toContain(r.url);
    expect(r.prep).toEqual({ pestType: 'bed_bug', label: 'Bed Bug Treatment Service', scheduledDate: '2026-09-10' });
    expect(r.expiresAt).toBeNull();
  });

  test('a visit whose stored guide differs from the keyword match is labeled with the STORED guide (what the page renders)', async () => {
    nextUpcomingVisit.mockImplementation(async (_ids, keyword) => (
      keyword === 'flea'
        ? { id: 'v-mixed', customer_id: 'c1', scheduled_date: '2026-09-10', service_type: 'Flea + Bed Bug', prep_template_key: 'prep.bed_bug', prep_expires_at: null }
        : null
    ));
    const r = await buildPrepGuideLink(['c1']);
    expect(ensureServicePrepToken).toHaveBeenCalledWith('v-mixed', 'prep.bed_bug');
    expect(r.line).toContain('Bed Bug Treatment Service');
    expect(r.line).not.toContain('Flea Treatment');
    expect(r.prep.pestType).toBe('bed_bug');
  });

  test('a stored guide key the composer cannot name refuses', async () => {
    nextUpcomingVisit.mockImplementation(async (_ids, keyword) => (
      keyword === 'flea' ? { id: 'v1', customer_id: 'c1', scheduled_date: '2026-09-10', prep_template_key: 'prep.termite', prep_expires_at: null } : null
    ));
    const r = await buildPrepGuideLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/cannot name/);
    expect(ensureServicePrepToken).not.toHaveBeenCalled();
  });

  test('an expired prep token refuses rather than inserting a dead page', async () => {
    nextUpcomingVisit.mockImplementation(async (_ids, keyword) => (
      keyword === 'flea' ? { id: 'v-flea', customer_id: 'c1', scheduled_date: '2026-09-20', prep_expires_at: '2020-01-01T00:00:00Z' } : null
    ));
    const r = await buildPrepGuideLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/expired/);
    expect(ensureServicePrepToken).not.toHaveBeenCalled();
  });
});

describe('buildServiceReportLink', () => {
  const { shortenOrPassthrough } = require('../services/short-url');

  test('newest completed record with a public token, skipping suppressed typed reports; never mints', async () => {
    mockBuilders = {
      service_records: chainBuilder({
        rows: [
          { id: 'r-new', customer_id: 'c1', service_date: '2026-09-01', service_type: 'Quarterly Pest', report_view_token: 'b'.repeat(32), structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }) },
          { id: 'r-ok', customer_id: 'c2', service_date: '2026-08-01', service_type: 'Lawn', report_view_token: 'c'.repeat(32), structured_notes: null },
        ],
      }),
    };
    const r = await buildServiceReportLink(['c1', 'c2']);
    expect(mockBuilders.service_records.whereNotNull).toHaveBeenCalledWith('report_view_token');
    // Only v1 records: the React page's /:token/data 404s for legacy templates.
    expect(mockBuilders.service_records.where).toHaveBeenCalledWith({ status: 'completed', report_template_version: 'service_report_v1' });
    expect(r.url).toBe(`https://portal.wavespestcontrol.com/report/${'c'.repeat(32)}`);
    expect(shortenOrPassthrough).toHaveBeenCalledWith(r.url, expect.objectContaining({
      kind: 'service_report', entityType: 'service_records', entityId: 'r-ok', customerId: 'c2', codePrefix: 'report',
    }));
    expect(r.report).toEqual({ id: 'r-ok', serviceDate: '2026-08-01', serviceType: 'Lawn' });
  });

  test('no tokened report → reason', async () => {
    mockBuilders = { service_records: chainBuilder({ rows: [] }) };
    const r = await buildServiceReportLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No service report/);
  });
});

describe('buildStatementLink', () => {
  beforeEach(() => {
    isEnabled.mockReset().mockImplementation((g) => g === 'payerStatements');
  });

  test('gate off → reason names GATE_PAYER_STATEMENTS, no reads', async () => {
    isEnabled.mockReturnValue(false);
    const r = await buildStatementLink('5551234567');
    expect(r.reason).toMatch(/GATE_PAYER_STATEMENTS/);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('FAIL CLOSED: the recipient number must be an active payer\'s AP phone — a homeowner\'s number resolves no payer and gets no statement', async () => {
    const payers = chainBuilder({ rows: [] });
    payers.whereRaw = jest.fn(() => payers);
    mockBuilders = { payers, payer_statements: chainBuilder({ firstRow: { id: 31, status: 'sent', token: 'f'.repeat(64), total: '412.50' } }) };
    const r = await buildStatementLink('5551234567');
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/not a payer's AP phone/);
    expect(payers.where).toHaveBeenCalledWith({ active: true });
    expect(payers.whereRaw).toHaveBeenCalledWith(expect.stringContaining('ap_phone'), ['5551234567']);
    expect(mockDb).not.toHaveBeenCalledWith('payer_statements');
  });

  test('AP phone matches → newest payable statement, raw /pay/statement link, immediate-only', async () => {
    const payers = chainBuilder({ rows: [{ id: 7, display_name: 'Gulf Coast PM' }] });
    payers.whereRaw = jest.fn(() => payers);
    mockBuilders = {
      payers,
      payer_statements: chainBuilder({ firstRow: { id: 31, payer_id: 7, status: 'sent', token: 'f'.repeat(64), total: '412.50' } }),
    };
    const r = await buildStatementLink('9415550100');
    expect(mockBuilders.payer_statements.whereIn).toHaveBeenCalledWith('payer_id', [7]);
    // Payability is a SQL predicate (no row page to fall off), tokened rows only.
    expect(mockBuilders.payer_statements.whereIn).toHaveBeenCalledWith('status', ['finalized', 'sent', 'viewed']);
    expect(mockBuilders.payer_statements.whereNotNull).toHaveBeenCalledWith('token');
    expect(mockBuilders.payer_statements.orderBy).toHaveBeenCalledWith('created_at', 'desc');
    expect(r.url).toBe(`https://portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}`);
    expect(r.line).toContain('statement S-31');
    expect(r.immediateOnly).toBe(true);
    expect(r.statement).toEqual({ id: 31, number: 'S-31', total: 412.5, payerName: 'Gulf Coast PM' });
  });

  test('several active payers share the AP phone → the newest payable statement across ALL of them, named for its own payer', async () => {
    const payers = chainBuilder({ rows: [{ id: 7, display_name: 'Gulf Coast PM' }, { id: 8, display_name: 'Gulf Coast HOA' }] });
    payers.whereRaw = jest.fn(() => payers);
    mockBuilders = {
      payers,
      payer_statements: chainBuilder({ firstRow: { id: 52, payer_id: 8, status: 'finalized', token: 'd'.repeat(64), total: '80.00' } }),
    };
    const r = await buildStatementLink('9415550100');
    expect(mockBuilders.payer_statements.whereIn).toHaveBeenCalledWith('payer_id', [7, 8]);
    expect(r.url).toBe(`https://portal.wavespestcontrol.com/pay/statement/${'d'.repeat(64)}`);
    expect(r.statement).toEqual({ id: 52, number: 'S-52', total: 80, payerName: 'Gulf Coast HOA' });
  });
});

describe('immediateOnlyLinkSendCheck (schedule + draft fence)', () => {
  const { immediateOnlyLinkSendCheck } = require('../services/composer-customer-links');
  const expiringLinkSendCheck = immediateOnlyLinkSendCheck;

  test('a service report link (long /report form, or the branded short form of kind service_report) is immediate-only', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck(`Here is your latest service report: portal.wavespestcontrol.com/report/${'b'.repeat(32)}`)).toEqual({ present: true, label: 'Service report' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'rep1', kind: 'service_report' } }) };
    expect(await immediateOnlyLinkSendCheck('Here is your latest service report: wavespest.co/l/rep1')).toEqual({ present: true, label: 'Service report' });
  });

  test('an appointment page link (branded short form of kind appointment, or the long /appointment form) is immediate-only', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: { kind: 'appointment' } }) };
    expect(await immediateOnlyLinkSendCheck('Everything about your visit: wavespest.co/l/Ab12cD')).toEqual({ present: true, label: 'Appointment page' });
    expect(mockBuilders.short_codes.where).toHaveBeenCalledWith({ code: 'Ab12cD' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: { kind: 'estimate' } }) };
    expect(await immediateOnlyLinkSendCheck('See it: wavespest.co/l/Ab12cD')).toEqual({ present: false });
    expect(await immediateOnlyLinkSendCheck('portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Appointment page' });
    expect(await immediateOnlyLinkSendCheck('evil.example/l/Ab12cD')).toEqual({ present: false });
  });

  test('a statement pay link is immediate-only; a /secure link is the Auto Pay seam\'s (and, in PR 2b, the card request\'s)', async () => {
    expect(await immediateOnlyLinkSendCheck(`Pay here: portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}`)).toEqual({ present: true, label: 'Statement pay' });
    expect(await immediateOnlyLinkSendCheck('Secure it: portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY')).toEqual({ present: false });
    expect(await expiringLinkSendCheck('Nothing to see')).toEqual({ present: false });
  });
  const PREP = 'a'.repeat(32);

  test('every canonical prep link is immediate-only, expiry or not — only /sms binds the page to the recipient (pre-push Codex P0)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await expiringLinkSendCheck(`Checklist: portal.wavespestcontrol.com/prep/${PREP}`)).toEqual({ present: true, label: 'Prep guide' });
    expect(mockDb).not.toHaveBeenCalledWith('scheduled_services');
    expect(await expiringLinkSendCheck(`portal.wavespestcontrol.com.evil.example/prep/${PREP}`)).toEqual({ present: false });
  });
});

describe('bearerLinkSendCheck (immediate-send seam for prep, statement, appointment + report links)', () => {
  const { bearerLinkSendCheck } = require('../services/composer-customer-links');

  function wire({ owner = { id: 'c1', phone: '+1 (941) 555-0100' } } = {}) {
    mockBuilders = {
      customers: chainBuilder({ firstRow: owner }),
      short_codes: chainBuilder({ firstRow: null }),
    };
  }

  test('nothing applies → ok', async () => {
    wire();
    expect(await bearerLinkSendCheck('Hi there, see you Tuesday.', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
  });

  describe('prep guide links (the public page\'s predicates, re-run at the send — GH Codex #3844 r3 P2)', () => {
    const PREP = 'b'.repeat(32);
    const PREP_BODY = `Checklist: portal.wavespestcontrol.com/prep/${PREP}`;
    const { resolvePrepSource } = require('../routes/prep-public');
    beforeEach(() => {
      wire();
      resolvePrepSource.mockReset().mockResolvedValue({ templateKey: 'prep.flea', customerId: 'c1' });
      loadTemplateByKey.mockReset().mockResolvedValue({ template: { id: 't1' }, activeVersion: { id: 'tv1' } });
    });

    test('a resolving token whose guide has an active version, owned by the recipient, passes', async () => {
      expect(await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      expect(resolvePrepSource).toHaveBeenCalledWith(PREP);
      expect(loadTemplateByKey).toHaveBeenCalledWith('prep.flea');
    });

    test('an expired (unresolvable) token refuses', async () => {
      resolvePrepSource.mockResolvedValue(null);
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/prep guide link has expired/);
    });

    test('a guide deactivated since the insert refuses', async () => {
      loadTemplateByKey.mockResolvedValue({ template: { id: 't1' }, activeVersion: null });
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no active version/);
    });

    test('a prep page for another customer refuses (the page shows their name and address)', async () => {
      expect((await bearerLinkSendCheck(PREP_BODY, '5551234567', { trustedCustomerId: 'c1' })).error).toMatch(/different customer/);
    });

    test('a prep page with no customer owner refuses — nothing can bind it to a recipient (pre-push Codex P0)', async () => {
      resolvePrepSource.mockResolvedValue({ templateKey: 'prep.flea', customerId: null });
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no customer on file/);
    });

    test('a non-canonical prep host refuses outright', async () => {
      expect((await bearerLinkSendCheck(`https://evil.example/?next=portal.wavespestcontrol.com/prep/${PREP}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/not on the Waves portal/);
    });
  });

  test('a statement link: payable + active payer AP phone passes; anything else refuses', async () => {
    const STMT = 'f'.repeat(64);
    const body = `Pay here: portal.wavespestcontrol.com/pay/statement/${STMT}`;
    const wireStmt = ({ stmt, payer }) => {
      mockDb.mockClear();
      isEnabled.mockImplementation((g) => g === 'payerStatements');
      mockBuilders = {
        payer_statements: chainBuilder({ firstRow: stmt }),
        payers: chainBuilder({ firstRow: payer }),
      };
    };
    wireStmt({ stmt: { id: 31, payer_id: 7, status: 'sent' }, payer: { id: 7, ap_phone: '(941) 555-0100' } });
    // The verified statement rides back so a real send can stamp finalized → sent.
    expect(await bearerLinkSendCheck(body, '9415550100', { trustedCustomerId: null })).toEqual({ ok: true, statements: [31] });
    expect(mockBuilders.payer_statements.where).toHaveBeenCalledWith({ token: STMT });
    expect(mockBuilders.payers.where).toHaveBeenCalledWith({ id: 7, active: true });
    // The kill switch is honored at send time — a stale tab cannot deliver a
    // link the pay page now 404s (Codex r1 P1); no row is read once it is off.
    wireStmt({ stmt: { id: 31, payer_id: 7, status: 'sent' }, payer: { id: 7, ap_phone: '(941) 555-0100' } });
    isEnabled.mockReturnValue(false);
    expect((await bearerLinkSendCheck(body, '9415550100', {})).error).toMatch(/GATE_PAYER_STATEMENTS/);
    expect(mockDb).not.toHaveBeenCalledWith('payer_statements');
    wireStmt({ stmt: { id: 31, payer_id: 7, status: 'sent' }, payer: { id: 7, ap_phone: '(941) 555-0100' } });
    expect((await bearerLinkSendCheck(body, '5551234567', {})).error).toMatch(/payer's AP phone/);
    wireStmt({ stmt: { id: 31, payer_id: 7, status: 'paid' }, payer: { id: 7, ap_phone: '(941) 555-0100' } });
    expect((await bearerLinkSendCheck(body, '9415550100', {})).error).toMatch(/no longer payable/);
    wireStmt({ stmt: null, payer: null });
    expect((await bearerLinkSendCheck(body, '9415550100', {})).error).toMatch(/no longer payable/);
    wireStmt({ stmt: { id: 31, payer_id: 7, status: 'sent' }, payer: null });
    expect((await bearerLinkSendCheck(body, '9415550100', {})).error).toMatch(/payer's AP phone/);
  });

  test('an appointment page link refuses at the send once GATE_APPOINTMENT_PAGE is off', async () => {
    const prev = process.env.GATE_APPOINTMENT_PAGE;
    try {
      wire();
      mockBuilders.short_codes = chainBuilder({ firstRow: { code: 'Ab12cD', kind: 'appointment', entity_type: 'scheduled_services', entity_id: 'v1' } });
      mockBuilders.scheduled_services = chainBuilder({ firstRow: { id: 'v1', customer_id: 'c1' } });
      mockBuilders.customers = chainBuilder({ firstRow: { id: 'c1', account_id: 'acct' }, rows: [{ id: 'c1', account_id: 'acct' }] });
      process.env.GATE_APPOINTMENT_PAGE = 'true';
      expect(await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      delete process.env.GATE_APPOINTMENT_PAGE;
      expect((await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/GATE_APPOINTMENT_PAGE/);
    } finally {
      if (prev === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prev;
    }
  });

  describe('appointment + service report links are bound to the recipient\'s ACCOUNT at the send (pre-push Codex P0)', () => {
    const gate = process.env.GATE_APPOINTMENT_PAGE;
    const RESCHEDULE = 'e'.repeat(64);
    const REPORT = 'b'.repeat(32);
    const acct = (id, account_id = 'acct') => ({ id, account_id });
    function wireAccount({ recipientRows = [acct('c1')], linkCustomer = acct('c1'), visit = { id: 'v1', customer_id: 'c1' }, report = { id: 'r1', customer_id: 'c1', structured_notes: null }, shortRow = null } = {}) {
      wire();
      mockBuilders.customers = chainBuilder({ firstRow: linkCustomer, rows: recipientRows });
      mockBuilders.scheduled_services = chainBuilder({ firstRow: visit });
      mockBuilders.service_records = chainBuilder({ firstRow: report });
      mockBuilders.short_codes = chainBuilder({ firstRow: shortRow });
    }
    beforeEach(() => { process.env.GATE_APPOINTMENT_PAGE = 'true'; });
    afterEach(() => { if (gate === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = gate; });

    test('the long appointment form resolves by reschedule_token; a household sibling on the same account passes', async () => {
      wireAccount({ recipientRows: [acct('c1')], linkCustomer: acct('c2'), visit: { id: 'v1', customer_id: 'c2' } });
      expect(await bearerLinkSendCheck(`Details: portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: null })).toEqual({ ok: true });
      expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ reschedule_token: RESCHEDULE });
      expect(mockBuilders.customers.where).toHaveBeenCalledWith({ id: 'c2' });
    });

    test('the branded short form resolves through short_codes → scheduled_services', async () => {
      wireAccount({ shortRow: { code: 'Ab12cD', kind: 'appointment', entity_type: 'scheduled_services', entity_id: 'v1' } });
      expect(await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ id: 'v1' });
    });

    test('a visit on another account refuses; an unresolvable one refuses; a trusted customer off the account refuses', async () => {
      wireAccount({ recipientRows: [acct('c1')], linkCustomer: acct('c9', 'other'), visit: { id: 'v1', customer_id: 'c9' } });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: null })).error).toMatch(/different customer/);
      wireAccount({ visit: null });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: null })).error).toMatch(/no longer resolves/);
      wireAccount();
      mockBuilders.customers.first = jest.fn().mockResolvedValueOnce(acct('c1')).mockResolvedValueOnce(acct('c7', 'other'));
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: 'c7' })).error).toMatch(/not the selected customer/);
    });

    test('a service report link re-runs the builder\'s public predicate and binds to the account (long form, and the short form of kind service_report)', async () => {
      wireAccount();
      expect(await bearerLinkSendCheck(`Report: portal.wavespestcontrol.com/report/${REPORT}`, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      expect(mockBuilders.service_records.where).toHaveBeenCalledWith({ report_view_token: REPORT });
      expect(mockBuilders.service_records.where).toHaveBeenCalledWith({ status: 'completed', report_template_version: 'service_report_v1' });
      expect(mockBuilders.service_records.whereNotNull).toHaveBeenCalledWith('report_view_token');
      wireAccount({ shortRow: { code: 'rep1', kind: 'service_report', entity_type: 'service_records', entity_id: 'r1' } });
      expect(await bearerLinkSendCheck('Report: wavespest.co/l/rep1', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      expect(mockBuilders.service_records.where).toHaveBeenCalledWith({ id: 'r1' });
    });

    test('a suppressed typed report, a vanished record, or another account\'s report refuses', async () => {
      wireAccount({ report: { id: 'r1', customer_id: 'c1', structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }) } });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/${REPORT}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
      wireAccount({ report: null });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/${REPORT}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
      wireAccount({ linkCustomer: acct('c9', 'other'), report: { id: 'r1', customer_id: 'c9', structured_notes: null } });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/${REPORT}`, '9415550100', { trustedCustomerId: null })).error).toMatch(/different customer/);
    });
  });

  test('markStatementsSent goes through the email delivery\'s own finalized → sent writer, per statement', async () => {
    const { markStatementSent } = require('../services/payer-statement-email');
    await markStatementsSent([31, 52]);
    expect(markStatementSent).toHaveBeenCalledWith(31);
    expect(markStatementSent).toHaveBeenCalledWith(52);
  });

});
