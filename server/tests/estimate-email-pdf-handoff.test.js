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
      expect(src).toMatch(/attachments: pdfCopy\.attachments, withProviderHandoff: pdfCopy\.withProviderHandoff/);
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
  const fenceFor = (fresh, recipient = 'lead@example.com') => emailPdf.deliveryPdfFence(fresh, { recipient });
  const run = async (fence) => { let c; await fence.withProviderHandoff(async (_d, b) => { c = b; }); return c({ database: db }); };

  test('no fence (so no PDF) when the address being sent to is not the row\'s current one', () => {
    expect(fenceFor(draft(), 'old@example.com')).toBeNull();
    expect(fenceFor(draft({ customer_email: null }))).toBeNull();
    expect(fenceFor(null)).toBeNull();
    expect(fenceFor(draft(), ' LEAD@example.com ')).not.toBeNull();
  });

  test('a draft in flight passes: status and the persisted expiry are not part of this fence', async () => {
    const fresh = draft();
    readsRow(draft({ status: 'sending', expires_at: new Date('2099-01-01T00:00:00Z') }));
    await expect(run(fenceFor(fresh))).resolves.toEqual({ ok: true });
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
    await expect(run(fenceFor(draft()))).rejects.toMatchObject({ providerBoundaryBlocked: true, reason });
  });

  test('an invalidation or call-side block vetoes it', async () => {
    readsRow(draft());
    claimSql.estimateOffCustomerSurface.mockReturnValue(true);
    await expect(run(fenceFor(draft()))).rejects.toMatchObject({ reason: 'estimate_invalidated' });
    claimSql.estimateOffCustomerSurface.mockReturnValue(false);
    claimSql.callSideBlockForEstimateData.mockResolvedValue('call_draft_block');
    await expect(run(fenceFor(draft()))).rejects.toMatchObject({ reason: 'call_side_call_draft_block' });
  });

  test('a read failure is tagged retryable, not a pass', async () => {
    const fence = fenceFor(draft());
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
