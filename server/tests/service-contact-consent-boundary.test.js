/**
 * #5467 per-phone consent boundary + server-owned service_preferences keys.
 * An on-site contact the call pipeline filed while keeping the account's
 * existing consent stamp sits on service_preferences.unconsented_slot_phone_keys:
 * every TEXT resolver holds that phone out (whatever the double opt-in gate
 * does) until the person's own YES; email resolution is untouched. The two
 * customer-facing writers that rebuild service_preferences keep the
 * server-owned keys.
 */
const { getAppointmentContacts, getServiceContactSmsRecipient } = require('../services/customer-contact');
const { withServerOwnedPrefs, SERVER_OWNED_PREF_KEYS } = require('../utils/service-preferences-server-keys');

const base = {
  first_name: 'Sample', last_name: 'Holder', phone: '+15550100001', email: 'holder@example.com',
  service_contacts_consent_at: new Date('2026-07-22T00:00:00Z'),
  service_contact_name: 'Sample Manager', service_contact_phone: '+15550100002',
  service_contact2_name: 'Sample Spouse', service_contact2_phone: '+15550100003',
};

describe('unconsented_slot_phone_keys holds a phone out of text resolution', () => {
  test('getAppointmentContacts: the held phone is skipped, the stamped contacts stay', () => {
    const phones = getAppointmentContacts({ ...base, service_preferences: { unconsented_slot_phone_keys: ['5550100003'] } }).map((c) => c.phone);
    expect(phones).toContain('+15550100002');
    expect(phones).not.toContain('+15550100003');
  });

  test('a JSON-string service_preferences is read too', () => {
    const phones = getAppointmentContacts({ ...base, service_preferences: JSON.stringify({ unconsented_slot_phone_keys: ['5550100003'] }) }).map((c) => c.phone);
    expect(phones).not.toContain('+15550100003');
  });

  test('email resolution (skipConsentGate) is not affected', () => {
    const phones = getAppointmentContacts({ ...base, service_preferences: { unconsented_slot_phone_keys: ['5550100003'] } }, {}, { skipConsentGate: true }).map((c) => c.phone);
    expect(phones).toContain('+15550100003');
  });

  test('getServiceContactSmsRecipient: a held slot-1 phone falls back to the primary', () => {
    const r = getServiceContactSmsRecipient({ ...base, service_preferences: { unconsented_slot_phone_keys: ['5550100002'] } });
    expect(r.role).toBe('primary');
    expect(r.phone).toBe('+15550100001');
  });

  test('no list: unchanged behavior', () => {
    expect(getAppointmentContacts(base).map((c) => c.phone)).toEqual(expect.arrayContaining(['+15550100002', '+15550100003']));
  });
});

describe('server-owned service_preferences keys survive customer-facing rebuilds', () => {
  test('withServerOwnedPrefs carries every server key from the stored blob', () => {
    const raw = { interior_spray: true, demote_primary_on_optin: { a: 1 }, demote_primary_applied: { b: 1 }, consent_covered_phone_keys: ['1'], unconsented_slot_phone_keys: ['2'] };
    const out = withServerOwnedPrefs(raw, { interior_spray: false });
    expect(out.interior_spray).toBe(false);
    for (const k of SERVER_OWNED_PREF_KEYS) expect(out[k]).toEqual(raw[k]);
  });

  test('both writers route through it', () => {
    const fs = require('fs');
    const prefsRoute = fs.readFileSync(require.resolve('../routes/service-preferences'), 'utf8');
    const estimateRoute = fs.readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    expect(prefsRoute).toContain("require('../utils/service-preferences-server-keys').withServerOwnedPrefs(raw, storedBase)");
    expect(estimateRoute).toContain("require('../utils/service-preferences-server-keys').withServerOwnedPrefs(curRaw, prefs)");
    // ...reading the stored blob under a row lock, so a key written in between is never lost.
    expect(estimateRoute).toContain(".select('service_preferences').where({ id: customerId }).forUpdate().first();");
  });
});
