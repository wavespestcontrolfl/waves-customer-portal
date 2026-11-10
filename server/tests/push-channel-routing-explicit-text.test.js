// GATE_APP_FIRST_ANY_DEVICE, owner 2026-11-04: "only the customer can change back to
// text, if they prefer". The channel columns are seeded with 'sms', so a stored 'sms'
// vetoes the app notice only when the customer's explicit-choice marker is true.
// Email and Both veto as before; Gate off leaves the old rules byte for byte.

const { _test } = require('../services/messaging/push-channel-routing');

const ENV = 'GATE_APP_FIRST_ANY_DEVICE';
let saved;
beforeEach(() => { saved = process.env[ENV]; process.env[ENV] = 'true'; });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

// Chainable knex stub; a fixture may be a row, an Error, or a function of the LAST where() arg.
// Records the columns each first() asked for.
function stubKnex(tables, asked = []) {
  return (name) => {
    let lastWhere;
    return {
      where(arg) { lastWhere = arg; return this; },
      async first(...cols) {
        if (name === 'notification_prefs') asked.push(cols);
        let v = tables[name];
        if (typeof v === 'function') v = v(lastWhere);
        if (v instanceof Error) throw v;
        return v;
      },
    };
  };
}

const holder = { phone: '9415550123', account_id: null };
const eligible = (messageType, prefs, asked) => _test.pushEligibleRuntime('c-1', '9415550123', messageType,
  stubKnex({ customers: holder, notification_prefs: prefs }, asked));

// messageType -> [channel column, marker column]
const ROUTED = [
  ['appointment_reminder', 'service_reminder_24h_channel', 'service_reminder_24h_channel_explicit'],
  ['reminder_72h', 'service_reminder_72h_channel', 'service_reminder_72h_channel_explicit'],
  ['tech_en_route', 'en_route_channel', 'en_route_channel_explicit'],
  ['tech_arrived', 'tech_arrived_channel', 'tech_arrived_channel_explicit'],
  ['service_complete', 'service_complete_channel', 'service_complete_channel_explicit'],
  ['service_report_v1', 'service_complete_channel', 'service_complete_channel_explicit'],
  ['lawn_watering_instruction', 'service_complete_channel', 'service_complete_channel_explicit'],
  ['receipt', 'payment_receipt_channel', 'payment_receipt_channel_explicit'],
  ['deposit_receipt', 'payment_receipt_channel', 'payment_receipt_channel_explicit'],
];

describe('gate on: the customer\'s own Text choice keeps the text', () => {
  test.each(ROUTED)('%s: an explicit sms vetoes the app notice', async (type, col, marker) => {
    await expect(eligible(type, { [col]: 'sms', [marker]: true })).resolves.toBe(false);
  });

  test.each(ROUTED)('%s: the seeded default sms (marker false or absent) routes to the app', async (type, col, marker) => {
    await expect(eligible(type, { [col]: 'sms', [marker]: false })).resolves.toBe(true);
    await expect(eligible(type, { [col]: 'sms' })).resolves.toBe(true);
    await expect(eligible(type, undefined)).resolves.toBe(true);
  });

  test.each(ROUTED)('%s: an explicit App choice routes, and email / both still veto', async (type, col, marker) => {
    await expect(eligible(type, { [col]: 'push', [marker]: true })).resolves.toBe(true);
    for (const value of ['email', 'both']) {
      await expect(eligible(type, { [col]: value })).resolves.toBe(false);
      await expect(eligible(type, { [col]: value, [marker]: true })).resolves.toBe(false);
    }
  });

  test('the marker is read with the channel, only when the gate is on', async () => {
    const asked = [];
    await eligible('tech_arrived', { tech_arrived_channel: 'sms' }, asked);
    expect(asked[0]).toEqual(['tech_arrived_channel', 'tech_arrived_channel_explicit']);
    delete process.env[ENV];
    const askedOff = [];
    await eligible('tech_arrived', { tech_arrived_channel: 'sms' }, askedOff);
    expect(askedOff[0]).toEqual(['tech_arrived_channel']);
  });

  test('an explicit Text choice is read from the account PRIMARY profile, not the selected property', async () => {
    const knex = stubKnex({
      customers: (where) => (where && where.account_id ? { id: 'primary-1' } : { phone: '9415550123', account_id: 'acct-1' }),
      notification_prefs: (where) => (where && where.customer_id === 'primary-1'
        ? { en_route_channel: 'sms', en_route_channel_explicit: true }
        : { en_route_channel: 'sms', en_route_channel_explicit: false }),
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'tech_en_route', knex)).resolves.toBe(false);
    // The reverse: a Text choice stamped on the property row only does not veto.
    const reverse = stubKnex({
      customers: (where) => (where && where.account_id ? { id: 'primary-1' } : { phone: '9415550123', account_id: 'acct-1' }),
      notification_prefs: (where) => (where && where.customer_id === 'primary-1'
        ? { en_route_channel: 'sms', en_route_channel_explicit: false }
        : { en_route_channel: 'sms', en_route_channel_explicit: true }),
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'tech_en_route', reverse)).resolves.toBe(true);
  });

  test('receipts follow the charged profile own row', async () => {
    const knex = stubKnex({
      customers: (where) => (where && where.account_id ? { id: 'primary-1' } : { phone: '9415550123', account_id: 'acct-1' }),
      notification_prefs: (where) => (where && where.customer_id === 'primary-1'
        ? { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: false }
        : { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: true }),
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'receipt', knex)).resolves.toBe(false);
  });

  test('billing channel arrays keep winning for receipts', async () => {
    // An explicit array with App routes even beside a stored explicit Text; one without App never routes.
    await expect(eligible('receipt', { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: true, payment_receipt_channels: ['push'] }))
      .resolves.toBe(true);
    await expect(eligible('receipt', { payment_receipt_channel: 'sms', payment_receipt_channel_explicit: false, payment_receipt_channels: ['sms'] }))
      .resolves.toBe(false);
  });

  test('channels without a marker keep their existing rules', async () => {
    // payment_issue keeps its own pre-existing explicit-Text veto.
    await expect(eligible('payment_failure', { payment_issue_channel: 'sms' })).resolves.toBe(false);
    await expect(eligible('billing_reminder', { billing_channel: 'sms' })).resolves.toBe(true);
  });
});

describe('gate off: nothing changes', () => {
  beforeEach(() => { delete process.env[ENV]; });

  test.each(ROUTED)('%s: a stored sms with the marker true still routes exactly as before', async (type, col, marker) => {
    await expect(eligible(type, { [col]: 'sms', [marker]: true })).resolves.toBe(true);
    await expect(eligible(type, { [col]: 'sms' })).resolves.toBe(true);
    await expect(eligible(type, { [col]: 'email' })).resolves.toBe(false);
  });
});
