/**
 * Every weekly irrigation email carries one line linking the mowing-crew blog
 * post (owner 2026-10-22). The bodies are email_template_versions rows, so the
 * line is published as a new active version by migration
 * 20261022190000_irrigation_mowing_crew_note. These tests render each variant
 * through the real template renderer and pin the exact customer copy, the
 * placement, and exactly-once behavior.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.raw = jest.fn((e) => e); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const migration = require('../models/migrations/20261022190000_irrigation_mowing_crew_note');
const guides = require('../models/migrations/20260907000010_irrigation_guide_resources');
const advice = require('../models/migrations/20260702000001_seed_irrigation_weekly_email_templates');
const setup = require('../models/migrations/20260801200000_seed_irrigation_setup_email_templates');
const plan = require('../models/migrations/20260828000004_seed_irrigation_week_plan_email_template');
const baseline = require('./fixtures/customer-copy-audit-email-baseline.json');
const { buildWeeklyEmailDecision, TEMPLATE_WEEK_PLAN } = require('../services/irrigation-weekly-email');

const {
  TEMPLATE_KEYS, NOTE_BLOCK, NOTE_TEXT, MOWING_CREW_URL, LEAD, LINK_LABEL, withNote, withNoteText, publishNote,
} = migration.__private;

const EXPECTED_URL = 'https://www.wavespestcontrol.com/lawn-care/note-for-your-mowing-crew/';
const EXPECTED_HTML_SENTENCE = `Who mows your lawn? Forward them this short note so every cut helps your grass: <a class="dm-link" href="${EXPECTED_URL}"`;
const count = (haystack, needle) => haystack.split(needle).length - 1;

// seed → (guide-resource migration, as live) so the test sees the real shape.
function seeded() {
  const out = [];
  const add = (mod) => mod.TEMPLATES.forEach((t) => out.push({ t, rowFn: mod.__private.templateRow, previewPayload: mod.__private.PREVIEW_PAYLOAD }));
  add(advice);
  add(setup);
  add(plan);
  return out.map(({ t, rowFn, previewPayload }) => {
    const template = { id: `tmpl-${t.key}`, ...rowFn(t) };
    template.allowed_variables = JSON.parse(template.allowed_variables);
    template.required_variables = JSON.parse(template.required_variables);
    const liveBlocks = guides.__private.updatedBlocks(t.blocks);
    return { key: t.key, template, subject: t.subject, preview: t.preview, liveBlocks, previewPayload };
  });
}

const render = ({ template, subject, preview, blocks, text_body: textBody = null, payload }) => EmailTemplates.renderTemplate({
  template, version: { id: 'v', subject, preview_text: preview, blocks, text_body: textBody }, payload,
});

describe('mowing-crew note: constants', () => {
  test('one URL constant, and the copy is word for word', () => {
    expect(MOWING_CREW_URL).toBe(EXPECTED_URL);
    expect(LEAD).toBe('Who mows your lawn? Forward them this short note so every cut helps your grass:');
    expect(LINK_LABEL).toBe('A note for whoever mows your lawn');
    expect(NOTE_BLOCK).toEqual({ type: 'paragraph', content: `${LEAD} [${LINK_LABEL}](${EXPECTED_URL})` });
    expect(NOTE_TEXT).toBe(`${LEAD} ${LINK_LABEL} (${EXPECTED_URL})`);
    // The URL is written once in the migration source.
    const src = require('fs').readFileSync(require.resolve('../models/migrations/20261022190000_irrigation_mowing_crew_note'), 'utf8');
    expect(count(src, 'note-for-your-mowing-crew')).toBe(1);
  });

  test('covers every template the weekly sweep can pick', () => {
    const picks = [
      'irrigation.weekly_cut_back', 'irrigation.weekly_add_water', 'irrigation.weekly_on_track',
      'irrigation.weekly_setup_schedule', 'irrigation.weekly_setup_system', 'irrigation.weekly_confirm_schedule',
      TEMPLATE_WEEK_PLAN,
    ];
    expect([...TEMPLATE_KEYS].sort()).toEqual([...picks].sort());
    expect(seeded().map((s) => s.key).sort()).toEqual([...picks].sort());
  });
});

describe('each variant renders the line once, in html and text', () => {
  test.each(seeded().map((s) => [s.key, s]))('%s', (_key, s) => {
    const blocks = withNote(s.liveBlocks);
    expect(blocks).not.toBeNull();
    const before = render({ ...s, blocks: s.liveBlocks, payload: s.previewPayload });
    const after = render({ ...s, blocks, payload: s.previewPayload });

    expect(count(after.html, EXPECTED_URL)).toBe(1);
    expect(count(after.html, EXPECTED_HTML_SENTENCE)).toBe(1);
    expect(after.html).toContain(`>${LINK_LABEL}</a>`);
    expect(count(after.text, EXPECTED_URL)).toBe(1);
    expect(count(after.text, NOTE_TEXT)).toBe(1);
    // Same inline paragraph style as the guide links beside it.
    const para = (html) => html.match(/<p class="dm-text" style="[^"]*">(?=[^<]*<a class="dm-link" href="https:\/\/www\.wavespestcontrol\.com\/sprinkler-timers)/)[0];
    const noteP = after.html.match(/<p class="dm-text" style="([^"]*)">Who mows your lawn\?/)[1];
    expect(para(after.html)).toContain(noteP);

    // After the main advice, before the footer small print.
    const at = (h) => after.html.indexOf(h);
    expect(at('Who mows your lawn?')).toBeGreaterThan(at('Helpful guides from the Waves blog'));
    const footer = after.html.search(/This (tip|plan|check-in) is based on/);
    expect(footer).toBeGreaterThan(0);
    expect(at('Who mows your lawn?')).toBeLessThan(footer);

    // Nothing else changes: subject, preview, and the rest of the body.
    expect(after.subject).toBe(before.subject);
    expect(after.previewText).toBe(before.previewText);
    expect(after.text.replace(`\n\n${NOTE_TEXT}`, '')).toBe(before.text);
    expect(after.validation.ok).toBe(before.validation.ok);
    expect(after.validation.referenced_variables).toEqual(before.validation.referenced_variables);
  });

  test('no customer data or placeholders leak into the added block', () => {
    expect(JSON.stringify(NOTE_BLOCK)).not.toMatch(/\{\{/);
  });
});

describe('week plan email end to end', () => {
  test('a real plan decision renders the line once', () => {
    process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2027-12-31', label: 'test year-round rule', hoursNote: 'on your assigned day', coverage: 'all' });
    let decision;
    try {
      decision = buildWeeklyEmailDecision({
        firstName: 'Dana', grassType: 'st_augustine', weekEnding: '2026-08-23', et0Inches: 1.6,
        irrigationSystem: true, irrigationRunMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], irrigationSystemType: ['spray'],
        weekPlanEnabled: true, county: 'Sarasota', forecastEt0Inches: 1.6, now: new Date('2026-08-28T12:00:00Z'),
        irrigationInchesPerWeek: null, rainfallInches7d: 0.6, forecastRainInches: 0.3,
      });
    } finally { delete process.env.IRRIGATION_RESTRICTION_POLICY; }
    expect(decision.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    const s = seeded().find((x) => x.key === TEMPLATE_WEEK_PLAN);
    const out = render({ ...s, blocks: withNote(s.liveBlocks), payload: decision.payload });
    expect(count(out.html, EXPECTED_URL)).toBe(1);
    expect(count(out.text, EXPECTED_URL)).toBe(1);
    expect(out.html).not.toMatch(/\{\{\s*\w+\s*\}\}/);
  });
});

describe('placement on the live (production-shaped) template', () => {
  const live = baseline.find((t) => t.template_key === 'irrigation.weekly_cut_back');

  test('joins the guide section, ahead of the rain-source line and the footer', () => {
    const next = withNote(live.blocks);
    const i = next.findIndex((b) => b.content === NOTE_BLOCK.content);
    expect(next[i - 1].content).toMatch(/Mowing height for your grass type/);
    expect(next[i + 1].content).toBe('{{rain_source_note}}');
    expect(next[next.length - 1].type).toBe('small_note');
    expect(next).toHaveLength(live.blocks.length + 1);
  });

  test('exactly once: a second pass changes nothing', () => {
    expect(withNote(withNote(live.blocks))).toBeNull();
  });

  test('a staff-added link to the same post is respected', () => {
    const staff = [...live.blocks, { type: 'paragraph', content: `[crew](${EXPECTED_URL})` }];
    expect(withNote(staff)).toBeNull();
  });

  test('without guide links it lands before the standing footer, else before the sign-off', () => {
    const seedBlocks = advice.TEMPLATES[0].blocks;
    const a = withNote(seedBlocks);
    expect(a[a.length - 3].content).toBe(NOTE_BLOCK.content);
    expect(a[a.length - 2].type).toBe('small_note');
    const b = withNote([{ type: 'paragraph', content: 'x' }, { type: 'signature', content: '— The Waves Team' }]);
    expect(b.map((x) => x.type)).toEqual(['paragraph', 'paragraph', 'signature']);
    expect(withNote([])).toBeNull();
    expect(withNote('not json')).toBeNull();
  });
});

describe('staff-authored plain-text body', () => {
  test('gets the line in text form, once, before the footer', () => {
    const body = 'Hello {{first_name}}\n\n[Overwatering vs. underwatering](https://www.wavespestcontrol.com/lawn-care/overwatering-lawn-vs-underwatering/)\n\nThis tip is based on rain.\n\n— The Waves Team';
    const out = withNoteText(body);
    expect(count(out, EXPECTED_URL)).toBe(1);
    expect(out).toContain(`${NOTE_TEXT}\n\nThis tip is based on rain.`);
    expect(withNoteText(out)).toBe(out);
    expect(withNoteText('Just a line')).toBe(`Just a line\n\n${NOTE_TEXT}`);
  });
});

// Minimal knex double: only what publishNote touches.
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

describe('publishNote', () => {
  const fixture = (blocks, textBody = null) => ({
    email_templates: [{ id: 't1', template_key: 'irrigation.weekly_on_track', active_version_id: 'v1' }],
    email_template_versions: [{
      id: 'v1', template_id: 't1', version_number: 4, status: 'active', subject: 'S', preview_text: 'P',
      blocks: JSON.stringify(blocks), text_body: textBody,
    }],
  });

  test('publishes a new active version, archives the old one, keeps subject and preview', async () => {
    const db = fixture(advice.TEMPLATES[0].blocks);
    expect(await publishNote(fakeKnex(db), 'irrigation.weekly_on_track', { audit: false })).toBe('published');
    const [old, next] = db.email_template_versions;
    expect(old.status).toBe('archived');
    expect(next).toMatchObject({ version_number: 5, status: 'active', subject: 'S', preview_text: 'P', text_body: null });
    expect(JSON.parse(next.blocks).filter((b) => String(b.content).includes(EXPECTED_URL))).toHaveLength(1);
    expect(db.email_templates[0].active_version_id).toBe(next.id);
  });

  test('a re-run publishes nothing', async () => {
    const db = fixture(advice.TEMPLATES[0].blocks);
    const k = fakeKnex(db);
    await publishNote(k, 'irrigation.weekly_on_track', { audit: false });
    expect(await publishNote(k, 'irrigation.weekly_on_track', { audit: false })).toBe('already');
    expect(db.email_template_versions).toHaveLength(2);
  });

  test('a custom text body is extended, not replaced', async () => {
    const db = fixture(advice.TEMPLATES[0].blocks, 'Hi\n\nBody');
    await publishNote(fakeKnex(db), 'irrigation.weekly_on_track', { audit: false });
    expect(db.email_template_versions[1].text_body).toBe(`Hi\n\nBody\n\n${NOTE_TEXT}`);
  });

  test('missing template or unusable blocks are left alone', async () => {
    expect(await publishNote(fakeKnex({ email_templates: [], email_template_versions: [] }), 'irrigation.weekly_on_track', { audit: false })).toBe('missing');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = fixture([]);
    expect(await publishNote(fakeKnex(db), 'irrigation.weekly_on_track', { audit: false })).toBe('skipped');
    expect(db.email_template_versions).toHaveLength(1);
    warn.mockRestore();
  });
});
