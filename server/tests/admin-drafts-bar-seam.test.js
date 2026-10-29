/**
 * Admin drafts route — the Intelligence Bar seam (GATE_IB_MESSAGE_DRAFTS). The bar's approve / revise / ignore cards run the
 * page's own handlers in process (approveDraftFromBar, reviseDraftFromBar, rejectDraftFromBar) with `pins` the card showed:
 *  - the claim's WHERE carries the carded text (the claim is the lock: a draft handled or edited after the card is not claimed)
 *  - the resolved recipient and the newest inbound text must still be the card's: a mismatch releases the claim and refuses
 *    preview_changed with NOTHING sent
 *  - the last await before the provider handoff re-checks the newest inbound text
 *  - a campaign / clarify / photo-triage draft is refused before any guard (the campaign guard could retire it)
 *  - the send is sendManualCustomerSms with exactly the carded text, so the page's checks stay intact
 * The page path (no pins) is pinned by the other admin-drafts suites. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/messaging/send-manual-customer-sms', () => ({
  sendManualCustomerSms: jest.fn(),
  manualSmsDeliveryState: (value) => value?.manualSmsInterlock?.deliveryState || null,
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/campaign-drafts', () => ({ CAMPAIGN_GATE: 'campaignDrafts' }));
jest.mock('../services/campaign-drafts-gate', () => ({
  ...jest.requireActual('../services/campaign-drafts-gate'),
  evaluateCampaignSendGate: jest.fn(),
}));
jest.mock('../services/composer-customer-links', () => ({
  autopayLinkSendCheck: jest.fn(async () => ({ present: false })),
  immediateOnlyLinkSendCheck: jest.fn(async () => ({ present: false })),
}));
jest.mock('../services/lead-estimate-link', () => ({ stampFirstResponseByContact: jest.fn(async () => {}) }));

const db = require('../models/db');
const draftsRouter = require('../routes/admin-drafts');
const { sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms');
const { evaluateCampaignSendGate } = require('../services/campaign-drafts-gate');

const updates = [];
const wheres = [];
let queues;
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of ['join', 'leftJoin', 'whereIn', 'whereNull', 'whereNotNull', 'orderBy', 'select', 'limit', 'count']) b[m] = jest.fn(() => b);
  b.where = jest.fn((...args) => { wheres.push({ table, args }); return b; });
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn((payload) => { b._mode = 'update'; updates.push({ table, payload }); return b; });
  b.returning = jest.fn(() => Promise.resolve(cfg.returning ?? []));
  b.catch = jest.fn(() => Promise.resolve());
  b.then = (resolve, reject) => {
    const value = b._mode === 'update' ? (cfg.update ?? 1) : b._mode === 'first' ? cfg.first : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  return b;
}
const enqueue = (table, cfg) => { (queues[table] = queues[table] || []).push(cfg); };

const TEXT = 'Yes, Thursday works. See you then!';
const PHONE = '+19415550142';
const draftRow = (over = {}) => ({
  id: 'draft-1', sms_log_id: 'log-1', customer_id: 'cust-1', draft_response: TEXT, flags: null, status: 'approved',
  intent: 'scheduling', campaign_type: null, purpose: null, source_ref: null, created_at: '2026-10-28T12:00:00.000Z', ...over,
});
const pins = (over = {}) => ({ draftText: TEXT, recipientPhone: PHONE, customerId: 'cust-1', latestInboundId: 'log-1', ...over });
const actor = { technicianId: 'admin-1' };

// A happy path in queue order: claim, sms_log row (recipient), newest inbound text.
function happy(draft = draftRow(), latest = { id: 'log-1', created_at: '2026-10-28T12:00:00Z' }) {
  enqueue('message_drafts', { returning: [draft] });
  enqueue('sms_log', { first: { id: 'log-1', from_phone: PHONE, to_phone: '+19415550100', customer_id: 'cust-1' } });
  enqueue('sms_log', { first: latest });
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  wheres.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  sendManualCustomerSms.mockResolvedValue({ sent: true, providerMessageId: 'SM_synthetic' });
});

describe('approveDraftFromBar', () => {
  test('claims on the carded text and sends exactly it', async () => {
    happy();
    const { status, json } = await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins() });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(wheres.some((w) => w.table === 'message_drafts' && w.args[0] === 'draft_response' && w.args[1] === TEXT)).toBe(true);
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    const input = sendManualCustomerSms.mock.calls[0][0];
    expect(input).toMatchObject({ to: PHONE, body: TEXT, entryPoint: 'admin_draft_approve', customerId: 'cust-1', metadata: { adminUserId: 'admin-1' } });
    expect(typeof input.preDispatchCheck).toBe('function');
  });

  test('the last await before the provider handoff stops the send when the customer texted again', async () => {
    happy();
    await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins() });
    const check = sendManualCustomerSms.mock.calls[0][0].preDispatchCheck;
    enqueue('sms_log', { first: { id: 'log-1' } });
    expect(await check()).toEqual({ ok: true });
    enqueue('sms_log', { first: { id: 'log-2' } });
    expect(await check()).toMatchObject({ ok: false, code: 'preview_changed' });
  });

  test('the sender\'s provider-boundary callback carries the same pin: a text after preDispatchCheck but before dispatch is caught there', async () => {
    happy();
    await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins() });
    const input = sendManualCustomerSms.mock.calls[0][0];
    expect(typeof input.preProviderCheck).toBe('function');
    enqueue('sms_log', { first: { id: 'log-1' } });
    expect(await input.preDispatchCheck()).toEqual({ ok: true });
    enqueue('sms_log', { first: { id: 'log-2' } });
    expect(await input.preProviderCheck({ channel: 'sms' })).toMatchObject({ ok: false, code: 'preview_changed' });
  });

  test('the page path passes no bar callback at all', async () => {
    happy();
    await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: null });
    const input = sendManualCustomerSms.mock.calls[0][0];
    expect(input.preDispatchCheck).toBeUndefined();
    expect(input.preProviderCheck).toBeUndefined();
  });

  test('a draft already handled or edited is not claimed: 409 preview_changed, nothing sent', async () => {
    enqueue('message_drafts', { returning: [] });
    enqueue('message_drafts', { first: draftRow({ status: 'approved' }) });
    const { status, json } = await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins() });
    expect(status).toBe(409);
    expect(json).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a changed recipient number releases the claim and sends nothing', async () => {
    happy();
    const { status, json } = await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins({ recipientPhone: '+19415550199' }) });
    expect(status).toBe(409);
    expect(json.code).toBe('preview_changed');
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(updates.some((u) => u.table === 'message_drafts' && u.payload.status === 'pending')).toBe(true);
  });

  test('a changed customer releases the claim and sends nothing', async () => {
    happy();
    const { status, json } = await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins({ customerId: 'cust-2' }) });
    expect(status).toBe(409);
    expect(json.code).toBe('preview_changed');
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a newer inbound text since the card releases the claim and sends nothing', async () => {
    happy(draftRow(), { id: 'log-2', created_at: '2026-10-28T12:30:00Z' });
    const { status, json } = await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins() });
    expect(status).toBe(409);
    expect(json.code).toBe('preview_changed');
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(updates.some((u) => u.table === 'message_drafts' && u.payload.status === 'pending')).toBe(true);
  });

  test.each([
    ['a campaign draft', { campaign_type: 'upsell', purpose: 'marketing' }],
    ['an estimate-question draft', { intent: 'estimate_clarify' }],
    ['a photo-triage draft', { intent: 'photo_triage' }],
  ])('%s stays on the page: refused before any guard, claim released, nothing sent', async (_label, over) => {
    enqueue('message_drafts', { returning: [draftRow(over)] });
    const { status, json } = await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins() });
    expect(status).toBe(409);
    expect(json.code).toBe('needs_communications_page');
    expect(evaluateCampaignSendGate).not.toHaveBeenCalled();
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(updates.every((u) => u.payload.status !== 'rejected')).toBe(true);
    expect(updates.some((u) => u.payload.status === 'pending')).toBe(true);
  });

  test('a blocked send releases the claim and the page\'s 422 comes back', async () => {
    happy();
    sendManualCustomerSms.mockResolvedValue({ sent: false, blocked: true, code: 'OPTED_OUT', reason: 'Customer opted out' });
    const { status, json } = await draftsRouter.approveDraftFromBar({ draftId: 'draft-1', actor, pins: pins() });
    expect(status).toBe(422);
    expect(json.code).toBe('OPTED_OUT');
    expect(updates.some((u) => u.table === 'message_drafts' && u.payload.status === 'pending')).toBe(true);
  });
});

describe('reviseDraftFromBar', () => {
  test('sends exactly the carded revision and claims on the original suggestion', async () => {
    happy(draftRow({ status: 'revised' }));
    const { status } = await draftsRouter.reviseDraftFromBar({ draftId: 'draft-1', actor, pins: pins(), body: { revisedResponse: 'Thursday at 10 works.' } });
    expect(status).toBe(200);
    expect(wheres.some((w) => w.table === 'message_drafts' && w.args[0] === 'draft_response' && w.args[1] === TEXT)).toBe(true);
    expect(sendManualCustomerSms.mock.calls[0][0]).toMatchObject({ body: 'Thursday at 10 works.', entryPoint: 'admin_draft_revise' });
    expect(typeof sendManualCustomerSms.mock.calls[0][0].preProviderCheck).toBe('function');
    expect(updates[0].payload).toMatchObject({ status: 'revised', revised_response: 'Thursday at 10 works.' });
  });

  test('a newer inbound text releases the claim and clears the edit, nothing sent', async () => {
    happy(draftRow({ status: 'revised' }), { id: 'log-3' });
    const { status, json } = await draftsRouter.reviseDraftFromBar({ draftId: 'draft-1', actor, pins: pins(), body: { revisedResponse: 'Thursday at 10 works.' } });
    expect(status).toBe(409);
    expect(json.code).toBe('preview_changed');
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(updates.some((u) => u.payload.status === 'pending' && u.payload.revised_response === null)).toBe(true);
  });
});

describe('rejectDraftFromBar', () => {
  test('ignores the carded draft and sends nothing', async () => {
    enqueue('message_drafts', { update: 1 });
    const { status, json } = await draftsRouter.rejectDraftFromBar({ draftId: 'draft-1', actor, pins: { draftText: TEXT } });
    expect(status).toBe(200);
    expect(json).toEqual({ success: true });
    expect(wheres.some((w) => w.table === 'message_drafts' && w.args[0] === 'draft_response' && w.args[1] === TEXT)).toBe(true);
    expect(updates[0].payload).toMatchObject({ status: 'rejected', approved_by: 'admin-1' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a draft edited or handled after the card: 409 preview_changed', async () => {
    enqueue('message_drafts', { update: 0 });
    enqueue('message_drafts', { first: draftRow({ status: 'rejected' }) });
    const { status, json } = await draftsRouter.rejectDraftFromBar({ draftId: 'draft-1', actor, pins: { draftText: TEXT } });
    expect(status).toBe(409);
    expect(json.code).toBe('preview_changed');
  });
});
