/**
 * 20260930160000 — prep.lawn guide revision (one migration; PR re-cut from #5420).
 *
 * Guards what must never regress in prep copy (same rules as the 2026-07-15
 * refresh test): no "safe"/"safely", no fixed re-entry windows, brand is
 * "Waves", no "per visit", pesticides "EPA-registered". prep.lawn also serves
 * one-time lawn treatments, so no re-service / next-visit / plan promise.
 * Plus the concurrency-safe publish mechanics: savepoint insert (a draft that
 * took the version number wins), pointer CAS before any status change (a
 * concurrent admin publish wins), marker + CAS-guarded down().
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const migration = require('../models/migrations/20260930160000_prep_lawn_guide_revision');
const { normalizeBlocks } = require('../services/email-template-library');

const { TEMPLATES, MIGRATION_MARKER } = migration;

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
    // prep.lawn also serves one-time lawn treatments: no program/plan framing (Codex r6 P1).
    expect(bermuda).not.toMatch(/lawn program|your plan/i);
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

describe('one-time-safe copy', () => {
  test('no re-service, next-visit, or plan promise (prep.lawn also goes to one-time lawn treatments)', () => {
    const text = JSON.stringify(TEMPLATES);
    expect(text).not.toMatch(/re-service/i);
    expect(text).not.toMatch(/next visit/i);
    expect(text).not.toMatch(/lawn program|your plan/i);
  });

  test('EPA registration is claimed for pesticides only', () => {
    const text = JSON.stringify(TEMPLATES);
    expect(text).not.toMatch(/every product we apply is EPA-registered/i);
    expect(text).toMatch(/Every pesticide we apply is EPA-registered/);
  });

  test('CitraBlue is a test-patch cultivar; North Port’s April 1 fertilizer start is named', () => {
    const text = JSON.stringify(TEMPLATES);
    expect(text).toMatch(/CitraBlue and any unknown cultivar get a test patch first/);
    expect(text).not.toMatch(/CitraBlue qualif/i);
    expect(text).toMatch(/April 1 – September 30 in North Port/);
  });
});

describe('publish mechanics', () => {
  function makeKnex({ insertError = null, casMoves = 1 } = {}) {
    const state = {
      template: { id: 't-1', template_key: 'prep.lawn', active_version_id: 'v-1' },
      versions: [{ id: 'v-1', template_id: 't-1', version_number: 3, status: 'active', subject: 'Subj', preview_text: 'Prev', blocks: '[]' }],
      templateUpdates: [],
      versionUpdates: [],
      inserted: [],
    };
    const table = (name) => {
      if (name === 'email_templates') {
        const filters = {};
        const q = {
          where: jest.fn((f) => { Object.assign(filters, f); return q; }),
          first: jest.fn(async () => state.template),
          update: jest.fn(async (patch) => {
            if (filters.active_version_id !== undefined) {
              if (!casMoves || state.template.active_version_id !== filters.active_version_id) return 0;
            }
            state.templateUpdates.push({ filters: { ...filters }, patch });
            Object.assign(state.template, patch);
            return 1;
          }),
        };
        return q;
      }
      if (name === 'email_template_versions') {
        const filters = {};
        const q = {
          where: jest.fn((f) => { Object.assign(filters, f); return q; }),
          orderBy: jest.fn(() => q),
          first: jest.fn(async () => {
            let rows = state.versions.filter((v) => Object.entries(filters).every(([k, val]) => v[k] === val));
            rows = rows.sort((a, b) => b.version_number - a.version_number);
            return rows[0] || null;
          }),
          insert: jest.fn((row) => ({
            returning: jest.fn(async () => {
              if (insertError) throw insertError;
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
      throw new Error(`unexpected table ${name}`);
    };
    const knex = jest.fn(table);
    knex.transaction = jest.fn(async (fn) => fn(jest.fn(table)));
    knex.schema = { hasTable: jest.fn(async () => true) };
    return { knex, state };
  }

  test('up publishes a new active version, flips the pointer by CAS, archives only the replaced version', async () => {
    const { knex, state } = makeKnex();
    await migration.up(knex);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].version_number).toBe(4);
    expect(state.inserted[0].subject).toBe('Subj');
    expect(JSON.parse(state.inserted[0].blocks)).toEqual(TEMPLATES[0].blocks);
    const snap = JSON.parse(state.inserted[0].validation_snapshot);
    expect(snap.source).toBe(MIGRATION_MARKER);
    expect(snap.supersedes_version).toBe(3);
    expect(state.templateUpdates[0].filters).toEqual({ id: 't-1', active_version_id: 'v-1' });
    expect(state.template.active_version_id).toBe('v-new-0');
    expect(state.versionUpdates).toEqual([{ filters: { id: 'v-1', status: 'active' }, patch: expect.objectContaining({ status: 'archived' }) }]);
  });

  test('a draft that took the version number wins: unique violation leaves the template as-is', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { knex, state } = makeKnex({ insertError: err });
    await migration.up(knex);
    expect(state.templateUpdates).toHaveLength(0);
    expect(state.versionUpdates).toHaveLength(0);
  });

  test('any other insert error still fails the migration', async () => {
    const { knex } = makeKnex({ insertError: new Error('boom') });
    await expect(migration.up(knex)).rejects.toThrow('boom');
  });

  test('a concurrent admin publish wins the CAS: this version is archived, nothing else changes', async () => {
    const { knex, state } = makeKnex({ casMoves: 0 });
    await migration.up(knex);
    expect(state.template.active_version_id).toBe('v-1');
    expect(state.versionUpdates).toEqual([{ filters: { id: 'v-new-0' }, patch: expect.objectContaining({ status: 'archived' }) }]);
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

  test('down restores the superseded version by pointer CAS when the marker matches', async () => {
    const { knex, state } = makeKnex();
    state.versions = [
      { id: 'v-old', template_id: 't-1', version_number: 3, status: 'archived', validation_snapshot: '{}', blocks: '[]' },
      { id: 'v-mig', template_id: 't-1', version_number: 4, status: 'active', validation_snapshot: JSON.stringify({ ok: true, source: MIGRATION_MARKER, supersedes_version: 3 }), blocks: '[]' },
    ];
    state.template.active_version_id = 'v-mig';
    await migration.down(knex);
    expect(state.templateUpdates[0].filters).toEqual({ id: 't-1', active_version_id: 'v-mig' });
    expect(state.template.active_version_id).toBe('v-old');
    expect(state.versionUpdates.some((u) => u.filters.id === 'v-old' && u.patch.status === 'active')).toBe(true);
    expect(state.versionUpdates.some((u) => u.filters.id === 'v-mig' && u.patch.status === 'archived')).toBe(true);
  });
});
