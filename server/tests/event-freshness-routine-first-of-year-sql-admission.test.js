/**
 * Real-Postgres regression test, Codex P1 (2026-09-27, second pass) on
 * event-curation.js's applyCurationHardGates (and the same duplicated
 * pattern in newsletter-autopilot.js's buildDigestPlan, newsletter-draft.js's
 * locked-event reload, and routes/admin-newsletter.js's approved-ids /
 * digest-plan endpoints): each one ANDed an unconditional
 * `whereNotIn('freshness_status', [...'stale_recurring'...])` at the TOP
 * LEVEL of its query, OUTSIDE excludeRoutineRecurringFromQuery's own
 * OR-group — so EVERY stale_recurring row was removed before that shared
 * gate's first-of-year admission (the NOT EXISTS "no earlier-this-ET-year
 * sibling" branch, event-freshness.js's buildRoutineFirstOfYearAdmission)
 * ever got a chance to run. A continuity-proven first-of-year weekly/monthly
 * row KEEPS the normalizer's 'stale_recurring' classification —
 * classifyFreshness has no pool access to know about continuity — so this
 * silently defeated the owner's 2026-09-27 recurring-first-of-year ruling
 * for every one of these consumers, despite excludeRoutineRecurringFromQuery
 * itself generating the correct admission SQL.
 *
 * event-freshness-routine-first-of-year-sql.test.js only inspects
 * `.toSQL()` text for excludeRoutineRecurringFromQuery in isolation, which
 * cannot catch an UNRELATED WHERE clause elsewhere in the same query
 * silently defeating the admission branch it correctly generates. These
 * tests run the REAL generated SQL against a live Postgres connection
 * (self-skips without DATABASE_URL, same convention as
 * event-ingestion-legacy-key-migration-postgres.test.js) to prove the fix
 * end to end: a genuine first-of-year stale_recurring row is admitted, a
 * non-first-of-year one is still rejected, and expired/needs_review remain
 * hard-excluded regardless.
 */

const { randomUUID } = require('crypto');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

// Fixtures anchored at explicit ET wall-clock times so no run date can push a
// pair across an ET midnight or New Year. `later` is ~10 days out (inside the
// curation window); `earlier` is 7 days before it in the SAME ET year. If that
// would cross into the prior year, both move to Jan 2 / Jan 9 of later's year,
// which is still within 90 days of any late-December run.
function etAt(day, time = '12:00:00') { return parseETDateTime(`${day}T${time}`); }
function sameYearDays() {
  let laterDay = etDateString(addETDays(new Date(), 10));
  let earlierDay = etDateString(addETDays(etAt(laterDay), -7));
  if (earlierDay.slice(0, 4) !== laterDay.slice(0, 4)) {
    const year = laterDay.slice(0, 4);
    laterDay = `${year}-01-09`;
    earlierDay = `${year}-01-02`;
  }
  return { laterDay, earlierDay };
}

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('buildCurationCandidateQuery admits a genuine first-of-year stale_recurring row on real Postgres', () => {
  jest.setTimeout(30000);

  const db = require('../models/db');
  const {
    buildCurationCandidateQuery, fetchCurationCandidates,
  } = require('../services/event-curation');
  const { filterRepeatedDateIdentities } = require('../services/newsletter-event-selection');

  const feedUrl = `https://test.invalid/curation-first-of-year-sql/${randomUUID()}`;
  let sourceId;

  beforeAll(async () => {
    const [row] = await db('event_sources').insert({
      name: `TEST curation-first-of-year-sql ${randomUUID()}`,
      url: 'https://test.invalid/',
      feed_url: feedUrl,
      feed_type: 'scrape',
      enabled: false, // never picked up by the real cron
      coverage_geo: '{}',
    }).returning('id');
    sourceId = row.id || row;
  });

  afterAll(async () => {
    if (sourceId) {
      // CASCADE (migration 20260427000003) removes the events_raw rows too.
      await db('event_sources').where({ id: sourceId }).del();
    }
    await db.destroy();
  });

  async function insertEvent(overrides = {}) {
    const [row] = await db('events_raw').insert({
      source_id: sourceId,
      external_id: `test-${randomUUID()}`,
      title: 'TEST Weekly Trivia',
      admin_status: 'pending',
      event_type: 'recurring_series',
      recurrence_type: 'weekly',
      freshness_status: 'stale_recurring',
      event_url: `https://test.invalid/trivia/${randomUUID()}`,
      venue_name: 'TEST Blind Tiger',
      city: 'sarasota',
      normalized_at: db.fn.now(),
      curated_at: null,
      merged_into: null,
      ...overrides,
    }).returning('id');
    return row.id || row;
  }

  test('a routine stale_recurring row with NO earlier-this-ET-year sibling IS admitted (the fix)', async () => {
    const id = await insertEvent({
      title: 'TEST Weekly Trivia First Of Year',
      start_at: etAt(sameYearDays().laterDay),
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).toContain(id);
  });

  test('a routine stale_recurring row WITH an earlier-this-ET-year sibling of the same identity is still EXCLUDED (unchanged)', async () => {
    const title = 'TEST Weekly Trivia With Earlier Sibling';
    // The earlier occurrence is pure occurrence EVIDENCE for the NOT EXISTS
    // subquery — it need not itself be a curation candidate (a past-dated
    // row never is), and loadYearIdentityPool-style evidence includes
    // rows regardless of admin_status.
    //
    // Codex P2, 2026-09-27 (re-raised): the admission now compares ET
    // CALENDAR DAYS, not exact timestamps (buildRoutineFirstOfYearAdmission
    // / occurrenceDayKey) — a sibling on the SAME day is the SAME
    // occurrence, never "earlier" (see the same-day test below). So this
    // fixture needs a sibling on a genuinely EARLIER ET calendar day, not
    // merely an earlier timestamp on the same day. sameYearDays() keeps both
    // in one ET year whatever the run date.
    const { laterDay, earlierDay } = sameYearDays();
    const laterStart = etAt(laterDay);
    const earlierDayStart = etAt(earlierDay);
    await insertEvent({
      title,
      admin_status: 'approved',
      start_at: earlierDayStart,
    });
    const laterId = await insertEvent({
      title,
      start_at: laterStart,
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(laterId);
  });

  test('two same-day same-identity rows 20 minutes apart are the SAME occurrence — the later is still admitted (Codex P2, re-raised)', async () => {
    const title = 'TEST Weekly Trivia Same Day Twenty Minutes Apart';
    const { laterDay } = sameYearDays();
    const laterStart = etAt(laterDay, '12:00:00');
    const earlierSameDay = etAt(laterDay, '11:40:00');
    await insertEvent({
      title,
      admin_status: 'approved',
      start_at: earlierSameDay,
    });
    const laterId = await insertEvent({
      title,
      start_at: laterStart,
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).toContain(laterId);
  });

  test('a merged-away duplicate a few minutes earlier does not count as an earlier occurrence', async () => {
    const title = 'TEST Weekly Trivia With Merged Duplicate';
    const { laterDay } = sameYearDays();
    const survivorId = await insertEvent({ title, start_at: etAt(laterDay, '12:00:00') });
    const loserId = await insertEvent({ title, start_at: etAt(laterDay, '11:45:00') });
    await db('events_raw').where({ id: loserId }).update({ merged_into: survivorId });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).toContain(survivorId);
  });

  test('a merged duplicate still counts once its survivor was advanced in place to a later day', async () => {
    const title = 'TEST Weekly Trivia Survivor Advanced';
    const { laterDay, earlierDay } = sameYearDays();
    // Merged on earlierDay; the stable-ID survivor's feed then moved it to laterDay.
    const survivorId = await insertEvent({ title, start_at: etAt(laterDay, '12:00:00') });
    const loserId = await insertEvent({ title, start_at: etAt(earlierDay, '12:00:00') });
    await db('events_raw').where({ id: loserId }).update({ merged_into: survivorId });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(survivorId);
  });

  test('a stale NON-routine row (limited run between its weeks) is kept out of the capped query', async () => {
    const id = await insertEvent({
      title: 'TEST Limited Run Between Weeks',
      event_type: 'limited_run',
      recurrence_type: 'none',
      freshness_status: 'stale_recurring',
      start_at: etAt(sameYearDays().laterDay),
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  test('blank venues fall back to city: an earlier row in another city does not suppress this one', async () => {
    const title = 'TEST Weekly Trivia Blank Venue';
    const { laterDay, earlierDay } = sameYearDays();
    await insertEvent({ title, venue_name: '', city: 'Tampa', admin_status: 'approved', start_at: etAt(earlierDay) });
    const laterId = await insertEvent({ title, venue_name: '  ', city: 'Venice', start_at: etAt(laterDay) });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).toContain(laterId);
  });

  test('the real year-pool loader carries recurrence metadata: rows re-labeled one_time inherit last year\'s weekly label', async () => {
    const title = 'TEST Relabeled Riverside Market';
    const { laterDay, earlierDay } = sameYearDays();
    const priorYear = `${Number(laterDay.slice(0, 4)) - 1}-08-01`;
    await insertEvent({ title, admin_status: 'approved', start_at: etAt(priorYear) });
    const oneTime = { event_type: 'one_time', recurrence_type: 'none', freshness_status: 'fresh_one_time' };
    const firstId = await insertEvent({ title, ...oneTime, start_at: etAt(earlierDay) });
    const laterId = await insertEvent({ title, ...oneTime, start_at: etAt(laterDay) });
    const candidates = await db('events_raw').whereIn('id', [firstId, laterId]);

    // No pools passed: the production loaders run against real Postgres.
    const rows = await filterRepeatedDateIdentities(candidates, { knex: db, reference: etAt(earlierDay) });
    expect(rows.map((r) => r.id)).toEqual([firstId]);
  });

  test('a series recognized only by its wording ("Weekly Yoga") reaches the first-of-year check', async () => {
    const id = await insertEvent({
      title: 'TEST Weekly Yoga On The Lawn',
      event_type: 'one_time',
      recurrence_type: 'unknown',
      freshness_status: 'stale_recurring',
      start_at: etAt(sameYearDays().laterDay),
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).toContain(id);
  });

  test('differently formatted cities still match: an earlier "lakewood-ranch" row suppresses a later "Lakewood Ranch" one', async () => {
    const title = 'TEST Weekly Trivia City Formatting';
    const { laterDay, earlierDay } = sameYearDays();
    await insertEvent({ title, venue_name: null, city: 'lakewood-ranch', admin_status: 'approved', start_at: etAt(earlierDay) });
    const laterId = await insertEvent({ title, venue_name: null, city: 'Lakewood Ranch', start_at: etAt(laterDay) });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(laterId);
  });

  test('titles normalize like the JS filter: an earlier "Weekly Trivia!" suppresses a later "The Weekly Trivia"', async () => {
    const { laterDay, earlierDay } = sameYearDays();
    await insertEvent({ title: 'TEST Weekly Trivia & Tacos!', admin_status: 'approved', start_at: etAt(earlierDay) });
    const laterId = await insertEvent({ title: 'The TEST Weekly Trivia and Tacos', start_at: etAt(laterDay) });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(laterId);
  });

  test('an annual row already featured this ET year is stamped as a permanent policy drop', async () => {
    const { laterDay, earlierDay } = sameYearDays();
    const annual = {
      title: 'TEST Annual Harbor Lights Festival',
      event_type: 'annual', recurrence_type: 'annual', freshness_status: 'fresh_annual',
      start_at: etAt(laterDay),
    };
    // Another listing of the same occurrence already shipped in an issue.
    await insertEvent({
      ...annual, admin_status: 'approved', curated_at: db.fn.now(),
      times_featured: 1, last_featured_at: etAt(earlierDay, '06:00:00'),
    });
    const id = await insertEvent(annual);
    const { policyDrops } = await fetchCurationCandidates(500);
    expect(policyDrops.map((d) => d.id)).toContain(String(id));
    // Each drop carries the fetched version, so its stamp can be pinned.
    expect(policyDrops.find((d) => d.id === String(id)).updated_at).toBeTruthy();
  });

  test('an operator-reset row is never a curation candidate, even after its curated_at is re-opened', async () => {
    const id = await insertEvent({
      title: 'TEST Operator Reset Revived Show',
      event_type: 'one_time', recurrence_type: 'none', freshness_status: 'fresh_one_time',
      approved_via: 'operator_reset', curated_at: null,
      start_at: etAt(sameYearDays().laterDay),
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  test('the real year-pool loader carries legacy featured history: a sibling featured last summer proves continuity', async () => {
    const title = 'TEST Legacy Continuity Riverside Market';
    const { laterDay, earlierDay } = sameYearDays();
    const priorSummer = `${Number(earlierDay.slice(0, 4)) - 1}-07-01`;
    const candidateId = await insertEvent({ title, start_at: etAt(earlierDay) });
    // Another row of the same series that a feed already advanced into this
    // year; it was featured last summer, before last_featured_occurrence_at existed.
    await insertEvent({
      title, admin_status: 'approved', start_at: etAt(laterDay),
      times_featured: 1, last_featured_at: etAt(priorSummer),
    });
    const candidates = await db('events_raw').where({ id: candidateId });
    const rows = await filterRepeatedDateIdentities(candidates, { knex: db, reference: etAt(earlierDay) });
    expect(rows.map((r) => r.id)).toEqual([candidateId]);
  });

  test('rows with no venue and no city match on title alone, like the JS filter', async () => {
    const title = 'TEST Weekly Trivia No Location';
    const { laterDay, earlierDay } = sameYearDays();
    await insertEvent({ title, venue_name: null, city: null, admin_status: 'approved', start_at: etAt(earlierDay) });
    const laterId = await insertEvent({ title, venue_name: null, city: 'sarasota', start_at: etAt(laterDay) });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(laterId);
  });

  test('a weekly row typed "unknown" still reaches the first-of-year check', async () => {
    const id = await insertEvent({
      title: 'TEST Unknown Type Weekly Market',
      event_type: 'unknown', recurrence_type: 'weekly', freshness_status: 'stale_recurring',
      start_at: etAt(sameYearDays().laterDay),
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).toContain(id);
  });

  test('annual and seasonal rows typed "unknown" reach the first-of-year check; a plain unknown row does not', async () => {
    const start = new Date(Date.now() + 10 * 24 * 3600 * 1000);
    const annualId = await insertEvent({
      title: 'TEST Unknown Type Annual Fair', event_type: 'unknown', recurrence_type: 'annual',
      freshness_status: 'fresh_annual', start_at: start,
    });
    const seasonalId = await insertEvent({
      title: 'TEST Unknown Type Seasonal Festival', event_type: 'unknown', recurrence_type: 'seasonal',
      freshness_status: 'fresh_annual', start_at: start,
    });
    const plainId = await insertEvent({
      title: 'TEST Unknown Type No Recurrence', event_type: 'unknown', recurrence_type: 'none',
      freshness_status: 'fresh_one_time', start_at: start,
    });
    const ids = (await buildCurationCandidateQuery(500)).map((r) => r.id);
    expect(ids).toContain(annualId);
    expect(ids).toContain(seasonalId);
    expect(ids).not.toContain(plainId);
  });

  test('expired and needs_review rows remain excluded unconditionally, even with no earlier sibling at all', async () => {
    const expiredId = await insertEvent({
      title: 'TEST Expired Row No Sibling',
      freshness_status: 'expired',
      start_at: new Date(Date.now() + 10 * 24 * 3600 * 1000),
    });
    const needsReviewId = await insertEvent({
      title: 'TEST Needs Review Row No Sibling',
      freshness_status: 'needs_review',
      start_at: new Date(Date.now() + 10 * 24 * 3600 * 1000),
    });
    const rows = await buildCurationCandidateQuery(500);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(expiredId);
    expect(ids).not.toContain(needsReviewId);
  });
});
