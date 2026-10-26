/**
 * Dry-week rain copy and "Weekly target for your …" (owner 2026-10-26: "About 0" of rain" and
 * "Weekly target for lawn" read oddly). Migration 20261026230000_irrigation_dry_week_copy edits the
 * live irrigation templates; the sender fills {{rain_sentence}} / {{rain_preview}}. These tests
 * render through the real template renderer and pin the customer copy, the old-sender window
 * (the migration runs before the new app serves), and exactly-once publishing.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.raw = jest.fn((e) => e); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261026230000_irrigation_dry_week_copy');
const setup = require('../models/migrations/20260801200000_seed_irrigation_setup_email_templates');
const {
  buildWeeklyEmailDecision, TEMPLATE_SETUP_SCHEDULE, TEMPLATE_CONFIRM_SCHEDULE, TEMPLATE_ADD_WATER,
} = require('../services/irrigation-weekly-email');

const {
  TEMPLATE_KEYS, FIXTURE_VALUES, withPreview, withBlocks, withText, publishCopy,
} = migration.__private;

// The live layout of the setup emails (read 2026-10-26). The seed has the opening paragraph and the
// preview; the details rows came from a later migration.
const LIVE_PREVIEW = 'About {{rain_last_week}}" of rain near your home — here\'s how that compares to what your lawn needs.';
const LIVE_CONFIRM_PREVIEW = 'About {{rain_last_week}}" of rain near your home — here\'s how the week added up.';
const OPENING = 'About {{rain_last_week}}" of rain fell near your home last week. This time of year your {{grass_label}} needs roughly {{target_inches}}" of water a week — rain and watering counted together.';
const LIVE_BLOCKS = [
  { type: 'heading', content: 'Your weekly lawn water check-in, {{first_name}}' },
  { type: 'paragraph', content: OPENING },
  { type: 'details', rows: [{ label: 'Rain at your home last week', value: '{{rain_last_week}}"' }, { label: 'Weekly target for {{grass_label}}', value: '{{target_inches}}" per week' }] },
  { type: 'callout', content: '{{schedule_ask}}' },
];

const setupTemplate = () => {
  const t = setup.TEMPLATES.find((x) => x.key === TEMPLATE_SETUP_SCHEDULE);
  const row = { id: 'tmpl-setup', ...setup.__private.templateRow(t) };
  row.allowed_variables = JSON.parse(row.allowed_variables);
  row.required_variables = JSON.parse(row.required_variables);
  return row;
};
const render = (version, payload) => EmailTemplates.renderTemplate({
  template: setupTemplate(), version: { id: 'v', subject: 'S', text_body: null, ...version }, payload,
});
const migrated = () => ({ preview_text: withPreview(LIVE_PREVIEW), blocks: withBlocks(LIVE_BLOCKS) });

const BASE = {
  firstName: 'Sam', grassType: 'st_augustine', weekEnding: '2026-08-23', et0Inches: 1.2,
  rainfallInches7d: 0.42, forecastRainInches: 3.08, irrigationSystem: true, irrigationInchesPerWeek: null,
};
const setupPayload = (extra = {}) => {
  const d = buildWeeklyEmailDecision({ ...BASE, ...extra });
  expect(d.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
  return d.payload;
};

describe('migration: exact-match template edits', () => {
  test('covers every template the weekly sweep can pick', () => {
    expect([...TEMPLATE_KEYS].sort()).toEqual([
      'irrigation.weekly_add_water', 'irrigation.weekly_confirm_schedule', 'irrigation.weekly_cut_back',
      'irrigation.weekly_on_track', 'irrigation.weekly_plan', 'irrigation.weekly_rain_report',
      'irrigation.weekly_setup_schedule', 'irrigation.weekly_setup_system',
    ]);
  });

  test('the preview: the amount moves into {{rain_preview}}, the rest keeps its words', () => {
    expect(withPreview(LIVE_PREVIEW)).toBe('{{rain_preview}} Here\'s how that compares to what your lawn needs.');
    expect(withPreview(LIVE_CONFIRM_PREVIEW)).toBe('{{rain_preview}} Here\'s how the week added up.');
    // Already migrated, or reworded by staff: left alone.
    expect(withPreview(withPreview(LIVE_PREVIEW))).toBe(withPreview(LIVE_PREVIEW));
    expect(withPreview('Rain report for {{first_name}}')).toBe('Rain report for {{first_name}}');
    expect(withPreview(null)).toBeNull();
  });

  test('the body: the opening sentence becomes {{rain_sentence}}, the target row reads "for your …"', () => {
    const blocks = withBlocks(LIVE_BLOCKS);
    expect(blocks[1].content).toBe('{{rain_sentence}} This time of year your {{grass_label}} needs roughly {{target_inches}}" of water a week — rain and watering counted together.');
    expect(blocks[2].rows).toEqual([
      { label: 'Rain at your home last week', value: '{{rain_last_week}}"' },
      { label: 'Weekly target for your {{grass_label}}', value: '{{target_inches}}" per week' },
    ]);
    // Everything else is untouched, and a re-run changes nothing.
    expect(blocks[0]).toEqual(LIVE_BLOCKS[0]);
    expect(blocks[3]).toEqual(LIVE_BLOCKS[3]);
    expect(withBlocks(blocks)).toEqual(blocks);
    // A template with only the target row (the plan and advice emails) gets the label alone.
    expect(withBlocks([LIVE_BLOCKS[2]])[0].rows[1].label).toBe('Weekly target for your {{grass_label}}');
  });

  test('a staff-authored text body gets the same sentence and label edits', () => {
    const text = `${OPENING}\n\nWeekly target for {{grass_label}}: {{target_inches}}"`;
    expect(withText(text)).toBe('{{rain_sentence}} This time of year your {{grass_label}} needs roughly {{target_inches}}" of water a week — rain and watering counted together.\n\nWeekly target for your {{grass_label}}: {{target_inches}}"');
    expect(withText('Hello {{first_name}}')).toBe('Hello {{first_name}}');
  });

});

describe('rendered copy', () => {
  test('a dry week: "No measurable rain", never "About 0""', () => {
    const payload = setupPayload({ rainfallInches7d: 0 });
    expect(payload.rain_last_week).toBe('0');
    expect(payload.rain_sentence).toBe('No measurable rain fell near your home last week.');
    expect(payload.rain_preview).toBe('No measurable rain near your home.');
    const out = render(migrated(), payload);
    expect(out.previewText).toBe('No measurable rain near your home. Here\'s how that compares to what your lawn needs.');
    expect(out.text).toContain('No measurable rain fell near your home last week. This time of year your St. Augustine needs roughly');
    expect(out.text).toContain('Weekly target for your St. Augustine');
    expect(out.text).not.toMatch(/About 0"/);
    expect(out.html).not.toMatch(/About 0&quot;|About 0"/);
    expect(out.missingPayload).toEqual([]);
  });

  test('a wet week keeps the amount, word for word as before', () => {
    const payload = setupPayload({ rainfallInches7d: 0.42 });
    const before = render({ preview_text: LIVE_PREVIEW, blocks: LIVE_BLOCKS }, payload);
    const after = render(migrated(), payload);
    expect(after.previewText).toBe('About 0.42" of rain near your home. Here\'s how that compares to what your lawn needs.');
    expect(before.previewText).toBe('About 0.42" of rain near your home — here\'s how that compares to what your lawn needs.');
    expect(after.text).toContain('About 0.42" of rain fell near your home last week. This time of year your St. Augustine needs roughly');
    // The only body change for a known grass is the target row's "your".
    expect(after.text.replace('Weekly target for your St. Augustine', 'Weekly target for St. Augustine')).toBe(before.text);
  });

  test('no grass type on file: "Weekly target for your lawn"', () => {
    const out = render(migrated(), setupPayload({ grassType: null }));
    expect(out.text).toContain('Weekly target for your lawn');
    expect(out.text).not.toContain('Weekly target for lawn');
  });

  test('the old sender (migration ahead of the deploy) degrades to a shorter email, never a broken one', () => {
    const payload = setupPayload({ rainfallInches7d: 0 });
    delete payload.rain_sentence;
    delete payload.rain_preview;
    const out = render(migrated(), payload);
    expect(out.previewText).toBe('Here\'s how that compares to what your lawn needs.');
    expect(out.text).toContain('This time of year your St. Augustine needs roughly');
    expect(out.text).not.toMatch(/\{\{|About 0"|fell near your home last week/);
    expect(out.missingPayload).toEqual([]);
  });

  test('a rain amount that rounds to zero is a dry week; a hundredth is not', () => {
    expect(setupPayload({ rainfallInches7d: 0.004 }).rain_sentence).toBe('No measurable rain fell near your home last week.');
    expect(setupPayload({ rainfallInches7d: 0.01 }).rain_sentence).toBe('About 0.01" of rain fell near your home last week.');
  });

  test('confirm_schedule carries the preview phrase; the add-water deficit lead names a dry week', () => {
    const confirm = buildWeeklyEmailDecision({ ...BASE, rainfallInches7d: 0, irrigationRunMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], irrigationSystemType: ['spray'] });
    expect(confirm.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
    expect(confirm.payload.rain_preview).toBe('No measurable rain near your home.');
    const dry = buildWeeklyEmailDecision({ ...BASE, rainfallInches7d: 0, forecastRainInches: 0, irrigationInchesPerWeek: 0.25 });
    expect(dry.templateKey).toBe(TEMPLATE_ADD_WATER);
    expect(dry.payload.summary_line).toMatch(/^There was no measurable rain near your home last week, so with your irrigation schedule \(0\.25" per week\) your lawn got about 0\.25" of water/);
    const light = buildWeeklyEmailDecision({ ...BASE, rainfallInches7d: 0.1, forecastRainInches: 0, irrigationInchesPerWeek: 0.25 });
    expect(light.payload.summary_line).toMatch(/^Rain was light near your home last week \(0\.1"\), so with your irrigation schedule/);
  });
});

// Minimal knex double: only what publishCopy touches.
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
      async select() { return rows.filter(match); },
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

describe('publishCopy', () => {
  const fixture = ({ allowed = ['first_name', 'grass_label', 'rain_last_week', 'target_inches', 'schedule_ask'], preview = LIVE_PREVIEW, blocks = LIVE_BLOCKS } = {}) => ({
    email_templates: [{ id: 't1', template_key: TEMPLATE_SETUP_SCHEDULE, active_version_id: 'v1', allowed_variables: JSON.stringify(allowed), optional_variables: '["schedule_ask"]' }],
    email_template_versions: [{
      id: 'v1', template_id: 't1', version_number: 6, status: 'active', subject: 'S', preview_text: preview,
      blocks: JSON.stringify(blocks), text_body: null,
    }],
    // pg hands back a jsonb payload as an object.
    email_template_fixtures: [{ id: 'f1', template_id: 't1', payload: { first_name: 'Sample', rain_last_week: '0.42' } }],
  });

  beforeEach(() => recordAuditEvent.mockClear());

  test('publishes a new active version, archives the old one, allows both variables as optional, fills the fixture, audits', async () => {
    const db = fixture();
    expect(await publishCopy(fakeKnex(db), TEMPLATE_SETUP_SCHEDULE)).toBe('published');
    const [old, next] = db.email_template_versions;
    expect(old.status).toBe('archived');
    expect(next).toMatchObject({ version_number: 7, status: 'active', subject: 'S', text_body: null });
    expect(next.preview_text).toBe('{{rain_preview}} Here\'s how that compares to what your lawn needs.');
    expect(JSON.parse(next.blocks)[1].content.startsWith('{{rain_sentence}} This time of year')).toBe(true);
    const tpl = db.email_templates[0];
    expect(tpl.active_version_id).toBe(next.id);
    expect(JSON.parse(tpl.allowed_variables)).toEqual(['first_name', 'grass_label', 'rain_last_week', 'target_inches', 'schedule_ask', 'rain_preview', 'rain_sentence']);
    expect(JSON.parse(tpl.optional_variables)).toEqual(['schedule_ask', 'rain_preview', 'rain_sentence']);
    expect(tpl.required_variables).toBeUndefined(); // never touched
    expect(JSON.parse(db.email_template_fixtures[0].payload)).toEqual({ first_name: 'Sample', rain_last_week: '0.42', ...FIXTURE_VALUES });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'email_template.publish',
      resource_id: 't1',
      metadata: {
        template_key: TEMPLATE_SETUP_SCHEDULE, from_version_id: 'v1', to_version_id: next.id, to_version_number: 7,
        added_variables: ['rain_preview', 'rain_sentence'],
      },
    });
    const { changes } = recordAuditEvent.mock.calls[0][0].metadata;
    expect(Object.keys(changes)).toEqual(['preview_text', 'blocks']);
    expect(changes.preview_text).toEqual({ before: LIVE_PREVIEW, after: next.preview_text });
    expect(changes.blocks).toEqual({ before: LIVE_BLOCKS, after: JSON.parse(next.blocks) });
  });

  test('a re-run publishes nothing', async () => {
    const db = fixture();
    const k = fakeKnex(db);
    await publishCopy(k, TEMPLATE_SETUP_SCHEDULE);
    expect(await publishCopy(k, TEMPLATE_SETUP_SCHEDULE)).toBe('already');
    expect(db.email_template_versions).toHaveLength(2);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('an empty or missing allowlist (no restriction) stays empty, a listed variable is not doubled; a staff-reworded template is left alone', async () => {
    for (const allowed of [[], null]) {
      const open = fixture({ allowed });
      expect(await publishCopy(fakeKnex(open), TEMPLATE_SETUP_SCHEDULE)).toBe('published');
      expect(JSON.parse(open.email_templates[0].allowed_variables)).toEqual([]);
    }
    const listed = fixture({ allowed: ['first_name', 'rain_preview'] });
    await publishCopy(fakeKnex(listed), TEMPLATE_SETUP_SCHEDULE);
    expect(JSON.parse(listed.email_templates[0].allowed_variables)).toEqual(['first_name', 'rain_preview', 'rain_sentence']);
    const reworded = fixture({ preview: 'Your rain this week, {{first_name}}', blocks: [{ type: 'paragraph', content: 'Hello' }] });
    expect(await publishCopy(fakeKnex(reworded), TEMPLATE_SETUP_SCHEDULE)).toBe('already');
    expect(reworded.email_template_versions).toHaveLength(1);
  });

  test('a missing template is left alone', async () => {
    expect(await publishCopy(fakeKnex({ email_templates: [], email_template_versions: [], email_template_fixtures: [] }), TEMPLATE_SETUP_SCHEDULE)).toBe('missing');
  });
});
