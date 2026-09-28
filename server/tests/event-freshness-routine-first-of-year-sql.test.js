/**
 * Codex P1 (2026-09-27), newsletter-event-selection.js:332 "Admit routine
 * first-of-year rows before filtering": excludeRoutineRecurringFromQuery
 * (event-freshness.js) used to drop EVERY routine event_type/recurrence_type
 * row outright unless it also carried freshness_status='fresh_series_launch'
 * — so a normal weekly/monthly series with genuine prior-year continuity
 * could never reach the JS first-of-year check (isFirstOccurrenceOfYear /
 * filterRepeatedDateIdentities) at all, in EVERY consumer of this shared SQL
 * gate (buildCurationCandidateQuery, the rescore pass, buildDigestPlan, the
 * admin planner, draft loading).
 *
 * These tests build a real (unconnected) knex query — `.toSQL()` compiles
 * the SQL text without a live Postgres connection — and assert the fixed
 * gate now admits a routine row via a NOT EXISTS ("no earlier-this-ET-year
 * sibling of the same identity") carve-out, in addition to the original two
 * branches.
 */

const db = require('../models/db');
const { excludeRoutineRecurringFromQuery, buildRoutineFirstOfYearAdmission } = require('../services/event-freshness');
const { buildCurationCandidateQuery } = require('../services/event-curation');

function baseQuery() {
  return db('events_raw as e').select('e.id').where('e.admin_status', 'pending');
}

describe('excludeRoutineRecurringFromQuery admits a genuine first-of-year routine row (Codex P1)', () => {
  test('the original two branches (non-routine metadata, fresh_series_launch) are preserved', () => {
    const { sql, bindings } = excludeRoutineRecurringFromQuery(baseQuery()).toSQL();
    expect(sql).toMatch(/"e"\."event_type" not in/i);
    expect(sql).toMatch(/"e"\."recurrence_type" not in/i);
    expect(sql).toMatch(/"e"\."freshness_status" = \?/);
    expect(bindings).toContain('fresh_series_launch');
  });

  test('a third branch admits a row when no earlier-this-(ET)-year sibling of the same identity is found', () => {
    const { sql } = excludeRoutineRecurringFromQuery(baseQuery()).toSQL();
    expect(sql).toMatch(/not exists/i);
    expect(sql).toContain('routine_sibling');
    // ET-year comparison, not a raw calendar-date comparison — a Dec 31
    // 10pm ET event is still the SAME ET year as an early-Jan-UTC sibling.
    expect(sql).toMatch(/date_part\('year',\s*\(routine_sibling\.start_at AT TIME ZONE 'America\/New_York'\)\)/i);
    expect(sql).toMatch(/date_part\('year',\s*\(e\.start_at AT TIME ZONE 'America\/New_York'\)\)/i);
    // Identity match: normalized title, plus venue (or city when venue is
    // blank on either side) — mirrors newsletter-event-selection.js's
    // isSameSeriesSibling as closely as SQL reasonably can.
    // Title normalized like normalizeDigestTitle (& to "and", filler words dropped).
    expect(sql).toMatch(/replace\(lower\(routine_sibling\.title\), '&', ' and '\)/i);
    // A venue counts only when it normalizes to non-empty text (blank = missing).
    expect(sql).toMatch(/COALESCE\(btrim\(regexp_replace\(lower\(routine_sibling\.venue_name\)/i);
    // City compared with the same normalization as the JS series context.
    expect(sql).toMatch(/btrim\(regexp_replace\(lower\(routine_sibling\.city\)/i);
  });

  test('the admission clause excludes the row itself and requires a strictly earlier sibling ET CALENDAR DAY (not just an earlier timestamp)', () => {
    // Codex P2, 2026-09-27 (re-raised): comparing bare `start_at <` values
    // would wrongly treat two same-identity rows on the SAME ET day, a few
    // minutes apart, as "earlier" — the comparison is on the ET calendar day
    // (mirrors newsletter-event-selection.js's occurrenceDayKey), so a
    // same-day sibling never disqualifies the row.
    const clause = buildRoutineFirstOfYearAdmission('e');
    expect(clause).toMatch(/routine_sibling\.id != e\.id/);
    expect(clause).not.toMatch(/routine_sibling\.start_at < e\.start_at/);
    expect(clause).toMatch(
      /\(routine_sibling\.start_at AT TIME ZONE 'America\/New_York'\)::date\s*<\s*\(e\.start_at AT TIME ZONE 'America\/New_York'\)::date/,
    );
  });

  test('an unaliased query (alias falsy) falls back to the original two-branch gate rather than guessing a correlation', () => {
    const { sql } = excludeRoutineRecurringFromQuery(db('events_raw').select('id'), '').toSQL();
    expect(sql).not.toMatch(/not exists/i);
    expect(sql).toMatch(/"event_type" not in/i);
  });

  test('buildCurationCandidateQuery (the real consumer) carries the new admission clause through', () => {
    const { sql } = buildCurationCandidateQuery(25).toSQL();
    expect(sql).toMatch(/not exists/i);
    expect(sql).toContain('routine_sibling');
  });
});
