/**
 * 20260930120000 — prep.lawn guide revision.
 *
 * Guards what must never regress in prep copy (same rules as the 2026-07-15
 * refresh test): no "safe"/"safely", no fixed re-entry windows, brand is
 * "Waves", no "per visit", "EPA-registered" wherever products are described.
 * Plus the publish mechanics: new active version, prior archived, pointer
 * flipped, marker-guarded down().
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const base = require('../models/migrations/20260930120000_prep_lawn_guide_revision');
const r1 = require('../models/migrations/20260930120001_prep_lawn_guide_revision_codex_r1');
// 000002 supersedes 000001 supersedes 000000; its TEMPLATES are what customers receive.
const migration = require('../models/migrations/20260930120002_prep_lawn_guide_revision_r2');
const { normalizeBlocks } = require('../services/email-template-library');

const { TEMPLATES } = migration;

function allNewCopy() {
  const chunks = [];
  for (const t of TEMPLATES) {
    for (const b of t.blocks) {
      if (typeof b.content === 'string') chunks.push(`${t.key}: ${b.content}`);
      if (typeof b.label === 'string') chunks.push(`${t.key}: ${b.label}`);
      for (const row of b.rows || []) chunks.push(`${t.key}: ${row.label} ${row.value}`);
    }
  }
  return chunks;
}

describe('prep.lawn revision content', () => {
  test('publishes exactly one template: prep.lawn', () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(['prep.lawn']);
  });

  test('never says safe/safely', () => {
    for (const chunk of allNewCopy()) expect(chunk).not.toMatch(/\bsafe(ly)?\b/i);
  });

  test('no fixed re-entry windows (hours/minutes tied to leaving or re-entering)', () => {
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/(out of the (home|house|kitchen|room)|stay (out|away|off)|re-?enter|be out)[^.]{0,50}\d+\s*(–|-|to)?\s*\d*\s*(hour|hr|minute|min)/i);
    }
  });

  test('brand and pricing wording rules', () => {
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/Waves Lawn (&|and) Pest/i);
      expect(chunk).not.toMatch(/per visit/i);
      expect(chunk).not.toMatch(/EPA[- ]approved/i);
    }
  });

  test('products are described as EPA-registered', () => {
    const joined = TEMPLATES[0].blocks.map((b) => b.content || '').join(' ');
    expect(/products?/i.test(joined)).toBe(true);
    expect(joined).toMatch(/EPA-registered/);
  });

  test('carries the sections, the 4-row FAQ, the report-rules callout, and the CTA', () => {
    const { blocks } = TEMPLATES[0];
    const headings = blocks.filter((b) => b.type === 'heading').map((b) => b.content);
    expect(headings).toEqual(['Before your first visit', 'Before we arrive', 'Pets & kids', 'What to expect after']);
    const faqBlocks = blocks.filter((b) => b.type === 'details' && b.variant === 'faq');
    expect(faqBlocks).toHaveLength(1);
    expect(faqBlocks[0].rows).toHaveLength(4);
    const bermuda = faqBlocks[0].rows.find((r) => /bermuda/i.test(r.label)).value;
    expect(bermuda).toMatch(/only when your lawn needs it/i);
    // CitraBlue is a test-area cultivar (protocol 20260808000001), never eligible outright.
    expect(bermuda).toMatch(/CitraBlue and any unknown cultivar get a test patch first/);
    expect(bermuda).not.toMatch(/CitraBlue qualif/i);
    expect(bermuda).toMatch(/spring/i);
    expect(bermuda).toMatch(/cultivar/i);
    expect(bermuda).toMatch(/two applications per growing season/i);
    expect(blocks.filter((b) => b.type === 'details' && !b.variant)).toHaveLength(1);
    expect(blocks.some((b) => b.type === 'callout' && /service report/i.test(b.content))).toBe(true);
    expect(blocks.find((b) => b.type === 'cta')).toEqual({ type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' });
    expect(JSON.stringify(blocks)).toMatch(/keep(?:s)? (?:kids and pets|feet and pets) off|off for two weeks/i);
  });

  test('the editor normalizer accepts the blocks and keeps the FAQ variant', () => {
    const { blocks } = TEMPLATES[0];
    const normalized = normalizeBlocks(blocks);
    expect(normalized).toHaveLength(blocks.length);
    expect(normalized.filter((b) => b.type === 'details' && b.variant === 'faq')).toHaveLength(1);
    expect(normalized.find((b) => b.type === 'cta')).toMatchObject({ label: 'Open prep guide', url_variable: 'prep_url' });
  });
});

describe('supersession', () => {
  test('000002: no re-service or next-visit promise (prep.lawn also goes to one-time lawn treatments)', () => {
    expect(migration.SUPERSEDES).toBe('migration:20260930120001');
    const text = JSON.stringify(TEMPLATES);
    expect(text).not.toMatch(/re-service/i);
    expect(text).not.toMatch(/next visit/i);
    // Fertilizer is not EPA-registered: the claim names pesticides only.
    expect(text).not.toMatch(/every product we apply is EPA-registered/i);
    expect(text).toMatch(/Every pesticide we apply is EPA-registered/);
  });

  test('000001 patches exactly the Bermuda answer and leaves every other block as 000000 shipped it', () => {
    expect(r1.SUPERSEDES).toBe('migration:20260930120000');
    const before = base.TEMPLATES[0].blocks;
    const after = r1.TEMPLATES[0].blocks;
    expect(after).toHaveLength(before.length);
    const changed = after.filter((b, i) => JSON.stringify(b) !== JSON.stringify(before[i]));
    expect(changed).toHaveLength(1);
    expect(changed[0].variant).toBe('faq');
  });
});

describe.each([
  ['000000', base, 'migration:20260930120000'],
  ['000001', r1, 'migration:20260930120001'],
  ['000002', migration, 'migration:20260930120002'],
])('publish mechanics (%s)', (_name, migration, marker) => {
  const { TEMPLATES } = migration;
  function makeKnex() {
    const state = {
      template: { id: 't-1', template_key: 'prep.lawn', active_version_id: 'v-1' },
      versions: [{ id: 'v-1', template_id: 't-1', version_number: 3, status: 'active', subject: 'Subj', preview_text: 'Prev', blocks: '[]' }],
      templateUpdates: [],
      versionUpdates: [],
      inserted: [],
    };
    const knex = jest.fn((table) => {
      if (table === 'email_templates') {
        const q = {
          where: jest.fn(() => q),
          first: jest.fn(async () => state.template),
          update: jest.fn(async (patch) => { state.templateUpdates.push(patch); return 1; }),
        };
        return q;
      }
      if (table === 'email_template_versions') {
        const filters = {};
        const q = {
          where: jest.fn((a, b, c) => {
            if (typeof a === 'object') Object.assign(filters, a);
            else if (a === 'version_number' && b === '<') filters.versionBelow = c;
            return q;
          }),
          whereNot: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          first: jest.fn(async () => {
            if (filters.id) return state.versions.find((v) => v.id === filters.id) || null;
            let rows = [...state.versions];
            if (filters.status) rows = rows.filter((v) => v.status === filters.status);
            if (filters.versionBelow !== undefined) rows = rows.filter((v) => v.version_number < filters.versionBelow);
            return rows.sort((a, b) => b.version_number - a.version_number)[0] || null;
          }),
          insert: jest.fn((row) => ({
            returning: jest.fn(async () => {
              const v = { id: `v-new-${state.inserted.length}`, ...row };
              state.inserted.push(v);
              state.versions.push(v);
              return [v];
            }),
          })),
          update: jest.fn(async (patch) => { state.versionUpdates.push({ filters: { ...filters }, patch }); return 1; }),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    });
    knex.schema = { hasTable: jest.fn(async () => true) };
    return { knex, state };
  }

  test('up publishes a new active version, archives the prior one, flips the pointer', async () => {
    const { knex, state } = makeKnex();
    await migration.up(knex);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].version_number).toBe(4);
    expect(state.inserted[0].status).toBe('active');
    expect(state.inserted[0].subject).toBe('Subj'); // carried from the prior version
    expect(JSON.parse(state.inserted[0].blocks)).toEqual(TEMPLATES[0].blocks);
    expect(state.versionUpdates.some((u) => u.patch.status === 'archived')).toBe(true);
    expect(state.templateUpdates.some((u) => u.active_version_id === 'v-new-0')).toBe(true);
    expect(JSON.parse(state.inserted[0].validation_snapshot).source).toBe(marker);
  });

  test('up is a no-op when the template row is absent', async () => {
    const { knex, state } = makeKnex();
    state.template = null;
    await migration.up(knex);
    expect(state.inserted).toHaveLength(0);
  });

  test('down leaves an admin publication (no marker) alone', async () => {
    const { knex, state } = makeKnex();
    state.versions = [{ id: 'v-1', template_id: 't-1', version_number: 9, status: 'active', validation_snapshot: '{"ok":true}', blocks: '[]' }];
    await migration.down(knex);
    expect(state.templateUpdates).toHaveLength(0);
    expect(state.versionUpdates).toHaveLength(0);
  });

  test('down reactivates the prior version when the marker matches', async () => {
    const { knex, state } = makeKnex();
    state.versions = [
      { id: 'v-old', template_id: 't-1', version_number: 3, status: 'archived', validation_snapshot: '{}', blocks: '[]' },
      { id: 'v-mig', template_id: 't-1', version_number: 4, status: 'active', validation_snapshot: JSON.stringify({ ok: true, source: marker }), blocks: '[]' },
    ];
    state.template.active_version_id = 'v-mig';
    await migration.down(knex);
    expect(state.templateUpdates.some((u) => u.active_version_id === 'v-old')).toBe(true);
    expect(state.versionUpdates.some((u) => u.patch.status === 'active')).toBe(true);
    expect(state.versionUpdates.some((u) => u.patch.status === 'archived')).toBe(true);
  });
});
