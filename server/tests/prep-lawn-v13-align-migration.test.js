/**
 * 20261026180000 — prep.lawn v13 alignment (mowing + water-in paragraphs).
 *
 * The migration patches the LIVE active version's blocks by exact paragraph
 * equality: the three replacements land and nothing else changes, a version
 * with none of the old texts publishes nothing, a version with only some
 * replaces only those, and down() reverses only its own version. The new
 * texts keep the prep-copy rules (no "safe"/"safely", no fixed re-entry
 * window, brand "Waves").
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const migration = require('../models/migrations/20261026180000_prep_lawn_v13_align');
// What the live version carries after the 2026-09-30 chain (170000 then 190000).
const chain = require('../models/migrations/20260930190000_prep_lawn_one_time_neutral');

const { PATCHES, MIGRATION_MARKER } = migration;

const OLD = PATCHES.map((p) => p.from);
const NEW = PATCHES.map((p) => p.to);

const baseBlocks = () => JSON.parse(JSON.stringify(chain.TEMPLATES[0].blocks));

function makeKnex({ blocks = baseBlocks(), insertError = null, casMoves = 1, extra = {} } = {}) {
  const state = {
    template: { id: 't-1', template_key: 'prep.lawn', active_version_id: 'v-1' },
    versions: [{ id: 'v-1', template_id: 't-1', version_number: 3, status: 'active', subject: 'Subj', preview_text: 'Prev', blocks: JSON.stringify(blocks), ...extra }],
    templateUpdates: [],
    versionUpdates: [],
    inserted: [],
  };
  const table = (name) => {
    if (name === 'email_templates') {
      const filters = {};
      const q = {
        where: jest.fn((f) => { Object.assign(filters, f); return q; }),
        forUpdate: jest.fn(() => { state.locked = true; return q; }),
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

describe('prep.lawn v13 alignment: the starting point', () => {
  test('the live chain (170000 then 190000) carries each old paragraph exactly once', () => {
    const contents = baseBlocks().map((b) => b.content);
    for (const old of OLD) expect(contents.filter((c) => c === old)).toHaveLength(1);
  });
});

describe('prep.lawn v13 alignment: up', () => {
  test('replaces exactly the three paragraphs and changes nothing else', async () => {
    const before = baseBlocks();
    const { knex, state } = makeKnex({ blocks: before });
    await migration.up(knex);
    expect(state.locked).toBe(true);
    expect(state.inserted).toHaveLength(1);
    const published = JSON.parse(state.inserted[0].blocks);
    expect(published).toHaveLength(before.length);
    const changed = published
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => JSON.stringify(b) !== JSON.stringify(before[i]));
    expect(changed).toHaveLength(3);
    expect(changed.map(({ b }) => b.content)).toEqual(NEW);
    // Same block type and position; only the content string differs.
    for (const { b, i } of changed) expect(b).toEqual({ ...before[i], content: b.content });
    expect(published.some((b) => OLD.includes(b.content))).toBe(false);
  });

  test('publishes a new active version, flips the pointer by CAS, archives only the replaced version', async () => {
    const { knex, state } = makeKnex();
    await migration.up(knex);
    expect(state.inserted[0].version_number).toBe(4);
    expect(state.inserted[0].status).toBe('active');
    expect(state.inserted[0].subject).toBe('Subj');
    expect(state.inserted[0].preview_text).toBe('Prev');
    expect(state.inserted[0].text_body).toBeNull();
    const snap = JSON.parse(state.inserted[0].validation_snapshot);
    expect(snap.source).toBe(MIGRATION_MARKER);
    expect(MIGRATION_MARKER).toBe('migration:20261026180000');
    expect(snap.supersedes_version).toBe(3);
    expect(state.templateUpdates[0].filters).toEqual({ id: 't-1', active_version_id: 'v-1' });
    expect(state.template.active_version_id).toBe('v-new-0');
    expect(state.versionUpdates).toEqual([{ filters: { id: 'v-1', status: 'active' }, patch: expect.objectContaining({ status: 'archived' }) }]);
  });

  test('an admin edit elsewhere in the live version survives', async () => {
    const edited = baseBlocks();
    edited[0] = { ...edited[0], content: `${edited[0].content} (admin-added sentence)` };
    const { knex, state } = makeKnex({ blocks: edited });
    await migration.up(knex);
    const published = JSON.parse(state.inserted[0].blocks);
    expect(published[0].content).toMatch(/admin-added sentence/);
    expect(published.map((b) => b.content).filter((c) => NEW.includes(c))).toEqual(NEW);
  });

  test('a version with none of the old strings publishes nothing', async () => {
    const already = baseBlocks().map((b) => {
      const i = OLD.indexOf(b.content);
      return i >= 0 ? { ...b, content: NEW[i] } : b;
    });
    const { knex, state } = makeKnex({ blocks: already });
    await migration.up(knex);
    expect(state.inserted).toHaveLength(0);
    expect(state.templateUpdates).toHaveLength(0);
    expect(state.versionUpdates).toHaveLength(0);
    expect(state.template.active_version_id).toBe('v-1');
  });

  test('an admin-rewritten paragraph (not an exact match) is not touched', async () => {
    const rewritten = baseBlocks().map((b) => (OLD.includes(b.content) ? { ...b, content: `${b.content} Admin note.` } : b));
    const { knex, state } = makeKnex({ blocks: rewritten });
    await migration.up(knex);
    expect(state.inserted).toHaveLength(0);
  });

  test('a version with only some of the old strings replaces only those', async () => {
    const partial = baseBlocks().map((b) => (b.content === OLD[1] ? { ...b, content: 'Admin-written watering paragraph.' } : b));
    const { knex, state } = makeKnex({ blocks: partial });
    await migration.up(knex);
    expect(state.inserted).toHaveLength(1);
    const published = JSON.parse(state.inserted[0].blocks);
    const contents = published.map((b) => b.content);
    expect(contents).toContain(NEW[0]);
    expect(contents).toContain(NEW[2]);
    expect(contents).toContain('Admin-written watering paragraph.');
    expect(contents).not.toContain(NEW[1]);
    expect(contents).not.toContain(OLD[0]);
    expect(contents).not.toContain(OLD[2]);
    expect(published).toHaveLength(partial.length);
  });

  test('a custom plain-text body leaves the template as-is', async () => {
    const { knex, state } = makeKnex({ extra: { text_body: 'custom' } });
    await migration.up(knex);
    expect(state.inserted).toHaveLength(0);
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
});

describe('prep.lawn v13 alignment: down', () => {
  test('restores the prior pointer by CAS and archives only its own version', async () => {
    const { knex, state } = makeKnex();
    state.versions = [
      { id: 'v-old', template_id: 't-1', version_number: 3, status: 'archived', validation_snapshot: '{}', blocks: '[]' },
      { id: 'v-mig', template_id: 't-1', version_number: 4, status: 'active', validation_snapshot: JSON.stringify({ ok: true, source: MIGRATION_MARKER, supersedes_version: 3 }), blocks: '[]' },
    ];
    state.template.active_version_id = 'v-mig';
    await migration.down(knex);
    expect(state.templateUpdates[0].filters).toEqual({ id: 't-1', active_version_id: 'v-mig' });
    expect(state.template.active_version_id).toBe('v-old');
    expect(state.versionUpdates).toEqual([
      { filters: { id: 'v-old' }, patch: expect.objectContaining({ status: 'active' }) },
      { filters: { id: 'v-mig', status: 'active' }, patch: expect.objectContaining({ status: 'archived' }) },
    ]);
  });

  test('leaves an admin publication (no marker) alone', async () => {
    const { knex, state } = makeKnex();
    state.versions = [{ id: 'v-1', template_id: 't-1', version_number: 9, status: 'active', validation_snapshot: '{"ok":true}', blocks: '[]' }];
    await migration.down(knex);
    expect(state.templateUpdates).toHaveLength(0);
    expect(state.versionUpdates).toHaveLength(0);
  });

  test('leaves the previous migration (190000) version alone', async () => {
    const { knex, state } = makeKnex();
    state.versions = [{ id: 'v-1', template_id: 't-1', version_number: 3, status: 'active', validation_snapshot: JSON.stringify({ source: chain.MIGRATION_MARKER, supersedes_version: 2 }), blocks: '[]' }];
    await migration.down(knex);
    expect(state.templateUpdates).toHaveLength(0);
    expect(state.versionUpdates).toHaveLength(0);
  });

  test('a concurrent admin publish after the marker check wins: no status changes', async () => {
    const { knex, state } = makeKnex({ casMoves: 0 });
    state.versions = [
      { id: 'v-old', template_id: 't-1', version_number: 3, status: 'archived', validation_snapshot: '{}', blocks: '[]' },
      { id: 'v-mig', template_id: 't-1', version_number: 4, status: 'active', validation_snapshot: JSON.stringify({ source: MIGRATION_MARKER, supersedes_version: 3 }), blocks: '[]' },
    ];
    state.template.active_version_id = 'v-mig';
    await migration.down(knex);
    expect(state.versionUpdates).toHaveLength(0);
    expect(state.template.active_version_id).toBe('v-mig');
  });
});

describe('prep.lawn v13 alignment: new copy rules', () => {
  test('the three new texts are the exact owner-approved strings', () => {
    expect(NEW).toEqual([
      'Mow at least 2 days before if mowing is due, and wait 2 days after. Weed sprays need leaf surface to soak in, and their labels ask for two uncut days on each side.',
      'Watering: your service report says one of water in today (granular fertilizer, most insect granules), keep dry for the stated hours (liquid weed control, fungicide), or resume your normal schedule. A weed barrier needs about ½ inch of rain or irrigation within 14 days to activate; your regular watering counts.',
      'Mowing: wait 2 days after a weed spray and 1 day after other liquid applications, longer if the report says so. Never mow a wet application.',
    ]);
  });

  test('never says safe/safely', () => {
    for (const text of NEW) expect(text).not.toMatch(/\bsafe(ly)?\b/i);
  });

  test('carries no fixed re-entry window', () => {
    for (const text of NEW) {
      expect(text).not.toMatch(/(out of the (home|house|kitchen|room)|stay (out|away|off)|keep (kids|pets|children)|re-?enter|be out)[^.]{0,50}\d+\s*(–|-|to)?\s*\d*\s*(hour|hr|minute|min)/i);
    }
  });

  test('brand and pricing wording rules hold; no other brand name appears', () => {
    for (const text of NEW) {
      expect(text).not.toMatch(/Waves Lawn (&|and) Pest/i);
      expect(text).not.toMatch(/per visit/i);
      expect(text).not.toMatch(/EPA[- ]approved/i);
      expect(text).not.toMatch(/waves\s+(pest|lawn)/i);
    }
    // The new copy names no other brand; "Waves" is the only brand this guide uses.
    const src = require('fs').readFileSync(require.resolve('../models/migrations/20261026180000_prep_lawn_v13_align'), 'utf8');
    expect(src).not.toMatch(/Turf Titan|Truly Nolen|Orkin|Terminix|Massey|TruGreen/i);
  });
});
