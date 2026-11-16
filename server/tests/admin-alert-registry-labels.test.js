/**
 * GATE_ALERT_REGISTRY_LABELS (owner 2026-11-05, admin-alert plan S1): every reader of the stored labels, run against every
 * trigger-registry type, with and without the labels. The point is the hard rule: a customer-contact registry row is never
 * moved off the owner's bell, never closed early and never loses its push because the labels appeared. Pure; no database.
 */
jest.mock('../models/db', () => jest.fn());

const { TRIGGER_REGISTRY, __private } = require('../services/notification-triggers');
const { mapAlertRow } = require('../services/needs-me');
const { classify, CLASSES } = require('../services/admin-alert-relevance');
const routing = require('../services/admin-alert-routing');
const retention = require('../services/admin-alert-retention');
const bellPolicy = require('../services/notification-bell-policy');
const NotificationService = require('../services/notification-service');
const { sendRefusal } = require('../services/admin-alert-send-to-claude');
const { AREAS, SEVERITIES, WHO, DONE_WHEN } = require('../services/admin-alert-compose');

const entries = Object.entries(TRIGGER_REGISTRY).filter(([, t]) => t.rule);
const CUSTOMER_KEYS = entries.filter(([, t]) => t.rule.contact === true || t.rule.promise === true).map(([k]) => k);
const UUID = '11111111-2222-4333-8444-555555555555';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-05T15:00:00Z');

const withGate = (value, fn) => {
  const before = process.env.GATE_ALERT_REGISTRY_LABELS;
  if (value) process.env.GATE_ALERT_REGISTRY_LABELS = value; else delete process.env.GATE_ALERT_REGISTRY_LABELS;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.GATE_ALERT_REGISTRY_LABELS; else process.env.GATE_ALERT_REGISTRY_LABELS = before;
  }
};
const labelsOf = (trigger) => withGate('true', () => __private.registryLabels(trigger));
// The metadata a registry bell row is written with (the part these labels touch): today's keys, plus labels when on.
const metaFor = (key, { labels = true, extra = {} } = {}) => ({
  ...(labels ? labelsOf(TRIGGER_REGISTRY[key]) : {}), triggerKey: key, priority: 'normal', payload: { customerId: UUID }, ...extra,
});
const rowFor = (key, meta, ageDays = 0) => ({
  id: `row-${key}`, category: TRIGGER_REGISTRY[key].category, title: 'Title', body: 'Body', link: '/admin/communications',
  metadata: meta, created_at: new Date(NOW.getTime() - ageDays * DAY_MS), read_at: null, done_at: null,
});

afterEach(() => { delete process.env.GATE_ALERT_CLAUDE_FAULTS; });

describe('the labels a registry type stores are all valid composer values', () => {
  test.each(entries)('%s', (key, trigger) => {
    const labels = labelsOf(trigger);
    expect(AREAS).toContain(labels.area);
    expect(SEVERITIES).toContain(labels.severity);
    expect(WHO).toContain(labels.who);
    if (labels.doneWhen !== undefined) expect(labels.doneWhen).toMatch(DONE_WHEN);
    if (labels.contact !== undefined) expect(labels.contact).toBe(true);
    if (labels.promise !== undefined) expect(labels.promise).toBe(true);
    expect(labels).not.toHaveProperty('subject');
    expect(labels).not.toHaveProperty('buttons');
  });
});

describe('a refreshed standing row keeps its labels', () => {
  test.each(entries)('%s', (key) => {
    const { mergeRefreshMetadata } = NotificationService._private;
    const labelled = metaFor(key);
    const plain = metaFor(key, { labels: false });
    for (const shouldRing of [true, false]) {
      // Labelled row, labelled emission: unchanged labels.
      expect(mergeRefreshMetadata(labelled, { ...labelled, payload: { n: 2 } }, shouldRing)).toMatchObject(labelsOf(TRIGGER_REGISTRY[key]));
      // Labelled row, an emission written while the gate was off: the labels stay (a refresh never strips them).
      expect(mergeRefreshMetadata(labelled, { ...plain, payload: { n: 2 } }, shouldRing)).toMatchObject(labelsOf(TRIGGER_REGISTRY[key]));
      // Old unlabelled row, labelled emission: gains the labels.
      expect(mergeRefreshMetadata(plain, { ...labelled, payload: { n: 2 } }, shouldRing)).toMatchObject(labelsOf(TRIGGER_REGISTRY[key]));
      // Gate off throughout: no label appears.
      const off = mergeRefreshMetadata(plain, { ...plain, payload: { n: 2 } }, shouldRing);
      for (const k of ['area', 'severity', 'who', 'doneWhen', 'contact', 'promise']) expect(off).not.toHaveProperty(k);
    }
  });
});

describe('Claude-queue routing ignores the labels', () => {
  test.each(entries)('%s: stampClaudeQueue and classifyClaudeQueue answer the same with and without labels', (key, trigger) => {
    for (const dedupeKey of [undefined, 'sms-draft-canary:x', 'ops-reminder-broken:j:d']) {
      const plain = metaFor(key, { labels: false });
      const labelled = metaFor(key);
      expect(routing.classifyClaudeQueue({ category: trigger.category, metadata: labelled, dedupeKey }))
        .toEqual(routing.classifyClaudeQueue({ category: trigger.category, metadata: plain, dedupeKey }));
      const stamped = routing.stampClaudeQueue({ category: trigger.category, metadata: labelled, dedupeKey });
      expect(stamped).toBe(labelled); // a registry event is never routed by the queue classes: same object back
    }
  });

  test('a customer-contact type is never rescued or routed, labelled or not', () => {
    process.env.GATE_ALERT_CLAUDE_FAULTS = 'true';
    for (const key of CUSTOMER_KEYS) {
      const { category } = TRIGGER_REGISTRY[key];
      expect(routing.rescueClaudeFault({ category, triggerKey: key, metadata: metaFor(key), payload: { customerId: UUID } })).toBeNull();
      expect(routing.CLAUDE_FAULT_TRIGGERS).not.toContain(key);
    }
  });

  test('exactly the registry types the faults gate names are who claude; the others that say claude are left out on purpose', () => {
    const claudeKeys = entries.filter(([, t]) => t.rule.who === 'claude').map(([k]) => k).sort();
    expect(claudeKeys).toEqual([...routing.CLAUDE_FAULT_TRIGGERS, ...Object.keys(routing.CLAUDE_FAULT_TRIGGERS_LEFT_OUT)].sort());
  });
});

describe('the relevance sweep classes are not captured by the labels', () => {
  // Every class prefix (plus none), so a class that needs a dedupe prefix is tried too; ids a class may read are present.
  const prefixes = ['', ...CLASSES.map((c) => c.prefix).filter(Boolean)];
  test.each(entries)('%s: classify gives the same class with and without labels', (key, trigger) => {
    for (const prefix of prefixes) {
      for (const extra of [{}, { requestId: UUID, customerId: UUID, leadId: UUID }]) {
        // Not a real pairing: messenger_reply (doneWhen customer_answered) is a banner for a bell messenger-inbox.js composes
        // under its own key; it never carries a portal hand-off's or an unfinished booking's dedupe key, which is what those
        // two classes (doneWhen customer_answered, category alert) need besides the label.
        if (key === 'messenger_reply' && prefix.startsWith('portal-')) continue;
        const dedupeKey = prefix ? `${prefix}x` : undefined;
        const base = { ...extra, ...(dedupeKey ? { dedupeKey } : {}) };
        const row = (meta) => ({ category: trigger.category, link: '/admin/communications?lead=' + UUID, metadata: meta });
        const before = classify(row(metaFor(key, { labels: false, extra: base })), { anyMode: true });
        const after = classify(row(metaFor(key, { extra: base })), { anyMode: true });
        expect({ key, prefix, extra, cls: after?.key ?? null }).toEqual({ key, prefix, extra, cls: before?.key ?? null });
      }
    }
  });
});

describe('the bell policy and the push agree with the stored declaration', () => {
  test.each(entries)('%s: ringsAsCustomerAlert reads the same from the rule and from the stored labels', (key, trigger) => {
    const stored = metaFor(key);
    expect(bellPolicy.ringsAsCustomerAlert({ triggerKey: key, declared: { contact: stored.contact === true, promise: stored.promise === true } }))
      .toBe(bellPolicy.ringsAsCustomerAlert({ triggerKey: key, declared: trigger.rule }));
  });
});

describe('retention: only an fyi type is shortened, never a customer row', () => {
  test.each(entries)('%s at 8 days and 40 days idle', (key, trigger) => {
    const eightDays = (meta) => retention.judgeRow(rowFor(key, meta, 8), NOW);
    const fortyDays = (meta) => retention.judgeRow(rowFor(key, meta, 40), NOW);
    const plain = metaFor(key, { labels: false });
    const labelled = metaFor(key);
    // 40 days: the 30-day rule takes it either way.
    expect(fortyDays(labelled).expire).toBe(fortyDays(plain).expire);
    // 8 days: today nothing expires; with labels only an fyi type does.
    expect(eightDays(plain).expire).toBe(false);
    expect(eightDays(labelled).expire).toBe(trigger.rule.severity === 'fyi');
    if (CUSTOMER_KEYS.includes(key)) expect(eightDays(labelled).expire).toBe(false);
  });

  test('the fyi types that start to expire at 7 days are exactly these', () => {
    const fyi = entries.filter(([key]) => retention.judgeRow(rowFor(key, metaFor(key), 8), NOW).expire).map(([k]) => k).sort();
    expect(fyi).toEqual(['job_application_withdrawn', 'job_complete', 'job_interview_booked', 'newsletter_proof_approved',
      'one_tap_purchase_completed', 'open_visits_nudge', 'payment_refunded', 'payment_succeeded', 'waiting_summary']);
  });

  test('the 72-hour quiet policy never reads severity, who or area: a labelled row is judged by its activity alone', () => {
    for (const [key] of entries) {
      for (const labels of [false, true]) {
        const summary = { kept: { refreshed: 0 }, held: { periodic: 0 }, expire: { byCategory: {} } };
        const due = retention.planQuietPage([rowFor(key, metaFor(key, { labels }), 5)], NOW, summary);
        const baseline = retention.planQuietPage([rowFor(key, metaFor(key, { labels: false }), 5)], NOW, { kept: { refreshed: 0 }, held: { periodic: 0 }, expire: { byCategory: {} } });
        expect(due.length).toBe(baseline.length);
      }
    }
  });
});

describe('needs-me, the morning banner and the Monday review read the stored labels', () => {
  const waits = (item) => item.kind === 'alert' && !item.unsorted && !item.activityOnly && !item.sent
    && item.who === 'person' && (item.severity === 'needs-you' || item.severity === 'broken'); // morning-banner.js waitsForPerson

  test.each(entries)('%s', (key, trigger) => {
    const before = mapAlertRow(rowFor(key, metaFor(key, { labels: false })));
    const after = mapAlertRow(rowFor(key, metaFor(key)));
    expect(after.severity).toBe(trigger.rule.severity);
    expect(after.who).toBe(trigger.rule.who);
    expect(after.area).toBe(trigger.rule.area);
    expect(after.doneWhen).toBe(trigger.rule.doneWhen ?? null);
    expect(after.activityOnly).toBe(false); // the labels never move a row off the bell
    expect(after.unsorted).toBe(false);
    // Nothing is invented: the subject is still read from the row's ids, never from the rule.
    expect(after.subject).toEqual(before.subject);
    if (CUSTOMER_KEYS.includes(key)) {
      // A customer row stays work for a person: counted by the banner and the Monday review exactly as before.
      expect(after.severity).toBe('needs-you');
      expect(after.who).toBe('person');
      expect(waits(after)).toBe(true);
      expect(waits(after)).toBe(waits(before));
    }
  });

  test("the types that stop counting as work for a person are exactly the who claude types and the who either one", () => {
    const moved = entries
      .filter(([key]) => waits(mapAlertRow(rowFor(key, metaFor(key, { labels: false })))) && !waits(mapAlertRow(rowFor(key, metaFor(key)))))
      .map(([k]) => k).sort();
    // The banner counts who 'person' only. No customer type is among them.
    expect(moved).toEqual(['event_sources_unhealthy', 'internal_admin_alert', 'kb_audit_flagged', 'property_lookup_canary_failed',
      'seo_sync_failed', 'service_report_delivery_failed', 'service_report_pdf_failed', 'service_report_token_mint_failed']);
    for (const key of CUSTOMER_KEYS) expect(moved).not.toContain(key);
  });

  test("the Monday review drops only who claude rows; its SQL and its item filter agree", () => {
    const mondayCounts = (key, labels) => {
      const item = mapAlertRow(rowFor(key, metaFor(key, { labels })));
      return item.severity === 'needs-you' && !item.unsorted && !item.activityOnly && item.who !== 'claude';
    };
    const dropped = entries.filter(([key]) => mondayCounts(key, false) && !mondayCounts(key, true)).map(([k]) => k).sort();
    expect(dropped).toEqual(entries.filter(([, t]) => t.rule.who === 'claude' && t.rule.severity === 'broken').map(([k]) => k).sort());
    for (const key of CUSTOMER_KEYS) expect(mondayCounts(key, true)).toBe(true);
  });
});

describe('Send to Claude: a customer row is still refused, labelled or not', () => {
  test.each(CUSTOMER_KEYS)('%s', (key) => {
    for (const labels of [false, true]) {
      expect(sendRefusal(rowFor(key, metaFor(key, { labels })))).toBe('customer_contact');
    }
  });
});
