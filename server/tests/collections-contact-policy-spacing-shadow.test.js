/**
 * collections/contact-policy.js — the seven-day overdue-reminder spacing
 * SHADOW evaluation (GATE_DUNNING_SPACING_SHADOW, dunning-unification PR 1,
 * re-sequenced narrow — see dunning-spacing.js's module header).
 *
 * Pins: gate off ⇒ the rule is never called and the verdict is byte-identical
 * to the pre-lane policy; gate on ⇒ the verdict STILL never changes (no
 * denial reason added, allowed/denied untouched) whether or not the rule
 * would have held, and a holding row logs exactly one structured
 * `dunning_within_7d SHADOW would hold` line with the expected fields; an
 * unknown purpose (never reaching the shadow check at all — evaluate()
 * denies unknown_purpose and returns first) never calls the rule either.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/open-balance', () => ({
  openBalanceInvoices: jest.fn(async () => []),
  rowIsSelfPayDue: jest.fn(async () => true),
}));
jest.mock('../services/collections/consent-provenance', () => ({
  resolve: jest.fn(async () => null),
  freshness: jest.fn(async () => null),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'miss' })),
}));
jest.mock('../services/stripe', () => ({
  isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => false),
}));
jest.mock('../services/invoice-followups', () => ({
  isDunningStopped: jest.fn(async () => false),
}));
jest.mock('../services/collections/dunning-spacing', () => {
  const actual = jest.requireActual('../services/collections/dunning-spacing');
  return { ...actual, lastOverdueReminderWithin7d: jest.fn(async () => null) };
});

const db = require('../models/db');
const logger = require('../services/logger');
const { openBalanceInvoices } = require('../services/open-balance');
const DunningSpacing = require('../services/collections/dunning-spacing');
const ContactPolicy = require('../services/collections/contact-policy');

const NOW = new Date('2026-08-12T15:00:00Z'); // Wed Aug 12, 11:00 ET

function chain({ result = [], first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNull', 'whereRaw', 'orderBy', 'select', 'count', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbTables(tables) {
  db.mockImplementation((table) => {
    const supply = tables[table];
    if (!supply) throw new Error(`Unexpected db table ${table}`);
    if (Array.isArray(supply)) {
      if (!supply.length) throw new Error(`Exhausted db queue for ${table}`);
      return supply.shift();
    }
    return supply;
  });
}

function customerRow(overrides = {}) {
  return {
    id: 'cust-1', first_name: 'Sandy', phone: '+19415550100',
    property_type: 'residential', deleted_at: null, ...overrides,
  };
}

function invoiceRow(overrides = {}) {
  return {
    id: 'inv-1', invoice_number: 'WPC-2026-1100', total: '128.00', credit_applied: 0,
    due_date: '2026-07-22', created_at: '2026-07-01T12:00:00.000Z',
    stripe_payment_intent_id: null, ...overrides,
  };
}

function armAllowedBaseline({
  customer = customerRow(), invoices = [invoiceRow()], flags = [], ledger = [],
  touchesSent = 2, activityCount = 0,
} = {}) {
  setDbTables({
    customers: chain({ first: customer }),
    collections_flags: chain({ result: flags }),
    collections_contact_ledger: chain({ result: ledger }),
    invoice_followup_sequences: chain({ first: { touches_sent: touchesSent } }),
    activity_log: chain({ result: [{ count: String(activityCount) }] }),
    messaging_suppression: chain({ first: undefined }),
    call_log: chain({ first: undefined }),
    invoices: chain({ result: [] }),
  });
  openBalanceInvoices.mockResolvedValue(invoices);
}

async function evalSms(purpose = 'late_payment', extra = {}) {
  // A designated reminder rail by default; the shadow observes nothing else.
  return ContactPolicy.evaluate('cust-1', { channel: 'sms', purpose, now: NOW, source: 'invoice_followups', ...extra });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((expr) => expr);
  delete process.env.GATE_DUNNING_SPACING_SHADOW;
  DunningSpacing.lastOverdueReminderWithin7d.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.GATE_DUNNING_SPACING_SHADOW;
});

describe('gate off', () => {
  test('the rule is never called and the verdict is the pre-lane allow', async () => {
    armAllowedBaseline();
    const result = await evalSms();
    expect(result.allowed).toBe(true);
    expect(result.denialReasons).toEqual([]);
    expect(DunningSpacing.lastOverdueReminderWithin7d).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('dunning_within_7d'));
  });

  test('a value other than the exact string true never calls the rule', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = '1';
    armAllowedBaseline();
    await evalSms();
    expect(DunningSpacing.lastOverdueReminderWithin7d).not.toHaveBeenCalled();
  });
});

describe('gate on, no holding row', () => {
  test('the rule is called and the verdict is unchanged', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    const result = await evalSms();
    expect(result.allowed).toBe(true);
    expect(result.denialReasons).toEqual([]);
    expect(DunningSpacing.lastOverdueReminderWithin7d).toHaveBeenCalledWith('cust-1', expect.objectContaining({
      now: NOW, database: db,
    }));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('dunning_within_7d'));
  });
});

describe('gate on, a holding row', () => {
  test('logs exactly one shadow line with the expected fields and leaves an ALLOWED verdict untouched', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    const holding = {
      id: 'ledger-9', channel: 'sms', source: 'late_payment_checker', purpose: 'late_payment',
      occurred_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      metadata: {},
    };
    DunningSpacing.lastOverdueReminderWithin7d.mockResolvedValue(holding);

    const result = await evalSms();

    expect(result.allowed).toBe(true);
    expect(result.denialReasons).toEqual([]);
    const shadowLines = logger.info.mock.calls.map(([msg]) => msg).filter((msg) => msg.includes('dunning_within_7d'));
    expect(shadowLines).toHaveLength(1);
    expect(shadowLines[0]).toContain('customer=cust-1');
    expect(shadowLines[0]).toContain('channel=sms');
    expect(shadowLines[0]).toContain('purpose=late_payment');
    expect(shadowLines[0]).toContain('prevSource=late_payment_checker');
    expect(shadowLines[0]).toContain('hoursSince=2.0');
    expect(shadowLines[0]).toContain('verdict=allowed');
  });

  test('logs a DENIED verdict verbatim and adds no denial reason of its own', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    // A recent ledger row inside the 24h window denies contact_within_24h —
    // an unrelated, pre-existing denial the shadow check must not touch.
    armAllowedBaseline({ ledger: [{
      id: 'ledger-recent', channel: 'sms', occurred_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      metadata: {},
    }] });
    const holding = {
      id: 'ledger-9', channel: 'sms', source: 'invoice_followups', purpose: 'late_payment',
      occurred_at: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(), // 5h ago
      metadata: {},
    };
    DunningSpacing.lastOverdueReminderWithin7d.mockResolvedValue(holding);

    const result = await evalSms();

    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toEqual(['contact_within_24h']);
    const shadowLines = logger.info.mock.calls.map(([msg]) => msg).filter((msg) => msg.includes('dunning_within_7d'));
    expect(shadowLines).toHaveLength(1);
    expect(shadowLines[0]).toContain('verdict=denied:contact_within_24h');
  });

  test('a shadow-read failure is swallowed — the verdict stands and no policy_evaluation_error is raised', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    DunningSpacing.lastOverdueReminderWithin7d.mockRejectedValue(new Error('db blip'));

    const result = await evalSms();

    expect(result.allowed).toBe(true);
    expect(result.denialReasons).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dunning_within_7d'));
  });
});

describe('non-overdue-reminder purposes never reach the shadow check', () => {
  test('an unknown purpose is denied before the shadow check and never calls the rule', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    const result = await evalSms('payment_link');
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toEqual(['unknown_purpose']);
    expect(DunningSpacing.lastOverdueReminderWithin7d).not.toHaveBeenCalled();
  });

  test('balance_reminder (an overdue-reminder purpose) does call the rule', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    await evalSms('balance_reminder');
    expect(DunningSpacing.lastOverdueReminderWithin7d).toHaveBeenCalled();
  });
});

describe('a caller that names its rail (Codex #5189 r3/r4)', () => {
  test('a caller with no source (voice dial/answer checks, the shadow sweep) never reaches the shadow check', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    await evalSms('late_payment', { source: undefined });
    expect(DunningSpacing.lastOverdueReminderWithin7d).not.toHaveBeenCalled();
  });

  test('the exempt in-call pay link never reaches the shadow check', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    await evalSms('late_payment', { source: 'collections_voice_paylink' });
    expect(DunningSpacing.lastOverdueReminderWithin7d).not.toHaveBeenCalled();
  });

  test('the follow-up replay is observed, with its own reservation key excluded', async () => {
    process.env.GATE_DUNNING_SPACING_SHADOW = 'true';
    armAllowedBaseline();
    await evalSms('late_payment', {
      source: 'invoice_followup_replay', spacingExcludeKey: 'followup-replay:abc', spacingExcludeEventKey: 'invoice-followup:seq-1:d3',
    });
    expect(DunningSpacing.lastOverdueReminderWithin7d).toHaveBeenCalledWith('cust-1', expect.objectContaining({
      excludeIdempotencyKey: 'followup-replay:abc', excludeEventKey: 'invoice-followup:seq-1:d3',
    }));
  });
});
