/**
 * 20260928050000_call_text_wording_any_hour — the copy update that rides
 * along with dropping the after-hours defer on the missed-call and
 * voicemail text-backs (owner ruling 2026-09-28). Pins:
 *  - up() rewrites both seeded bodies to add the "Someone from the Waves
 *    team will follow up as soon as possible" reassurance;
 *  - missed_call_text_back keeps {callback_clause} required and its exact
 *    "call back anytime{callback_clause}" shape;
 *  - voicemail_quote_link keeps its existing message and link untouched
 *    (only the reassurance is inserted);
 *  - an admin-edited body is preserved (CAS on the seeded body, same
 *    contract as 20260811000010 / 20260717090000);
 *  - down() restores the prior bodies verbatim.
 */
const migration = require('../models/migrations/20260928050000_call_text_wording_any_hour');
const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');

const { _SWAPS: SWAPS } = migration;
const byKey = Object.fromEntries(SWAPS.map(([key, expect_, set]) => [key, { expect: expect_, set }]));

function createKnex(rowsByKey) {
  // rowsByKey: { template_key: { id, body } }
  const state = { rows: rowsByKey, updates: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    let criteria = null;
    const q = {
      where(c) { criteria = c; return q; },
      async first() {
        if (criteria.template_key) {
          const row = state.rows[criteria.template_key];
          return row ? { ...row } : undefined;
        }
        const row = Object.values(state.rows).find((r) => r.id === criteria.id);
        if (!row) return undefined;
        if ('body' in criteria && row.body !== criteria.body) return undefined;
        return { ...row };
      },
      async update(patch) {
        const row = Object.values(state.rows).find((r) => r.id === criteria.id);
        if (!row || row.body !== criteria.body) return 0;
        Object.assign(row, patch);
        state.updates.push({ id: criteria.id, patch });
        return 1;
      },
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.__state = state;
  return knex;
}

const seededRows = () => Object.fromEntries(SWAPS.map(([key, expect_], i) => [
  key,
  { id: `row-${i}`, body: expect_ },
]));

test('up() rewrites both seeded bodies', async () => {
  const knex = createKnex(seededRows());
  await migration.up(knex);
  for (const [key, , set] of SWAPS) {
    expect(knex.__state.rows[key].body).toBe(set);
  }
  expect(knex.__state.updates).toHaveLength(2);
});

test('missed_call_text_back: keeps {callback_clause} required and the exact "call back anytime" ending, with the new reassurance leading', () => {
  const { set } = byKey.missed_call_text_back;
  expect(REQUIRED_TEMPLATE_PLACEHOLDERS.missed_call_text_back).toEqual(['callback_clause']);
  expect(set).toContain('{callback_clause}');
  expect(set).toContain('Someone from the Waves team will follow up as soon as possible');
  expect(set).not.toMatch(/reply stop/i);
  expect(set).not.toMatch(/Waves Pest Control/i);

  // Renders naturally with and without a known dialed line (callbackClause()
  // in missed-call-text-back.js — '' or ' at (941) 297-5749').
  expect(set.replace('{callback_clause}', ''))
    .toBe("Hi there, it's Waves. Sorry we missed your call. Someone from the Waves team will follow up as soon as possible, or text us here with what you need, or call back anytime.");
  expect(set.replace('{callback_clause}', ' at (941) 297-5749'))
    .toBe("Hi there, it's Waves. Sorry we missed your call. Someone from the Waves team will follow up as soon as possible, or text us here with what you need, or call back anytime at (941) 297-5749.");
});

test('voicemail_quote_link: keeps the existing message and link untouched, only adds the reassurance', () => {
  const { set } = byKey.voicemail_quote_link;
  expect(set).toBe(
    "Hello {first_name}, it's Waves Pest Control. We got your message about {service_label}, and your quote is here: {quote_url}\n\n"
    + "Someone from the Waves team will follow up as soon as possible. Or reply and we'll call you back.\n\n"
    + 'Reply STOP to opt out.',
  );
  // Every token from the prior body is still present, unchanged.
  expect(set).toContain("Hello {first_name}, it's Waves Pest Control.");
  expect(set).toContain('{service_label}');
  expect(set).toContain('your quote is here: {quote_url}');
  expect(set).toContain("Or reply and we'll call you back.");
  expect(set).toContain('Reply STOP to opt out.');
});

test('admin-edited body is preserved — CAS on the seeded body', async () => {
  const rows = seededRows();
  rows.missed_call_text_back.body = 'Custom copy Adam wrote in the admin UI {callback_clause}.';
  const knex = createKnex(rows);
  await migration.up(knex);

  expect(knex.__state.rows.missed_call_text_back.body).toBe('Custom copy Adam wrote in the admin UI {callback_clause}.');
  // The other, untouched by the admin, still migrates.
  expect(knex.__state.updates.map((u) => u.id)).toEqual([rows.voicemail_quote_link.id]);
});

test('down() restores the prior bodies verbatim', async () => {
  const knex = createKnex(seededRows());
  await migration.up(knex);
  await migration.down(knex);
  for (const [key, expect_] of SWAPS) {
    expect(knex.__state.rows[key].body).toBe(expect_);
  }
});

test('down() leaves an admin edit made after up() alone', async () => {
  const knex = createKnex(seededRows());
  await migration.up(knex);
  knex.__state.rows.voicemail_quote_link.body = 'Adam rewrote this after the migration ran.';
  await migration.down(knex);
  expect(knex.__state.rows.voicemail_quote_link.body).toBe('Adam rewrote this after the migration ran.');
  // The other row, untouched since up(), still reverts.
  expect(knex.__state.rows.missed_call_text_back.body).toBe(byKey.missed_call_text_back.expect);
});

test('missing table is a no-op in both directions', async () => {
  const knex = createKnex(seededRows());
  knex.schema.hasTable.mockResolvedValue(false);
  await migration.up(knex);
  await migration.down(knex);
  expect(knex.__state.updates).toHaveLength(0);
});
