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
jest.mock('../services/appointment-card-request', () => ({
  claimCardLinkSend: jest.fn(),
  markCardLinkSendOutcome: jest.fn(),
  startInvitationEmailLeg: jest.fn(),
  TEMPLATE_KEY: 'secure_appointment_card',
  PLAN_TEMPLATE_KEY: 'secure_appointment_card_plans',
  planInviteApplies: jest.fn(async () => false),
  renderTemplate: jest.fn(),
  requestCardForAppointment: jest.fn(),
  dateLineFor: jest.fn(() => ' on Tue, Sep 8'),
  cancelFeeLine: jest.fn(() => ''),
}));
jest.mock('../services/appointment-link', () => ({ buildAppointmentLink: jest.fn() }));
jest.mock('../services/prep-guide-sender', () => ({
  PREP_CONFIG: {
    flea: { label: 'Flea Treatment', serviceKeywords: ['flea'], emailTemplateKey: 'prep.flea' },
    bed_bug: { label: 'Bed Bug Treatment Service', serviceKeywords: ['bed bug'], emailTemplateKey: 'prep.bed_bug' },
    // A standalone guide: no service family, no visit — the prep-link scan
    // must skip it, not read serviceKeywords[0] (GH Codex #3953 r1 P1).
    sprinkler_timer: { label: 'Sprinkler Timer Guide', guide: true, emailTemplateKey: 'prep.sprinkler_timer' },
  },
  nextUpcomingVisit: jest.fn(),
  settleHeldEnrollment: jest.fn(async () => {}),
}));
jest.mock('../services/project-email', () => ({
  ensureServicePrepToken: jest.fn(),
  // The email path's scrubbed customer-facing title (fee cues + recorded
  // amounts) — the composer must go through it, never the raw column.
  projectTitle: jest.fn((project) => `[safe] ${project.title}`),
}));
// The report viewer's own segment parser is real; the vanity path builder
// (which numbers the customer's reports through the DB) is stubbed.
jest.mock('../services/project-report-links', () => ({
  ...jest.requireActual('../services/project-report-links'),
  projectReportPathForProject: jest.fn(async (_db, project, customer) => `/report/project/${String(customer?.first_name || 'customer').toLowerCase()}-${String(project.report_token).slice(0, 12)}`),
}));
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
// The writer's predicate is real (pure); nothing in the builder writes.
jest.mock('../routes/admin-contracts', () => ({
  createShareLink: jest.fn(),
  deliveredLiveShareLink: jest.requireActual('../routes/admin-contracts').deliveredLiveShareLink,
  shareLinkWritableStatuses: jest.requireActual('../routes/admin-contracts').shareLinkWritableStatuses,
  unsignableContractReason: jest.requireActual('../routes/admin-contracts').unsignableContractReason,
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
const { resolvePromoter, getLiveSettings } = require('../services/referral-engine');
const { isEstimateCustomerViewable } = require('../routes/estimate-public');
const { requestAutopaySetupLink, setupLinkIneligibility } = require('../services/autopay-setup-link');
const { isEnabled } = require('../config/feature-gates');
const { renderTemplate, requestCardForAppointment, claimCardLinkSend, markCardLinkSendOutcome, startInvitationEmailLeg, planInviteApplies } = require('../services/appointment-card-request');
const { buildAppointmentLink } = require('../services/appointment-link');
const { nextUpcomingVisit } = require('../services/prep-guide-sender');
const { ensureServicePrepToken } = require('../services/project-email');
const { loadTemplateByKey } = require('../services/email-template-library');
const { createShareLink } = require('../routes/admin-contracts');
const ReviewService = require('../services/review-request');
const {
  buildPayBalanceLink,
  buildLatestEstimateLink,
  buildReviewRequestLink,
  buildReferralLink,
  buildAutopaySetupLink,
  autopayLinkSendCheck,
  buildAppointmentPageLink,
  buildCardRequestLink,
  buildPrepGuideLink,
  buildServiceReportLink,
  buildContractSigningLink,
  buildStatementLink,
  buildProjectReportLink,
  markStatementsSent,
  markPrepGuidesSent,
  claimCardRequestSends,
  releaseCardRequestSends,
  markCardRequestSends,
  claimProjectReportSends,
  releaseProjectReportSends,
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
  b.orderByRaw = jest.fn(() => b);
  b.offset = jest.fn(() => b);
  b.limit = jest.fn(async () => rows);
  // Chainable and awaitable, as knex's is (`.select(cols).where(…)` and a
  // terminal `await q.select('id')` both work).
  b.select = jest.fn(() => Object.assign(Promise.resolve(rows), b));
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

// ---------------------------------------------------------------------------
// Step 2 rows: appointment page, card request, prep guide, latest service
// report, contract signing, payer statement. Each builder is mint-only and
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

describe('buildCardRequestLink', () => {
  const REQUEST = { id: 'r1', status: 'pending', token: 'tok22', selected_plan: 'annual_prepay', annual_prepay_term_id: 'term-1' };
  beforeEach(() => {
    requestCardForAppointment.mockReset();
    planInviteApplies.mockReset().mockResolvedValue(false);
    mockBuilders = { customers: chainBuilder({ firstRow: { first_name: 'Pat' } }), appointment_card_requests: chainBuilder({ firstRow: REQUEST }) };
    renderTemplate.mockReset().mockImplementation(async (vars, key) => (key === 'secure_appointment_card_plans'
      ? `Hi ${vars.first_name}! Pick a plan or save a card: ${vars.secure_link.replace(/^https:\/\//, '')}`
      : `Hi ${vars.first_name}! Save a card to secure your ${vars.service_type}${vars.date_line}: ${vars.secure_link.replace(/^https:\/\//, '')}\nNothing is charged today.`
    ));
  });

  test('a reused request that will open the plan picker gets the plan-choice copy — the funnel\'s own probe over the EXISTING request; an inactive variant keeps the base copy (GH Codex #3851 r2 P1)', async () => {
    requestCardForAppointment.mockResolvedValue({ requested: false, action: 'link_created', reason: 'request_exists', secureUrl: 'https://portal.wavespestcontrol.com/secure/tok22' });
    planInviteApplies.mockResolvedValue(true);
    const r = await buildCardRequestLink(VISIT);
    expect(planInviteApplies).toHaveBeenCalledWith('v1', REQUEST);
    expect(mockBuilders.appointment_card_requests.where).toHaveBeenCalledWith({ token: 'tok22' });
    expect(r.line).toBe('Hi Pat! Pick a plan or save a card: portal.wavespestcontrol.com/secure/tok22\n\n');
    // The base render still runs first — it is the live kill switch.
    expect(renderTemplate.mock.calls[0][1]).toBeUndefined();
    renderTemplate.mockImplementation(async (vars, key) => (key ? null : `Base copy: ${vars.secure_link.replace(/^https:\/\//, '')}`));
    expect((await buildCardRequestLink(VISIT)).line).toBe('Base copy: portal.wavespestcontrol.com/secure/tok22\n\n');
  });

  test('delegates inline (no text) and inserts the reviewed template as a standalone line', async () => {
    requestCardForAppointment.mockResolvedValue({ requested: true, action: 'link_created', reason: 'created', secureUrl: 'https://portal.wavespestcontrol.com/secure/tok22' });
    const r = await buildCardRequestLink(VISIT);
    expect(requestCardForAppointment).toHaveBeenCalledWith({ scheduledServiceId: 'v1', trigger: 'admin', delivery: 'inline' });
    expect(r.url).toBe('https://portal.wavespestcontrol.com/secure/tok22');
    expect(r.standalone).toBe(true);
    expect(r.immediateOnly).toBe(true);
    expect(r.line).toBe('Hi Pat! Save a card to secure your Flea Treatment on Tue, Sep 8: portal.wavespestcontrol.com/secure/tok22 Nothing is charged today.\n\n');
    expect(r.line).not.toMatch(/\n[^\n]/);
  });

  test('auto_secured → autoSecured outcome, nothing to insert', async () => {
    requestCardForAppointment.mockResolvedValue({ requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' });
    const r = await buildCardRequestLink(VISIT);
    expect(r.autoSecured).toBe(true);
    expect(r.url).toBeNull();
    expect(renderTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['gate_off', /APPOINTMENT_CARD_REQUEST/],
    ['unpriced_visit', /no price yet/],
    ['existing_customer', /first-time customers only/],
    ['visit_not_live:rescheduled', /not confirmed yet/],
    ['payer_billed', /third-party payer/],
    ['something_new', /something_new/],
  ])('skip %s → plain reason', async (reason, expected) => {
    requestCardForAppointment.mockResolvedValue({ requested: false, action: 'skipped', reason });
    const r = await buildCardRequestLink(VISIT);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(expected);
  });

  test('a template that dropped {secure_link} refuses (the minted URL must be in the body)', async () => {
    requestCardForAppointment.mockResolvedValue({ requested: true, action: 'link_created', reason: 'created', secureUrl: 'https://portal.wavespestcontrol.com/secure/tok22' });
    renderTemplate.mockResolvedValue('Hi Pat! Save a card please.');
    const r = await buildCardRequestLink(VISIT);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/\{secure_link\}/);
  });

  test('no picked visit → reason, the funnel is never entered', async () => {
    const r = await buildCardRequestLink(null);
    expect(r.reason).toMatch(/No upcoming appointment/);
    expect(requestCardForAppointment).not.toHaveBeenCalled();
  });
});

describe('buildPrepGuideLink', () => {
  // The post-mint key re-read (r27 P0): what the row carries after the mint.
  let keyedAfterMint = null;
  beforeEach(() => {
    nextUpcomingVisit.mockReset();
    ensureServicePrepToken.mockReset().mockResolvedValue('a'.repeat(32));
    loadTemplateByKey.mockReset().mockResolvedValue({ template: { id: 't1' }, activeVersion: { id: 'tv1' } });
    keyedAfterMint = null;
    mockBuilders = { scheduled_services: { where: jest.fn(function () { return this; }), first: jest.fn(async () => ({ prep_template_key: keyedAfterMint })) } };
  });

  test('a concurrent mint for ANOTHER guide won the unkeyed visit: the line names the guide the page renders, or refuses one the composer cannot name (GH Codex #3856 r27 P0)', async () => {
    nextUpcomingVisit.mockImplementation(async (_ids, keyword) => (
      keyword === 'flea' ? { id: 'v-flea', customer_id: 'c1', scheduled_date: '2026-09-20', prep_template_key: null, prep_expires_at: null } : null
    ));
    keyedAfterMint = 'prep.bed_bug';
    let r = await buildPrepGuideLink(['c1']);
    expect(ensureServicePrepToken).toHaveBeenCalledWith('v-flea', 'prep.flea');
    expect(r.line).toContain('Bed Bug Treatment Service');
    expect(r.line).not.toContain('Flea Treatment');
    expect(r.prep.pestType).toBe('bed_bug');

    keyedAfterMint = 'prep.wildlife';
    r = await buildPrepGuideLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/cannot name/);
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
    expect(r.reason).toMatch(/No upcoming visit of a prep-guide service/);
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

  test('a windowless same-day visit sorts AFTER a timed one, as each family\'s SQL orders it (GH Codex #3844 r12 P2)', async () => {
    nextUpcomingVisit.mockImplementation(async (_ids, keyword) => (
      keyword === 'flea'
        ? { id: 'v-flea', customer_id: 'c1', scheduled_date: '2026-09-10', window_start: null, service_type: 'Flea Treatment', prep_expires_at: null }
        : keyword === 'bed bug'
          ? { id: 'v-bb', customer_id: 'c1', scheduled_date: '2026-09-10', window_start: '09:00:00', service_type: 'Bed Bug Treatment', prep_expires_at: null }
          : null
    ));
    const r = await buildPrepGuideLink(['c1']);
    expect(ensureServicePrepToken).toHaveBeenCalledWith('v-bb', 'prep.bed_bug');
    expect(r.prep.pestType).toBe('bed_bug');
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
    // A unique tie-breaker closes the OFFSET-over-a-tie hole (GH Codex #3844 r6 P2).
    expect(mockBuilders.service_records.orderBy).toHaveBeenCalledWith([{ column: 'service_date', order: 'desc' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]);
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

describe('buildProjectReportLink', () => {
  const HELD = { id: 'p-held', customer_id: 'c1', title: 'WDO Inspection', project_type: 'wdo', project_date: '2026-09-01', report_token: 'e'.repeat(32), report_hold_status: 'held', sent_at: '2026-09-01T12:00:00Z' };
  const ISSUED = { id: 'p-ok', customer_id: 'c2', title: 'Termite Treatment', project_type: 'termite', project_date: '2026-08-10', report_token: 'f'.repeat(32), report_hold_status: null, sent_at: '2026-08-11T12:00:00Z' };

  test('the account\'s newest issued report, skipping one on a payment hold; the viewer\'s vanity path, nothing minted', async () => {
    mockBuilders = {
      projects: chainBuilder({ rows: [HELD, ISSUED], firstRow: ISSUED }),
      customers: chainBuilder({ firstRow: { first_name: 'Dana', last_name: 'Lee' } }),
    };
    const r = await buildProjectReportLink(['c1', 'c2']);
    // The scan carries eligibility columns only — projects holds multi-MB
    // blobs (wdo_signature …); the chosen project's title fields are loaded
    // once (r16 P2).
    expect(mockBuilders.projects.select).toHaveBeenCalledWith('id', 'customer_id', 'report_hold_status');
    expect(mockBuilders.projects.first).toHaveBeenCalledWith('id', 'customer_id', 'title', 'project_type', 'project_date', 'report_token', 'findings', 'wdo_sent_filings');
    expect(mockBuilders.projects.where).toHaveBeenCalledWith({ id: 'p-ok' });
    expect(mockBuilders.projects.whereIn).toHaveBeenCalledWith('customer_id', ['c1', 'c2']);
    expect(mockBuilders.projects.whereIn).toHaveBeenCalledWith('status', ['sent', 'closed']);
    // Delivery evidence too: completing a visit closes a project and mints
    // its token even when the report was never sent (GH Codex #3893 r3 P1)
    // — sent_at, the send stamp. The report email is the delivery and the
    // composer text is an operator re-share, the service report's own bar
    // (owner ruling, r17) — no per-leg SMS evidence. A migrated
    // 'legacy_sent' row stays out (owner ruling): its delivery_status is its
    // only issuance record and the send claim must never overwrite it.
    expect(mockBuilders.projects.whereNotNull).toHaveBeenCalledWith('sent_at');
    expect(mockBuilders.projects.whereRaw).toHaveBeenCalledWith("delivery_status IS DISTINCT FROM 'legacy_sent'");
    expect(mockBuilders.projects.whereNotNull).toHaveBeenCalledWith('report_token');
    // Newest issued first; ties by creation (id is a random UUID, not
    // chronological — r8 P2).
    expect(mockBuilders.projects.orderByRaw).toHaveBeenCalledWith('sent_at DESC, created_at DESC, id DESC');
    expect(mockBuilders.customers.where).toHaveBeenCalledWith({ id: 'c2' });
    expect(r.url).toBe(`https://portal.wavespestcontrol.com/report/project/dana-${'f'.repeat(12)}`);
    // The title rides the email path's type-gated fee scrub (projectTitle),
    // in the line and in the toast payload alike (GH Codex #3893 r4 P1).
    const { projectTitle } = require('../services/project-email');
    expect(projectTitle).toHaveBeenCalledWith(ISSUED);
    expect(r.line).toBe(`Here is your [safe] Termite Treatment report: ${r.url}\n\n`);
    expect(r.immediateOnly).toBe(true);
    expect(r.projectReport).toEqual({ id: 'p-ok', title: '[safe] Termite Treatment', projectType: 'termite', projectDate: '2026-08-10' });
  });

  test('no issued report (or only held ones) → reason, nothing else loaded', async () => {
    mockBuilders = { projects: chainBuilder({ rows: [HELD] }) };
    const r = await buildProjectReportLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No project report/);
    expect(mockBuilders.projects.first).not.toHaveBeenCalled();
  });
});

describe('buildContractSigningLink', () => {
  const { verifyComposerContractToken } = require('../utils/composer-contract-token');
  const MINTED = /^https:\/\/portal\.wavespestcontrol\.com\/contract\/([A-Za-z0-9_-]{69})$/;
  beforeEach(() => { createShareLink.mockReset(); });

  test('no contract awaiting signature → reason, nothing minted', async () => {
    mockBuilders = { customer_contracts: chainBuilder({ rows: [] }) };
    const r = await buildContractSigningLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No contract awaiting signature/);
  });

  test('mints the token IN MEMORY and writes nothing — the /sms send activates it (GH Codex #3844 r3 P1 + pre-push P0)', async () => {
    mockBuilders = { customer_contracts: chainBuilder({ rows: [{ id: 'k1', title: 'Auto Pay Authorization', contract_type: 'autopay_authorization', share_token_hash: 'deadbeef', share_token_expires_at: new Date(Date.now() - 1000) }] }) };
    const r = await buildContractSigningLink(['c1']);
    expect(r.url).toMatch(MINTED);
    // The token is the server's mint FOR THIS CONTRACT — the send verifies it before writing the hash.
    expect(verifyComposerContractToken('k1', r.url.match(MINTED)[1])).toBe(true);
    expect(verifyComposerContractToken('k2', r.url.match(MINTED)[1])).toBe(false);
    expect(r.line).toBe(`Please review and sign your Auto Pay Authorization here: ${r.url}\n\n`);
    expect(r.contract).toEqual({ id: 'k1', title: 'Auto Pay Authorization', requiresSignature: true });
    expect(r.immediateOnly).toBe(true);
    expect(r.expiresAt).toBeUndefined();
    expect(createShareLink).not.toHaveBeenCalled();
    expect(mockBuilders.customer_contracts.update).not.toHaveBeenCalled();
  });

  test('a delivered link whose window is still open refuses (courtesy — the send re-judges it under the row lock)', async () => {
    mockBuilders = { customer_contracts: chainBuilder({ rows: [{ id: 'k1', title: 'Auto Pay Authorization', contract_type: 'autopay_authorization', share_token_hash: 'deadbeef', share_token_expires_at: new Date(Date.now() + 86400e3) }] }) };
    const r = await buildContractSigningLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/already sent and is still live/);
  });

  test('a review-only document request (no signature) does not ask for one', async () => {
    mockBuilders = {
      customer_contracts: chainBuilder({ rows: [{ id: 'k2', title: 'Service Guide', contract_type: 'document_template', document_template_id: 'dt-svc', requires_signature_snapshot: false }] }),
      document_templates: chainBuilder({ firstRow: { category: 'service', document_type: 'customer_guide', requires_signature: false } }),
    };
    const r = await buildContractSigningLink(['c1']);
    expect(r.line).toBe(`Please review your Service Guide here: ${r.url}\n\n`);
    expect(r.contract.requiresSignature).toBe(false);
  });

  test('a marketing customer guide is never the composer\'s to send — skipped for the next signable contract, by the delivery\'s own predicate over its joined template columns (GH Codex #3844 r4 P1)', async () => {
    const guide = { id: 'g1', title: 'Product Safety Guide', contract_type: 'document_template', document_template_id: 'dt-mkt', requires_signature_snapshot: false };
    const signable = { id: 'k1', title: 'Auto Pay Authorization', contract_type: 'autopay_authorization' };
    mockBuilders = {
      customer_contracts: chainBuilder({ rows: [guide, signable] }),
      document_templates: chainBuilder({ firstRow: { category: 'marketing', document_type: 'customer_guide', requires_signature: false } }),
    };
    const r = await buildContractSigningLink(['c1']);
    expect(r.contract).toEqual({ id: 'k1', title: 'Auto Pay Authorization', requiresSignature: true });
    expect(mockBuilders.document_templates.where).toHaveBeenCalledWith({ id: 'dt-mkt' });
    expect(mockBuilders.document_templates.first).toHaveBeenCalledWith('category', 'document_type', 'requires_signature');
  });

  test('a bulk-sent guide (render summary bulkSend) is a marketing guide whatever its template says; only guides on file → the plain reason', async () => {
    mockBuilders = { customer_contracts: chainBuilder({ rows: [{ id: 'g2', title: 'Bulk Guide', contract_type: 'document_template', document_template_id: 'dt-bulk', document_render_summary: JSON.stringify({ bulkSend: true }) }] }) };
    mockBuilders.document_templates = chainBuilder({ firstRow: { category: 'service', document_type: 'customer_guide', requires_signature: true } });
    const r = await buildContractSigningLink(['c1']);
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/No contract awaiting signature/);
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
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'rep1', kind: 'service_report', target_url: 'https://portal.wavespestcontrol.com/report/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }) };
    expect(await immediateOnlyLinkSendCheck('Here is your latest service report: wavespest.co/l/rep1')).toEqual({ present: true, label: 'Service report' });
  });

  test('a project report link (vanity or full-token form) is immediate-only; the project form is not mistaken for a service report', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck(`Here is your report: portal.wavespestcontrol.com/report/project/dana-lee-${'f'.repeat(12)}`)).toEqual({ present: true, label: 'Project report' });
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/report/project/${'f'.repeat(32)}`)).toEqual({ present: true, label: 'Project report' });
    // The viewer ignores the slug — a working vanity URL with `_` / `.` in
    // it is the same report and is fenced the same (r5 P1).
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/report/project/dana_lee.jr-${'f'.repeat(12)}`)).toEqual({ present: true, label: 'Project report' });
    // An explicit http:// owned link is still a protected link (fence reads presence).
    expect(await immediateOnlyLinkSendCheck(`http://portal.wavespestcontrol.com/report/project/${'f'.repeat(32)}`)).toEqual({ present: true, label: 'Project report' });
    expect(await immediateOnlyLinkSendCheck(`evil.example/report/project/${'f'.repeat(32)}`)).toEqual({ present: false });
  });

  test('an appointment page link (branded short form of kind appointment, or the long /appointment form) is immediate-only', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'ab12cd', kind: 'appointment', target_url: 'https://portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY' } }) };
    expect(await immediateOnlyLinkSendCheck('Everything about your visit: wavespest.co/l/Ab12cD')).toEqual({ present: true, label: 'Appointment page' });
    // Codes are stored lower-case and the public resolver lowercases before
    // its lookup — a pasted mixed-case code is the same working link and must
    // be judged, not missed (GH Codex #3844 r5 P1).
    expect(mockBuilders.short_codes.where).toHaveBeenCalledWith({ code: 'ab12cd' });
    expect(await immediateOnlyLinkSendCheck('Everything about your visit: WAVESPEST.CO/L/AB12CD')).toEqual({ present: true, label: 'Appointment page' });
    expect(mockBuilders.short_codes.where).toHaveBeenLastCalledWith({ code: 'ab12cd' });
    // /l/:code is served on the portal origin too — a branded URL rewritten
    // onto the portal host is the same working link (GH Codex #3844 r6 P1).
    expect(await immediateOnlyLinkSendCheck('Everything about your visit: portal.wavespestcontrol.com/l/Ab12cD')).toEqual({ present: true, label: 'Appointment page' });
    expect(mockBuilders.short_codes.where).toHaveBeenLastCalledWith({ code: 'ab12cd' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: { kind: 'estimate' } }) };
    expect(await immediateOnlyLinkSendCheck('See it: wavespest.co/l/Ab12cD')).toEqual({ present: false });
    expect(await immediateOnlyLinkSendCheck('portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Appointment page' });
    expect(await immediateOnlyLinkSendCheck('evil.example/l/Ab12cD')).toEqual({ present: false });
  });

  test('a statement pay link and a visit-lane card request are immediate-only; a customer-kind /secure link is the Auto Pay seam\'s', async () => {
    expect(await immediateOnlyLinkSendCheck(`Pay here: portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}`)).toEqual({ present: true, label: 'Statement pay' });
    mockBuilders = { appointment_card_requests: chainBuilder({ firstRow: { kind: 'visit' } }) };
    expect(await immediateOnlyLinkSendCheck('Secure it: portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Card request' });
    expect(mockBuilders.appointment_card_requests.where).toHaveBeenCalledWith({ token: 'abcDEF123_-xyz789QWERTY' });
    mockBuilders = { appointment_card_requests: chainBuilder({ firstRow: { kind: 'customer' } }) };
    expect(await immediateOnlyLinkSendCheck('Secure it: portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY')).toEqual({ present: false });
    mockBuilders = { appointment_card_requests: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck('Secure it: portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY')).toEqual({ present: false });
  });
  const PREP = 'a'.repeat(32);

  test('a canonical contract link is present; a look-alike host or a nested URL is not', async () => {
    expect(await expiringLinkSendCheck('Sign here: portal.wavespestcontrol.com/contract/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Contract signing' });
    expect(await expiringLinkSendCheck('https://portal.wavespestcontrol.com/contract/abcDEF123_-xyz789QWERTY.')).toEqual({ present: true, label: 'Contract signing' });
    expect(await expiringLinkSendCheck('portal.wavespestcontrol.com.evil.example/contract/abcDEF123_-xyz789QWERTY')).toEqual({ present: false });
    expect(await expiringLinkSendCheck('https://evil.example/?next=portal.wavespestcontrol.com/contract/abcDEF123_-xyz789QWERTY')).toEqual({ present: false });
    expect(await expiringLinkSendCheck('Nothing to see')).toEqual({ present: false });
  });

  test('every canonical prep link is immediate-only, expiry or not — only /sms binds the page to the recipient (pre-push Codex P0)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await expiringLinkSendCheck(`Checklist: portal.wavespestcontrol.com/prep/${PREP}`)).toEqual({ present: true, label: 'Prep guide' });
    expect(mockDb).not.toHaveBeenCalledWith('scheduled_services');
    expect(await expiringLinkSendCheck(`portal.wavespestcontrol.com.evil.example/prep/${PREP}`)).toEqual({ present: false });
  });

  test('a trailing slash is the same working page — every fenced kind is still judged (GH Codex #3844 r7 P1)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'ab12cd', kind: 'appointment', target_url: 'https://portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY' } }) };
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/prep/${PREP}/`)).toEqual({ present: true, label: 'Prep guide' });
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}/`)).toEqual({ present: true, label: 'Statement pay' });
    expect(await immediateOnlyLinkSendCheck('portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY/')).toEqual({ present: true, label: 'Appointment page' });
    expect(await immediateOnlyLinkSendCheck('wavespest.co/l/Ab12cD/')).toEqual({ present: true, label: 'Appointment page' });
    expect(mockBuilders.short_codes.where).toHaveBeenLastCalledWith({ code: 'ab12cd' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/report/${'b'.repeat(32)}//`)).toEqual({ present: true, label: 'Service report' });
  });

  test('percent-encoded bearer paths are decoded ONCE for the whole body before judging — every fenced kind, long and short (pre-push Codex audit)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'ab12cd', kind: 'appointment', target_url: 'https://portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY' } }) };
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/prep/%61${PREP.slice(1)}`)).toEqual({ present: true, label: 'Prep guide' });
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/%70rep/${PREP}`)).toEqual({ present: true, label: 'Prep guide' });
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com%2Fpay%2Fstatement%2F${'f'.repeat(64)}`)).toEqual({ present: true, label: 'Statement pay' });
    expect(await immediateOnlyLinkSendCheck('portal.wavespestcontrol.com/appointment/%61bcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Appointment page' });
    expect(await immediateOnlyLinkSendCheck('wavespest.co/l/%41b12cD')).toEqual({ present: true, label: 'Appointment page' });
    expect(mockBuilders.short_codes.where).toHaveBeenLastCalledWith({ code: 'ab12cd' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com/report/%62${'b'.repeat(31)}`)).toEqual({ present: true, label: 'Service report' });
  });

  test('an explicit http:// owned bearer is a protected link the fence parks — the public mounts are protocol-agnostic (GH Codex #3844 r11 P1)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'ab12cd', kind: 'appointment', target_url: 'https://portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY' } }) };
    expect(await immediateOnlyLinkSendCheck(`http://portal.wavespestcontrol.com/prep/${PREP}`)).toEqual({ present: true, label: 'Prep guide' });
    // A visit-lane card request too (GH Codex #3851 r2 P1) — /sms refuses it for its scheme.
    mockBuilders.appointment_card_requests = chainBuilder({ firstRow: { kind: 'visit' } });
    expect(await immediateOnlyLinkSendCheck('http://portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Card request' });
    // A contract signing link too (GH Codex #3851 r1 P1) — /sms then refuses it for its scheme.
    expect(await immediateOnlyLinkSendCheck('http://portal.wavespestcontrol.com/contract/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Contract signing' });
    expect(await immediateOnlyLinkSendCheck(`http://portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}`)).toEqual({ present: true, label: 'Statement pay' });
    expect(await immediateOnlyLinkSendCheck('http://portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Appointment page' });
    expect(await immediateOnlyLinkSendCheck('http://wavespest.co/l/Ab12cD')).toEqual({ present: true, label: 'Appointment page' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck(`http://portal.wavespestcontrol.com/report/${'b'.repeat(32)}`)).toEqual({ present: true, label: 'Service report' });
    // Only http(s) is a served page; another host under http is still not ours.
    expect(await immediateOnlyLinkSendCheck(`ftp://portal.wavespestcontrol.com/prep/${PREP}`)).toEqual({ present: false });
    expect(await immediateOnlyLinkSendCheck(`http://evil.example/prep/${PREP}`)).toEqual({ present: false });
  });

  test('the fence judges a short code by its target, and parks a protected kind claim the target does not confirm (pre-push Codex P0)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'ab12cd', kind: 'other', target_url: 'https://portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY' } }) };
    expect(await immediateOnlyLinkSendCheck('See it: wavespest.co/l/Ab12cD')).toEqual({ present: true, label: 'Appointment page' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'ab12cd', kind: 'service_report', target_url: 'https://portal.wavespestcontrol.com/estimate/xyz' } }) };
    expect(await immediateOnlyLinkSendCheck('See it: wavespest.co/l/Ab12cD')).toEqual({ present: true, label: 'Service report' });
    mockBuilders = { short_codes: chainBuilder({ firstRow: { code: 'ab12cd', kind: 'other', target_url: 'https://evil.example/appointment/abcDEF123_-xyz789QWERTY' } }) };
    expect(await immediateOnlyLinkSendCheck('See it: wavespest.co/l/Ab12cD')).toEqual({ present: false });
  });

  test('long-form bearers on the branded short host are the same served pages — fenced like the portal origin (GH Codex #3844 r8 P1)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck(`wavespest.co/prep/${PREP}`)).toEqual({ present: true, label: 'Prep guide' });
    expect(await immediateOnlyLinkSendCheck(`wavespest.co/pay/statement/${'f'.repeat(64)}`)).toEqual({ present: true, label: 'Statement pay' });
    expect(await immediateOnlyLinkSendCheck('wavespest.co/appointment/abcDEF123_-xyz789QWERTY')).toEqual({ present: true, label: 'Appointment page' });
    expect(await immediateOnlyLinkSendCheck(`wavespest.co/report/${'b'.repeat(32)}`)).toEqual({ present: true, label: 'Service report' });
    expect(await immediateOnlyLinkSendCheck(`wavespest.co.evil.example/prep/${PREP}`)).toEqual({ present: false });
  });

  test('the DNS-equivalent trailing-dot host is the same served page — fenced (GH Codex #3844 r10 P1)', async () => {
    mockBuilders = { short_codes: chainBuilder({ firstRow: null }) };
    expect(await immediateOnlyLinkSendCheck(`https://portal.wavespestcontrol.com./prep/${PREP}`)).toEqual({ present: true, label: 'Prep guide' });
    expect(await immediateOnlyLinkSendCheck(`portal.wavespestcontrol.com./pay/statement/${'f'.repeat(64)}`)).toEqual({ present: true, label: 'Statement pay' });
  });
});

describe('bearerLinkSendCheck (immediate-send seam for contract + visit card links)', () => {
  const { bearerLinkSendCheck } = require('../services/composer-customer-links');
  const { hashContractToken } = jest.requireActual('../services/contracts');
  const TOKEN = 'abcDEF123_-xyz789QWERTY';
  const CONTRACT_BODY = `Please sign: portal.wavespestcontrol.com/contract/${TOKEN}`;
  const live = { id: 'k1', customer_id: 'c1', status: 'sent', share_token_expires_at: new Date(Date.now() + 86400e3) };

  function wire({ contract = live, owner = { id: 'c1', phone: '+1 (941) 555-0100' }, card = null, funnel } = {}) {
    const contracts = chainBuilder({ firstRow: contract });
    mockBuilders = {
      customer_contracts: contracts,
      customers: chainBuilder({ firstRow: owner }),
      appointment_card_requests: chainBuilder({ firstRow: card }),
      short_codes: chainBuilder({ firstRow: null }),
    };
    // The canonical funnel, re-run at the send: by default it still answers this token.
    requestCardForAppointment.mockReset().mockResolvedValue(
      funnel || { requested: false, action: 'link_created', reason: 'request_exists', secureUrl: `https://portal.wavespestcontrol.com/secure/${TOKEN}` },
    );
    return contracts;
  }

  test('nothing applies → ok', async () => {
    wire();
    expect(await bearerLinkSendCheck('Hi there, see you Tuesday.', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
  });

  test('a live contract link owned by the recipient passes and rides back as delivered; the lookup is by token HASH', async () => {
    const contracts = wire();
    expect(await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true, contracts: [{ id: 'k1', tokenHash: hashContractToken(TOKEN), delivered: true }] });
    expect(contracts.where).toHaveBeenCalledWith({ share_token_hash: hashContractToken(TOKEN) });
  });

  test('a marketing customer guide refuses however it got into the body — pasted from the Contracts page (delivered) or the composer\'s own insert (GH Codex #3844 r4 P1)', async () => {
    wire({ contract: { ...live, contract_type: 'document_template', document_template_id: 'dt-bulk', document_render_summary: { bulkSend: true } } });
    // A bulk send is a marketing guide whatever its template says.
    mockBuilders.document_templates = chainBuilder({ firstRow: { category: 'service', document_type: 'customer_guide', requires_signature: true } });
    expect((await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/customer guide.*Document Templates/);
    const { mintComposerContractToken } = require('../utils/composer-contract-token');
    const minted = mintComposerContractToken('k9');
    wire();
    mockBuilders.customer_contracts.first = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'k9', customer_id: 'c1', status: 'draft', contract_type: 'document_template', document_template_id: 'dt-mkt', requires_signature_snapshot: false });
    mockBuilders.document_templates = chainBuilder({ firstRow: { category: 'marketing', document_type: 'customer_guide', requires_signature: false } });
    expect((await bearerLinkSendCheck(`Please review: portal.wavespestcontrol.com/contract/${minted}`, '9415550100', { trustedCustomerId: 'c1', contractId: 'k9' })).error).toMatch(/customer guide.*Document Templates/);
    expect(mockBuilders.document_templates.where).toHaveBeenCalledWith({ id: 'dt-mkt' });
  });

  describe('the composer\'s own unwritten insert (no stored hash — GH Codex #3844 r3 P1 + pre-push P0)', () => {
    const { mintComposerContractToken } = require('../utils/composer-contract-token');
    const MINTED = mintComposerContractToken('k9');
    const MINTED_BODY = `Please sign: portal.wavespestcontrol.com/contract/${MINTED}`;
    function wireUnwritten(contract = { id: 'k9', customer_id: 'c1', status: 'draft' }) {
      const contracts = wire().customer_contracts || mockBuilders.customer_contracts;
      // First lookup = by hash (nothing stored); second = by the composer's contractId.
      contracts.first = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(contract);
      return contracts;
    }

    test('the composer names the contract, the token is a minted one, the owner matches → rides back for activation', async () => {
      const contracts = wireUnwritten();
      expect(await bearerLinkSendCheck(MINTED_BODY, '9415550100', { trustedCustomerId: 'c1', contractId: 'k9' })).toEqual({ ok: true, contracts: [{ id: 'k9', tokenHash: hashContractToken(MINTED), delivered: false }] });
      expect(contracts.where).toHaveBeenCalledWith({ id: 'k9' });
      expect(contracts.first).toHaveBeenCalledWith('id', 'customer_id', 'status', 'contract_type', 'document_template_id', 'document_render_summary', 'requires_signature_snapshot', 'payment_method_id');
    });

    test('an expired document request re-opens (the writer\'s own rule); an expired contract of any other type does not (pre-push Codex P1)', async () => {
      wireUnwritten({ id: 'k9', customer_id: 'c1', status: 'expired', contract_type: 'document_template' });
      expect((await bearerLinkSendCheck(MINTED_BODY, '9415550100', { trustedCustomerId: 'c1', contractId: 'k9' })).ok).toBe(true);
      wireUnwritten({ id: 'k9', customer_id: 'c1', status: 'expired', contract_type: 'autopay_authorization' });
      expect((await bearerLinkSendCheck(MINTED_BODY, '9415550100', { trustedCustomerId: 'c1', contractId: 'k9' })).error).toMatch(/expired or no longer live/);
    });

    test('no contractId (a pasted or reloaded link) refuses — nothing to activate', async () => {
      wireUnwritten();
      expect((await bearerLinkSendCheck(MINTED_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/expired or no longer live/);
    });

    test('a token that is not the server\'s mint for THIS contract refuses — the caller cannot choose the bearer (pre-push Codex P0)', async () => {
      wireUnwritten();
      expect((await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1', contractId: 'k9' })).error).toMatch(/expired or no longer live/);
      wireUnwritten();
      const other = mintComposerContractToken('k8');
      expect((await bearerLinkSendCheck(`Please sign: portal.wavespestcontrol.com/contract/${other}`, '9415550100', { trustedCustomerId: 'c1', contractId: 'k9' })).error).toMatch(/expired or no longer live/);
      wireUnwritten();
      const stale = mintComposerContractToken('k9', Math.floor(Date.now() / 1000) - 13 * 3600);
      expect((await bearerLinkSendCheck(`Please sign: portal.wavespestcontrol.com/contract/${stale}`, '9415550100', { trustedCustomerId: 'c1', contractId: 'k9' })).error).toMatch(/expired or no longer live/);
    });

    test.each([
      ['a terminal contract', { id: 'k9', customer_id: 'c1', status: 'signed' }, '9415550100', /expired or no longer live/],
      ['an unknown contract', null, '9415550100', /expired or no longer live/],
      ['a contract whose customer is not the trusted recipient', { id: 'k9', customer_id: 'c2', status: 'draft' }, '9415550100', /search dropdown/],
    ])('%s refuses', async (_label, contract, phone, msg) => {
      wireUnwritten(contract);
      expect((await bearerLinkSendCheck(MINTED_BODY, phone, { trustedCustomerId: 'c1', contractId: 'k9' })).error).toMatch(msg);
    });
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

    test('the composer line must name the guide the page renders: a mismatched label refuses, an operator-edited line is not checked (GH Codex #3856 r27 P0)', async () => {
      const mismatched = `Your prep checklist for the upcoming Rodent Service is here: portal.wavespestcontrol.com/prep/${PREP}`;
      expect((await bearerLinkSendCheck(mismatched, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/names Rodent Service but the page now shows the Flea Treatment guide/);
      const matching = `Your prep checklist for the upcoming Flea Treatment is here: https://portal.wavespestcontrol.com/prep/${PREP}`;
      expect((await bearerLinkSendCheck(matching, '9415550100', { trustedCustomerId: 'c1' })).ok).toBe(true);
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).ok).toBe(true);
    });

    test('the in-lock recheck returns the entries it resolved NOW — the post-send bookkeeping uses these, not the pre-lock ones (pre-push Codex P1 on e8b68e9cc)', async () => {
      const { recheckPrepLinks } = require('../services/composer-customer-links');
      expect(await recheckPrepLinks(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true, preps: [{ customerId: 'c1', pestType: 'flea', serviceId: null, templateKey: 'prep.flea' }] });
    });

    test('a resolving token whose guide has an active version, owned by the recipient, passes — its customer + pest ride back for the dedupe marker', async () => {
      expect(await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true, preps: [{ customerId: 'c1', pestType: 'flea', serviceId: null, templateKey: 'prep.flea' }] });
      expect(resolvePrepSource).toHaveBeenCalledWith(PREP);
      expect(loadTemplateByKey).toHaveBeenCalledWith('prep.flea');
    });

    test('a pasted prep link with no selected customer adopts the one live owner of the number (null is no trusted id — pre-push Codex P1 on r9); a selected customer who is not the owner refuses', async () => {
      mockBuilders.customers = chainBuilder({ firstRow: { id: 'c1', phone: '+1 (941) 555-0100' }, rows: [{ id: 'c1' }] });
      expect(await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: null })).toEqual({ ok: true, preps: [{ customerId: 'c1', pestType: 'flea', serviceId: null, templateKey: 'prep.flea' }], customerId: 'c1' });
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c2' })).error).toMatch(/Pick this customer/);
      expect(mockBuilders.customers.whereNull).toHaveBeenCalledWith('deleted_at');
    });

    test('a prep page whose owning customer was deleted refuses — a stale phone never authorizes the page (pre-push Codex P0)', async () => {
      mockBuilders.customers = chainBuilder({ firstRow: null, rows: [] });
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: null })).error).toMatch(/different customer/);
    });

    test('a scheduled-service prep page re-reads its visit\'s state at the send — not upcoming (or gone) refuses, upcoming passes; a project prep has no visit to check (GH Codex #3844 r14 P2)', async () => {
      const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      resolvePrepSource.mockResolvedValue({ templateKey: 'prep.flea', customerId: 'c1', viewRow: { scheduled_service_id: 'v1' } });
      for (const visit of [
        { id: 'v1', customer_id: 'c1', status: 'cancelled' },
        { id: 'v1', customer_id: 'c1', status: 'en_route' },
        { id: 'v1', customer_id: 'c1', status: 'rescheduled' },
        null,
      ]) {
        mockBuilders.scheduled_services = chainBuilder({ firstRow: visit });
        expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/visit is no longer upcoming/);
        expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ id: 'v1' });
      }
      mockBuilders.scheduled_services = chainBuilder({ firstRow: { id: 'v1', customer_id: 'c1', status: 'confirmed', scheduled_date: TOMORROW } });
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).ok).toBe(true);
      resolvePrepSource.mockResolvedValue({ templateKey: 'prep.project.termite', customerId: 'c1', viewRow: { project_id: 'p1' } });
      mockBuilders.scheduled_services = chainBuilder({ firstRow: null });
      expect((await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).ok).toBe(true);
      expect(mockBuilders.scheduled_services.where).not.toHaveBeenCalled();
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

    test('a trailing slash is the same page — the token is still bound at the send (GH Codex #3844 r7 P1)', async () => {
      expect((await bearerLinkSendCheck(`${PREP_BODY}/`, '5551234567', { trustedCustomerId: 'c1' })).error).toMatch(/different customer/);
      expect(resolvePrepSource).toHaveBeenCalledWith(PREP);
    });

    test('the long form on the branded short host is the same served page — judged, not skipped (GH Codex #3844 r8 P1)', async () => {
      expect((await bearerLinkSendCheck(`Checklist: wavespest.co/prep/${PREP}`, '5551234567', { trustedCustomerId: 'c1' })).error).toMatch(/different customer/);
      expect(resolvePrepSource).toHaveBeenCalledWith(PREP);
    });

    test('a project prep page (guide outside PREP_CONFIG) passes with no marker identity — the tagger has no replay guard for it', async () => {
      resolvePrepSource.mockResolvedValue({ templateKey: 'prep.project.termite', customerId: 'c1' });
      expect(await bearerLinkSendCheck(PREP_BODY, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
    });

    test('a non-canonical prep host refuses outright', async () => {
      expect((await bearerLinkSendCheck(`https://evil.example/?next=portal.wavespestcontrol.com/prep/${PREP}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/not on the Waves portal/);
    });
  });

  test.each([
    ['rotated/unknown token', null],
    ['signed contract', { ...live, status: 'signed' }],
    ['expired window', { ...live, share_token_expires_at: new Date(Date.now() - 1000) }],
  ])('%s → refuses as no longer live', async (_label, contract) => {
    wire({ contract });
    const r = await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired or no longer live/);
  });

  test('a contract link sent to a phone that is not the contract customer\'s refuses', async () => {
    wire({ owner: { id: 'c1', phone: '+19415550100' } });
    const r = await bearerLinkSendCheck(CONTRACT_BODY, '5551234567', { trustedCustomerId: 'c1' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different customer/);
  });

  test('a send without a trusted customer rides the seam-wide owner rule (GH Codex #3844 r9 P1): a unique live owner rides back as customerId, an ambiguous number refuses', async () => {
    const owner = { id: 'c1', phone: '+1 (941) 555-0100' };
    wire();
    mockBuilders.customers = chainBuilder({ firstRow: owner, rows: [{ id: 'c1' }] });
    expect(await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: null }))
      .toEqual({ ok: true, contracts: [{ id: 'k1', tokenHash: hashContractToken(TOKEN), delivered: true }], customerId: 'c1' });
    wire();
    mockBuilders.customers = chainBuilder({ firstRow: owner, rows: [{ id: 'c1' }, { id: 'c2' }] });
    const r = await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/search dropdown/);
  });

  test('a non-canonical contract host refuses outright', async () => {
    wire();
    const r = await bearerLinkSendCheck(`https://evil.example/?next=portal.wavespestcontrol.com/contract/${TOKEN}`, '9415550100', { trustedCustomerId: 'c1' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not on the Waves portal/);
  });

  test('a statement link: payable + active payer AP phone passes; anything else refuses', async () => {
    const STMT = 'f'.repeat(64);
    const body = `Pay here: portal.wavespestcontrol.com/pay/statement/${STMT}`;
    const wireStmt = ({ stmt, payer, owners = [] }) => {
      mockDb.mockClear();
      isEnabled.mockImplementation((g) => g === 'payerStatements');
      mockBuilders = {
        payer_statements: chainBuilder({ firstRow: stmt }),
        payers: chainBuilder({ firstRow: payer }),
        customers: chainBuilder({ rows: owners }),
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

  test('a bearer to a non-US destination refuses — the last-ten binding cannot tell +44…5550100 from the customer\'s US number (GH Codex #3844 r10 P1); plain text is unaffected', async () => {
    const STMT = 'f'.repeat(64);
    isEnabled.mockImplementation((g) => g === 'payerStatements');
    mockBuilders = {
      payer_statements: chainBuilder({ firstRow: { id: 31, payer_id: 7, status: 'sent' } }),
      payers: chainBuilder({ firstRow: { id: 7, ap_phone: '(941) 555-0100' } }),
      customers: chainBuilder({ rows: [{ id: 'c1' }] }),
    };
    expect((await bearerLinkSendCheck(`Pay here: portal.wavespestcontrol.com/pay/statement/${STMT}`, '9415550100', { trustedCustomerId: null, usDestination: false })).error).toMatch(/US number/);
    expect(await bearerLinkSendCheck('No links here', '9415550100', { trustedCustomerId: null, usDestination: false })).toEqual({ ok: true });
  });

  test('a statement to a number on file for several live customers refuses unless the send trusts one of them — never the unverified-lead policy (GH Codex #3844 r7 P1)', async () => {
    const STMT = 'f'.repeat(64);
    const body = `Pay here: portal.wavespestcontrol.com/pay/statement/${STMT}`;
    const stmt = { id: 31, payer_id: 7, status: 'sent' };
    const payer = { id: 7, ap_phone: '(941) 555-0100' };
    const wireStmt = (owners) => {
      isEnabled.mockImplementation((g) => g === 'payerStatements');
      mockBuilders = {
        payer_statements: chainBuilder({ firstRow: stmt }),
        payers: chainBuilder({ firstRow: payer }),
        customers: chainBuilder({ rows: owners }),
      };
    };
    wireStmt([{ id: 'c1' }, { id: 'c2' }]);
    expect((await bearerLinkSendCheck(body, '9415550100', { trustedCustomerId: null })).error).toMatch(/more than one customer/);
    expect(mockBuilders.customers.whereNull).toHaveBeenCalledWith('deleted_at');
    wireStmt([{ id: 'c1' }, { id: 'c2' }]);
    expect(await bearerLinkSendCheck(body, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true, statements: [31] });
    // One live row rides back for /sms to trust (r9 P1); none (the AP phone
    // is normally no customer's) stays a lead.
    wireStmt([{ id: 'c1' }]);
    expect(await bearerLinkSendCheck(body, '9415550100', { trustedCustomerId: null })).toEqual({ ok: true, statements: [31], customerId: 'c1' });
    wireStmt([]);
    expect(await bearerLinkSendCheck(body, '9415550100', { trustedCustomerId: null })).toEqual({ ok: true, statements: [31] });
  });

  test('a visit-lane /secure link: pending + owner passes, a completed row refuses, a customer-kind row is left to the Auto Pay seam', async () => {
    const secure = `Secure your visit: portal.wavespestcontrol.com/secure/${TOKEN}`;
    wire({ card: { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1', scheduled_service_id: 'v1' } });
    // The live card rides back so /sms can consume the one-text claim after a real send.
    expect(await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true, cards: [{ token: TOKEN, scheduledServiceId: 'v1', planChoice: false }] });
    wire({ card: { id: 'r1', kind: 'visit', status: 'completed', customer_id: 'c1' } });
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer live/);
    wire({ card: { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1', sent_at: new Date() } });
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/already texted/);
    wire({ card: { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1' }, owner: { id: 'c1', phone: '+15550000000' } });
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/different customer/);
    wire({ card: { id: 'r1', kind: 'customer', status: 'pending', customer_id: 'c9' } });
    expect(await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
    expect(requestCardForAppointment).not.toHaveBeenCalled();
  });

  test('a non-US destination refuses a visit card link BEFORE the stateful funnel runs — it can auto-secure the visit (pre-push Codex P1)', async () => {
    wire({ card: { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1', scheduled_service_id: 'v1' } });
    expect((await bearerLinkSendCheck(`Secure your visit: portal.wavespestcontrol.com/secure/${TOKEN}`, '9415550100', { trustedCustomerId: 'c1', usDestination: false })).error).toMatch(/only go to a US number/);
    expect(requestCardForAppointment).not.toHaveBeenCalled();
  });

  test('an http:// or look-alike /secure link refuses here in its own right — never skipped on the Auto Pay seam\'s order (GH Codex #3851 r2 P1)', async () => {
    wire({ card: { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1', scheduled_service_id: 'v1' } });
    expect((await bearerLinkSendCheck(`Secure your visit: http://portal.wavespestcontrol.com/secure/${TOKEN}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/not on the Waves portal/);
    wire({ card: { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1', scheduled_service_id: 'v1' } });
    expect((await bearerLinkSendCheck(`Secure your visit: https://evil.example/secure/${TOKEN}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/not on the Waves portal/);
    expect(requestCardForAppointment).not.toHaveBeenCalled();
  });

  test('the email twin\'s variant rides back with the claim: the funnel\'s probe over THIS request, and only while the variant template is active (GH Codex #3851 r2 P1)', async () => {
    const secure = `Secure your visit: portal.wavespestcontrol.com/secure/${TOKEN}`;
    const card = { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1', scheduled_service_id: 'v1', selected_plan: 'annual_prepay', annual_prepay_term_id: 'term-1' };
    wire({ card });
    planInviteApplies.mockReset().mockResolvedValue(true);
    renderTemplate.mockReset().mockResolvedValue('Pick a plan or save a card: {secure_link}');
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).cards).toEqual([{ token: TOKEN, scheduledServiceId: 'v1', planChoice: true }]);
    expect(planInviteApplies).toHaveBeenCalledWith('v1', card);
    expect(renderTemplate).toHaveBeenCalledWith(expect.objectContaining({ secure_link: `https://portal.wavespestcontrol.com/secure/${TOKEN}` }), 'secure_appointment_card_plans');
    wire({ card });
    renderTemplate.mockReset().mockResolvedValue(null); // variant inactive → base copy, base email
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).cards).toEqual([{ token: TOKEN, scheduledServiceId: 'v1', planChoice: false }]);
    planInviteApplies.mockReset().mockResolvedValue(false);
  });

  test('a contract the public signing page cannot complete refuses: an Auto Pay authorization whose payment method is gone (409 there), a contract on an inactive customer (410 there) — GH Codex #3851 r2 P2', async () => {
    wire({ contract: { ...live, contract_type: 'autopay_authorization', payment_method_id: 'pm-1' } });
    mockBuilders.payment_methods = chainBuilder({ firstRow: null });
    expect((await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/payment method.*no longer available/);
    expect(mockBuilders.payment_methods.where).toHaveBeenCalledWith({ id: 'pm-1', customer_id: 'c1' });
    expect(mockBuilders.payment_methods.whereNotNull).toHaveBeenCalledWith('stripe_payment_method_id');
    wire({ contract: { ...live, contract_type: 'autopay_authorization', payment_method_id: null } });
    expect((await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/payment method.*no longer available/);
    wire({ contract: { ...live, contract_type: 'autopay_authorization', payment_method_id: 'pm-1' } });
    mockBuilders.payment_methods = chainBuilder({ firstRow: { id: 'pm-1' } });
    expect((await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1' })).ok).toBe(true);
    wire({ owner: { id: 'c1', phone: '+1 (941) 555-0100', active: false } });
    expect((await bearerLinkSendCheck(CONTRACT_BODY, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/inactive customer/);
  });

  test('a visit-lane card link re-runs the canonical funnel at the send: a skip refuses with its reason, auto_secured refuses, a different token refuses', async () => {
    const secure = `Secure your visit: portal.wavespestcontrol.com/secure/${TOKEN}`;
    const card = { id: 'r1', kind: 'visit', status: 'pending', customer_id: 'c1', scheduled_service_id: 'v1' };
    wire({ card });
    await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' });
    expect(requestCardForAppointment).toHaveBeenCalledWith({ scheduledServiceId: 'v1', trigger: 'admin', delivery: 'inline' });
    wire({ card, funnel: { requested: false, action: 'skipped', reason: 'zero_price_visit' } });
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/\$0 — nothing to secure.*remove the card request link/);
    wire({ card, funnel: { requested: false, action: 'skipped', reason: 'card_hold_lane' } });
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/holds a card through its estimate/);
    wire({ card, funnel: { requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' } });
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/consented card already secures/);
    wire({ card, funnel: { requested: true, action: 'link_created', reason: 'created', secureUrl: 'https://portal.wavespestcontrol.com/secure/someOtherToken0000' } });
    expect((await bearerLinkSendCheck(secure, '9415550100', { trustedCustomerId: 'c1' })).ok).toBe(false);
  });

  test('an appointment page link refuses at the send once GATE_APPOINTMENT_PAGE is off', async () => {
    const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const prev = process.env.GATE_APPOINTMENT_PAGE;
    try {
      wire();
      mockBuilders.short_codes = chainBuilder({ firstRow: { code: 'ab12cd', kind: 'appointment', target_url: 'https://portal.wavespestcontrol.com/appointment/abcDEF123_-xyz789QWERTY' } });
      mockBuilders.scheduled_services = chainBuilder({ firstRow: { id: 'v1', customer_id: 'c1', status: 'confirmed', scheduled_date: TOMORROW } });
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
    const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const acct = (id, account_id = 'acct') => ({ id, account_id });
    function wireAccount({ recipientRows = [acct('c1')], linkCustomer = acct('c1'), visit = { id: 'v1', customer_id: 'c1' }, report = { id: 'r1', customer_id: 'c1', structured_notes: null }, shortRow = null } = {}) {
      wire();
      mockBuilders.customers = chainBuilder({ firstRow: linkCustomer, rows: recipientRows });
      // A live upcoming visit unless the case says otherwise.
      mockBuilders.scheduled_services = chainBuilder({ firstRow: visit && { status: 'confirmed', scheduled_date: TOMORROW, ...visit } });
      mockBuilders.service_records = chainBuilder({ firstRow: report });
      mockBuilders.short_codes = chainBuilder({ firstRow: shortRow });
    }
    beforeEach(() => { process.env.GATE_APPOINTMENT_PAGE = 'true'; });
    afterEach(() => { if (gate === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = gate; });

    test('the long appointment form resolves by reschedule_token; a household sibling on the same account passes', async () => {
      wireAccount({ recipientRows: [acct('c1')], linkCustomer: acct('c2'), visit: { id: 'v1', customer_id: 'c2' } });
      // The one live row on the number rides back for /sms to trust (r9 P1).
      expect(await bearerLinkSendCheck(`Details: portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: null })).toEqual({ ok: true, customerId: 'c1' });
      expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ reschedule_token: RESCHEDULE });
      expect(mockBuilders.customers.where).toHaveBeenCalledWith({ id: 'c2' });
    });

    test('the branded short form resolves through short_codes.target_url → reschedule_token, the code lower-cased as the public resolver does (GH Codex #3844 r5 P1)', async () => {
      wireAccount({ shortRow: { code: 'ab12cd', kind: 'appointment', target_url: `https://portal.wavespestcontrol.com/appointment/${RESCHEDULE}` } });
      expect(await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      expect(mockBuilders.short_codes.where).toHaveBeenCalledWith({ code: 'ab12cd' });
      expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ reschedule_token: RESCHEDULE });
    });

    test('a short code is judged by the page it opens, not its kind column (pre-push Codex P0)', async () => {
      // kind says nothing protected, target is an appointment page → bound like the long form.
      wireAccount({ recipientRows: [acct('c1')], linkCustomer: acct('c9', 'other-acct'), visit: { id: 'v1', customer_id: 'c9' },
        shortRow: { code: 'ab12cd', kind: 'other', target_url: `https://portal.wavespestcontrol.com/appointment/${RESCHEDULE}` } });
      expect((await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/appointment link/);
      expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ reschedule_token: RESCHEDULE });
      // kind claims appointment, target is not one → unverifiable, refused.
      wireAccount({ shortRow: { code: 'ab12cd', kind: 'appointment', target_url: 'https://portal.wavespestcontrol.com/estimate/xyz' } });
      expect((await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/does not open an appointment page/);
      expect(mockBuilders.scheduled_services.where).not.toHaveBeenCalled();
      wireAccount({ shortRow: { code: 'rep1', kind: 'service_report', target_url: 'https://evil.example/report/' + REPORT } });
      expect((await bearerLinkSendCheck('Report: wavespest.co/l/rep1', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/does not open a report/);
      // Neither kind nor target protected → not this seam's business.
      wireAccount({ shortRow: { code: 'est1', kind: 'estimate', target_url: 'https://portal.wavespestcontrol.com/estimate/xyz' } });
      expect(await bearerLinkSendCheck('See it: wavespest.co/l/est1', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
    });

    test('percent-encoded long and short bearers reach the seam decoded — judged, never dropped (pre-push Codex audit)', async () => {
      wireAccount({ shortRow: { code: 'ab12cd', kind: 'appointment', target_url: `https://portal.wavespestcontrol.com/appointment/${RESCHEDULE}` } });
      expect(await bearerLinkSendCheck('Your visit: wavespest.co/l/%41b12cD', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      expect(mockBuilders.short_codes.where).toHaveBeenCalledWith({ code: 'ab12cd' });
      expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ reschedule_token: RESCHEDULE });
      wireAccount({ recipientRows: [acct('c1')], linkCustomer: acct('c9', 'other'), visit: { id: 'v1', customer_id: 'c9' } });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/%65${RESCHEDULE.slice(1)}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/appointment link/);
    });

    test('an http:// short link is judged at the send and refused for its scheme — never dropped unseen (GH Codex #3844 r12 P1)', async () => {
      wireAccount({ shortRow: { code: 'ab12cd', kind: 'appointment', target_url: `https://portal.wavespestcontrol.com/appointment/${RESCHEDULE}` } });
      expect((await bearerLinkSendCheck('Your visit: http://wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/uses http:\/\//);
      expect(mockBuilders.short_codes.where).toHaveBeenCalledWith({ code: 'ab12cd' });
      expect(mockBuilders.scheduled_services.where).not.toHaveBeenCalled();
    });

    test('an expired short link refuses — /l/:code answers 410 past expires_at even while the visit or report still exists (pre-push Codex P1)', async () => {
      const gone = new Date(Date.now() - 60_000).toISOString();
      wireAccount({ shortRow: { code: 'ab12cd', kind: 'appointment', target_url: `https://portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, expires_at: gone } });
      expect((await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/appointment link has expired/);
      expect(mockBuilders.scheduled_services.where).not.toHaveBeenCalled();
      wireAccount({ shortRow: { code: 'rep1', kind: 'service_report', target_url: `https://portal.wavespestcontrol.com/report/${REPORT}`, expires_at: gone } });
      expect((await bearerLinkSendCheck('Report: wavespest.co/l/rep1', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/service report link has expired/);
      // Still live (future expiry, or none) passes as before.
      wireAccount({ shortRow: { code: 'ab12cd', kind: 'appointment', target_url: `https://portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, expires_at: new Date(Date.now() + 60_000).toISOString() } });
      expect(await bearerLinkSendCheck('Your visit: wavespest.co/l/Ab12cD', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
    });

    test('the appointment seam re-runs the page\'s state NOW — cancelled, completed, pending rebook, elapsed, or dispatch-owned unreviewed refuses (pre-push Codex P1)', async () => {
      const link = `portal.wavespestcontrol.com/appointment/${RESCHEDULE}`;
      for (const visit of [
        { id: 'v1', customer_id: 'c1', status: 'cancelled' },
        { id: 'v1', customer_id: 'c1', status: 'completed' },
        { id: 'v1', customer_id: 'c1', status: 'rescheduled' },
        { id: 'v1', customer_id: 'c1', status: 'en_route' },
        { id: 'v1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2020-01-01', window_start: '09:00' },
        { id: 'v1', customer_id: 'c1', status: 'pending', source_action: require('../services/call-booking-source-actions').DISPATCH_OWNED_PENDING_SOURCE_ACTIONS[0], customer_confirmed: false },
      ]) {
        wireAccount({ visit });
        expect((await bearerLinkSendCheck(link, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer upcoming/);
      }
      wireAccount({ visit: { id: 'v1', customer_id: 'c1', status: 'pending', source_action: require('../services/call-booking-source-actions').DISPATCH_OWNED_PENDING_SOURCE_ACTIONS[0], customer_confirmed: true } });
      expect(await bearerLinkSendCheck(link, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
    });

    test('a GROUPED visit is judged by the stop\'s state, as the page renders it — a sibling in pending rebook or underway, or an unreadable membership, refuses (GH Codex #3844 r13 P1)', async () => {
      const appointmentPublic = require('../routes/appointment-public');
      const spy = jest.spyOn(appointmentPublic, 'pageStateForVisit');
      try {
        const link = `portal.wavespestcontrol.com/appointment/${RESCHEDULE}`;
        for (const state of ['pending_rebook', 'in_progress', 'not_available']) {
          spy.mockResolvedValueOnce({ state, phase: null });
          wireAccount({ visit: { id: 'v1', customer_id: 'c1', visit_id: 'grp-1' } });
          expect((await bearerLinkSendCheck(link, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer upcoming/);
          expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'v1', visit_id: 'grp-1' }));
        }
        spy.mockResolvedValueOnce({ state: 'upcoming', phase: null });
        wireAccount({ visit: { id: 'v1', customer_id: 'c1', visit_id: 'grp-1' } });
        expect(await bearerLinkSendCheck(link, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      } finally {
        spy.mockRestore();
      }
    });

    test('a visit whose owning customer was deleted refuses — the public route 404s it, and a live sibling on the account must not be texted a dead link (pre-push Codex P1)', async () => {
      wireAccount({ linkCustomer: null, visit: { id: 'v1', customer_id: 'c-gone' } });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer resolves/);
      expect(mockBuilders.customers.where).toHaveBeenCalledWith({ id: 'c-gone' });
      expect(mockBuilders.customers.whereNull).toHaveBeenCalledWith('deleted_at');
    });

    test('a number on file for more than one ACCOUNT is ambiguous: no trusted customer → refuses (the insert route 409s the same); a trusted customer names the account → passes (GH Codex #3844 r6 P1)', async () => {
      wireAccount({ recipientRows: [acct('c1', 'acct-a'), acct('c2', 'acct-b')], linkCustomer: acct('c1', 'acct-a') });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: null })).error).toMatch(/more than one customer account/);
      wireAccount({ recipientRows: [acct('c1', 'acct-a'), acct('c2', 'acct-b')], linkCustomer: acct('c1', 'acct-a') });
      expect(await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
    });

    test('a pasted bearer to a number two SAME-account siblings share refuses with no trusted customer — never an arbitrary row\'s consent (GH Codex #3844 r9 P1); a trusted sibling passes', async () => {
      wireAccount({ recipientRows: [acct('c1'), acct('c2')], linkCustomer: acct('c1') });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: null })).error).toMatch(/more than one customer — pick/);
      wireAccount({ recipientRows: [acct('c1'), acct('c2')], linkCustomer: acct('c1') });
      expect(await bearerLinkSendCheck(`portal.wavespestcontrol.com/appointment/${RESCHEDULE}`, '9415550100', { trustedCustomerId: 'c2' })).toEqual({ ok: true });
      // No bearer in the body → the owner rule never reads a row.
      wireAccount({ recipientRows: [acct('c1'), acct('c2')] });
      expect(await bearerLinkSendCheck('Plain text, no links', '9415550100', { trustedCustomerId: null })).toEqual({ ok: true });
      expect(mockBuilders.customers.select).not.toHaveBeenCalled();
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
      wireAccount({ shortRow: { code: 'rep1', kind: 'service_report', target_url: `https://portal.wavespestcontrol.com/report/${REPORT}` } });
      expect(await bearerLinkSendCheck('Report: wavespest.co/l/rep1', '9415550100', { trustedCustomerId: 'c1' })).toEqual({ ok: true });
      expect(mockBuilders.service_records.where).toHaveBeenCalledWith({ report_view_token: REPORT });
    });

    test('a suppressed typed report, a vanished record, or another account\'s report refuses', async () => {
      wireAccount({ report: { id: 'r1', customer_id: 'c1', structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }) } });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/${REPORT}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
      wireAccount({ report: null });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/${REPORT}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
      wireAccount({ linkCustomer: acct('c9', 'other'), report: { id: 'r1', customer_id: 'c9', structured_notes: null } });
      expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/${REPORT}`, '9415550100', { trustedCustomerId: null })).error).toMatch(/different customer/);
    });

    describe('project report links resolve as the viewer does and bind to the account', () => {
      const FULL = 'f'.repeat(32);
      const project = (over = {}) => ({ id: 'p1', customer_id: 'c1', status: 'closed', sent_at: '2026-08-11T12:00:00Z', report_token: FULL, report_hold_status: null, ...over });
      function wireProject({ full = project(), byPrefix = [project()], ...account } = {}) {
        wireAccount(account);
        mockBuilders.projects = chainBuilder({ firstRow: full, rows: byPrefix });
      }

      // The verified report rides back for the send flow's delivery claim
      // (claimProjectReportSends), keyed to the delivery state seen (r11 P1).
      const OK = (deliveryStatus = null) => ({ ok: true, projectReports: [{ id: 'p1', deliveryStatus }] });

      test('the full-token form resolves by report_token; the vanity form by its 12-hex prefix, exactly one match', async () => {
        wireProject();
        expect(await bearerLinkSendCheck(`Report: portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).toEqual(OK());
        expect(mockBuilders.projects.where).toHaveBeenCalledWith({ report_token: FULL });
        // Eligibility columns only, never `*` (r16 P2).
        const LINK_COLUMNS = ['id', 'customer_id', 'status', 'sent_at', 'delivery_status', 'report_token', 'report_hold_status'];
        expect(mockBuilders.projects.first).toHaveBeenCalledWith(...LINK_COLUMNS);
        // The service-report seam never sees the project run.
        expect(mockBuilders.service_records.where).not.toHaveBeenCalled();
        wireProject();
        expect(await bearerLinkSendCheck(`Report: portal.wavespestcontrol.com/report/project/dana-lee-${FULL.slice(0, 12)}`, '9415550100', { trustedCustomerId: 'c1' })).toEqual(OK());
        expect(await bearerLinkSendCheck(`Report: portal.wavespestcontrol.com/report/project/dana_lee.jr-${FULL.slice(0, 12)}`, '9415550100', { trustedCustomerId: 'c1' })).toEqual(OK());
        expect(mockBuilders.projects.where).toHaveBeenCalledWith('report_token', 'like', `${FULL.slice(0, 12)}%`);
        expect(mockBuilders.projects.select).toHaveBeenCalledWith(LINK_COLUMNS);
        expect(mockBuilders.projects.limit).toHaveBeenCalledWith(2);
        // The verified delivery state rides back for the claim.
        wireProject({ full: project({ delivery_status: 'sent' }) });
        expect(await bearerLinkSendCheck(`Report: portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).toEqual(OK('sent'));
      });

      test('an ambiguous prefix, a vanished project, a payment-held report, or another account\'s report refuses', async () => {
        wireProject({ byPrefix: [project(), project({ id: 'p2' })] });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/dana-${FULL.slice(0, 12)}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
        wireProject({ full: null });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
        // A tokened but unissued (draft) project — a /send that failed after
        // stamping the token — is not a report to text (GH Codex #3893 r1 P1).
        wireProject({ full: project({ status: 'draft' }) });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
        // Closed by a visit completion but never sent (report_not_sent) —
        // the token exists, the report was not issued (GH Codex #3893 r3 P1).
        wireProject({ full: project({ sent_at: null }) });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
        // Issued by EMAIL only is still issued — the report email is the
        // delivery and the text is an operator re-share, the service
        // report's own bar (owner ruling, r17).
        wireProject({ full: project({ delivery_status: 'partial', delivery_channels: { email: { ok: true }, sms: { ok: false, error: 'no phone on file' } } }) });
        expect(await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).toEqual(OK('partial'));
        // A migrated 'legacy_sent' delivery stays out (owner ruling) —
        // with or without a sent_at — so the send claim never overwrites
        // the only record that it was issued.
        wireProject({ full: project({ sent_at: null, delivery_status: 'legacy_sent' }) });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
        wireProject({ full: project({ delivery_status: 'legacy_sent' }) });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/no longer viewable/);
        wireProject({ full: project({ report_hold_status: 'held' }) });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/payment hold/);
        wireProject({ full: project({ customer_id: 'c9' }), linkCustomer: acct('c9', 'other') });
        expect((await bearerLinkSendCheck(`portal.wavespestcontrol.com/report/project/${FULL}`, '9415550100', { trustedCustomerId: null })).error).toMatch(/different customer/);
        // A look-alike host or a non-report segment is not ours.
        wireProject();
        expect((await bearerLinkSendCheck(`https://evil.example/report/project/${FULL}`, '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/not on the Waves portal/);
        expect((await bearerLinkSendCheck('portal.wavespestcontrol.com/report/project/just-a-slug', '9415550100', { trustedCustomerId: 'c1' })).error).toMatch(/not on the Waves portal/);
      });
    });
  });

  test('markPrepGuidesSent writes the tagger\'s replay-guard marker (sms_outbound + "<pest> prep info sent") per verified prep page (GH Codex #3844 r8 P2)', async () => {
    const insert = jest.fn(async () => [1]);
    const stamp = { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), update: jest.fn(async () => 1) };
    mockBuilders = { customer_interactions: { insert }, scheduled_services: stamp };
    mockDb.fn = { now: () => 'NOW()' };
    await markPrepGuidesSent([
      { customerId: 'c1', pestType: 'flea', serviceId: 'svc-1', templateKey: 'prep.flea' },
      // A second visit of the same customer + pest: stamped too, marker once.
      { customerId: 'c1', pestType: 'flea', serviceId: 'svc-2', templateKey: 'prep.flea' },
      { customerId: 'c2', pestType: 'bed_bug', serviceId: null, templateKey: 'prep.bed_bug' },
    ], 'admin-9');
    // The texted visit page is stamped delivered (the fence every release
    // predicate honours), conditional on the key that rendered — only the
    // prep that carried a visit (pre-push Codex P1 on d5c33f299).
    expect(stamp.where).toHaveBeenCalledTimes(2);
    expect(stamp.where).toHaveBeenCalledWith({ id: 'svc-1', prep_template_key: 'prep.flea' });
    expect(stamp.where).toHaveBeenCalledWith({ id: 'svc-2', prep_template_key: 'prep.flea' });
    expect(stamp.whereNull).toHaveBeenCalledWith('prep_sent_at');
    expect(stamp.update).toHaveBeenCalledWith({ prep_sent_at: expect.anything() });
    expect(stamp.update.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0]);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'c1', interaction_type: 'sms_outbound', subject: 'flea prep info sent', admin_user_id: 'admin-9' }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'c2', subject: 'bed_bug prep info sent' }));
    // The texted guide is the prep delivery: the customer's live step-0
    // enrolment for that sequence is settled once per customer + pest, as
    // the manual sender does — the runner consults neither the stamp nor
    // the marker (GH Codex #3856 r30 P1).
    const { settleHeldEnrollment } = require('../services/prep-guide-sender');
    expect(settleHeldEnrollment).toHaveBeenCalledTimes(2);
    expect(settleHeldEnrollment).toHaveBeenCalledWith('c1', 'prep.flea');
    expect(settleHeldEnrollment).toHaveBeenCalledWith('c2', 'prep.bed_bug');
  });

  test('markPrepGuidesSent settles the enrolment BEFORE the replay marker, and a failed marker insert neither skips the settle nor aborts the batch (GH Codex #3856 r31 P1)', async () => {
    const { settleHeldEnrollment } = require('../services/prep-guide-sender');
    settleHeldEnrollment.mockClear();
    const insert = jest.fn(async () => { throw new Error('customer_interactions down'); });
    const stamp = { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), update: jest.fn(async () => 1) };
    mockBuilders = { customer_interactions: { insert }, scheduled_services: stamp };
    mockDb.fn = { now: () => 'NOW()' };
    await expect(markPrepGuidesSent([
      { customerId: 'c1', pestType: 'flea', serviceId: 'svc-1', templateKey: 'prep.flea' },
      { customerId: 'c2', pestType: 'cockroach', serviceId: 'svc-2', templateKey: 'prep.cockroach' },
    ], 'admin-9')).resolves.toBeUndefined();
    // Both customers' live step-0 enrolments are settled — the duplicate-send
    // fence does not ride on the audit write — and the settle ran first.
    expect(settleHeldEnrollment).toHaveBeenCalledTimes(2);
    expect(settleHeldEnrollment).toHaveBeenCalledWith('c1', 'prep.flea');
    expect(settleHeldEnrollment).toHaveBeenCalledWith('c2', 'prep.cockroach');
    expect(settleHeldEnrollment.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0]);
    expect(insert).toHaveBeenCalledTimes(2);
    // The delivered-page stamp still lands for each visit.
    expect(stamp.update).toHaveBeenCalledTimes(2);
  });

  test('markStatementsSent goes through the email delivery\'s own finalized → sent writer, per statement', async () => {
    const { markStatementSent } = require('../services/payer-statement-email');
    await markStatementsSent([31, 52]);
    expect(markStatementSent).toHaveBeenCalledWith(31);
    expect(markStatementSent).toHaveBeenCalledWith(52);
  });

  describe('project report send claim (the project send flow\'s own delivery claim, taken by the composer send — GH Codex #3893 r10 + r11 P1)', () => {
    beforeEach(() => { mockDb.fn = { now: () => 'NOW()' }; });
    const claimUpdate = (projects) => projects.update.mock.calls;

    test('claim: the flow\'s conditional UPDATE keyed to the delivery state the seam saw — a stamped state, none, or a STALE claim it may take over', async () => {
      const projects = chainBuilder();
      mockBuilders = { projects };
      const r = await claimProjectReportSends([{ id: 'p1', deliveryStatus: 'sent' }, { id: 'p2', deliveryStatus: null }, { id: 'p3', deliveryStatus: 'sending' }]);
      expect(r.ok).toBe(true);
      expect(projects.where).toHaveBeenCalledWith({ id: 'p1' });
      expect(projects.where).toHaveBeenCalledWith({ delivery_status: 'sent' });
      expect(projects.whereNull).toHaveBeenCalledWith('delivery_status');
      expect(projects.whereRaw).toHaveBeenCalledWith("delivery_status = 'sending' AND updated_at < now() - interval '10 minutes'");
      expect(claimUpdate(projects)).toHaveLength(3);
      expect(claimUpdate(projects)[0][0]).toEqual({ delivery_status: 'sending', delivery_claim_token: expect.stringMatching(/^[a-f0-9]{24}$/), updated_at: 'NOW()' });
      // The hand-back target: the state seen, or 'failed' for a stale claim
      // taken over — the flow's own normalization of a crashed send.
      expect(r.claim.projects.map((p) => p.previousStatus)).toEqual(['sent', null, 'failed']);
      expect(new Set(r.claim.projects.map((p) => p.token)).size).toBe(3);
    });

    test('claim: the same report linked twice (vanity + full form, a repeated URL) is ONE claim, not a self-competing second one (pre-push Codex P1)', async () => {
      const projects = chainBuilder();
      mockBuilders = { projects };
      const r = await claimProjectReportSends([{ id: 'p1', deliveryStatus: 'sent' }, { id: 'p1', deliveryStatus: 'sent' }, { id: 'p2', deliveryStatus: 'closed' }]);
      expect(r.ok).toBe(true);
      expect(claimUpdate(projects)).toHaveLength(2);
      expect(r.claim.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    test('claim lost (the flow is sending right now, or the state moved): every claim this call won is handed back, token-guarded, and the send refuses', async () => {
      const projects = chainBuilder();
      projects.update.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      mockBuilders = { projects };
      const r = await claimProjectReportSends([{ id: 'p1', deliveryStatus: 'sent' }, { id: 'p2', deliveryStatus: 'closed' }]);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/being re-sent right now/);
      const token = claimUpdate(projects)[0][0].delivery_claim_token;
      expect(projects.where).toHaveBeenCalledWith({ id: 'p1', delivery_status: 'sending', delivery_claim_token: token });
      expect(claimUpdate(projects)[2][0]).toEqual({ delivery_status: 'sent', delivery_claim_token: null, updated_at: 'NOW()' });
    });

    test('claim: an UPDATE that throws hands back the claims already won before the error surfaces', async () => {
      const projects = chainBuilder();
      projects.update.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('connection reset'));
      mockBuilders = { projects };
      await expect(claimProjectReportSends([{ id: 'p1', deliveryStatus: 'sent' }, { id: 'p2', deliveryStatus: 'sent' }])).rejects.toThrow('connection reset');
      expect(claimUpdate(projects)).toHaveLength(3);
      expect(claimUpdate(projects)[2][0]).toMatchObject({ delivery_status: 'sent', delivery_claim_token: null });
    });

    test('release: restores the delivery state this claim replaced, only where the row still carries this claim', async () => {
      const projects = chainBuilder();
      mockBuilders = { projects };
      await releaseProjectReportSends({ projects: [{ id: 'p1', token: 't1', previousStatus: 'partial' }, { id: 'p3', token: 't3', previousStatus: 'failed' }] });
      expect(projects.where).toHaveBeenCalledWith({ id: 'p1', delivery_status: 'sending', delivery_claim_token: 't1' });
      expect(projects.update).toHaveBeenCalledWith({ delivery_status: 'partial', delivery_claim_token: null, updated_at: 'NOW()' });
      expect(projects.where).toHaveBeenCalledWith({ id: 'p3', delivery_status: 'sending', delivery_claim_token: 't3' });
      expect(projects.update).toHaveBeenCalledWith({ delivery_status: 'failed', delivery_claim_token: null, updated_at: 'NOW()' });
    });
  });

  describe('card request send claim (the service\'s own one-text mechanics, run by the composer send)', () => {
    const cards = [{ token: TOKEN, scheduledServiceId: 'v1' }, { token: 'tok2ABCDEF_-0123456789', scheduledServiceId: 'v2' }];

    const pendingRows = { v1: { status: 'pending', token: TOKEN, sent_at: null }, v2: { status: 'pending', token: 'tok2ABCDEF_-0123456789', sent_at: null } };
    function wireRequests(rows = pendingRows) {
      const requests = chainBuilder();
      requests.first = jest.fn(async () => rows[requests.where.mock.calls.at(-1)[0].scheduled_service_id] ?? null);
      return requests;
    }

    test('claim: each visit through the service\'s own claim (NULL → stamp, else stale-lease adoption), one stamp; both won → the claim rides back', async () => {
      claimCardLinkSend.mockReset().mockResolvedValue(true);
      mockBuilders = { scheduled_services: chainBuilder(), appointment_card_requests: wireRequests() };
      const r = await claimCardRequestSends(cards);
      expect(r.ok).toBe(true);
      expect(r.claim.cards).toEqual(cards);
      expect(claimCardLinkSend).toHaveBeenCalledWith('v1', r.claim.stamp, TOKEN);
      expect(claimCardLinkSend).toHaveBeenCalledWith('v2', r.claim.stamp, cards[1].token);
    });

    test('claim: the request row is re-read UNDER the claim — a capture completed, a rotated token or a text that went out meanwhile releases the claim and refuses (pre-push Codex P1)', async () => {
      for (const [row, msg] of [
        [{ status: 'completed', token: TOKEN, sent_at: null }, /no longer live/],
        [{ status: 'pending', token: 'rotatedTOKEN_0123456789', sent_at: null }, /no longer live/],
        [{ status: 'pending', token: TOKEN, sent_at: new Date() }, /already being sent, or was already texted/],
        [null, /no longer live/],
      ]) {
        claimCardLinkSend.mockReset().mockResolvedValue(true);
        const visits = chainBuilder();
        mockBuilders = { scheduled_services: visits, appointment_card_requests: wireRequests({ ...pendingRows, v2: row }) };
        const r = await claimCardRequestSends(cards);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(msg);
        // Both claims this call won are released, value-guarded on the stamp.
        expect(visits.where).toHaveBeenCalledWith({ id: 'v1', card_link_sent_at: expect.any(Date) });
        expect(visits.where).toHaveBeenCalledWith({ id: 'v2', card_link_sent_at: expect.any(Date) });
        expect(visits.update).toHaveBeenCalledTimes(2);
      }
    });

    test('claim: the post-claim read THROWING releases every claim this call won before the error surfaces (GH Codex #3851 r3 P2)', async () => {
      claimCardLinkSend.mockReset().mockResolvedValue(true);
      const visits = chainBuilder();
      const requests = wireRequests();
      requests.first = jest.fn(async () => { if (requests.where.mock.calls.at(-1)[0].scheduled_service_id === 'v2') throw new Error('connection reset'); return pendingRows.v1; });
      mockBuilders = { scheduled_services: visits, appointment_card_requests: requests };
      await expect(claimCardRequestSends(cards)).rejects.toThrow('connection reset');
      expect(visits.where).toHaveBeenCalledWith({ id: 'v1', card_link_sent_at: expect.any(Date) });
      expect(visits.where).toHaveBeenCalledWith({ id: 'v2', card_link_sent_at: expect.any(Date) });
      expect(visits.update).toHaveBeenCalledTimes(2);
    });

    test('claim: a visit already claimed refuses and hands back the claims won before it', async () => {
      claimCardLinkSend.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const visits = chainBuilder();
      mockBuilders = { scheduled_services: visits, appointment_card_requests: wireRequests() };
      const r = await claimCardRequestSends(cards);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/already being sent, or was already texted/);
      // The value-guarded release of v1 — the only claim this call won.
      expect(visits.where).toHaveBeenCalledWith({ id: 'v1', card_link_sent_at: expect.any(Date) });
      expect(visits.update).toHaveBeenCalledTimes(1);
      expect(visits.update.mock.calls[0][0]).toEqual(expect.objectContaining({ card_link_sent_at: null }));
    });

    test('release: value-guarded on this claim\'s own stamp', async () => {
      mockBuilders = { scheduled_services: chainBuilder() };
      const stamp = new Date();
      await releaseCardRequestSends({ stamp, cards: [cards[0]] });
      expect(mockBuilders.scheduled_services.where).toHaveBeenCalledWith({ id: 'v1', card_link_sent_at: stamp });
      expect(mockBuilders.scheduled_services.update.mock.calls[0][0]).toEqual(expect.objectContaining({ card_link_sent_at: null }));
    });

    test('mark: delegates every visit to the service\'s own finalizer (retries + park + office alert live there), starts the email twin the way the service does, and reports a marker that did not land', async () => {
      const stamp = new Date();
      const visits = { v1: { id: 'v1', customer_id: 'c1', service_type: 'Flea Treatment', scheduled_date: '2026-09-08' }, v2: { id: 'v2', customer_id: 'c1', service_type: 'Bed Bug Treatment', scheduled_date: '2026-09-09' } };
      const visitsBuilder = chainBuilder();
      visitsBuilder.first = jest.fn(async () => visits[visitsBuilder.where.mock.calls.at(-1)[0].id]);
      mockBuilders = { scheduled_services: visitsBuilder };
      markCardLinkSendOutcome.mockReset().mockResolvedValue(true);
      startInvitationEmailLeg.mockReset();
      expect(await markCardRequestSends({ stamp, cards })).toBe(true);
      expect(markCardLinkSendOutcome).toHaveBeenCalledWith('v1', stamp);
      expect(markCardLinkSendOutcome).toHaveBeenCalledWith('v2', stamp);
      // The email twin (owner delivery rule: both channels — GH Codex #3844
      // r5 P1): the funnel's own leg, the base variant the composer inserted.
      expect(startInvitationEmailLeg).toHaveBeenCalledWith({ visit: visits.v1, secureUrl: `https://portal.wavespestcontrol.com/secure/${TOKEN}`, planChoice: false });
      expect(startInvitationEmailLeg).toHaveBeenCalledWith({ visit: visits.v2, secureUrl: `https://portal.wavespestcontrol.com/secure/${cards[1].token}`, planChoice: false });
      markCardLinkSendOutcome.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      startInvitationEmailLeg.mockReset();
      expect(await markCardRequestSends({ stamp, cards })).toBe(false);
      expect(markCardLinkSendOutcome).toHaveBeenCalledTimes(2); // never short-circuits — every claimed visit is finalized
      expect(startInvitationEmailLeg).toHaveBeenCalledTimes(2); // the text went out either way — so does its twin
      // The AMBIGUOUS provider outcome: marker lands, no twin (GH Codex #3851 r4 P1).
      markCardLinkSendOutcome.mockReset().mockResolvedValue(true);
      startInvitationEmailLeg.mockReset();
      expect(await markCardRequestSends({ stamp, cards }, { emailTwin: false })).toBe(true);
      expect(markCardLinkSendOutcome).toHaveBeenCalledTimes(2);
      expect(startInvitationEmailLeg).not.toHaveBeenCalled();
    });

    test('mark: a marker that throws, or a visit read that fails for one email twin, never leaves a later claim unfinalized (GH Codex #3851 r1 P1)', async () => {
      const stamp = new Date();
      const visitsBuilder = chainBuilder();
      // v1's visit read fails (transient) — v2 still marks and still gets its twin.
      visitsBuilder.first = jest.fn(async () => {
        const id = visitsBuilder.where.mock.calls.at(-1)[0].id;
        if (id === 'v1') throw new Error('connection reset');
        return { id, customer_id: 'c1', service_type: 'Bed Bug Treatment', scheduled_date: '2026-09-09' };
      });
      mockBuilders = { scheduled_services: visitsBuilder };
      markCardLinkSendOutcome.mockReset().mockResolvedValue(true);
      startInvitationEmailLeg.mockReset();
      expect(await markCardRequestSends({ stamp, cards })).toBe(true);
      expect(markCardLinkSendOutcome).toHaveBeenCalledWith('v1', stamp);
      expect(markCardLinkSendOutcome).toHaveBeenCalledWith('v2', stamp);
      expect(startInvitationEmailLeg).toHaveBeenCalledTimes(1);
      expect(startInvitationEmailLeg).toHaveBeenCalledWith(expect.objectContaining({ visit: expect.objectContaining({ id: 'v2' }) }));
      // A marker that THROWS for v1 reports not-all-marked and still finalizes v2.
      markCardLinkSendOutcome.mockReset().mockRejectedValueOnce(new Error('deadlock')).mockResolvedValueOnce(true);
      startInvitationEmailLeg.mockReset();
      expect(await markCardRequestSends({ stamp, cards })).toBe(false);
      expect(markCardLinkSendOutcome).toHaveBeenCalledTimes(2);
    });
  });
});
