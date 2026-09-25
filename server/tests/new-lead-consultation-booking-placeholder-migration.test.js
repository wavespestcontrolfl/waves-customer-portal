/**
 * 20260924020000 — consultation-booking placeholder on the LIVE new_lead
 * automation step (lead-inspection-link-scope.md §2 "PR 3 / Email block").
 * Anchor-based insert (never an exact-body match — the live row is
 * owner-edited), idempotent, no-op-safe when an anchor is missing.
 */
const migration = require('../models/migrations/20260924020000_new_lead_consultation_booking_placeholder');

const SEEDED_HTML = require('fs')
  .readFileSync(require('path').join(__dirname, '../models/migrations/20260424000007_seed_automation_default_steps.js'), 'utf8');

function makeKnex(rows, { hasUpdatedAt = true, hasTable = true } = {}) {
  const updates = [];
  const selects = [];
  const knex = jest.fn((table) => {
    if (table !== 'automation_steps') throw new Error(`unexpected table ${table}`);
    let rowId;
    const q = {
      where: jest.fn((criteria) => {
        if (criteria.id !== undefined) rowId = criteria.id;
        else selects.push(criteria);
        return q;
      }),
      select: jest.fn(async () => rows),
      update: jest.fn(async (patch) => { updates.push({ rowId, patch }); return 1; }),
    };
    return q;
  });
  knex.schema = {
    hasTable: jest.fn(async () => hasTable),
    hasColumn: jest.fn(async () => hasUpdatedAt),
  };
  return { knex, updates, selects };
}

describe('new_lead consultation-booking placeholder migration', () => {
  test('the seed still carries both anchors — pins the coupling so drift is a loud test failure', () => {
    expect(SEEDED_HTML).toContain("<h2>What's next</h2>");
    expect(SEEDED_HTML).toContain('Reply with your address');
  });

  test('selects every new_lead step (frozen scope — 20260924020001 narrows it to step 0)', async () => {
    const { knex, selects } = makeKnex([]);
    await migration.up(knex);
    expect(selects).toEqual([{ template_key: 'new_lead' }]);
  });

  test('inserts both placeholders right before their anchors', async () => {
    const html = "<h2>Hi {{first_name}}</h2>\n<h2>What's next</h2>\n<p>Reply to this email.</p>\n<p>— The Waves Pest Control team</p>";
    const text = 'Hi {{first_name}}. Reply with your address and a good time. — The Waves Pest Control team';
    const { knex, updates } = makeKnex([{ id: 5, html_body: html, text_body: text }]);

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    const { patch } = updates[0];
    expect(patch.html_body).toContain("{{consultation_booking}}\n<h2>What's next</h2>");
    expect(patch.text_body).toContain('{{consultation_booking_text}}\nReply with your address');
    // Nothing else in either body moved.
    expect(patch.html_body).toContain('<h2>Hi {{first_name}}</h2>');
    expect(patch.text_body).toContain('Hi {{first_name}}.');
    expect(patch.updated_at).toBeInstanceOf(Date);
  });

  test('matches the LIVE (owner-edited) body, not just the pristine seed — anchor-based, not sentence-exact', async () => {
    // A body that has drifted from the seed (different phone, extra
    // paragraph) but still carries both anchors patches fine.
    const html = "<h2>Hi Bob</h2><p>Give us a call at (941) 297-5749.</p><h2>What's next</h2><p>Reply.</p>";
    const text = 'Hi Bob. Call us at (941) 297-5749. Reply with your address whenever works.';
    const { knex, updates } = makeKnex([{ id: 9, html_body: html, text_body: text }]);

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    expect(updates[0].patch.html_body).toContain('{{consultation_booking}}');
    expect(updates[0].patch.html_body).toContain('297-5749');
    expect(updates[0].patch.text_body).toContain('{{consultation_booking_text}}');
  });

  test('idempotent — a body that already has the placeholder is left untouched', async () => {
    const html = "<h2>Hi</h2>\n{{consultation_booking}}\n<h2>What's next</h2>";
    const text = 'Hi. {{consultation_booking_text}} Reply with your address.';
    const { knex, updates } = makeKnex([{ id: 3, html_body: html, text_body: text }]);

    await migration.up(knex);

    expect(updates).toHaveLength(0);
  });

  test('falls back to the sign-off line when the primary anchor is missing', async () => {
    const html = '<h2>Hi</h2><p>No what\'s-next heading here.</p><p>— The Waves Pest Control team</p>';
    const text = 'Hi. No reply-with-address sentence here. — The Waves Pest Control team';
    const { knex, updates } = makeKnex([{ id: 4, html_body: html, text_body: text }]);

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    expect(updates[0].patch.html_body).toContain('{{consultation_booking}}\n<p>— The Waves Pest Control team</p>');
    expect(updates[0].patch.text_body).toContain('{{consultation_booking_text}}\n— The Waves Pest Control team');
  });

  test('no-ops (and warns) when neither anchor nor sign-off is found', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const html = '<p>Totally custom rewritten copy.</p>';
    const text = 'Totally custom rewritten copy.';
    const { knex, updates } = makeKnex([{ id: 7, html_body: html, text_body: text }]);

    await migration.up(knex);

    expect(updates).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('no-ops when automation_steps is absent', async () => {
    const { knex } = makeKnex([], { hasTable: false });
    await migration.up(knex);
    expect(knex).not.toHaveBeenCalled();
  });

  test('down() is a documented no-op — never touches any row', async () => {
    const { knex, updates } = makeKnex([{ id: 1, html_body: 'x', text_body: 'y' }]);
    await migration.down(knex);
    expect(updates).toHaveLength(0);
    expect(knex).not.toHaveBeenCalled();
  });
});
