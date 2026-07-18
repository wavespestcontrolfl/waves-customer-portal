/**
 * 20260714100001 — re-entry language compliance on prep.termite and
 * prep.bed_bug: "…until the technician confirms it is safe to return" must
 * become "…until the technician says they are ready" on the ACTIVE version,
 * exact-match only (admin-edited copy is left alone).
 */
const migration = require('../models/migrations/20260714100001_prep_reentry_language_compliance');

const BED_BUG_OLD = 'Secure pets and plan to keep people and animals out of treated areas until the technician confirms it is safe to return.';
const BED_BUG_NEW = 'Secure pets and plan to keep people and animals out of treated areas until the technician says they are ready.';
const TERMITE_OLD = 'Keep people and pets away from active treatment areas until the technician confirms it is safe to return.';
const TERMITE_NEW = 'Keep people and pets away from active treatment areas until the technician says they are ready.';

function makeKnex({ templates, versions }) {
  const updates = [];
  const knex = jest.fn((table) => {
    if (table === 'email_templates') {
      const q = {
        where: jest.fn(({ template_key: key }) => ({
          first: jest.fn(async () => templates[key] || null),
        })),
      };
      return q;
    }
    if (table === 'email_template_versions') {
      let versionId;
      const q = {
        where: jest.fn(({ id }) => { versionId = id; return q; }),
        first: jest.fn(async () => versions[versionId] || null),
        update: jest.fn(async (patch) => { updates.push({ versionId, patch }); return 1; }),
      };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  return { knex, updates };
}

describe('prep re-entry language compliance migration', () => {
  test('rewrites the exact shipped copy on both active versions', async () => {
    const { knex, updates } = makeKnex({
      templates: {
        'prep.bed_bug': { id: 't-bb', active_version_id: 'v-bb' },
        'prep.termite': { id: 't-tm', active_version_id: 'v-tm' },
      },
      versions: {
        'v-bb': { id: 'v-bb', blocks: JSON.stringify([{ type: 'paragraph', content: BED_BUG_OLD }]) },
        'v-tm': { id: 'v-tm', blocks: JSON.stringify([{ type: 'paragraph', content: TERMITE_OLD }]) },
      },
    });

    await migration.up(knex);

    expect(updates).toHaveLength(2);
    const [bb, tm] = updates;
    expect(JSON.parse(bb.patch.blocks)[0].content).toBe(BED_BUG_NEW);
    expect(JSON.parse(tm.patch.blocks)[0].content).toBe(TERMITE_NEW);
    expect(JSON.parse(bb.patch.blocks)[0].content).not.toMatch(/\bsafe\b/i);
    expect(JSON.parse(tm.patch.blocks)[0].content).not.toMatch(/\bsafe\b/i);
  });

  test('leaves admin-edited copy alone (exact match only)', async () => {
    const edited = 'Keep pets away until we tell you otherwise.';
    const { knex, updates } = makeKnex({
      templates: { 'prep.termite': { id: 't-tm', active_version_id: 'v-tm' } },
      versions: { 'v-tm': { id: 'v-tm', blocks: JSON.stringify([{ type: 'paragraph', content: edited }]) } },
    });

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].patch.blocks)[0].content).toBe(edited);
  });

  test('down restores the original copy', async () => {
    const { knex, updates } = makeKnex({
      templates: { 'prep.bed_bug': { id: 't-bb', active_version_id: 'v-bb' } },
      versions: { 'v-bb': { id: 'v-bb', blocks: JSON.stringify([{ type: 'paragraph', content: BED_BUG_NEW }]) } },
    });

    await migration.down(knex);

    expect(JSON.parse(updates[0].patch.blocks)[0].content).toBe(BED_BUG_OLD);
  });

  test('no-ops when the template tables are absent', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };

    await migration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });
});
