/**
 * Claude's queue routing (GATE_ALERT_CLAUDE_QUEUE, services/admin-alert-routing.js): which admin
 * rows leave the owner's bell, and what create() / the refresh merge do with them. No database:
 * create() runs against a recording connection. The write paths against Postgres are in
 * admin-alert-routing-db.test.js (CI).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-bell-policy', () => ({
  isBellPolicyEnabled: jest.fn(() => true),
  bellAllowed: jest.fn(async () => false),
}));

const routing = require('../services/admin-alert-routing');
const NotificationService = require('../services/notification-service');
const bellPolicy = require('../services/notification-bell-policy');

const { classifyClaudeQueue, stampClaudeQueue, CLAUDE_QUEUE_CLASSES } = routing;

beforeEach(() => { process.env.GATE_ALERT_CLAUDE_QUEUE = 'true'; bellPolicy.bellAllowed.mockClear(); });
afterAll(() => { delete process.env.GATE_ALERT_CLAUDE_QUEUE; });

// One real-shaped row per class, from the emitters.
const CLASS_ROWS = {
  'sms-draft-canary': { category: 'system', metadata: { dedupeKey: 'sms-draft-canary:smsDraftDefault', source: 'sms-draft-canary' } },
  'ops-reminder-broken': { category: 'system', metadata: { dedupeKey: 'ops-reminder-broken:tech-tips:2026-10-26', opsJob: null, opsKind: 'ask' } },
  'gbp-sync-degraded': { category: 'review', metadata: { locationId: 'venice', reason: 'gbp_sync_degraded', cause: 'no_client' } },
  'gbp-sync-health-escalation': { category: 'review', metadata: { opsKey: 'gbp-sync-health', observedAt: '2026-10-26T10:00:00Z' } },
};

describe('routing table', () => {
  test('every fault class matches its emitter row and is broken', () => {
    expect(Object.keys(CLASS_ROWS).sort()).toEqual(CLAUDE_QUEUE_CLASSES.map((c) => c.name).sort());
    for (const [name, row] of Object.entries(CLASS_ROWS)) {
      expect(classifyClaudeQueue(row)).toEqual({ className: name, severity: 'broken' });
    }
  });

  test('a Mac reminder job row is Claude\'s; ask is needs-you, fyi is fyi, no kind is needs-you', () => {
    const meta = (extra) => ({ category: 'system', metadata: { opsJob: 'tech-tips', dedupeKey: 'k', ...extra } });
    expect(classifyClaudeQueue(meta({ opsKind: 'ask' }))).toEqual({ className: 'ops-job', severity: 'needs-you' });
    expect(classifyClaudeQueue(meta({ opsKind: 'fyi' }))).toEqual({ className: 'ops-job', severity: 'fyi' });
    expect(classifyClaudeQueue(meta({}))).toEqual({ className: 'ops-job', severity: 'needs-you' });
    // Any category: the Mac job picks its own.
    expect(classifyClaudeQueue({ category: 'billing', metadata: { opsJob: 'x', opsKind: 'ask' } })).not.toBeNull();
  });

  test('an owner ask (opsWho person) stays in the bell', () => {
    expect(classifyClaudeQueue({ category: 'system', metadata: { opsJob: 'gate-flip', opsKind: 'ask', opsWho: 'person' } })).toBeNull();
  });

  test('rows with no stamp and no class stay in the bell', () => {
    expect(classifyClaudeQueue({ category: 'system', metadata: { dedupeKey: 'something-else:1' } })).toBeNull();
    expect(classifyClaudeQueue({ category: 'system', metadata: { dedupeKey: 'old-raw' } })).toBeNull();
    // Right key prefix, wrong category: not the emitter's row.
    expect(classifyClaudeQueue({ category: 'billing', metadata: { dedupeKey: 'sms-draft-canary:x' } })).toBeNull();
    // The ops_digest twin of the GBP escalation stays where it is (owner 2026-09-11).
    expect(classifyClaudeQueue({ category: 'ops_digest', metadata: { opsKey: 'gbp-sync-health', kind: 'FIX', opsJob: undefined } })).toBeNull();
    expect(classifyClaudeQueue({ category: 'ops_digest', metadata: { opsJob: 'ops-check', kind: 'ACT' } })).toBeNull();
  });

  test('customer-contact categories, registry events and customer-tied rows are never routed', () => {
    for (const category of ['inbound_sms', 'inbound_email', 'missed_call', 'voicemail_callback', 'new_lead']) {
      expect(classifyClaudeQueue({ category, metadata: { opsJob: 'x', dedupeKey: 'sms-draft-canary:x', reason: 'gbp_sync_degraded' } })).toBeNull();
    }
    expect(classifyClaudeQueue({ category: 'system', metadata: { opsJob: 'x', triggerKey: 'sms_reply' } })).toBeNull();
    expect(classifyClaudeQueue({ category: 'system', metadata: { opsJob: 'x', customerId: 'c1' } })).toBeNull();
    expect(classifyClaudeQueue({ category: 'system', metadata: { opsJob: 'x', payload: { threadId: 't1' } } })).toBeNull();
  });
});

describe('stampClaudeQueue and the gate', () => {
  const canary = CLASS_ROWS['sms-draft-canary'];

  test('gate on: Activity-only, who claude, severity, class', () => {
    const out = stampClaudeQueue(canary);
    expect(out).toMatchObject({ feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'sms-draft-canary', dedupeKey: canary.metadata.dedupeKey });
    expect(out).not.toBe(canary.metadata);
    // Idempotent: a second stamp (notifyAdmin, then create) returns the same object.
    expect(stampClaudeQueue({ category: canary.category, metadata: out })).toBe(out);
  });

  test('gate off or unset: the metadata object is returned untouched', () => {
    for (const v of [undefined, 'false', '1', 'TRUE']) {
      if (v === undefined) delete process.env.GATE_ALERT_CLAUDE_QUEUE; else process.env.GATE_ALERT_CLAUDE_QUEUE = v;
      expect(stampClaudeQueue(canary)).toBe(canary.metadata);
    }
  });

  test('a stamp overrides a stale who / severity the emitter wrote (the canary raises who person, needs-you)', () => {
    const out = stampClaudeQueue({ category: 'system', metadata: { ...canary.metadata, who: 'person', severity: 'needs-you', quiet: false } });
    expect(out).toMatchObject({ who: 'claude', severity: 'broken', feed: 'activity' });
  });
});

describe('create()', () => {
  const recorder = () => {
    const inserted = [];
    const conn = () => ({ insert: (row) => { inserted.push(row); return { returning: async () => [{ id: 'n1', ...row }] }; } });
    return { conn, inserted };
  };
  const make = (over) => ({ recipientType: 'admin', title: 'T', body: 'B', link: '/admin/agents', ...over });

  test('gate on: a routed row is written Activity-only even when the bell policy would silence it', async () => {
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'system', connection: conn, metadata: { ...CLASS_ROWS['sms-draft-canary'].metadata } }));
    expect(out.id).toBe('n1');
    expect(bellPolicy.bellAllowed).not.toHaveBeenCalled();
    expect(JSON.parse(inserted[0].metadata)).toMatchObject({ feed: 'activity', who: 'claude', severity: 'broken' });
  });

  test('gate on: an unrouted row still meets the bell policy (silenced = no row)', async () => {
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'system', connection: conn, metadata: { dedupeKey: 'other:1' } }));
    expect(out).toMatchObject({ suppressed: true, reason: 'bell_policy' });
    expect(inserted).toHaveLength(0);
  });

  test('gate off: the same row is policy-silenced exactly as before', async () => {
    delete process.env.GATE_ALERT_CLAUDE_QUEUE;
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'system', connection: conn, metadata: { ...CLASS_ROWS['sms-draft-canary'].metadata } }));
    expect(out).toMatchObject({ suppressed: true });
    expect(inserted).toHaveLength(0);
  });

  test('a customer row (non-admin recipient) is never stamped', async () => {
    const { conn, inserted } = recorder();
    await NotificationService.create({ recipientType: 'customer', recipientId: 'c1', category: 'system', title: 'T', body: 'B', connection: conn, metadata: { opsJob: 'x' } });
    expect(JSON.parse(inserted[0].metadata)).toEqual({ opsJob: 'x' });
  });
});

describe('refresh merge', () => {
  const { mergeRefreshMetadata } = NotificationService._private;
  const routed = { dedupeKey: 'k', feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'sms-draft-canary', reason: 'openai_429' };

  test('a routed refresh stays off the bell with or without a ring, and a stale quiet flag is dropped', () => {
    for (const ring of [true, false]) {
      const out = mergeRefreshMetadata({ dedupeKey: 'k', feed: 'activity', quiet: true }, routed, ring);
      expect(out).toMatchObject({ feed: 'activity', who: 'claude', reason: 'openai_429' });
      expect(out).not.toHaveProperty('quiet');
    }
  });

  test('a ringing refresh of a routed row never takes the owner-bell correction (feed null)', () => {
    // Existing merge rule: no audience + quiet true clears feed. A routed row must keep it.
    const out = mergeRefreshMetadata({ dedupeKey: 'k', quiet: true }, routed, true);
    expect(out.feed).toBe('activity');
  });

  test('a bell row refreshed by a routed emission moves off the bell; no ring stamp on a quiet refresh', () => {
    const out = mergeRefreshMetadata({ dedupeKey: 'k', reason: 'old' }, routed, false);
    expect(out).toMatchObject({ feed: 'activity', who: 'claude' });
    expect(out).not.toHaveProperty('rungAt');
  });

  test('an unrouted refresh is unchanged: quiet refresh keeps the existing visibility', () => {
    const out = mergeRefreshMetadata({ dedupeKey: 'k' }, { dedupeKey: 'k', feed: 'activity', quiet: true, note: 'x' }, false);
    expect(out).toEqual({ dedupeKey: 'k', note: 'x' });
  });
});

describe("Claude's queue in the Activity feed (buildActivity)", () => {
  const { buildActivity } = require('../services/agent-activity');
  const row = (over) => ({ id: 'r1', title: 'Fixture', body: 'Why.', detail: null, link: '/admin/reviews', read_at: null, done_at: null,
    created_at: '2026-10-26T10:00:00Z', version: 'v1', ...over });
  const routed = (severity, className, over) => row({ metadata: { feed: 'activity', who: 'claude', severity, claudeQueue: className }, ...over });

  test('a routed needs-you row and a routed fyi row both render, labelled, with title, link, detail and a Done version', () => {
    const feed = buildActivity({ claudeQueue: [
      routed('needs-you', 'ops-job', { id: 'ask', title: 'PR 6407 is live: check it', detail: 'Full text.' }),
      routed('fyi', 'ops-job', { id: 'fyi', title: 'Tech tips: weekly count' }),
      routed('broken', 'sms-draft-canary', { id: 'bad', title: 'SMS draft route FAILING' }),
    ] });
    const byId = Object.fromEntries(feed.items.map((i) => [i.notificationId, i]));
    expect(feed.items).toHaveLength(3);
    expect(byId.ask).toMatchObject({ kind: 'digest', agent: "Claude's queue", status: 'awaiting_review', title: 'PR 6407 is live: check it', link: '/admin/reviews', detail: 'Full text.', version: 'v1' });
    expect(byId.ask.subtitle).toBe('ops job \u00b7 needs Claude');
    expect(byId.fyi).toMatchObject({ agent: "Claude's queue", status: 'completed', title: 'Tech tips: weekly count' });
    expect(byId.fyi.subtitle).toMatch(/FYI$/);
    expect(byId.bad).toMatchObject({ status: 'failed' });
    expect(byId.bad.subtitle).toBe('sms draft canary \u00b7 needs a fix');
  });

  test('a done routed row reads Done and carries no Done version; a bell-only row is not passed in', () => {
    const feed = buildActivity({ claudeQueue: [routed('broken', 'sms-draft-canary', { id: 'closed', done_at: '2026-10-26T12:00:00Z', resolution: 'Recovered.', version: 'v2' })] });
    expect(feed.items[0]).toMatchObject({ status: 'completed', version: null, doneAt: expect.any(String), resolution: 'Recovered.' });
    expect(feed.items[0].subtitle).toMatch(/done$/);
  });

  test('digests render exactly as before when no routed rows exist', () => {
    const digest = { id: 'd1', title: 'ACT: look', created_at: '2026-10-26T09:00:00Z', read_at: null, done_at: null, metadata: { kind: 'ACT' }, link: '/admin' };
    expect(buildActivity({ digests: [digest] })).toEqual(buildActivity({ digests: [digest], claudeQueue: [] }));
  });
});
