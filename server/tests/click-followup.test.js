/**
 * Click-followup action queue (services/click-followup.js).
 *
 * Pins the contract: gate-off shadow mode (count, never write), conversion
 * marking, 48h-outbound + reply-pause + opt-out suppression, cadence
 * stacking guard, draft insertion (intent='click_followup', status='pending',
 * GSM-7 body), the one-open-action claim, and — hardest rule in the house —
 * that this module has NO send path at all. Mirrors the
 * booking-abandon-recovery.test.js mock harness.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
  NON_LIVE_APPOINTMENT_STATUSES: ['cancelled', 'rescheduled', 'skipped', 'no_show'],
}));
jest.mock('../services/short-url', () => ({
  createTrackedShortLink: jest.fn(async () => ({
    code: 'newc0', shortUrl: 'https://portal.wavespestcontrol.com/l/newc0',
  })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (input, contactState) => contactState),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'miss' })),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => null),
}));
// Only the window constant is consumed — never the deposit machinery.
jest.mock('../services/estimate-deposits', () => ({
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { customerConvertedSince } = require('../services/estimate-conversion-guard');
const { createTrackedShortLink } = require('../services/short-url');
const { loadSuppressionState } = require('../services/messaging/validators/suppression');
const { readCachedLineType } = require('../services/messaging/validators/line-type');
const { leadIdForEstimate } = require('../services/estimate-lead-linkage');
const { _internals } = require('../services/click-followup');

const inserts = [];
const updates = [];
const deletes = [];

function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw',
    'whereNotExists', 'whereNotIn', 'andWhere', 'orWhere', 'orWhereRaw', 'orderBy', 'select', 'groupBy', 'max',
  ]) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.insert = jest.fn((payload) => { b._mode = 'insert'; inserts.push({ table, payload }); return b; });
  b.returning = jest.fn(() => b);
  b.update = jest.fn((payload) => { b._mode = 'update'; updates.push({ table, payload }); return b; });
  b.del = jest.fn(() => { b._mode = 'del'; deletes.push({ table }); return b; });
  b.then = (resolve, reject) => {
    if (b._mode === 'insert' && cfg.insertError) return Promise.reject(cfg.insertError).then(resolve, reject);
    const value = b._mode === 'insert' ? (cfg.insert ?? [{ id: 'row-1' }])
      : b._mode === 'update' ? (cfg.update ?? 1)
        : b._mode === 'del' ? (cfg.del ?? 1)
          : b._mode === 'first' ? cfg.first
            : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  b.catch = (onRejected) => b.then(undefined, onRejected);
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

const NOW = new Date('2026-07-05T15:00:00Z');
const H = 3600000;

function makeEstimate(overrides = {}) {
  return {
    id: 'est-1',
    token: 'tok-abc',
    status: 'viewed',
    archived_at: null,
    customer_id: 'cust-1',
    customer_name: 'Dana Reyes',
    customer_phone: '+19415550101',
    created_at: new Date(NOW.getTime() - 10 * 24 * H),
    sent_at: new Date(NOW.getTime() - 10 * 24 * H),
    viewed_at: new Date(NOW.getTime() - 9 * 24 * H),
    expires_at: new Date(NOW.getTime() + 15 * 24 * H),
    followup_unviewed_sent: true,
    followup_viewed_sent: true,
    followup_final_sent: true,
    followup_expiring_sent: true,
    ...overrides,
  };
}

function makeClick(overrides = {}) {
  return {
    click_id: 'click-1',
    clicked_at: new Date(NOW.getTime() - 6 * H),
    short_code_id: 'sc-1',
    kind: 'estimate',
    entity_type: 'estimates',
    entity_id: 'est-1',
    customer_id: 'cust-1',
    lead_id: null,
    ...overrides,
  };
}

// Happy-path DB script minus the candidate rows (enqueued per test).
function enqueueCleanChecks() {
  enqueue('sms_log', { first: null });                    // no outbound in 48h
  enqueue('messages', { first: null });                   // no recent reply
  enqueue('click_followup_actions', { first: null });     // no open action
  enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] }); // claim
  enqueue('message_drafts', { insert: [{ id: 'draft-1' }] });
  enqueue('click_followup_actions', { update: 1 });       // → drafted
  enqueue('short_codes', { update: 1 });                  // message_ref stamp
}

beforeEach(() => {
  jest.clearAllMocks();
  inserts.length = 0;
  updates.length = 0;
  deletes.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  // Transaction proxy: route trx(table) through the same table queues so the
  // draft-insert + action-link pair records like any other call; a rejection
  // inside the callback propagates as the transaction failing (rollback).
  db.transaction = jest.fn(async (cb) => cb(db));
  isEnabled.mockReturnValue(true);
  customerConvertedSince.mockResolvedValue({ converted: false });
  createTrackedShortLink.mockResolvedValue({
    code: 'newc0', shortUrl: 'https://portal.wavespestcontrol.com/l/newc0',
  });
  loadSuppressionState.mockImplementation(async (input, contactState) => contactState);
  readCachedLineType.mockResolvedValue({ state: 'miss' });
  leadIdForEstimate.mockResolvedValue(null);
});

describe('runQueue — draft creation', () => {
  test('queues a pending draft for a clicked, unconverted, unsuppressed estimate', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueueCleanChecks();

    const counts = await _internals.runQueue(NOW);

    expect(counts).toMatchObject({ candidates: 1, drafted: 1 });

    // Claim first (status pending), then flip to drafted with the draft id.
    const claim = inserts.find((i) => i.table === 'click_followup_actions');
    expect(claim.payload).toMatchObject({
      short_code_id: 'sc-1',
      short_code_click_id: 'click-1',
      customer_id: 'cust-1',
      contact_phone: '9415550101', // persisted phone dedupe key (last-10)
      entity_type: 'estimates',
      entity_id: 'est-1',
      status: 'pending',
    });
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'click_followup_actions', payload: expect.objectContaining({ status: 'drafted', draft_id: 'draft-1' }) },
    ]));

    // The draft: pending + click_followup intent, owner-reviewable.
    const draft = inserts.find((i) => i.table === 'message_drafts');
    expect(draft.payload).toMatchObject({
      customer_id: 'cust-1',
      intent: 'click_followup',
      status: 'pending',
    });
    expect(draft.payload.draft_response).toContain('Dana');
    expect(draft.payload.draft_response).toContain('https://portal.wavespestcontrol.com/l/newc0');
    const flags = JSON.parse(draft.payload.flags);
    expect(flags).toMatchObject({ click_followup: true, toPhone: '+19415550101', estimate_id: 'est-1' });

    // Fresh tracked mint carries the linkage.
    expect(createTrackedShortLink).toHaveBeenCalledWith(
      'https://portal.wavespestcontrol.com/estimate/tok-abc',
      expect.objectContaining({ channel: 'sms', purpose: 'click_followup', customerId: 'cust-1' }),
    );
    // Minted code points back at the draft that carries it.
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'short_codes', payload: expect.objectContaining({ message_ref: 'message_drafts:draft-1' }) },
    ]));
  });

  test('draft body is GSM-7 safe: no em-dashes, curly quotes, or emoji', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueueCleanChecks();

    await _internals.runQueue(NOW);

    const draft = inserts.find((i) => i.table === 'message_drafts');
    const body = draft.payload.draft_response;
    expect(body).not.toMatch(/[–—‘’“”…]/); // – — ‘ ’ “ ” …
    expect(/^[\x20-\x7E]*$/.test(body)).toBe(true); // plain printable ASCII only
    // Template itself stays GSM-7 clean at the source too.
    expect(/^[\x20-\x7E{}]*$/.test(_internals.DRAFT_TEMPLATE)).toBe(true);
  });

  test('lead-only click (no customer) still drafts, keyed on lead_id + flags phone', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick({ customer_id: null, lead_id: 'lead-1' })] });
    enqueue('estimates', { first: makeEstimate({ customer_id: null }) });
    enqueueCleanChecks();

    const counts = await _internals.runQueue(NOW);

    expect(counts.drafted).toBe(1);
    const claim = inserts.find((i) => i.table === 'click_followup_actions');
    expect(claim.payload).toMatchObject({ customer_id: null, lead_id: 'lead-1', status: 'pending' });
    const draft = inserts.find((i) => i.table === 'message_drafts');
    expect(draft.payload.customer_id).toBeNull();
    expect(JSON.parse(draft.payload.flags).toPhone).toBe('+19415550101');
  });

  test('one candidate per contact per run — two clicks by the same customer collapse', async () => {
    enqueue('short_code_clicks as scc', {
      rows: [
        makeClick(),
        makeClick({ click_id: 'click-2', short_code_id: 'sc-2', clicked_at: new Date(NOW.getTime() - 20 * H) }),
      ],
    });
    enqueue('estimates', { first: makeEstimate() });
    enqueueCleanChecks();

    const counts = await _internals.runQueue(NOW);

    expect(counts.candidates).toBe(1);
    expect(inserts.filter((i) => i.table === 'message_drafts')).toHaveLength(1);
  });

  test('anonymous click (no customer/lead on the code) resolves the lead from the estimate', async () => {
    leadIdForEstimate.mockResolvedValue('lead-9');
    enqueue('short_code_clicks as scc', { rows: [makeClick({ customer_id: null, lead_id: null })] });
    enqueue('estimates', { first: makeEstimate({ customer_id: null }) }); // loaded once (cached) for grouping + processing
    enqueueCleanChecks();

    const counts = await _internals.runQueue(NOW);

    expect(counts.drafted).toBe(1);
    expect(leadIdForEstimate).toHaveBeenCalled();
    const claim = inserts.find((i) => i.table === 'click_followup_actions');
    expect(claim.payload).toMatchObject({ lead_id: 'lead-9', customer_id: null, status: 'pending' });
    // The fresh mint carries the resolved lead too.
    expect(createTrackedShortLink).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ leadId: 'lead-9' }));
    expect(JSON.parse(inserts.find((i) => i.table === 'message_drafts').payload.flags).lead_id).toBe('lead-9');
  });

  test('contactless clicks dedupe by last-10 phone, never entity_id — two estimates, one person, one draft', async () => {
    enqueue('short_code_clicks as scc', {
      rows: [
        makeClick({ customer_id: null, lead_id: null, entity_id: 'est-1' }),
        makeClick({
          click_id: 'click-2', short_code_id: 'sc-2', customer_id: null, lead_id: null,
          entity_id: 'est-2', clicked_at: new Date(NOW.getTime() - 12 * H),
        }),
      ],
    });
    // Grouping loads BOTH estimates (different entity_ids) — same phone.
    enqueue('estimates', { first: makeEstimate({ id: 'est-1', customer_id: null }) });
    enqueue('estimates', { first: makeEstimate({ id: 'est-2', customer_id: null }) });
    enqueueCleanChecks();

    const counts = await _internals.runQueue(NOW);

    expect(counts.candidates).toBe(1); // phone key collapsed them
    expect(inserts.filter((i) => i.table === 'message_drafts')).toHaveLength(1);
  });

  test('re-click eligibility: the candidate anti-join is per CLICK, not per code', () => {
    // The mocked builder never executes whereNotExists callbacks, so pin the
    // query shape at the source: exclusion keys on short_code_click_id (a
    // terminal action for an OLD click never shadows a NEW click), not on
    // the code-level short_code_id.
    const src = require('fs').readFileSync(require.resolve('../services/click-followup'), 'utf8');
    expect(src).toContain('cfa.short_code_click_id = scc.id');
    expect(src).not.toContain('cfa.short_code_id = sc.id');
  });
});

describe('runQueue — gate + suppression', () => {
  test('gate off → shadow only: counts candidates, writes NOTHING', async () => {
    isEnabled.mockReturnValue(false);
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });

    const counts = await _internals.runQueue(NOW);

    expect(counts).toMatchObject({ candidates: 1, drafted: 0 });
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('converted contact → action marked converted, no draft', async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'paid-invoice' });
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] }); // outcome row

    const counts = await _internals.runQueue(NOW);

    expect(counts.converted).toBe(1);
    const outcome = inserts.find((i) => i.table === 'click_followup_actions');
    expect(outcome.payload).toMatchObject({ status: 'converted' });
    expect(outcome.payload.converted_at).toBeInstanceOf(Date);
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test("conversion guard-error (fail-closed transient) → skip with NO row, so next tick retries", async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'guard-error' });
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });

    const counts = await _internals.runQueue(NOW);

    expect(counts.skipped).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('outbound SMS in the last 48h → no draft, no action row (transient hold)', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('sms_log', { first: { id: 'sms-1' } }); // recent outbound

    const counts = await _internals.runQueue(NOW);

    expect(counts.skipped).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('reply-pause: contact texted Waves recently → no draft (Virginia owns the thread)', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('sms_log', { first: null });
    enqueue('messages', { first: { id: 'm-1' } }); // recent inbound

    const counts = await _internals.runQueue(NOW);

    expect(counts.skipped).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('opt-out suppression record → dismissed, never drafted', async () => {
    loadSuppressionState.mockImplementation(async (input, contactState) => {
      contactState.suppression = { reason: 'opt_out_keyword' };
      return contactState;
    });
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] }); // outcome row

    const counts = await _internals.runQueue(NOW);

    expect(counts.dismissed).toBe(1);
    expect(inserts.find((i) => i.table === 'click_followup_actions').payload).toMatchObject({ status: 'dismissed' });
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('known-landline (cached line type) → dismissed', async () => {
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] });

    const counts = await _internals.runQueue(NOW);

    expect(counts.dismissed).toBe(1);
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('cadence stage due within 24h → dismissed (never stack nudges)', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', {
      // viewed 49h ago with the viewed-stage flag unset → stage window
      // [viewed+48h, viewed+72h] overlaps the next 24h.
      first: makeEstimate({ viewed_at: new Date(NOW.getTime() - 49 * H), followup_viewed_sent: false }),
    });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] });

    const counts = await _internals.runQueue(NOW);

    expect(counts.dismissed).toBe(1);
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('terminal estimate (declined/expired/accepted/void or archived) → dismissed', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate({ status: 'declined' }) });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] });

    const counts = await _internals.runQueue(NOW);

    expect(counts.dismissed).toBe(1);
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('lost claim (unique-violation on the open-action guard) → skip, no draft', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('sms_log', { first: null });
    enqueue('messages', { first: null });
    enqueue('click_followup_actions', { first: null }); // advisory pre-check passes
    enqueue('click_followup_actions', {
      insertError: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });

    const counts = await _internals.runQueue(NOW);

    expect(counts.skipped).toBe(1);
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('open action already held by the contact (advisory pre-check) → skip', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('sms_log', { first: null });
    enqueue('messages', { first: null });
    enqueue('click_followup_actions', { first: { id: 'act-existing' } });

    const counts = await _internals.runQueue(NOW);

    expect(counts.skipped).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('phone-only dedupe persists across ticks: open action for the same phone on ANOTHER estimate → skip', async () => {
    // Contactless click on est-2; a prior tick left an open action for the
    // same phone (found via the contact_phone key in hasOpenAction).
    enqueue('short_code_clicks as scc', {
      rows: [makeClick({ customer_id: null, lead_id: null, entity_id: 'est-2' })],
    });
    enqueue('estimates', { first: makeEstimate({ id: 'est-2', customer_id: null }) });
    enqueue('sms_log', { first: null });
    enqueue('messages', { first: null });
    enqueue('click_followup_actions', { first: { id: 'act-open-same-phone' } });

    const counts = await _internals.runQueue(NOW);

    expect(counts.skipped).toBe(1);
    expect(inserts).toEqual([]);
    // The pre-check was given the phone key to match on.
    const openCheck = db.mock.results
      .map((r, i) => ({ table: db.mock.calls[i][0], builder: r.value }))
      .find((x) => x.table === 'click_followup_actions');
    expect(openCheck).toBeDefined();
  });

  test('deposit-abandonment stage due (gate on, pending deposit 2-72h old) → dismissed, never stacked', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', {
      first: makeEstimate({ status: 'viewed', followup_deposit_abandoned_sent: false }),
    });
    enqueue('estimate_deposits', {
      first: { latest_pending_at: new Date(NOW.getTime() - 5 * H) }, // inside the 2-72h window
    });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] }); // dismissed outcome row

    const counts = await _internals.runQueue(NOW);

    expect(counts.dismissed).toBe(1);
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
    expect(inserts.find((i) => i.table === 'click_followup_actions').payload).toMatchObject({ status: 'dismissed' });
  });

  test('deposit stage gate OFF → no deposit lookup can suppress (stage only shadow-logs)', async () => {
    // clickFollowup gate on, deposit gate off.
    isEnabled.mockImplementation((key) => key === 'clickFollowup');
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', {
      first: makeEstimate({ status: 'viewed', followup_deposit_abandoned_sent: false }),
    });
    enqueueCleanChecks();

    const counts = await _internals.runQueue(NOW);

    expect(counts.drafted).toBe(1);
  });

  test('lead-only estimate whose lead is WON → marked converted, no draft', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick({ customer_id: null, lead_id: 'lead-1' })] });
    enqueue('estimates', { first: makeEstimate({ customer_id: null }) });
    enqueue('leads', { first: { id: 'lead-1', status: 'won', customer_id: null, converted_at: null } });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] }); // converted outcome row

    const counts = await _internals.runQueue(NOW);

    expect(counts.converted).toBe(1);
    expect(inserts.find((i) => i.table === 'click_followup_actions').payload).toMatchObject({ status: 'converted' });
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('lead-only estimate with a LINKED customer runs the conversion guard against that customer', async () => {
    customerConvertedSince
      .mockResolvedValueOnce({ converted: false })                          // estimate-level (no customer_id)
      .mockResolvedValueOnce({ converted: true, reason: 'paid-invoice' });  // lead's linked customer
    enqueue('short_code_clicks as scc', { rows: [makeClick({ customer_id: null, lead_id: 'lead-1' })] });
    enqueue('estimates', { first: makeEstimate({ customer_id: null }) });
    enqueue('leads', { first: { id: 'lead-1', status: 'quoted', customer_id: 'cust-9', converted_at: null } });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] });

    const counts = await _internals.runQueue(NOW);

    expect(counts.converted).toBe(1);
    expect(customerConvertedSince).toHaveBeenLastCalledWith(
      expect.objectContaining({ customer_id: 'cust-9' }),
    );
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('booked lead-only BOOKING click: phone-evidence conversion suppresses the draft (queue side)', async () => {
    // The admin booking link targets /book with no lead_id/estimate_id, so
    // the booking the click produced leaves no lead/estimate evidence — only
    // a new customers row matching the contact's phone.
    enqueue('short_code_clicks as scc', {
      rows: [makeClick({ kind: 'booking', customer_id: null, lead_id: 'lead-1' })],
    });
    enqueue('estimates', { first: makeEstimate({ customer_id: null }) });
    enqueue('leads', { first: { id: 'lead-1', status: 'quoted', customer_id: null, converted_at: null } });
    enqueue('customers', { first: { id: 'new-cust' } }); // phone-matched customer created after the click
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] }); // converted outcome row

    const counts = await _internals.runQueue(NOW);

    expect(counts.converted).toBe(1);
    expect(inserts.find((i) => i.table === 'click_followup_actions').payload).toMatchObject({ status: 'converted' });
    expect(inserts.find((i) => i.table === 'message_drafts')).toBeUndefined();
  });

  test('unconverted lead-only estimate still drafts (lead check passes through)', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick({ customer_id: null, lead_id: 'lead-1' })] });
    enqueue('estimates', { first: makeEstimate({ customer_id: null }) });
    enqueue('leads', { first: { id: 'lead-1', status: 'quoted', customer_id: null, converted_at: null } });
    enqueueCleanChecks();

    const counts = await _internals.runQueue(NOW);

    expect(counts.drafted).toBe(1);
  });

  test('draft insert failure releases the pending claim so the next tick retries', async () => {
    enqueue('short_code_clicks as scc', { rows: [makeClick()] });
    enqueue('estimates', { first: makeEstimate() });
    enqueue('sms_log', { first: null });
    enqueue('messages', { first: null });
    enqueue('click_followup_actions', { first: null });
    enqueue('click_followup_actions', { insert: [{ id: 'act-1' }] }); // claim ok
    enqueue('message_drafts', { insertError: new Error('insert failed') });

    const counts = await _internals.runQueue(NOW);

    expect(counts.drafted).toBe(0);
    expect(deletes).toEqual([{ table: 'click_followup_actions' }]); // claim released
  });
});

describe('cadenceStageDueSoon', () => {
  const { cadenceStageDueSoon } = _internals;

  test('unviewed stage inside its 24-48h window → due', () => {
    const est = makeEstimate({
      status: 'sent', viewed_at: null,
      sent_at: new Date(NOW.getTime() - 25 * H),
      followup_unviewed_sent: false,
    });
    expect(cadenceStageDueSoon(est, NOW)).toBe(true);
  });

  test('all stage flags already sent → not due', () => {
    expect(cadenceStageDueSoon(makeEstimate(), NOW)).toBe(false);
  });

  test('expiring stage: expires in 2 days with flag unset → due', () => {
    const est = makeEstimate({
      expires_at: new Date(NOW.getTime() + 2 * 24 * H),
      followup_expiring_sent: false,
    });
    expect(cadenceStageDueSoon(est, NOW)).toBe(true);
  });

  test('windows long past → not due', () => {
    const est = makeEstimate({
      viewed_at: new Date(NOW.getTime() - 20 * 24 * H),
      followup_viewed_sent: false,
      followup_final_sent: false,
    });
    expect(cadenceStageDueSoon(est, NOW)).toBe(false);
  });
});

describe('expireStaleActions', () => {
  test('flips stale open actions to expired AND retires their linked pending drafts', async () => {
    enqueue('click_followup_actions', {
      rows: [
        { id: 'act-1', draft_id: 'draft-1' },
        { id: 'act-2', draft_id: null }, // pending claim that never drafted
      ],
    });
    enqueue('click_followup_actions', { update: 2 });
    enqueue('message_drafts', { update: 1 });

    const n = await _internals.expireStaleActions(NOW);

    expect(n).toBe(2);
    expect(updates).toEqual([
      { table: 'click_followup_actions', payload: expect.objectContaining({ status: 'expired' }) },
      // Linked draft leaves the sendable pool: rejected + flags.expired merge.
      { table: 'message_drafts', payload: expect.objectContaining({ status: 'rejected' }) },
    ]);
    expect(String(db.raw.mock.calls.map((c) => c[0]).join('\n'))).toContain('"expired": true');
  });

  test('no stale actions → no writes at all', async () => {
    enqueue('click_followup_actions', { rows: [] });

    const n = await _internals.expireStaleActions(NOW);

    expect(n).toBe(0);
    expect(updates).toEqual([]);
  });
});

describe('NO-SEND guarantee', () => {
  test('queue + shared gate sources have no path to the messaging send pipeline', () => {
    const fs = require('fs');
    for (const mod of ['../services/click-followup', '../services/click-followup-gate']) {
      const src = fs.readFileSync(require.resolve(mod), 'utf8');
      expect(src).not.toContain('sendCustomerMessage');
      expect(src).not.toContain('send-customer-message');
      expect(src).not.toContain('sendTemplate');
      expect(src).not.toMatch(/twilio/i);
    }
  });
});

// Direct gate tests — the SAME verdicts drive both the cron (draft time) and
// admin-drafts approve/revise (send time), so pinning each code here pins
// both surfaces at once (parity by construction).
describe('evaluateClickFollowupGate — shared verdict codes', () => {
  const gate = require('../services/click-followup-gate');
  const baseInput = () => ({
    estimate: makeEstimate(),
    customerId: 'cust-1',
    leadId: null,
    phone: '+19415550101',
    sinceTs: new Date(NOW.getTime() - 6 * H),
    now: NOW,
  });

  test('estimate_terminal: missing, archived, or terminal-status estimates', async () => {
    expect((await gate.evaluateClickFollowupGate({ ...baseInput(), estimate: null })).code).toBe('estimate_terminal');
    expect((await gate.evaluateClickFollowupGate({ ...baseInput(), estimate: makeEstimate({ status: 'declined' }) })).code).toBe('estimate_terminal');
    expect((await gate.evaluateClickFollowupGate({ ...baseInput(), estimate: makeEstimate({ archived_at: new Date() }) })).code).toBe('estimate_terminal');
  });

  test('converted: customer-guard evidence', async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'paid-invoice' });
    const v = await gate.evaluateClickFollowupGate(baseInput());
    expect(v).toMatchObject({ ok: false, code: 'converted', reason: 'paid-invoice' });
  });

  test('converted: PHONE evidence — a customers row created after the click (booked lead-only booking click)', async () => {
    enqueue('customers', { first: { id: 'new-cust' } }); // created >= clicked_at, phone matches
    const v = await gate.evaluateClickFollowupGate({ ...baseInput(), estimate: makeEstimate({ customer_id: null }), customerId: null });
    expect(v).toMatchObject({ ok: false, code: 'converted', reason: 'phone-customer-created' });
  });

  test('converted: PHONE evidence — a live booking whose customer matches the phone', async () => {
    enqueue('customers', { first: null });                       // no new customer row
    enqueue('scheduled_services as ss', { first: { id: 'ss-9' } }); // live booking after the click
    const v = await gate.evaluateClickFollowupGate({ ...baseInput(), estimate: makeEstimate({ customer_id: null }), customerId: null });
    expect(v).toMatchObject({ ok: false, code: 'converted', reason: 'phone-booking' });
  });

  test('converted: lead-side evidence at the gate (approval twin of the queue check)', async () => {
    enqueue('leads', { first: { id: 'lead-1', status: 'won', customer_id: null, converted_at: null } });
    const v = await gate.evaluateClickFollowupGate({
      ...baseInput(), estimate: makeEstimate({ customer_id: null }), customerId: null, leadId: 'lead-1',
    });
    expect(v).toMatchObject({ ok: false, code: 'converted', reason: 'lead-won' });
  });

  test('suppressed: opt-out record blocks', async () => {
    loadSuppressionState.mockImplementation(async (input, state) => {
      state.suppression = { reason: 'opt_out_keyword' };
      return state;
    });
    const v = await gate.evaluateClickFollowupGate(baseInput());
    expect(v).toMatchObject({ ok: false, code: 'suppressed' });
  });

  test('cadence_due: a stage window overlapping the next 24h', async () => {
    const v = await gate.evaluateClickFollowupGate({
      ...baseInput(),
      estimate: makeEstimate({ viewed_at: new Date(NOW.getTime() - 49 * H), followup_viewed_sent: false }),
    });
    expect(v).toMatchObject({ ok: false, code: 'cadence_due' });
  });

  test('recent_outbound / replied_recently: touch holds', async () => {
    enqueue('sms_log', { first: { id: 'sms-1' } });
    expect((await gate.evaluateClickFollowupGate(baseInput())).code).toBe('recent_outbound');

    enqueue('sms_log', { first: null });
    enqueue('messages', { first: { id: 'm-1' } });
    expect((await gate.evaluateClickFollowupGate(baseInput())).code).toBe('replied_recently');
  });

  test('guard_error: fail-closed conversion lookup', async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'guard-error' });
    expect((await gate.evaluateClickFollowupGate(baseInput())).code).toBe('guard_error');
  });

  test('all clear → ok', async () => {
    expect((await gate.evaluateClickFollowupGate(baseInput())).ok).toBe(true);
  });
});
