/**
 * Sprinkler settings follow the home — the shared move guard (codex #3565
 * gh-r19…r25): portal sizing fields confirm per field; a tech-recorded
 * fallback figure is unconfirmed until a complete portal schedule outranks it.
 */
const { sizingFieldsUnconfirmed, scheduleUnconfirmedAfterMove, IRRIGATION_SIZING_FIELDS } = require('../services/irrigation-schedule-confirmation');

const row = (over) => ({ irrigation_run_minutes: 20, watering_days: JSON.stringify(['Mon']), irrigation_system_type: JSON.stringify(['spray']), irrigation_inches_per_week: null, irrigation_confirmed_fields: JSON.stringify([]), ...over });

describe('sizingFieldsUnconfirmed', () => {
  test('portal fields confirm per field; every NON-NULL one must be re-saved', () => {
    expect(IRRIGATION_SIZING_FIELDS).toEqual(['irrigation_run_minutes', 'watering_days', 'irrigation_system_type', 'irrigation_inches_per_week']);
    expect(sizingFieldsUnconfirmed(row())).toBe(true);
    expect(sizingFieldsUnconfirmed(row({ irrigation_confirmed_fields: JSON.stringify(['irrigation_run_minutes']) }))).toBe(true);
    expect(sizingFieldsUnconfirmed(row({ irrigation_confirmed_fields: ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type'] }))).toBe(false);
    expect(sizingFieldsUnconfirmed(row({ irrigation_run_minutes: null, watering_days: '[]', irrigation_system_type: [], irrigation_inches_per_week: null }))).toBe(false);
    expect(sizingFieldsUnconfirmed(row({ irrigation_confirmed_fields: 'not json' }))).toBe(true);
  });
  test('a tech-recorded fallback figure (turf profile / assessment) is unconfirmed until a COMPLETE portal schedule outranks it (gh-r25)', () => {
    const empty = { irrigation_run_minutes: null, watering_days: null, irrigation_system_type: null, irrigation_inches_per_week: null, irrigation_confirmed_fields: '[]' };
    expect(sizingFieldsUnconfirmed({ ...empty, turf_irrigation_inches_per_week: 1 })).toBe(true);
    expect(sizingFieldsUnconfirmed({ ...empty, assessment_irrigation_inches_per_week: 0.8 })).toBe(true);
    // Typed inches re-saved → the portal figure wins over the tech reading.
    expect(sizingFieldsUnconfirmed({ ...empty, irrigation_inches_per_week: 1.2, irrigation_confirmed_fields: ['irrigation_inches_per_week'], turf_irrigation_inches_per_week: 1 })).toBe(false);
    // Minutes alone re-saved is not a complete derived schedule → still unconfirmed.
    expect(sizingFieldsUnconfirmed({ ...empty, irrigation_run_minutes: 20, irrigation_confirmed_fields: ['irrigation_run_minutes'], turf_irrigation_inches_per_week: 1 })).toBe(true);
    expect(sizingFieldsUnconfirmed(row({ irrigation_confirmed_fields: ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type'], turf_irrigation_inches_per_week: 1 }))).toBe(false);
  });
  test('scheduleUnconfirmedAfterMove needs the move stamp', () => {
    expect(scheduleUnconfirmedAfterMove(row())).toBe(false);
    expect(scheduleUnconfirmedAfterMove(row({ irrigation_home_changed_at: '2026-08-28T00:00:00Z' }))).toBe(true);
  });
});
