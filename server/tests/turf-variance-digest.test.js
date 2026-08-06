jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  const qb = () => { throw new Error('db must not be touched when loadRows is injected'); };
  return qb;
});

const logger = require('../services/logger');
const sendgrid = require('../services/sendgrid-mail');
const {
  runTurfVarianceDigest,
  _private: { composeTurfVarianceDigest },
} = require('../services/turf-variance-digest');

function row(deltaPct, overrides = {}) {
  return {
    service_record_id: `sr-${Math.abs(deltaPct)}-${overrides.day || '2026-08-01'}`,
    service_date: overrides.day || '2026-08-01',
    estimated: { turfSqFt: 3200 },
    actual: { treatedSqft: 3200 * (1 + deltaPct / 100) },
    turf_delta_pct: deltaPct,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.TURF_VARIANCE_DIGEST_DISABLED;
  delete process.env.TURF_VARIANCE_DIGEST_EMAIL;
  delete process.env.TURF_VARIANCE_ALERT_PCT;
  delete process.env.TURF_VARIANCE_MIN_SAMPLES;
});

describe('composeTurfVarianceDigest', () => {
  test('quiet window (within threshold) composes nothing', () => {
    expect(composeTurfVarianceDigest([row(5), row(-8), row(10)])).toBeNull();
  });

  test('too few samples composes nothing even at extreme drift', () => {
    expect(composeTurfVarianceDigest([row(80), row(90)])).toBeNull();
  });

  test('positive average = estimates running LOW (underpriced), ACT subject', () => {
    const composed = composeTurfVarianceDigest([row(20), row(30), row(25)]);
    expect(composed.subject).toMatch(/^ACT: lawn turf estimates running low — avg \+25% vs field actuals \(3 services, 30d\)$/);
    expect(composed.direction).toBe('low');
    expect(composed.text).toContain('underpriced turf');
  });

  test('negative average = estimates running HIGH (overpriced) — the 2026-08-05 vision-overshoot class', () => {
    const composed = composeTurfVarianceDigest([row(-20), row(-25), row(-30)]);
    expect(composed.direction).toBe('high');
    expect(composed.subject).toContain('running high');
    expect(composed.text).toContain('overpriced turf');
  });

  test('outliers are the largest |deltas| and read from the JSONB snapshots', () => {
    const rows = [row(16), row(-60, { day: '2026-08-03' }), row(18), row(17), row(19), row(21)];
    const composed = composeTurfVarianceDigest(rows, { thresholdPct: 1 });
    const [first] = composed.text.split('\n').filter((l) => l.startsWith('- '));
    expect(first).toContain('2026-08-03');
    expect(first).toContain('-60%');
    expect(first).toContain('3,200 sq ft');
    // capped at 5 lines
    expect(composed.text.split('\n').filter((l) => l.startsWith('- ')).length).toBe(5);
  });

  test('string-encoded JSONB still renders sqft', () => {
    const composed = composeTurfVarianceDigest([
      { ...row(30), estimated: '{"turfSqFt":2500}', actual: '{"treatedSqft":3250}' },
      row(30), row(30),
    ]);
    expect(composed.text).toContain('2,500 sq ft');
  });

  test('thresholds come from env', () => {
    process.env.TURF_VARIANCE_ALERT_PCT = '40';
    expect(composeTurfVarianceDigest([row(30), row(30), row(30)])).toBeNull();
    process.env.TURF_VARIANCE_MIN_SAMPLES = '5';
    process.env.TURF_VARIANCE_ALERT_PCT = '10';
    expect(composeTurfVarianceDigest([row(30), row(30), row(30)])).toBeNull();
  });
});

describe('runTurfVarianceDigest', () => {
  const hotRows = [row(-20), row(-25), row(-30)];

  test('sends the ACT email to the internal default recipient and stamps the durable send marker', async () => {
    const stampSendMarker = jest.fn();
    const result = await runTurfVarianceDigest({ loadRows: async () => hotRows, stampSendMarker });
    expect(result.sent).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const args = sendgrid.sendOne.mock.calls[0][0];
    expect(args.to).toBe('contact@wavespestcontrol.com');
    expect(args.subject).toMatch(/^ACT: /);
    expect(args.categories).toEqual(['ops', 'turf-variance']);
    expect(stampSendMarker).toHaveBeenCalledTimes(1);
  });

  test('a recent durable send marker skips everything — deploy-overlap double-send guard (codex P1)', async () => {
    const loadRows = jest.fn();
    const result = await runTurfVarianceDigest({ loadRows, sentRecently: async () => true });
    expect(result.skipped).toBe('recent_send');
    expect(loadRows).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('the marker is NOT stamped when the send fails or is skipped', async () => {
    const stampSendMarker = jest.fn();
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 500 }));
    await runTurfVarianceDigest({ loadRows: async () => hotRows, stampSendMarker });
    process.env.TURF_VARIANCE_DIGEST_DISABLED = '1';
    await runTurfVarianceDigest({ loadRows: async () => hotRows, stampSendMarker });
    expect(stampSendMarker).not.toHaveBeenCalled();
  });

  test('quiet window sends nothing', async () => {
    const result = await runTurfVarianceDigest({ loadRows: async () => [row(2), row(-3), row(1)] });
    expect(result.skipped).toBe('within_threshold');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('kill switch skips the send but still reports what it would have said', async () => {
    process.env.TURF_VARIANCE_DIGEST_DISABLED = '1';
    const result = await runTurfVarianceDigest({ loadRows: async () => hotRows });
    expect(result.skipped).toBe('disabled');
    expect(result.avgDeltaPct).toBe(-25);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('fails closed on a non-internal recipient', async () => {
    process.env.TURF_VARIANCE_DIGEST_EMAIL = 'stranger@example.com';
    const result = await runTurfVarianceDigest({ loadRows: async () => hotRows });
    expect(result.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not an internal address'));
  });

  test('query failure is reported, never thrown', async () => {
    const result = await runTurfVarianceDigest({ loadRows: async () => { throw new Error('boom'); } });
    expect(result.skipped).toBe('query_failed');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('send failure reports error without throwing', async () => {
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 500 }));
    const result = await runTurfVarianceDigest({ loadRows: async () => hotRows });
    expect(result.sent).toBe(false);
    expect(result.error).toBe(true);
  });
});
