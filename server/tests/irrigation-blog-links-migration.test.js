/**
 * The irrigation blog-link migration.
 *
 * Ships in a SEPARATE deploy from the renderer that understands markdown
 * links: Railway runs migrations pre-deploy while the previous app version is
 * still serving, and that version would render a literal `[label](url)` to any
 * customer emailed during the window — including the Monday 7:00 ET sweep.
 *
 * Pins the rollback identity rule (codex #3169 P1): `down` must undo only the
 * version THIS migration published, identified by exact block content. Matching
 * on the marker URL alone was too loose — a staff member who reworded the link
 * block while keeping the URL produced a version that stripped back to the
 * pre-migration blocks, so the rollback mistook it for its own work and
 * archived their edit.
 */

const migration = require('../models/migrations/20260803000000_irrigation_blog_links');

const { BLOCK, TEMPLATE_KEYS, WATERING_URL, MOWING_URL } = migration.__private;

function makeKnex(initial) {
  const db = JSON.parse(JSON.stringify(initial));
  let nextId = 2000;
  const match = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);

  function table(name) {
    const rows = db[name];
    const state = { where: {}, order: null };
    const api = {
      where(w) { state.where = { ...state.where, ...w }; return api; },
      orderBy(col, dir) { state.order = { col, dir }; return api; },
      max(expr) {
        const [col] = String(expr).split(' as ');
        const sel = rows.filter((r) => match(r, state.where));
        return { first: async () => ({ max: sel.length ? Math.max(...sel.map((r) => Number(r[col]) || 0)) : null }) };
      },
      async first() { return rows.find((r) => match(r, state.where)) || undefined; },
      async update(patch) { rows.filter((r) => match(r, state.where)).forEach((r) => Object.assign(r, patch)); return 1; },
      insert(row) { const c = { id: `id-${nextId += 1}`, ...row }; rows.push(c); return { returning: async () => [c] }; },
      then(resolve) {
        let sel = rows.filter((r) => match(r, state.where));
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
  const knex = (n) => table(n);
  knex.schema = { hasTable: async () => true };
  knex.__db = db;
  return knex;
}

const baseBlocks = [
  { type: 'heading', content: 'hi' },
  { type: 'small_note', content: 'standing footer note' },
  { type: 'signature', content: '— The Waves Team' },
];

const fixture = () => ({
  email_templates: [{
    id: 't1',
    template_key: 'irrigation.weekly_on_track',
    active_version_id: 'v1',
    allowed_variables: JSON.stringify(['first_name']),
    optional_variables: JSON.stringify([]),
  }],
  email_template_versions: [{
    id: 'v1', template_id: 't1', version_number: 1, status: 'active',
    subject: 'S', preview_text: 'P', blocks: JSON.stringify(baseBlocks),
    text_body: null, published_at: '2026-08-01T00:00:00.000Z',
  }],
});

describe('irrigation blog-link migration', () => {
  test('links both posts at their canonical hub URLs', () => {
    expect(WATERING_URL).toBe('https://www.wavespestcontrol.com/lawn-care/overwatering-lawn-vs-underwatering/');
    expect(MOWING_URL).toBe('https://www.wavespestcontrol.com/lawn-care/mowing-height-by-grass-type/');
    expect(TEMPLATE_KEYS).toHaveLength(6);
  });

  test('publishes a new version and sits the note above the standing footer', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    const versions = knex.__db.email_template_versions;
    expect(versions).toHaveLength(2);
    const published = versions.find((v) => v.id !== 'v1');
    expect(published.status).toBe('active');
    // The original row customers were already sent is retained untouched.
    expect(JSON.parse(versions.find((v) => v.id === 'v1').blocks)).toEqual(baseBlocks);
    const types = JSON.parse(published.blocks).map((b) => b.type);
    expect(types).toEqual(['heading', 'small_note', 'small_note', 'signature']);
    expect(JSON.parse(published.blocks)[1].content).toBe(BLOCK.content);
  });

  test('is idempotent', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    await migration.up(knex);
    expect(knex.__db.email_template_versions).toHaveLength(2);
  });

  test('down() undoes its own version when nothing was published on top', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.__db.email_templates[0].active_version_id).toBe('v1');
  });

  test('down() PRESERVES a staff version that reworded the link block but kept the URL', async () => {
    // codex #3169 P1. Matching on the marker URL alone, this version stripped
    // back to the pre-migration blocks and was archived as if it were ours.
    const knex = makeKnex(fixture());
    await migration.up(knex);
    const edited = { ...BLOCK, content: `${BLOCK.content} Staff added this sentence.` };
    knex.__db.email_template_versions.push({
      id: 'v3', template_id: 't1', version_number: 3, status: 'active',
      subject: 'S', preview_text: 'P',
      blocks: JSON.stringify([baseBlocks[0], edited, baseBlocks[1], baseBlocks[2]]),
      text_body: null, published_at: '2026-08-04T00:00:00.000Z',
    });
    knex.__db.email_templates[0].active_version_id = 'v3';

    await migration.down(knex);

    expect(knex.__db.email_templates[0].active_version_id).toBe('v3');
    expect(knex.__db.email_template_versions.find((v) => v.id === 'v3').status).toBe('active');
    expect(JSON.stringify(knex.__db.email_template_versions.find((v) => v.id === 'v3').blocks))
      .toContain('Staff added this sentence.');
  });

  test('down() preserves a staff version that changed other content too', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    knex.__db.email_template_versions.push({
      id: 'v3', template_id: 't1', version_number: 3, status: 'active',
      subject: 'S', preview_text: 'P',
      blocks: JSON.stringify([{ type: 'heading', content: 'STAFF REWROTE THIS' }, BLOCK, baseBlocks[1]]),
      text_body: null, published_at: '2026-08-04T00:00:00.000Z',
    });
    knex.__db.email_templates[0].active_version_id = 'v3';
    await migration.down(knex);
    expect(knex.__db.email_templates[0].active_version_id).toBe('v3');
  });

  test('down() never activates an unpublished draft', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    knex.__db.email_template_versions.push({
      id: 'draft1', template_id: 't1', version_number: 9, status: 'draft',
      subject: 'S', preview_text: 'P', blocks: JSON.stringify(baseBlocks),
      text_body: null, published_at: null,
    });
    await migration.down(knex);
    expect(knex.__db.email_templates[0].active_version_id).not.toBe('draft1');
    expect(knex.__db.email_template_versions.find((v) => v.id === 'draft1').status).toBe('draft');
  });

  test('a staff-authored text_body receives the links too', async () => {
    const f = fixture();
    f.email_template_versions[0].text_body = 'Rain last week: {{rain_last_week}}"';
    const knex = makeKnex(f);
    await migration.up(knex);
    const published = knex.__db.email_template_versions.find((v) => v.id !== 'v1');
    expect(published.text_body).toContain('{{rain_last_week}}');
    expect(published.text_body).toContain(WATERING_URL);
  });
});
