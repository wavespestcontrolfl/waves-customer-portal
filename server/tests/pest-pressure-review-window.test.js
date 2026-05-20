const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { resolveReviewWindow, detectFrequencyKey } = require('../services/pest-pressure/review-window');

const windows = DEFAULT_CONFIG.serviceFrequencyWindows;

function diffDays(start, end) {
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

describe('detectFrequencyKey', () => {
  test.each([
    ['Quarterly Pest Control Service', 'quarterly'],
    ['Monthly Pest', 'monthly'],
    ['Bi-monthly Pest', 'bimonthly'],
    ['Bimonthly Pest', 'bimonthly'],
    ['Every Other Month', 'bimonthly'],
    ['Semi-annual Termite Inspection', 'semiannual'],
    ['Semiannual termite', 'semiannual'],
    ['Every 6 months', 'semiannual'],
    ['One-Time Service', 'custom'],
    [null, 'custom'],
    ['', 'custom'],
  ])('%s → %s', (input, expected) => {
    expect(detectFrequencyKey(input)).toBe(expected);
  });
});

describe('resolveReviewWindow', () => {
  const serviceDate = new Date('2026-05-17T12:00:00Z');

  test('monthly maps to 30-day window', () => {
    const w = resolveReviewWindow({
      serviceFrequency: 'Monthly Pest Control',
      serviceDate,
      windows,
    });
    expect(w.days).toBe(30);
    expect(w.frequencyKey).toBe('monthly');
    expect(w.source).toBe('frequency');
    expect(diffDays(w.start, w.end)).toBe(30);
  });

  test('bimonthly maps to 60-day window', () => {
    const w = resolveReviewWindow({
      serviceFrequency: 'Bi-monthly Pest Control',
      serviceDate,
      windows,
    });
    expect(w.days).toBe(60);
    expect(w.frequencyKey).toBe('bimonthly');
  });

  test('quarterly maps to 90-day window', () => {
    const w = resolveReviewWindow({
      serviceFrequency: 'Quarterly Pest Control Service',
      serviceDate,
      windows,
    });
    expect(w.days).toBe(90);
    expect(w.frequencyKey).toBe('quarterly');
  });

  test('semiannual maps to 180-day window', () => {
    const w = resolveReviewWindow({
      serviceFrequency: 'Semi-annual Termite Inspection',
      serviceDate,
      windows,
    });
    expect(w.days).toBe(180);
    expect(w.frequencyKey).toBe('semiannual');
    expect(w.source).toBe('frequency');
  });

  test('custom uses last completed service date', () => {
    const last = new Date('2026-04-01T12:00:00Z');
    const w = resolveReviewWindow({
      serviceFrequency: 'One-Time Service',
      serviceDate,
      lastCompletedServiceDate: last,
      windows,
    });
    expect(w.source).toBe('last_service');
    expect(w.start.getTime()).toBe(last.getTime());
    expect(diffDays(w.start, w.end)).toBe(46);
  });

  test('custom falls back to configured fallbackDays when no last service', () => {
    const w = resolveReviewWindow({
      serviceFrequency: null,
      serviceDate,
      windows,
    });
    expect(w.source).toBe('fallback');
    expect(w.days).toBe(windows.fallbackDays);
  });
});
