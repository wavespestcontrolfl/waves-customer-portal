// The side-effect gate (estimate-accept-effects.js): a carded accept (the
// Intelligence Bar's dry run, and its real run) hands the converter ONE
// context, and every message, bell and notification the converter sends
// itself goes through it. A dry run records each one and sends none; the
// carded real run records the same list and sends them; the page button
// passes no context and sends as before. The paths that reach helpers which
// take no context (visit seeding, the invoice service, the annual prepay
// term) are refused before the conversion writes.
//
// Runs the REAL converter against a stateful fake knex (the same harness as
// plan-ledger-unsliced-accept.test.js) with every sender mocked.

jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn(async () => {}),
  isNewRecurringSignupCandidate: jest.fn(async () => false),
}));
// The global pool, for the one inline path that only runs when the caller
// passed no database of its own (the welcome text).
jest.mock('../models/db', () => {
  const pool = (...args) => pool.impl(...args);
  pool.transaction = (...args) => pool.impl.transaction(...args);
  pool.raw = (...args) => pool.impl.raw(...args);
  Object.defineProperty(pool, 'schema', { get: () => pool.impl.schema });
  return pool;
});
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => {}) }));
jest.mock('../services/account-membership-email', () => ({
  ...jest.requireActual('../services/account-membership-email'),
  sendMembershipStarted: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: jest.fn(async () => {}) }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn(async () => {}) }));
jest.mock('../services/invoice', () => ({
  create: jest.fn(async () => ({ id: 'inv-1' })),
  sendViaSMSAndEmail: jest.fn(async () => ({ ok: true })),
  voidInvoice: jest.fn(async () => {}),
}));
jest.mock('../services/stripe', () => ({}));

const globalPool = require('../models/db');
const { isNewRecurringSignupCandidate } = require('../services/new-recurring-welcome-sms');
const NotificationService = require('../services/notification-service');
const AccountMembershipEmail = require('../services/account-membership-email');
const { sendNewRecurringWelcome } = require('../services/new-recurring-welcome-sms');
const TechNotifications = require('../services/tech-visit-notifications');
const Reminders = require('../services/appointment-reminders');
const InvoiceService = require('../services/invoice');
const EstimateConverter = require('../services/estimate-converter');
const Effects = require('../services/estimate-accept-effects');

const SENDERS = {
  notifyAdmin: NotificationService.notifyAdmin,
  sendMembershipStarted: AccountMembershipEmail.sendMembershipStarted,
  sendNewRecurringWelcome,
  notifyTechVisitChange: TechNotifications.notifyTechVisitChange,
  registerAppointment: Reminders.registerAppointment,
  invoiceCreate: InvoiceService.create,
  invoiceSend: InvoiceService.sendViaSMSAndEmail,
};
const sendersCalled = () => Object.entries(SENDERS).filter(([, fn]) => fn.mock.calls.length).map(([name]) => name);

// ── stateful fake knex ──────────────────────────────────────────────────────
// Covers exactly the tables a skipAutoSchedule/skipSetupInvoice recurring
// accept touches: estimates, customers (first + update-returning),
// scheduled_services (classifier rows + reservation count), activity_log,
// and customer_plan_rates (the ledger store). Throws on anything else so a
// converter change that widens the surface fails loudly here.
function makeAcceptDb({
  estimate,
  customer,
  planRows = [],
  ledgerRows = [],
  updateReturnedRate = null,
  ledgerDelError = null,
  linkedVisitCount = 0,
}) {
  const ledgerStore = ledgerRows.map((r) => ({ ...r }));
  const customerUpdates = [];

  const nestedBuilder = () => {
    const b = {};
    ['where', 'orWhere', 'whereNull', 'whereNot', 'orWhereNot', 'whereIn', 'whereNotIn'].forEach((m) => {
      b[m] = (...args) => { if (typeof args[0] === 'function') args[0](nestedBuilder()); return b; };
    });
    return b;
  };

  const db = (table) => {
    if (table === 'estimates') {
      return { where: () => ({ first: async () => estimate }) };
    }
    if (table === 'customers') {
      const q = {
        where() { return q; },
        forUpdate() { return q; },
        async first() { return customer; },
        update(updates, returning) {
          customerUpdates.push(updates);
          if (Array.isArray(returning)) {
            return Promise.resolve([{ monthly_rate: updateReturnedRate }]);
          }
          return Promise.resolve(1);
        },
      };
      return q;
    }
    if (table === 'scheduled_services') {
      // Hybrid chain: the add-on classifier consumes it as a thenable
      // (leftJoin/select/where… → rows); the reservation probe ends in
      // .count().first() → { count: 0 }.
      const q = {};
      ['leftJoin', 'select', 'whereNotIn', 'whereNull', 'whereNotNull', 'count', 'orderBy'].forEach((m) => {
        q[m] = () => q;
      });
      q.where = (...args) => { if (typeof args[0] === 'function') args[0](nestedBuilder()); return q; };
      q.first = async () => ({ count: linkedVisitCount });
      q.then = (resolve, reject) => Promise.resolve(planRows.map((r) => ({ ...r }))).then(resolve, reject);
      return q;
    }
    if (table === 'activity_log') {
      return { insert: async () => [1] };
    }
    if (table === 'customer_plan_rates') {
      const ctx = { filter: null };
      const q = {
        where(filter) { ctx.filter = filter; return q; },
        select() {
          return Promise.resolve(ledgerStore
            .filter((r) => r.customer_id === ctx.filter.customer_id)
            .map((r) => ({ family_key: r.family_key, monthly_rate: r.monthly_rate })));
        },
        insert(row) {
          return {
            onConflict() {
              return {
                merge(mergeFields) {
                  const existing = ledgerStore.find((r) => r.customer_id === row.customer_id
                    && r.family_key === row.family_key);
                  if (existing) Object.assign(existing, mergeFields);
                  else ledgerStore.push({ ...row });
                  return Promise.resolve();
                },
              };
            },
            then(resolve, reject) {
              ledgerStore.push({ ...row });
              return Promise.resolve().then(resolve, reject);
            },
          };
        },
        del() {
          if (ledgerDelError) return Promise.reject(ledgerDelError);
          const before = ledgerStore.length;
          for (let i = ledgerStore.length - 1; i >= 0; i -= 1) {
            const matches = ledgerStore[i].customer_id === ctx.filter.customer_id
              && (ctx.filter.family_key === undefined || ledgerStore[i].family_key === ctx.filter.family_key);
            if (matches) ledgerStore.splice(i, 1);
          }
          return Promise.resolve(before - ledgerStore.length);
        },
      };
      return q;
    }
    throw new Error(`unsliced-accept fake db: unexpected table ${table}`);
  };

  db.schema = {
    hasTable: async (name) => name === 'customer_plan_rates',
    hasColumn: async () => false, // pre-billing_mode update shape — simplest legacy path
  };
  db.transaction = async (fn) => fn(db);
  db.raw = (sql, bindings) => ({ __raw: sql, bindings });
  db.ledgerStore = ledgerStore;
  db.customerUpdates = customerUpdates;
  return db;
}

// ── fixtures ────────────────────────────────────────────────────────────────
const estimateRow = (services) => ({
  id: 'est-gate',
  status: 'accepted',
  customer_id: 'cust-1',
  monthly_total: null,
  annual_total: null,
  onetime_total: null,
  estimate_data: {
    membershipSnapshot: { existingServiceKeys: [] },
    result: { recurring: { services } },
  },
});
const PEST_LINE = { name: 'Quarterly Pest Control Service', service: 'pest_control', frequency: 'quarterly', selected: true, isSelected: true };
const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', last_name: 'Customer',
  pipeline_stage: 'active_customer', monthly_rate: '95', member_since: '2025-01-01', waveguard_tier: 'Bronze',
};
const LIVE_PEST_ROW = {
  service_type: 'Quarterly Pest Control Service', is_callback: false, catalog_service_key: null, catalog_service_name: null, source_estimate_id: null,
};

// What the manual accept passes, EXCEPT the deferrals: the sender options are
// left on, so the conversion would send everything itself. The gate is what
// stops it.
const SENDING_OPTS = {
  skipAutoSchedule: true,
  skipSetupInvoice: true,
  autoSendInvoice: false,
};
const newDb = () => makeAcceptDb({ estimate: estimateRow([PEST_LINE]), customer: CUSTOMER, planRows: [LIVE_PEST_ROW] });

beforeEach(() => { Object.values(SENDERS).forEach((fn) => fn.mockClear()); });

describe('a dry run through the real converter', () => {
  test('sends nothing, and the effect list names each message it held back', async () => {
    const log = Effects.createEffectLog(true);
    const gate = Effects.createSideEffectGate({ dryRun: true, log });
    await EstimateConverter.convertEstimate('est-gate', { ...SENDING_OPTS, database: newDb(), sideEffects: gate });
    expect(sendersCalled()).toEqual([]);
    expect(log.list()).toEqual([
      { kind: 'side_effect', type: 'customer_email', target: 'membership_started', recipient: null, detail: null },
    ]);
  });

  test('the carded real run records the SAME list and then sends it', async () => {
    const dryLog = Effects.createEffectLog(true);
    await EstimateConverter.convertEstimate('est-gate', {
      ...SENDING_OPTS, database: newDb(), sideEffects: Effects.createSideEffectGate({ dryRun: true, log: dryLog }),
    });
    const realLog = Effects.createEffectLog(true);
    await EstimateConverter.convertEstimate('est-gate', {
      ...SENDING_OPTS, database: newDb(), sideEffects: Effects.createSideEffectGate({ dryRun: false, log: realLog }),
    });
    expect(Effects.effectsFingerprint(realLog.list())).toBe(Effects.effectsFingerprint(dryLog.list()));
    expect(sendersCalled()).toEqual(['sendMembershipStarted']);
  });
});

describe('a dry run that would also ring an admin bell', () => {
  const COMMERCIAL_LINE = { name: 'Commercial Pest Program', service: 'commercial_pest_control', frequency: 'monthly', selected: true, isSelected: true };
  const commercialDb = () => makeAcceptDb({ estimate: estimateRow([PEST_LINE, COMMERCIAL_LINE]), customer: CUSTOMER, planRows: [LIVE_PEST_ROW] });

  test('names the email and the bell, sends neither', async () => {
    const log = Effects.createEffectLog(true);
    const result = await EstimateConverter.convertEstimate('est-gate', {
      ...SENDING_OPTS, database: commercialDb(), sideEffects: Effects.createSideEffectGate({ dryRun: true, log }),
    });
    expect(result.requiresManualRecurringScheduling).toBe(true);
    expect(sendersCalled()).toEqual([]);
    expect(log.list()).toEqual([
      { kind: 'side_effect', type: 'customer_email', target: 'membership_started', recipient: null, detail: null },
      expect.objectContaining({ kind: 'side_effect', type: 'admin_bell', target: 'commercial_schedule' }),
    ]);
  });

  test('the page button, with no context, rings that bell itself', async () => {
    await EstimateConverter.convertEstimate('est-gate', { ...SENDING_OPTS, database: commercialDb() });
    expect(sendersCalled()).toEqual(['notifyAdmin', 'sendMembershipStarted']);
  });

  test('with the manual accept\'s deferral the bell is returned for the post-commit plan, not sent', async () => {
    const result = await EstimateConverter.convertEstimate('est-gate', {
      ...SENDING_OPTS, database: commercialDb(), skipMembershipEmail: true, deferCommercialScheduleNotification: true,
      sideEffects: Effects.createSideEffectGate({ dryRun: true, log: Effects.createEffectLog(true) }),
    });
    expect(result.commercialScheduleNotification).toMatchObject({ options: { bell: true } });
    expect(sendersCalled()).toEqual([]);
  });
});

describe('the inline welcome text (a caller that passes no database)', () => {
  const welcomeDb = () => {
    const db = makeAcceptDb({ estimate: estimateRow([PEST_LINE]), customer: { ...CUSTOMER, phone: '+19415550142' }, planRows: [LIVE_PEST_ROW] });
    globalPool.impl = db;
    return db;
  };
  beforeEach(() => { isNewRecurringSignupCandidate.mockResolvedValue(true); });
  afterEach(() => { isNewRecurringSignupCandidate.mockResolvedValue(false); });

  test('a dry run names the text with a masked number and sends nothing', async () => {
    welcomeDb();
    const log = Effects.createEffectLog(true);
    await EstimateConverter.convertEstimate('est-gate', {
      ...SENDING_OPTS, skipMembershipEmail: true, sideEffects: Effects.createSideEffectGate({ dryRun: true, log }),
    });
    expect(sendersCalled()).toEqual([]);
    expect(log.list()).toEqual([
      { kind: 'side_effect', type: 'customer_sms', target: 'new_recurring_welcome', recipient: '***42', detail: null },
    ]);
  });

  test('the page button sends it', async () => {
    welcomeDb();
    await EstimateConverter.convertEstimate('est-gate', { ...SENDING_OPTS, skipMembershipEmail: true });
    expect(sendersCalled()).toEqual(['sendNewRecurringWelcome']);
  });
});

describe('the page button (no context)', () => {
  test('still sends the membership email itself, exactly as before', async () => {
    await EstimateConverter.convertEstimate('est-gate', { ...SENDING_OPTS, database: newDb() });
    expect(sendersCalled()).toEqual(['sendMembershipStarted']);
  });

  test('the same options with the manual accept\'s own deferrals send nothing in the converter', async () => {
    await EstimateConverter.convertEstimate('est-gate', {
      ...SENDING_OPTS, database: newDb(), skipMembershipEmail: true, skipWelcomeSms: true, deferCommercialScheduleNotification: true,
    });
    expect(sendersCalled()).toEqual([]);
  });
});

describe('the gate itself', () => {
  const descriptor = { type: 'admin_bell', target: 'plan_rate_review', detail: 'Multi-plan rate needs review after re-quote' };

  test('a dry run records and does not call', () => {
    const log = Effects.createEffectLog(true);
    const fn = jest.fn(() => 'sent');
    expect(Effects.createSideEffectGate({ dryRun: true, log }).run(descriptor, fn)).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    expect(log.list()).toEqual([{ kind: 'side_effect', type: 'admin_bell', target: 'plan_rate_review', recipient: null, detail: 'Multi-plan rate needs review after re-quote' }]);
  });

  test('a real carded run records and calls', () => {
    const log = Effects.createEffectLog(true);
    const fn = jest.fn(() => 'sent');
    expect(Effects.createSideEffectGate({ dryRun: false, log }).run(descriptor, fn)).toBe('sent');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.list()).toHaveLength(1);
  });

  test('no context calls and records nothing', () => {
    const fn = jest.fn(() => 'sent');
    expect(Effects.gateFrom({}).run(descriptor, fn)).toBe('sent');
    expect(Effects.gateFrom(undefined).run(descriptor, fn)).toBe('sent');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('the text recipient is masked to its last two digits', () => {
    expect(Effects.maskPhone('+1 (941) 555-0142')).toBe('***42');
    expect(Effects.maskPhone('12')).toBeNull();
  });
});

describe('the paths the gate cannot cover are refused, dry or real', () => {
  const dry = () => Effects.createSideEffectGate({ dryRun: true, log: Effects.createEffectLog(true) });

  test.each([
    ['visits would be booked (seeder, reminders, tech notice, shortfall bell, inspection credit)', { skipAutoSchedule: false, skipSetupInvoice: true }, 'carded_path_schedules_visits'],
    ['an invoice would be created (invoice service, Stripe, delivery, deposit alerts)', { skipAutoSchedule: true, skipSetupInvoice: false }, 'carded_path_creates_invoice'],
    ['annual prepay (renewal term and mint)', { skipAutoSchedule: true, skipSetupInvoice: true, billingTerm: 'prepay_annual' }, 'carded_path_annual_prepay'],
  ])('%s', async (_name, opts, code) => {
    const db = newDb();
    await expect(EstimateConverter.convertEstimate('est-gate', { database: db, sideEffects: dry(), ...opts }))
      .rejects.toMatchObject({ code, statusCode: 422, isOperational: true });
    // Refused before the conversion wrote anything.
    expect(db.customerUpdates).toEqual([]);
    expect(sendersCalled()).toEqual([]);
  });

  test('the same options without a context are not refused (the page keeps its paths)', async () => {
    const db = newDb();
    await expect(EstimateConverter.convertEstimate('est-gate', {
      database: db, skipAutoSchedule: true, skipSetupInvoice: true, skipMembershipEmail: true, billingTerm: 'standard',
    })).resolves.toMatchObject({ customerId: 'cust-1' });
  });
});
