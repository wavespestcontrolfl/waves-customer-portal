// Declared lead timeline ("When do you want this handled?") → leads.urgency.
// Shared helper + the two public intake parsers that carry it.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { TIMELINE_VALUES, normalizeTimeline, urgencyForTimeline } = require('../services/lead-timeline');
const { _test } = require('../routes/lead-webhook');
const { buildLeadWebhookIntake } = _test;

describe('normalizeTimeline', () => {
  test('accepts the four canonical form values', () => {
    for (const v of TIMELINE_VALUES) expect(normalizeTimeline(v)).toBe(v);
  });

  test('accepts form-friendly aliases, case- and separator-insensitively', () => {
    expect(normalizeTimeline('ASAP')).toBe('now');
    expect(normalizeTimeline('Today')).toBe('now');
    expect(normalizeTimeline('This Week')).toBe('this_week');
    expect(normalizeTimeline('this-month')).toBe('this_month');
    expect(normalizeTimeline('just pricing')).toBe('browsing');
  });

  test('never guesses: unknown, empty and non-string input → null', () => {
    expect(normalizeTimeline('soon')).toBeNull();
    expect(normalizeTimeline('')).toBeNull();
    expect(normalizeTimeline(null)).toBeNull();
    expect(normalizeTimeline(undefined)).toBeNull();
    expect(normalizeTimeline({ now: true })).toBeNull();
    expect(normalizeTimeline(42)).toBeNull();
  });
});

describe('urgencyForTimeline', () => {
  test('maps onto the lead-triage urgency vocabulary', () => {
    expect(urgencyForTimeline('now')).toBe('urgent');
    expect(urgencyForTimeline('this_week')).toBe('high');
    expect(urgencyForTimeline('this_month')).toBe('normal');
    expect(urgencyForTimeline('browsing')).toBe('low');
  });

  test('null timeline → null urgency (the triage may still fill it in)', () => {
    expect(urgencyForTimeline(null)).toBeNull();
    expect(urgencyForTimeline('later')).toBeNull();
  });
});

describe('buildLeadWebhookIntake — timeline', () => {
  test('carries a declared timeline through', () => {
    expect(buildLeadWebhookIntake({ timeline: 'this_week' }).timeline).toBe('this_week');
    expect(buildLeadWebhookIntake({ Timeline: 'now' }).timeline).toBe('now');
  });

  test('absent or unknown → null (older cached forms keep the triage path)', () => {
    expect(buildLeadWebhookIntake({}).timeline).toBeNull();
    expect(buildLeadWebhookIntake({ timeline: 'whenever' }).timeline).toBeNull();
  });

  test('exact key only — a timeline-ish word inside another field is not swept up', () => {
    expect(buildLeadWebhookIntake({ message: 'timeline: now please', address_timeline: 'now' }).timeline).toBeNull();
  });
});
