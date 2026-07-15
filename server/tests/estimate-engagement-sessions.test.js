/**
 * Sessionizer — pins the session-boundary semantics every engagement rule
 * depends on: views under the gap collapse into one visit (multi-clicks in
 * a sitting never double-fire), views past the gap start a new one, order
 * doesn't matter, junk timestamps drop.
 */

jest.mock('../models/db', () => jest.fn());

const { sessionize } = require('../services/estimate-engagement-sessions');

const t = (iso) => ({ viewed_at: iso });

test('views under the gap are ONE session', () => {
  const sessions = sessionize([
    t('2026-06-10T15:00:00Z'),
    t('2026-06-10T15:10:00Z'),
    t('2026-06-10T15:29:00Z'),
  ], 30);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].viewCount).toBe(3);
  expect(sessions[0].startedAt.toISOString()).toBe('2026-06-10T15:00:00.000Z');
  expect(sessions[0].endedAt.toISOString()).toBe('2026-06-10T15:29:00.000Z');
});

test('a view past the gap starts a new session', () => {
  const sessions = sessionize([
    t('2026-06-10T15:00:00Z'),
    t('2026-06-10T15:31:00Z'),
  ], 30);
  expect(sessions).toHaveLength(2);
  expect(sessions[1].viewCount).toBe(1);
});

test('the gap chains — each view extends the session window', () => {
  // 25 min apart each: every consecutive pair is under the 30-min gap, so
  // one long session even though first→last exceeds 30 min.
  const sessions = sessionize([
    t('2026-06-10T15:00:00Z'),
    t('2026-06-10T15:25:00Z'),
    t('2026-06-10T15:50:00Z'),
  ], 30);
  expect(sessions).toHaveLength(1);
});

test('input order does not matter', () => {
  const sessions = sessionize([
    t('2026-06-10T18:00:00Z'),
    t('2026-06-10T15:00:00Z'),
  ], 30);
  expect(sessions).toHaveLength(2);
  expect(sessions[0].startedAt.toISOString()).toBe('2026-06-10T15:00:00.000Z');
});

test('unparseable timestamps drop; empty input yields no sessions', () => {
  expect(sessionize([t('garbage'), t(null)], 30)).toHaveLength(0);
  expect(sessionize([], 30)).toHaveLength(0);
  expect(sessionize(null, 30)).toHaveLength(0);
});
