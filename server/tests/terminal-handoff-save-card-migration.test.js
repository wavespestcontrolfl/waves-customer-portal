// The terminal_handoff_tokens save-card columns are additive, idempotent and
// reversible. A fake knex records the schema calls.
const migration = require('../models/migrations/20261102180000_terminal_handoff_save_card');

function fakeKnex(existingColumns = []) {
  const columns = new Set(existingColumns);
  const calls = [];
  const builder = () => {
    const chain = {};
    const rec = (name) => (...args) => { calls.push([name, ...args]); return chain; };
    ['notNullable', 'defaultTo', 'references', 'inTable', 'onDelete'].forEach((m) => { chain[m] = rec(m); });
    return chain;
  };
  const table = {
    string: (col, len) => { calls.push(['string', col, len]); columns.add(col); return builder(); },
    uuid: (col) => { calls.push(['uuid', col]); columns.add(col); return builder(); },
    dropForeign: (cols) => { calls.push(['dropForeign', cols]); },
    dropColumn: (col) => { calls.push(['dropColumn', col]); columns.delete(col); },
  };
  return {
    calls,
    columns,
    schema: {
      hasTable: async () => true,
      hasColumn: async (_t, col) => columns.has(col),
      alterTable: async (_t, cb) => { cb(table); },
    },
  };
}

describe('terminal_handoff_tokens save-card migration', () => {
  test('up adds the four columns, kind defaulting to collect', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect([...knex.columns].sort()).toEqual([
      'appointment_card_request_id', 'consent_text_version', 'kind', 'stripe_setup_intent_id',
    ]);
    expect(knex.calls).toEqual(expect.arrayContaining([
      ['string', 'kind', 16], ['defaultTo', 'collect'], ['notNullable'],
      ['inTable', 'appointment_card_requests'], ['onDelete', 'SET NULL'],
      ['string', 'stripe_setup_intent_id', 100], ['string', 'consent_text_version', 64],
    ]));
  });

  test('up is a no-op when the columns already exist', async () => {
    const knex = fakeKnex(['kind', 'appointment_card_request_id', 'stripe_setup_intent_id', 'consent_text_version']);
    await migration.up(knex);
    expect(knex.calls).toEqual([]);
  });

  test('down drops exactly what up added', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    await migration.down(knex);
    expect([...knex.columns]).toEqual([]);
    expect(knex.calls).toEqual(expect.arrayContaining([['dropForeign', ['appointment_card_request_id']]]));
  });
});
