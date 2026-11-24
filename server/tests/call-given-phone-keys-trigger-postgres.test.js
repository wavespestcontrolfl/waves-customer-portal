// customers.service_preferences.call_given_phone_keys lists the slot phones the call pipeline stamped as caller-given consent
// (GATE_CALL_GIVEN_CONTACT_CONSENT). Every writer of the slot phone columns (admin removal, the holder's portal save, a dedupe
// merge) must drop a removed phone from it, while the call pipeline's own UPDATE (slot + key together) keeps it.
// Runs against the owned synthetic CI/QA database.
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;

(SKIP ? describe.skip : describe)('call-given phone list follows the stored slot phones (trigger)', () => {
  const customerId = randomUUID();
  let db;

  const keys = async () => {
    const row = await db('customers').where({ id: customerId }).first('service_preferences');
    const prefs = typeof row.service_preferences === 'string' ? JSON.parse(row.service_preferences) : (row.service_preferences || {});
    return prefs.call_given_phone_keys;
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
      id: customerId, first_name: 'QA', last_name: 'CallGiven', phone: '+19415550101',
      email: `qa-callgiven-${customerId}@example.invalid`, active: true, pipeline_stage: 'active_customer',
    });
  });

  beforeEach(() => setRow({
    service_contact_phone: '+19415550202', service_contact2_phone: '(941) 555-0303', service_contact3_phone: null,
    service_preferences: JSON.stringify({ unconsented_slot_phone_keys: ['9415550999'], call_given_phone_keys: ['9415550202', '9415550303'] }),
  }));

  afterAll(async () => {
    if (!db) return;
    await db('customers').where({ id: customerId }).del();
    await db.destroy();
  });

  test('a removal drops the removed phone and keeps the rest and the other preferences', async () => {
    await setRow({ service_contact_phone: null });
    expect(await keys()).toEqual(['9415550303']);
    const row = await db('customers').where({ id: customerId }).first('service_preferences');
    const prefs = typeof row.service_preferences === 'string' ? JSON.parse(row.service_preferences) : row.service_preferences;
    expect(prefs.unconsented_slot_phone_keys).toEqual(['9415550999']);
  });

  test('the call pipeline write (slot and key in one update) keeps the new phone', async () => {
    await setRow({
      service_contact3_phone: '+19415550404',
      service_preferences: JSON.stringify({ call_given_phone_keys: ['9415550202', '9415550303', '9415550404'] }),
    });
    expect((await keys()).sort()).toEqual(['9415550202', '9415550303', '9415550404']);
  });

  test('a phone that only moves to another slot stays; an unrelated update is untouched; rows without the list are left alone', async () => {
    await setRow({ service_contact_phone: null, service_contact3_phone: '+19415550202' });
    expect((await keys()).sort()).toEqual(['9415550202', '9415550303']);
    await setRow({ first_name: 'QA2' });
    expect((await keys()).sort()).toEqual(['9415550202', '9415550303']);
    await setRow({ service_preferences: JSON.stringify({ interior_spray: true }), service_contact2_phone: null });
    expect(await keys()).toBeUndefined();
  });
});
