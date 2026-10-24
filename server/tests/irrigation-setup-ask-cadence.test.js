/**
 * GATE_IRRIGATION_SETUP_ASK_CADENCE (owner 2026-10-24): the setup ask goes out
 * on a customer's first 3 setup emails, then at most once every 4 weeks. The
 * weeks between send irrigation.weekly_rain_report: the same rain report with
 * no callout and no button.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260801200000_seed_irrigation_setup_email_templates');
const migration = require('../models/migrations/20261024220000_seed_irrigation_rain_report_template');
const {
  buildWeeklyEmailDecision,
  weeklyInputsForCustomer,
  setupAskDue,
  irrigationSetupAskCadenceLive,
  loadSetupAskHistory,
  TEMPLATE_SETUP_SCHEDULE,
  TEMPLATE_SETUP_SYSTEM,
  TEMPLATE_RAIN_REPORT,
  TEMPLATE_CUT_BACK,
} = require('../services/irrigation-weekly-email');

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T11:05:00Z');

const BASE = {
  firstName: 'Dana',
  grassType: 'st_augustine',
  weekEnding: '2026-10-25',
  et0Inches: 1.2,
  rainfallInches7d: 0.6,
  forecastRainInches: 0.4,
};
const SYSTEM_NO_SCHEDULE = { ...BASE, irrigationSystem: true, irrigationInchesPerWeek: null };
const NOTHING_ON_FILE = { ...BASE, irrigationSystem: null, irrigationInchesPerWeek: null };

function rainReportRows() {
  const source = seed.__private.TEMPLATES.find((t) => t.key === migration.__private.SOURCE_KEY);
  const template = { id: 'tmpl-rain', ...seed.__private.templateRow(source), template_key: TARGET(), default_cta_label: null, default_cta_url_variable: null };
  template.allowed_variables = JSON.parse(template.allowed_variables);
  template.required_variables = JSON.parse(template.required_variables);
  return {
    template,
    version: { id: 'ver-rain', subject: source.subject, preview_text: source.preview, blocks: migration.__private.rainReportBlocks(source.blocks), text_body: null },
  };
}
function TARGET() { return migration.__private.TARGET_KEY; }

describe('setupAskDue', () => {
  test('the first 3 setup emails always ask', () => {
    expect(setupAskDue({ count: 0, lastAskAt: null }, NOW)).toBe(true);
    expect(setupAskDue({ count: 2, lastAskAt: new Date(NOW - 7 * DAY) }, NOW)).toBe(true);
  });
  test('after 3, the ask waits 4 weeks from the last one', () => {
    expect(setupAskDue({ count: 3, lastAskAt: new Date(NOW - 7 * DAY) }, NOW)).toBe(false);
    expect(setupAskDue({ count: 12, lastAskAt: new Date(NOW - 21 * DAY) }, NOW)).toBe(false);
    expect(setupAskDue({ count: 12, lastAskAt: new Date(NOW - 28 * DAY) }, NOW)).toBe(true);
    // A later start last time (sent 7:40, today 7:05) still counts as four weeks.
    expect(setupAskDue({ count: 12, lastAskAt: new Date(NOW.getTime() - 28 * DAY + 35 * 60 * 1000) }, NOW)).toBe(true);
  });
  test('an unreadable history keeps the ask (today\'s behavior)', () => {
    expect(setupAskDue(null, NOW)).toBe(true);
    expect(setupAskDue({ count: 5, lastAskAt: null }, NOW)).toBe(true);
    expect(setupAskDue({ count: 5, lastAskAt: 'not a date' }, NOW)).toBe(true);
  });
});

describe('gate reader', () => {
  const prior = process.env.GATE_IRRIGATION_SETUP_ASK_CADENCE;
  afterEach(() => { if (prior === undefined) delete process.env.GATE_IRRIGATION_SETUP_ASK_CADENCE; else process.env.GATE_IRRIGATION_SETUP_ASK_CADENCE = prior; });
  test('strict opt-in: only exactly "true"', () => {
    delete process.env.GATE_IRRIGATION_SETUP_ASK_CADENCE;
    expect(irrigationSetupAskCadenceLive()).toBe(false);
    process.env.GATE_IRRIGATION_SETUP_ASK_CADENCE = '1';
    expect(irrigationSetupAskCadenceLive()).toBe(false);
    process.env.GATE_IRRIGATION_SETUP_ASK_CADENCE = 'true';
    expect(irrigationSetupAskCadenceLive()).toBe(true);
  });
});

describe('decision routing', () => {
  test.each([
    [SYSTEM_NO_SCHEDULE, TEMPLATE_SETUP_SCHEDULE, 'setup_schedule'],
    [NOTHING_ON_FILE, TEMPLATE_SETUP_SYSTEM, 'setup_system'],
  ])('ask due: unchanged setup variant', (inputs, key, reason) => {
    const d = buildWeeklyEmailDecision(inputs);
    expect(d.templateKey).toBe(key);
    expect(d.reason).toBe(reason);
  });

  test.each([SYSTEM_NO_SCHEDULE, NOTHING_ON_FILE])('ask held back: rain report, no ask copy', (inputs) => {
    const asked = buildWeeklyEmailDecision(inputs);
    const quiet = buildWeeklyEmailDecision({ ...inputs, setupAskQuiet: true });
    expect(quiet.shouldSend).toBe(true);
    expect(quiet.templateKey).toBe(TEMPLATE_RAIN_REPORT);
    expect(quiet.reason).toBe('rain_report');
    expect(quiet.payload.schedule_ask).toBe('');
    // Same rain, target and forecast as the ask week.
    expect(quiet.payload.rain_last_week).toBe(asked.payload.rain_last_week);
    expect(quiet.payload.target_inches).toBe(asked.payload.target_inches);
    expect(quiet.payload.forecast_line).toBe(asked.payload.forecast_line);
  });

  test('a customer with a schedule is never affected', () => {
    const inputs = { ...BASE, irrigationSystem: true, irrigationInchesPerWeek: 2.5 };
    expect(buildWeeklyEmailDecision({ ...inputs, setupAskQuiet: true }).templateKey).toBe(TEMPLATE_CUT_BACK);
  });

  test('rain unknown still sends nothing', () => {
    const d = buildWeeklyEmailDecision({ ...SYSTEM_NO_SCHEDULE, rainfallInches7d: null, setupAskQuiet: true });
    expect(d.shouldSend).toBe(false);
  });
});

describe('weeklyInputsForCustomer', () => {
  const customer = { id: 'c1', first_name: 'Dana', irrigation_system: true, address_line1: '1 Test St', city: 'Bradenton', zip: '34202' };
  const opts = { weekEnding: '2026-10-25', weekWeather: { rainInches: 0.6, et0Inches: 1.2, rainSource: 'mrms' }, weekPlanEnabled: false, planWeekEnd: '2026-11-01', now: NOW };
  test('no key unless the ask is held back (gate-off inputs stay byte-identical)', () => {
    expect('setupAskQuiet' in weeklyInputsForCustomer(customer, opts)).toBe(false);
    expect('setupAskQuiet' in weeklyInputsForCustomer(customer, { ...opts, setupAskQuiet: false })).toBe(false);
    expect(weeklyInputsForCustomer(customer, { ...opts, setupAskQuiet: true }).setupAskQuiet).toBe(true);
  });
});

describe('loadSetupAskHistory', () => {
  function fakeConn(result, calls) {
    const q = {};
    ['where', 'whereIn', 'whereNotNull', 'whereNot', 'count', 'max'].forEach((m) => { q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; }); });
    q.first = jest.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
    return jest.fn(() => q);
  }
  test('counts SENT setup asks, excluding this week\'s own trigger', async () => {
    const calls = [];
    const at = new Date('2026-10-19T11:02:00Z');
    const h = await loadSetupAskHistory({ customerId: 'c1', weekEnding: '2026-10-25', conn: fakeConn({ count: '12', lastAskAt: at }, calls) });
    expect(h).toEqual({ count: 12, lastAskAt: at });
    expect(calls).toContainEqual(['where', { recipient_type: 'customer', recipient_id: 'c1' }]);
    expect(calls).toContainEqual(['whereIn', 'template_key', [TEMPLATE_SETUP_SCHEDULE, TEMPLATE_SETUP_SYSTEM]]);
    expect(calls).toContainEqual(['whereNotNull', 'sent_at']);
    expect(calls).toContainEqual(['whereNot', 'trigger_event_id', 'irrigation.weekly:c1:2026-10-25']);
  });
  test('a read error returns null (the ask stays)', async () => {
    const h = await loadSetupAskHistory({ customerId: 'c1', weekEnding: '2026-10-25', conn: fakeConn(new Error('boom'), []) });
    expect(h).toBeNull();
    expect(setupAskDue(h, NOW)).toBe(true);
  });
});

describe('rain report template (migration 20261024220000)', () => {
  test('drops only the callout and the button', () => {
    const blocks = [{ type: 'heading', content: 'h' }, { type: 'callout', content: 'ask' }, { type: 'paragraph', content: 'p' }, { type: 'cta', label: 'GO', url_variable: 'x' }, { type: 'small_note', content: 'n' }];
    expect(migration.__private.rainReportBlocks(blocks).map((b) => b.type)).toEqual(['heading', 'paragraph', 'small_note']);
    expect(migration.__private.rainReportBlocks(JSON.stringify(blocks))).toHaveLength(3);
  });

  test.each([SYSTEM_NO_SCHEDULE, NOTHING_ON_FILE])('renders the real payload with no ask and no placeholders', (inputs) => {
    const d = buildWeeklyEmailDecision({ ...inputs, setupAskQuiet: true });
    const { template, version } = rainReportRows();
    const out = EmailTemplates.renderTemplate({ template, version, payload: d.payload });
    for (const part of [out.subject, out.html, out.text]) {
      expect(part).not.toMatch(PLACEHOLDER_RE);
      expect(part).not.toMatch(/ADD MY WATERING SCHEDULE/i);
      expect(part).not.toMatch(/watering amount yet|sprinkler system on file/i);
    }
    expect(out.subject).toBe("Here's what fell on your lawn last week, Dana");
    expect(out.text).toContain('0.6"');
    expect(out.text).toMatch(/Prefer not to get these weekly check-ins/);
  });
});
