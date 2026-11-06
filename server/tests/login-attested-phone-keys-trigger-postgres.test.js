// customers.service_preferences.login_attested_phone_keys is written only by the
// account holder's portal save. Every other writer of the slot phone columns must
// drop a removed phone from it, and re-adding the number must not bring it back
// (GATE_CONTACT_LOGIN_HOLDER_ONLY). Runs against the owned synthetic CI/QA database.
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;

(SKIP ? describe.skip : describe)('login attestation list follows the stored slot phones (trigger)', () => {
  const customerId = randomUUID();
  const holder = '+19415550101';
  let db;

  const keys = async () => {
    const row = await db('customers').where({ id: customerId }).first('service_preferences');
    const prefs = typeof row.service_preferences === 'string' ? JSON.parse(row.service_preferences) : (row.service_preferences || {});
    return prefs.login_attested_phone_keys;
  };
  const setRow = (fields) => db('customers').where({ id: customerId }).update(fields);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const qa = process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID
      && url.pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!qa && !ci) throw new Error('Use only the owned synthetic QA or isolated CI database.');
    db = require('../models/db');
    await db('customers').insert({
      id: customerId, first_name: 'QA', last_name: 'Attest', phone: holder,
      email: `qa-attest-${customerId}@example.invalid`, active: true, pipeline_stage: 'active_customer',
    });
  });

  beforeEach(() => setRow({
    service_contact_phone: '+19415550202', service_contact2_phone: '(941) 555-0303', service_contact3_phone: null,
    service_preferences: JSON.stringify({ unconsented_slot_phone_keys: ['9415550999'], login_attested_phone_keys: ['9415550202', '9415550303'] }),
  }));

  afterAll(async () => {
    if (!db) return;
    await db('customers').where({ id: customerId }).del();
    await db.destroy();
  });

  test('an admin-style removal drops the removed phone and keeps the rest and the other preferences', async () => {
    await setRow({ service_contact_phone: null, service_contacts_consent_at: null });
    expect(await keys()).toEqual(['9415550303']);
    const row = await db('customers').where({ id: customerId }).first('service_preferences');
    const prefs = typeof row.service_preferences === 'string' ? JSON.parse(row.service_preferences) : row.service_preferences;
    expect(prefs.unconsented_slot_phone_keys).toEqual(['9415550999']);
  });

  test('remove, then the call pipeline re-adds the same number with its consent stamp: the attestation does not come back', async () => {
    await setRow({ service_contact_phone: null });
    expect(await keys()).toEqual(['9415550303']);
    await setRow({
      service_contact_phone: '+1 (941) 555-0202', service_contacts_consent_at: new Date(),
      service_contacts_consent_source: 'call_pipeline_request', service_contacts_consent_text_version: 'call-2026-07-23',
    });
    expect(await keys()).toEqual(['9415550303']);
  });

  test('a replaced phone is dropped even when the same save fills another slot', async () => {
    await setRow({ service_contact_phone: '+19415550404' });
    expect(await keys()).toEqual(['9415550303']);
  });

  test('a holder save, which writes the slots and the list in one update, keeps exactly what it lists', async () => {
    await setRow({
      service_contact_phone: '+19415550404', service_contact2_phone: null, service_contact3_phone: '+19415550202',
      service_preferences: JSON.stringify({ login_attested_phone_keys: ['9415550404', '9415550202'] }),
    });
    expect((await keys()).sort()).toEqual(['9415550202', '9415550404']);
  });

  test('a phone that only moves to another slot stays attested; an unrelated update is untouched', async () => {
    await setRow({ service_contact_phone: null, service_contact3_phone: '+19415550202' });
    expect((await keys()).sort()).toEqual(['9415550202', '9415550303']);
    await setRow({ first_name: 'QA2' });
    expect((await keys()).sort()).toEqual(['9415550202', '9415550303']);
  });

  test('rows with no list, or no preferences at all, are left alone', async () => {
    await setRow({ service_preferences: null, service_contact_phone: null });
    const row = await db('customers').where({ id: customerId }).first('service_preferences');
    expect(row.service_preferences).toBeNull();
    await setRow({ service_preferences: JSON.stringify({ unconsented_slot_phone_keys: ['9415550999'] }), service_contact2_phone: null });
    expect(await keys()).toBeUndefined();
  });
});
