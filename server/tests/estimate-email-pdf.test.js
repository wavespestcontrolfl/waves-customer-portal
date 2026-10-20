// GATE_ESTIMATE_EMAIL_PDF (owner ask 2026-10-19): the estimate PDF rides on
// open-estimate emails. Covers the attachment builder, the follow-up helper
// and the follow-up send path (sendDualChannel) with the real allowlist.
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  billingEmailDetailsLive: () => false,
}));
jest.mock('../services/admin-estimate-persistence', () => ({ staleCallLinkageReason: jest.fn(async () => null) }));
jest.mock('../utils/estimate-claim-sql', () => ({
  estimateOffCustomerSurface: jest.fn(() => false),
  callSideBlockForEstimateData: jest.fn(async () => null),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: (s) => String(s || ''),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => null) }));
jest.mock('../services/estimate-service-lines', () => ({ inferEstimateServiceInterest: jest.fn(() => '') }));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({ eligible: false })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));
jest.mock('../services/estimate-conversion-guard', () => ({ customerConvertedSince: jest.fn(async () => ({ converted: false })) }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => null) }));
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: jest.fn(() => true),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
  resolveEstimateInvoiceMode: jest.fn(() => false),
  matchAcceptCustomerByPhone: jest.fn(async () => ({ match: null })),
  buildPricingBundle: jest.fn(async () => ({})),
  resolveEstimateQuoteRequirement: jest.fn(() => ({ quoteRequired: false })),
  estimateTrenchingReviewRequired: jest.fn(() => false),
  reconcileFrozenMembershipSnapshot: jest.fn(async () => {}),
  resolveAcceptOneTimeTotal: jest.fn(() => 149),
  commercialAcceptDepositExempt: jest.fn(() => false),
  isCommercialAutoAcceptEstimate: jest.fn(() => false),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  commercialLowConfidenceRange: jest.fn(() => ({ hasLowConfidence: false, forceSiteQuote: false })),
}));
jest.mock('../services/payment-method-consents', () => ({ findConsentedChargeableCard: jest.fn(async () => null) }));
jest.mock('../services/recurring-card-on-file', () => ({ resolveRecurringCardPolicyForEstimate: jest.fn(async () => ({ required: true })) }));
jest.mock('../services/estimate-card-holds', () => ({ resolveCardHoldPolicy: jest.fn(() => ({ required: true })) }));
jest.mock('../services/estimate-membership-context', () => ({ buildEstimateMembershipContext: jest.fn(async () => ({})) }));
jest.mock('../services/service-report/pdf-puppeteer', () => ({
  launchBrowser: jest.fn(),
  serviceReportPublicBase: jest.fn(() => 'https://portal.example.test'),
}));

const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const EmailTemplateLibrary = require('../services/email-template-library');
const pdf = require('../services/pdf/estimate-doc-pdf');
const { openEstimateEmailPdf, ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS } = require('../services/estimate-email-pdf');
const { _private } = require('../services/estimate-follow-up');

const setGates = (on) => featureGates.isEnabled.mockImplementation((name) => on && (name === 'estimateEmailPdf' || name === 'estimateDocPdf'));
const ESTIMATE = { id: '8f1c2d3e-aaaa-bbbb-cccc-1234567890ab', token: 'tok_synthetic', estimate_slug: 'EST-2026-0512', customer_name: 'Synthetic Customer' };

describe('buildEstimateEmailPdfAttachment', () => {
  const pdfBytes = Buffer.from('%PDF-synthetic');
  const noSleep = jest.fn(async () => {});
  beforeEach(() => { jest.clearAllMocks(); setGates(true); });

  test('returns a SendGrid attachment named by the estimate number, with no customer name', async () => {
    const render = jest.fn(async () => pdfBytes);
    const out = await pdf.buildEstimateEmailPdfAttachment(ESTIMATE, { validThrough: new Date('2099-01-01T00:00:00Z'), render, sleep: noSleep });
    expect(out).toEqual({ filename: 'Waves-Estimate-EST-2026-0512.pdf', content: pdfBytes.toString('base64'), type: 'application/pdf', disposition: 'attachment' });
    expect(out.filename).not.toMatch(/Synthetic|Customer/);
    expect(render).toHaveBeenCalledWith(ESTIMATE, { validThrough: new Date('2099-01-01T00:00:00Z') });
  });

  test('falls back to a short id when the estimate has no number', () => {
    expect(pdf.estimateEmailPdfFilename({ id: '8f1c2d3e-aaaa' })).toBe('Waves-Estimate-8f1c2d3e.pdf');
    expect(pdf.estimateEmailPdfFilename({ estimate_slug: '../../x y' })).toBe('Waves-Estimate-xy.pdf');
    expect(pdf.estimateEmailPdfFilename({})).toBe('Waves-Estimate-copy.pdf');
  });

  test.each([
    ['the email gate is off', (n) => n === 'estimateDocPdf'],
    ['the browser document gate is off', (n) => n === 'estimateEmailPdf'],
  ])('returns null without rendering when %s', async (_label, enabled) => {
    featureGates.isEnabled.mockImplementation(enabled);
    const render = jest.fn(async () => pdfBytes);
    expect(await pdf.buildEstimateEmailPdfAttachment(ESTIMATE, { render, sleep: noSleep })).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  test('waits and retries while the render capacity is busy, then succeeds', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'estimate_doc_render_busy' });
    const render = jest.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValueOnce(pdfBytes);
    const out = await pdf.buildEstimateEmailPdfAttachment(ESTIMATE, { render, sleep: noSleep, delayMs: 8000 });
    expect(out.filename).toBe('Waves-Estimate-EST-2026-0512.pdf');
    expect(render).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(8000);
  });

  test('gives up after three busy tries and returns null (about 16 seconds at the default delay)', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'estimate_doc_render_busy' });
    const render = jest.fn().mockRejectedValue(busy);
    expect(await pdf.buildEstimateEmailPdfAttachment(ESTIMATE, { render, sleep: noSleep })).toBeNull();
    expect(render).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  test('any other failure returns null at once, never throws, and logs without the token or the link', async () => {
    const logger = require('../services/logger');
    const render = jest.fn().mockRejectedValue(new Error('page.goto: net::ERR https://portal.example.test/estimate/tok_synthetic?mode=pdf&dpin=abc'));
    await expect(pdf.buildEstimateEmailPdfAttachment(ESTIMATE, { render, sleep: noSleep })).resolves.toBeNull();
    expect(render).toHaveBeenCalledTimes(1);
    const logged = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('email PDF skipped');
    expect(logged).not.toContain('tok_synthetic');
    expect(logged).not.toContain('dpin=abc');
  });

  test('an empty render is not an attachment', async () => {
    expect(await pdf.buildEstimateEmailPdfAttachment(ESTIMATE, { render: async () => Buffer.alloc(0), sleep: noSleep })).toBeNull();
  });

  test('has no pdfkit fallback: a browser failure never reaches the proposal builder', async () => {
    const pdfkit = jest.spyOn(require('../services/pdf/estimate-pdf'), 'buildEstimateProposalEmailAttachment');
    await pdf.buildEstimateEmailPdfAttachment(ESTIMATE, { render: async () => { throw new Error('x'); }, sleep: noSleep });
    expect(pdfkit).not.toHaveBeenCalled();
    pdfkit.mockRestore();
  });
});

describe('openEstimateEmailPdf', () => {
  const ATTACHMENT = { filename: 'Waves-Estimate-EST-2026-0512.pdf', content: 'AA==', type: 'application/pdf', disposition: 'attachment' };
  let build;
  const freshRow = (overrides = {}) => ({ ...ESTIMATE, status: 'sent', archived_at: null, expires_at: new Date(Date.now() + 5 * 86400000), ...overrides });
  const readsRow = (row) => db.mockImplementation(() => { const b = {}; b.where = jest.fn(() => b); b.first = jest.fn(async () => row); return b; });
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
  });
  afterEach(() => build.mockRestore());

  test('an allowlisted template on an open estimate gets the attachment and the follow-up note', async () => {
    readsRow(freshRow());
    const out = await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.viewed_followup' });
    expect(out.attachments).toEqual([ATTACHMENT]);
    expect(out.payload).toEqual({ estimate_pdf_note: pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp });
    expect(pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp).toBe("Your estimate is attached as a PDF if the link won't open. Reply or call (941) 297-5749 to get started.");
  });

  test.each(['accepted', 'declined', 'expired', 'draft', 'scheduled', 'send_failed'])('a %s estimate gets nothing', async (status) => {
    readsRow(freshRow({ status }));
    const out = await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.viewed_followup' });
    expect(out).toEqual({ attachments: [], payload: {} });
    expect(build).not.toHaveBeenCalled();
  });

  test('an archived estimate, or one past its expiry, gets nothing; an extension in flight is judged by its new date', async () => {
    readsRow(freshRow({ archived_at: new Date() }));
    expect((await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.expiring_notice' })).attachments).toEqual([]);
    readsRow(freshRow({ expires_at: new Date(Date.now() - 1000) }));
    expect((await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.expiring_notice' })).attachments).toEqual([]);
    const later = new Date(Date.now() + 86400000);
    const out = await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.extended', validThrough: later });
    expect(out.attachments).toEqual([ATTACHMENT]);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ id: ESTIMATE.id }), { validThrough: later });
  });

  test('the money and accepted templates are not on the allowlist', async () => {
    readsRow(freshRow());
    for (const key of ['estimate.deposit_abandoned', 'estimate.payment_step_abandoned', 'estimate.accepted_confirmation', 'estimate.accepted_internal', 'estimate.proposal_delivery', 'estimate.delivery']) {
      expect(ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS).not.toContain(key);
      expect(await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: key })).toEqual({ attachments: [], payload: {} });
    }
    expect(build).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('the allowlist is exactly the follow-up, engagement and extension templates', () => {
    expect([...ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS].sort()).toEqual([
      'estimate.engage_expiring', 'estimate.engage_expiring_unseen', 'estimate.engage_gone_quiet', 'estimate.engage_high_intent',
      'estimate.engage_return_after_dark', 'estimate.engage_return_visit', 'estimate.engage_unopened',
      'estimate.expiring_notice', 'estimate.extended', 'estimate.extension_notice',
      'estimate.followup_final', 'estimate.unviewed_followup', 'estimate.viewed_followup',
    ]);
  });

  test('gate off: no lookup, no render', async () => {
    setGates(false);
    expect(await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.viewed_followup' })).toEqual({ attachments: [], payload: {} });
    expect(db).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  test('a lookup error or a null render degrades to nothing', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    expect((await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.viewed_followup' })).attachments).toEqual([]);
    readsRow(freshRow());
    build.mockResolvedValue(null);
    expect(await openEstimateEmailPdf({ estimateId: ESTIMATE.id, templateKey: 'estimate.viewed_followup' })).toEqual({ attachments: [], payload: {} });
  });
});

describe('sendDualChannel with the PDF copy', () => {
  const ATTACHMENT = { filename: 'Waves-Estimate-EST-2026-0512.pdf', content: 'AA==', type: 'application/pdf', disposition: 'attachment' };
  const est = { id: ESTIMATE.id, customer_email: 'lead@example.com', customer_phone: null, customer_id: null, address: '123 Example Street, Bradenton, FL 34205' };
  const leg = (templateKey) => ({ templateKey, stage: 'viewed_followup', payload: { first_name: 'Sam' } });
  const sent = () => EmailTemplateLibrary.sendTemplate.mock.calls.at(-1)[0];
  let build;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
    db.mockImplementation(() => {
      const b = {};
      b.where = jest.fn(() => b);
      b.first = jest.fn(async () => ({ ...ESTIMATE, customer_email: 'lead@example.com', status: 'viewed', archived_at: null, expires_at: new Date(Date.now() + 86400000) }));
      return b;
    });
    setGates(true);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
  });
  afterEach(() => build.mockRestore());

  test.each([...ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS.filter((k) => k.startsWith('estimate.') && !['estimate.extended', 'estimate.extension_notice'].includes(k))])(
    '%s on an open estimate carries the PDF and the note',
    async (templateKey) => {
      await _private.sendDualChannel(est, { email: leg(templateKey) });
      expect(sent().attachments).toEqual([ATTACHMENT]);
      expect(sent().payload).toEqual({ first_name: 'Sam', estimate_pdf_note: pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp });
    },
  );

  test.each([
    'estimate.deposit_abandoned', 'estimate.payment_step_abandoned', 'estimate.accepted_confirmation', 'estimate.accepted_internal',
  ])('%s never carries the PDF, with the gate on', async (templateKey) => {
    await _private.sendDualChannel(est, { email: leg(templateKey) });
    expect(sent()).not.toHaveProperty('attachments');
    expect(sent().payload).toEqual({ first_name: 'Sam' });
    expect(build).not.toHaveBeenCalled();
  });

  test('a PDF-bearing send passes the final fence as its provider handoff; a body-only send has none', async () => {
    await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') });
    expect(sent().withProviderHandoff).toEqual(expect.any(Function));
    build.mockResolvedValue(null);
    await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') });
    expect(sent()).not.toHaveProperty('withProviderHandoff');
  });

  test('an address that is not the estimate\'s current one gets the email without the file', async () => {
    const ok = await _private.sendDualChannel({ ...est, customer_email: 'old@example.com' }, { email: leg('estimate.viewed_followup') });
    expect(ok).toBe(true);
    expect(sent()).not.toHaveProperty('attachments');
    expect(sent().payload).toEqual({ first_name: 'Sam' });
    expect(build).not.toHaveBeenCalled();
  });

  test('a fence abort with no text sent leaves the stage unattempted, so the claim is released for the next sweep', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: false, aborted: true, boundaryBlocked: true, message: { id: 'm1' } });
    expect(await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') })).toBe(false);
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: false, aborted: true, boundaryCheckFailed: true, message: { id: 'm1' } });
    expect(await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') })).toBe(false);
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('SendGrid 400'));
    expect(await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') })).toBe(false);
  });

  test('gate off: the send is exactly as before (no attachments key, same payload)', async () => {
    setGates(false);
    await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') });
    expect(sent()).not.toHaveProperty('attachments');
    expect(sent().payload).toEqual({ first_name: 'Sam' });
    expect(build).not.toHaveBeenCalled();
  });

  test('an estimate that was accepted since the job was picked up gets the email without the file', async () => {
    db.mockImplementation(() => { const b = {}; b.where = jest.fn(() => b); b.first = jest.fn(async () => ({ ...ESTIMATE, status: 'accepted' })); return b; });
    const ok = await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') });
    expect(ok).toBe(true);
    expect(sent()).not.toHaveProperty('attachments');
    expect(sent().payload).toEqual({ first_name: 'Sam' });
  });

  test('a failed render still sends the follow-up as before', async () => {
    build.mockResolvedValue(null);
    const ok = await _private.sendDualChannel(est, { email: leg('estimate.viewed_followup') });
    expect(ok).toBe(true);
    expect(sent()).not.toHaveProperty('attachments');
    expect(sent().payload).toEqual({ first_name: 'Sam' });
  });
});
