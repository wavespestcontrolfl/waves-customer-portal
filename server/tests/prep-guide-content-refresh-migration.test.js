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
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));

const migration = require('../models/migrations/20260715000001_prep_guide_content_refresh');
const { normalizeBlocks } = require('../services/email-template-library');

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

  test('every guide keeps the email CTA button (label + url_variable) and marks FAQs', () => {
    for (const t of TEMPLATES) {
      // renderBlocks skips a cta without url/url_variable and renderTemplate
      // only appends the default CTA when there is NO cta block — a bare
      // {type:'cta'} silently loses the "Open prep guide" button.
      const cta = t.blocks.find((b) => b.type === 'cta');
      expect(cta).toEqual({ type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' });
      // The FAQ block carries the single-column page variant.
      const faqBlocks = t.blocks.filter((b) => b.type === 'details' && b.variant === 'faq');
      expect(faqBlocks.length).toBe(1);
    }
  });

  test('the editor normalizer preserves the FAQ variant on details blocks', () => {
    // Admin create-draft/save-draft rebuild blocks through normalizeBlocks —
    // if it drops variant:'faq', the page FAQ layout silently regresses to
    // the two-column table after the next editor save (codex #2741 r2).
    const normalized = normalizeBlocks([
      { type: 'details', variant: 'faq', rows: [{ label: 'Q?', value: 'A.' }] },
      { type: 'details', rows: [{ label: 'Service', value: 'X' }] },
    ]);
    expect(normalized[0].variant).toBe('faq');
    expect(normalized[1].variant).toBeUndefined();
  });

  test('sequence step-0 bodies carry the EPA-registered phrasing when they describe products', () => {
    for (const s of STEP_SWAPS) {
      if (/\bproducts?\b/i.test(s.toHtml.replace(/over-the-counter products/g, ''))) {
        expect(s.toHtml).toMatch(/EPA-registered/);
      }
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
    // migration marker present so down() can identify its own versions
    expect(JSON.parse(state.inserted[0].validation_snapshot).source).toBe('migration:20260715000001');
  });

  test('down leaves an admin publication (no marker) alone', async () => {
    const { knex, state } = makeKnex();
    state.step = { id: 's-1', html_body: 'unrelated', text_body: '' };
    // Active version was published by an admin — no snapshot marker.
    state.versions = [{ id: 'v-1', template_id: 't-1', version_number: 9, status: 'active', validation_snapshot: '{"ok":true}', blocks: '[]' }];
    state.template.active_version_id = 'v-1';

    await migration.down(knex);

    expect(state.templateUpdates).toHaveLength(0);
    expect(state.versionUpdates).toHaveLength(0);
  });

  test('down reactivates the prior version when the marker matches', async () => {
    const { knex, state } = makeKnex();
    state.step = { id: 's-1', html_body: 'unrelated', text_body: '' };
    state.versions = [
      { id: 'v-old', template_id: 't-1', version_number: 3, status: 'archived', validation_snapshot: '{}', blocks: '[]' },
      { id: 'v-mig', template_id: 't-1', version_number: 4, status: 'active', validation_snapshot: JSON.stringify({ ok: true, source: 'migration:20260715000001' }), blocks: '[]' },
    ];
    state.template.active_version_id = 'v-mig';

    await migration.down(knex);

    expect(state.templateUpdates.some((u) => u.active_version_id === 'v-old')).toBe(true);
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
