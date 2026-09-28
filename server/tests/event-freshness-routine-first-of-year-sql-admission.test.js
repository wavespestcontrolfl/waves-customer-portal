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

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('buildCurationCandidateQuery admits a genuine first-of-year stale_recurring row on real Postgres', () => {
  jest.setTimeout(30000);

  const db = require('../models/db');
  const { buildCurationCandidateQuery } = require('../services/event-curation');

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
      start_at: new Date(Date.now() + 10 * 24 * 3600 * 1000),
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
    await insertEvent({
      title,
      admin_status: 'approved',
      start_at: new Date(Date.now() - 5 * 24 * 3600 * 1000),
    });
    const laterId = await insertEvent({
      title,
      start_at: new Date(Date.now() + 10 * 24 * 3600 * 1000),
    });
    const rows = await buildCurationCandidateQuery(500);
    expect(rows.map((r) => r.id)).not.toContain(laterId);
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
