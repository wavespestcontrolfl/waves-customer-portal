/**
 * 20260715000001 — prep guide content refresh.
 *
 * Guards the two things that must never regress in prep copy:
 *  1. Compliance: re-entry language never says "safe"/"safely" and never
 *     promises a fixed re-entry window (site-compliance ruling); brand is
 *     "Waves Pest Control"; pricing wording never says "per visit".
 *  2. Mechanics: new versions publish (prior archived, pointer flipped),
 *     and the sequence step-0 swap is exact-match admin-edit preserving.
 */
const migration = require('../models/migrations/20260715000001_prep_guide_content_refresh');

const { TEMPLATES, STEP_SWAPS } = migration;

function allNewCopy() {
  const chunks = [];
  for (const t of TEMPLATES) {
    for (const b of t.blocks) {
      if (typeof b.content === 'string') chunks.push(`${t.key}: ${b.content}`);
      for (const row of b.rows || []) {
        chunks.push(`${t.key}: ${row.label} ${row.value}`);
      }
    }
  }
  for (const s of STEP_SWAPS) chunks.push(`${s.templateKey} step0: ${s.toHtml}`);
  return chunks;
}

describe('prep guide content compliance', () => {
  test('re-entry copy never says safe/safely', () => {
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/\bsafe(ly)?\b/i);
    }
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
    }
  });

  test('product references use the EPA-registered phrasing where products are described', () => {
    // Every guide that mentions products at all carries the compliant term.
    const mentioning = TEMPLATES.filter((t) => t.blocks.some(
      (b) => typeof b.content === 'string' && /products?/i.test(b.content),
    ));
    for (const t of mentioning) {
      const joined = t.blocks.map((b) => b.content || '').join(' ');
      expect(joined).toMatch(/EPA-registered/);
    }
  });

  test('no wildlife or fumigation content (owner prohibitions)', () => {
    expect(TEMPLATES.map((t) => t.key)).not.toContain('prep.wildlife');
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/fumigat|tent(ing|ed)?\b/i);
    }
  });

  test('every guide answers the top asked topics: pets/kids and what to expect', () => {
    for (const t of TEMPLATES) {
      const headings = t.blocks.filter((b) => b.type === 'heading').map((b) => b.content);
      expect(headings).toContain('Pets & kids');
      expect(headings.some((x) => /what to expect/i.test(x))).toBe(true);
      expect(t.blocks.filter((b) => b.type === 'details').length).toBeGreaterThanOrEqual(2); // service info + FAQ
    }
  });
});

describe('publish mechanics', () => {
  function makeKnex() {
    const state = {
      template: { id: 't-1', template_key: 'prep.flea', active_version_id: 'v-1' },
      versions: [{ id: 'v-1', template_id: 't-1', version_number: 3, status: 'active', subject: 'Subj', preview_text: 'Prev', blocks: '[]' }],
      templateUpdates: [],
      versionUpdates: [],
      inserted: [],
      step: null,
      stepUpdate: null,
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
        let filters = {};
        const q = {
          where: jest.fn((f) => { Object.assign(filters, f); return q; }),
          whereNot: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          first: jest.fn(async () => {
            if (filters.id) return state.versions.find((v) => v.id === filters.id) || null;
            return [...state.versions].sort((a, b) => b.version_number - a.version_number)[0] || null;
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
      if (table === 'automation_steps') {
        const q = {
          where: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          first: jest.fn(async () => state.step),
          update: jest.fn(async (patch) => { state.stepUpdate = patch; return 1; }),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    });
    knex.schema = { hasTable: jest.fn(async () => true) };
    return { knex, state };
  }

  test('publishes a new active version and archives the prior one', async () => {
    const { knex, state } = makeKnex();
    // Limit to one template + no steps for this fake
    state.step = { id: 's-1', html_body: 'unrelated', text_body: '' };

    await migration.up(knex);

    // The fake serves ONE template row for all 8 templates; the first
    // publish is the representative one.
    expect(state.inserted.length).toBeGreaterThan(0);
    expect(state.inserted[0].version_number).toBe(4);
    expect(state.inserted[0].status).toBe('active');
    expect(state.inserted[0].subject).toBe('Subj'); // carried from prior version
    // prior active versions archived
    expect(state.versionUpdates.some((u) => u.patch.status === 'archived')).toBe(true);
    // pointer flipped
    expect(state.templateUpdates.some((u) => u.active_version_id === 'v-new-0')).toBe(true);
  });

  test('step swap is exact-match only (admin-edited body untouched)', async () => {
    const { knex, state } = makeKnex();
    state.step = { id: 's-1', html_body: 'ADMIN EDITED BODY', text_body: '' };

    await migration.up(knex);

    expect(state.stepUpdate).toBeNull();
  });

  test('step swap replaces the exact prod body and regenerates text_body', async () => {
    const { knex, state } = makeKnex();
    state.step = { id: 's-1', html_body: STEP_SWAPS[0].fromHtml, text_body: '' };

    await migration.up(knex);

    expect(state.stepUpdate).not.toBeNull();
    expect(state.stepUpdate.html_body).toBe(STEP_SWAPS[0].toHtml);
    expect(state.stepUpdate.text_body).toContain('Waves Pest Control team');
    expect(state.stepUpdate.text_body).not.toMatch(/<[a-z]+>/);
  });
});
