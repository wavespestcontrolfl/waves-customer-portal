// GATE_ESTIMATE_EMAIL_PDF, codex #6343 round 1: the permanent PDF copy needs
// (a) a final fence at the provider boundary, (b) a provider retry that
// rebuilds the PDF or drops the PDF note, (c) no PDF note in admin test sends.
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({ staleCallLinkageReason: jest.fn(async () => null) }));
jest.mock('../services/transactional-email-provider-retry', () => ({ scheduleRetryAfterBoundaryAbort: jest.fn(async () => ({ id: 'm1' })) }));
jest.mock('../utils/estimate-claim-sql', () => ({
  estimateOffCustomerSurface: jest.fn(() => false),
  callSideBlockForEstimateData: jest.fn(async () => null),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const claimSql = require('../utils/estimate-claim-sql');
const persistence = require('../services/admin-estimate-persistence');
const pdf = require('../services/pdf/estimate-doc-pdf');
const emailPdf = require('../services/estimate-email-pdf');
const library = require('../services/email-template-library');

const ID = '8f1c2d3e-aaaa-bbbb-cccc-1234567890ab';
const ATTACHMENT = { filename: 'Waves-Estimate-EST-1.pdf', content: 'AA==', type: 'application/pdf', disposition: 'attachment' };
const row = (overrides = {}) => ({
  id: ID, token: 'tok_synthetic', status: 'sent', archived_at: null,
  customer_name: 'Synthetic Customer', customer_email: 'lead@example.com', address: '1 Example Street',
  monthly_total: 59, annual_total: 708, onetime_total: 0, waveguard_tier: 'Silver',
  expires_at: new Date('2099-01-01T00:00:00Z'),
  estimate_data: { lead_id: 'lead-1', lead_linkage: 'sid', estimatorEngine: { callLogId: 'call-1' } },
  ...overrides,
});
const readsRow = (...rows) => {
  let i = 0;
  db.mockImplementation(() => {
    const b = {};
    b.where = jest.fn(() => b);
    b.first = jest.fn(async () => rows[Math.min(i++, rows.length - 1)]);
    return b;
  });
};
const setGates = (on) => featureGates.isEnabled.mockImplementation((name) => on && (name === 'estimateEmailPdf' || name === 'estimateDocPdf'));

describe('the provider-boundary fence on a PDF-bearing send', () => {
  let build;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
  });
  afterEach(() => build.mockRestore());

  // Runs the handoff the way sendTemplate does and returns what the boundary
  // check does when sendOne awaits it.
  async function runFence(open) {
    let check;
    await open.withProviderHandoff(async (database, boundary) => { check = boundary; });
    expect(typeof check).toBe('function');
    return check;
  }

  test('open() hands back a handoff that installs the boundary check on dispatch', async () => {
    readsRow(row());
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(open.attachments).toEqual([ATTACHMENT]);
    const dispatch = jest.fn(async () => {});
    await expect(open.withProviderHandoff(dispatch)).resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  test('no PDF, no fence: the empty result carries no handoff', async () => {
    readsRow(row({ status: 'accepted' }));
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(open).toEqual({ attachments: [], payload: {} });
  });

  test('an unchanged, open estimate passes the fence', async () => {
    readsRow(row(), row());
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    const check = await runFence(open);
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
  });

  test('a view that flips sent to viewed, or stamps unrelated keys into estimate_data, does not trip it', async () => {
    readsRow(row(), row({ status: 'viewed', estimate_data: { lead_id: 'lead-1', lead_linkage: 'sid', viewedMonthlyTotal: 59, estimatorEngine: { callLogId: 'call-1' } } }));
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    await expect((await runFence(open))({ database: db })).resolves.toEqual({ ok: true });
  });

  test.each([
    ['a re-price after the render', { monthly_total: 79 }, 'estimate_changed_since_render'],
    ['a corrected recipient or name', { customer_name: 'Other Person' }, 'estimate_changed_since_render'],
    ['a corrected address', { address: '2 Other Street' }, 'estimate_changed_since_render'],
    ['a call repointed to another lead', { estimate_data: { lead_id: 'lead-2', lead_linkage: 'sid', estimatorEngine: { callLogId: 'call-1' } } }, 'estimate_changed_since_render'],
    ['an accepted estimate', { status: 'accepted' }, 'estimate_not_open'],
    ['an archived estimate', { archived_at: new Date() }, 'estimate_not_open'],
  ])('%s blocks the handoff', async (_label, change, reason) => {
    readsRow(row(), row(change));
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    const check = await runFence(open);
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason });
  });

  test('an invalidation marker landing after the render blocks the handoff', async () => {
    readsRow(row());
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    claimSql.estimateOffCustomerSurface.mockReturnValue(true);
    await expect((await runFence(open))({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_invalidated' });
  });

  test('a call-side block that has no estimate-side marker yet blocks the handoff', async () => {
    readsRow(row());
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    claimSql.callSideBlockForEstimateData.mockResolvedValue('call_draft_block');
    await expect((await runFence(open))({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'call_side_call_draft_block' });
  });

  test('the manual sender\'s linkage verdict (staleCallLinkageReason) is repeated too', async () => {
    readsRow(row());
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    persistence.staleCallLinkageReason.mockResolvedValue('call_linkage_changed');
    await expect((await runFence(open))({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'call_linkage_call_linkage_changed' });
    expect(persistence.staleCallLinkageReason).toHaveBeenCalledWith(db, expect.any(Object), { estimateStatus: 'sent' });
  });

  test('a fence that cannot read is a definite non-send tagged retryable, never a pass', async () => {
    readsRow(row());
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    const check = await runFence(open);
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryCheckFailed: true });
  });

  test('every caller that attaches the PDF passes the handoff to sendTemplate', () => {
    const root = path.join(__dirname, '..', 'services');
    for (const file of ['estimate-follow-up.js', 'estimate-extension.js', 'estimate-auto-renew.js']) {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      expect(src).toMatch(/attachments: pdfCopy\.attachments, withProviderHandoff: pdfCopy\.withProviderHandoff/);
    }
  });
});

describe('what the fence hashes (codex #6343 r2)', () => {
  let build;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
  });
  afterEach(() => build.mockRestore());

  const content = { proposal: { buildings: [{ name: 'Main house', lineItems: [{ label: 'Quarterly pest', price: 59 }] }], terms: 'Authored terms' }, lead_id: 'lead-1', lead_linkage: 'sid' };
  const withData = (data) => row({ estimate_data: { ...data, estimatorEngine: { callLogId: 'call-1' } } });
  async function fenceAgainst(rendered, atHandoff) {
    readsRow(rendered, atHandoff);
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    let check;
    await open.withProviderHandoff(async (_d, boundary) => { check = boundary; });
    return check({ database: db });
  }

  test.each([
    ['a view stamp', { viewedMonthlyTotal: 59 }],
    ['a delivery receipt', { deliveryState: { lastDeliveredAt: '2026-10-19T10:00:00Z' }, sendSnapshot: { scope: {} } }],
    ['a charge job stamp', { prepayAutoChargeJob: { released_for_visit_id: 'v1' } }],
    ['rate-review terms served', { rateReviewTermsServed: { at: '2026-10-19' } }],
    ['a manual send receipt', { manualSendAttempts: [{ key: 'k' }] }],
  ])('%s does not trip the fence', async (_label, stamp) => {
    await expect(fenceAgainst(withData(content), withData({ ...content, ...stamp }))).resolves.toEqual({ ok: true });
  });

  test('an engine delivery claim and key order do not trip it either', async () => {
    const reordered = { lead_linkage: 'sid', lead_id: 'lead-1', proposal: { terms: 'Authored terms', buildings: content.proposal.buildings } };
    const handoff = row({ estimate_data: { ...reordered, estimatorEngine: { callLogId: 'call-1', delivering_at: '2026-10-19T10:00:00Z', delivering_token: 't' } } });
    await expect(fenceAgainst(withData(content), handoff)).resolves.toEqual({ ok: true });
  });

  test.each([
    ['a line-item price edit', { proposal: { ...content.proposal, buildings: [{ name: 'Main house', lineItems: [{ label: 'Quarterly pest', price: 69 }] }] } }],
    ['an added building', { proposal: { ...content.proposal, buildings: [...content.proposal.buildings, { name: 'Guest house', lineItems: [] }] } }],
    ['edited authored terms', { proposal: { ...content.proposal, terms: 'New terms' } }],
    ['a content key no one has heard of yet', { inclusions: ['New inclusion'] }],
  ])('%s blocks the handoff', async (_label, edit) => {
    await expect(fenceAgainst(withData(content), withData({ ...content, ...edit })))
      .rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_changed_since_render' });
  });
});

describe('the expiry check at the fence (codex #6343 r2)', () => {
  let build;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
    jest.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
  });
  afterEach(() => { jest.useRealTimers(); build.mockRestore(); });

  const fence = async (opts, rows) => {
    readsRow(...rows);
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup', ...opts });
    let check;
    await open.withProviderHandoff(async (_d, boundary) => { check = boundary; });
    return check;
  };

  test('an estimate that expires between the render and the handoff is blocked', async () => {
    const expiring = row({ expires_at: new Date('2026-10-19T12:00:30Z') });
    const check = await fence({}, [expiring, expiring]);
    jest.setSystemTime(new Date('2026-10-19T12:01:00Z'));
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_expired' });
  });

  test('still inside the window at the handoff passes', async () => {
    const expiring = row({ expires_at: new Date('2026-10-19T12:00:30Z') });
    const check = await fence({}, [expiring, expiring]);
    jest.setSystemTime(new Date('2026-10-19T12:00:10Z'));
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
  });

  test('an extension in flight is judged by its new date, not the stored one', async () => {
    const stored = row({ expires_at: new Date('2026-10-19T12:00:30Z') });
    const check = await fence({ validThrough: new Date('2026-10-26T12:00:00Z') }, [stored, stored]);
    jest.setSystemTime(new Date('2026-10-19T12:05:00Z'));
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
  });
});

describe('recoverFenceAbort: an email the fence aborted is requeued or skipped on purpose (codex #6343 r2)', () => {
  const retryRail = require('../services/transactional-email-provider-retry');
  const aborted = (extra = {}) => ({ sent: false, aborted: true, boundaryBlocked: true, message: { id: 'm1', send_attempt_token: 'a1' }, ...extra });
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    retryRail.scheduleRetryAfterBoundaryAbort.mockResolvedValue({ id: 'm1' });
  });

  test('the estimate is still sendable (it only changed): the email goes on the retry rail', async () => {
    readsRow(row());
    expect(await emailPdf.recoverFenceAbort({ estimateId: ID, result: aborted() })).toBe('scheduled');
    expect(retryRail.scheduleRetryAfterBoundaryAbort).toHaveBeenCalledWith({ id: 'm1', send_attempt_token: 'a1' });
  });

  test('the fence could not read: the email goes on the retry rail', async () => {
    readsRow(row());
    expect(await emailPdf.recoverFenceAbort({ estimateId: ID, result: aborted({ boundaryBlocked: undefined, boundaryCheckFailed: true }) })).toBe('scheduled');
  });

  test('a fresh read that fails still keeps the email (retried, not dropped)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await emailPdf.recoverFenceAbort({ estimateId: ID, result: aborted() })).toBe('scheduled');
  });

  test.each([
    ['accepted', row({ status: 'accepted' })],
    ['archived', row({ archived_at: new Date() })],
    ['expired', row({ expires_at: new Date(Date.now() - 1000) })],
  ])('a %s estimate is skipped on purpose, nothing queued', async (_label, closed) => {
    readsRow(closed);
    expect(await emailPdf.recoverFenceAbort({ estimateId: ID, result: aborted() })).toBe('skipped');
    expect(retryRail.scheduleRetryAfterBoundaryAbort).not.toHaveBeenCalled();
  });

  test('an invalidated estimate is skipped on purpose', async () => {
    readsRow(row());
    claimSql.estimateOffCustomerSurface.mockReturnValue(true);
    expect(await emailPdf.recoverFenceAbort({ estimateId: ID, result: aborted() })).toBe('skipped');
    expect(retryRail.scheduleRetryAfterBoundaryAbort).not.toHaveBeenCalled();
  });

  test.each([
    [{ sent: true }], [{ sent: false, aborted: true, reason: 'annual_offer_withheld' }], [undefined],
  ])('any other result is left alone: %j', async (result) => {
    expect(await emailPdf.recoverFenceAbort({ estimateId: ID, result })).toBe('none');
    expect(db).not.toHaveBeenCalled();
    expect(retryRail.scheduleRetryAfterBoundaryAbort).not.toHaveBeenCalled();
  });
});

describe('the destination must still be the estimate\'s recipient (pre-push audit P0)', () => {
  let build;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
  });
  afterEach(() => build.mockRestore());
  const open = (extra = {}) => emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup', recipient: 'lead@example.com', ...extra });
  const handoffCheck = async (o) => { let c; await o.withProviderHandoff(async (_d, b) => { c = b; }); return c; };

  test('first send: the same address passes, in any case and with stray spaces', async () => {
    readsRow(row(), row({ customer_email: ' Lead@Example.COM ' }));
    const o = await open();
    expect(o.attachments).toEqual([ATTACHMENT]);
    // Fingerprint covers the column too, so compare the recipient rule alone.
    expect(await emailPdf.handoffBlockReason(ID, null, { recipient: 'lead@example.com' })).toBeNull();
  });

  test('first send: an address that is not the estimate\'s current one gets no PDF at all', async () => {
    readsRow(row({ customer_email: 'corrected@example.com' }));
    expect(await open()).toEqual({ attachments: [], payload: {} });
    expect(build).not.toHaveBeenCalled();
  });

  test('first send: an address corrected after the render blocks the handoff as recipient_changed', async () => {
    readsRow(row(), row({ customer_email: 'corrected@example.com' }));
    const check = await handoffCheck(await open());
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'recipient_changed' });
  });

  test('first send: an estimate that lost its address blocks too', async () => {
    readsRow(row(), row({ customer_email: null }));
    const check = await handoffCheck(await open());
    await expect(check({ database: db })).rejects.toMatchObject({ reason: 'recipient_changed' });
  });

  test('an aborted send to a superseded address is skipped on purpose, never queued', async () => {
    const retryRail = require('../services/transactional-email-provider-retry');
    readsRow(row({ customer_email: 'corrected@example.com' }));
    const result = { sent: false, aborted: true, boundaryBlocked: true, message: { id: 'm1', send_attempt_token: 'a1', recipient_email_snapshot: 'lead@example.com' } };
    expect(await emailPdf.recoverFenceAbort({ estimateId: ID, result })).toBe('skipped');
    expect(retryRail.scheduleRetryAfterBoundaryAbort).not.toHaveBeenCalled();
  });

  const stored = (extra = {}) => ({
    id: 'm1', template_key: 'estimate.viewed_followup', estimate_id: ID, has_attachments: true,
    recipient_email_snapshot: 'lead@example.com', html_snapshot: '<p>x</p>', text_snapshot: 'x', ...extra,
  });

  test('retry: a corrected address stops the retry before any render, PDF or body-only', async () => {
    readsRow(row({ customer_email: 'corrected@example.com' }));
    expect(await emailPdf.prepareRetryPdf(stored())).toEqual({ stopped: 'recipient_changed' });
    expect(build).not.toHaveBeenCalled();
  });

  test('retry: an address corrected while the PDF was being built stops the body-only fallback too', async () => {
    build.mockResolvedValue(null);
    readsRow(row(), row(), row({ customer_email: 'corrected@example.com' }));
    expect(await emailPdf.prepareRetryPdf(stored())).toEqual({ stopped: 'recipient_changed' });
  });

  test('retry: the rebuilt PDF carries a handoff fence on the row\'s own destination', async () => {
    readsRow(row(), row(), row({ customer_email: 'corrected@example.com' }));
    const out = await emailPdf.prepareRetryPdf(stored());
    expect(out.attachments).toEqual([ATTACHMENT]);
    await expect(out.boundaryCheck({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'recipient_changed' });
  });
});

describe('the provider-retry rail for PDF-bearing rows', () => {
  const BLOCKS = [
    { type: 'paragraph', content: 'Hi {{first_name}},' },
    { type: 'cta', label: 'View your estimate', url_variable: 'estimate_url' },
    { type: 'small_note', content: '{{estimate_pdf_note}}' },
    { type: 'signature', content: '— The Waves Team' },
  ];
  const template = { template_key: 'estimate.viewed_followup', name: 'Follow-up', mode: 'service', send_stream: 'service' };
  const version = { subject: 'Your estimate', blocks: BLOCKS };
  const render = (note) => library.renderTemplate({
    template, version, payload: { first_name: 'Sam', estimate_url: 'https://portal.example.test/estimate/tok', estimate_pdf_note: note },
  });
  const stored = (extra = {}) => {
    const withNote = render(pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp);
    return {
      id: 'm1', template_key: 'estimate.viewed_followup', estimate_id: ID, has_attachments: true,
      recipient_email_snapshot: 'lead@example.com',
      html_snapshot: withNote.html, text_snapshot: withNote.text, ...extra,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
  });

  test('the rail allowlist is the follow-up templates plus the delivery email, never the proposal', () => {
    expect(emailPdf.ESTIMATE_PDF_RETRY_TEMPLATE_KEYS).toEqual([...emailPdf.ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS, 'estimate.delivery']);
    expect(emailPdf.isRetryTemplate('estimate.delivery')).toBe(true);
    expect(emailPdf.isRetryTemplate('estimate.proposal_delivery')).toBe(false);
    expect(emailPdf.isRetryTemplate('invoice.sent')).toBe(false);
  });

  test('stripPdfNote removes exactly the note paragraph from html and text (follow-up and delivery notes)', () => {
    for (const note of Object.values(pdf.ESTIMATE_EMAIL_PDF_NOTES)) {
      const withNote = render(note);
      const without = render('');
      expect(withNote.html).not.toBe(without.html);
      const out = emailPdf.stripPdfNote(withNote.html, withNote.text);
      expect(out.html).toBe(without.html);
      expect(out.text).toBe(without.text);
      expect(out.text).not.toContain('PDF');
      expect(out.html).not.toContain('PDF');
    }
  });

  test('a stored body with no note, or a note in only one of html/text, cannot be stripped', () => {
    const plain = render('');
    expect(emailPdf.stripPdfNote(plain.html, plain.text)).toBeNull();
    const withNote = render(pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp);
    expect(emailPdf.stripPdfNote(withNote.html, plain.text)).toBeNull();
  });

  test('retry with the estimate still open rebuilds the PDF and carries the fence', async () => {
    const build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
    readsRow(row());
    const out = await emailPdf.prepareRetryPdf(stored());
    expect(out.attachments).toEqual([ATTACHMENT]);
    expect(typeof out.boundaryCheck).toBe('function');
    expect(out).not.toHaveProperty('html');
    build.mockRestore();
  });

  test('the delivery email is rebuilt on retry too', async () => {
    const build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
    readsRow(row());
    const out = await emailPdf.prepareRetryPdf(stored({ template_key: 'estimate.delivery' }));
    expect(out.attachments).toEqual([ATTACHMENT]);
    build.mockRestore();
  });

  test.each([
    ['the estimate is no longer open', () => readsRow(row({ status: 'accepted' })), true],
    ['the render returns nothing', () => readsRow(row()), false],
  ])('when %s the retry goes body-only with the note removed', async (_label, arrange, buildOk) => {
    const build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(buildOk ? ATTACHMENT : null);
    arrange();
    const row0 = stored();
    const out = await emailPdf.prepareRetryPdf(row0);
    expect(out.attachments).toEqual([]);
    expect(out.html).toBe(render('').html);
    expect(out.text).toBe(render('').text);
    expect(out.boundaryCheck).toBeUndefined();
    build.mockRestore();
  });

  test('gate off: body-only as well; no estimate to authorize the address against: stopped', async () => {
    readsRow(row());
    setGates(false);
    expect((await emailPdf.prepareRetryPdf(stored())).attachments).toEqual([]);
    expect(await emailPdf.prepareRetryPdf(stored({ estimate_id: null }))).toEqual({ stopped: 'estimate_missing' });
  });

  test('a stored body whose note cannot be removed is unsendable, never sent with a missing-file promise', async () => {
    readsRow(row());
    setGates(false);
    const plain = render('');
    expect(await emailPdf.prepareRetryPdf(stored({ html_snapshot: plain.html, text_snapshot: plain.text })))
      .toEqual({ unsendable: true });
  });
});
