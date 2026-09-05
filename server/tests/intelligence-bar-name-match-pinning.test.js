/**
 * IB name-match resolution guards (comms + leads tools).
 *
 * The bugs under test:
 *  - resolveCustomer resolved a partial name with `.first()` — no ORDER BY,
 *    no ambiguity check, no deleted_at filter — so "Alpha" could resolve to
 *    whichever row Postgres returned first, including an archived/merged-away
 *    customer. Now: soft-deleted rows are excluded and >1 live match returns
 *    a structured ambiguity error instead of a row.
 *  - update_lead_status by lead_name had the same `.first()` roulette.
 *  - bulk_update_leads re-queried the match set at execute time; it now
 *    honors a pinned `lead_ids` list so the executed set is always a subset
 *    of the previewed one, and the dry run returns `matched_ids` for pinning.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  // The single-lead status update commits status + activity in one
  // transaction (GH r14 P2) — the trx handle is the same mock, so each
  // test's per-table implementation serves both reads and the trx writes.
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadFunnelStage: jest.fn().mockResolvedValue(undefined),
  bridgeLeadsFunnelStage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/lead-attribution', () => ({
  settleWonFunnelRow: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ success: true, message_sid: 'SM-test' }),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { resolveCustomer, executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { executeLeadsTool, resolveLeadForUpdate, previewBulkLeadUpdate } = require('../services/intelligence-bar/leads-tools');
const { bridgeLeadFunnelStage, bridgeLeadsFunnelStage } = require('../services/lead-funnel-bridge');
const { settleWonFunnelRow } = require('../services/lead-attribution');

// Minimal knex chain: filter methods return the chain; terminal methods
// resolve per-method results supplied by the test.
function chain(resultByMethod = {}) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereRaw', 'whereILike', 'orWhereILike', 'orWhereRaw', 'leftJoin', 'orderBy', 'clone']) {
    c[m] = jest.fn(() => c);
  }
  for (const m of ['first', 'limit', 'select', 'update', 'insert']) {
    c[m] = jest.fn(async () => resultByMethod[m]);
  }
  return c;
}

const CUST_A = { id: 'cust-1', first_name: 'Testa', last_name: 'Alpha', phone: '+19415551111' };
const CUST_B = { id: 'cust-2', first_name: 'Testb', last_name: 'Alpha', phone: '+19415552222' };
const LEAD_A = { id: 'lead-1', first_name: 'Testc', last_name: 'Beta', status: 'contacted', phone: '+19415553333' };
const LEAD_B = { id: 'lead-2', first_name: 'Testd', last_name: 'Beta', status: 'new', phone: '+19415554444' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveCustomer (comms)', () => {
  test('a name matching two live customers returns a structured ambiguity error, not a row', async () => {
    const customers = chain({ limit: [CUST_A, CUST_B] });
    db.mockReturnValue(customers);

    const res = await resolveCustomer({ customer_name: 'Alpha' });
    expect(res.ambiguous).toBe(true);
    expect(res.error).toContain('Multiple customers match');
    expect(res.candidates).toEqual([
      { id: 'cust-1', name: 'Testa Alpha', phone_last4: '1111' },
      { id: 'cust-2', name: 'Testb Alpha', phone_last4: '2222' },
    ]);
    // Soft-deleted customers are excluded from name resolution.
    expect(customers.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(customers.limit).toHaveBeenCalledWith(2);
  });

  test('a unique live match resolves to the row', async () => {
    db.mockReturnValue(chain({ limit: [CUST_A] }));
    expect(await resolveCustomer({ customer_name: 'Testa' })).toEqual(CUST_A);
  });

  test('phone lookup excludes soft-deleted customers', async () => {
    const customers = chain({ first: CUST_A });
    db.mockReturnValue(customers);
    await resolveCustomer({ phone: '941-555-1111' });
    expect(customers.whereNull).toHaveBeenCalledWith('deleted_at');
  });

  test('send_sms with an ambiguous name sends NOTHING and surfaces the ambiguity', async () => {
    db.mockReturnValue(chain({ limit: [CUST_A, CUST_B] }));

    const res = await executeCommsTool('send_sms', { customer_name: 'Alpha', message: 'hello' });
    expect(res.ambiguous).toBe(true);
    expect(res.candidates).toHaveLength(2);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a pinned confirmation refuses to send when the customer phone changed inside the pending window', async () => {
    // The record's phone no longer matches the approved (pinned) phone.
    db.mockReturnValue(chain({ first: { ...CUST_A, phone: '+19415559999' } }));

    const res = await executeCommsTool('send_sms', {
      customer_id: 'cust-1', phone: '+19415551111', message: 'hello', _require_phone_match: true,
    });
    expect(res.preview_changed).toBe(true);
    expect(res.error).toContain('phone changed');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a pinned confirmation refuses when the customer was archived during the pending window', async () => {
    // whereNull('deleted_at') makes the confirm-time lookup miss the
    // archived row even though its phone is unchanged.
    const customers = chain({ first: undefined });
    db.mockReturnValue(customers);

    const res = await executeCommsTool('send_sms', {
      customer_id: 'cust-1', phone: '+19415551111', message: 'hello', _require_phone_match: true,
    });
    expect(res.preview_changed).toBe(true);
    expect(customers.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('without the pin, a phone/record mismatch degrades to a phone-only send (legacy behavior)', async () => {
    db.mockReturnValue(chain({ first: { ...CUST_A, phone: '+19415559999' } }));

    const res = await executeCommsTool('send_sms', { customer_id: 'cust-1', phone: '+19415551111', message: 'hello' });
    expect(res.preview_changed).toBeUndefined();
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: '+19415551111', customerId: null }));
  });
});

describe('update_lead_status (leads)', () => {
  test('a name matching two active leads is refused — nothing is updated', async () => {
    const leads = chain({ limit: [LEAD_A, LEAD_B] });
    db.mockReturnValue(leads);

    const res = await executeLeadsTool('update_lead_status', { lead_name: 'Beta', new_status: 'lost', lost_reason: 'test' });
    expect(res.ambiguous).toBe(true);
    expect(res.error).toContain('Multiple active leads match');
    expect(res.candidates.map(c => c.id)).toEqual(['lead-1', 'lead-2']);
    expect(leads.update).not.toHaveBeenCalled();
  });

  test('a pinned lead_id executes against exactly that lead, with the read status re-asserted in the UPDATE', async () => {
    const leads = chain({ first: LEAD_A, update: [{ id: 'lead-1' }] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));

    const res = await executeLeadsTool('update_lead_status', { lead_id: 'lead-1', new_status: 'lost', lost_reason: 'test' });
    expect(res.success).toBe(true);
    expect(res.old_status).toBe('contacted');
    expect(leads.where).toHaveBeenCalledWith('id', 'lead-1');
    // Atomic guard: the UPDATE's WHERE carries the status the card was built
    // from, so a concurrent transition matches zero rows.
    expect(leads.where).toHaveBeenCalledWith('status', 'contacted');
    expect(leads.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(leads.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'lost' }), ['id', 'customer_id']);
  });

  test('a won through the single-lead tool runs the shared won settlement (bridge + wizard-repeat settlement), not the bare bridge (codex #3834 r34 P1)', async () => {
    // The customer handed to the settlement is the one the claimed UPDATE
    // returned (c2), never the pre-update read (c1) — a reassignment that
    // left the status alone lands in between (codex r35 P1).
    const leads = chain({ first: { ...LEAD_A, customer_id: 'c1' }, update: [{ id: 'lead-1', customer_id: 'c2' }] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));
    settleWonFunnelRow.mockResolvedValueOnce({ reason: 'error' });

    const res = await executeLeadsTool('update_lead_status', { lead_id: 'lead-1', new_status: 'won' });
    expect(res.success).toBe(true);
    expect(leads.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'won' }), ['id', 'customer_id']);
    expect(settleWonFunnelRow).toHaveBeenCalledWith('lead-1', 'c2');
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    expect(res.warning).toMatch(/attribution reporting may lag/);
  });

  test('a zero-row guarded update (concurrent transition) refuses instead of claiming success', async () => {
    const leads = chain({ first: LEAD_A, update: [] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));

    const res = await executeLeadsTool('update_lead_status', { lead_id: 'lead-1', new_status: 'lost' });
    expect(res.preview_changed).toBe(true);
    expect(res.success).toBeUndefined();
    expect(activities.insert).not.toHaveBeenCalled();
  });

  test('a pinned confirmation refuses a stale transition when the lead moved inside the pending window', async () => {
    const leads = chain({ first: LEAD_A }); // live status: contacted
    db.mockReturnValue(leads);

    const res = await executeLeadsTool('update_lead_status', {
      lead_id: 'lead-1', new_status: 'lost', _expected_status: 'new',
    });
    expect(res.preview_changed).toBe(true);
    expect(res.error).toContain('changed after the card was approved');
    expect(leads.update).not.toHaveBeenCalled();
  });

  test('resolveLeadForUpdate returns the single active match for pinning', async () => {
    db.mockReturnValue(chain({ limit: [LEAD_A] }));
    expect(await resolveLeadForUpdate({ lead_name: 'Testc' })).toEqual(LEAD_A);
  });
});

describe('bulk_update_leads (leads)', () => {
  test('dry run returns matched_ids so the proposal can pin the previewed set', async () => {
    db.mockReturnValue(chain({ select: [LEAD_A, LEAD_B] }));

    const res = await previewBulkLeadUpdate({ current_status: 'contacted', new_status: 'lost' });
    expect(res.dry_run).toBe(true);
    expect(res.matches).toBe(2);
    expect(res.matched_ids).toEqual(['lead-1', 'lead-2']);
  });

  test('execution is ONE guarded UPDATE: pinned ids AND the criteria ride in the same WHERE, RETURNING reports the real set', async () => {
    // Only two of the three pinned leads still match the criteria at
    // confirm time — the guarded UPDATE returns exactly those.
    const leads = chain({ update: [{ id: 'lead-1' }, { id: 'lead-2' }] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));

    const res = await executeLeadsTool('bulk_update_leads', {
      current_status: 'contacted',
      new_status: 'lost',
      dry_run: false,
      lead_ids: ['lead-1', 'lead-2', 'lead-gone'],
    });

    expect(res.success).toBe(true);
    expect(res.updated).toBe(2);
    // The UPDATE itself carries the pinned ids and the criteria guards —
    // no separate SELECT-then-UPDATE-by-id race window.
    expect(leads.whereIn).toHaveBeenCalledWith('id', ['lead-1', 'lead-2', 'lead-gone']);
    expect(leads.where).toHaveBeenCalledWith('status', 'contacted');
    expect(leads.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(leads.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'lost' }), ['id']);
    expect(leads.select).not.toHaveBeenCalled();
  });

  test('a bulk WON keeps the ONE set-based bridge and runs the shared settlement only for confirmed wizard repeats (codex #3834 r34 P1, r35 P2)', async () => {
    // Three leads won; only lead-2 is a quote_wizard row carrying the marker.
    const leads = chain({ update: [{ id: 'lead-1' }, { id: 'lead-2' }, { id: 'lead-3' }], select: [{ id: 'lead-2', customer_id: 'c2' }] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));
    bridgeLeadsFunnelStage.mockResolvedValueOnce({ reason: 'error' });

    const res = await executeLeadsTool('bulk_update_leads', {
      current_status: 'estimate_sent', new_status: 'won', dry_run: false, lead_ids: ['lead-1', 'lead-2', 'lead-3'],
    });
    expect(res.success).toBe(true);
    expect(bridgeLeadsFunnelStage).toHaveBeenCalledTimes(1);
    expect(bridgeLeadsFunnelStage).toHaveBeenCalledWith(['lead-1', 'lead-2', 'lead-3'], 'won');
    expect(leads.whereRaw).toHaveBeenCalledWith("extracted_data->>'duplicate_of_lead_id' IS NOT NULL");
    expect(settleWonFunnelRow).toHaveBeenCalledTimes(1);
    expect(settleWonFunnelRow).toHaveBeenCalledWith('lead-2', 'c2');
    // The set bridge's ERROR is still the card warning.
    expect(res.warning).toMatch(/attribution reporting may lag/);
  });

  test('a bulk WON whose repeat discovery fails after the statuses committed still reports success with the attribution warning and writes the activities (codex #3834 r37 P2)', async () => {
    const leads = chain({ update: [{ id: 'lead-1' }] });
    leads.select.mockRejectedValueOnce(new Error('db boom'));
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));

    const res = await executeLeadsTool('bulk_update_leads', {
      current_status: 'estimate_sent', new_status: 'won', dry_run: false, lead_ids: ['lead-1'],
    });
    expect(res.success).toBe(true);
    expect(res.updated).toBe(1);
    expect(res.warning).toMatch(/attribution reporting may lag/);
    expect(activities.insert).toHaveBeenCalled();
    expect(settleWonFunnelRow).not.toHaveBeenCalled();
  });

  test('a confirmed run with dry_run:false actually updates (no silent no-op)', async () => {
    const leads = chain({ update: [{ id: 'lead-1' }] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));

    const res = await executeLeadsTool('bulk_update_leads', {
      current_status: 'contacted', new_status: 'lost', dry_run: false, lead_ids: ['lead-1'],
    });
    expect(res.dry_run).toBeUndefined();
    expect(res.updated).toBe(1);
    expect(leads.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'lost' }), ['id']);
  });
});
