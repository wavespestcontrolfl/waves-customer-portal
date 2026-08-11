/**
 * 20260811000011 — dry-state re-entry wording on the seeded new_appointment
 * automation step (codex P1 on PR #3360): the fixed "~1 hour" / "~30
 * minutes" figures must become dry-state + technician-confirmed wording,
 * exact-sentence-match only (admin-edited copy is left alone).
 */
const migration = require('../models/migrations/20260811000011_dry_state_reentry_wording_new_appointment');

const HTML_OLD = '<p>Wait about an hour after interior treatment before walking barefoot or letting pets back in. For exterior work, you can resume normal activity as soon as the product has dried (usually within 30 minutes).</p>';
const TEXT_OLD = 'After: wait ~1 hour before walking barefoot indoors or letting pets back in; exterior dries in ~30 minutes.';

const SEEDED_HTML_SENTENCE = require('fs')
  .readFileSync(require('path').join(__dirname, '../models/migrations/20260424000007_seed_automation_default_steps.js'), 'utf8');

function makeKnex(rows, { hasUpdatedAt = true } = {}) {
  const updates = [];
  const knex = jest.fn((table) => {
    if (table !== 'automation_steps') throw new Error(`unexpected table ${table}`);
    let rowId;
    const q = {
      where: jest.fn((criteria) => {
        if (criteria.id !== undefined) rowId = criteria.id;
        return q;
      }),
      select: jest.fn(async () => rows),
      update: jest.fn(async (patch) => { updates.push({ rowId, patch }); return 1; }),
    };
    return q;
  });
  knex.schema = {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async () => hasUpdatedAt),
  };
  return { knex, updates };
}

describe('dry-state re-entry wording migration', () => {
  test('the swap sources match the 20260424000007 seed verbatim', () => {
    // If the seed text ever drifts, the swap silently no-ops — pin the
    // coupling so that reads as a test failure instead.
    expect(SEEDED_HTML_SENTENCE).toContain(HTML_OLD);
    expect(SEEDED_HTML_SENTENCE).toContain(TEXT_OLD.replace(/'/g, "\\'"));
  });

  test('rewrites both bodies and strips every fixed minute figure', async () => {
    const { knex, updates } = makeKnex([
      { id: 7, html_body: `<h2>Hi</h2>\n${HTML_OLD}\nrest`, text_body: `intro. ${TEXT_OLD} — team` },
    ]);

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    const { patch } = updates[0];
    expect(patch.html_body).not.toContain('about an hour');
    expect(patch.html_body).not.toContain('within 30 minutes');
    expect(patch.text_body).not.toContain('~1 hour');
    expect(patch.text_body).not.toContain('~30 minutes');
    // Compliance idiom: dry-state + technician confirms, no fixed figure.
    expect(patch.html_body).toMatch(/until they are dry/);
    expect(patch.html_body).toMatch(/technician will confirm timing/);
    expect(patch.text_body).toMatch(/until they are dry/);
    expect(patch.html_body).not.toMatch(/\bsafe\b/i);
    expect(patch.text_body).not.toMatch(/\bsafe\b/i);
    // Surrounding admin-visible copy is preserved.
    expect(patch.html_body).toContain('<h2>Hi</h2>');
    expect(patch.text_body).toContain('intro.');
    expect(patch.updated_at).toBeInstanceOf(Date);
  });

  test('leaves admin-edited copy alone (exact sentence match only)', async () => {
    const { knex, updates } = makeKnex([
      { id: 8, html_body: '<p>Custom rewritten guidance.</p>', text_body: 'Custom text.' },
    ]);

    await migration.up(knex);

    expect(updates).toHaveLength(0);
  });

  test('down restores the original sentences', async () => {
    const { knex: upKnex, updates: upUpdates } = makeKnex([
      { id: 9, html_body: HTML_OLD, text_body: TEXT_OLD },
    ]);
    await migration.up(upKnex);
    const rewritten = upUpdates[0].patch;

    const { knex: downKnex, updates: downUpdates } = makeKnex([
      { id: 9, html_body: rewritten.html_body, text_body: rewritten.text_body },
    ]);
    await migration.down(downKnex);

    expect(downUpdates[0].patch.html_body).toBe(HTML_OLD);
    expect(downUpdates[0].patch.text_body).toBe(TEXT_OLD);
  });

  test('no-ops when automation_steps is absent', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });
});
