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
  _private: { composeParkedRunDigest, noteExcerpt, redactForEmail, NOTE_WITHHELD },
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
  test('notes carrying email/phone shapes are withheld entirely (structured PII = email-strict withhold)', () => {
    const scrubbed = noteExcerpt('Call adam.b@example.com or (941) 555-1234 about this');
    expect(scrubbed).toBe(NOTE_WITHHELD);
    expect(scrubbed).not.toContain('example.com');
    expect(scrubbed).not.toContain('555-1234');
  });

  test('excerpt truncates to 120 chars with an ellipsis', () => {
    const excerpt = noteExcerpt('Gate finding: '.repeat(30));
    expect(excerpt.length).toBe(121);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  test('empty notes excerpt to null', () => {
    expect(noteExcerpt('   ')).toBeNull();
    expect(noteExcerpt(null)).toBeNull();
  });
});

// ── Codex r3 behaviors: fail-closed confidence gate + canonical note redaction ──

describe('Codex r3: low-confidence redactions are withheld, never emailed raw', () => {
  test("redactForEmail omits text the redactor flags 'low' (all-lowercase prose it is blind to)", () => {
    // The redactor deliberately returns this ORIGINAL text with
    // confidence 'low' — the digest must withhold it, not email it.
    const lowered = 'john smith needs roach control at his rental property immediately';
    expect(redactForEmail(lowered)).toBeNull();
  });

  test('name-only redactions pass through REDACTED (Title-Case furniture must not blank every title)', () => {
    const out = redactForEmail('Termite Damage Repair Guide for Sarasota Homes');
    expect(out).not.toBeNull();
    expect(out).toContain('[name]'); // the cap-pair heuristic fired and redacted
    const clean = redactForEmail('palmetto bug vs roach');
    expect(clean).toBe('palmetto bug vs roach');
  });

  test('a throwing redactor omits the value (fail closed)', () => {
    const piiRedactor = require('../services/content/pii-redactor');
    const spy = jest.spyOn(piiRedactor, 'redact').mockImplementation(() => {
      throw new Error('redactor exploded');
    });
    try {
      expect(redactForEmail('Anything at all, even benign text')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('reviewer notes carrying a street address are withheld entirely, never partially redacted', () => {
    // Synthetic fixture — generated copy echoed into reviewer_notes can
    // repeat a name + street address from the brief. An address is a
    // structured finding, so email-strict mode withholds the whole note
    // (a lowercase name beside the redacted token could survive).
    const excerpt = noteExcerpt('Draft mentions Jane Doe at 4867 Maple Street repeatedly; validation failed.');
    expect(excerpt).toBe(NOTE_WITHHELD);
    expect(excerpt).not.toContain('Jane Doe');
    expect(excerpt).not.toContain('4867 Maple Street');
  });

  test('a low-confidence note is replaced by the neutral placeholder, not the raw text', () => {
    const raw = 'jane doe on maple street complained about ants again and again';
    const excerpt = noteExcerpt(raw);
    expect(excerpt).toBe(NOTE_WITHHELD);
    expect(excerpt).not.toContain('jane doe');
  });

  test('a note the redactor throws on is also withheld', () => {
    const piiRedactor = require('../services/content/pii-redactor');
    const spy = jest.spyOn(piiRedactor, 'redact').mockImplementation(() => {
      throw new Error('redactor exploded');
    });
    try {
      expect(noteExcerpt('Quality gate: 2 findings')).toBe(NOTE_WITHHELD);
    } finally {
      spy.mockRestore();
    }
  });

  test('source pin: the hand-written note sanitizer is gone — notes use the canonical redactForEmail path', () => {
    const src = require('fs').readFileSync(require.resolve('../services/content/parked-run-digest'), 'utf8');
    expect(src).not.toMatch(/sanitizeNote/);
    expect(src).toMatch(/EMAILABLE_CONFIDENCE\.has\(confidence\)/);
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

// ── Codex r1 behaviors ───────────────────────────────────────────────

describe('Codex r1: approvable exclusion, stale once-only, Sunday actionable-only', () => {
  test('stale rows older than the watermark are NOT resent (Sunday full digest, active rows present)', async () => {
    const d = deps({
      active: [item({ parked_at: '2026-08-08T10:00:00Z' })],
      stale: [item({ parked_at: '2026-07-01T10:00:00Z' }), item({ parked_at: '2026-08-08T18:00:00Z' })],
      watermark: '2026-08-07T12:00:00Z',
      now: SUNDAY,
    });
    const r = await runParkedRunDigest(d);
    expect(r.sent).toBe(true);
    // Only the post-watermark stale row rides along; the July one was
    // surfaced already and the portal can never clear it — no weekly loop.
    expect(r.staleCount).toBe(1);
  });

  test('Sunday with ONLY stale rows (no actionable active) does not send', async () => {
    const d = deps({
      active: [],
      stale: [item({ parked_at: '2026-07-01T10:00:00Z' })],
      watermark: '2026-08-07T12:00:00Z',
      now: SUNDAY,
    });
    const r = await runParkedRunDigest(d);
    expect(r.sent).toBeUndefined();
    expect(email.send).not.toHaveBeenCalled();
  });

  test('first-ever digest still surfaces the whole stale backlog once', async () => {
    const d = deps({
      active: [item({ parked_at: '2026-08-05T10:00:00Z' })],
      stale: [item({ parked_at: '2026-06-01T10:00:00Z' })],
      watermark: null,
      now: THURSDAY,
    });
    const r = await runParkedRunDigest(d);
    expect(r.sent).toBe(true);
    expect(r.staleCount).toBe(1);
  });

  test('loadParkedSet excludes approvable kinds via the shared email-approvals classifier', () => {
    const { isApprovableKind } = require('../services/content/email-approvals');
    expect(isApprovableKind('named_competitor_review')).toBe(true);
    expect(isApprovableKind('trust_build_2_of_3')).toBe(true);
    expect(isApprovableKind('gate_fail')).toBe(false);
    // The digest source filters on this exact predicate (see loadParkedSet)
    // so the two lanes can never diverge on what "approvable" means.
    const src = require('fs').readFileSync(require.resolve('../services/content/parked-run-digest'), 'utf8');
    expect(src).toMatch(/isApprovableKind\(row\.skip_reason\)/);
    expect(src).not.toMatch(/named_competitor_review\|trust_build/); // no second regex copy
  });
});

describe('Codex r2: pre-split approvable exclusion + PII redaction', () => {
  test('a decided approvable run never lands in the stale bucket', async () => {
    const { loadParkedSet } = require('../services/content/parked-run-digest');
    // Source-level pin: the approvable exclusion guards BOTH buckets — the
    // active builder (skipReason from the latest run or the opportunity)
    // and the stale loop — so a dismissed approvable run can't resurface.
    const src = require('fs').readFileSync(require.resolve('../services/content/parked-run-digest'), 'utf8');
    expect(src).toMatch(/isApprovableKind\(skipReason\)/); // active side
    expect(src).toMatch(/isApprovableKind\(row\.skip_reason\)/); // stale side
    expect(typeof loadParkedSet).toBe('function');
  });

  test('customer-derived query/title text is redacted through pii-redactor before composition', () => {
    const src = require('fs').readFileSync(require.resolve('../services/content/parked-run-digest'), 'utf8');
    expect(src).toMatch(/require\('\.\/pii-redactor'\)/);
    expect(src).toMatch(/redactForEmail\(row\.query/);
    expect(src).toMatch(/redactForEmail\(draftTitle/);
    const digest = require('../services/content/parked-run-digest');
    const redactForEmail = digest._private?.redactForEmail;
    if (redactForEmail) {
      // Phone = structured finding → the whole value is withheld (r4).
      expect(redactForEmail('call from John Smith at 941-555-1234')).toBeNull();
    }
  });
});

// ── Codex r4 behaviors: portal-mirrored active set, transition timestamps,
// structured-PII withholding ───────────────────────────────────────────────

describe('Codex r4: email-strict redaction withholds structured-PII values entirely', () => {
  test("the exact r4 counter-examples are withheld despite 'high'/'medium' confidence", () => {
    // redact() reports these emailable (phone → high, address → medium)
    // while the lowercase names beside the redacted tokens survive — the
    // digest must withhold the whole value, not trust confidence alone.
    expect(redactForEmail('jane doe, call 941-555-1234')).toBeNull();
    expect(redactForEmail('john smith at 4867 maple street')).toBeNull();
  });

  test('clean lowercase SEO queries still flow through untouched', () => {
    expect(redactForEmail('lawn fungus treatment bradenton')).toBe('lawn fungus treatment bradenton');
  });

  test('source pin: the strict gate withholds on any non-name finding', () => {
    const src = require('fs').readFileSync(require.resolve('../services/content/parked-run-digest'), 'utf8');
    expect(src).toMatch(/findings\.some\(\(f\) => f\.type !== 'name'\)/);
  });
});

describe('Codex r4: active set mirrors the portal queue; janitor conversions get transition timestamps', () => {
  const digest = require('../services/content/parked-run-digest');
  const { activeParkedAt } = digest._private;

  test('a janitor-converted item is dated by the opportunity transition stamp, not the run\'s preserved completion', () => {
    // The janitor rewrites the run's outcome/skip_reason but deliberately
    // preserves run.completed_at; its opportunity path stamps
    // opp.completed_at at the pending_review transition — that stamp is
    // what keeps the converted item in front of the watermark.
    const run = {
      completed_at: '2026-08-01T10:00:00Z', // original approval-request park
      created_at: '2026-08-01T09:00:00Z',
      updated_at: '2026-08-06T02:00:00Z',
    };
    const opp = { completed_at: '2026-08-06T02:00:00Z', updated_at: '2026-08-06T02:00:00Z' };
    expect(activeParkedAt(run, opp)).toEqual(new Date('2026-08-06T02:00:00Z'));
  });

  test('mutable updated_at columns are never consulted: miner re-touches and run writes cannot re-date an item', () => {
    // The miner upsert preserves pending_review via its status CASE but
    // stamps opp.updated_at = now() every morning; PR polling/remediation/
    // note edits bump run.updated_at. Neither may classify the unchanged
    // backlog as "new".
    const run = { completed_at: '2026-08-01T10:00:00Z', created_at: '2026-08-01T09:00:00Z', updated_at: '2026-08-07T09:00:00Z' };
    const opp = { completed_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-07T08:00:00Z', created_at: '2026-07-01T00:00:00Z' };
    expect(activeParkedAt(run, opp)).toEqual(new Date('2026-08-01T10:00:00Z'));
  });

  test('a pending_review opportunity with no run at all dates from its transition-stamped completed_at', () => {
    expect(activeParkedAt(null, { updated_at: '2026-08-07T08:00:00Z', completed_at: '2026-08-05T10:00:00Z' }))
      .toEqual(new Date('2026-08-05T10:00:00Z'));
  });

  test('source pin: activeParkedAt anchors on the stable transition stamps only', () => {
    const src = require('fs').readFileSync(require.resolve('../services/content/parked-run-digest'), 'utf8');
    expect(src).toMatch(/opp\?\.completed_at \|\| run\?\.completed_at/);
    // No mutable general-purpose timestamp feeds watermark classification.
    expect(src).not.toMatch(/activeParkedAt[\s\S]{0,400}updated_at \|\|/);
  });

  test('source pin: the active set derives from opportunity_queue pending_review state, not a single run outcome', () => {
    const src = require('fs').readFileSync(require.resolve('../services/content/parked-run-digest'), 'utf8');
    // Active query starts from the queue's pending-review state…
    expect(src).toMatch(/db\('opportunity_queue'\)\s*\n\s*\.where\('status', 'pending_review'\)/);
    // …and the run outcome filter survives ONLY on the stale side.
    const activeIdx = src.indexOf("db('opportunity_queue')");
    const outcomeIdx = src.indexOf("where('r.outcome', 'completed_pending_review')");
    expect(activeIdx).toBeGreaterThan(-1);
    expect(outcomeIdx).toBeGreaterThan(activeIdx);
  });
});
