/**
 * Conversion guard for estimate follow-ups.
 *
 * Pins the contract that stops the follow-up cron from nagging customers who
 * already converted out-of-band (paid an invoice, booked an appointment after
 * the estimate, or reached active_customer) while the estimate row still says
 * sent/viewed — booking/invoicing/completion never write estimate status, so
 * status alone is not a conversion signal. Also pins the daily archive sweep's
 * first-conversion semantics: pre-conversion estimates get archived_at, but an
 * upsell estimate sent to an already-converted customer is left alone.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'Hello there! url'),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
}));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({
    eligible: true,
    outstandingAmount: 49,
  })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  customerConvertedSince,
  archiveConvertedOpenEstimates,
} = require('../services/estimate-conversion-guard');
const { _private } = require('../services/estimate-follow-up');

// Chainable knex-builder stub. Chain methods return the builder; closures
// passed to where/orWhere run against the same builder, closures passed to
// whereExists/whereNotExists run bound to a fresh sub-builder (mirroring
// knex). Awaiting resolves by mode: first → cfg.first, update+returning →
// cfg.returning, update → cfg.update, else cfg.rows.
function makeBuilder(table, cfg = {}, calls = []) {
  const b = { _table: table, _mode: 'rows' };
  const record = (m) => (...args) => {
    calls.push({ table, m, args });
    return b;
  };
  for (const m of [
    'whereIn', 'whereNull', 'whereNotNull', 'whereNot', 'whereRaw', 'select',
    'from', 'groupBy', 'max', 'as', 'join', 'andWhere', 'orWhereNull',
  ]) {
    b[m] = jest.fn(record(m));
  }
  for (const m of ['where', 'orWhere']) {
    b[m] = jest.fn((...args) => {
      calls.push({ table, m, args });
      if (typeof args[0] === 'function') args[0].call(b, b);
      return b;
    });
  }
  for (const m of ['whereExists', 'whereNotExists']) {
    b[m] = jest.fn((fn) => {
      calls.push({ table, m });
      if (typeof fn === 'function') fn.call(makeBuilder(`${table}:sub`, {}, calls));
      return b;
    });
  }
  b.first = jest.fn((...args) => {
    calls.push({ table, m: 'first', args });
    b._mode = 'first';
    return b;
  });
  b.update = jest.fn((payload) => {
    calls.push({ table, m: 'update', args: [payload] });
    b._mode = 'update';
    return b;
  });
  b.returning = jest.fn((...args) => {
    calls.push({ table, m: 'returning', args });
    b._mode = 'returning';
    return b;
  });
  b.then = (resolve, reject) => {
    const value =
      b._mode === 'first' ? cfg.first
        : b._mode === 'returning' ? (cfg.returning ?? [])
          : b._mode === 'update' ? (cfg.update ?? 0)
            : (cfg.rows ?? []);
    if (cfg.throws) return Promise.reject(cfg.throws).then(resolve, reject);
    return Promise.resolve(
      typeof value === 'function' ? value() : value,
    ).then(resolve, reject);
  };
  return b;
}

// Routes db('<table>') to a per-table cfg; records every chained call.
function wireDb(resolvers, calls = []) {
  db.mockReset();
  db.raw = jest.fn((expr) => expr);
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.mockImplementation((table) => makeBuilder(table, resolvers[table] || {}, calls));
  return calls;
}

const BASE_EST = {
  id: 'est-1',
  status: 'viewed',
  customer_id: 'cust-1',
  customer_phone: '+15550001111',
  created_at: '2026-06-25T20:11:06.024Z',
  viewed_at: '2026-06-25T20:11:10.984Z',
};

// 2pm ET — inside the 9a-5p send window so quiet-hours never trips.
const BUSINESS_HOURS = new Date('2026-07-01T14:00:00-04:00');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('customerConvertedSince', () => {
  test('no customer_id → not converted, no queries', async () => {
    wireDb({});
    const res = await customerConvertedSince({ id: 'x', customer_id: null });
    expect(res).toEqual({ converted: false });
    expect(db).not.toHaveBeenCalled();
  });

  test('paid invoice on/after estimate creation → paid-invoice', async () => {
    const calls = wireDb({ invoices: { first: { id: 'inv-1' } } });
    const res = await customerConvertedSince(BASE_EST);
    expect(res).toEqual({ converted: true, reason: 'paid-invoice' });
    // Time-bounded to the estimate's own lifetime, not any historic payment.
    const bound = calls.find(
      (c) => c.table === 'invoices' && c.m === 'where' && c.args[0] === 'paid_at',
    );
    expect(bound).toBeTruthy();
    expect(bound.args[1]).toBe('>=');
    expect(bound.args[2]).toEqual(new Date(BASE_EST.created_at));
  });

  test('no invoice, live appointment created after estimate → appointment-booked', async () => {
    const calls = wireDb({
      invoices: { first: null },
      scheduled_services: { first: { id: 'svc-1' } },
    });
    const res = await customerConvertedSince(BASE_EST);
    expect(res).toEqual({ converted: true, reason: 'appointment-booked' });
    // Cancelled appointments never count as conversion.
    const notCancelled = calls.find(
      (c) => c.table === 'scheduled_services' && c.m === 'whereNot',
    );
    expect(notCancelled.args).toEqual(['status', 'cancelled']);
  });

  test('no invoice/appointment, active_customer stage → active-customer', async () => {
    wireDb({
      invoices: { first: null },
      scheduled_services: { first: null },
      customers: { first: { pipeline_stage: 'active_customer' } },
    });
    const res = await customerConvertedSince(BASE_EST);
    expect(res).toEqual({ converted: true, reason: 'active-customer' });
  });

  test('no conversion signal anywhere → not converted', async () => {
    wireDb({
      invoices: { first: null },
      scheduled_services: { first: null },
      customers: { first: { pipeline_stage: 'estimate_sent' } },
    });
    const res = await customerConvertedSince(BASE_EST);
    expect(res).toEqual({ converted: false });
  });

  test('lookup error fails CLOSED (skip the send, no flag burn)', async () => {
    wireDb({ invoices: { throws: new Error('boom') } });
    const res = await customerConvertedSince(BASE_EST);
    expect(res).toEqual({ converted: true, reason: 'guard-error' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('safetyGate integration (real guard, mocked db)', () => {
  test('converted customer skips with customer-converted reason', async () => {
    wireDb({ invoices: { first: { id: 'inv-1' } } });
    const gate = await _private.safetyGate(
      { ...BASE_EST, viewed_at: '2026-06-25T20:11:10.984Z' },
      BUSINESS_HOURS,
    );
    expect(gate).toEqual({
      skip: true,
      reason: 'customer-converted:paid-invoice',
    });
  });

  test('unconverted customer still passes the gate', async () => {
    wireDb({
      invoices: { first: null },
      scheduled_services: { first: null },
      customers: { first: { pipeline_stage: 'estimate_sent' } },
      messages: { first: null }, // reply-pause lookup: no recent inbound SMS
    });
    const gate = await _private.safetyGate(BASE_EST, BUSINESS_HOURS);
    expect(gate).toEqual({ skip: false });
  });

  test('terminal status still wins before the conversion lookup', async () => {
    wireDb({});
    const gate = await _private.safetyGate(
      { ...BASE_EST, status: 'accepted' },
      BUSINESS_HOURS,
    );
    expect(gate).toEqual({ skip: true, reason: 'terminal-status:accepted' });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('archiveConvertedOpenEstimates', () => {
  test('archives open estimates and reports what it touched', async () => {
    const calls = wireDb({
      estimates: {
        returning: [
          { id: 'est-1', customer_name: 'Monty Manuel', status: 'viewed' },
          { id: 'est-2', customer_name: 'Anna Gomez', status: 'viewed' },
        ],
      },
    });
    const res = await archiveConvertedOpenEstimates();
    expect(res.archived).toBe(2);
    expect(res.rows.map((r) => r.id)).toEqual(['est-1', 'est-2']);

    // Scope: only live sent/viewed, un-archived, customer-linked rows.
    expect(calls.find((c) => c.m === 'whereIn').args).toEqual([
      'status',
      ['sent', 'viewed'],
    ]);
    expect(
      calls.find((c) => c.table === 'estimates' && c.m === 'whereNull').args,
    ).toEqual(['archived_at']);
    expect(
      calls.find((c) => c.table === 'estimates' && c.m === 'whereNotNull').args,
    ).toEqual(['customer_id']);

    // Stamp is archived_at + updated_at only — status is never rewritten
    // (no implicit accept; acceptance has money side-effects).
    const update = calls.find((c) => c.m === 'update');
    expect(Object.keys(update.args[0]).sort()).toEqual([
      'archived_at',
      'updated_at',
    ]);

    // First-conversion semantics: both the has-signal EXISTS and the
    // none-before NOT EXISTS run for invoices and completed services.
    expect(calls.filter((c) => c.m === 'whereExists')).toHaveLength(2);
    expect(calls.filter((c) => c.m === 'whereNotExists')).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Archived 2'),
    );
  });

  test('quiet run logs nothing-to-archive', async () => {
    wireDb({ estimates: { returning: [] } });
    const res = await archiveConvertedOpenEstimates();
    expect(res.archived).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('nothing to archive'),
    );
  });
});
