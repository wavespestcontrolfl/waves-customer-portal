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
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadFunnelStage: jest.fn().mockResolvedValue(undefined),
  bridgeLeadsFunnelStage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ success: true, message_sid: 'SM-test' }),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { resolveCustomer, executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { executeLeadsTool, resolveLeadForUpdate, previewBulkLeadUpdate } = require('../services/intelligence-bar/leads-tools');

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

  test('a pinned lead_id executes against exactly that lead', async () => {
    const leads = chain({ first: LEAD_A, update: 1 });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));

    const res = await executeLeadsTool('update_lead_status', { lead_id: 'lead-1', new_status: 'lost', lost_reason: 'test' });
    expect(res.success).toBe(true);
    expect(res.old_status).toBe('contacted');
    expect(leads.where).toHaveBeenCalledWith('id', 'lead-1');
    expect(leads.whereNull).toHaveBeenCalledWith('deleted_at');
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

  test('execution with pinned lead_ids updates only that set (intersected with the criteria)', async () => {
    const leads = chain({ select: [LEAD_A, LEAD_B], update: 2 });
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
    // Matching is constrained to the pinned ids…
    expect(leads.whereIn).toHaveBeenCalledWith('id', ['lead-1', 'lead-2', 'lead-gone']);
    // …and the UPDATE hits only the ids that still match the criteria.
    expect(leads.whereIn).toHaveBeenCalledWith('id', ['lead-1', 'lead-2']);
    expect(leads.whereNull).toHaveBeenCalledWith('deleted_at');
  });

  test('a confirmed run with dry_run:false actually updates (no silent no-op)', async () => {
    const leads = chain({ select: [LEAD_A], update: 1 });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));

    const res = await executeLeadsTool('bulk_update_leads', {
      current_status: 'contacted', new_status: 'lost', dry_run: false, lead_ids: ['lead-1'],
    });
    expect(res.dry_run).toBeUndefined();
    expect(res.updated).toBe(1);
    expect(leads.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'lost' }));
  });
});
