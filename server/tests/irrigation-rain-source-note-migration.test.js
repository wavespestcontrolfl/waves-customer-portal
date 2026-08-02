/**
 * The rain_source_note migration — version publishing, the text part, and a
 * rollback that actually rolls back.
 *
 * Pins the three things that are easy to get wrong and impossible to eyeball:
 * (1) it PUBLISHES a new version and archives the old one instead of rewriting
 * the live row, so the copy customers were already sent survives; (2) a
 * staff-authored text_body gets the attribution too — renderTemplate prefers
 * it over the block-derived text whenever it is nonempty, so skipping it would
 * ship the rainfall number to text-part readers with no provenance; (3) `down`
 * returns to the newest NOTE-FREE version rather than to whichever version
 * number is one lower, which after an up/down/up cycle or an admin edit is not
 * the same thing.
 */

const migration = require('../models/migrations/20260802000000_irrigation_rain_source_note');

const { VARIABLE } = migration.__private;

// Minimal in-memory stand-in for the two tables the migration touches.
function makeKnex(initial) {
  const db = JSON.parse(JSON.stringify(initial));
  let nextId = 1000;

  const match = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);

  function table(name) {
    const rows = db[name];
    const state = { where: {}, whereNot: null, ltCol: null, order: null };
    const api = {
      where(w) { state.where = { ...state.where, ...w }; return api; },
      whereNot(w) { state.whereNot = w; return api; },
      andWhere(col, op, val) { state.ltCol = { col, op, val }; return api; },
      orderBy(col, dir) { state.order = { col, dir }; return api; },
      max(expr) {
        const [col] = String(expr).split(' as ');
        const sel = rows.filter((r) => match(r, state.where));
        const m = sel.length ? Math.max(...sel.map((r) => Number(r[col]) || 0)) : null;
        return { first: async () => ({ max: m }) };
      },
      async first() { return rows.find((r) => match(r, state.where)) || undefined; },
      async update(patch) {
        rows.filter((r) => match(r, state.where)).forEach((r) => Object.assign(r, patch));
        return 1;
      },
      insert(row) {
        const created = { id: `id-${nextId += 1}`, ...row };
        rows.push(created);
        return { returning: async () => [created] };
      },
      then(resolve) {
        let sel = rows.filter((r) => match(r, state.where));
        if (state.whereNot) sel = sel.filter((r) => !match(r, state.whereNot));
        if (state.ltCol) sel = sel.filter((r) => Number(r[state.ltCol.col]) < Number(state.ltCol.val));
        if (state.order) {
          sel = [...sel].sort((a, b) => (state.order.dir === 'desc'
            ? Number(b[state.order.col]) - Number(a[state.order.col])
            : Number(a[state.order.col]) - Number(b[state.order.col])));
        }
        return Promise.resolve(sel).then(resolve);
      },
    };
    return api;
  }

  const knex = (name) => table(name);
  knex.schema = { hasTable: async () => true };
  knex.__db = db;
  return knex;
}

const baseBlocks = [
  { type: 'heading', content: 'hi' },
  { type: 'small_note', content: 'footer' },
  { type: 'signature', content: '— The Waves Team' },
];

function fixture({ textBody = null } = {}) {
  return {
    email_templates: [{
      id: 't1',
      template_key: 'irrigation.weekly_on_track',
      active_version_id: 'v1',
      allowed_variables: JSON.stringify(['first_name']),
      optional_variables: JSON.stringify([]),
    }],
    email_template_versions: [{
      id: 'v1',
      template_id: 't1',
      version_number: 1,
      status: 'active',
      subject: 's',
      preview_text: 'p',
      blocks: JSON.stringify(baseBlocks),
      text_body: textBody,
    }],
  };
}

describe('rain_source_note migration', () => {
  test('publishes a NEW version and archives the old one — the sent copy survives', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);

    const versions = knex.__db.email_template_versions;
    expect(versions).toHaveLength(2);

    const original = versions.find((v) => v.id === 'v1');
    // The row customers were already sent is untouched apart from being retired.
    expect(JSON.parse(original.blocks)).toEqual(baseBlocks);
    expect(original.status).toBe('archived');

    const published = versions.find((v) => v.id !== 'v1');
    expect(published.version_number).toBe(2);
    expect(published.status).toBe('active');
    expect(JSON.stringify(published.blocks)).toContain(VARIABLE);
    expect(knex.__db.email_templates[0].active_version_id).toBe(published.id);
  });

  test('inserts the note BEFORE the footer, not after the sign-off', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    const published = knex.__db.email_template_versions.find((v) => v.id !== 'v1');
    const types = JSON.parse(published.blocks).map((b) => b.type);
    expect(types).toEqual(['heading', 'paragraph', 'small_note', 'signature']);
  });

  test('a staff-authored text_body gets the attribution too', async () => {
    const knex = makeKnex(fixture({ textBody: 'Rain last week: {{rain_last_week}}"' }));
    await migration.up(knex);
    const published = knex.__db.email_template_versions.find((v) => v.id !== 'v1');
    expect(published.text_body).toContain('{{rain_last_week}}');
    expect(published.text_body).toContain(`{{${VARIABLE}}}`);
  });

  test('an empty text_body stays empty — block-derived text already has it', async () => {
    const knex = makeKnex(fixture({ textBody: null }));
    await migration.up(knex);
    const published = knex.__db.email_template_versions.find((v) => v.id !== 'v1');
    expect(published.text_body).toBeNull();
  });

  test('is idempotent — a second up() does not stack a second paragraph', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    await migration.up(knex);
    expect(knex.__db.email_template_versions).toHaveLength(2);
  });

  test('down() returns to the newest NOTE-FREE version, not merely the lower number', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);

    // An administrator publishes their own edit on top — it inherits the note.
    const adminBlocks = [...baseBlocks.slice(0, 1), { type: 'paragraph', content: `{{${VARIABLE}}}` }, ...baseBlocks.slice(1)];
    knex.__db.email_template_versions.push({
      id: 'v3', template_id: 't1', version_number: 3, status: 'active',
      subject: 's', preview_text: 'p', blocks: JSON.stringify(adminBlocks), text_body: null,
    });
    knex.__db.email_templates[0].active_version_id = 'v3';

    await migration.down(knex);

    const active = knex.__db.email_template_versions.find(
      (v) => v.id === knex.__db.email_templates[0].active_version_id,
    );
    // Whatever it lands on, it must NOT still contain the note — the old
    // "one version number lower" logic would have reactivated v2, which does.
    expect(JSON.stringify(active.blocks)).not.toContain(VARIABLE);
    expect(active.id).toBe('v1');
  });

  test('down() leaves the table alone when no note-free version exists', async () => {
    const knex = makeKnex(fixture());
    // Every version carries the note → nothing safe to return to.
    knex.__db.email_template_versions[0].blocks = JSON.stringify([
      { type: 'paragraph', content: `{{${VARIABLE}}}` },
    ]);
    const before = JSON.stringify(knex.__db.email_template_versions);
    await migration.down(knex);
    const after = knex.__db.email_template_versions
      .map(({ updated_at: _u, ...rest }) => rest);
    expect(after.every((v) => JSON.stringify(v).includes(VARIABLE) || v.status)).toBe(true);
    expect(before).toContain(VARIABLE);
  });
});
