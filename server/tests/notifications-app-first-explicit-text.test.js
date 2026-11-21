// Owner 2026-11-20: "lets revert to text, if they want to setup app notifications, let
// them do it on their own". The settings page shows the stored channel: an untouched
// default reads Text, even when the account holder has the phone app, and an App pick is
// always the customer's own write. The save route still stamps an explicit-choice marker
// on each routed channel the customer writes (an explicit Text stops the companion app
// alert). The 2026-11-04 rule (App shown for an untouched Text default; an echo of the
// shown App stores nothing) is withdrawn.

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

const { notificationPrefsDbUpdates, dropLegacyReceiptAppEcho, loadPreferencePayload, CHANNEL_DB_COLUMNS } = notificationsRoute._private;

const ENV_KEYS = ['GATE_PUSH_CHANNEL_ROUTING', 'GATE_CUSTOMER_APP_NOTIFICATIONS', 'GATE_APP_FIRST_STALE_TEXT'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => { process.env[k] = 'true'; });
  delete process.env.GATE_APP_FIRST_STALE_TEXT;
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

  test('a receipt Text save over the untouched Text default is an echo of what the page showed, not a choice', () => {
    // The page shows the stored Text (never App) for an untouched default, so Text again stores no marker.
    expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'sms' }, { payment_receipt_channel: 'sms' }))
      .toEqual({ payment_receipt_channel: 'sms' });
    expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'sms' },
      { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: true }))
      .toEqual({ payment_receipt_channel: 'sms' });
  });

  test('the marker columns travel with their channel to the primary profile row', () => {
    for (const [, , marker] of NEW_FLAGS) expect(CHANNEL_DB_COLUMNS).toContain(marker);
    // The receipt channel is per charged row, so its marker is too.
    expect(CHANNEL_DB_COLUMNS).not.toContain('payment_receipt_channel_explicit');
  });
});

describe('save route: an App pick is the customer\'s own choice and is stored (owner 2026-11-20)', () => {
  test('App over an untouched Text default is stored with its marker: the page showed Text, so App is no echo', () => {
    expect(notificationPrefsDbUpdates({ enRouteChannel: 'push', serviceReminder24hChannel: 'sms' }, { en_route_channel: 'sms' }))
      .toEqual({
        en_route_channel: 'push', en_route_channel_explicit: true,
        service_reminder_24h_channel: 'sms', service_reminder_24h_channel_explicit: true,
      });
  });

  test('a receipt App value over the customer\'s own earlier choice is stored with its marker', () => {
    for (const existing of [
      { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: true },
      { payment_receipt_channel: 'email', payment_receipt_channel_explicit: false },
    ]) {
      const updates = dropLegacyReceiptAppEcho({ paymentConfirmationChannel: 'push', billingEmail: 'a@example.com' }, existing);
      expect(updates).toEqual({ paymentConfirmationChannel: 'push', billingEmail: 'a@example.com' });
      expect(notificationPrefsDbUpdates({ paymentConfirmationChannel: 'push' }, existing))
        .toEqual({ payment_receipt_channel: 'push', payment_receipt_channel_explicit: true });
    }
  });

  // The legacy billing form sends its receipt channel on every save. A page loaded before
  // 2026-11-20 showed App for an untouched Text default, so saving only the billing email
  // echoes 'push'. That echo must never become an App choice (pre-push audit P1, 2026-11-20).
  test('the legacy billing form\'s App echo over an untouched Text default is dropped; the rest of the save is kept', () => {
    for (const existing of [
      { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: false },
      { payment_receipt_channel: 'sms' },
      { payment_receipt_channel: null },
      {},
      undefined,
    ]) {
      const updates = dropLegacyReceiptAppEcho(
        { paymentConfirmationChannel: 'push', billingEmail: 'a@example.com', billingReminderChannel: 'sms' }, existing);
      expect(updates).toEqual({ billingEmail: 'a@example.com', billingReminderChannel: 'sms' });
      expect(notificationPrefsDbUpdates(updates, existing || {})).not.toHaveProperty('payment_receipt_channel');
      expect(notificationPrefsDbUpdates(updates, existing || {})).not.toHaveProperty('payment_receipt_channel_explicit');
    }
  });

  test('the echo guard touches only an App value on the legacy receipt key', () => {
    const untouched = { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: false };
    for (const updates of [
      { paymentConfirmationChannel: 'sms' }, { paymentConfirmationChannel: 'email' }, { paymentConfirmationChannel: 'both' },
      { enRouteChannel: 'push' }, { paymentConfirmationChannels: ['push'] }, { billingEmail: '' },
    ]) {
      expect(dropLegacyReceiptAppEcho({ ...updates }, untouched)).toEqual(updates);
    }
  });

  test('the save route runs the echo guard before it builds the write', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/notifications.js'), 'utf8');
    const guard = source.indexOf('dropLegacyReceiptAppEcho(updates, existing || {});');
    const write = source.indexOf('const allDbUpdates = notificationPrefsDbUpdates(updates, existing || {});');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
  });

  test('the route no longer drops a saved App value', () => {
    expect(notificationsRoute._private.settleShownAppChoices).toBeUndefined();
    const source = fs.readFileSync(path.join(__dirname, '../routes/notifications.js'), 'utf8');
    for (const gone of ['settleShownAppChoices', 'appFirstDisplayActive', 'withAppFirstDisplay']) expect(source).not.toContain(gone);
  });
});

describe('GET payload: the stored channel is shown, Text for an untouched default (owner 2026-11-20)', () => {
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

  test('every gate on + a reachable phone app + untouched Text: Text on every routed key, and no device read', async () => {
    mockRows({ own: defaults, primary: defaults });
    const payload = await loadPreferencePayload(req());
    for (const key of KEYS) expect(payload[key]).toBe('sms');
    expect(payload.appointmentConfirmationChannel).toBe('sms');
    expect(payload.billingReminderChannel).toBe('sms');
    expect(mockCustomerStatus).not.toHaveBeenCalled();
  });

  test('a phone not opened in 30 days (GATE_APP_FIRST_STALE_TEXT on) shows Text too', async () => {
    process.env.GATE_APP_FIRST_STALE_TEXT = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: true, registered: true, fresh: false, reachable: false, appStale: true });
    mockRows({ own: defaults, primary: defaults });
    const payload = await loadPreferencePayload(req());
    for (const key of KEYS) expect(payload[key]).toBe('sms');
  });

  test('the customer\'s own App, Email and Both choices show as stored', async () => {
    const primary = {
      ...defaults, service_reminder_24h_channel: 'push', service_reminder_24h_channel_explicit: true,
      en_route_channel: 'email', tech_arrived_channel: 'both',
    };
    mockRows({ own: { ...defaults, payment_receipt_channel: 'push', payment_receipt_channel_explicit: true }, primary });
    const payload = await loadPreferencePayload(req());
    expect(payload).toMatchObject({
      serviceReminder72hChannel: 'sms', serviceReminder24hChannel: 'push', enRouteChannel: 'email', techArrivedChannel: 'both',
      serviceCompleteChannel: 'sms', paymentConfirmationChannel: 'push',
    });
  });

  test('channels are read from the primary profile, the receipt from the current row', async () => {
    mockRows({
      own: { ...defaults, service_reminder_24h_channel: 'email', payment_receipt_channel: 'email' },
      primary: { ...defaults, service_reminder_24h_channel: 'both' },
    });
    const payload = await loadPreferencePayload(req());
    expect(payload.serviceReminder24hChannel).toBe('both');
    expect(payload.paymentConfirmationChannel).toBe('email');
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
