/**
 * 20260924020400 — strips the consultation placeholders 020000 wrote, in the
 * same pre-deploy step, so an old serving instance can never email them
 * literally (Codex #4813 r4 P1). Re-insert ships after this renderer deploys.
 */
const migration = require('../models/migrations/20260924020400_new_lead_consultation_placeholder_hold');

function makeKnex(rows, { hasTable = true } = {}) {
  const updates = [];
  const knex = jest.fn((table) => {
    if (table !== 'automation_steps') throw new Error(`unexpected table ${table}`);
    let rowId;
    const q = {
      where: jest.fn((c) => { if (c.id !== undefined) rowId = c.id; return q; }),
      select: jest.fn(async () => rows),
      update: jest.fn(async (patch) => { updates.push({ rowId, patch }); return 1; }),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => hasTable), hasColumn: jest.fn(async () => true) };
  return { knex, updates };
}

const SEEDED_HTML = "<h2>Hi</h2>\n<h2>What's next</h2>\n<p>— The Waves Pest Control team</p>";
const SEEDED_TEXT = 'Hi. Reply with your address. — The Waves Pest Control team';
const PATCHED_HTML = "<h2>Hi</h2>\n{{consultation_booking}}\n<h2>What's next</h2>\n<p>— The Waves Pest Control team</p>";
const PATCHED_TEXT = 'Hi. {{consultation_booking_text}}\nReply with your address. — The Waves Pest Control team';

describe('new_lead consultation placeholder hold migration', () => {
  test('restores exactly what 020000 patched, on every new_lead step', async () => {
    const { knex, updates } = makeKnex([
      { id: 's0', html_body: PATCHED_HTML, text_body: PATCHED_TEXT },
      { id: 's1', html_body: '<p>drip</p>\n{{ consultation_booking }}\n<p>bye</p>', text_body: 'drip {{ consultation_booking_text }}\nbye' },
    ]);
    await migration.up(knex);
    expect(updates).toHaveLength(2);
    expect(updates[0].patch.html_body).toBe(SEEDED_HTML);
    expect(updates[0].patch.text_body).toBe(SEEDED_TEXT);
    expect(updates[1].patch.html_body).toBe('<p>drip</p>\n<p>bye</p>');
    expect(updates[1].patch.text_body).toBe('drip bye');
  });

  test('idempotent — a step without placeholders is untouched', async () => {
    const { knex, updates } = makeKnex([{ id: 's0', html_body: SEEDED_HTML, text_body: SEEDED_TEXT }]);
    await migration.up(knex);
    expect(updates).toEqual([]);
  });

  test('no table → no-op; down is a no-op', async () => {
    const { knex, updates } = makeKnex([{ id: 's0', html_body: PATCHED_HTML, text_body: PATCHED_TEXT }], { hasTable: false });
    await migration.up(knex);
    expect(updates).toEqual([]);
    await expect(migration.down()).resolves.toBeUndefined();
  });

  test('orders after 020000 and 020001 by filename', () => {
    const fs = require('fs');
    const path = require('path');
    const names = fs.readdirSync(path.join(__dirname, '../models/migrations')).filter((n) => n.includes('consultation')).sort();
    const hold = names.indexOf('20260924020400_new_lead_consultation_placeholder_hold.js');
    expect(hold).toBeGreaterThan(names.indexOf('20260924020000_new_lead_consultation_booking_placeholder.js'));
    expect(hold).toBeGreaterThan(names.indexOf('20260924020001_new_lead_consultation_placeholder_step0_only.js'));
  });
});
