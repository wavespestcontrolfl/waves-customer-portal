/**
 * Sprinkler settings follow the home — the shared move guard (codex #3565
 * gh-r19…r25): portal sizing fields confirm per field; a tech-recorded
 * fallback figure is unconfirmed until a complete portal schedule outranks it.
 */
const { sizingFieldsUnconfirmed, scheduleUnconfirmedAfterMove, countyConfirmedAfterMove, confirmIrrigationFields, IRRIGATION_SIZING_FIELDS, COUNTY_CONFIRMED_FIELD } = require('../services/irrigation-schedule-confirmation');

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

describe('countyConfirmedAfterMove (codex gh-r32)', () => {
  test('no move → confirmed; after a move only the turf_county ledger entry confirms (sizing entries do not)', () => {
    expect(COUNTY_CONFIRMED_FIELD).toBe('turf_county');
    expect(countyConfirmedAfterMove({ irrigation_home_changed_at: null, irrigation_confirmed_fields: '[]' })).toBe(true);
    expect(countyConfirmedAfterMove({ irrigation_home_changed_at: '2026-08-20T00:00:00Z', irrigation_confirmed_fields: '[]' })).toBe(false);
    expect(countyConfirmedAfterMove({ irrigation_home_changed_at: '2026-08-20T00:00:00Z', irrigation_confirmed_fields: JSON.stringify(IRRIGATION_SIZING_FIELDS) })).toBe(false);
    expect(countyConfirmedAfterMove({ irrigation_home_changed_at: '2026-08-20T00:00:00Z', irrigation_confirmed_fields: JSON.stringify(['turf_county']) })).toBe(true);
    // The county entry never confirms a sizing field.
    expect(sizingFieldsUnconfirmed(row({ irrigation_confirmed_fields: ['turf_county'] }))).toBe(true);
  });
  test('confirmIrrigationFields: lock, atomic union over the CURRENT row, minimal upsert when no prefs row', async () => {
    const calls = [];
    const builder = (table) => {
      const q = {
        where: (w) => { calls.push(['where', table, w]); return q; },
        update: async (u) => { calls.push(['update', table, u]); return calls.some((c) => c[0] === 'noRow') ? 0 : 1; },
        insert: (r) => { calls.push(['insert', table, r]); return q; },
        onConflict: (k) => { calls.push(['onConflict', k]); return q; },
        merge: async (m) => { calls.push(['merge', m]); return 1; },
      };
      return q;
    };
    const trx = Object.assign(builder, { raw: (sql, b) => { calls.push(['raw', sql, b]); return { sql, b }; } });
    const conn = { transaction: (fn) => fn(trx) };
    expect(await confirmIrrigationFields(conn, 'c1', ['turf_county'])).toBe(1);
    expect(calls[0][0]).toBe('raw');
    expect(calls[0][1]).toMatch(/pg_advisory_xact_lock/);
    expect(calls[0][2]).toEqual(['property-preferences', 'c1']);
    const union = calls.find((c) => c[0] === 'raw' && /jsonb_agg\(DISTINCT v\)/.test(c[1]));
    expect(union[2]).toEqual([JSON.stringify(['turf_county'])]);
    expect(calls.find((c) => c[0] === 'update')[2].irrigation_confirmed_fields).toEqual({ sql: union[1], b: union[2] });
    expect(calls.some((c) => c[0] === 'insert')).toBe(false);
    // No row → minimal upsert carrying only the entry.
    calls.length = 0; calls.push(['noRow']);
    expect(await confirmIrrigationFields(conn, 'c2', ['turf_county'])).toBe(1);
    expect(calls.find((c) => c[0] === 'insert')[2]).toEqual({ customer_id: 'c2', irrigation_confirmed_fields: JSON.stringify(['turf_county']) });
    expect(calls.find((c) => c[0] === 'onConflict')[1]).toBe('customer_id');
    expect(await confirmIrrigationFields(conn, 'c3', [])).toBe(0);
  });
});
