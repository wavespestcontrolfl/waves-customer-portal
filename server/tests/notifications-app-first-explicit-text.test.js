// GATE_APP_FIRST_ANY_DEVICE, owner 2026-11-04: "only the customer can change back to
// text, if they prefer". The save route stamps an explicit-choice marker on each routed
// channel the customer writes; the GET payload shows App for an untouched Text default
// once the account holder has the phone app; a save that echoes the shown App stores
// nothing.

jest.mock('express', () => ({ Router: () => ({ use: jest.fn(), get: jest.fn(), put: jest.fn(), post: jest.fn() }) }));
jest.mock('joi', () => ({}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({ authenticate: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn() }));
const mockCustomerStatus = jest.fn();
jest.mock('../services/push-notifications', () => ({
  PUSH_HEARTBEAT_HOURS: 72,
  customerStatus: (...args) => mockCustomerStatus(...args),
}));
jest.mock('../services/account-properties', () => ({
  ...jest.requireActual('../services/account-properties'),
  resolvePrimaryProfileId: jest.fn(async () => 'primary-1'),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { resolvePrimaryProfileId } = require('../services/account-properties');
const notificationsRoute = require('../routes/notifications');

const { notificationPrefsDbUpdates, loadPreferencePayload, settleShownAppChoices, CHANNEL_DB_COLUMNS } = notificationsRoute._private;

const ENV_KEYS = ['GATE_APP_FIRST_ANY_DEVICE', 'GATE_PUSH_CHANNEL_ROUTING', 'GATE_CUSTOMER_APP_NOTIFICATIONS'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => { process.env[k] = 'true'; });
  mockCustomerStatus.mockReset();
  mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: true });
  resolvePrimaryProfileId.mockResolvedValue('primary-1');
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const NEW_FLAGS = [
  ['serviceReminder24hChannel', 'service_reminder_24h_channel', 'service_reminder_24h_channel_explicit'],
  ['enRouteChannel', 'en_route_channel', 'en_route_channel_explicit'],
  ['techArrivedChannel', 'tech_arrived_channel', 'tech_arrived_channel_explicit'],
  ['serviceCompleteChannel', 'service_complete_channel', 'service_complete_channel_explicit'],
];

describe('save route: explicit-choice markers', () => {
  test.each(NEW_FLAGS)('%s stamps %s for every value, Text included, and only on a write of that channel', (key, column, marker) => {
    for (const value of ['sms', 'push']) {
      expect(notificationPrefsDbUpdates({ [key]: value }, {})).toEqual({ [column]: value, [marker]: true });
    }
    expect(notificationPrefsDbUpdates({ smsEnabled: false }, {})).not.toHaveProperty(marker);
  });

  test('the 72 hour marker is unchanged', () => {
    expect(notificationPrefsDbUpdates({ serviceReminder72hChannel: 'sms' }, {}))
      .toEqual({ service_reminder_72h_channel: 'sms', service_reminder_72h_channel_explicit: true });
  });

  test('a receipt channel change stamps, whatever the new value', () => {
    expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'email' }, { payment_receipt_channel: 'sms' }))
      .toEqual({ payment_receipt_channel: 'email', payment_receipt_channel_explicit: true });
    expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'sms' }, { payment_receipt_channel: 'email' }))
      .toEqual({ payment_receipt_channel: 'sms', payment_receipt_channel_explicit: true });
  });

  test('a receipt echo of the stored value is not a choice (the legacy billing save sends it every time)', () => {
    expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'sms', billingReminderChannel: 'sms' }, { payment_receipt_channel: 'sms' }))
      .toEqual({ payment_receipt_channel: 'sms', billing_channel: 'sms' });
  });

  test('while the page shows App for the untouched Text default, picking Text is a choice', () => {
    expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'sms' }, { payment_receipt_channel: 'sms' }, { appShown: true }))
      .toEqual({ payment_receipt_channel: 'sms', payment_receipt_channel_explicit: true });
    // An explicit Text row is shown as Text, so saving Text again changes nothing.
    expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'sms' },
      { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: true }, { appShown: true }))
      .toEqual({ payment_receipt_channel: 'sms' });
  });

  test('the marker columns travel with their channel to the primary profile row', () => {
    for (const [, , marker] of NEW_FLAGS) expect(CHANNEL_DB_COLUMNS).toContain(marker);
    // The receipt channel is per charged row, so its marker is too.
    expect(CHANNEL_DB_COLUMNS).not.toContain('payment_receipt_channel_explicit');
  });
});

describe('save route: echoing the shown App stores nothing', () => {
  const appReq = (customerId = 'c-1') => ({ customerId, query: { appPreferences: '1' } });
  const primaryRow = (row) => db.mockImplementation(() => ({ where: () => ({ first: async () => row }) }));

  test('drops an App echo for an untouched Text default, keeps everything else', async () => {
    primaryRow({ en_route_channel: 'sms', en_route_channel_explicit: false });
    const updates = { enRouteChannel: 'push', serviceReminder24hChannel: 'sms' };
    const shown = await settleShownAppChoices(appReq(), updates, { payment_receipt_channel: 'sms' });
    expect(shown).toBe(true);
    expect(updates).toEqual({ serviceReminder24hChannel: 'sms' });
  });

  test('keeps an App choice over an explicit Text row (the customer switches to App)', async () => {
    primaryRow({ en_route_channel: 'sms', en_route_channel_explicit: true });
    const updates = { enRouteChannel: 'push' };
    await settleShownAppChoices(appReq(), updates, {});
    expect(updates).toEqual({ enRouteChannel: 'push' });
  });

  test('a receipt App echo is judged on the current customer row', async () => {
    const updates = { paymentConfirmationChannel: 'push' };
    await settleShownAppChoices(appReq('primary-1'), updates, { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: false });
    expect(updates).toEqual({});
  });

  test('gate off, no app device, or a page that cannot render App: nothing is dropped', async () => {
    const run = async (request = appReq('primary-1')) => {
      const updates = { paymentConfirmationChannel: 'push' };
      const shown = await settleShownAppChoices(request, updates, { payment_receipt_channel: 'sms' });
      return { shown, updates };
    };
    const untouched = { shown: false, updates: { paymentConfirmationChannel: 'push' } };
    delete process.env.GATE_APP_FIRST_ANY_DEVICE;
    expect(await run()).toEqual(untouched);
    process.env.GATE_APP_FIRST_ANY_DEVICE = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: false, reachable: false });
    expect(await run()).toEqual(untouched);
    mockCustomerStatus.mockResolvedValue({ enabled: true, reachable: true });
    expect(await run({ customerId: 'primary-1', query: {} })).toEqual(untouched);
  });
});

describe('GET payload: App is shown for an untouched Text default', () => {
  function mockRows({ own, primary }) {
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') {
        return { where: ({ customer_id: id }) => ({ first: async () => (String(id) === 'primary-1' ? primary : own) }) };
      }
      if (table === 'customers') {
        return {
          where: () => ({ first: async () => ({ email: 'a@example.com' }) }),
          whereIn: () => ({ select: async () => [{ id: 'c-1', email: 'a@example.com' }] }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
  }
  const req = (query = { appPreferences: '1' }, extra = {}) => ({ customerId: 'c-1', query, ...extra });
  const KEYS = ['serviceReminder72hChannel', 'serviceReminder24hChannel', 'enRouteChannel', 'techArrivedChannel', 'serviceCompleteChannel', 'paymentConfirmationChannel'];
  const defaults = {
    service_reminder_72h_channel: 'sms', service_reminder_24h_channel: 'sms', en_route_channel: 'sms',
    tech_arrived_channel: 'sms', service_complete_channel: 'sms', payment_receipt_channel: 'sms',
    appointment_confirmation_channel: 'sms',
  };

  test('gate on + app device + untouched Text: App on every routed key, other keys untouched', async () => {
    mockRows({ own: defaults, primary: defaults });
    const payload = await loadPreferencePayload(req());
    for (const key of KEYS) expect(payload[key]).toBe('push');
    expect(payload.appointmentConfirmationChannel).toBe('sms');
    expect(payload.billingReminderChannel).toBe('sms');
  });

  test('an explicit Text shows as Text; Email and Both show as stored', async () => {
    const primary = {
      ...defaults, service_reminder_24h_channel_explicit: true, service_reminder_72h_channel_explicit: true,
      en_route_channel: 'email', tech_arrived_channel: 'both',
    };
    mockRows({ own: { ...defaults, payment_receipt_channel_explicit: true }, primary });
    const payload = await loadPreferencePayload(req());
    expect(payload).toMatchObject({
      serviceReminder72hChannel: 'sms', serviceReminder24hChannel: 'sms', enRouteChannel: 'email', techArrivedChannel: 'both',
      serviceCompleteChannel: 'push', paymentConfirmationChannel: 'sms',
    });
  });

  test('channels are read from the primary profile, the receipt from the current row', async () => {
    mockRows({
      own: { ...defaults, service_reminder_24h_channel_explicit: true, payment_receipt_channel_explicit: true },
      primary: { ...defaults, service_reminder_24h_channel_explicit: false },
    });
    const payload = await loadPreferencePayload(req());
    expect(payload.serviceReminder24hChannel).toBe('push');
    expect(payload.paymentConfirmationChannel).toBe('sms');
  });

  test.each([
    ['gate off', () => { delete process.env.GATE_APP_FIRST_ANY_DEVICE; }],
    ['routing gate off', () => { delete process.env.GATE_PUSH_CHANNEL_ROUTING; }],
    ['no app device', () => { mockCustomerStatus.mockResolvedValue({ enabled: true, registered: false, reachable: false }); }],
    ['app alerts turned off', () => { mockCustomerStatus.mockResolvedValue({ enabled: false, registered: true, reachable: true }); }],
    ['status lookup fails', () => { mockCustomerStatus.mockRejectedValue(new Error('db down')); }],
  ])('%s: the stored values', async (_label, arrange) => {
    arrange();
    mockRows({ own: defaults, primary: defaults });
    const payload = await loadPreferencePayload(req());
    for (const key of KEYS.filter((key) => key !== 'serviceCompleteChannel')) expect(payload[key]).toBe('sms');
    expect(payload.serviceCompleteChannel).toBe('sms');
  });

  test('a page that cannot render App (no appPreferences) and a contact session see the stored values', async () => {
    mockRows({ own: defaults, primary: defaults });
    for (const request of [req({}), req({ appPreferences: '1' }, { contactSession: { phoneKey: '9415550999' } })]) {
      const payload = await loadPreferencePayload(request);
      for (const key of ['serviceReminder24hChannel', 'enRouteChannel', 'paymentConfirmationChannel']) expect(payload[key]).toBe('sms');
    }
  });
});

describe('migration 20261105020000_notice_channel_explicit_flags', () => {
  const FILE = '../models/migrations/20261105020000_notice_channel_explicit_flags';
  const migration = require(FILE);
  const COLUMNS = NEW_FLAGS.map(([, , marker]) => marker).concat('payment_receipt_channel_explicit');

  // In-memory stand-in for the table: alterTable runs the builder against a recorder.
  function fakeKnex({ hasTable = true, present = [] } = {}) {
    const columns = new Set(present);
    const added = [];
    const knex = {
      schema: {
        hasTable: async () => hasTable,
        hasColumn: async (_table, column) => columns.has(column),
        alterTable: async (_table, build) => {
          build({
            boolean: (name) => {
              const chain = {
                notNullable: () => chain,
                defaultTo: (value) => { columns.add(name); added.push([name, value]); return chain; },
              };
              return chain;
            },
            dropColumn: (name) => { columns.delete(name); },
          });
        },
      },
    };
    return { knex, columns, added };
  }

  test('up adds the five columns DEFAULT false; down drops them; up again works', async () => {
    const { knex, columns, added } = fakeKnex();
    await migration.up(knex);
    expect([...columns].sort()).toEqual([...COLUMNS].sort());
    expect(added.every(([, value]) => value === false)).toBe(true);
    await migration.down(knex);
    expect(columns.size).toBe(0);
    await migration.up(knex);
    expect(columns.size).toBe(5);
  });

  test('up and down are idempotent', async () => {
    const { knex, columns } = fakeKnex({ present: COLUMNS });
    await migration.up(knex);
    expect(columns.size).toBe(5);
    await migration.down(knex);
    await migration.down(knex);
    expect(columns.size).toBe(0);
  });

  test('no table, no change', async () => {
    const { knex, columns } = fakeKnex({ hasTable: false });
    await migration.up(knex);
    await migration.down(knex);
    expect(columns.size).toBe(0);
  });

  test('the file declares exactly the columns the route stamps, NOT NULL', () => {
    const source = fs.readFileSync(path.join(__dirname, `${FILE}.js`), 'utf8');
    for (const column of COLUMNS) expect(source).toContain(`'${column}'`);
    expect(source).toContain('.notNullable().defaultTo(false)');
  });
});
