process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({
  sendAccountUpdated: jest.fn().mockResolvedValue(undefined),
}));

const propertyRouter = require('../routes/property');
const { mowingAlertText } = require('../utils/mowing-schedule');

const { propertyChangeItems, displayPrefValue } = propertyRouter._private;

// The route wires new preference fields through four independent lists (Joi
// schema, ALLOWED_FIELDS, JSON round-trip cols, email-notice fields). These
// tests pin the mowing fields into each so a partial wiring regresses loudly.
describe('property preferences — mowing schedule fields', () => {
  test('displayPrefValue renders mowing values for the account-updated email', () => {
    expect(displayPrefValue(['Mon', 'Thu'])).toBe('Mon, Thu');
    expect(displayPrefValue(JSON.stringify(['Tue']))).toBe('Tue');
    expect(displayPrefValue('morning')).toBe('Morning');
    expect(displayPrefValue(null)).toBe('Not set');
    expect(displayPrefValue([])).toBe('Not set');
  });

  // NOTE: these items feed AccountMembershipEmail.sendAccountUpdated, which
  // deliberately SKIPS ('self_initiated') whenever the actor is the recipient
  // — which is every customer-initiated PUT on this route today. So this pins
  // the change-item wiring, NOT that an email is delivered. mowing_days /
  // mowing_time_of_day are registered exactly like the sibling watering_days
  // entry so that if a staff-actor path is ever added, mowing notifies with
  // the rest instead of being silently omitted.
  test('mowing day and time changes produce account-updated change items', () => {
    const items = propertyChangeItems(
      { mowing_days: JSON.stringify(['Mon', 'Thu']), mowing_time_of_day: 'morning', mowing_notes: 'crew day' },
      { mowing_days: null, mowing_time_of_day: null, mowing_notes: null },
    );
    const keys = items.map(i => i.key).sort();
    // mowing_notes is intentionally NOT an email field (matches
    // irrigation_schedule_notes precedent — free-text edits do not email).
    expect(keys).toEqual(['mowing_days', 'mowing_time_of_day']);
    const daysItem = items.find(i => i.key === 'mowing_days');
    expect(daysItem.label).toBe('Mowing days');
    expect(daysItem.oldValue).toBe('Not set');
    expect(daysItem.newValue).toBe('Mon, Thu');
  });

  test('an unchanged mowing value produces no email item', () => {
    const items = propertyChangeItems(
      { mowing_days: JSON.stringify(['Mon']) },
      { mowing_days: ['Mon'] },
    );
    expect(items).toEqual([]);
  });

  test('route source wires mowing fields through schema, allowlist, and JSON round-trip', () => {
    // The Joi schema, ALLOWED_FIELDS, JSON_COLS, and JSON_FIELDS are private
    // to the module. Read the source once and pin each wiring point — this is
    // deliberately a source-level contract so "field saves but comes back as a
    // JSON string" or "field validates but is filtered before storage" cannot
    // slip through unnoticed.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'property.js'), 'utf8');

    // Both mowing enums are validated against the exact keys the pills emit.
    // A length-only check would persist values ("Monday", a 40-char time)
    // that the summary and the technician alert both filter out — a silent
    // write that vanishes from every surface — or overflow varchar(30).
    expect(src).toMatch(/mowingDays:\s*Joi\.array\(\)[\s\S]{0,200}?\.valid\('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'\)/);
    expect(src).toMatch(/mowingTimeOfDay:\s*Joi\.string\(\)[^\n]*\.valid\(/);
    expect(src).toMatch(/mowingNotes:\s*longText/);
    expect(src).toMatch(/'mowing_days',\s*'mowing_time_of_day',\s*'mowing_notes'/);

    const jsonListMentions = src.match(/JSON_(?:COLS|FIELDS)\s*=\s*\[[^\]]*'mowing_days'[^\]]*\]/g) || [];
    expect(jsonListMentions).toHaveLength(2);

    const defaults = src.match(/mowingDays:\s*\[\],\s*mowingTimeOfDay:\s*'',\s*mowingNotes:\s*''/);
    expect(defaults).not.toBeNull();
  });
});

// The whole point of collecting mowing days is that the person treating the
// lawn knows when it was (or is about to be) cut. These pin the formatting
// and the two day-view builders that render it.
describe('mowingAlertText — technician-facing line', () => {
  test('days and time render together, Mon-first regardless of stored order', () => {
    expect(mowingAlertText({ mowing_days: ['Thu', 'Mon'], mowing_time_of_day: 'afternoon' }))
      .toBe('Mows: Mon, Thu (afternoons)');
  });

  test('a jsonb column handed back as a JSON string still formats', () => {
    expect(mowingAlertText({ mowing_days: JSON.stringify(['Wed']), mowing_time_of_day: 'morning' }))
      .toBe('Mows: Wed (mornings)');
  });

  test('partial answers still produce a line', () => {
    expect(mowingAlertText({ mowing_days: ['Fri'] })).toBe('Mows: Fri');
    expect(mowingAlertText({ mowing_time_of_day: 'varies' })).toBe('Mows: time varies');
    expect(mowingAlertText({ mowing_notes: 'Every other week' })).toBe('Mowing: Every other week');
    expect(mowingAlertText({ mowing_days: ['Tue'], mowing_notes: 'Skips December' }))
      .toBe('Mows: Tue — Skips December');
  });

  test('nothing set, unknown values, and bad JSON produce no alert', () => {
    expect(mowingAlertText({})).toBe('');
    expect(mowingAlertText(null)).toBe('');
    expect(mowingAlertText({ mowing_days: [], mowing_time_of_day: '', mowing_notes: '  ' })).toBe('');
    expect(mowingAlertText({ mowing_days: '{not json', mowing_time_of_day: 'whenever' })).toBe('');
  });

  test('both day-view builders render the mowing alert', () => {
    const fs = require('fs');
    const path = require('path');
    // admin-dispatch still inlines its (string-shaped) alert block.
    const dispatchSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-dispatch.js'), 'utf8');
    expect(dispatchSrc).toContain("require('../utils/mowing-schedule')");
    expect(dispatchSrc).toMatch(/mowingAlertText\(prefs\)/);
    // admin-schedule's typed block moved to the shared property-alerts
    // compiler (also consumed by the pre-visit brief) — the mowing alert
    // renders through it.
    const scheduleSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(scheduleSrc).toContain("require('../services/property-alerts')");
    expect(scheduleSrc).toMatch(/compilePropertyAlerts\(\{/);
    const compilerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'property-alerts.js'), 'utf8');
    expect(compilerSrc).toContain("require('../utils/mowing-schedule')");
    expect(compilerSrc).toMatch(/mowingAlertText\(prefs\)/);
  });
});
