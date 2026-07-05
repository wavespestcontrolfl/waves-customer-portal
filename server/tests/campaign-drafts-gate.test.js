/**
 * Campaign pre-send gate (services/campaign-drafts-gate.js) — the ONE guard
 * stack shared by the generators (draft time) and the admin-drafts
 * approve/revise route (send time).
 *
 * Pins, per verdict code:
 *  - customer_not_found / customer_deleted (both campaign types)
 *  - customer_not_live: upsell target deactivated or demoted while pending
 *  - not_lapsed: reactivation target rebooked/promoted back to a live stage —
 *    including the BRANCHED lapsed predicate (churned needs the
 *    cancellation-processor stamps; dormant matches on the stage alone)
 *  - opportunity_missing / opportunity_closed: the source_ref
 *    upsell_opportunities row vanished or left status='identified'
 *    (pitched/accepted/declined/deferred elsewhere)
 *  - prefs_opted_out: sms_enabled / seasonal_tips flipped to false
 *  - cooldown_active: unified 30d cooldown — a campaign-grade SMS from a
 *    still-live auto lane, another campaign draft (the draft being approved
 *    is EXCLUDED via excludeDraftId), or a prepay renewal notice
 *  - guard_error: lookup failure fails CLOSED
 *  - ok: injected customer/opportunity rows are trusted (no re-read)
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { CUSTOMER_STAGES } = require('../services/customer-stages');
const {
  evaluateCampaignSendGate,
  isLiveCustomerRow,
  isLapsedCustomerRow,
  parseOpportunityRef,
  CAMPAIGN_SMS_TYPES,
  TERMINAL_CODES,
  HOLD_CODES,
  TRANSIENT_CODES,
  VERDICT_CODES,
} = require('../services/campaign-drafts-gate');

const builders = [];
function makeBuilder(table, cfg = {}) {
  const b = { _table: table };
  for (const m of [
    'join', 'leftJoin', 'whereIn', 'whereNull', 'whereNotNull', 'whereNot',
    'orWhere', 'orWhereNull', 'orderBy', 'select', 'groupBy', 'limit', 'max',
  ]) b[m] = jest.fn(() => b);
  b.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(b, b);
    return b;
  });
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.then = (resolve, reject) => {
    const value = b._mode === 'first' ? cfg.first : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  builders.push(b);
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

function liveCustomer(overrides = {}) {
  return {
    id: 'cust-1',
    deleted_at: null,
    active: true,
    pipeline_stage: 'active_customer',
    churned_at: null,
    nearest_location_id: 'loc-9',
    ...overrides,
  };
}

beforeEach(() => {
  // NOTE: clearAllMocks does NOT clear the once-style queues — reset them here.
  jest.clearAllMocks();
  builders.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  db.raw.mockImplementation((expr) => expr);
});

describe('customer resolution', () => {
  test('no customerId → customer_not_found', async () => {
    expect(await evaluateCampaignSendGate({ campaignType: 'upsell', customerId: null }))
      .toEqual({ ok: false, code: 'customer_not_found' });
  });

  test('customer row missing → customer_not_found', async () => {
    enqueue('customers', { first: undefined });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'upsell', customerId: 'cust-1' });
    expect(verdict).toEqual({ ok: false, code: 'customer_not_found' });
  });

  test('soft-deleted customer → customer_deleted (any campaign type)', async () => {
    enqueue('customers', { first: liveCustomer({ deleted_at: '2026-07-02T00:00:00Z' }) });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'reactivation', customerId: 'cust-1' });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('customer_deleted');
  });

  test('injected customer row is trusted — no customers read', async () => {
    const verdict = await evaluateCampaignSendGate({
      campaignType: 'reactivation',
      customerId: 'cust-1',
      customer: liveCustomer({ pipeline_stage: 'dormant' }),
    });
    expect(verdict.ok).toBe(true);
    expect(builders.some((b) => b._table === 'customers')).toBe(false);
  });
});

describe('upsell: customer must still be live', () => {
  test('deactivated while pending → customer_not_live', async () => {
    enqueue('customers', { first: liveCustomer({ active: false }) });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'upsell', customerId: 'cust-1' });
    expect(verdict.code).toBe('customer_not_live');
  });

  test('demoted out of a customer stage while pending → customer_not_live', async () => {
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'dormant' }) });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'upsell', customerId: 'cust-1' });
    expect(verdict.code).toBe('customer_not_live');
  });

  test('isLiveCustomerRow mirrors whereLiveCustomer semantics', () => {
    for (const stage of CUSTOMER_STAGES) {
      expect(isLiveCustomerRow(liveCustomer({ pipeline_stage: stage }))).toBe(true);
    }
    expect(isLiveCustomerRow(liveCustomer({ active: false }))).toBe(false);
    expect(isLiveCustomerRow(liveCustomer({ pipeline_stage: 'new_lead' }))).toBe(false);
    expect(isLiveCustomerRow(null)).toBe(false);
  });
});

describe('reactivation: customer must still be lapsed (branched predicate)', () => {
  test('target rebooked/promoted to a live stage while pending → not_lapsed', async () => {
    // pipeline-manager / booking promotion: stage flips to active_customer,
    // active true — win-back copy must NOT go to a now-active customer.
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'active_customer' }) });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'reactivation', customerId: 'cust-1' });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('not_lapsed');
  });

  test('dormant matches on the stage alone (pipeline-manager sets only pipeline_stage)', async () => {
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'dormant', active: true, churned_at: null }) });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'reactivation', customerId: 'cust-1' });
    expect(verdict.ok).toBe(true);
  });

  test('churned requires the cancellation-processor stamps (active=false + churned_at)', async () => {
    expect(isLapsedCustomerRow({ pipeline_stage: 'churned', active: false, churned_at: '2026-06-01' })).toBe(true);
    // churned stage WITHOUT the stamps is not the cancellation-processor
    // shape — fail toward not sending win-back copy.
    expect(isLapsedCustomerRow({ pipeline_stage: 'churned', active: true, churned_at: null })).toBe(false);
    expect(isLapsedCustomerRow({ pipeline_stage: 'churned', active: false, churned_at: null })).toBe(false);
    expect(isLapsedCustomerRow(null)).toBe(false);
  });
});

describe('upsell: source opportunity must still be identified', () => {
  test('opportunity row vanished → opportunity_missing', async () => {
    enqueue('customers', { first: liveCustomer() });
    enqueue('upsell_opportunities', { first: undefined });
    const verdict = await evaluateCampaignSendGate({
      campaignType: 'upsell', customerId: 'cust-1', sourceRef: 'upsell_opportunities:opp-1',
    });
    expect(verdict.code).toBe('opportunity_missing');
  });

  test.each(['pitched', 'accepted', 'declined', 'deferred'])(
    'opportunity moved to %s (customer-intel route / retention agent) → opportunity_closed',
    async (status) => {
      enqueue('customers', { first: liveCustomer() });
      enqueue('upsell_opportunities', { first: { id: 'opp-1', status } });
      const verdict = await evaluateCampaignSendGate({
        campaignType: 'upsell', customerId: 'cust-1', sourceRef: 'upsell_opportunities:opp-1',
      });
      expect(verdict.code).toBe('opportunity_closed');
      expect(verdict.reason).toBe(status);
    }
  );

  test('injected opportunity row is trusted — no upsell_opportunities read', async () => {
    const verdict = await evaluateCampaignSendGate({
      campaignType: 'upsell',
      customerId: 'cust-1',
      sourceRef: 'upsell_opportunities:opp-1',
      customer: liveCustomer(),
      opportunity: { id: 'opp-1', status: 'identified' },
    });
    expect(verdict.ok).toBe(true);
    expect(builders.some((b) => b._table === 'upsell_opportunities')).toBe(false);
  });

  test('parseOpportunityRef only matches upsell_opportunities refs', () => {
    expect(parseOpportunityRef('upsell_opportunities:opp-1')).toBe('opp-1');
    expect(parseOpportunityRef('customers:cust-1')).toBeNull();
    expect(parseOpportunityRef(null)).toBeNull();
  });
});

describe('prefs', () => {
  test('sms_enabled/seasonal_tips revoked while pending → prefs_opted_out', async () => {
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'dormant' }) });
    enqueue('notification_prefs', { first: { sms_enabled: true, seasonal_tips: false } });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'reactivation', customerId: 'cust-1' });
    expect(verdict.code).toBe('prefs_opted_out');
  });
});

describe('unified 30d cooldown (HOLD)', () => {
  test('a campaign-grade SMS from a still-live auto lane after drafting → cooldown_active', async () => {
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'dormant' }) });
    enqueue('message_drafts', { first: undefined }); // no other campaign draft
    enqueue('sms_log', { first: { id: 'sms-1' } }); // renewal/upsell/reactivation/retention_outreach send landed
    const verdict = await evaluateCampaignSendGate({ campaignType: 'reactivation', customerId: 'cust-1' });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('cooldown_active');
    expect(verdict.reason).toBe('recent_campaign_sms');

    // The cross-lane filter covers all five existing senders.
    const smsBuilder = builders.find((b) => b._table === 'sms_log');
    expect(smsBuilder.whereIn).toHaveBeenCalledWith('message_type', CAMPAIGN_SMS_TYPES);
  });

  test('cooldown covers every campaign-grade sender, incl. Customer-Intel retention approvals', () => {
    // admin-customer-intel retention approve sends original_message_type
    // 'retention' (persisted as sms_log.message_type) — distinct from the
    // retention agent's 'retention_outreach'. Both must hold the cooldown.
    expect(CAMPAIGN_SMS_TYPES).toEqual(
      expect.arrayContaining(['upsell', 'renewal', 'reactivation', 'retention_outreach', 'retention'])
    );
  });

  test('another campaign draft in the window → cooldown_active (recent_campaign_draft)', async () => {
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'dormant' }) });
    enqueue('message_drafts', { first: { id: 'draft-other' } });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'reactivation', customerId: 'cust-1' });
    expect(verdict.code).toBe('cooldown_active');
    expect(verdict.reason).toBe('recent_campaign_draft');
  });

  test('prepay renewal notice in the window → cooldown_active (recent_prepay_notice)', async () => {
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'dormant' }) });
    enqueue('message_drafts', { first: undefined });
    enqueue('sms_log', { first: undefined });
    enqueue('annual_prepay_terms', { first: { id: 'apt-1' } });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'reactivation', customerId: 'cust-1' });
    expect(verdict.code).toBe('cooldown_active');
    expect(verdict.reason).toBe('recent_prepay_notice');
  });

  test('excludeDraftId: the draft being approved never trips its own cooldown', async () => {
    enqueue('customers', { first: liveCustomer({ pipeline_stage: 'dormant' }) });
    const verdict = await evaluateCampaignSendGate({
      campaignType: 'reactivation', customerId: 'cust-1', excludeDraftId: 'draft-1',
    });
    expect(verdict.ok).toBe(true);
    const draftBuilder = builders.find((b) => b._table === 'message_drafts');
    expect(draftBuilder.whereNot).toHaveBeenCalledWith('id', 'draft-1');
  });
});

describe('guard_error (fail closed)', () => {
  test('a lookup failure returns guard_error, never ok', async () => {
    db.mockImplementation(() => { throw new Error('connection refused'); });
    const verdict = await evaluateCampaignSendGate({ campaignType: 'upsell', customerId: 'cust-1' });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('guard_error');
  });
});

describe('verdict-code partition', () => {
  test('every code is exactly one of terminal / hold / transient', () => {
    const all = [...TERMINAL_CODES, ...HOLD_CODES, ...TRANSIENT_CODES];
    expect(new Set(all).size).toBe(all.length); // disjoint
    expect(VERDICT_CODES.sort()).toEqual(all.sort()); // complete
  });
});
