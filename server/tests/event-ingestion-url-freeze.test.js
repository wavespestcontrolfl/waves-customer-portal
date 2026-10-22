/**
 * GATE_NEWSLETTER_CLICK_BOUND: a feed pull keeps event_url on an approved or
 * featured row (iCal / calendar-RSS upserts). Gate off = the pulled URL wins.
 */

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ __raw: true, sql, bindings }));
  db.fn = { now: () => 'now()' };
  return db;
});

const { eventUrlMergeValue } = require('../services/event-ingestion');

afterEach(() => { delete process.env.GATE_NEWSLETTER_CLICK_BOUND; });

test('gate off: the pulled URL is merged as-is', () => {
  expect(eventUrlMergeValue('https://venue.example/new')).toBe('https://venue.example/new');
});

test('gate on: approved, featured or ever-sent rows keep their stored URL', () => {
  process.env.GATE_NEWSLETTER_CLICK_BOUND = 'true';
  const v = eventUrlMergeValue('https://venue.example/new');
  expect(v.__raw).toBe(true);
  expect(v.sql).toContain("events_raw.admin_status IN ('approved', 'featured') OR EXISTS (");
  expect(v.sql).toContain('THEN events_raw.event_url ELSE ? END');
  expect(v.bindings).toEqual(['https://venue.example/new']);
});

test('gate on: a null pulled URL is still bound, never interpolated', () => {
  process.env.GATE_NEWSLETTER_CLICK_BOUND = 'true';
  expect(eventUrlMergeValue(null).bindings).toEqual([null]);
});
