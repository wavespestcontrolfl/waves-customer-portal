/**
 * The mowing-days ask in every weekly irrigation email (owner 2026-11-02). The sender fills
 * {{mowing_ask}} / {{mowing_ask_url}} only while autoDispatchMowingDaysMode() is 'true', the
 * customer has nothing saved under Mowing, the ask is due (first 3 sends, then every 27+ days) and
 * the customer is on a recurring lawn program; migration 20261102120000_irrigation_mowing_ask_line
 * places a paragraph and a small text link in each weekly template. These tests pin the predicate,
 * the cadence, every payload path, the replay freeze, the migration's placement and exactly-once
 * publishing, and the rendered email with the line on and off.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.raw = jest.fn((e) => e); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../config/feature-gates', () => ({
  gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true), autoDispatchMowingDaysMode: jest.fn(() => 'off'),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const db = require('../models/db');
const { autoDispatchMowingDaysMode } = require('../config/feature-gates');
const { recordAuditEvent } = require('../services/audit-log');
const EmailTemplates = require('../services/email-template-library');
const { portalUrl } = require('../utils/portal-url');
const migration = require('../models/migrations/20261102120000_irrigation_mowing_ask_line');
const advice = require('../models/migrations/20260702000001_seed_irrigation_weekly_email_templates');
const setup = require('../models/migrations/20260801200000_seed_irrigation_setup_email_templates');
const planSeed = require('../models/migrations/20260828000004_seed_irrigation_week_plan_email_template');
const guides = require('../models/migrations/20260907000010_irrigation_guide_resources');
const crew = require('../models/migrations/20261022190000_irrigation_mowing_crew_note');
const rainReport = require('../models/migrations/20261024223000_seed_irrigation_rain_report_template');
const dryWeek = require('../models/migrations/20261026230000_irrigation_dry_week_copy');
const tuna = require('../models/migrations/20261101140000_irrigation_tuna_can_line');
const {
  buildWeeklyEmailDecision, weeklyInputsForCustomer, replayWeekPlanForCustomer,
  MOWING_ASK, WEEKLY_TEMPLATES, mowingAskVariables, mowingNothingSaved, loadMowingAskHistory, mowingAskDue, mowingAskLive,
  SETUP_ASK_FREE_SENDS, SETUP_ASK_SPACING_DAYS,
  TEMPLATE_SETUP_SCHEDULE, TEMPLATE_SETUP_SYSTEM, TEMPLATE_RAIN_REPORT, TEMPLATE_CONFIRM_SCHEDULE,
  TEMPLATE_CUT_BACK, TEMPLATE_ADD_WATER, TEMPLATE_ON_TRACK, TEMPLATE_WEEK_PLAN,
} = require('../services/irrigation-weekly-email');

const {
  MIGRATION_ID, MIGRATION_MARKER, AUDIT_ACTION, TEMPLATE_KEYS, ASK_BLOCK, LINK_BLOCK, ASK_TEXT, FIXTURE_VALUES,
  withAsk, withAskText, publishAsk,
} = migration.__private;

const COPY = "When does your lawn get mowed? Mowing right before or right after a lawn treatment can undo it. Add your mowing days under Mowing in your portal, and we'll plan your lawn treatments around them.";
const COPY_HTML = COPY.replace("we'll", 'we&#39;ll');
const PROPERTY_TAB = portalUrl('/?tab=property');
const GUIDES_HEADING = 'Helpful guides from the Waves blog';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T12:05:00Z');
const count = (haystack, needle) => haystack.split(needle).length - 1;

describe('the line', () => {
  test('is the owner-approved copy, word for word, in the sender and the editor fixture', () => {
    expect(MOWING_ASK).toBe(COPY);
    expect(FIXTURE_VALUES.mowing_ask).toBe(COPY);
    expect(ASK_BLOCK).toEqual({ type: 'paragraph', content: '{{mowing_ask}}' });
    expect(LINK_BLOCK).toEqual({ type: 'cta', variant: 'link', label: 'Add my mowing days', url_variable: 'mowing_ask_url' });
    expect(ASK_TEXT).toBe('{{mowing_ask}} {{mowing_ask_url}}');
  });

  test('the sender and the migration cover the same eight weekly templates', () => {
    const all = [TEMPLATE_CUT_BACK, TEMPLATE_ADD_WATER, TEMPLATE_ON_TRACK, TEMPLATE_SETUP_SCHEDULE, TEMPLATE_SETUP_SYSTEM, TEMPLATE_RAIN_REPORT, TEMPLATE_CONFIRM_SCHEDULE, TEMPLATE_WEEK_PLAN].sort();
    expect([...WEEKLY_TEMPLATES].sort()).toEqual(all);
    expect([...TEMPLATE_KEYS].sort()).toEqual(all);
  });

  test('both variables are filled together or not at all', () => {
    expect(mowingAskVariables(true)).toEqual({ mowing_ask: COPY, mowing_ask_url: PROPERTY_TAB });
    for (const off of [false, undefined, null, 'true']) expect(mowingAskVariables(off)).toEqual({ mowing_ask: '', mowing_ask_url: '' });
  });
});

describe('mowingNothingSaved', () => {
  test.each([
    ['no prefs row at all', {}],
    ['nulls', { mowing_days: null, mowing_time_of_day: null, mowing_notes: null }],
    ['an empty day list', { mowing_days: [] }],
    ['an empty JSON-text day list', { mowing_days: '[]' }],
    ['unparseable or unknown days', { mowing_days: 'not json' }],
    ['day names outside the list', { mowing_days: ['Someday'] }],
    ['blank time and notes', { mowing_time_of_day: '  ', mowing_notes: ' \n ' }],
  ])('%s: nothing saved', (_label, prefs) => {
    expect(mowingNothingSaved(prefs)).toBe(true);
  });

  test.each([
    ['a day', { mowing_days: ['Sat'] }],
    ['a day as JSON text', { mowing_days: '["Tue"]' }],
    ['a time of day only', { mowing_time_of_day: 'morning' }],
    ['notes only', { mowing_notes: 'Every other Friday' }],
  ])('%s: something saved', (_label, prefs) => {
    expect(mowingNothingSaved(prefs)).toBe(false);
  });
});

describe('mowingAskDue (cadence)', () => {
  test('the first three sends are always due', () => {
    expect(SETUP_ASK_FREE_SENDS).toBe(3);
    for (const sends of [0, 1, 2]) {
      expect(mowingAskDue({ count: sends, lastAskAt: new Date(NOW.getTime() - DAY) }, NOW)).toBe(true);
    }
  });

  test('after three, due only 27+ days after the last ask', () => {
    expect(SETUP_ASK_SPACING_DAYS).toBe(27);
    const at = (days) => ({ count: 3, lastAskAt: new Date(NOW.getTime() - days * DAY) });
    expect(mowingAskDue(at(7), NOW)).toBe(false);
    expect(mowingAskDue(at(26.9), NOW)).toBe(false);
    expect(mowingAskDue(at(27), NOW)).toBe(true);
    expect(mowingAskDue({ count: 9, lastAskAt: new Date(NOW.getTime() - 28 * DAY) }, NOW)).toBe(true);
  });

  test('an unreadable history holds the line back (unlike the setup ask)', () => {
    expect(mowingAskDue(null, NOW)).toBe(false);
    expect(mowingAskDue(undefined, NOW)).toBe(false);
  });
});

function fakeConn(result, calls) {
  const q = {};
  ['where', 'whereIn', 'whereNotNull', 'whereNot', 'whereRaw', 'count', 'max'].forEach((m) => {
    q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
  });
  q.first = jest.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
  return jest.fn(() => q);
}

describe('loadMowingAskHistory', () => {
  test('counts SENT weekly emails (any weekly template) that carried the ask, excluding this week', async () => {
    const calls = [];
    const at = new Date('2026-10-26T11:02:00Z');
    const h = await loadMowingAskHistory({ customerId: 'c1', weekEnding: '2026-11-01', conn: fakeConn({ count: '2', lastAskAt: at }, calls) });
    expect(h).toEqual({ count: 2, lastAskAt: at });
    expect(calls).toContainEqual(['where', { recipient_type: 'customer', recipient_id: 'c1' }]);
    expect(calls).toContainEqual(['whereIn', 'template_key', WEEKLY_TEMPLATES]);
    expect(calls).toContainEqual(['whereNotNull', 'sent_at']);
    expect(calls).toContainEqual(['whereNot', 'trigger_event_id', 'irrigation.weekly:c1:2026-11-01']);
    expect(calls).toContainEqual(['whereRaw', "COALESCE(payload_snapshot->>'mowing_ask', '') <> ''"]);
  });

  test('no rows reads as zero sends; a read error is null', async () => {
    expect(await loadMowingAskHistory({ customerId: 'c1', weekEnding: '2026-11-01', conn: fakeConn(undefined, []) })).toEqual({ count: 0, lastAskAt: null });
    expect(await loadMowingAskHistory({ customerId: 'c1', weekEnding: '2026-11-01', conn: fakeConn(new Error('boom'), []) })).toBeNull();
  });
});

describe('mowingAskLive (the sweep\'s answer for a new decision)', () => {
  const customer = { id: 'cust-mow', mowing_days: null, mowing_time_of_day: null, mowing_notes: null };
  // email_messages answers the history; customers answers the recurring-lawn check.
  function routeDb({ history = { count: '0', lastAskAt: null }, lawn = { id: 'cust-mow' } } = {}) {
    db.mockImplementation((table) => {
      const q = {};
      ['where', 'whereIn', 'whereNotNull', 'whereNot', 'whereRaw', 'count', 'max', 'whereExists', 'orWhereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
      const value = String(table).startsWith('email_messages') ? history : lawn;
      q.first = jest.fn(() => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)));
      return q;
    });
  }
  const live = (c = customer) => mowingAskLive(c, { weekEnding: '2026-11-01', now: NOW });

  beforeEach(() => { db.mockReset(); routeDb(); });
  afterAll(() => autoDispatchMowingDaysMode.mockReturnValue('off'));

  test('the switch: only \'true\' shows the line; off and shadow read nothing', async () => {
    for (const mode of ['off', 'shadow']) {
      autoDispatchMowingDaysMode.mockReturnValue(mode);
      expect(await live()).toBe(false);
    }
    expect(db).not.toHaveBeenCalled();
    autoDispatchMowingDaysMode.mockReturnValue('true');
    expect(await live()).toBe(true);
  });

  test('something saved under Mowing: no line, no history read', async () => {
    autoDispatchMowingDaysMode.mockReturnValue('true');
    expect(await live({ ...customer, mowing_notes: 'Thursdays' })).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('cadence from the history; an unreadable history means no line', async () => {
    autoDispatchMowingDaysMode.mockReturnValue('true');
    routeDb({ history: { count: '3', lastAskAt: new Date(NOW.getTime() - 7 * DAY) } });
    expect(await live()).toBe(false);
    routeDb({ history: { count: '3', lastAskAt: new Date(NOW.getTime() - 27 * DAY) } });
    expect(await live()).toBe(true);
    routeDb({ history: new Error('relation unavailable') });
    expect(await live()).toBe(false);
  });

  test('a customer in the audience only through the irrigation_email tag (no lawn program) gets no line', async () => {
    autoDispatchMowingDaysMode.mockReturnValue('true');
    routeDb({ lawn: null });
    expect(await live()).toBe(false);
    routeDb({ lawn: new Error('timeout') });
    expect(await live()).toBe(false);
  });
});

// Every payload path the sweep can produce.
const BASE = { firstName: 'Sam', grassType: 'st_augustine', weekEnding: '2026-11-01', et0Inches: 1.2, rainfallInches7d: 0.42, forecastRainInches: 0.4 };
const PLAN_CUSTOMER = {
  id: 'fixture-customer', first_name: 'Sample', email: 'sample@example.invalid',
  address_line1: '100 Fixture Lane', address_line2: 'Unit 1', city: 'Sarasota', zip: '34236',
  latitude: 27.3, longitude: -82.5, grass_type: 'st_augustine', turf_county: 'Sarasota',
  irrigation_run_minutes: 20, watering_days: ['Mon', 'Wed', 'Fri', 'Sun'],
  irrigation_system_type: ['spray'], irrigation_system: true, irrigation_inches_per_week: null, rain_sensor: false,
};
const PLAN_NOW = new Date('2026-09-07T14:05:00Z');
function planDecision(mowingAsk, customer = PLAN_CUSTOMER) {
  return buildWeeklyEmailDecision({
    ...weeklyInputsForCustomer(customer, {
      weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 },
      weekPlanEnabled: true, planWeekEnd: '2026-09-13', now: PLAN_NOW, mowingAsk,
    }),
    forecastRainInches: 0.3, forecastEt0Inches: 1.6,
  });
}
const PATHS = [
  [TEMPLATE_SETUP_SCHEDULE, (m) => buildWeeklyEmailDecision({ ...BASE, irrigationSystem: true, irrigationInchesPerWeek: null, mowingAsk: m })],
  [TEMPLATE_SETUP_SYSTEM, (m) => buildWeeklyEmailDecision({ ...BASE, irrigationSystem: null, irrigationInchesPerWeek: null, mowingAsk: m })],
  [TEMPLATE_RAIN_REPORT, (m) => buildWeeklyEmailDecision({ ...BASE, irrigationSystem: true, irrigationInchesPerWeek: null, setupAskQuiet: true, mowingAsk: m })],
  [TEMPLATE_CONFIRM_SCHEDULE, (m) => buildWeeklyEmailDecision({ ...BASE, turfIrrigationInchesPerWeek: 1, mowingAsk: m })],
  [TEMPLATE_CUT_BACK, (m) => buildWeeklyEmailDecision({ ...BASE, rainfallInches7d: 2.1, irrigationInchesPerWeek: 1, mowingAsk: m })],
  [TEMPLATE_ADD_WATER, (m) => buildWeeklyEmailDecision({ ...BASE, rainfallInches7d: 0, forecastRainInches: 0, irrigationInchesPerWeek: 0.25, mowingAsk: m })],
  [TEMPLATE_ON_TRACK, (m) => buildWeeklyEmailDecision({ ...BASE, rainfallInches7d: 0.25, et0Inches: 1.6, irrigationInchesPerWeek: 1, mowingAsk: m })],
  [TEMPLATE_WEEK_PLAN, (m) => planDecision(m)],
];

describe('payload: every weekly email carries the two variables', () => {
  test.each(PATHS)('%s', (key, decide) => {
    const on = decide(true);
    const off = decide(undefined);
    expect(on.templateKey).toBe(key);
    expect(off.templateKey).toBe(key);
    expect(on.payload).toMatchObject({ mowing_ask: COPY, mowing_ask_url: PROPERTY_TAB });
    // The link goes where the setup button goes: the portal property tab.
    expect(on.payload.mowing_ask_url).toBe(on.payload.customer_portal_url);
    expect(off.payload).toMatchObject({ mowing_ask: '', mowing_ask_url: '' });
    // Nothing else in the email moves.
    const { mowing_ask: _a, mowing_ask_url: _b, ...restOn } = on.payload;
    const { mowing_ask: _c, mowing_ask_url: _d, ...restOff } = off.payload;
    expect(restOn).toEqual(restOff);
  });
});

describe('replay freezes the answer', () => {
  test('a plan decided with the line replays to the identical payload, even after the customer saves mowing days', () => {
    const decision = planDecision(true);
    expect(decision.weekPlan).toBeTruthy();
    expect(decision.decisionInputs.mowingAsk).toBe(true);
    const snapshot = JSON.parse(JSON.stringify({
      weekEnding: '2026-09-06', planAsOf: PLAN_NOW, decisionInputs: decision.decisionInputs, plan: decision.weekPlan, restriction: decision.restriction,
    }));
    for (const current of [PLAN_CUSTOMER, { ...PLAN_CUSTOMER, mowing_days: ['Sat'], mowing_time_of_day: 'morning' }]) {
      const replay = replayWeekPlanForCustomer(snapshot, current);
      expect(replay).not.toBeNull();
      expect(replay.payload).toEqual(decision.payload);
      expect(replay.payload.mowing_ask).toBe(COPY);
    }
  });

  test('without the line the frozen inputs keep their old shape (no mowingAsk key), so the plan hash is unchanged', () => {
    const off = planDecision(undefined);
    const on = planDecision(true);
    expect('mowingAsk' in off.decisionInputs).toBe(false);
    const { mowingAsk: _m, ...onRest } = on.decisionInputs;
    expect(onRest).toEqual(off.decisionInputs);
    expect(on.weekPlan).toEqual(off.weekPlan);
    expect('mowingAsk' in weeklyInputsForCustomer(PLAN_CUSTOMER, { weekEnding: '2026-09-06', weekWeather: { rainInches: 0.6, et0Inches: 1.6 }, weekPlanEnabled: false, planWeekEnd: '2026-09-13', now: PLAN_NOW })).toBe(false);
  });

  test('an old snapshot without the key replays with no line', () => {
    const decision = planDecision(undefined);
    const snapshot = JSON.parse(JSON.stringify({ weekEnding: '2026-09-06', planAsOf: PLAN_NOW, decisionInputs: decision.decisionInputs, plan: decision.weekPlan, restriction: decision.restriction }));
    const replay = replayWeekPlanForCustomer(snapshot, PLAN_CUSTOMER);
    expect(replay.payload).toMatchObject({ mowing_ask: '', mowing_ask_url: '' });
  });
});

// The live layout of each weekly template, rebuilt through the migrations that shaped it:
// seed → schedule-ask callout (20260825000001) → guide section (20260907000010) → crew note
// (20261022190000) → rain report copy of setup_system (20261024223000) → dry-week copy
// (20261026230000) → tuna-can line on setup_schedule (20261101140000).
function liveTemplates() {
  const rows = [];
  for (const mod of [advice, setup, planSeed]) {
    for (const t of mod.TEMPLATES) {
      const template = { id: `tmpl-${t.key}`, ...mod.__private.templateRow(t) };
      template.allowed_variables = JSON.parse(template.allowed_variables);
      template.required_variables = JSON.parse(template.required_variables);
      let blocks = t.blocks.map((b) => {
        if (b.type !== 'callout') return b;
        if (t.key === TEMPLATE_SETUP_SCHEDULE) return { type: 'callout', content: '{{schedule_ask}}' };
        if (t.key === TEMPLATE_CONFIRM_SCHEDULE) return { type: 'callout', content: '{{schedule_note}}' };
        return b;
      });
      blocks = crew.__private.withNote(guides.__private.updatedBlocks(blocks));
      rows.push({ key: t.key, template, subject: t.subject, preview: t.preview, blocks, previewPayload: mod.__private.PREVIEW_PAYLOAD });
    }
  }
  const system = rows.find((r) => r.key === TEMPLATE_SETUP_SYSTEM);
  rows.push({
    ...system,
    key: TEMPLATE_RAIN_REPORT,
    template: { ...system.template, id: 'tmpl-rain', template_key: TEMPLATE_RAIN_REPORT, default_cta_label: null, default_cta_url_variable: null },
    blocks: rainReport.__private.rainReportBlocks(system.blocks),
  });
  for (const r of rows) {
    r.blocks = dryWeek.__private.withBlocks(r.blocks);
    if (r.key === TEMPLATE_SETUP_SCHEDULE) r.blocks = tuna.__private.withLine(r.blocks);
  }
  return rows;
}
const migratedTemplate = (template) => ({ ...template, allowed_variables: [...template.allowed_variables, 'mowing_ask', 'mowing_ask_url', 'rain_sentence', 'rain_preview', 'schedule_ask', 'schedule_note'] });
const render = (r, blocks, payload, textBody = null) => EmailTemplates.renderTemplate({
  template: migratedTemplate(r.template),
  version: { id: 'v', subject: r.subject, preview_text: r.preview, blocks, text_body: textBody },
  payload,
});
const ON = { mowing_ask: COPY, mowing_ask_url: PROPERTY_TAB };
const OFF = { mowing_ask: '', mowing_ask_url: '' };

describe('migration placement, per template', () => {
  test('the fixtures cover every weekly template', () => {
    expect(liveTemplates().map((r) => r.key).sort()).toEqual([...TEMPLATE_KEYS].sort());
  });

  test.each(liveTemplates().map((r) => [r.key, r]))('%s', (key, r) => {
    const blocks = withAsk(r.blocks, key);
    expect(blocks).toHaveLength(r.blocks.length + 2);
    const at = blocks.findIndex((b) => b.content === '{{mowing_ask}}');
    expect(blocks.filter((b) => b.content === '{{mowing_ask}}')).toHaveLength(1);
    expect(blocks[at]).toEqual(ASK_BLOCK);
    expect(blocks[at + 1]).toEqual(LINK_BLOCK);
    if (key === TEMPLATE_SETUP_SCHEDULE) {
      // Right after the schedule ask (its tuna-can line stays with it), ahead of the forecast and the button.
      expect(blocks[at - 2]).toEqual({ type: 'callout', content: '{{schedule_ask}}' });
      expect(blocks[at - 1].content).toBe(tuna.__private.TUNA_CAN_LINE);
      expect(blocks[at + 2]).toEqual({ type: 'paragraph', content: '{{forecast_line}}' });
    } else {
      // Right before the "Helpful guides from the Waves blog" section.
      expect(blocks[at + 2]).toEqual({ type: 'heading', content: GUIDES_HEADING });
    }
    // Every other block is as it was, in order; a re-run changes nothing.
    expect([...blocks.slice(0, at), ...blocks.slice(at + 2)]).toEqual(r.blocks);
    expect(withAsk(blocks, key)).toBe(blocks);
  });

  test('setup_schedule without the tuna-can line: directly after the callout', () => {
    const blocks = [{ type: 'heading', content: 'h' }, { type: 'callout', content: '{{schedule_ask}}' }, { type: 'paragraph', content: '{{forecast_line}}' }];
    expect(withAsk(blocks, TEMPLATE_SETUP_SCHEDULE)).toEqual([blocks[0], blocks[1], ASK_BLOCK, LINK_BLOCK, blocks[2]]);
  });

  test('an office-edited body with no anchor: before the footer small print, else the signature, else the end', () => {
    const note = { type: 'small_note', content: 'This tip is based on rainfall.' };
    const sig = { type: 'signature', content: '— The Waves Team' };
    const p = { type: 'paragraph', content: 'Hello' };
    expect(withAsk([p, note, sig], TEMPLATE_ON_TRACK)).toEqual([p, ASK_BLOCK, LINK_BLOCK, note, sig]);
    expect(withAsk([p, sig, p], TEMPLATE_ON_TRACK)).toEqual([p, ASK_BLOCK, LINK_BLOCK, sig, p]);
    expect(withAsk([p], TEMPLATE_SETUP_SCHEDULE)).toEqual([p, ASK_BLOCK, LINK_BLOCK]);
  });
});

describe('a staff-authored plain-text body', () => {
  const TUNA = tuna.__private.TUNA_CAN_LINE;
  test('setup_schedule: after the schedule ask paragraph and its tuna-can line', () => {
    expect(withAskText(`Hi {{first_name}}\n\n{{schedule_ask}}\n\n${TUNA}\n\n{{forecast_line}}`, TEMPLATE_SETUP_SCHEDULE))
      .toBe(`Hi {{first_name}}\n\n{{schedule_ask}}\n\n${TUNA}\n\n${ASK_TEXT}\n\n{{forecast_line}}`);
    expect(withAskText('Hi\n\n{{schedule_ask}}\n\nBye', TEMPLATE_SETUP_SCHEDULE)).toBe(`Hi\n\n{{schedule_ask}}\n\n${ASK_TEXT}\n\nBye`);
  });

  test('other templates: before the guides heading, else before the sign-off, else at the end', () => {
    expect(withAskText('Body\n\nHELPFUL GUIDES FROM THE WAVES BLOG\n\nGuide (https://www.wavespestcontrol.com/x/)', TEMPLATE_CUT_BACK))
      .toBe(`Body\n\n${ASK_TEXT}\n\nHELPFUL GUIDES FROM THE WAVES BLOG\n\nGuide (https://www.wavespestcontrol.com/x/)`);
    expect(withAskText('Body\n\nThis tip is based on rainfall.\n\n— The Waves Team', TEMPLATE_WEEK_PLAN)).toBe(`Body\n\n${ASK_TEXT}\n\nThis tip is based on rainfall.\n\n— The Waves Team`);
    expect(withAskText('Body only\n\n', TEMPLATE_ON_TRACK)).toBe(`Body only\n\n${ASK_TEXT}`);
  });

  test('no body stays no body; a body that already has it is left alone', () => {
    expect(withAskText(null, TEMPLATE_ON_TRACK)).toBeNull();
    expect(withAskText('  ', TEMPLATE_ON_TRACK)).toBe('  ');
    const done = `Body\n\n${ASK_TEXT}`;
    expect(withAskText(done, TEMPLATE_ON_TRACK)).toBe(done);
  });
});

describe('rendered email', () => {
  const askLines = (html) => html.split('\n').filter((line) => line.includes(COPY_HTML) || line.includes('>Add my mowing days</a>'));

  test.each(liveTemplates().map((r) => [r.key, r]))('%s: line on = the sentence and a property-tab link; line off = no trace', (key, r) => {
    const blocks = withAsk(r.blocks, key);
    const before = render(r, r.blocks, { ...r.previewPayload, ...OFF });
    const on = render(r, blocks, { ...r.previewPayload, ...ON });
    const off = render(r, blocks, { ...r.previewPayload, ...OFF });

    expect(count(on.html, COPY_HTML)).toBe(1);
    expect(on.html).toContain(`<a class="dm-link" href="${PROPERTY_TAB}" style="color:#0A7EC2;text-decoration:underline;">Add my mowing days</a>`);
    expect(count(on.text, COPY)).toBe(1);
    expect(on.text).toContain(`${COPY}\n\nAdd my mowing days: ${PROPERTY_TAB}`);
    // The two added lines are the only change; the primary button is untouched.
    expect(askLines(on.html)).toHaveLength(2);
    expect(on.html.split('\n').filter((line) => !askLines(on.html).includes(line)).join('\n')).toBe(before.html);
    expect(on.text.replace(`\n\n${COPY}\n\nAdd my mowing days: ${PROPERTY_TAB}`, '')).toBe(before.text);
    if (key !== TEMPLATE_SETUP_SCHEDULE) expect(on.html.indexOf(COPY_HTML)).toBeLessThan(on.html.indexOf(GUIDES_HEADING));
    expect(on.missingPayload).toEqual([]);
    expect(on.validation).toMatchObject({ disallowed_variables: [] });

    // Off: byte-identical to the email before the migration.
    expect(off.html).toBe(before.html);
    expect(off.text).toBe(before.text);
    expect(off.html).not.toMatch(/mowing days|When does your lawn get mowed/);
    expect(off.text).not.toMatch(/mowing days|When does your lawn get mowed/);
  });

  test('a staff text body: on carries the sentence and the link; off leaves only a blank line', () => {
    const r = liveTemplates().find((x) => x.key === TEMPLATE_ON_TRACK);
    const text = 'Body {{first_name}}\n\nHELPFUL GUIDES FROM THE WAVES BLOG\n\nGuide (https://www.wavespestcontrol.com/x/)';
    const migratedText = withAskText(text, TEMPLATE_ON_TRACK);
    const before = render(r, r.blocks, { ...r.previewPayload, ...OFF }, text);
    expect(render(r, r.blocks, { ...r.previewPayload, ...ON }, migratedText).text).toContain(`${COPY} ${PROPERTY_TAB}\n\nHELPFUL GUIDES`);
    const off = render(r, r.blocks, { ...r.previewPayload, ...OFF }, migratedText);
    expect(off.text.replace('\n\n \n\n', '\n\n')).toBe(before.text);
  });
});

// Minimal knex double: only what publishAsk touches.
function fakeKnex(tables) {
  let n = 100;
  const table = (name) => {
    const rows = tables[name];
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

describe('publishAsk', () => {
  const live = () => liveTemplates().find((r) => r.key === TEMPLATE_SETUP_SCHEDULE);
  const fixture = ({ allowed = ['first_name', 'schedule_ask'], blocks = live().blocks, textBody = null, template = {} } = {}) => ({
    email_templates: [{
      id: 't1', template_key: TEMPLATE_SETUP_SCHEDULE, active_version_id: 'v1', allowed_variables: allowed == null ? null : JSON.stringify(allowed),
      optional_variables: '["schedule_ask"]', default_cta_label: 'ADD MY WATERING SCHEDULE', default_cta_url_variable: 'customer_portal_url', ...template,
    }],
    email_template_versions: [{
      id: 'v1', template_id: 't1', version_number: 9, status: 'active', subject: 'S', preview_text: 'P',
      blocks: JSON.stringify(blocks), text_body: textBody,
    }],
    // pg hands back a jsonb payload as an object.
    email_template_fixtures: [{ id: 'f1', template_id: 't1', payload: { first_name: 'Sample', mowing_ask: 'kept' } }],
  });

  beforeEach(() => recordAuditEvent.mockClear());

  test('the audit action and any migration:<name>:<field> action fit audit_log.action varchar(96)', () => {
    expect(AUDIT_ACTION).toBe('email_template.publish');
    expect(AUDIT_ACTION.length).toBeLessThanOrEqual(96);
    for (const field of ['blocks', 'text_body', 'allowed_variables', 'optional_variables']) {
      expect(`migration:${MIGRATION_ID}:${field}`.length).toBeLessThanOrEqual(96);
    }
    expect(MIGRATION_MARKER).toBe('migration:20261102120000');
  });

  test('publishes a new active version, archives the old one, allows both variables as optional, fills fixtures, audits', async () => {
    const tables = fixture();
    expect(await publishAsk(fakeKnex(tables), TEMPLATE_SETUP_SCHEDULE)).toBe('published');
    const [old, next] = tables.email_template_versions;
    expect(old.status).toBe('archived');
    expect(next).toMatchObject({ version_number: 10, status: 'active', subject: 'S', preview_text: 'P', text_body: null });
    expect(JSON.parse(next.blocks)).toEqual(withAsk(live().blocks, TEMPLATE_SETUP_SCHEDULE));
    const tpl = tables.email_templates[0];
    expect(tpl.active_version_id).toBe(next.id);
    expect(JSON.parse(tpl.allowed_variables)).toEqual(['first_name', 'schedule_ask', 'mowing_ask', 'mowing_ask_url']);
    expect(JSON.parse(tpl.optional_variables)).toEqual(['schedule_ask', 'mowing_ask', 'mowing_ask_url']);
    expect(tpl.required_variables).toBeUndefined(); // never touched
    // A value the fixture already has wins.
    expect(JSON.parse(tables.email_template_fixtures[0].payload)).toEqual({ first_name: 'Sample', mowing_ask: 'kept', mowing_ask_url: FIXTURE_VALUES.mowing_ask_url });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    const audit = recordAuditEvent.mock.calls[0][0];
    expect(audit).toMatchObject({
      action: 'email_template.publish', resource_type: 'email_template', resource_id: 't1', critical: true,
      metadata: { via: MIGRATION_MARKER, migration: MIGRATION_ID, template_key: TEMPLATE_SETUP_SCHEDULE, from_version_id: 'v1', to_version_id: next.id, to_version_number: 10, added_variables: ['mowing_ask', 'mowing_ask_url'] },
    });
    expect(Object.keys(audit.metadata.changes)).toEqual(['blocks']);
    expect(audit.trx).toBeDefined();
  });

  test('a re-run publishes nothing', async () => {
    const tables = fixture();
    const k = fakeKnex(tables);
    await publishAsk(k, TEMPLATE_SETUP_SCHEDULE);
    expect(await publishAsk(k, TEMPLATE_SETUP_SCHEDULE)).toBe('already');
    expect(tables.email_template_versions).toHaveLength(2);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('an empty or missing allowlist (no restriction) stays empty; a listed variable is not doubled', async () => {
    for (const allowed of [[], null]) {
      const open = fixture({ allowed });
      expect(await publishAsk(fakeKnex(open), TEMPLATE_SETUP_SCHEDULE)).toBe('published');
      expect(JSON.parse(open.email_templates[0].allowed_variables)).toEqual([]);
    }
    const listed = fixture({ allowed: ['first_name', 'mowing_ask'] });
    await publishAsk(fakeKnex(listed), TEMPLATE_SETUP_SCHEDULE);
    expect(JSON.parse(listed.email_templates[0].allowed_variables)).toEqual(['first_name', 'mowing_ask', 'mowing_ask_url']);
  });

  test('a staff text body gets the text form; each representation is checked on its own', async () => {
    const tables = fixture({ textBody: 'Hi\n\n{{schedule_ask}}\n\nBye' });
    expect(await publishAsk(fakeKnex(tables), TEMPLATE_SETUP_SCHEDULE)).toBe('published');
    expect(tables.email_template_versions[1].text_body).toBe(`Hi\n\n{{schedule_ask}}\n\n${ASK_TEXT}\n\nBye`);
    expect(Object.keys(recordAuditEvent.mock.calls[0][0].metadata.changes)).toEqual(['blocks', 'text_body']);
    // Blocks already carry the ask, the text does not: only the text is added.
    recordAuditEvent.mockClear();
    const partial = fixture({ blocks: withAsk(live().blocks, TEMPLATE_SETUP_SCHEDULE), textBody: 'Hi\n\n{{schedule_ask}}\n\nBye' });
    expect(await publishAsk(fakeKnex(partial), TEMPLATE_SETUP_SCHEDULE)).toBe('published');
    expect(JSON.parse(partial.email_template_versions[1].blocks)).toEqual(withAsk(live().blocks, TEMPLATE_SETUP_SCHEDULE));
    expect(Object.keys(recordAuditEvent.mock.calls[0][0].metadata.changes)).toEqual(['text_body']);
  });

  test('a version that relies on the default CTA is left whole (a link block would hide it)', async () => {
    const noCta = live().blocks.filter((b) => b.type !== 'cta');
    const tables = fixture({ blocks: noCta });
    expect(await publishAsk(fakeKnex(tables), TEMPLATE_SETUP_SCHEDULE)).toBe('skipped');
    expect(tables.email_template_versions).toHaveLength(1);
    expect(recordAuditEvent).not.toHaveBeenCalled();
    // No default CTA on the template (the rain report): nothing to hide, so it publishes.
    const rain = fixture({ blocks: noCta, template: { default_cta_label: null, default_cta_url_variable: null } });
    expect(await publishAsk(fakeKnex(rain), TEMPLATE_SETUP_SCHEDULE)).toBe('published');
  });

  test('unusable blocks are skipped; a missing template is left alone', async () => {
    const bad = fixture();
    bad.email_template_versions[0].blocks = 'not json';
    expect(await publishAsk(fakeKnex(bad), TEMPLATE_SETUP_SCHEDULE)).toBe('skipped');
    expect(await publishAsk(fakeKnex({ email_templates: [], email_template_versions: [], email_template_fixtures: [] }), TEMPLATE_SETUP_SCHEDULE)).toBe('missing');
  });

  test('up() publishes each weekly template once and a second up() publishes nothing', async () => {
    const tables = { email_templates: [], email_template_versions: [], email_template_fixtures: [] };
    liveTemplates().forEach((r, i) => {
      tables.email_templates.push({ id: `t${i}`, template_key: r.key, active_version_id: `a${i}`, allowed_variables: '[]', optional_variables: '[]', default_cta_label: r.template.default_cta_label, default_cta_url_variable: r.template.default_cta_url_variable });
      tables.email_template_versions.push({ id: `a${i}`, template_id: `t${i}`, version_number: 1, status: 'active', subject: r.subject, preview_text: r.preview, blocks: JSON.stringify(r.blocks), text_body: null });
    });
    const k = fakeKnex(tables);
    k.schema = { hasTable: async () => true };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.up(k);
    expect(tables.email_template_versions.filter((v) => v.status === 'active')).toHaveLength(8);
    expect(tables.email_template_versions).toHaveLength(16);
    await migration.up(k);
    expect(tables.email_template_versions).toHaveLength(16);
    expect(log.mock.calls.map((c) => c[0]).filter((l) => l.endsWith(': published'))).toHaveLength(8);
    log.mockRestore();
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
