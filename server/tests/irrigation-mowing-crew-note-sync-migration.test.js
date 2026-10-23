/**
 * 20261022191000 checks the blocks and the custom plain-text body of a
 * template version independently (Codex P2 on #6485): the renderer uses a
 * custom text_body instead of block-derived text, so a version with the URL
 * in only one of the two must still be completed.
 */
const base = require('../models/migrations/20261022190000_irrigation_mowing_crew_note').__private;
const advice = require('../models/migrations/20260702000001_seed_irrigation_weekly_email_templates');
const sync = require('../models/migrations/20261022191000_irrigation_mowing_crew_note_sync');

const { NOTE_BLOCK, NOTE_TEXT, MOWING_CREW_URL, TEMPLATE_KEYS } = base;
const { planSync, syncNote } = sync.__private;
const count = (h, n) => h.split(n).length - 1;

function fakeKnex(db) {
  let n = 100;
  const table = (name) => {
    const rows = db[name];
    let where = {};
    const match = (r) => Object.entries(where).every(([k, v]) => r[k] === v);
    const api = {
      where(w) { where = { ...where, ...w }; return api; },
      forUpdate() { return api; },
      orderBy() { return api; },
      async first() { return rows.filter(match).sort((a, b) => (b.version_number || 0) - (a.version_number || 0))[0]; },
      async update(patch) { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, patch)); return hit.length; },
      insert(row) { const c = { id: `v${n += 1}`, ...row }; rows.push(c); return { returning: async () => [c] }; },
    };
    return api;
  };
  const knex = (name) => table(name);
  knex.transaction = async (cb) => cb((name) => table(name));
  return knex;
}

const seedBlocks = advice.TEMPLATES[0].blocks;
const withBlock = [...seedBlocks.slice(0, -2), NOTE_BLOCK, ...seedBlocks.slice(-2)];
const TEXT_PLAIN = 'Hi\n\nBody\n\nThis tip is based on rain.\n\n— The Waves Team';
const TEXT_DONE = `Hi\n\nBody\n\n${NOTE_TEXT}\n\nThis tip is based on rain.\n\n— The Waves Team`;

const fixture = (blocks, textBody) => ({
  email_templates: [{ id: 't1', template_key: 'irrigation.weekly_on_track', active_version_id: 'v1' }],
  email_template_versions: [{
    id: 'v1', template_id: 't1', version_number: 7, status: 'active', subject: 'S', preview_text: 'P',
    blocks: JSON.stringify(blocks), text_body: textBody,
  }],
});
const run = async (db) => syncNote(fakeKnex(db), 'irrigation.weekly_on_track', { audit: false });
const carries = (v) => ({
  blocks: JSON.stringify(JSON.parse(v.blocks)).includes(MOWING_CREW_URL),
  text: String(v.text_body || '').includes(MOWING_CREW_URL),
});

describe('mowing-crew note sync', () => {
  test('covers the same seven templates as 190000', () => {
    expect(TEMPLATE_KEYS).toHaveLength(7);
  });

  test('blocks only: the custom text body gets the line, blocks stay put', async () => {
    const db = fixture(withBlock, TEXT_PLAIN);
    expect(await run(db)).toBe('published');
    const [old, next] = db.email_template_versions;
    expect(old.status).toBe('archived');
    expect(next).toMatchObject({ version_number: 8, status: 'active', subject: 'S', preview_text: 'P', text_body: TEXT_DONE });
    expect(next.blocks).toBe(old.blocks);
    expect(count(next.blocks, MOWING_CREW_URL)).toBe(1);
    expect(count(next.text_body, MOWING_CREW_URL)).toBe(1);
    expect(db.email_templates[0].active_version_id).toBe(next.id);
  });

  test('text only: the blocks get the paragraph, the text body stays put', async () => {
    const db = fixture(seedBlocks, TEXT_DONE);
    expect(await run(db)).toBe('published');
    const next = db.email_template_versions[1];
    expect(next.text_body).toBe(TEXT_DONE);
    expect(carries(next)).toEqual({ blocks: true, text: true });
    expect(JSON.parse(next.blocks).filter((b) => b.content === NOTE_BLOCK.content)).toHaveLength(1);
  });

  test('both present: nothing is published', async () => {
    const db = fixture(withBlock, TEXT_DONE);
    expect(await run(db)).toBe('already');
    expect(db.email_template_versions).toHaveLength(1);
    expect(db.email_template_versions[0].status).toBe('active');
  });

  test('neither present: both get the line, exactly once', async () => {
    const db = fixture(seedBlocks, TEXT_PLAIN);
    expect(await run(db)).toBe('published');
    const next = db.email_template_versions[1];
    expect(carries(next)).toEqual({ blocks: true, text: true });
    expect(count(next.blocks, MOWING_CREW_URL)).toBe(1);
    expect(count(next.text_body, MOWING_CREW_URL)).toBe(1);
    expect(next.text_body).toBe(TEXT_DONE);
  });

  test('no custom text body: only the blocks change and the text stays derived (null)', async () => {
    const db = fixture(seedBlocks, null);
    expect(await run(db)).toBe('published');
    expect(db.email_template_versions[1].text_body).toBeNull();
    expect(carries(db.email_template_versions[1]).blocks).toBe(true);
    // blank text body counts as none
    const blank = fixture(withBlock, '  ');
    expect(await run(blank)).toBe('already');
  });

  test('a second run after publishing changes nothing', async () => {
    const db = fixture(seedBlocks, TEXT_PLAIN);
    const k = fakeKnex(db);
    await syncNote(k, 'irrigation.weekly_on_track', { audit: false });
    expect(await syncNote(k, 'irrigation.weekly_on_track', { audit: false })).toBe('already');
    expect(db.email_template_versions).toHaveLength(2);
  });

  test('unusable blocks: text still synced; with no text, left alone and reported', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const textOnly = fixture([], TEXT_PLAIN);
    expect(await run(textOnly)).toBe('published');
    expect(textOnly.email_template_versions[1].blocks).toBe('[]');
    expect(textOnly.email_template_versions[1].text_body).toBe(TEXT_DONE);
    const none = fixture([], null);
    expect(await run(none)).toBe('skipped');
    expect(none.email_template_versions).toHaveLength(1);
    warn.mockRestore();
  });

  test('missing template is left alone; planSync is pure', async () => {
    expect(await syncNote(fakeKnex({ email_templates: [], email_template_versions: [] }), 'irrigation.weekly_on_track', { audit: false })).toBe('missing');
    const v = { blocks: JSON.stringify(seedBlocks), text_body: TEXT_PLAIN };
    expect(planSync(v)).toEqual(planSync(v));
    expect(v.text_body).toBe(TEXT_PLAIN);
  });
});
