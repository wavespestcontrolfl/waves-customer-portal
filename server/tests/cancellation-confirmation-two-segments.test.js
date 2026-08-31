/**
 * Cancellation confirmation SMS stays within two segments once RENDERED
 * (owner ruling 2026-08-31 after the first live V2 cancel: the H0 body was
 * 306 chars before substitution and every real send went to 3 segments).
 * Uses the same counter the send path and comms-lint enforce.
 */
const { countSegments, detectEncoding } = require('../services/messaging/segment-counter');
const {
  CANCELLATION_CONFIRMATION_BODY,
  CANCELLATION_CONFIRMATION_PRIOR_BODY,
} = require('../models/migrations/20260831000030_cancellation_confirmation_two_segments');

const render = (body, vars) => body.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
const LONG_VARS = { first_name: 'Christopher-Alexander', effective_date: 'September 30, 2026' };

describe('service_cancellation_confirmation SMS body', () => {
  test('renders to at most 2 segments with a long name and long date, GSM-7 only', () => {
    const rendered = render(CANCELLATION_CONFIRMATION_BODY, LONG_VARS);
    expect(rendered).not.toMatch(/\{\w+\}/); // every variable substituted
    expect(detectEncoding(rendered).encoding).toBe('GSM_7');
    expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
  });

  test('keeps every truth claim: effective date, visits off, autopay off, completed visits payable, reply to reverse', () => {
    const b = CANCELLATION_CONFIRMATION_BODY;
    expect(b).toMatch(/cancelled as of \{effective_date\}/);
    expect(b).toMatch(/visits are off the calendar/);
    expect(b).toMatch(/autopay is off/);
    expect(b).toMatch(/Completed visits stay payable/);
    expect(b).toMatch(/Reply here/);
    expect(b).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji (house voice)
  });

  test('non-GSM first names fold to GSM-7 so the whole text stays at two segments', () => {
    const { gsmSafeName } = require('../services/messaging/gsm-normalize');
    // Á is outside GSM-7 → folds; é/ñ are GSM-native → kept as typed.
    expect(gsmSafeName('Álvaro')).toBe('Alvaro');
    expect(gsmSafeName('José-María Peña')).toBe('José-María Peña'.replace('í', 'i'));
    expect(gsmSafeName('  ')).toBe('there');
    expect(gsmSafeName('王小明')).toBe('there');
    const rendered = render(CANCELLATION_CONFIRMATION_BODY, { ...LONG_VARS, first_name: gsmSafeName('Álvaro-Christopher') });
    expect(detectEncoding(rendered).encoding).toBe('GSM_7');
    expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
    // Without folding the same name forces UCS-2 and a third segment — the bug.
    const unsafe = render(CANCELLATION_CONFIRMATION_BODY, { ...LONG_VARS, first_name: 'Álvaro-Christopher' });
    expect(countSegments(unsafe).segmentCount).toBeGreaterThan(2);
  });

  test('documents the bug: the prior H0 body rendered past two segments', () => {
    const rendered = render(CANCELLATION_CONFIRMATION_PRIOR_BODY, LONG_VARS);
    expect(countSegments(rendered).segmentCount).toBeGreaterThan(2);
  });
});
