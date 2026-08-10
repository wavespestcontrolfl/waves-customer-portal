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

  test('mowing day and time changes produce account-updated email items', () => {
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

    expect(src).toMatch(/mowingDays:\s*Joi\.array\(\)/);
    expect(src).toMatch(/mowingTimeOfDay:\s*shortText/);
    expect(src).toMatch(/mowingNotes:\s*longText/);
    expect(src).toMatch(/'mowing_days',\s*'mowing_time_of_day',\s*'mowing_notes'/);

    const jsonListMentions = src.match(/JSON_(?:COLS|FIELDS)\s*=\s*\[[^\]]*'mowing_days'[^\]]*\]/g) || [];
    expect(jsonListMentions).toHaveLength(2);

    const defaults = src.match(/mowingDays:\s*\[\],\s*mowingTimeOfDay:\s*'',\s*mowingNotes:\s*''/);
    expect(defaults).not.toBeNull();
  });
});
