/**
 * 20260924030100 — re-inserts the consultation-booking placeholders into
 * new_lead step 0 ONLY, after #4813's renderer is live (two-deploy staging).
 */
const migration = require('../models/migrations/20260924030100_new_lead_consultation_placeholder_reinsert');

function makeKnex(rows, { hasTable = true } = {}) {
  const updates = [];
  const filters = [];
  const knex = jest.fn((table) => {
    if (table !== 'automation_steps') throw new Error(`unexpected table ${table}`);
    let rowId;
    const q = {
      where: jest.fn((c) => { if (c.id !== undefined) rowId = c.id; else filters.push(c); return q; }),
      select: jest.fn(async () => rows),
      update: jest.fn(async (patch) => { updates.push({ rowId, patch }); return 1; }),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => hasTable), hasColumn: jest.fn(async () => true) };
  return { knex, updates, filters };
}

// The LIVE prod body shape (owner-edited phone), as read 2026-09-24.
const LIVE_HTML = "<h2>Hi {{first_name}} — thanks</h2>\n<h2>How we work</h2>\n<ul><li>x</li></ul>\n\n<h2>What's next</h2>\n<p>If you'd like a quote... <a href=\"tel:+19412975749\">(941) 297-5749</a>.</p>\n\n<p>— The Waves Pest Control team</p>";
const LIVE_TEXT = 'Hi {{first_name}} — thanks for your interest in Waves. Reply with your address and a good time, or call (941) 297-5749. — The Waves Pest Control team';

describe('new_lead consultation placeholder re-insert migration', () => {
  test('targets step 0 only', async () => {
    const { knex, filters } = makeKnex([]);
    await migration.up(knex);
    expect(filters).toEqual([{ template_key: 'new_lead', step_order: 0 }]);
  });

  test('inserts both placeholders right before their anchors in the live body', async () => {
    const { knex, updates } = makeKnex([{ id: 's0', html_body: LIVE_HTML, text_body: LIVE_TEXT }]);
    await migration.up(knex);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.html_body).toContain("{{consultation_booking}}\n<h2>What's next</h2>");
    expect(updates[0].patch.text_body).toContain('{{consultation_booking_text}}\nReply with your address');
    // Nothing else changed — the owner-edited phone survives.
    expect(updates[0].patch.html_body.replace("{{consultation_booking}}\n", '')).toBe(LIVE_HTML);
    expect(updates[0].patch.html_body).toContain('297-5749');
    expect(updates[0].patch.updated_at).toBeInstanceOf(Date);
  });

  test('idempotent — placeholder already present (spaced or not) → untouched', async () => {
    const { knex, updates } = makeKnex([{
      id: 's0',
      html_body: LIVE_HTML.replace("<h2>What's next</h2>", "{{ consultation_booking }}\n<h2>What's next</h2>"),
      text_body: LIVE_TEXT.replace('Reply with your address', '{{consultation_booking_text}}\nReply with your address'),
    }]);
    await migration.up(knex);
    expect(updates).toEqual([]);
  });

  test('falls back to the sign-off when the anchor is missing; untouched when both are', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { knex, updates } = makeKnex([
      { id: 'a', html_body: '<p>edited</p>\n<p>— The Waves Pest Control team</p>', text_body: 'edited — The Waves Pest Control team' },
      { id: 'b', html_body: '<p>totally rewritten</p>', text_body: 'totally rewritten' },
    ]);
    await migration.up(knex);
    expect(updates).toHaveLength(1);
    expect(updates[0].rowId).toBe('a');
    expect(updates[0].patch.html_body).toBe('<p>edited</p>\n{{consultation_booking}}\n<p>— The Waves Pest Control team</p>');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('no table → no-op; down is a no-op', async () => {
    const { knex, updates } = makeKnex([{ id: 's0', html_body: LIVE_HTML, text_body: LIVE_TEXT }], { hasTable: false });
    await migration.up(knex);
    expect(updates).toEqual([]);
    await expect(migration.down()).resolves.toBeUndefined();
  });

  test('orders after the 020400 hold by filename', () => {
    const fs = require('fs');
    const path = require('path');
    const names = fs.readdirSync(path.join(__dirname, '../models/migrations')).filter((n) => n.includes('consultation_placeholder')).sort();
    expect(names.indexOf('20260924030100_new_lead_consultation_placeholder_reinsert.js')).toBeGreaterThan(names.indexOf('20260924020400_new_lead_consultation_placeholder_hold.js'));
  });
});
