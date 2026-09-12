/**
 * The address_recovered card's pass marker, round-tripped against real jsonb.
 *
 * The two branches of recoveryMarkerPayload are mirror images and each must
 * clear the other's keys. That contract has now been wrong in BOTH directions
 * on PR #4437: first a failed pass left the provenance stamps in place, then a
 * successful pass left `recovery_superseded_at` behind — which made the
 * success -> failure -> success sequence reject the current recovery forever
 * and kept the booking banner on the stale validation failure.
 *
 * Postgres is the only place `-` and `||` on jsonb actually mean anything, so
 * this exercises the real expressions against a real column.
 */

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const { recoveryMarkerPayload } = require('../services/call-recording-processor');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('recovery marker reconcile on PostgreSQL', () => {
  const schema = `recovery_marker_${randomUUID().replaceAll('-', '')}`;
  const STAMP = { extraction_model: 'gpt-5.6-sol', extraction_prompt_version: 'v6-abc' };
  let database;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.cards (id uuid PRIMARY KEY, payload jsonb)', [schema]);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });

  const card = async (payload) => {
    const id = randomUUID();
    await database('cards').insert({ id, payload: payload === null ? null : JSON.stringify(payload) });
    return id;
  };
  const reconcile = async (id, passStamp) => {
    await database('cards').where({ id }).update({ payload: recoveryMarkerPayload(database, passStamp) });
    return (await database('cards').where({ id }).first('payload')).payload;
  };

  test('a recovering pass stamps its provenance', async () => {
    const id = await card({ address_as_heard: '100 Port Ave East' });

    expect(await reconcile(id, STAMP)).toMatchObject({ ...STAMP, address_as_heard: '100 Port Ave East' });
  });

  test('a pass that did not recover strips the provenance and records the supersede', async () => {
    const id = await card({ ...STAMP, address_as_heard: '100 Port Ave East' });
    const after = await reconcile(id, null);

    expect(after.extraction_model).toBeUndefined();
    expect(after.extraction_prompt_version).toBeUndefined();
    expect(typeof after.recovery_superseded_at).toBe('string');
    // Operator-facing evidence is never collateral damage.
    expect(after.address_as_heard).toBe('100 Port Ave East');
  });

  // The regression: recovering AGAIN must clear the failed pass's marker, or
  // the card reads as superseded forever.
  test('success -> failure -> success leaves a live, fully stamped card', async () => {
    const id = await card({ address_as_heard: '100 Port Ave East' });

    await reconcile(id, STAMP);
    const failed = await reconcile(id, null);
    expect(failed.recovery_superseded_at).toBeDefined();

    const recovered = await reconcile(id, STAMP);
    expect(recovered.recovery_superseded_at).toBeUndefined();
    expect(recovered).toMatchObject(STAMP);
  });

  test('a null payload reconciles instead of throwing', async () => {
    const id = await card(null);

    expect(await reconcile(id, STAMP)).toMatchObject(STAMP);
  });
});
