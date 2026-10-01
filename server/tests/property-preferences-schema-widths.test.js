/**
 * PREFS_FIELD_SCHEMAS max lengths must match the real property_preferences
 * column widths (codex P2): several fields used the generic 200-char
 * shortText, or hoaEmail's RFC-max 254, even though their actual varchar
 * column is narrower — a value between the column width and the Joi max
 * validated fine here and then 500'd on the INSERT/UPDATE as a Postgres
 * 22001 "value too long for type" error instead of a clean field-level
 * rejection. This pins each field's cap against the migration that created
 * its column, and the blackout date fields' '' -> null normalization.
 */
const {
  PREFS_FIELD_SCHEMAS,
  validatePrefsBody,
} = require('../services/property-preferences-schema');

// [field, real column width] — widths read directly off the migrations:
//   20260401000005_property_preferences.js (access codes, irrigation
//   controller location, hoa_name), 20260401000084_property_prefs_
//   expanded.js (side_gate_access, the rest of the HOA fields).
const WIDTHS = [
  ['neighborhoodGateCode', 100],
  ['propertyGateCode', 100],
  ['garageCode', 100],
  ['lockboxCode', 100],
  ['sideGateAccess', 200],
  ['irrigationControllerLocation', 200],
  ['hoaName', 150],
  ['hoaCompany', 200],
  ['hoaPhone', 30],
  ['hoaLawnHeight', 100],
  ['hoaInspectionPeriod', 100],
];

describe('PREFS_FIELD_SCHEMAS max lengths match real column widths', () => {
  test.each(WIDTHS)('%s accepts exactly %i chars and rejects %i + 1', (field, width) => {
    const schema = PREFS_FIELD_SCHEMAS[field];
    expect(schema.validate('a'.repeat(width)).error).toBeUndefined();
    expect(schema.validate('a'.repeat(width + 1)).error).toBeTruthy();
  });

  test('hoaEmail is capped at 100 (the real hoa_email column width), not the RFC-max 254', () => {
    const schema = PREFS_FIELD_SCHEMAS.hoaEmail;
    // A syntactically valid email at 101+ chars validated under the old
    // 254 cap and would have 500'd on save against the varchar(100) column.
    const longLocal = 'a'.repeat(90);
    const tooLong = `${longLocal}@example.com`; // > 100 chars
    expect(tooLong.length).toBeGreaterThan(100);
    expect(schema.validate(tooLong).error).toBeTruthy();
    const fits = 'manager@example.com';
    expect(schema.validate(fits).error).toBeUndefined();
  });

  test('via validatePrefsBody, an overlong field is a clean per-field rejection, not silently truncated or 500d', () => {
    const { value, rejected } = validatePrefsBody(PREFS_FIELD_SCHEMAS, {
      garageCode: 'x'.repeat(101),
      hoaPhone: 'x'.repeat(31),
      accessNotes: 'kept',
    });
    expect(rejected.map((r) => r.field).sort()).toEqual(['garageCode', 'hoaPhone']);
    expect(value.garageCode).toBeUndefined();
    expect(value.hoaPhone).toBeUndefined();
    expect(value.accessNotes).toBe('kept');
  });
});

describe('blackoutStart / blackoutEnd — empty string normalizes to null (codex P1)', () => {
  test.each(['blackoutStart', 'blackoutEnd'])('%s: an empty string never reaches storage as the literal "" (Postgres 22007 on a date column)', (field) => {
    const schema = PREFS_FIELD_SCHEMAS[field];
    const { value, error } = schema.validate('');
    expect(error).toBeUndefined();
    expect(value).toBeNull();
  });

  test.each(['blackoutStart', 'blackoutEnd'])('%s: null passes through as null', (field) => {
    const { value, error } = PREFS_FIELD_SCHEMAS[field].validate(null);
    expect(error).toBeUndefined();
    expect(value).toBeNull();
  });

  test.each(['blackoutStart', 'blackoutEnd'])('%s: a valid ISO date still validates', (field) => {
    const { value, error } = PREFS_FIELD_SCHEMAS[field].validate('2026-12-25');
    expect(error).toBeUndefined();
    expect(new Date(value).getUTCFullYear()).toBe(2026);
  });

  test.each(['blackoutStart', 'blackoutEnd'])('%s: a non-date string is rejected', (field) => {
    const { error } = PREFS_FIELD_SCHEMAS[field].validate('not-a-date');
    expect(error).toBeTruthy();
  });
});
