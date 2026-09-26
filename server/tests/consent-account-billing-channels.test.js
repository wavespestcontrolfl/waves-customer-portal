// Explicit billing channel arrays are account-level (stored on the primary
// profile). loadContactState overlays them onto a sibling property's prefs so
// the router fan-out and the per-leg consent re-read agree with the choice.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { loadContactState } = require('../services/messaging/validators/consent');

function databaseWith({ prefs, customers, failCustomersPrimary = false }) {
  return jest.fn((table) => {
    const conditions = {};
    const q = {
      where: jest.fn((cond) => { Object.assign(conditions, cond); return q; }),
      first: jest.fn(async () => {
        if (table === 'notification_prefs') {
          const row = prefs.find((r) => String(r.customer_id) === String(conditions.customer_id));
          return row ? { ...row } : undefined;
        }
        if (table === 'customers') {
          if (failCustomersPrimary && conditions.is_primary_profile) throw new Error('primary read failed');
          return customers.find((row) => Object.entries(conditions)
            .every(([key, value]) => String(row[key]) === String(value)));
        }
        return undefined;
      }),
    };
    return q;
  });
}

const billingInput = (customerId) => ({ customerId, purpose: 'billing', metadata: { billingDeliveryCategory: 'billing' } });

const customers = [
  { id: 'primary', account_id: 'acct-1', is_primary_profile: true },
  { id: 'sibling', account_id: 'acct-1', is_primary_profile: false },
];

test("a sibling property's contact state carries the primary's billing arrays, other prefs stay per-property", async () => {
  const dbh = databaseWith({ customers, prefs: [
    { customer_id: 'primary', billing_channels: ['email'], invoice_channels: ['push'], sms_enabled: true },
    { customer_id: 'sibling', billing_channels: null, sms_enabled: false },
  ] });
  const state = await loadContactState(billingInput('sibling'), dbh);
  expect(state.lookupFailed).toBe(false);
  expect(state.prefs).toMatchObject({
    customer_id: 'sibling', sms_enabled: false, billing_channels: ['email'], invoice_channels: ['push'],
  });
});

test('the primary profile keeps its own row untouched', async () => {
  const dbh = databaseWith({ customers, prefs: [{ customer_id: 'primary', billing_channels: ['sms'] }] });
  const state = await loadContactState(billingInput('primary'), dbh);
  expect(state.prefs).toEqual({ customer_id: 'primary', billing_channels: ['sms'] });
});

test('an unreadable primary owner fails the lookup closed', async () => {
  const dbh = databaseWith({ customers, failCustomersPrimary: true, prefs: [{ customer_id: 'sibling' }] });
  const state = await loadContactState(billingInput('sibling'), dbh);
  expect(state.lookupFailed).toBe(true);
});

test('a non-billing send never pays for (or fails on) the owner lookup', async () => {
  const dbh = databaseWith({ customers, failCustomersPrimary: true, prefs: [{ customer_id: 'sibling', sms_enabled: true }] });
  const state = await loadContactState({ customerId: 'sibling', purpose: 'appointment' }, dbh);
  expect(state.lookupFailed).toBe(false);
  expect(state.prefs).toEqual({ customer_id: 'sibling', sms_enabled: true });
});
