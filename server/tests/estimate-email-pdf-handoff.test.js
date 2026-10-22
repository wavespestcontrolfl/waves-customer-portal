// GATE_ESTIMATE_EMAIL_PDF, codex #6343 round 1: the permanent PDF copy needs
// (a) a final fence at the provider boundary, (b) a provider retry that
// is out of scope (PDF rows are not on the retry rail), (c) no PDF note in admin test sends.
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
jest.mock('../routes/estimate-public', () => ({
  reconcileFrozenMembershipSnapshot: jest.fn(async () => {}),
  composeEstimateDataPayload: jest.fn((...args) => require('./helpers/estimate-document-payload').documentPayloadFromRow(...args)),
  findLinkedUpcomingAppointment: jest.fn(async () => null),
  adoptionServiceModesForContract: jest.fn(() => []),
}));
jest.mock('../services/admin-estimate-persistence', () => ({ staleCallLinkageReason: jest.fn(async () => null) }));
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
    b.whereNot = jest.fn(() => b);
    b.whereNull = jest.fn(() => b);
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

  test('every caller that attaches the PDF passes the handoff to sendTemplate; auto-renew carries no PDF at all', () => {
    const root = path.join(__dirname, '..', 'services');
    for (const file of ['estimate-follow-up.js', 'estimate-extension.js']) {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      expect(src).toMatch(/attachments: pdfCopy\.attachments/);
      // The fence rides every prepared send, with the file or without it.
      expect(src).toMatch(/withProviderHandoff: pdfCopy\.withProviderHandoff/);
    }
    const renew = fs.readFileSync(path.join(root, 'estimate-auto-renew.js'), 'utf8');
    expect(renew).not.toMatch(/estimate-email-pdf|pdfCopy|attachments/);
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

describe('a live-repriced estimate does not veto itself (codex #6343 r5)', () => {
  test('the fingerprint is of the row as the database returned it, even if the builder mutates the object it was handed', async () => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    // What resolveProposalBillingContext used to do to the row it was handed.
    const build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockImplementation(async (rowArg) => {
      rowArg.monthly_total = 1;
      rowArg.estimate_data = { ...rowArg.estimate_data, membershipSnapshot: { reconciled: true } };
      return ATTACHMENT;
    });
    readsRow(row(), row());
    const o = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(o.attachments).toEqual([ATTACHMENT]);
    let check;
    await o.withProviderHandoff(async (_d, b) => { check = b; });
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
    build.mockRestore();
  });
});

describe('the document\'s own input is the fence (codex #6343 r14)', () => {
  // The real composeEstimateDataPayload is exercised in
  // estimate-email-pdf-document-input.test.js (linked customer contact, billing,
  // appointment, line items against the real composer). Here the composer is a
  // stand-in so each case moves exactly one thing the payload carries between the
  // render and the handoff and checks the fence's wiring.
  const estimatePublic = require('../routes/estimate-public');
  const { documentPayloadFromRow } = require('./helpers/estimate-document-payload');
  const APPOINTMENT = { mode: 'existing_appointment', appointment: { id: 'appt-1', scheduledDate: '2026-10-30', windowStart: '09:00', windowEnd: '11:00', serviceType: 'Pest control', status: 'confirmed' } };
  // Payload changes: each returns a modified copy of what the stand-in builds.
  const withPayload = (edit) => async (estimate, opts) => edit(await documentPayloadFromRow(estimate, opts));
  const CHANGES = {
    'a linked customer phone edit': (p) => { p.estimate.customerPhone = '9415550199'; return p; },
    'a linked customer name edit': (p) => { p.estimate.customerName = 'Someone Else'; return p; },
    'a linked customer address edit': (p) => { p.estimate.address = '9 Elsewhere Rd'; return p; },
    'a billing change (monthly lane)': (p) => { p.cta.monthlyBilled = true; return p; },
    'a line-item edit': (p) => { p.proposal = { buildings: [{ lineItems: [{ description: 'x', unitPrice: 1 }] }] }; return p; },
    'an appointment that appears': (p) => { p.estimate.acceptance = APPOINTMENT; return p; },
    'an appointment that moves': (p) => { p.estimate.acceptance = { ...APPOINTMENT, appointment: { ...APPOINTMENT.appointment, scheduledDate: '2026-11-02' } }; return p; },
    'an appointment that moves to another window': (p) => { p.estimate.acceptance = { ...APPOINTMENT, appointment: { ...APPOINTMENT.appointment, windowStart: '13:00', windowEnd: '15:00' } }; return p; },
    'an appointment that changes status': (p) => { p.estimate.acceptance = { ...APPOINTMENT, appointment: { ...APPOINTMENT.appointment, status: 'rescheduled' } }; return p; },
    'a different service on the appointment': (p) => { p.estimate.acceptance = { ...APPOINTMENT, appointment: { ...APPOINTMENT.appointment, serviceType: 'Lawn care' } }; return p; },
    'a call to action that turns terminal': (p) => { p.cta.terminalState = 'expired'; return p; },
    'a satellite image that appears': (p) => { p.estimate.satelliteUrl = '/api/estimates/tok/map/satellite'; return p; },
  };
  let build;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    estimatePublic.composeEstimateDataPayload.mockReset();
    estimatePublic.composeEstimateDataPayload.mockImplementation((...args) => documentPayloadFromRow(...args));
    estimatePublic.reconcileFrozenMembershipSnapshot.mockReset();
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
  });
  afterEach(() => build.mockRestore());

  // Follow-up path: the payload at render is edited by `atRender`, at the handoff by `atHandoff`.
  async function followUp(atRender, atHandoff) {
    readsRow(row(), row());
    if (atRender) estimatePublic.composeEstimateDataPayload.mockImplementationOnce(withPayload(atRender));
    const o = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(o.attachments).toEqual([ATTACHMENT]);
    let check;
    await o.withProviderHandoff(async (_d, b) => { check = b; });
    if (atHandoff instanceof Error) estimatePublic.composeEstimateDataPayload.mockRejectedValueOnce(atHandoff);
    else if (atHandoff) estimatePublic.composeEstimateDataPayload.mockImplementationOnce(withPayload(atHandoff));
    return check({ database: db });
  }

  test('the payload is composed the way the render pass is served: reconciled clone, pdf pass, pinned valid-through', async () => {
    await followUp();
    const [estimate, opts] = estimatePublic.composeEstimateDataPayload.mock.calls[0];
    expect(opts).toEqual({ isPdfRenderPass: true, docRenderPin: { validThrough: '2099-01-01T00:00:00.000Z' } });
    expect(estimatePublic.reconcileFrozenMembershipSnapshot).toHaveBeenCalledWith(estimate);
    expect(estimatePublic.composeEstimateDataPayload).toHaveBeenCalledTimes(2);
  });

  test('the same unchanged estimate composed twice (fresh per-request fields each time) never vetoes itself', async () => {
    await expect(followUp()).resolves.toEqual({ ok: true });
    await expect(followUp(CHANGES['a billing change (monthly lane)'], CHANGES['a billing change (monthly lane)'])).resolves.toEqual({ ok: true });
    // Several handoffs in a row against one baseline.
    readsRow(row(), row());
    const o = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    let check;
    await o.withProviderHandoff(async (_d, b) => { check = b; });
    for (let i = 0; i < 3; i += 1) {
      readsRow(row());
      await expect(check({ database: db })).resolves.toEqual({ ok: true });
    }
  });

  test('the composer does not see the row the fingerprint reads: it gets a clone', async () => {
    const fresh = row();
    readsRow(fresh);
    estimatePublic.composeEstimateDataPayload.mockImplementationOnce(async (estimate) => {
      estimate.monthly_total = 'MUTATED';
      estimate.estimate_data.injected = true;
      return documentPayloadFromRow(estimate);
    });
    await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(fresh.monthly_total).toBe(59);
    expect(fresh.estimate_data).not.toHaveProperty('injected');
  });

  test.each(Object.keys(CHANGES))('%s between render and handoff vetoes the PDF', async (name) => {
    await expect(followUp(null, CHANGES[name])).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_changed_since_render' });
  });

  test('a change that was already in the payload at render (and stays) does not veto', async () => {
    await expect(followUp(CHANGES['an appointment that appears'], CHANGES['an appointment that appears'])).resolves.toEqual({ ok: true });
  });

  test('the per-request fields (askToken, generatedAt) are not part of it', async () => {
    const volatile = (p) => { p.estimate.askToken = 'another-token'; p.meta.generatedAt = '2030-01-01T00:00:00.000Z'; p.meta.cacheHit = true; return p; };
    await expect(followUp(null, volatile)).resolves.toEqual({ ok: true });
  });

  test('a failed composition at the handoff is a tagged retryable check failure, not a pass', async () => {
    await expect(followUp(null, new Error('db down'))).rejects.toMatchObject({ providerBoundaryCheckFailed: true });
  });

  test('a failed composition at render time means no PDF (and no build)', async () => {
    readsRow(row());
    estimatePublic.composeEstimateDataPayload.mockRejectedValueOnce(new Error('db down'));
    const out = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(out.attachments).toEqual([]);
    expect(out.payload).toEqual({});
    expect(out.withProviderHandoff).toEqual(expect.any(Function));
    expect(build).not.toHaveBeenCalled();
  });

  test('the delivery fence carries it too, and leaves the printed date out', async () => {
    const draft = (extra = {}) => row({ status: 'sending', ...extra });
    const fence = await emailPdf.deliveryPdfFence(draft(), { recipient: 'lead@example.com', validThrough: new Date('2099-02-01T00:00:00Z') });
    let check;
    await fence.withProviderHandoff(async (_d, b) => { check = b; });
    expect(estimatePublic.composeEstimateDataPayload.mock.calls[0][1].docRenderPin).toEqual({ validThrough: '2099-02-01T00:00:00.000Z' });
    // The send persists expires_at later: not a change.
    readsRow(draft({ expires_at: new Date('2099-02-01T00:00:00Z') }));
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
    // A phone edit on the linked customer during the render is.
    readsRow(draft());
    estimatePublic.composeEstimateDataPayload.mockImplementationOnce(withPayload(CHANGES['a linked customer phone edit']));
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_changed_since_render' });
  });

  test('the no-file fence keeps no fingerprint: a payload change does not stop a link-only email', async () => {
    build.mockResolvedValue(null);
    readsRow(row(), row());
    const open = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(open.attachments).toEqual([]);
    let check;
    await open.withProviderHandoff(async (_d, b) => { check = b; });
    estimatePublic.composeEstimateDataPayload.mockClear();
    estimatePublic.composeEstimateDataPayload.mockImplementation(withPayload(CHANGES['an appointment that appears']));
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
    expect(estimatePublic.composeEstimateDataPayload).not.toHaveBeenCalled();
  });
});

describe('prepareDeliveryPdfCopy: the delivery send\'s whole PDF step (codex #6343 r8)', () => {
  let build;
  const fresh = (extra = {}) => row({ status: 'sending', ...extra });
  const prepare = (input = {}) => emailPdf.prepareDeliveryPdfCopy({ freshEstimate: fresh(), sendTo: 'lead@example.com', validThrough: new Date('2099-01-01T00:00:00Z'), ...input });
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    readsRow(fresh());
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    require('../routes/estimate-public').findLinkedUpcomingAppointment.mockReset();
    require('../routes/estimate-public').findLinkedUpcomingAppointment.mockResolvedValue(null);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
  });
  afterEach(() => build.mockRestore());

  test('gate on, plain estimate: attachment, the delivery note, a fence, no warning', async () => {
    const out = await prepare();
    expect(out).toMatchObject({ expected: true, attachment: ATTACHMENT, note: pdf.ESTIMATE_EMAIL_PDF_NOTES.delivery, warning: null });
    expect(out.fence.withProviderHandoff).toEqual(expect.any(Function));
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), { validThrough: new Date('2099-01-01T00:00:00Z') });
  });

  test('a commercial proposal, the gate off, or a review with no stored decision: nothing expected, nothing built', async () => {
    const proposalRow = fresh({ estimate_data: { proposal: { enabled: true, buildings: [{ name: 'x', lineItems: [{ id: 'a', description: 'a', quantity: 1, unit: 'acre', unitPrice: 1, frequency: 'one_time' }] }] } } });
    for (const input of [{ proposalMode: true }, { freshEstimate: proposalRow }, { reviewedMessages: { email: { provider: 'sendgrid' } } }]) {
      expect(await prepare(input)).toMatchObject({ expected: false, attachment: null, fence: null });
    }
    setGates(false);
    expect(await prepare()).toMatchObject({ expected: false, attachment: null });
    expect(build).not.toHaveBeenCalled();
  });

  test('a review that stored yes still gets the file', async () => {
    expect(await prepare({ reviewedMessages: { email: { pdfCopy: true } } })).toMatchObject({ expected: true, attachment: ATTACHMENT });
  });

  const ACCEPTED = { ok: true, providerAttempted: true, providerAccepted: true };

  test('annotate: pdfAttached is true only for a fresh provider-accepted send that carried the file', async () => {
    const withFile = await prepare();
    const ok = { ok: true };
    withFile.annotate(ok, ACCEPTED);
    expect(ok).toEqual({ ok: true, pdfAttached: true });
    // A failed channel, an unexpected copy and a missing result are never annotated.
    const failed = { ok: false };
    withFile.annotate(failed, ACCEPTED);
    expect(failed).toEqual({ ok: false });
    const untouched = { ok: true };
    (await prepare({ proposalMode: true })).annotate(untouched, ACCEPTED);
    expect(untouched).toEqual({ ok: true });
    const noResult = { ok: true };
    withFile.annotate(noResult);
    expect(noResult).toEqual({ ok: true });
    // An ok send that was not a provider-accepted attempt: nothing is claimed.
    const unaccepted = { ok: true };
    withFile.annotate(unaccepted, { ok: true, providerAccepted: false });
    expect(unaccepted).toEqual({ ok: true });
  });

  test('annotate: no file built means false plus the warning, on a fresh accepted send', async () => {
    const noFile = await prepare({ sendTo: 'old@example.com' });
    const warned = { ok: true };
    noFile.annotate(warned, ACCEPTED);
    expect(warned).toEqual({ ok: true, pdfAttached: false, warning: 'The PDF copy could not be attached; the email went out with the link only.' });
  });

  test('annotate: a deduped answer reports the earlier message\'s persisted has_attachments, or nothing when unknown, never true by assumption', async () => {
    const withFile = await prepare();
    for (const [extras, expected] of [
      [{ messageHasAttachments: true }, { ok: true, pdfAttached: true }],
      [{ messageHasAttachments: false }, { ok: true, pdfAttached: false, warning: 'The PDF copy could not be attached; the email went out with the link only.' }],
      [{}, { ok: true }],
    ]) {
      const channel = { ok: true };
      withFile.annotate(channel, { ok: true, deduped: true, providerAccepted: false, ...extras });
      expect(channel).toEqual(expected);
    }
    // Even a deduped result that carries providerAccepted (a superseded attempt) is not a fresh send.
    const superseded = { ok: true };
    withFile.annotate(superseded, { ok: true, deduped: true, providerAccepted: true });
    expect(superseded).toEqual({ ok: true });
  });

  test('recordDelivered records for a fresh accepted send only; a deduped result, an unaccepted one or none never records', async () => {
    const spy = jest.spyOn(pdf, 'recordEmailedPdfDisclosure').mockResolvedValue('persisted');
    const copy = await prepare();
    await copy.recordDelivered(ACCEPTED);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(ATTACHMENT, ID);
    spy.mockClear();
    for (const result of [
      { ok: true, deduped: true, providerAccepted: true },
      { ok: true, deduped: true, providerAccepted: false },
      { ok: true, providerAccepted: false },
      { ok: false, providerAccepted: true },
      undefined,
    ]) await copy.recordDelivered(result);
    await (await prepare({ proposalMode: true })).recordDelivered(ACCEPTED);
    await (await prepare({ sendTo: 'old@example.com' })).recordDelivered(ACCEPTED);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('resultExtras: deduped and the earlier message\'s has_attachments travel on the result; a fence abort becomes a failed result', async () => {
    const { resultExtras } = emailPdf.deliverySendPieces(undefined);
    // A fresh send adds nothing: the channel result stays byte-identical to today.
    expect(resultExtras({ sent: true })).toEqual({});
    expect(resultExtras({ sent: true, deduped: true, message: { has_attachments: true } })).toEqual({ deduped: true, messageHasAttachments: true });
    expect(resultExtras({ sent: true, deduped: true, message: {} })).toEqual({ deduped: true });
    expect(resultExtras({ aborted: true, boundaryBlocked: true })).toMatchObject({ ok: false, vetoedAtHandoff: true });
  });

  test('an address that is not the row\'s, a render that returns nothing or throws, or a failed fence read: expected but no file, with the warning', async () => {
    const warning = 'The PDF copy could not be attached; the email went out with the link only.';
    // Expected but no file: the send still carries the no-document fence.
    const stale = await prepare({ sendTo: 'old@example.com' });
    expect(stale).toMatchObject({ expected: true, attachment: null, warning });
    expect(stale.fence.withProviderHandoff).toEqual(expect.any(Function));
    expect(build).not.toHaveBeenCalled();
    build.mockResolvedValue(null);
    expect(await prepare()).toMatchObject({ expected: true, attachment: null, warning });
    build.mockRejectedValue(new Error('browser down'));
    expect(await prepare()).toMatchObject({ expected: true, attachment: null, warning });
    build.mockResolvedValue(ATTACHMENT);
    require('../routes/estimate-public').composeEstimateDataPayload.mockRejectedValueOnce(new Error('db down'));
    expect(await prepare()).toMatchObject({ expected: true, attachment: null, warning });
  });
});

describe('a sibling unarchived during the render vetoes the handoff (codex #6343 r9)', () => {
  let build;
  let group;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
    group = jest.spyOn(emailPdf, 'estimateInMultiPropertyGroup');
  });
  afterEach(() => { build.mockRestore(); group.mockRestore(); });

  test('follow-up: ungrouped at render, grouped at the handoff', async () => {
    readsRow(row(), row());
    // The render-time eligibility read is the real check (no group id on the
    // row → ungrouped); the spy answers only the handoff's group read.
    group.mockResolvedValue(true);
    const o = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(o.attachments).toEqual([ATTACHMENT]);
    let check;
    await o.withProviderHandoff(async (_d, b) => { check = b; });
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_grouped' });
  });

  test('follow-up: still ungrouped at the handoff passes', async () => {
    readsRow(row(), row());
    group.mockResolvedValue(false);
    const o = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    let check;
    await o.withProviderHandoff(async (_d, b) => { check = b; });
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
  });

  // r10: the fence never records a group verdict as its baseline, so a group
  // that already formed before the fence was built is refused too.
  test('delivery: a group present at the handoff is refused whenever it formed', async () => {
    const draft = () => row({ status: 'sending' });
    group.mockResolvedValue(true);
    const fence = await emailPdf.deliveryPdfFence(draft(), { recipient: 'lead@example.com' });
    let check;
    await fence.withProviderHandoff(async (_d, b) => { check = b; });
    readsRow(draft());
    await expect(check({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'estimate_grouped' });
  });

  test('delivery: the same ungrouped state at both ends passes', async () => {
    const draft = () => row({ status: 'sending' });
    group.mockResolvedValue(false);
    const fence = await emailPdf.deliveryPdfFence(draft(), { recipient: 'lead@example.com' });
    let check;
    await fence.withProviderHandoff(async (_d, b) => { check = b; });
    readsRow(draft());
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
  });
});

describe('a render that produces nothing keeps the provider-boundary fence (codex #6343 r11)', () => {
  let build;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    require('../routes/estimate-public').findLinkedUpcomingAppointment.mockReset();
    require('../routes/estimate-public').findLinkedUpcomingAppointment.mockResolvedValue(null);
    build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(null);
  });
  afterEach(() => build.mockRestore());

  async function fenceOf(copy) {
    let check;
    await copy.withProviderHandoff(async (_d, b) => { check = b; });
    return check;
  }

  test('follow-up: no file and no note, but the fence is there and checks state, recipient and call-side', async () => {
    readsRow(row(), row());
    const copy = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup', recipient: 'lead@example.com' });
    expect(copy).toMatchObject({ attachments: [], payload: {} });
    expect(copy.recordDelivered).toBeUndefined();
    await expect((await fenceOf(copy))({ database: db })).resolves.toEqual({ ok: true });
  });

  test.each([
    ['an accept or decline during the wait', { status: 'accepted' }, 'estimate_not_open'],
    ['an archive', { archived_at: new Date() }, 'estimate_not_open'],
    ['an address correction', { customer_email: 'corrected@example.com' }, 'recipient_changed'],
    ['an expiry', { expires_at: new Date(Date.now() - 1000) }, 'estimate_expired'],
  ])('follow-up: %s vetoes the body-only send', async (_label, change, reason) => {
    readsRow(row(), row(change));
    const copy = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup', recipient: 'lead@example.com' });
    await expect((await fenceOf(copy))({ database: db })).rejects.toMatchObject({ providerBoundaryBlocked: true, reason });
  });

  test('follow-up: a call-side block vetoes it, and a content edit does not (no document to disagree with)', async () => {
    readsRow(row(), row({ monthly_total: 99 }));
    const copy = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    const check = await fenceOf(copy);
    await expect(check({ database: db })).resolves.toEqual({ ok: true });
    claimSql.callSideBlockForEstimateData.mockResolvedValue('call_draft_block');
    await expect(check({ database: db })).rejects.toMatchObject({ reason: 'call_side_call_draft_block' });
  });

  test('follow-up: a render that throws, or a failed fingerprint read, ends the same way', async () => {
    readsRow(row(), row());
    build.mockRejectedValue(new Error('browser down'));
    const thrown = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(thrown.attachments).toEqual([]);
    expect(thrown.withProviderHandoff).toEqual(expect.any(Function));
  });

  test('paths that return before any render keep today\'s behaviour: nothing, no fence', async () => {
    readsRow(row({ status: 'accepted' }));
    expect(await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' })).toEqual({ attachments: [], payload: {} });
    setGates(false);
    expect(await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' })).toEqual({ attachments: [], payload: {} });
    setGates(true);
    expect(await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.deposit_abandoned' })).toEqual({ attachments: [], payload: {} });
    readsRow(row({ estimate_group_id: 'g' }), { id: 'sibling' });
    expect(await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' })).toEqual({ attachments: [], payload: {} });
  });

  test('delivery: expected but no file keeps the claimed-state / address / call-side fence', async () => {
    const draft = (extra = {}) => row({ status: 'sending', ...extra });
    const copy = await emailPdf.prepareDeliveryPdfCopy({ freshEstimate: draft(), sendTo: 'lead@example.com', validThrough: new Date('2099-01-01T00:00:00Z') });
    expect(copy).toMatchObject({ expected: true, attachment: null, note: '' });
    const check = async (current) => { readsRow(current); return (await fenceOf(copy.fence))({ database: db }); };
    await expect(check(draft())).resolves.toEqual({ ok: true });
    await expect(check(draft({ monthly_total: 150 }))).resolves.toEqual({ ok: true });
    await expect(check(draft({ status: 'declined' }))).rejects.toMatchObject({ reason: 'estimate_not_open' });
    await expect(check(draft({ customer_email: 'corrected@example.com' }))).rejects.toMatchObject({ reason: 'recipient_changed' });
    claimSql.callSideBlockForEstimateData.mockResolvedValue('call_draft_block');
    await expect(check(draft())).rejects.toMatchObject({ reason: 'call_side_call_draft_block' });
  });

  test('delivery: a proposal, a gate-off send, and a review without the decision still get no fence at all', async () => {
    const draft = row({ status: 'sending' });
    expect((await emailPdf.prepareDeliveryPdfCopy({ freshEstimate: draft, sendTo: 'lead@example.com', proposalMode: true })).fence).toBeNull();
    expect((await emailPdf.prepareDeliveryPdfCopy({ freshEstimate: draft, sendTo: 'lead@example.com', reviewedMessages: { email: { provider: 'sendgrid' } } })).fence).toBeNull();
    setGates(false);
    expect((await emailPdf.prepareDeliveryPdfCopy({ freshEstimate: draft, sendTo: 'lead@example.com' })).fence).toBeNull();
  });
});

describe('the fingerprint covers what the document projects from the row (codex #6343 r11)', () => {
  test.each([
    ['satellite_url', { satellite_url: 'https://maps.googleapis.com/maps/api/staticmap?center=other' }],
    ['estimate_slug', { estimate_slug: 'EST-2099-0002' }],
    ['created_at', { created_at: new Date('2030-01-01T00:00:00Z') }],
  ])('a change to %s changes the fingerprint', (_column, change) => {
    const base = row({ satellite_url: 'https://maps.googleapis.com/maps/api/staticmap?center=a', estimate_slug: 'EST-2099-0001', created_at: new Date('2026-08-06T14:57:32Z') });
    expect(emailPdf.rowFingerprint({ ...base, ...change })).not.toBe(emailPdf.rowFingerprint(base));
  });

  test('a satellite_url change between render and handoff vetoes the PDF', async () => {
    jest.clearAllMocks();
    db.mockReset();
    setGates(true);
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
    require('../routes/estimate-public').findLinkedUpcomingAppointment.mockResolvedValue(null);
    const build = jest.spyOn(pdf, 'buildEstimateEmailPdfAttachment').mockResolvedValue(ATTACHMENT);
    readsRow(row({ satellite_url: 'https://maps.googleapis.com/maps/api/staticmap?center=a' }), row({ satellite_url: 'https://maps.googleapis.com/maps/api/staticmap?center=b' }));
    const copy = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    let check;
    await copy.withProviderHandoff(async (_d, b) => { check = b; });
    await expect(check({ database: db })).rejects.toMatchObject({ reason: 'estimate_changed_since_render' });
    build.mockRestore();
  });
});

describe('grouped estimates carry no PDF (codex #6343 r6)', () => {
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

  test('an estimate whose group has another non-archived member gets no PDF and no note', async () => {
    readsRow(row({ estimate_group_id: 'group-1' }), { id: 'sibling' });
    expect(await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' })).toEqual({ attachments: [], payload: {} });
    expect(build).not.toHaveBeenCalled();
  });

  test('a group of one (the siblings archived) still gets the PDF', async () => {
    readsRow(row({ estimate_group_id: 'group-1' }), undefined, row({ estimate_group_id: 'group-1' }));
    const out = await emailPdf.openEstimateEmailPdf({ estimateId: ID, templateKey: 'estimate.viewed_followup' });
    expect(out.attachments).toEqual([ATTACHMENT]);
  });

  test('estimateInMultiPropertyGroup: no group id means no lookup at all', async () => {
    expect(await emailPdf.estimateInMultiPropertyGroup(row())).toBe(false);
    expect(db).not.toHaveBeenCalled();
    readsRow({ id: 'sibling' });
    expect(await emailPdf.estimateInMultiPropertyGroup(row({ estimate_group_id: 'g' }))).toBe(true);
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

describe('deliveryPdfFence: the manual delivery send (codex #6343 r4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue(null);
    persistence.staleCallLinkageReason.mockResolvedValue(null);
  });
  const draft = (extra = {}) => row({ status: 'sending', expires_at: new Date('2020-01-01T00:00:00Z'), ...extra });
  const fenceFor = async (fresh, recipient = 'lead@example.com') => emailPdf.deliveryPdfFence(fresh, { recipient });
  const run = async (fence) => { let c; await fence.withProviderHandoff(async (_d, b) => { c = b; }); return c({ database: db }); };

  test('no fence (so no PDF) when the address being sent to is not the row\'s current one', async () => {
    expect(await fenceFor(draft(), 'old@example.com')).toBeNull();
    expect(await fenceFor(draft({ customer_email: null }))).toBeNull();
    expect(await fenceFor(null)).toBeNull();
    expect(await fenceFor(draft(), ' LEAD@example.com ')).not.toBeNull();
  });

  test('a draft in flight passes: status and the persisted expiry are not part of this fence', async () => {
    const fresh = draft();
    readsRow(draft({ status: 'sending', expires_at: new Date('2099-01-01T00:00:00Z') }));
    await expect(run(await fenceFor(fresh))).resolves.toEqual({ ok: true });
  });

  test.each([
    ['an address correction', { customer_email: 'corrected@example.com' }, 'recipient_changed'],
    ['a price edit', { monthly_total: 99 }, 'estimate_changed_since_render'],
    ['a content edit', { estimate_data: { proposal: { terms: 'new' }, lead_id: 'lead-1', lead_linkage: 'sid', estimatorEngine: { callLogId: 'call-1' } } }, 'estimate_changed_since_render'],
    ['an archive', { archived_at: new Date() }, 'estimate_not_open'],
    ['a decline during the render', { status: 'declined' }, 'estimate_not_open'],
    ['an accept during the render', { status: 'accepted' }, 'estimate_not_open'],
    ['the claim released back to a failed send', { status: 'send_failed' }, 'estimate_not_open'],
    ['the row already marked sent', { status: 'sent' }, 'estimate_not_open'],
  ])('%s vetoes the handoff', async (_label, change, reason) => {
    readsRow(draft(change));
    await expect(run(await fenceFor(draft()))).rejects.toMatchObject({ providerBoundaryBlocked: true, reason });
  });

  test('an invalidation or call-side block vetoes it', async () => {
    readsRow(draft());
    claimSql.estimateOffCustomerSurface.mockReturnValue(true);
    await expect(run(await fenceFor(draft()))).rejects.toMatchObject({ reason: 'estimate_invalidated' });
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue('call_draft_block');
    await expect(run(await fenceFor(draft()))).rejects.toMatchObject({ reason: 'call_side_call_draft_block' });
  });

  test('a read failure is tagged retryable, not a pass', async () => {
    const fence = await fenceFor(draft());
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(run(fence)).rejects.toMatchObject({ providerBoundaryCheckFailed: true });
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
});

