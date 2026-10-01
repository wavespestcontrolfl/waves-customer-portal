/**
 * Codex #5506 r1 P1: the office approval's address witness must be bound to the final customer_confirmed
 * stamp itself. The stamp takes the visit row FOR UPDATE, re-reads the address from that locked row and
 * stamps only on a match, so an address write that lands between the approval and the stamp leaves the
 * hold pending. Real PostgreSQL, synthetic data only.
 */
const { randomUUID } = require('crypto');
const knexFactory = require('knex');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('the activation stamp is bound to the approved address (real PostgreSQL)', () => {
  let knex;
  let schema;
  const ADDRESS = { service_address_line1: '1234 Sample Newbuild Trl', service_address_line2: '', service_address_city: 'Parrish', service_address_state: 'FL', service_address_zip: '34219' };
  const NORM = '1234 sample newbuild trl parrish fl 34219';

  beforeAll(async () => {
    schema = `hold_stamp_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['scheduled_services', 'triage_items', 'call_log']) {
      await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
  }, 60000);

  afterAll(async () => {
    if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); }
  });

  beforeEach(async () => {
    for (const table of ['triage_items', 'scheduled_services', 'call_log']) await knex(table).del();
  });

  async function seed({ witness = NORM, cardStatus = 'open' } = {}) {
    const callId = randomUUID();
    const visitId = randomUUID();
    await knex('call_log').insert({ id: callId });
    await knex('scheduled_services').insert({
      id: visitId, scheduled_date: '2099-01-05', service_type: 'pest_control', status: 'confirmed',
      customer_confirmed: false, source_action: 'voice_agent', source_call_log_id: callId, ...ADDRESS,
    });
    await knex('triage_items').insert({
      call_log_id: callId, category: 'review', reason_code: 'outbound_booking_review', status: cardStatus,
      payload: JSON.stringify({ street_level_address: true, scheduled_service_id: visitId, ...(witness ? { approved_address: witness } : {}) }),
    });
    return { callId, visitId };
  }

  const { _test } = require('../services/outbound-review-confirm');
  const stamp = (visitId, bindAddress = true) => _test.stampCustomerConfirmed(knex, { id: visitId }, { bindAddress });
  const confirmed = async (visitId) => (await knex('scheduled_services').where({ id: visitId }).first('customer_confirmed')).customer_confirmed;

  test('the approved address is still the visit address: the stamp lands', async () => {
    const { visitId } = await seed();
    expect(await stamp(visitId)).toBe(1);
    expect(await confirmed(visitId)).toBe(true);
  });

  test('an address correction after the approval: nothing is stamped and the resolved hold card is reopened', async () => {
    const { visitId, callId } = await seed({ cardStatus: 'resolved' });
    await knex('scheduled_services').where({ id: visitId }).update({ service_address_line1: '1240 Sample Newbuild Trl' });
    expect(await stamp(visitId)).toBe(0);
    expect(await confirmed(visitId)).toBe(false);
    const card = await knex('triage_items').where({ call_log_id: callId }).first();
    expect(card.status).toBe('open');
  });

  test('an address write racing the stamp (row lock held) is serialized: the stamp sees it and refuses', async () => {
    const { visitId } = await seed();
    const writer = await knex.transaction();
    await writer('scheduled_services').where({ id: visitId }).forUpdate().first('id');
    // Start the stamp while the writer holds the row lock: it must wait behind it.
    let finished = false;
    const stamping = stamp(visitId).then((n) => { finished = true; return n; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    await writer('scheduled_services').where({ id: visitId }).update({ service_address_zip: '34203' });
    await writer.commit();
    expect(await stamping).toBe(0);
    expect(await confirmed(visitId)).toBe(false);
  });

  test('no witness, or not an office approval (bindAddress off: a technician confirmed on site), stamps as before', async () => {
    const noWitness = await seed({ witness: null });
    expect(await stamp(noWitness.visitId)).toBe(1);
    const onSite = await seed();
    await knex('scheduled_services').where({ id: onSite.visitId }).update({ service_address_line1: '1240 Sample Newbuild Trl' });
    expect(await stamp(onSite.visitId, false)).toBe(1);
  });

  test('a visit a rejection took (cancelled) is never stamped', async () => {
    const { visitId } = await seed();
    await knex('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
    expect(await stamp(visitId)).toBe(0);
  });
});
