/**
 * Unit tests for customer-insights-miner pure helpers + gates.
 *
 * Async DB-touching paths (mineAll, persist) exercised via the CLI
 * smoke test, not jest — they require live tables.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  classifyTopic,
  inferCity,
  inferService,
  inferFunnelStage,
  gateCallRecord,
  gateSmsRecord,
  gateReviewRecord,
  hasBusinessContext,
  normalizePhone,
  pickExample,
  paraphrase,
  normalizedQuestionFor,
  locationIdToCity,
} = require('../services/content/customer-insights-miner')._internals;

// ── classifyTopic ────────────────────────────────────────────────────

describe('classifyTopic', () => {
  test.each([
    ['Is it safe for dogs?', 'pet-safety'],
    ['Does rain ruin the mosquito spray?', 'rain-after-treatment'],
    ['Can you come out today?', 'same-day-service'],
    ['How much is the first visit?', 'price-cost'],
    ['Are these termites or flying ants', 'termite-vs-flying-ants'],
    ['I keep hearing scratching in the attic at night', 'rodent-attic-noise'],
    ['Mosquitoes are biting outside', 'mosquito-timing'],
    ['Big palmetto bug in the kitchen', 'roach-identification'],
    ['Tiny bugs around the bathroom sink', 'tiny-bugs'],
    ['When can I come back in the house after spray?', 'leave-house-after-spray'],
    ['Why are bugs worse after spraying?', 'bugs-worse-after-spray'],
    ['Brown spots on my St. Augustine', 'lawn-fungus-brown-spots'],
    ['Chinch bugs are killing my lawn', 'chinch-bug-damage'],
    ['Fire ant mounds in the yard', 'fire-ants'],
    ['Ants in line across the kitchen counter', 'ant-trail-kitchen'],
    ['Big spider in the bathroom', 'spider-in-house'],
    ['Can I fertilize during the summer blackout?', 'fertilizer-blackout'],
    ['Do you service Lakewood Ranch?', 'service-area-confirm'],
  ])('classifies "%s" → %s', (input, expected) => {
    expect(classifyTopic(input).topic).toBe(expected);
  });

  test('returns null for unrecognized text', () => {
    expect(classifyTopic('what time is it')).toBeNull();
    expect(classifyTopic('')).toBeNull();
    expect(classifyTopic(null)).toBeNull();
  });

  test('emergency topic has urgency=high', () => {
    expect(classifyTopic('Can you come out today').urgency).toBe('high');
  });
});

// ── inferCity ────────────────────────────────────────────────────────

describe('inferCity', () => {
  test('finds city from free text', () => {
    expect(inferCity('We are in Bradenton')).toBe('Bradenton');
    expect(inferCity('Service in Lakewood Ranch please')).toBe('Lakewood Ranch');
  });
  test('returns null when no city mentioned', () => {
    expect(inferCity('Are there roaches?')).toBeNull();
    expect(inferCity('')).toBeNull();
  });
});

// ── inferService ─────────────────────────────────────────────────────

describe('inferService', () => {
  test.each([
    ['termite inspection', 'termite'],
    ['need rodent control', 'rodent'],
    ['mosquito spray', 'mosquito'],
    ['brown spots on lawn', 'lawn'],
    ['tree fertilizing', 'tree-shrub'],
    ['roach problem', 'pest'],
  ])('%s → %s', (input, expected) => {
    expect(inferService(input)).toBe(expected);
  });
  test('null when no service hint', () => {
    expect(inferService('just checking on schedule')).toBeNull();
  });
});

// ── inferFunnelStage ─────────────────────────────────────────────────

describe('inferFunnelStage', () => {
  test('reviews are always post-service', () => {
    expect(inferFunnelStage('review', 'Great service!')).toBe('post-service');
  });
  test('active customer signals', () => {
    expect(inferFunnelStage('sms', 'Tech came yesterday, when is my next service?')).toBe('active-customer');
  });
  test('pre-sale signals', () => {
    expect(inferFunnelStage('sms', 'Just considering a quote, how much?')).toBe('pre-sale');
  });
  test('post-service signals', () => {
    expect(inferFunnelStage('sms', 'After spray, I still see ants.')).toBe('post-service');
  });
  test('fallback unknown', () => {
    expect(inferFunnelStage('sms', 'Hello.')).toBe('unknown');
  });
});

// ── eligibility gates ────────────────────────────────────────────────

describe('gateCallRecord', () => {
  test('passes when consent column present + true + has text + good outcome', () => {
    const row = { call_recording_consent_disclaimer_played: true, call_outcome: 'booked', lead_synopsis: 'Wants pest control' };
    expect(gateCallRecord(row, { consentColumnPresent: true }).ok).toBe(true);
  });
  test('fails when consent column missing', () => {
    expect(gateCallRecord({ call_outcome: 'booked', lead_synopsis: 'x' }, { consentColumnPresent: false })).toMatchObject({ ok: false, reason: 'consent_column_missing' });
  });
  test('fails when consent flag false', () => {
    expect(gateCallRecord({ call_recording_consent_disclaimer_played: false, call_outcome: 'booked', lead_synopsis: 'x' }, { consentColumnPresent: true })).toMatchObject({ ok: false, reason: 'consent_not_played' });
  });
  test('fails on wrong_number / spam', () => {
    expect(gateCallRecord({ call_recording_consent_disclaimer_played: true, call_outcome: 'spam', lead_synopsis: 'x' }, { consentColumnPresent: true })).toMatchObject({ ok: false, reason: 'non_service_call' });
  });
  test('fails on no text', () => {
    expect(gateCallRecord({ call_recording_consent_disclaimer_played: true, call_outcome: 'booked' }, { consentColumnPresent: true })).toMatchObject({ ok: false, reason: 'no_text' });
  });
});

describe('gateSmsRecord', () => {
  test('passes when sender not suppressed + body has business context', () => {
    const r = gateSmsRecord({ from_phone: '9415551234', body: 'I need pest control' }, { suppressedPhones: new Set() });
    expect(r.ok).toBe(true);
  });
  test('fails when sender on suppression list', () => {
    const r = gateSmsRecord({ from_phone: '+1-941-555-1234', body: 'pest help' }, { suppressedPhones: new Set(['9415551234']) });
    expect(r).toMatchObject({ ok: false, reason: 'suppressed_sender' });
  });
  test('fails on empty body', () => {
    const r = gateSmsRecord({ from_phone: '9415551234', body: '' }, { suppressedPhones: new Set() });
    expect(r).toMatchObject({ ok: false, reason: 'empty_body' });
  });
  test('fails when body has no business context', () => {
    const r = gateSmsRecord({ from_phone: '9415551234', body: 'hi how are you' }, { suppressedPhones: new Set() });
    expect(r).toMatchObject({ ok: false, reason: 'no_business_context' });
  });
});

describe('gateReviewRecord', () => {
  test('passes for normal positive review', () => {
    const r = gateReviewRecord({ review_text: 'Great service.', star_rating: 5 });
    expect(r.ok).toBe(true);
  });
  test('fails on low star (cherry-picking risk)', () => {
    const r = gateReviewRecord({ review_text: 'Terrible', star_rating: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'low_star_complaint' });
  });
  test('fails on JSON-blob review_text (data quality gap from Step 0)', () => {
    const r = gateReviewRecord({ review_text: '{"rating":5,"totalReviews":100}', star_rating: 5 });
    expect(r).toMatchObject({ ok: false, reason: 'json_blob_in_text' });
  });
  test('fails on empty', () => {
    expect(gateReviewRecord({ review_text: '', star_rating: 5 })).toMatchObject({ ok: false });
  });
});

// ── small helpers ────────────────────────────────────────────────────

describe('hasBusinessContext', () => {
  test('detects service-related words', () => {
    expect(hasBusinessContext('I need pest spray')).toBe(true);
    expect(hasBusinessContext('check on my lawn please')).toBe(true);
    expect(hasBusinessContext('hi how are you')).toBe(false);
  });
});

describe('normalizePhone', () => {
  test('strips formatting + leading 1', () => {
    expect(normalizePhone('+1 (941) 555-1234')).toBe('9415551234');
    expect(normalizePhone('941.555.1234')).toBe('9415551234');
    expect(normalizePhone('9415551234')).toBe('9415551234');
    expect(normalizePhone(null)).toBe('');
  });
});

describe('pickExample', () => {
  test('picks shortest record above the 8-char minimum', () => {
    // Sub-8-char strings ("short", "ok thanks") are discarded as too
    // sparse for an example; we want representativeness, not brevity-noise.
    expect(pickExample(['the longer message body here', 'medium length here', 'short']))
      .toBe('medium length here');
  });
  test('handles empty input', () => {
    expect(pickExample([])).toBe('');
    expect(pickExample(null)).toBe('');
  });
  test('falls back to first record when all are below threshold', () => {
    expect(pickExample(['hi', 'ok'])).toBe('hi');
  });
});

describe('paraphrase', () => {
  test('caps to 200 chars', () => {
    expect(paraphrase('x'.repeat(500)).length).toBe(200);
  });
});

describe('normalizedQuestionFor', () => {
  test('returns canonical question for known topics', () => {
    expect(normalizedQuestionFor('pet-safety')).toBe('Is the treatment safe for pets?');
    expect(normalizedQuestionFor('rain-after-treatment')).toBe('Does rain affect the treatment?');
  });
  test('falls back to topic key for unknown', () => {
    expect(normalizedQuestionFor('made-up')).toBe('made-up');
  });
});

describe('locationIdToCity', () => {
  test('maps known location IDs', () => {
    expect(locationIdToCity('lakewood-ranch')).toBe('Lakewood Ranch');
    expect(locationIdToCity('bradenton')).toBe('Bradenton');
  });
  test('returns null for unknown', () => {
    expect(locationIdToCity('atlanta')).toBeNull();
    expect(locationIdToCity(null)).toBeNull();
  });
});
