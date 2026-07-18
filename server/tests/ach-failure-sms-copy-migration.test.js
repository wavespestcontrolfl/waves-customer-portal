/**
 * 20260717090000_align_ach_failure_sms_copy — the ACH failure SMS bodies
 * must describe what the failure handlers actually do at each escalation
 * step. Pins:
 *  - up() rewrites all three seeded bodies and adds {billing_url} to the
 *    two notices that lacked an actionable link;
 *  - the new copy no longer promises an unconditional "retry in 3 business
 *    days" or a 2nd-failure card switch (which happens at 3, not 2);
 *  - admin-edited rows are preserved (update keys on the seeded body);
 *  - is_active is never touched;
 *  - down() restores the prior bodies verbatim.
 */
const migration = require('../models/migrations/20260717090000_align_ach_failure_sms_copy');

const { TEMPLATES } = migration;

function createKnex(rowsByKey) {
  const state = { rows: rowsByKey, updates: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const q = {
      criteria: null,
      where(criteria) { q.criteria = criteria; return q; },
      async update(patch) {
        const row = state.rows[q.criteria.template_key];
        if (!row || row.body !== q.criteria.body) return 0;
        Object.assign(row, patch);
        state.updates.push({ key: q.criteria.template_key, patch });
        return 1;
      },
      columnInfo: async () => ({
        template_key: {}, name: {}, category: {}, body: {},
        variables: {}, is_active: {}, sort_order: {}, updated_at: {},
      }),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.__state = state;
  return knex;
}

const seededRows = () => Object.fromEntries(TEMPLATES.map((t) => [
  t.template_key,
  {
    template_key: t.template_key,
    body: t.old_body,
    variables: JSON.stringify(t.old_variables),
    is_active: true,
  },
]));

test('up() rewrites all three ACH failure bodies and their variables', async () => {
  const knex = createKnex(seededRows());
  await migration.up(knex);

  for (const t of TEMPLATES) {
    const row = knex.__state.rows[t.template_key];
    expect(row.body).toBe(t.new_body);
    expect(JSON.parse(row.variables)).toEqual(t.new_variables);
    // Active flag is the operator pause switch — never touched here.
    expect(row.is_active).toBe(true);
  }
  expect(knex.__state.updates).toHaveLength(TEMPLATES.length);
});

test('new copy matches the handlers: no unconditional retry promise, no 2nd-failure switch claim', () => {
  const byKey = Object.fromEntries(TEMPLATES.map((t) => [t.template_key, t]));

  // 1st failure: the monthly autopay lane now genuinely re-attempts via the
  // retry sweep; the invoice/pay-page lane does not — copy must be true for
  // both and carry a self-service link.
  expect(byKey.ach_retry_notice.new_body).not.toContain('3 business days');
  expect(byKey.ach_retry_notice.new_body).toContain('{billing_url}');

  // 2nd failure: no switch happens at this stage (it happens at 3) — the
  // notice must ask for action, not claim a card switch.
  expect(byKey.ach_card_fallback.new_body).not.toContain('switched this payment to your card');
  expect(byKey.ach_card_fallback.new_body).toContain('{billing_url}');

  // 3rd failure: the card-default flip only happens when a card exists —
  // the claim is conditioned accordingly.
  expect(byKey.ach_suspended.new_body).toContain('If you have a card on file');
});

test('admin-edited body is preserved — update keys on the seeded body', async () => {
  const rows = seededRows();
  rows.ach_retry_notice.body = 'Custom copy Adam wrote in the admin UI.';
  const knex = createKnex(rows);
  await migration.up(knex);

  expect(knex.__state.rows.ach_retry_notice.body).toBe('Custom copy Adam wrote in the admin UI.');
  // The other two, untouched by the admin, still migrate.
  expect(knex.__state.updates.map((u) => u.key).sort()).toEqual(['ach_card_fallback', 'ach_suspended']);
});

test('down() restores the prior bodies and variables verbatim', async () => {
  const knex = createKnex(seededRows());
  await migration.up(knex);
  await migration.down(knex);

  for (const t of TEMPLATES) {
    const row = knex.__state.rows[t.template_key];
    expect(row.body).toBe(t.old_body);
    expect(JSON.parse(row.variables)).toEqual(t.old_variables);
  }
});

test('missing table is a no-op in both directions', async () => {
  const knex = createKnex(seededRows());
  knex.schema.hasTable.mockResolvedValue(false);
  await migration.up(knex);
  await migration.down(knex);
  expect(knex.__state.updates).toHaveLength(0);
});
