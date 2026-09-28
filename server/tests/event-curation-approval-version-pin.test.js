/**
 * Codex P1 (2026-09-27), event-curation.js:456 "Revalidate content before
 * initial auto-approval": applyDecision's approval UPDATE only rechecked
 * admin_status/merged_into, so a row whose title/description/start_at/
 * event_url/recurrence_type changed DURING the (up to 10-minute)
 * classify call — an ingestion re-pull, or an admin edit — could still
 * auto-approve (or just get curated_at stamped) from a decision computed
 * against the STALE content, and an approved row is never re-examined.
 *
 * The fix pins both writes (the approval UPDATE, and the fallback
 * non-approving assessment write) to the exact `updated_at` the row carried
 * when it was fetched for classification, via a
 * date_trunc('milliseconds', …) comparison. On a
 * version mismatch, the row is left exactly as-is (curated_at untouched) so
 * the next run re-classifies its CURRENT content.
 *
 * Mocked DB — isolates the write path itself.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/event-scoring', () => ({
  ...jest.requireActual('../services/event-scoring'),
  assessEvent: jest.fn(),
  malformedAssessmentReason: jest.fn(() => null),
}));

const db = require('../models/db');
const { assessEvent } = require('../services/event-scoring');
const { applyDecision } = require('../services/event-curation');

function wireDb({ approveRows = 1, fallbackRows = 1 } = {}) {
  const calls = [];
  const whereRawCalls = [];
  db.fn = { now: jest.fn(() => 'NOW()') };
  const chain = {
    where: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereRaw: jest.fn((sql, bindings) => { whereRawCalls.push({ sql, bindings }); return chain; }),
    update: jest.fn((patch) => {
      calls.push(patch);
      const isApprovalWrite = patch.admin_status === 'approved';
      return Promise.resolve(isApprovalWrite ? approveRows : fallbackRows);
    }),
  };
  db.mockImplementation(() => chain);
  return { calls, whereRawCalls };
}

beforeEach(() => jest.clearAllMocks());

const APPROVING_DECISION = {
  approve: true,
  score: 90,
  breakdown: { final: 90 },
  rejectionCodes: [],
  audienceTags: [],
  noveltyType: 'touring',
  evidence: ['Official page confirms the one-night date.'],
  editorialReason: 'Great event',
};

const event = { id: 'evt-1', updated_at: new Date('2026-09-27T09:00:00.000Z') };
const rawAssessment = { id: 'evt-1' };

describe('applyDecision pins its writes to the exact row version fetched for classification', () => {
  test('approves and stamps curated_at when nothing changed since fetch', async () => {
    assessEvent.mockReturnValue(APPROVING_DECISION);
    const { calls, whereRawCalls } = wireDb();
    const outcome = await applyDecision(event, rawAssessment);
    expect(outcome).toBe('approved');
    expect(calls).toHaveLength(1);
    expect(calls[0].admin_status).toBe('approved');
    expect(calls[0].approved_via).toBe('auto_curation');
    const clause = whereRawCalls.find((c) => c.bindings[0] === event.updated_at);
    expect(clause).toBeTruthy();
    // Not a plain `=` — node-postgres reads timestamptz back millisecond
    // precision while the column itself is microsecond precision.
    expect(clause.sql).toMatch(/date_trunc\('milliseconds',\s*updated_at\)\s*=\s*\?/);
  });

  test('content changed underneath during classify: the approval UPDATE matches 0 rows, falls through to the pinned fallback, which ALSO matches 0 rows — the row is left un-examined', async () => {
    assessEvent.mockReturnValue(APPROVING_DECISION);
    const { calls, whereRawCalls } = wireDb({ approveRows: 0, fallbackRows: 0 });
    const outcome = await applyDecision(event, rawAssessment);
    expect(outcome).toBe('left_pending');
    // Both writes attempted, both pinned to the exact fetched version.
    expect(calls).toHaveLength(2);
    expect(whereRawCalls.filter((c) => c.bindings[0] === event.updated_at)).toHaveLength(2);
  });

  test('a non-approving decision (below the feature floor) still pins its write to the fetched version', async () => {
    const belowFloor = {
      ...APPROVING_DECISION, approve: false, score: 40, rejectionCodes: [],
    };
    assessEvent.mockReturnValue(belowFloor);
    const { calls, whereRawCalls } = wireDb();
    const outcome = await applyDecision(event, rawAssessment);
    expect(outcome).toBe('left_pending');
    expect(calls).toHaveLength(1);
    expect(calls[0].admin_status).toBeUndefined();
    expect(whereRawCalls.some((c) => c.bindings[0] === event.updated_at)).toBe(true);
  });

  test('a concurrent operator decision (admin_status no longer pending, content otherwise unchanged) still stamps curated_at via the fallback write — reported "raced", never silently dropped', async () => {
    assessEvent.mockReturnValue(APPROVING_DECISION);
    const { calls } = wireDb({ approveRows: 0, fallbackRows: 1 });
    const outcome = await applyDecision(event, rawAssessment);
    expect(outcome).toBe('raced');
    expect(calls).toHaveLength(2);
    expect(calls[0].admin_status).toBe('approved'); // attempted, but unmatched
    expect(calls[1].admin_status).toBeUndefined(); // fallback never sets admin_status
  });

  test('a rejected-policy decision never approves, and the fallback write carries the score/evidence for the Event Inbox', async () => {
    const rejected = {
      ...APPROVING_DECISION, approve: false, rejectionCodes: ['retail_promotion'],
    };
    assessEvent.mockReturnValue(rejected);
    const { calls } = wireDb();
    const outcome = await applyDecision(event, rawAssessment);
    expect(outcome).toBe('left_pending');
    expect(calls).toHaveLength(1);
    expect(calls[0].admin_status).toBeUndefined();
    expect(calls[0].editorial_score).toBe(90);
  });

  test('a missing assessment only stamps the row when it is unchanged and still pending', async () => {
    const { calls, whereRawCalls } = wireDb();
    const outcome = await applyDecision(event, { id: 'evt-1', __missing: true });
    expect(outcome).toBe('left_pending');
    expect(calls).toHaveLength(1);
    expect(calls[0].curation_note).toBe('No assessment returned by model');
    expect(whereRawCalls).toHaveLength(1);
    expect(whereRawCalls[0].bindings[0]).toBe(event.updated_at);
    expect(db.mock.results.length).toBeGreaterThan(0);
  });
});
