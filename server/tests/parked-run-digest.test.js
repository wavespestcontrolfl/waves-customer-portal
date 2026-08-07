/**
 * parked-run-digest.test.js — owner visibility digest for silently parked
 * autonomous content runs. Covers: grouping by skip_reason, the stale
 * bucket, watermark advance ONLY on a successful send (fail-closed), gate
 * off → no-op, ACT: subject format, no-new-parks → no send, and the Sunday
 * full digest.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/email', () => ({
  send: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../models/db', () => {
  const qb = () => { throw new Error('db must not be touched when loaders are injected'); };
  return qb;
});

const email = require('../services/email');
const { isEnabled } = require('../config/feature-gates');
const {
  runParkedRunDigest,
  _private: { composeParkedRunDigest, sanitizeNote, noteExcerpt },
} = require('../services/content/parked-run-digest');

// 2026-08-06 is a Thursday; 2026-08-09 is a Sunday (both at 8am ET).
const THURSDAY = '2026-08-06T12:00:00Z';
const SUNDAY = '2026-08-09T12:00:00Z';

let seq = 0;
function item(overrides = {}) {
  seq += 1;
  return {
    run_id: `run-${seq}`,
    opportunity_id: `opp-${seq}`,
    skip_reason: 'gate_fail',
    title: `Draft title ${seq}`,
    query: `query ${seq}`,
    page_type: 'supporting-blog',
    parked_at: '2026-08-05T10:00:00Z',
    note: 'quality gate: 2 findings',
    ...overrides,
  };
}

function deps({ active = [], stale = [], watermark = null, now = THURSDAY } = {}) {
  return {
    now,
    loadParkedSet: jest.fn(async () => ({ active, stale })),
    getWatermark: jest.fn(async () => (watermark ? new Date(watermark) : null)),
    advanceWatermark: jest.fn(async () => {}),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  email.send.mockResolvedValue({ ok: true });
  delete process.env.PARKED_RUN_DIGEST_EMAIL;
  delete process.env.ADMIN_PORTAL_URL;
});

describe('composeParkedRunDigest', () => {
  test('groups active items by skip_reason with per-group counts, largest first', () => {
    const composed = composeParkedRunDigest({
      active: [
        item({ skip_reason: 'gate_fail' }),
        item({ skip_reason: 'gate_fail' }),
        item({ skip_reason: 'gate_fail' }),
        item({ skip_reason: 'operator_slug_mismatch' }),
      ],
      stale: [],
      newCount: 2,
    });
    expect(composed.bodyHtml).toContain('<strong>gate_fail</strong> (3)');
    expect(composed.bodyHtml).toContain('<strong>operator_slug_mismatch</strong> (1)');
    expect(composed.bodyHtml.indexOf('gate_fail</strong> (3)'))
      .toBeLessThan(composed.bodyHtml.indexOf('operator_slug_mismatch</strong> (1)'));
    expect(composed.bodyHtml).toContain('Awaiting your decision (4)');
  });

  test('stale items land in a separate "probably dismissible" bucket, not the active one', () => {
    const composed = composeParkedRunDigest({
      active: [item({ skip_reason: 'gate_fail' })],
      stale: [
        item({ skip_reason: 'publish_validation_failed', opp_status: 'skipped' }),
        item({ skip_reason: 'publish_validation_failed', opp_status: 'gone' }),
      ],
      newCount: 0,
    });
    expect(composed.bodyHtml).toContain('Stale — probably dismissible (2)');
    expect(composed.bodyHtml).toContain('Awaiting your decision (1)');
    expect(composed.bodyHtml).toContain('opportunity skipped');
    expect(composed.bodyHtml).toContain('opportunity gone');
    expect(composed.staleCount).toBe(2);
  });

  test('subject follows the ACT: ops convention with total and new counts', () => {
    const composed = composeParkedRunDigest({
      active: Array.from({ length: 62 }, () => item()),
      stale: Array.from({ length: 12 }, () => item({ opp_status: 'done' })),
      newCount: 12,
    });
    expect(composed.subject).toBe('ACT: 74 content drafts parked for review (12 new since last digest)');
    expect(composed.subject).toMatch(/^ACT: /);
  });

  test('deep links point at the real review-queue route on the portal host', () => {
    const composed = composeParkedRunDigest({ active: [item()], stale: [], newCount: 1 });
    expect(composed.bodyHtml).toContain('https://portal.wavespestcontrol.com/admin/blog?tab=autopilot');
  });

  test('items carry title/query/page_type/parked date and the note excerpt', () => {
    const composed = composeParkedRunDigest({
      active: [item({ title: 'Palmetto bug guide', query: 'palmetto bug vs roach', page_type: 'hub', note: 'uniqueness gate: near-dup of /pest-library' })],
      stale: [],
      newCount: 1,
    });
    expect(composed.bodyHtml).toContain('Palmetto bug guide');
    expect(composed.bodyHtml).toContain('palmetto bug vs roach');
    expect(composed.bodyHtml).toContain('hub');
    expect(composed.bodyHtml).toContain('parked 2026-08-05');
    expect(composed.bodyHtml).toContain('uniqueness gate: near-dup of /pest-library');
  });

  test('empty set composes nothing', () => {
    expect(composeParkedRunDigest({ active: [], stale: [], newCount: 0 })).toBeNull();
  });
});

describe('note excerpts (no PII)', () => {
  test('email addresses and phone shapes are scrubbed', () => {
    const scrubbed = sanitizeNote('call adam.b@example.com or (941) 555-1234 about this');
    expect(scrubbed).not.toContain('example.com');
    expect(scrubbed).not.toContain('555-1234');
    expect(scrubbed).toContain('[email]');
    expect(scrubbed).toContain('[phone]');
  });

  test('excerpt truncates to 120 chars with an ellipsis', () => {
    const excerpt = noteExcerpt('x'.repeat(300));
    expect(excerpt.length).toBe(121);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  test('empty notes excerpt to null', () => {
    expect(noteExcerpt('   ')).toBeNull();
    expect(noteExcerpt(null)).toBeNull();
  });
});

describe('runParkedRunDigest cadence + watermark', () => {
  test('gate off → no-op: nothing loaded, nothing sent', async () => {
    isEnabled.mockReturnValue(false);
    const d = deps({ active: [item()] });
    const result = await runParkedRunDigest(d);
    expect(result).toEqual({ skipped: 'gate_off' });
    expect(d.loadParkedSet).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  test('no parked runs at all → never sends', async () => {
    const result = await runParkedRunDigest(deps({ active: [], stale: [] }));
    expect(result).toEqual({ skipped: 'no_parked_runs' });
    expect(email.send).not.toHaveBeenCalled();
  });

  test('new parks since the watermark → sends and advances the watermark to the tick time', async () => {
    const d = deps({
      active: [item({ parked_at: '2026-08-05T10:00:00Z' })],
      watermark: '2026-08-01T00:00:00Z',
      now: THURSDAY,
    });
    const result = await runParkedRunDigest(d);
    expect(result.sent).toBe(true);
    expect(result.newCount).toBe(1);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].to).toBe('contact@wavespestcontrol.com');
    expect(email.send.mock.calls[0][0].subject).toMatch(/^ACT: 1 content drafts parked for review \(1 new since last digest\)$/);
    expect(d.advanceWatermark).toHaveBeenCalledTimes(1);
    expect(d.advanceWatermark.mock.calls[0][0]).toEqual(new Date(THURSDAY));
  });

  test('no NEW parks on a weekday → no send even with a non-empty backlog', async () => {
    const d = deps({
      active: [item({ parked_at: '2026-07-01T10:00:00Z' })],
      stale: [item({ parked_at: '2026-07-02T10:00:00Z', opp_status: 'done' })],
      watermark: '2026-08-01T00:00:00Z',
      now: THURSDAY,
    });
    const result = await runParkedRunDigest(d);
    expect(result).toEqual({ skipped: 'no_new_parks' });
    expect(email.send).not.toHaveBeenCalled();
    expect(d.advanceWatermark).not.toHaveBeenCalled();
  });

  test('Sunday sends the full digest even with zero new parks, when the set is non-empty', async () => {
    const d = deps({
      active: [item({ parked_at: '2026-07-01T10:00:00Z' })],
      watermark: '2026-08-01T00:00:00Z',
      now: SUNDAY,
    });
    const result = await runParkedRunDigest(d);
    expect(result.sent).toBe(true);
    expect(result.newCount).toBe(0);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(d.advanceWatermark).toHaveBeenCalledTimes(1);
  });

  test('Sunday does NOT double-send after a same-ET-day send (deploy-overlap tick)', async () => {
    const d = deps({
      active: [item({ parked_at: '2026-07-01T10:00:00Z' })],
      // Watermark stamped earlier the same ET Sunday.
      watermark: '2026-08-09T11:00:00Z',
      now: SUNDAY,
    });
    const result = await runParkedRunDigest(d);
    expect(result).toEqual({ skipped: 'no_new_parks' });
    expect(email.send).not.toHaveBeenCalled();
  });

  test('first run ever (no watermark) treats the whole backlog as new and sends once', async () => {
    const d = deps({
      active: [item(), item()],
      stale: [item({ opp_status: 'skipped' })],
      watermark: null,
      now: THURSDAY,
    });
    const result = await runParkedRunDigest(d);
    expect(result.sent).toBe(true);
    expect(result.newCount).toBe(3);
    expect(result.subject).toBe('ACT: 3 content drafts parked for review (3 new since last digest)');
  });

  test('FAIL CLOSED on send: { ok:false } from the mailer leaves the watermark alone', async () => {
    email.send.mockResolvedValue({ ok: false, error: 'smtp down' });
    const d = deps({ active: [item()], watermark: null, now: THURSDAY });
    const result = await runParkedRunDigest(d);
    expect(result.sent).toBe(false);
    expect(result.error).toBe('smtp down');
    expect(d.advanceWatermark).not.toHaveBeenCalled();
  });

  test('FAIL CLOSED on send: a throwing mailer also leaves the watermark alone', async () => {
    email.send.mockRejectedValue(new Error('socket hang up'));
    const d = deps({ active: [item()], watermark: null, now: THURSDAY });
    const result = await runParkedRunDigest(d);
    expect(result.sent).toBe(false);
    expect(result.error).toBe('socket hang up');
    expect(d.advanceWatermark).not.toHaveBeenCalled();
  });

  test('parked-set query failure is fail-soft: skips, never throws out of the tick', async () => {
    const d = deps({});
    d.loadParkedSet = jest.fn(async () => { throw new Error('relation missing'); });
    const result = await runParkedRunDigest(d);
    expect(result).toEqual({ skipped: 'query_failed' });
    expect(email.send).not.toHaveBeenCalled();
  });

  test('non-internal recipient env fails closed: no send, no watermark advance', async () => {
    process.env.PARKED_RUN_DIGEST_EMAIL = 'someone@gmail.com';
    const d = deps({ active: [item()], watermark: null, now: THURSDAY });
    const result = await runParkedRunDigest(d);
    expect(result).toEqual({ skipped: 'recipient' });
    expect(email.send).not.toHaveBeenCalled();
    expect(d.advanceWatermark).not.toHaveBeenCalled();
  });
});
