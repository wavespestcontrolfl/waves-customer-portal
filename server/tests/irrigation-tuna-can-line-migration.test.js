/**
 * Tuna-can line in the weekly irrigation setup email (owner 2026-11-01). Migration
 * 20261101140000_irrigation_tuna_can_line adds ONE paragraph to ONE template,
 * irrigation.weekly_setup_schedule, right after the setup callout. These tests render through the
 * real template renderer and pin the placement, the exact copy, exactly-once publishing and that
 * no other template is touched.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.raw = jest.fn((e) => e); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261101140000_irrigation_tuna_can_line');
const setup = require('../models/migrations/20260801200000_seed_irrigation_setup_email_templates');
const { buildWeeklyEmailDecision, TEMPLATE_SETUP_SCHEDULE } = require('../services/irrigation-weekly-email');

const {
  TEMPLATE_KEY, AUDIT_ACTION, TUNA_CAN_LINE, withLine, withLineText, publishLine,
} = migration.__private;

const COPY = 'Not sure how much your sprinklers put down? Set a few empty tuna cans in one zone, run it for 15 minutes, and measure the water in the cans with a ruler. Reply with that number and how long you run each zone, and we\'ll set up your weekly amount.';

// The live layout of the setup_schedule email: the seed, with the callout swapped for {{schedule_ask}}
// (20260825000001) and the rain sentence and target label of 20261026230000.
const LIVE_BLOCKS = [
  { type: 'heading', content: 'Your weekly lawn water check-in, {{first_name}}' },
  { type: 'paragraph', content: '{{rain_sentence}} This time of year your {{grass_label}} needs roughly {{target_inches}}" of water a week — rain and watering counted together.' },
  { type: 'details', rows: [{ label: 'Rain at your home last week', value: '{{rain_last_week}}"' }, { label: 'Weekly target for your {{grass_label}}', value: '{{target_inches}}" per week' }] },
  { type: 'callout', content: '{{schedule_ask}}' },
  { type: 'paragraph', content: '{{forecast_line}}' },
  { type: 'cta', label: 'ADD MY WATERING SCHEDULE', url_variable: 'customer_portal_url' },
  { type: 'small_note', content: 'This check-in is based on rainfall.' },
  { type: 'signature', content: '— The Waves Team' },
];
const LIVE_PREVIEW = '{{rain_preview}} Here\'s how that compares to what your lawn needs.';

const setupTemplate = () => {
  const t = setup.TEMPLATES.find((x) => x.key === TEMPLATE_SETUP_SCHEDULE);
  const row = { id: 'tmpl-setup', ...setup.__private.templateRow(t) };
  row.allowed_variables = [...JSON.parse(row.allowed_variables), 'schedule_ask', 'rain_sentence', 'rain_preview', 'rain_source_note'];
  row.required_variables = JSON.parse(row.required_variables);
  return row;
};
const version = (over = {}) => ({
  id: 'v', subject: 'S', preview_text: LIVE_PREVIEW, blocks: withLine(LIVE_BLOCKS), text_body: null, ...over,
});
const render = (v, payload) => EmailTemplates.renderTemplate({ template: setupTemplate(), version: v, payload });
const payload = () => {
  const d = buildWeeklyEmailDecision({
    firstName: 'Sam', grassType: 'st_augustine', weekEnding: '2026-11-01', et0Inches: 1.2,
    rainfallInches7d: 0.42, forecastRainInches: 3.08, irrigationSystem: true, irrigationInchesPerWeek: null,
  });
  expect(d.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
  return d.payload;
};

describe('the line', () => {
  test('is the owner-approved copy, word for word, and targets only the schedule-needed template', () => {
    expect(TUNA_CAN_LINE).toBe(COPY);
    expect(TEMPLATE_KEY).toBe('irrigation.weekly_setup_schedule');
    expect(TEMPLATE_KEY).toBe(TEMPLATE_SETUP_SCHEDULE);
  });

  test('the audit action fits audit_log.action varchar(96)', () => {
    expect(AUDIT_ACTION.length).toBeLessThanOrEqual(96);
  });

  test('sits right after the setup callout, before the forecast line and the button', () => {
    const blocks = withLine(LIVE_BLOCKS);
    expect(blocks).toHaveLength(LIVE_BLOCKS.length + 1);
    expect(blocks[3]).toEqual({ type: 'callout', content: '{{schedule_ask}}' });
    expect(blocks[4]).toEqual({ type: 'paragraph', content: COPY });
    expect(blocks[5]).toEqual({ type: 'paragraph', content: '{{forecast_line}}' });
    expect(blocks[6].type).toBe('cta');
    // Every other block is as it was.
    expect([...blocks.slice(0, 4), ...blocks.slice(5)]).toEqual(LIVE_BLOCKS);
  });

  test('a re-run, a template with no callout, or unusable blocks gives null (nothing to publish)', () => {
    expect(withLine(withLine(LIVE_BLOCKS))).toBeNull();
    expect(withLine(LIVE_BLOCKS.filter((b) => b.type !== 'callout'))).toBeNull();
    expect(withLine('not json')).toBeNull();
    expect(withLine(null)).toBeNull();
  });

  test('a staff-authored text body gets the line after the schedule-ask paragraph; no body stays no body', () => {
    const text = 'Hi {{first_name}}\n\n{{schedule_ask}}\n\n{{forecast_line}}\n\n— The Waves Team';
    expect(withLineText(text)).toBe(`Hi {{first_name}}\n\n{{schedule_ask}}\n\n${COPY}\n\n{{forecast_line}}\n\n— The Waves Team`);
    expect(withLineText(null)).toBeNull();
    expect(withLineText('  ')).toBe('  ');
    expect(withLineText(`x\n\n${COPY}`)).toBe(false);
    expect(withLineText('Hello, nothing to anchor on')).toBe(false);
  });
});

describe('rendered email', () => {
  test('HTML and text both carry the line, in order, with no placeholder or missing-variable refusal', () => {
    const v = version();
    const p = payload();
    const out = render(v, p);
    expect(p.schedule_ask).toBeTruthy();
    expect(out.missingPayload).toEqual([]);
    expect(out.text).toContain(COPY);
    // The apostrophe is escaped in HTML.
    expect(out.html).toContain(COPY.replace("we'll", 'we&#39;ll'));
    const at = out.text.indexOf(COPY);
    const ask = out.text.indexOf(p.schedule_ask);
    expect(ask).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(ask);
    expect(at).toBeLessThan(out.text.indexOf('ADD MY WATERING SCHEDULE'));
    for (const field of [out.text, out.html, out.previewText]) expect(field).not.toMatch(/\{\{|undefined|\[object/);
    // No new variable: the library's own validation is clean.
    const validation = EmailTemplates.validationFor(setupTemplate(), v);
    expect(validation).toMatchObject({ ok: true, disallowed_variables: [], missing_required_in_template: [] });
    expect(validation.referenced_variables).not.toContain('tuna_can_line');
  });

  test('a customer with no schedule inputs on file still gets the line (the ask changes, the line does not)', () => {
    const p = payload();
    p.schedule_ask = 'Add your minutes per zone under Irrigation in your portal.';
    const out = render(version(), p);
    expect(out.text).toContain(COPY);
    expect(out.text).toContain('Add your minutes per zone');
  });

  test('without the migration the email has no tuna-can line', () => {
    const out = render(version({ blocks: LIVE_BLOCKS }), payload());
    expect(out.text).not.toMatch(/tuna/i);
  });
});

// Minimal knex double: only what publishLine touches.
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
  knex.schema = { hasTable: async (t) => t in db };
  return knex;
}

describe('publishLine', () => {
  const fixture = ({ blocks = LIVE_BLOCKS, text_body = null, key = TEMPLATE_KEY } = {}) => ({
    email_templates: [{
      id: 't1', template_key: key, active_version_id: 'v1',
      allowed_variables: '["first_name"]', optional_variables: '["schedule_ask"]', required_variables: '["first_name"]',
    }],
    email_template_versions: [{
      id: 'v1', template_id: 't1', version_number: 7, status: 'active', subject: 'S', preview_text: LIVE_PREVIEW,
      blocks: JSON.stringify(blocks), text_body,
    }],
    email_template_fixtures: [{ id: 'f1', template_id: 't1', payload: { first_name: 'Sample' } }],
  });

  beforeEach(() => recordAuditEvent.mockClear());

  test('publishes a new active version, archives the old one, changes only the blocks, audits the change', async () => {
    const db = fixture();
    expect(await publishLine(fakeKnex(db))).toBe('published');
    const [old, next] = db.email_template_versions;
    expect(old.status).toBe('archived');
    expect(next).toMatchObject({ version_number: 8, status: 'active', subject: 'S', preview_text: LIVE_PREVIEW, text_body: null });
    expect(JSON.parse(next.blocks)).toEqual(withLine(LIVE_BLOCKS));
    const tpl = db.email_templates[0];
    expect(tpl.active_version_id).toBe(next.id);
    // No new variable: allowlists, required list and fixtures are never touched.
    expect(tpl.allowed_variables).toBe('["first_name"]');
    expect(tpl.optional_variables).toBe('["schedule_ask"]');
    expect(tpl.required_variables).toBe('["first_name"]');
    expect(db.email_template_fixtures[0].payload).toEqual({ first_name: 'Sample' });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    const call = recordAuditEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      action: AUDIT_ACTION, resource_id: 't1', critical: true,
      metadata: { template_key: TEMPLATE_KEY, from_version_id: 'v1', to_version_id: next.id, to_version_number: 8 },
    });
    expect(call.action.length).toBeLessThanOrEqual(96);
    expect(Object.keys(call.metadata.changes)).toEqual(['blocks']);
    expect(call.metadata.changes.blocks).toEqual({ before: LIVE_BLOCKS, after: JSON.parse(next.blocks) });
  });

  test('a re-run publishes nothing: no new version, no second audit row', async () => {
    const db = fixture();
    const k = fakeKnex(db);
    await publishLine(k);
    expect(await publishLine(k)).toBe('already');
    expect(db.email_template_versions).toHaveLength(2);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('a staff-authored text body gets the line too, so HTML and text agree; one that cannot be placed leaves the version whole', async () => {
    const withText = fixture({ text_body: 'Hi\n\n{{schedule_ask}}\n\nBye' });
    expect(await publishLine(fakeKnex(withText))).toBe('published');
    expect(withText.email_template_versions[1].text_body).toBe(`Hi\n\n{{schedule_ask}}\n\n${COPY}\n\nBye`);
    expect(Object.keys(recordAuditEvent.mock.calls[0][0].metadata.changes)).toEqual(['blocks', 'text_body']);

    recordAuditEvent.mockClear();
    const unplaceable = fixture({ text_body: 'A fully custom text body' });
    expect(await publishLine(fakeKnex(unplaceable))).toBe('skipped');
    expect(unplaceable.email_template_versions).toHaveLength(1);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('a version with no callout is skipped; a missing template is missing', async () => {
    const noCallout = fixture({ blocks: LIVE_BLOCKS.filter((b) => b.type !== 'callout') });
    expect(await publishLine(fakeKnex(noCallout))).toBe('skipped');
    expect(noCallout.email_template_versions).toHaveLength(1);
    expect(await publishLine(fakeKnex({ email_templates: [], email_template_versions: [] }))).toBe('missing');
  });

  test('up() touches only irrigation.weekly_setup_schedule: another template is left alone', async () => {
    const other = fixture({ key: 'irrigation.weekly_setup_system' });
    await migration.up(fakeKnex(other));
    expect(other.email_template_versions).toHaveLength(1);
    expect(other.email_templates[0].active_version_id).toBe('v1');
    expect(recordAuditEvent).not.toHaveBeenCalled();

    const target = fixture();
    await migration.up(fakeKnex(target));
    expect(target.email_template_versions).toHaveLength(2);
  });

  test('up() does nothing where email_templates does not exist; down() is a no-op', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    const db = fixture();
    await migration.down(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(1);
    expect(db.email_templates[0].active_version_id).toBe('v1');
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(2);
    expect(db.email_templates[0].active_version_id).toBe(db.email_template_versions[1].id);
  });
});
