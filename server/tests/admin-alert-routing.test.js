/**
 * Claude's queue routing (services/admin-alert-routing.js): which admin
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

beforeEach(() => { bellPolicy.bellAllowed.mockClear(); });

// One real-shaped row per class, from the emitters.
const CLASS_ROWS = {
  'sms-draft-canary': { category: 'system', metadata: { dedupeKey: 'sms-draft-canary:smsDraftDefault', source: 'sms-draft-canary' } },
  'ops-reminder-broken': { category: 'system', metadata: { dedupeKey: 'ops-reminder-broken:tech-tips:2026-10-26', opsJob: null, opsKind: 'ask' } },
  'gbp-sync-degraded': { category: 'review', metadata: { locationId: 'venice', reason: 'gbp_sync_degraded', cause: 'no_client' } },
  'gbp-sync-health-escalation': { category: 'review', metadata: { opsKey: 'gbp-sync-health', observedAt: '2026-10-26T10:00:00Z' } },
  'typed-decisions-review': { category: 'typed_decisions', metadata: { dedupeKey: 'typed-decisions-review:2026-11-02', lane: 'typed_decisions', severity: 'fyi', who: 'claude' } },
  'content-terminal-due': { category: 'content', metadata: { dedupeKey: 'content-terminal-due:2026-11-02', terminalDue: 'claude', area: 'Content', severity: 'needs-you', who: 'claude' } },
};
// A fault is broken; the AI-test list the Claude labeler grades and the website drafts list the
// Mac's blog-run job writes are FYIs (owner 2026-11-02).
const CLASS_SEVERITY = { 'typed-decisions-review': 'fyi', 'content-terminal-due': 'fyi' };

describe('routing table', () => {
  test('every class matches its emitter row, with its severity (a fault is broken)', () => {
    expect(Object.keys(CLASS_ROWS).sort()).toEqual(CLAUDE_QUEUE_CLASSES.map((c) => c.name).sort());
    for (const [name, row] of Object.entries(CLASS_ROWS)) {
      expect(classifyClaudeQueue(row)).toEqual({ className: name, severity: CLASS_SEVERITY[name] || 'broken' });
    }
  });

  test('the AI-test list is matched by its own category and key only', () => {
    expect(classifyClaudeQueue({ category: 'system', metadata: { dedupeKey: 'typed-decisions-review:2026-11-02' } })).toBeNull();
    expect(classifyClaudeQueue({ category: 'typed_decisions', metadata: { dedupeKey: 'typed-decisions-other:2026-11-02' } })).toBeNull();
  });

  test('the website drafts list is Claude\'s only while its emitter stamps it; the stalled-list item stays in the bell', () => {
    // The emitter's quiet switch off: the same daily item, unstamped, rings the owner as before.
    expect(classifyClaudeQueue({ category: 'content', metadata: { dedupeKey: 'content-terminal-due:2026-11-02', area: 'Content' } })).toBeNull();
    // The owner's item for a list the terminal stopped handling.
    expect(classifyClaudeQueue({ category: 'content', metadata: { dedupeKey: 'content-terminal-stalled:2026-11-02', who: 'person' } })).toBeNull();
    // The stamp on another category is not the emitter's row.
    expect(classifyClaudeQueue({ category: 'system', metadata: { terminalDue: 'claude' } })).toBeNull();
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

describe('stampClaudeQueue', () => {
  const canary = CLASS_ROWS['sms-draft-canary'];

  test('Activity-only, who claude, severity, class', () => {
    const out = stampClaudeQueue(canary);
    expect(out).toMatchObject({ feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'sms-draft-canary', dedupeKey: canary.metadata.dedupeKey });
    expect(out).not.toBe(canary.metadata);
    // Idempotent: a second stamp (notifyAdmin, then create) returns the same object.
    expect(stampClaudeQueue({ category: canary.category, metadata: out })).toBe(out);
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

  test('a routed row is written Activity-only even when the bell policy would silence it', async () => {
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'system', connection: conn, metadata: { ...CLASS_ROWS['sms-draft-canary'].metadata } }));
    expect(out.id).toBe('n1');
    expect(bellPolicy.bellAllowed).not.toHaveBeenCalled();
    expect(JSON.parse(inserted[0].metadata)).toMatchObject({ feed: 'activity', who: 'claude', severity: 'broken' });
  });

  test('an unrouted row still meets the bell policy (silenced = no row)', async () => {
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'system', connection: conn, metadata: { dedupeKey: 'other:1' } }));
    expect(out).toMatchObject({ suppressed: true, reason: 'bell_policy' });
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

  test('a routed row refreshed by an emission that no longer routes returns to the bell: routing fields cleared', () => {
    const existing = { dedupeKey: 'k', feed: 'activity', who: 'claude', severity: 'needs-you', claudeQueue: 'ops-job', opsJob: 'j', quiet: true };
    const next = { dedupeKey: 'k', opsJob: 'j', opsWho: 'person' };
    for (const ring of [true, false]) {
      const out = mergeRefreshMetadata(existing, next, ring);
      expect(out).toMatchObject({ opsWho: 'person', opsJob: 'j' });
      for (const gone of ['claudeQueue', 'who', 'severity', 'feed']) expect(out).not.toHaveProperty(gone);
    }
  });

  test('on that transition, what the new emission itself carries stands (its own who, severity, feed)', () => {
    const existing = { dedupeKey: 'k', feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'sms-draft-canary' };
    const out = mergeRefreshMetadata(existing, { dedupeKey: 'k', who: 'person', severity: 'needs-you', feed: 'activity' }, false);
    expect(out).toMatchObject({ who: 'person', severity: 'needs-you', feed: 'activity' });
    expect(out).not.toHaveProperty('claudeQueue');
  });

  test('a feed the emitter wrote itself on a never-routed row is left alone', () => {
    const out = mergeRefreshMetadata({ dedupeKey: 'k', feed: 'activity', who: 'person' }, { dedupeKey: 'k', note: 'x' }, false);
    expect(out).toMatchObject({ feed: 'activity', who: 'person', note: 'x' });
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

// GATE_ALERT_CLAUDE_FAULTS (owner 2026-11-02, "build all"): a fault the code marks "Claude fixes this" that the bell
// policy would drop goes to Claude's queue instead. Only a drop is rescued; nothing that rings changes.
describe('dropped Claude faults (classifyClaudeFault, rescueClaudeFault)', () => {
  const { classifyClaudeFault, rescueClaudeFault, CLAUDE_FAULT_TRIGGERS, CLAUDE_FAULT_TRIGGERS_LEFT_OUT, CLAUDE_FAULT_CATEGORIES } = routing;
  beforeEach(() => { process.env.GATE_ALERT_CLAUDE_FAULTS = 'true'; });
  afterEach(() => { delete process.env.GATE_ALERT_CLAUDE_FAULTS; });

  test('the two lists cover exactly the registry rules that say who claude, each one broken', () => {
    const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
    const markedForClaude = Object.keys(TRIGGER_REGISTRY).filter((k) => TRIGGER_REGISTRY[k].rule?.who === 'claude').sort();
    const decided = [...CLAUDE_FAULT_TRIGGERS, ...Object.keys(CLAUDE_FAULT_TRIGGERS_LEFT_OUT)].sort();
    // A new who 'claude' rule fails here until it is rescued or left out with a reason.
    expect(decided).toEqual(markedForClaude);
    expect(CLAUDE_FAULT_TRIGGERS.filter((k) => k in CLAUDE_FAULT_TRIGGERS_LEFT_OUT)).toEqual([]);
    for (const key of CLAUDE_FAULT_TRIGGERS) expect(TRIGGER_REGISTRY[key].rule.severity).toBe('broken');
    for (const why of Object.values(CLAUDE_FAULT_TRIGGERS_LEFT_OUT)) expect(why).toMatch(/\w{3,}/);
  });

  test('a rescued registry fault is broken and named by its trigger; a left-out or unmarked trigger is not rescued', () => {
    for (const key of CLAUDE_FAULT_TRIGGERS) {
      expect(classifyClaudeFault({ category: 'system', triggerKey: key, payload: { failures: [] } })).toEqual({ className: key, severity: 'broken' });
    }
    for (const key of Object.keys(CLAUDE_FAULT_TRIGGERS_LEFT_OUT)) {
      expect(classifyClaudeFault({ category: 'system', triggerKey: key, payload: {} })).toBeNull();
    }
    expect(classifyClaudeFault({ category: 'alert', triggerKey: 'dashboard_alert', payload: {} })).toBeNull();
    // The trigger key may ride in the row's metadata instead (a registry bell write that reaches create()).
    expect(classifyClaudeFault({ category: 'system', metadata: { triggerKey: 'seo_sync_failed' } })).toEqual({ className: 'seo_sync_failed', severity: 'broken' });
  });

  test('an expired-credential alert (token_alert, no metadata at all) is rescued; another raw category is not', () => {
    expect(Object.keys(CLAUDE_FAULT_CATEGORIES)).toEqual(['token_alert']);
    expect(classifyClaudeFault({ category: 'token_alert' })).toEqual({ className: 'token-alert', severity: 'broken' });
    expect(classifyClaudeFault({ category: 'system', metadata: { dedupeKey: 'x' } })).toBeNull();
    expect(classifyClaudeFault({ category: 'call_pipeline_drift' })).toBeNull();
  });

  test('a customer-tied alert, a customer-contact category and an ops_digest row are never rescued', () => {
    const key = 'property_lookup_canary_failed';
    expect(classifyClaudeFault({ category: 'system', triggerKey: key, payload: { customerId: 'c1' } })).toBeNull();
    expect(classifyClaudeFault({ category: 'system', triggerKey: key, payload: { scopeCustomerId: 'c1' } })).toBeNull();
    expect(classifyClaudeFault({ category: 'system', triggerKey: key, payload: { threadId: 't1' } })).toBeNull();
    expect(classifyClaudeFault({ category: 'system', triggerKey: key, metadata: { payload: { scopeCustomerId: 'c1' } } })).toBeNull();
    expect(classifyClaudeFault({ category: 'token_alert', metadata: { customerId: 'c1' } })).toBeNull();
    expect(classifyClaudeFault({ category: 'token_alert', metadata: { scopeCustomerId: 'c1' } })).toBeNull();
    for (const category of ['inbound_sms', 'inbound_email', 'missed_call', 'voicemail_callback', 'new_lead', 'ops_digest']) {
      expect(classifyClaudeFault({ category, triggerKey: key })).toBeNull();
    }
  });

  test('gate off or not exactly true: nothing is rescued', () => {
    for (const v of [undefined, 'false', 'TRUE', '1', 'shadow']) {
      if (v === undefined) delete process.env.GATE_ALERT_CLAUDE_FAULTS; else process.env.GATE_ALERT_CLAUDE_FAULTS = v;
      expect(classifyClaudeFault({ category: 'token_alert' })).toBeNull();
      expect(rescueClaudeFault({ category: 'system', triggerKey: 'seo_sync_failed', metadata: {} })).toBeNull();
    }
  });

  test('rescueClaudeFault stamps a copy for the queue (create() then skips the policy) and keeps the row fields', () => {
    const metadata = { triggerKey: 'event_sources_unhealthy', priority: 'normal', payload: { failingCount: 2 } };
    const out = rescueClaudeFault({ category: 'newsletter', triggerKey: 'event_sources_unhealthy', metadata, payload: metadata.payload });
    expect(out).toEqual({ ...metadata, feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'event_sources_unhealthy' });
    expect(out).not.toBe(metadata);
    // The stamp is the one create() and notifyAdmin already honor: a second stamp returns it unchanged.
    expect(stampClaudeQueue({ category: 'newsletter', metadata: out })).toBe(out);
  });
});

describe('create(): a dropped Claude fault is written to the queue instead', () => {
  const recorder = () => {
    const inserted = [];
    const conn = () => ({ insert: (row) => { inserted.push(row); return { returning: async () => [{ id: 'n2', ...row }] }; } });
    return { conn, inserted };
  };
  const make = (over) => ({ recipientType: 'admin', title: 'cloudflare_workers_ai credential expired', body: 'Check token health', link: '/admin/social-media', ...over });
  afterEach(() => { delete process.env.GATE_ALERT_CLAUDE_FAULTS; bellPolicy.bellAllowed.mockImplementation(async () => false); });

  test('gate on: the policy says drop, so the row is written Activity-only, who claude, broken (no metadata given)', async () => {
    process.env.GATE_ALERT_CLAUDE_FAULTS = 'true';
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'token_alert', connection: conn }));
    expect(out.id).toBe('n2');
    expect(bellPolicy.bellAllowed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(inserted[0].metadata)).toEqual({ feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'token-alert' });
  });

  test('gate off: the same alert is dropped exactly as before (no row)', async () => {
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'token_alert', connection: conn }));
    expect(out).toMatchObject({ suppressed: true, reason: 'bell_policy' });
    expect(inserted).toHaveLength(0);
  });

  test('gate on: an alert the policy lets ring is untouched (a rescue happens only at a drop)', async () => {
    process.env.GATE_ALERT_CLAUDE_FAULTS = 'true';
    bellPolicy.bellAllowed.mockImplementation(async () => true);
    const { conn, inserted } = recorder();
    await NotificationService.create(make({ category: 'token_alert', connection: conn, metadata: { source: 'token-health' } }));
    expect(JSON.parse(inserted[0].metadata)).toEqual({ source: 'token-health' });
  });

  test('gate on: a dropped alert that is not a Claude fault is still dropped', async () => {
    process.env.GATE_ALERT_CLAUDE_FAULTS = 'true';
    const { conn, inserted } = recorder();
    const out = await NotificationService.create(make({ category: 'call_pipeline_drift', connection: conn }));
    expect(out).toMatchObject({ suppressed: true, reason: 'bell_policy' });
    expect(inserted).toHaveLength(0);
  });
});
