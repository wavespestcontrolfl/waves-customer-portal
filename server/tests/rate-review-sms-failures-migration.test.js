/** 20261003130000: an additive, idempotent table keyed by the message sid; down() drops it. */
const migration = require('../models/migrations/20261003130000_rate_review_sms_failures');

function fakeKnex({ exists = false } = {}) {
  const calls = [];
  const t = { string: jest.fn(() => ({ primary: jest.fn(), notNullable: jest.fn(() => ({ defaultTo: jest.fn() })) })), timestamp: jest.fn(() => ({ notNullable: jest.fn(() => ({ defaultTo: jest.fn() })) })) };
  const knex = { fn: { now: () => 'now()' }, schema: {
    hasTable: jest.fn(async () => exists),
    createTable: jest.fn(async (name, cb) => { calls.push(['create', name]); cb(t); }),
    dropTableIfExists: jest.fn(async (name) => { calls.push(['drop', name]); }),
  } };
  return { knex, calls, t };
}

test('up creates the table keyed by twilio_sid; a second run is a no-op; down drops it', async () => {
  const a = fakeKnex();
  await migration.up(a.knex);
  expect(a.calls).toEqual([['create', 'rate_review_sms_failures']]);
  expect(a.t.string).toHaveBeenCalledWith('twilio_sid', 50);
  const b = fakeKnex({ exists: true });
  await migration.up(b.knex);
  expect(b.calls).toEqual([]);
  await migration.down(a.knex);
  expect(a.calls.at(-1)).toEqual(['drop', 'rate_review_sms_failures']);
});
