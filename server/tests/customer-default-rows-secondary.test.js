const { createDefaultCustomerRows, SECONDARY_PROFILE_APPOINTMENT_TEXTS_OFF } = require('../services/customer-default-rows');

// Minimal knex double: records every insert payload per table and answers the
// customers lookup with the row under test.
function fakeDb(customerRow) {
  const inserts = {};
  const dbc = jest.fn((table) => ({
    where: jest.fn(() => ({ first: jest.fn(async () => customerRow) })),
    insert: jest.fn((payload) => {
      inserts[table] = payload;
      return { onConflict: jest.fn(() => ({ ignore: jest.fn(async () => undefined) })) };
    }),
  }));
  return { dbc, inserts };
}

describe('createDefaultCustomerRows — secondary profiles start with appointment texts off', () => {
  test('a primary profile keeps the column defaults (transactional on, marketing NULL)', async () => {
    const { dbc, inserts } = fakeDb({ is_primary_profile: true, account_id: 'acct-1' });
    await createDefaultCustomerRows(dbc, 'cust-1');
    expect(inserts.property_preferences).toEqual({ customer_id: 'cust-1' });
    expect(inserts.notification_prefs).toEqual({ customer_id: 'cust-1', seasonal_tips: null, marketing_offers: null });
  });

  test('an additional property on an account seeds the five appointment texts false', async () => {
    const { dbc, inserts } = fakeDb({ is_primary_profile: false, account_id: 'acct-1' });
    await createDefaultCustomerRows(dbc, 'cust-2');
    expect(inserts.notification_prefs).toEqual({
      customer_id: 'cust-2', seasonal_tips: null, marketing_offers: null,
      appointment_confirmation: false, service_reminder_72h: false, service_reminder_24h: false,
      tech_en_route: false, tech_arrived: false,
    });
    // The account holder's copy is NOT part of the rule (owner ruling 2026-07-24).
    expect(SECONDARY_PROFILE_APPOINTMENT_TEXTS_OFF).not.toHaveProperty('appointment_notify_primary');
  });

  test('a NULL primary flag on an account-linked row is secondary too', async () => {
    const { dbc, inserts } = fakeDb({ is_primary_profile: null, account_id: 'acct-1' });
    await createDefaultCustomerRows(dbc, 'cust-4');
    expect(inserts.notification_prefs).toMatchObject({ customer_id: 'cust-4', appointment_confirmation: false, tech_arrived: false });
  });

  test('a stand-alone row with no account, or no customer row at all, is treated as primary', async () => {
    for (const row of [{ is_primary_profile: false, account_id: null }, undefined]) {
      const { dbc, inserts } = fakeDb(row);
      await createDefaultCustomerRows(dbc, 'cust-3');
      expect(inserts.notification_prefs).toEqual({ customer_id: 'cust-3', seasonal_tips: null, marketing_offers: null });
    }
  });
});
