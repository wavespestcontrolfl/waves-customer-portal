/**
 * Seasonal reactivation — campaign drafts V1.
 *
 * Pins:
 *  - audience query uses the canonical lapsed predicate (pipeline_stage IN
 *    ('churned','dormant') + active=false + churned_at NOT NULL + deleted_at
 *    NULL) and NOT the dead customers.status filter
 *  - gate off = shadow mode: candidate count computed/logged, zero drafts,
 *    zero sends (and never a send via the old path either — the module no
 *    longer imports the send wrapper)
 *  - gate on = pending campaign drafts (campaign_type='reactivation',
 *    purpose='marketing', status='pending'), GSM-7-normalized body
 *  - unified cooldown: a recent campaign-grade sms_log row excludes the
 *    customer
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'Hi Dana — we miss you… call us at (941) 318-7612'),
}));
jest.mock('../config/twilio-numbers', () => ({
  getOutboundNumber: jest.fn(() => '+19413187612'),
  findByNumber: jest.fn(() => ({ formatted: '(941) 318-7612' })),
}));
// Regression pin: the reactivation cron must NEVER touch the send wrapper
// again (the old auto-send path is gone, not gated).
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const seasonalReactivation = require('../services/workflows/seasonal-reactivation');

const inserts = [];
const builders = [];
function makeBuilder(table, cfg = {}) {
  const b = { _table: table };
  for (const m of [
    'join', 'leftJoin', 'whereIn', 'whereNull', 'whereNotNull', 'whereNot',
    'orWhere', 'orWhereNull', 'orderBy', 'select', 'groupBy', 'limit',
  ]) b[m] = jest.fn(() => b);
  b.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(b, b);
    return b;
  });
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.insert = jest.fn((payload) => { b._mode = 'insert'; inserts.push({ table, payload }); return b; });
  b.then = (resolve, reject) => {
    const value = b._mode === 'insert' ? (cfg.insert ?? [1])
      : b._mode === 'first' ? cfg.first
        : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  builders.push(b);
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

function lapsedCustomer(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Dana',
    phone: '+19415550101',
    location_id: 'loc-1',
    address: '123 Palm Ave',
    // Columns the audience query selects and injects into the shared
    // pre-send gate (dormant = the stage alone; see the branched predicate).
    active: true,
    pipeline_stage: 'dormant',
    churned_at: null,
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  // NOTE: clearAllMocks does NOT clear the once-style queues — reset them here.
  jest.clearAllMocks();
  inserts.length = 0;
  builders.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  db.raw.mockImplementation((expr) => expr);
  // Pin the clock: July → seasonal type 'pest' (non-general hook path).
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-07-06T14:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('audience query — dead-column fix', () => {
  test('churned branch requires cancellation-processor stamps; dormant branch matches on stage alone', async () => {
    enqueue('customers', { rows: [] });

    await seasonalReactivation.run();

    const customersBuilder = builders.find((b) => b._table === 'customers');

    // Churned branch: pipeline_stage + active=false + churned_at (what
    // cancellation-processor writes together).
    expect(customersBuilder.where).toHaveBeenCalledWith('pipeline_stage', 'churned');
    expect(customersBuilder.where).toHaveBeenCalledWith('active', false);
    expect(customersBuilder.whereNotNull).toHaveBeenCalledWith('churned_at');

    // Dormant branch: pipeline-manager's no_service_120_days sets
    // pipeline_stage ONLY (active stays true, churned_at never stamped) — so
    // a dormant-without-churned_at customer matches via a bare orWhere on the
    // stage, with no churn-stamp constraints attached. Without this branch
    // the stale-service audience this lane exists for never matches.
    expect(customersBuilder.orWhere).toHaveBeenCalledWith('pipeline_stage', 'dormant');

    // Both branches: soft-deleted exclusion + phone.
    expect(customersBuilder.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(customersBuilder.whereNotNull).toHaveBeenCalledWith('phone');

    // The dead filters are gone: no whereIn on customers.status (onboarding
    // enum) and no flat whereIn('pipeline_stage', ...) ANDing the churn
    // stamps onto dormant rows.
    expect(customersBuilder.whereIn).not.toHaveBeenCalled();
  });
});

describe('gate off — shadow mode', () => {
  test('counts candidates, writes zero drafts, never sends', async () => {
    isEnabled.mockReturnValue(false);
    enqueue('customers', { rows: [lapsedCustomer(), lapsedCustomer({ id: 'cust-2' })] });
    // Guards pass for both: notification_prefs / message_drafts / sms_log /
    // annual_prepay_terms default to empty.

    const result = await seasonalReactivation.run();

    expect(result).toMatchObject({ candidates: 2, drafted: 0, gate: 'off' });
    expect(inserts).toEqual([]);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/shadow: 2 reactivation candidate/));
  });
});

describe('gate on — pending campaign drafts', () => {
  test('writes a pending reactivation draft with GSM-7-normalized body, never sends', async () => {
    isEnabled.mockReturnValue(true);
    enqueue('customers', { rows: [lapsedCustomer()] });
    enqueue('service_records', { first: { id: 'sr-1' } }); // has pest history → seasonal hook

    const result = await seasonalReactivation.run();

    expect(result).toMatchObject({ candidates: 1, drafted: 1, gate: 'on' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    expect(inserts).toHaveLength(1);
    const { table, payload } = inserts[0];
    expect(table).toBe('message_drafts');
    expect(payload).toMatchObject({
      customer_id: 'cust-1',
      status: 'pending',
      campaign_type: 'reactivation',
      purpose: 'marketing',
      source_ref: 'customers:cust-1',
    });
    // toGsm7Safe: em-dash → '-', ellipsis → '...'
    expect(payload.draft_response).toBe('Hi Dana - we miss you... call us at (941) 318-7612');
    expect(payload.draft_response).toMatch(/^[\x20-\x7E]*$/);
  });

  test('recent campaign-grade sms_log row excludes the customer (unified 30d cooldown)', async () => {
    isEnabled.mockReturnValue(true);
    enqueue('customers', { rows: [lapsedCustomer()] });
    // prefs pass (default), no recent campaign draft, but a recent 'renewal'
    // SMS exists → cooldown skip.
    enqueue('message_drafts', { first: undefined });
    enqueue('sms_log', { first: { id: 'sms-1' } });

    const result = await seasonalReactivation.run();

    expect(result).toMatchObject({ candidates: 0, drafted: 0 });
    expect(inserts).toEqual([]);
  });

  test('explicitly opted-out prefs exclude the customer', async () => {
    isEnabled.mockReturnValue(true);
    enqueue('customers', { rows: [lapsedCustomer()] });
    enqueue('notification_prefs', { first: { sms_enabled: true, seasonal_tips: false } });

    const result = await seasonalReactivation.run();

    expect(result).toMatchObject({ candidates: 0, drafted: 0 });
    expect(inserts).toEqual([]);
  });
});
