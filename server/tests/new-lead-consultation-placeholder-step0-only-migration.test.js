/**
 * 20260924020001 — narrows 20260924020000's over-broad patch: the
 * consultation-booking placeholders may live on new_lead step 0 ONLY.
 */
const migration = require('../models/migrations/20260924020001_new_lead_consultation_placeholder_step0_only');

function makeKnex(rows, { hasTable = true } = {}) {
  const updates = [];
  const filters = [];
  const knex = jest.fn((table) => {
    if (table !== 'automation_steps') throw new Error(`unexpected table ${table}`);
    let rowId;
    const q = {
      where: jest.fn((criteria) => {
        if (criteria.id !== undefined) rowId = criteria.id;
        else filters.push(['where', criteria]);
        return q;
      }),
      whereNot: jest.fn((criteria) => { filters.push(['whereNot', criteria]); return q; }),
      select: jest.fn(async () => rows),
      update: jest.fn(async (patch) => { updates.push({ rowId, patch }); return 1; }),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => hasTable), hasColumn: jest.fn(async () => true) };
  return { knex, updates, filters };
}

const HTML = '<h2>Hi</h2>\n{{consultation_booking}}\n<h2>What\'s next</h2>\n<p>— The Waves Pest Control team</p>';
const TEXT = 'Hi. {{consultation_booking_text}}\nReply with your address. — The Waves Pest Control team';

describe('new_lead consultation placeholder step-0-only migration', () => {
  test('queries new_lead rows other than step 0 only', async () => {
    const { knex, filters } = makeKnex([]);
    await migration.up(knex);
    expect(filters).toEqual([
      ['where', { template_key: 'new_lead' }],
      ['whereNot', { step_order: 0 }],
    ]);
  });

  test('strips both placeholders (and the inserted newline) from a later step', async () => {
    const { knex, updates } = makeKnex([{ id: 's1', html_body: HTML, text_body: TEXT }]);
    await migration.up(knex);
    expect(updates).toHaveLength(1);
    expect(updates[0].rowId).toBe('s1');
    expect(updates[0].patch.html_body).toBe('<h2>Hi</h2>\n<h2>What\'s next</h2>\n<p>— The Waves Pest Control team</p>');
    expect(updates[0].patch.text_body).toBe('Hi. Reply with your address. — The Waves Pest Control team');
    expect(updates[0].patch.html_body).not.toContain('{{consultation_booking');
    expect(updates[0].patch.text_body).not.toContain('{{consultation_booking');
    expect(updates[0].patch.updated_at).toBeInstanceOf(Date);
  });

  test('idempotent — a later step without placeholders is left untouched', async () => {
    const { knex, updates } = makeKnex([{ id: 's1', html_body: '<p>plain</p>', text_body: 'plain' }]);
    await migration.up(knex);
    expect(updates).toEqual([]);
  });

  test('no automation_steps table → no-op', async () => {
    const { knex, updates } = makeKnex([{ id: 's1', html_body: HTML, text_body: TEXT }], { hasTable: false });
    await migration.up(knex);
    expect(updates).toEqual([]);
  });

  test('down is a no-op', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
