// Cadence-engine behavior: start → advance → auto-stop on review → complete.
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true, auditLogId: 'audit-1' }));
const mockEmailSendTemplate = jest.fn(async () => ({ sent: true, message: { id: 'em-1' } }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/visit-completion-packets', () => ({
  enrollVisitCompletionReview: jest.fn(),
  enrollVisitCompletionReviewForInvoice: jest.fn(),
}));
// Mutable gate flags for the 2026-07-30 revamp tests (post-service auto-enroll
// + direct Google link). Both default OFF = pre-rollout behavior.
const mockGates = { reviewSequences: false, reviewDirectLink: false };
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => !!mockGates[g],
  gates: mockGates,
}));
// Personalized-ask drafter (own suite: review-ask-drafter.test.js). Default
// null = template path, matching the gate-off production posture.
const mockDraftAskBody = jest.fn(async () => null);
const mockDraftEmailIntro = jest.fn(async () => null);
jest.mock('../services/review-ask-drafter', () => ({
  draftAskBody: (...a) => mockDraftAskBody(...a),
  draftEmailIntro: (...a) => mockDraftEmailIntro(...a),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The per-customer send lock needs a real pool; its own suite covers it.
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (key, fn) => {
    (global.__reviewLockKeys = global.__reviewLockKeys || []).push(key);
    const held = global.__reviewLockHeld = global.__reviewLockHeld || new Set();
    if (held.has(key)) return { skipped: true, reason: 'lease_held' };
    held.add(key);
    try { return await fn(); } finally { held.delete(key); }
  },
  wasLockSkipped: result => result?.skipped === true,
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendCustomerMessage(...a) }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: (...a) => mockEmailSendTemplate(...a) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.test' }));
jest.mock('../services/customer-contact', () => ({
  // Honor explicit null/'' so tests can model a customer missing a channel.
  // service_contact_email models a service contact who is NOT the account
  // holder (email-intro identity-guard tests) — same pattern as the phone.
  getServiceContact: (c) => ({
    phone: c.phone !== undefined ? c.phone : '+19410000000',
    email: c.service_contact_email !== undefined
      ? c.service_contact_email
      : (c.email !== undefined ? c.email : 'x@y.com'),
    name: c.first_name || 'Stan',
  }),
  // The SMS resolver mirrors getServiceContact in these fixtures (no
  // service-contact phones are modeled, so gating never diverges).
  getServiceContactSmsRecipient: (c) => ({
    // service_contact_phone models a consented service contact who is NOT the
    // account holder (recipient-identity guard tests).
    phone: c.service_contact_phone !== undefined
      ? c.service_contact_phone
      : (c.phone !== undefined ? c.phone : '+19410000000'),
    email: c.email !== undefined ? c.email : 'x@y.com',
    name: c.first_name || 'Stan',
  }),
  firstNameFrom: (v) => String(v == null ? '' : v).trim().split(/\s+/)[0] || '',
}));

const db = require('../models/db');
// Passthrough transaction: the callback gets the db fn itself, which routes
// to whichever mock is currently installed (no rollback semantics — tests
// assert outcomes, not isolation).
db.transaction = async (fn) => fn(db);
const ReviewService = require('../services/review-request');

function valueFor(row, column) { return row[String(column).split('.').pop()]; }

function makeMock(initial = {}, opts = {}) {
  const state = { rows: { customers: [], review_sequences: [], review_requests: [], notification_prefs: [], google_reviews: [], scheduled_services: [], activity_log: [], ...initial } };
  const throwUpdateFor = new Set(opts.throwUpdateFor || []);
  // Fail one specific SELECT: a predicate over the built query (table,
  // equals/ops/raws/selected) so a test can break a single lookup and leave
  // the rest of the runner alone.
  const throwSelectWhen = typeof opts.throwSelectWhen === 'function' ? opts.throwSelectWhen : null;
  function filtered(q) {
    let rows = [...(state.rows[q.table] || [])];
    rows = rows.filter((r) => q.equals.every(([k, v]) => valueFor(r, k) === v));
    rows = rows.filter((r) => q.notEquals.every(([k, v]) => valueFor(r, k) !== v));
    rows = rows.filter((r) => q.notNull.every((k) => valueFor(r, k) != null));
    rows = rows.filter((r) => q.nulls.every((k) => valueFor(r, k) == null));
    rows = rows.filter((r) => q.ins.every(([k, vs]) => vs.includes(valueFor(r, k))));
    rows = rows.filter((r) => q.notIns.every(([k, vs]) => !vs.includes(valueFor(r, k))));
    rows = rows.filter((r) => q.ops.every(([k, op, v]) => {
      const l = valueFor(r, k); if (l == null) return false;
      return op === '>=' ? l >= v : op === '<=' ? l <= v : op === '>' ? l > v : op === '<' ? l < v : l === v;
    }));
    if (q.order) { const [k, d] = q.order; rows.sort((a, b) => { const av = valueFor(a, k), bv = valueFor(b, k); if (av === bv) return 0; const x = av > bv ? 1 : -1; return d === 'desc' ? -x : x; }); }
    return q.limitValue ? rows.slice(0, q.limitValue) : rows;
  }
  function make(tbl) {
    const t = String(tbl).split(/\s+as\s+/i)[0];
    const q = {
      table: t, equals: [], notEquals: [], notNull: [], nulls: [], ops: [], ins: [], notIns: [], raws: [], order: null, limitValue: null,
      where(a, op, v) {
        if (typeof a === 'function') { a(this); return this; }
        if (a && typeof a === 'object') { Object.entries(a).forEach(([k, val]) => this.equals.push([k, val])); return this; }
        if (arguments.length === 3) { if (op === '!=') this.notEquals.push([a, v]); else this.ops.push([a, op, v]); return this; }
        this.equals.push([a, op]); return this;
      },
      orWhere() { return this; },
      whereRaw(sql) { this.raws.push(sql); return this; },
      whereNot(c, v) { this.notEquals.push([c, v]); return this; },
      whereIn(c, vs) { this.ins.push([c, vs]); return this; },
      whereNotIn(c, vs) { this.notIns.push([c, vs]); return this; },
      whereNotNull(c) { this.notNull.push(c); return this; },
      whereNull(c) { this.nulls.push(c); return this; },
      leftJoin() { return this; }, joinRaw() { return this; }, select(...cols) { this.selected = cols; return this; },
      orderBy(c, d = 'asc') { this.order = [c, d]; return this; },
      orderByRaw() { return this; }, groupBy() { return this; }, groupByRaw() { return this; },
      limit(n) { this.limitValue = n; return this; },
      async first() { return filtered(this)[0] || null; },
      count() { return { first: async () => ({ count: String(filtered(this).length), c: String(filtered(this).length) }) }; },
      insert(row) {
        if (!state.rows[this.table]) state.rows[this.table] = [];
        if (opts.onInsert) { const veto = opts.onInsert(this.table, row, state); if (veto) return { returning: async () => { throw veto; } }; }
        const inserted = { id: row.id || `${this.table}-${state.rows[this.table].length + 1}`, ...row };
        state.rows[this.table].push(inserted);
        return { returning: async () => [inserted] };
      },
      async update(patch) { if (opts.onUpdate) opts.onUpdate(this.table, patch, state); if (throwUpdateFor.has(this.table)) throw new Error('pg blip on update'); const rows = filtered(this); rows.forEach((r) => Object.assign(r, patch)); return rows.length; },
      async del() { const rows = filtered(this); const arr = state.rows[this.table] || []; rows.forEach((r) => { const i = arr.indexOf(r); if (i >= 0) arr.splice(i, 1); }); return rows.length; },
      then(res, rej) {
        if (throwSelectWhen && throwSelectWhen(this)) {
          return Promise.reject(new Error('pg blip on select')).then(res, rej);
        }
        return Promise.resolve(filtered(this)).then(res, rej);
      },
    };
    return q;
  }
  const conn = jest.fn(make);
  conn.__state = state;
  return conn;
}

beforeEach(() => {
  mockSendCustomerMessage.mockClear();
  mockEmailSendTemplate.mockClear();
  mockGates.reviewSequences = false;
  mockGates.reviewDirectLink = false;
  mockDraftAskBody.mockReset().mockResolvedValue(null);
  mockDraftEmailIntro.mockReset().mockResolvedValue(null);
});

describe('review sequences — cadence engine', () => {
  test('startReviewSequence fires step 0, advances to step 1, and records the touch', async () => {
    const mock = makeMock({
      customers: [{ id: 'cust-1', first_name: 'Stan', last_name: 'S', nearest_location_id: 'bradenton' }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'cust-1', serviceType: 'pest control', techName: 'Adam', startedBy: 'admin-1' });

    expect(result.started).toBe(true);
    expect(result.sequence.current_step).toBe(1);
    expect(result.sequence.touches_sent).toBe(1);
    expect(result.sequence.status).toBe('active');

    // One SMS touch went out via the messaging middleware.
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCustomerMessage.mock.calls[0][0]).toMatchObject({ channel: 'sms', purpose: 'review_request', customerId: 'cust-1' });

    // The touch is recorded in review_requests with channel + template + sequence linkage,
    // and marked followup_sent so the legacy Day-3 auto-followup skips it.
    const touch = mock.__state.rows.review_requests[0];
    expect(touch).toMatchObject({ channel: 'sms', template_key: 'day0_ask', sequence_step: 0, followup_sent: true, status: 'sent' });
    expect(touch.sequence_id).toBe(result.sequence.id);
  });

  test('a sequence auto-stops (no send) once the customer has left a review', async () => {
    const mock = makeMock({
      customers: [{ id: 'cust-2', first_name: 'Mae', last_name: 'R', has_left_google_review: true, nearest_location_id: 'venice' }],
      review_sequences: [{
        id: 'seq-2', customer_id: 'cust-2', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 5 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    const seq = mock.__state.rows.review_sequences[0];
    expect(seq.status).toBe('stopped');
    expect(seq.stop_reason).toBe('reviewed');
  });

  test('a cadence stops after the customer submits private feedback (no further asks)', async () => {
    const mock = makeMock({
      customers: [{ id: 'f1', first_name: 'Fee', last_name: 'D', phone: '+19410000020', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seqF', customer_id: 'f1', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 4 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
      // The Day-0 touch was submitted as a detractor (score, no Google redirect,
      // no has_left_google_review / google_reviews row).
      review_requests: [{ id: 'rrF', sequence_id: 'seqF', customer_id: 'f1', channel: 'sms', sms_sent_at: new Date(Date.now() - 3 * 86400000), submitted_at: new Date(Date.now() - 2 * 86400000), score: 4, category: 'detractor' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    const seq = mock.__state.rows.review_sequences[0];
    expect(seq.status).toBe('stopped');
    expect(seq.stop_reason).toBe('responded');
  });

  test('a cadence stops once the lifetime 3-ask cap is reached', async () => {
    const mock = makeMock({
      customers: [{ id: 'cap1', first_name: 'Max', last_name: 'A', phone: '+19410000030', nearest_location_id: 'venice' }],
      review_sequences: [{
        id: 'seqCap', customer_id: 'cap1', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 4 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
      // 3 delivered review asks already exist (e.g. 2 prior + the cadence Day-0).
      review_requests: [
        { customer_id: 'cap1', channel: 'sms', sms_sent_at: new Date('2026-06-01') },
        { customer_id: 'cap1', channel: 'sms', sms_sent_at: new Date('2026-06-10') },
        { customer_id: 'cap1', sequence_id: 'seqCap', channel: 'sms', sms_sent_at: new Date('2026-06-20') },
      ],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('capped');
  });

  test('stopReviewSequence reaches a parked (deferred) series final, leaves a redeeming lease alone (codex #4140 r18 P2)', async () => {
    const mock = makeMock({
      review_sequences: [
        { id: 'seqParked', customer_id: 'p1', status: 'deferred', next_run_at: new Date(Date.now() + 30 * 60000), plan: JSON.stringify([{ channel: 'sms' }]), current_step: 0 },
        { id: 'seqLease', customer_id: 'p2', status: 'redeeming', next_run_at: null, plan: JSON.stringify([{ channel: 'sms' }]), current_step: 0 },
        { id: 'seqActive', customer_id: 'p3', status: 'active', next_run_at: new Date(), plan: JSON.stringify([{ channel: 'sms' }]), current_step: 0 },
      ],
    });
    db.mockImplementation(mock);

    expect(await ReviewService.stopReviewSequence('seqParked')).toEqual({ stopped: true });
    expect(mock.__state.rows.review_sequences[0]).toMatchObject({ status: 'stopped', stop_reason: 'manual', next_run_at: null });
    expect(await ReviewService.stopReviewSequence('seqLease')).toEqual({ stopped: false });
    expect(mock.__state.rows.review_sequences[1].status).toBe('redeeming');
    expect(await ReviewService.stopReviewSequence('seqActive')).toEqual({ stopped: true });
    // A stopped parked row no longer reads as an enrollment on the Reviews page.
    expect(await ReviewService.getActiveSequencesForCustomers(['p1', 'p2', 'p3'])).toEqual(expect.objectContaining({ p2: expect.anything() }));
    expect(Object.keys(await ReviewService.getActiveSequencesForCustomers(['p1', 'p2', 'p3']))).toEqual(['p2']);
  });

  test('getActiveSequencesForCustomers promises no tick for an active row the runner will retire as stale (codex #4140 r24 P2)', async () => {
    const mock = makeMock({
      review_sequences: [
        { id: 'seqStale', customer_id: 's1', status: 'active', next_run_at: new Date(Date.now() - 8 * 86400000), plan: JSON.stringify([{ channel: 'sms' }]), current_step: 0 },
        { id: 'seqLate', customer_id: 's2', status: 'active', next_run_at: new Date(Date.now() - 60 * 60000), plan: JSON.stringify([{ channel: 'sms' }]), current_step: 0 },
      ],
    });
    db.mockImplementation(mock);

    const map = await ReviewService.getActiveSequencesForCustomers(['s1', 's2']);
    expect(map.s1).toMatchObject({ staleRetire: true, nextSendTickAt: null });
    expect(map.s2.staleRetire).toBe(false);
    expect(map.s2.nextSendTickAt).toBeTruthy();
  });

  test('a cadence stops on a non-promoter draft score tap (no submit)', async () => {
    const mock = makeMock({
      customers: [{ id: 'lo1', first_name: 'Lo', last_name: 'W', phone: '+19410000031', nearest_location_id: 'parrish' }],
      review_sequences: [{
        id: 'seqLo', customer_id: 'lo1', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 4 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
      // Day-0 touch: a detractor tapped score 3 but never hit submit (no submitted_at).
      review_requests: [{ id: 'rrLo', sequence_id: 'seqLo', customer_id: 'lo1', channel: 'sms', sms_sent_at: new Date(Date.now() - 3 * 86400000), score: 3, category: 'detractor' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('responded');
  });

  test('the final email step completes the sequence', async () => {
    const mock = makeMock({
      customers: [{ id: 'cust-3', first_name: 'Lee', last_name: 'P', email: 'lee@x.com', nearest_location_id: 'sarasota' }],
      // Email fails closed without a prefs row, so model the backfilled row.
      notification_prefs: [{ customer_id: 'cust-3', review_request: true, email_enabled: true, sms_enabled: true }],
      review_sequences: [{
        id: 'seq-3', customer_id: 'cust-3', status: 'active', current_step: 2, touches_sent: 2,
        plan: JSON.stringify([
          { day: 0, channel: 'sms', templateKey: 'friendly_ask' },
          { day: 3, channel: 'sms', templateKey: 'soft_reminder' },
          { day: 7, channel: 'email', templateKey: 'final_nudge' },
        ]),
        started_at: new Date(Date.now() - 8 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockEmailSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockEmailSendTemplate.mock.calls[0][0]).toMatchObject({ templateKey: 'review_request_email', to: 'lee@x.com' });
    expect(out.completed).toBe(1);
    const seq = mock.__state.rows.review_sequences[0];
    expect(seq.status).toBe('completed');
    expect(seq.stop_reason).toBe('completed');
  });

  test('manual SMS send with no template defaults to the friendly ask (audit P1)', async () => {
    const mock = makeMock({ customers: [{ id: 'm1', first_name: 'Stan', last_name: 'S', phone: '+19410000001', nearest_location_id: 'bradenton' }] });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: null, manageRetryVia: 'cron' });

    expect(out.ok).toBe(true);
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    // Body is the friendly-ask copy, not an empty/no_template failure.
    expect(mockSendCustomerMessage.mock.calls[0][0].body).toMatch(/quick Google review/i);
    expect(mock.__state.rows.review_requests[0].template_key).toBe('friendly_ask');
  });

  test('an SMS-opted-out customer who allows email gets the email touch instead of stalling', async () => {
    const mock = makeMock({
      customers: [{ id: 'm2', first_name: 'Eve', last_name: 'M', phone: '+19410000002', email: 'eve@x.com', nearest_location_id: 'venice' }],
      notification_prefs: [{ customer_id: 'm2', sms_enabled: false, email_enabled: true, review_request: true }],
    });
    db.mockImplementation(mock);

    // Intended channel is SMS (default Day-0 step), but SMS is opted out.
    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'friendly_ask', manageRetryVia: 'sequence' });

    expect(out.ok).toBe(true);
    expect(out.channel).toBe('email');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockEmailSendTemplate).toHaveBeenCalledTimes(1);
    // Email touches are recorded under the email template for honest attribution.
    expect(mock.__state.rows.review_requests[0]).toMatchObject({ channel: 'email', template_key: 'review_request_email' });
  });

  test('start is blocked when the customer is at the 3-ask cap (counts both channels)', async () => {
    const mock = makeMock({
      customers: [{ id: 'm3', first_name: 'Cap', last_name: 'T', phone: '+19410000003', nearest_location_id: 'parrish' }],
      // 2 SMS asks + 1 email ask, all delivered INSIDE the rolling 180-day
      // window (the count is window-scoped in JS now, so the fixture must be
      // recent) — the cap counts review_requests across channels, not just
      // sms_log.
      review_requests: [
        { customer_id: 'm3', channel: 'sms', sms_sent_at: new Date(Date.now() - 90 * 86400000) },
        { customer_id: 'm3', channel: 'sms', sms_sent_at: new Date(Date.now() - 60 * 86400000) },
        { customer_id: 'm3', channel: 'email', sent_at: new Date(Date.now() - 45 * 86400000) },
      ],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.startReviewSequence({ customerId: 'm3', serviceType: 'pest control', techName: 'Adam' });
    expect(out.started).toBe(false);
    expect(out.reason).toBe('at_cap');
    expect(mock.__state.rows.review_sequences).toHaveLength(0);
  });

  test('an explicit "email" channel preference does NOT fall back to SMS', async () => {
    const mock = makeMock({
      customers: [{ id: 'p1', first_name: 'Pat', last_name: 'C', phone: '+19410000010', email: null, nearest_location_id: 'venice' }],
      notification_prefs: [{ customer_id: 'p1', review_request: true, review_request_channel: 'email' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'friendly_ask', manageRetryVia: 'cron' });

    // Deliberately chose email, has no email on file → no contact, NOT an SMS.
    expect(out.ok).toBeFalsy();
    expect(out.reason).toBe('no_contact');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockEmailSendTemplate).not.toHaveBeenCalled();
  });

  test('a default "sms" channel pref still allows the email step (not a deliberate opt-out)', async () => {
    const mock = makeMock({
      customers: [{ id: 'p2', first_name: 'Deb', last_name: 'D', phone: '+19410000011', email: 'deb@x.com', nearest_location_id: 'sarasota' }],
      // The prefs backfill sets review_request_channel='sms' by DEFAULT.
      notification_prefs: [{ customer_id: 'p2', review_request: true, sms_enabled: true, email_enabled: true, review_request_channel: 'sms' }],
    });
    db.mockImplementation(mock);

    // An email-channel touch (Day 7) must still send via email.
    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'email', templateId: 'final_nudge', manageRetryVia: 'sequence' });

    expect(out.ok).toBe(true);
    expect(out.channel).toBe('email');
    expect(mockEmailSendTemplate).toHaveBeenCalledTimes(1);
  });

  test('a cadence email touch uses the personalized intro when the drafter verifies one', async () => {
    const intro = 'Hi Deb, hope the ants along the lanai have finally packed up since our visit. If anything still looks off, just reply here. Otherwise, a quick review would mean the world to our little crew.';
    mockDraftEmailIntro.mockResolvedValue(intro);
    const mock = makeMock({
      email_templates: [{ id: 'tpl-rre', template_key: 'review_request_email', active_version_id: 'ver-rre' }],
      email_template_versions: [{ id: 'ver-rre', blocks: '[{"type":"paragraph","content":"{{intro_paragraph}}"}]' }],
      customers: [{ id: 'pe-1', first_name: 'Deb', last_name: 'D', phone: '+19410000013', email: 'x@y.com', nearest_location_id: 'sarasota' }],
      notification_prefs: [{ customer_id: 'pe-1', review_request: true, sms_enabled: true, email_enabled: true, review_request_channel: 'sms' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'email', templateId: 'final_nudge',
      sequenceId: 'seq-pe', sequenceStep: 2, manageRetryVia: 'sequence',
    });

    expect(out.ok).toBe(true);
    expect(mockDraftEmailIntro).toHaveBeenCalledTimes(1);
    const payload = mockEmailSendTemplate.mock.calls[0][0].payload;
    expect(payload.intro_paragraph).toBe(intro);
    const row = mock.__state.rows.review_requests[0];
    expect(row.template_key).toBe('review_request_email_personalized');
    expect(row.custom_body).toBe(intro); // persisted for retry reuse
  });

  test('a cadence email touch falls back to the generic intro when the drafter declines', async () => {
    const mock = makeMock({
      email_templates: [{ id: 'tpl-rre', template_key: 'review_request_email', active_version_id: 'ver-rre' }],
      email_template_versions: [{ id: 'ver-rre', blocks: '[{"type":"paragraph","content":"{{intro_paragraph}}"}]' }],
      customers: [{ id: 'pe-2', first_name: 'Gil', last_name: 'E', phone: '+19410000014', email: 'x@y.com', nearest_location_id: 'sarasota' }],
      notification_prefs: [{ customer_id: 'pe-2', review_request: true, sms_enabled: true, email_enabled: true, review_request_channel: 'sms' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'email', templateId: 'final_nudge',
      sequenceId: 'seq-pe2', sequenceStep: 2, manageRetryVia: 'sequence',
    });

    expect(out.ok).toBe(true);
    const payload = mockEmailSendTemplate.mock.calls[0][0].payload;
    expect(payload.intro_paragraph).toMatch(/small, family-owned/);
    expect(mock.__state.rows.review_requests[0].template_key).toBe('review_request_email');
  });

  test('the email intro is NOT drafted for a recipient who is not the account holder', async () => {
    mockDraftEmailIntro.mockResolvedValue('should never send');
    const mock = makeMock({
      // The resolved service contact is a different person than the account holder.
      email_templates: [{ id: 'tpl-rre', template_key: 'review_request_email', active_version_id: 'ver-rre' }],
      email_template_versions: [{ id: 'ver-rre', blocks: '[{"type":"paragraph","content":"{{intro_paragraph}}"}]' }],
      customers: [{ id: 'pe-3', first_name: 'Ana', last_name: 'F', phone: '+19410000015', email: 'owner@elsewhere.com', service_contact_email: 'tenant@rental.com', nearest_location_id: 'sarasota' }],
      notification_prefs: [{ customer_id: 'pe-3', review_request: true, sms_enabled: true, email_enabled: true, review_request_channel: 'sms' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'email', templateId: 'final_nudge',
      sequenceId: 'seq-pe3', sequenceStep: 2, manageRetryVia: 'sequence',
    });

    expect(out.ok).toBe(true);
    expect(mockDraftEmailIntro).not.toHaveBeenCalled();
    const payload = mockEmailSendTemplate.mock.calls[0][0].payload;
    expect(payload.intro_paragraph).toMatch(/small, family-owned/);
  });

  test('a no-link template is recorded with followup_sent=true (no legacy Day-3 ask)', async () => {
    const mock = makeMock({ customers: [{ id: 'nl1', first_name: 'No', last_name: 'L', phone: '+19410000012', nearest_location_id: 'parrish' }] });
    db.mockImplementation(mock);

    await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'resolution_check', manageRetryVia: 'cron' });

    expect(mock.__state.rows.review_requests[0].followup_sent).toBe(true);
  });

  test('a no-link template (resolution_check) sends without a /rate link', async () => {
    const mock = makeMock({ customers: [{ id: 'n1', first_name: 'Ron', last_name: 'R', phone: '+19410000009', nearest_location_id: 'parrish' }] });
    db.mockImplementation(mock);

    await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'resolution_check', manageRetryVia: 'cron' });

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    const body = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(body).not.toMatch(/\/rate\//);
    expect(body).not.toMatch(/portal\.test/);
  });

  test('a no-link check-in never falls back to email (would add a /rate link)', async () => {
    const mock = makeMock({
      customers: [{ id: 'c5', first_name: 'Cara', last_name: 'R', phone: null, email: 'cara@x.com', nearest_location_id: 'venice' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'resolution_check', manageRetryVia: 'cron' });

    // No phone + a private check-in must NOT be emailed (the only email template
    // carries a review link) → no contact, no email send.
    expect(out.ok).toBeFalsy();
    expect(out.reason).toBe('no_contact');
    expect(mockEmailSendTemplate).not.toHaveBeenCalled();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a DNC phone (stored E.164) falls back to email even when contact phone is formatted', async () => {
    const mock = makeMock({
      customers: [{ id: 'dnc1', first_name: 'Dan', last_name: 'C', phone: '(941) 555-1234', email: 'dan@x.com', nearest_location_id: 'bradenton' }],
      notification_prefs: [{ customer_id: 'dnc1', review_request: true, sms_enabled: true, email_enabled: true }],
      messaging_suppression: [{ phone: '+19415551234', active: true, reason: 'dnc' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'friendly_ask', manageRetryVia: 'sequence' });

    // Phone is on the DNC list (matched after E.164 normalization) → email.
    expect(out.ok).toBe(true);
    expect(out.channel).toBe('email');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockEmailSendTemplate).toHaveBeenCalledTimes(1);
  });

  test('an edited no-link check-in never renders a review link even if {review_url} is left in', async () => {
    const mock = makeMock({ customers: [{ id: 'edit1', first_name: 'Ed', last_name: 'T', phone: '+19410000040', nearest_location_id: 'venice' }] });
    db.mockImplementation(mock);

    await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'sms',
      templateId: 'resolution_check',
      body: 'Hi {first}, sorry about that — here {review_url} if you want.',
      manageRetryVia: 'cron',
    });

    const body = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(body).not.toMatch(/\/rate\//);
    expect(body).not.toMatch(/portal\.test/);
    expect(body).not.toContain('{review_url}');
  });

  test('a post-send DB failure does NOT requeue an already-accepted SMS (audit P1)', async () => {
    // Twilio accepts (sent:true), but the post-send review_requests UPDATE throws.
    const mock = makeMock(
      { customers: [{ id: 'bk1', first_name: 'Bo', last_name: 'K', phone: '+19410000050', nearest_location_id: 'bradenton' }] },
      { throwUpdateFor: ['review_requests'] },
    );
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'friendly_ask', manageRetryVia: 'cron' });

    // The SMS already went out — must be reported sent, NOT retryable.
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out.sent).toBe(true);
    expect(out.retryable).toBeFalsy();
  });

  test('a NOT-sent result whose bookkeeping fails stays retryable (no false terminal)', async () => {
    // Provider returned a transient non-send (not delivered), and the post-send
    // status update throws → must remain retryable, not become terminal.
    mockSendCustomerMessage.mockResolvedValueOnce({ sent: false, retryable: true, code: 'PROVIDER_FAILURE' });
    const mock = makeMock(
      { customers: [{ id: 'bk2', first_name: 'Bea', last_name: 'K', phone: '+19410000051', nearest_location_id: 'venice' }] },
      { throwUpdateFor: ['review_requests'] },
    );
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'friendly_ask', manageRetryVia: 'sequence' });

    expect(out.sent).toBeFalsy();
    expect(out.retryable).toBe(true);
    expect(out.terminal).toBeFalsy();
  });

  test('a terminal SMS failure (invalid number) is suppressed, not retried forever', async () => {
    mockSendCustomerMessage.mockResolvedValueOnce({ sent: false, terminal: true, retryable: false, code: 'INVALID_NUMBER' });
    const mock = makeMock({ customers: [{ id: 't1', first_name: 'Bad', last_name: 'N', phone: '+10000000000', nearest_location_id: 'bradenton' }] });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'friendly_ask', manageRetryVia: 'cron' });

    expect(out.terminal).toBe(true);
    const row = mock.__state.rows.review_requests[0];
    expect(row.status).toBe('suppressed');
    expect(row.scheduled_for).toBeUndefined(); // not requeued
  });

  test('startReviewSequence reports started:false when the first touch immediately stops', async () => {
    const mock = makeMock({
      customers: [{ id: 's5', first_name: 'Opt', last_name: 'O', phone: '+19410000005', nearest_location_id: 'sarasota' }],
      notification_prefs: [{ customer_id: 's5', review_request: false }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.startReviewSequence({ customerId: 's5', serviceType: 'pest control', techName: 'Adam' });

    expect(out.started).toBe(false);
    expect(out.reason).toBe('opted_out');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mock.__state.rows.review_sequences[0].status).toBe('stopped');
  });

  test('an opted-out customer stops the sequence without sending', async () => {
    const mock = makeMock({
      customers: [{ id: 'cust-4', first_name: 'Ada', last_name: 'B', nearest_location_id: 'parrish' }],
      notification_prefs: [{ customer_id: 'cust-4', review_request: false }],
      review_sequences: [{
        id: 'seq-4', customer_id: 'cust-4', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 4 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('opted_out');
  });

  test('a step parked by a summary bounce after the provider accepted it is still advanced, so recovery resumes the next step', async () => {
    const Summary = require('../services/visit-completion-summary');
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'cust-pk', first_name: 'Pia', last_name: 'K', nearest_location_id: 'venice' }],
      review_sequences: [{
        id: 'seq-pk', customer_id: 'cust-pk', service_record_id: 'sr-pk', status: 'active', current_step: 0, touches_sent: 0,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 60000), next_run_at: new Date(Date.now() - 60000),
      }],
    });
    db.mockImplementation(mock);
    mockSendCustomerMessage.mockImplementationOnce(async () => {
      // The bounce reconciliation parks the sequence between the provider's
      // return and this step's bookkeeping (the packet handoff ends at return).
      Object.assign(mock.__state.rows.review_sequences[0], { status: 'stopped', stop_reason: Summary.PARKED_REVIEW_REASON, completed_at: new Date() });
      return { sent: true, auditLogId: 'audit-pk' };
    });

    await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    const seq = mock.__state.rows.review_sequences[0];
    // Parked stays parked (never re-activated here), but the delivered step is
    // recorded so a resume schedules step 1 instead of replaying step 0.
    expect(seq).toMatchObject({ status: 'stopped', stop_reason: Summary.PARKED_REVIEW_REASON, current_step: 1, touches_sent: 1 });
    expect(seq.next_run_at).toBeInstanceOf(Date);
  });
});

describe('cadence scheduling + post-service enrollment (2026-07-30 revamp)', () => {
  const { nextTouchRunAt, shiftToWeekdayMorning, buildReviewUrl } = ReviewService.__private;

  // 2026-08-01 is a Saturday, 2026-08-02 a Sunday, 2026-08-03 a Monday (EDT).
  const SAT = new Date('2026-08-01T14:00:00-04:00');
  const SUN = new Date('2026-08-02T09:00:00-04:00');
  const WED = new Date('2026-07-29T14:00:00-04:00');
  const MON_10 = new Date('2026-08-03T10:00:00-04:00').getTime();
  const MON_1030 = new Date('2026-08-03T10:30:00-04:00').getTime();

  test('shiftToWeekdayMorning moves Sat and Sun sends to Monday 10:00-10:30 ET, leaves weekdays alone', () => {
    for (const weekend of [SAT, SUN]) {
      const shifted = shiftToWeekdayMorning(weekend);
      expect(shifted.getTime()).toBeGreaterThanOrEqual(MON_10);
      expect(shifted.getTime()).toBeLessThanOrEqual(MON_1030);
    }
    expect(shiftToWeekdayMorning(WED)).toBe(WED);
  });

  test('a weekdaysOnly Day-3 step landing on Saturday fires Monday morning instead', () => {
    const at = nextTouchRunAt({
      startedAt: WED, // Wed + 3d = Sat
      step: { day: 3, channel: 'sms', weekdaysOnly: true },
      now: new Date(WED.getTime() + 60000),
    });
    expect(at.getTime()).toBeGreaterThanOrEqual(MON_10);
    expect(at.getTime()).toBeLessThanOrEqual(MON_1030);
  });

  test('an already-due later step keeps the 3-day rule after the touch that just sent (owner ruling 2026-09-07)', () => {
    // Weekend-shifted Day-4 SMS just fired Monday 8:00 AM; the email's base
    // time is already past — it must NOT fire before Thursday 8:00 AM.
    const now = new Date('2026-08-03T08:00:00-04:00');
    const at = nextTouchRunAt({ startedAt: WED, step: { day: 4, channel: 'email' }, now });
    expect(at.getTime()).toBe(new Date('2026-08-06T08:00:00-04:00').getTime());
  });

  test('a private no-link check-in on a later day keeps its day — the 3-day minimum spaces asks only (codex #4141 r2)', () => {
    const now = new Date(WED.getTime() + 60000);
    const at = nextTouchRunAt({ startedAt: WED, step: { day: 1, channel: 'sms', templateKey: 'resolution_check' }, now });
    expect(at.getTime()).toBe(WED.getTime() + 86400000);
    const ask = nextTouchRunAt({ startedAt: WED, step: { day: 1, channel: 'sms', templateKey: 'soft_reminder' }, now });
    expect(ask.getTime()).toBe(now.getTime() + 72 * 3600000);
  });

  test('an ask that follows a private check-in is not pushed 72 h past the check-in; after an ask it still is (codex #4141 r4 P2)', () => {
    const startedAt = new Date('2026-05-26T14:00:00Z');
    const now = new Date('2026-05-27T14:00:00Z');
    const afterCheckIn = nextTouchRunAt({ startedAt, step: { day: 2, channel: 'sms', templateKey: 'soft_reminder' }, previousStep: { day: 1, channel: 'sms', templateKey: 'resolution_check' }, now });
    expect(afterCheckIn.getTime()).toBe(startedAt.getTime() + 2 * 86400000);
    const afterAsk = nextTouchRunAt({ startedAt, step: { day: 2, channel: 'sms', templateKey: 'soft_reminder' }, previousStep: { day: 0, channel: 'sms', templateKey: 'day0_ask' }, now });
    expect(afterAsk.getTime()).toBe(now.getTime() + 72 * 3600000);
  });

  test('a future step is scheduled exactly at started_at + day offset', () => {
    const at = nextTouchRunAt({ startedAt: WED, step: { day: 3, channel: 'sms' }, now: WED });
    expect(at.getTime()).toBe(WED.getTime() + 3 * 86400000);
  });

  test('buildReviewUrl resolves to the rate page by default and to the tracked Google redirect under GATE_REVIEW_DIRECT_LINK', async () => {
    const request = { id: 'rr-9', token: 'ab'.repeat(32) };
    expect(await buildReviewUrl(request, 'cust-9')).toBe(`https://portal.test/rate/${request.token}`);
    mockGates.reviewDirectLink = true;
    expect(await buildReviewUrl(request, 'cust-9')).toBe(`https://portal.test/api/rate/${request.token}/go`);
  });

  test('enrollPostService with the gate OFF queues the legacy single ask (no sequence)', async () => {
    const mock = makeMock({
      customers: [{ id: 'en-1', first_name: 'Lee', last_name: 'K', phone: '+19410000031', nearest_location_id: 'parrish' }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'en-1', delayMinutes: 120 });

    expect(mock.__state.rows.review_sequences).toHaveLength(0);
    expect(mock.__state.rows.review_requests).toHaveLength(1);
    expect(mock.__state.rows.review_requests[0]).toMatchObject({ customer_id: 'en-1', status: 'pending', triggered_by: 'auto' });
    expect(mock.__state.rows.review_requests[0].scheduled_for).toBeInstanceOf(Date);
    expect(result.id).toBe(mock.__state.rows.review_requests[0].id);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('enrollPostService with the gate ON starts a cadence scheduled at the smart send window (nothing sends inline)', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'en-2', first_name: 'Ana', last_name: 'M', phone: '+19410000032', nearest_location_id: 'sarasota' }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({
      customerId: 'en-2',
      serviceType: 'Quarterly Pest Control',
      techName: 'Adam',
      completedAt: new Date(),
    });

    expect(result.started).toBe(true);
    expect(result.scheduledFor).toBeInstanceOf(Date);
    expect(mock.__state.rows.review_requests).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    const seq = mock.__state.rows.review_sequences[0];
    expect(seq).toMatchObject({ customer_id: 'en-2', status: 'active', current_step: 0, touches_sent: 0, started_by: 'post_service' });
    expect(seq.next_run_at).toBeInstanceOf(Date);
    // The cron picks it up at next_run_at — never more than ~26h out (the
    // smart window's worst case is "next morning 10 AM" + Sat→Sun overrides).
    expect(seq.next_run_at.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(seq.next_run_at.getTime()).toBeLessThan(Date.now() + 48 * 3600000);
  });

  describe('decision record (owner directive 2026-09-07: panel and Reviews page explain the same decision)', () => {
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

    test('a smart-window enrollment records the planned Day-0 send with owner action none', async () => {
      mockGates.reviewSequences = true;
      const mock = makeMock({ customers: [{ id: 'dc-1', first_name: 'Ana', last_name: 'M', phone: '+19410000132', nearest_location_id: 'sarasota' }] });
      db.mockImplementation(mock);

      const result = await ReviewService.enrollPostService({ customerId: 'dc-1', serviceType: 'Quarterly Pest Control', completedAt: new Date() });

      expect(result.started).toBe(true);
      const seq = mock.__state.rows.review_sequences[0];
      const d = parse(seq.decision);
      expect(d).toMatchObject({ reason: 'smart_window', ownerAction: 'none' });
      expect(new Date(d.plannedAt).getTime()).toBe(seq.next_run_at.getTime());
      expect(seq.customer_requested == null).toBe(true);
    });

    test('"Customer asked for the link" is recorded (who/when/source) and the ask waits for the next tick — not an instant send', async () => {
      mockGates.reviewSequences = true;
      const mock = makeMock({ customers: [{ id: 'dc-2', first_name: 'Dana', last_name: 'Q', phone: '+19410000133', nearest_location_id: 'bradenton' }] });
      db.mockImplementation(mock);
      const requested = { by: 'tech-1', byName: 'Adam', at: new Date().toISOString(), source: 'completion_panel' };

      const result = await ReviewService.enrollPostService({ customerId: 'dc-2', serviceType: 'pest control', completedAt: new Date(), delayMinutes: 0, customerRequested: requested });

      expect(result.started).toBe(true);
      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      const seq = mock.__state.rows.review_sequences[0];
      expect(parse(seq.customer_requested)).toEqual(requested);
      expect(parse(seq.decision)).toMatchObject({ reason: 'customer_requested', ownerAction: 'none' });
      expect(seq.next_run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    test('an operator-picked time records operator_timing', async () => {
      mockGates.reviewSequences = true;
      const mock = makeMock({ customers: [{ id: 'dc-3', first_name: 'Lee', last_name: 'K', phone: '+19410000134', nearest_location_id: 'parrish' }] });
      db.mockImplementation(mock);

      await ReviewService.enrollPostService({ customerId: 'dc-3', completedAt: new Date(), delayMinutes: 600 });

      expect(parse(mock.__state.rows.review_sequences[0].decision)).toMatchObject({ reason: 'operator_timing' });
    });

    test('a send-window hold records the planned send; a sent touch records the scheduled follow-up', async () => {
      mockGates.reviewSequences = true;
      const nextAllowedAt = new Date(Date.now() + 9 * 3600000);
      mockSendCustomerMessage.mockResolvedValueOnce({ sent: false, deferred: true, nextAllowedAt: nextAllowedAt.toISOString(), code: 'QUIET_HOURS_HOLD' });
      const mock = makeMock({
        customers: [{ id: 'dc-4', first_name: 'Mae', last_name: 'R', phone: '+19410000135', nearest_location_id: 'venice' }],
        review_sequences: [{
          id: 'seq-dc4', customer_id: 'dc-4', status: 'active', current_step: 0, touches_sent: 0, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'day0_ask' }, { day: 4, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true }]),
          started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000),
        }],
      });
      db.mockImplementation(mock);

      await ReviewService.processReviewSequences();
      const held = mock.__state.rows.review_sequences[0];
      expect(parse(held.decision)).toMatchObject({ reason: 'send_window', plannedAt: nextAllowedAt.toISOString(), ownerAction: 'none' });
      expect(held.next_run_at.getTime()).toBe(nextAllowedAt.getTime());

      held.next_run_at = new Date(Date.now() - 1000);
      await ReviewService.processReviewSequences();
      const sent = mock.__state.rows.review_sequences[0];
      expect(sent.current_step).toBe(1);
      const d = parse(sent.decision);
      expect(d.reason).toBe('follow_up_scheduled');
      expect(new Date(d.plannedAt).getTime()).toBe(sent.next_run_at.getTime());
    });

    test('a provider blip with a synthesized retry time is a re-check, not a send-window hold (codex #4140 r1)', async () => {
      mockGates.reviewSequences = true;
      mockSendCustomerMessage.mockResolvedValueOnce({ sent: false, deferred: true, retryable: true, nextAllowedAt: new Date(Date.now() + 5 * 60000).toISOString(), code: 'PROVIDER_FAILURE' });
      const mock = makeMock({
        customers: [{ id: 'dc-6', first_name: 'Mae', last_name: 'R', phone: '+19410000136', nearest_location_id: 'venice' }],
        review_sequences: [{
          id: 'seq-dc6', customer_id: 'dc-6', status: 'active', current_step: 0, touches_sent: 0, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'day0_ask' }]),
          started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000),
        }],
      });
      db.mockImplementation(mock);

      await ReviewService.processReviewSequences();
      const d = parse(mock.__state.rows.review_sequences[0].decision);
      expect(d.reason).not.toBe('send_window');
      expect(d.plannedAt).toBeNull();
      expect(d.nextEvalAt).toBeTruthy();
    });

    test('a stale send claim reads as stranded, a fresh one as sending (codex #4140 r1)', async () => {
      const mock = makeMock({
        review_sequences: [
          { id: 'seq-dc7', customer_id: 'dc-7', status: 'active', current_step: 0, plan: JSON.stringify([{ day: 0 }]), next_run_at: null, updated_at: new Date(Date.now() - 20 * 60000) },
          { id: 'seq-dc8', customer_id: 'dc-8', status: 'active', current_step: 0, plan: JSON.stringify([{ day: 0 }]), next_run_at: null, updated_at: new Date() },
        ],
      });
      db.mockImplementation(mock);

      const map = await ReviewService.getActiveSequencesForCustomers(['dc-7', 'dc-8']);
      expect(map['dc-7']).toMatchObject({ sending: false, stranded: true });
      expect(map['dc-8']).toMatchObject({ sending: true, stranded: false });
    });

    test('"Customer asked for the link" survives a parked series final and its redemption (codex #4140 r1)', async () => {
      mockGates.reviewSequences = true;
      const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
      const mock = makeMock({
        customers: [{ id: 'pk2', first_name: 'Ann', last_name: 'Q', phone: '+19410000168', nearest_location_id: 'bradenton' }],
        service_records: [{ id: 'sr-pk2', customer_id: 'pk2', scheduled_service_id: 'pk2-2' }],
        scheduled_services: [
          { id: 'pk2-1', customer_id: 'pk2', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
          { id: 'pk2-2', customer_id: 'pk2', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
        ],
        review_sequences: [{ id: 'seq-stuck2', customer_id: 'pk2', scheduled_service_id: 'pk2-1', status: 'active', current_step: 0, next_run_at: null, plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
      });
      db.mockImplementation(mock);
      const prev = ReviewService._SUPERSEDE_RETRY_DELAY_MS;
      ReviewService._SUPERSEDE_RETRY_DELAY_MS = 1;
      const requested = { by: 'tech-1', byName: 'Adam', at: new Date().toISOString(), source: 'completion_panel' };
      let res;
      try {
        res = await ReviewService.enrollPostService({ customerId: 'pk2', serviceRecordId: 'sr-pk2', completedAt: new Date(), delayMinutes: 0, customerRequested: requested });
      } finally {
        ReviewService._SUPERSEDE_RETRY_DELAY_MS = prev;
      }
      expect(res.reason).toBe('deferred_inflight');
      const parked = mock.__state.rows.review_sequences.find((r) => r.status === 'deferred');
      expect(parse(parked.customer_requested)).toMatchObject({ by: 'tech-1', source: 'completion_panel' });
      expect(parse(parked.decision)).toMatchObject({ reason: 'opener_in_flight', enrollmentReason: 'customer_requested' });

      mock.__state.rows.review_sequences.find((r) => r.id === 'seq-stuck2').status = 'completed';
      parked.next_run_at = new Date(Date.now() - 1000);
      const out = await ReviewService.processReviewSequences();
      expect(out.redeemed).toBe(1);
      const active = mock.__state.rows.review_sequences.find((r) => r.status === 'active');
      expect(parse(active.customer_requested)).toMatchObject({ by: 'tech-1', source: 'completion_panel' });
      // The redeemed Day-0 was already due, so the runner may have sent it in
      // the same sweep and moved the decision on — never to operator_timing.
      expect(['customer_requested', 'follow_up_scheduled']).toContain(parse(active.decision).reason);
    });

    test('getActiveSequencesForCustomers exposes the parsed decision and the request capture', async () => {
      const mock = makeMock({
        review_sequences: [{ id: 'seq-dc5', customer_id: 'dc-5', status: 'active', current_step: 1, plan: JSON.stringify([{ day: 0 }, { day: 4 }]), next_run_at: new Date(), decision: JSON.stringify({ reason: 'follow_up_scheduled', ownerAction: 'none' }), customer_requested: JSON.stringify({ by: 'tech-1', source: 'completion_panel' }) }],
      });
      db.mockImplementation(mock);

      const map = await ReviewService.getActiveSequencesForCustomers(['dc-5']);
      expect(map['dc-5']).toMatchObject({ currentStep: 1, totalSteps: 2, sending: false, decision: { reason: 'follow_up_scheduled' }, customerRequested: { source: 'completion_panel' } });
    });
  });

  describe('3-day rule at dispatch (owner ruling 2026-09-07)', () => {
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    function fixture(id, { lastAskAgoMs, step = { day: 4, channel: 'sms', templateKey: 'soft_reminder' } }) {
      return {
        customers: [{ id: `${id}-c`, first_name: 'Dana', last_name: 'Q', phone: '+19410000150', nearest_location_id: 'bradenton' }],
        review_sequences: [{
          id, customer_id: `${id}-c`, status: 'active', current_step: 1, touches_sent: 1, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'day0_ask' }, step]),
          started_at: new Date(Date.now() - 4 * 86400000), next_run_at: new Date(Date.now() - 60000),
        }],
        // The Day-0 ask actually went out lastAskAgoMs ago (held by the send
        // window, retried, etc. — the plan's day offset no longer tells).
        review_requests: [{ id: `${id}-d0`, sequence_id: id, sequence_step: 0, customer_id: `${id}-c`, channel: 'sms', template_key: 'day0_ask', status: 'sent', sms_sent_at: new Date(Date.now() - lastAskAgoMs), created_at: new Date(Date.now() - lastAskAgoMs) }],
      };
    }

    test('an uncertain reservation spaces the cadence without permanently stopping it', async () => {
      const rows = fixture('seq-reservation', { lastAskAgoMs: 73 * 3600000 });
      rows.sms_log = [{ id: 'reserved-attempt', customer_id: 'seq-reservation-c', direction: 'outbound',
        status: 'sending', message_body: 'Please leave a Google review.',
        metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 3600000) }];
      const mock = makeMock(rows);
      db.mockImplementation(mock);

      await ReviewService.processReviewSequences();

      const seq = mock.__state.rows.review_sequences[0];
      expect(seq.status).toBe('active');
      expect(seq.current_step).toBe(1);
      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      expect(seq.next_run_at.getTime()).toBeGreaterThanOrEqual(Date.now() + 71 * 3600000 - 1000);
      jest.useFakeTimers().setSystemTime(new Date(seq.next_run_at.getTime() + 1000));
      try {
        expect((await ReviewService.processReviewSequences()).sent).toBe(1);
        expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a follow-up due by the plan but under 72h after the last delivered ask is held to lastSent + 72h, nothing dropped', async () => {
      const lastAskAgoMs = 40 * 3600000;
      const mock = makeMock(fixture('seq-3d1', { lastAskAgoMs }));
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      expect(out.sent).toBe(0);
      const seq = mock.__state.rows.review_sequences[0];
      expect(seq.status).toBe('active');
      expect(seq.current_step).toBe(1);
      const expected = Date.now() - lastAskAgoMs + 72 * 3600000;
      expect(Math.abs(seq.next_run_at.getTime() - expected)).toBeLessThan(5000);
      expect(parse(seq.decision)).toMatchObject({ reason: 'spacing', ownerAction: 'none' });
      expect(new Date(parse(seq.decision).plannedAt).getTime()).toBe(seq.next_run_at.getTime());
    });

    test('a follow-up 72h or more after the last delivered ask sends', async () => {
      const mock = makeMock(fixture('seq-3d2', { lastAskAgoMs: 73 * 3600000 }));
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
      expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    test('a weekdays-only step whose quiet-hours hold names Saturday morning retries Monday morning instead (codex #4330 P2)', async () => {
      // Friday 19:30 ET: the 72h floor is satisfied, the provider defers to
      // the next send window — Saturday 08:00. weekdaysOnly must reapply.
      const fri = new Date('2026-08-07T19:30:00-04:00');
      const realNow = Date.now;
      Date.now = () => fri.getTime();
      try {
        const mock = makeMock(fixture('seq-wk-sat', { lastAskAgoMs: 80 * 3600000, step: { day: 4, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true } }));
        db.mockImplementation(mock);
        const sat8 = new Date('2026-08-08T08:00:00-04:00');
        // A quiet-hours hold is a DEFINITE not-sent (the real sender names it so).
        mockSendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, deferred: true, retryable: true, deliveryOutcome: 'not_sent', code: 'QUIET_HOURS_HOLD', nextAllowedAt: sat8.toISOString() });

        const out = await ReviewService.processReviewSequences();

        expect(out.sent).toBe(0);
        const seq = mock.__state.rows.review_sequences[0];
        expect(seq.status).toBe('active');
        const { etParts } = require('../utils/datetime-et');
        expect(etParts(seq.next_run_at)).toMatchObject({ dayOfWeek: 1, hour: 10 });
        expect(parse(seq.decision).reason).toBe('send_window');
      } finally {
        Date.now = realNow;
      }
    });

    test('a weekdays-only follow-up held by the rule lands on a weekday morning', async () => {
      // Force lastSent + 72h onto a Saturday: pick lastSent = Wednesday 09:00 ET.
      const wed = new Date('2026-08-05T09:00:00-04:00');
      const realNow = Date.now;
      Date.now = () => wed.getTime() + 60 * 3600000; // Friday 21:00 ET
      try {
        const mock = makeMock(fixture('seq-3d3', { lastAskAgoMs: 60 * 3600000, step: { day: 4, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true } }));
        db.mockImplementation(mock);

        await ReviewService.processReviewSequences();

        const seq = mock.__state.rows.review_sequences[0];
        expect(mockSendCustomerMessage).not.toHaveBeenCalled();
        // Saturday 09:00 → Monday 10:00–10:30 ET
        const { etParts } = require('../utils/datetime-et');
        expect(etParts(seq.next_run_at)).toMatchObject({ dayOfWeek: 1, hour: 10 });
      } finally {
        Date.now = realNow;
      }
    });

    test('a private no-link check-in at the next step is not held behind the 3-day rule (codex #4141 r1)', async () => {
      const mock = makeMock(fixture('seq-3d4', { lastAskAgoMs: 20 * 3600000, step: { day: 1, channel: 'sms', templateKey: 'resolution_check' } }));
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
      expect(mockSendCustomerMessage.mock.calls[0][0].body).not.toContain('/rate/');
    });

    test('an unavailable last-ask lookup defers the ask instead of sending inside 72h (codex #4141 r1 P1)', async () => {
      const mock = makeMock(fixture('seq-3d5', { lastAskAgoMs: 20 * 3600000 }), {
        // The runner's own last-ask lookup: review_requests, delivered asks,
        // bounded by delivery time (the cap-stats read has no such bound).
        throwSelectWhen: (q) => q.table === 'review_requests' && (q.raws || []).some((r) => /GREATEST\(review_requests\.sms_sent_at, review_requests\.sent_at/.test(String(r))) && (q.selected || []).includes('review_requests.sequence_id'),
      });
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      expect(out.sent).toBe(0);
      const seq = mock.__state.rows.review_sequences[0];
      expect(seq.status).toBe('active');
      expect(parse(seq.decision)).toMatchObject({ reason: 'spacing_lookup_unavailable', ownerAction: 'none' });
      expect(seq.next_run_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60000);
    });

    test('the spacing anchor is the DELIVERY time — a row created 40 days ago and texted an hour ago is an hour-old ask (codex #4141 r3 P2)', async () => {
      const sentAt = new Date(Date.now() - 3600000);
      const mock = makeMock({
        review_requests: [{ id: 'rr-old', customer_id: 'la-1', channel: 'sms', status: 'sent', template_key: 'day0_ask', created_at: new Date(Date.now() - 40 * 86400000), sms_sent_at: sentAt }],
      });
      db.mockImplementation(mock);

      const at = await ReviewService.__private.lastDeliveredAskAt('la-1');
      expect(at.getTime()).toBe(sentAt.getTime());
    });

    test('an email-labelled private check-in in an admin plan is not held behind the 3-day rule either (codex #4141 r3 P2)', async () => {
      const mock = makeMock(fixture('seq-3d4e', { lastAskAgoMs: 20 * 3600000, step: { day: 1, channel: 'email', templateKey: 'resolution_check' } }));
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
      expect(mockSendCustomerMessage.mock.calls[0][0].body).not.toContain('/rate/');
    });

    test('a due step runs under the per-customer review-send lock; a held lock leaves the row due for the next tick (codex #4141 r4 P1)', async () => {
      const dueAt = new Date(Date.now() - 60000);
      const mock = makeMock({
        customers: [{ id: 'lk-c', first_name: 'Ana', last_name: 'M', phone: '+19410000160', nearest_location_id: 'sarasota' }],
        review_sequences: [{
          id: 'seq-lk', customer_id: 'lk-c', status: 'active', current_step: 0, touches_sent: 0, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'day0_ask' }]),
          started_at: new Date(Date.now() - 600000), next_run_at: dueAt,
        }],
      });
      db.mockImplementation(mock);
      global.__reviewLockKeys = [];
      global.__reviewLockHeld = new Set(['review-send:lk-c']);
      try {
        const out = await ReviewService.processReviewSequences();
        expect(global.__reviewLockKeys).toContain('review-send:lk-c');
        expect(out).toMatchObject({ sent: 0, deferred: 1 });
        expect(mockSendCustomerMessage).not.toHaveBeenCalled();
        expect(mock.__state.rows.review_sequences[0].next_run_at).toBe(dueAt);
      } finally {
        global.__reviewLockHeld = null;
      }
      const again = await ReviewService.processReviewSequences();
      expect(again.sent).toBe(1);
    });

    test('an immediate start skipped by the customer lock is durably picked up by the next cadence tick', async () => {
      const mock = makeMock({ customers: [{ id: 'immediate-lock', first_name: 'Ana', nearest_location_id: 'sarasota' }] });
      db.mockImplementation(mock);
      global.__reviewLockHeld = new Set(['review-send:immediate-lock']);
      try {
        const result = await ReviewService.startReviewSequence({ customerId: 'immediate-lock', serviceType: 'pest control', techName: 'Bea' });
        expect(result).toMatchObject({ started: true, firstTouch: { deferred: true, reason: 'customer_lock_held' } });
        expect(result.sequence.next_run_at).toBeInstanceOf(Date);
        expect(result.sequence.next_run_at.getTime()).toBeLessThanOrEqual(Date.now());
        expect(parse(result.sequence.decision)).toMatchObject({ reason: 'customer_lock_held', ownerAction: 'none' });
        expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      } finally {
        global.__reviewLockHeld = null;
      }
      const nextTick = await ReviewService.processReviewSequences();
      expect(nextTick.sent).toBe(1);
      expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    test('a failed immediate-start retry write never reports a queued cadence', async () => {
      const mock = makeMock({ customers: [{ id: 'immediate-lock-write', nearest_location_id: 'sarasota' }] }, { throwUpdateFor: ['review_sequences'] });
      db.mockImplementation(mock);
      global.__reviewLockHeld = new Set(['review-send:immediate-lock-write']);
      try {
        const result = await ReviewService.startReviewSequence({ customerId: 'immediate-lock-write', serviceType: 'pest control', techName: 'Bea' });
        expect(result).toMatchObject({ started: false, reason: 'send_failed' });
        expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      } finally {
        global.__reviewLockHeld = null;
      }
    });

    test('a held customer lock does not reschedule an existing in-flight claim', async () => {
      const mock = makeMock({ review_sequences: [{ id: 'live-claim', customer_id: 'live-claim-customer', status: 'active', next_run_at: null }] });
      db.mockImplementation(mock);
      global.__reviewLockHeld = new Set(['review-send:live-claim-customer']);
      try {
        expect(await ReviewService._runSequenceStep('live-claim')).toMatchObject({ deferred: true, reason: 'customer_lock_held' });
        expect(mock.__state.rows.review_sequences[0].next_run_at).toBeNull();
      } finally {
        global.__reviewLockHeld = null;
      }
    });

    test.each([2, 72])('an operator-started cadence spaces from a staff ask sent %s hours BEFORE enrollment', async (hoursAgo) => {
      jest.useFakeTimers().setSystemTime(new Date('2030-01-01T16:00:00Z'));
      try {
        const manualAt = new Date(Date.now() - hoursAgo * 3600000);
        const mock = makeMock({
          customers: [{ id: 'prior-staff-ask', first_name: 'Ana', nearest_location_id: 'sarasota' }],
          sms_log: [{ customer_id: 'prior-staff-ask', direction: 'outbound', status: 'sent', created_at: manualAt, message_body: 'Please leave a review: https://g.page/r/example/review' }],
        });
        db.mockImplementation(mock);
        const result = await ReviewService.startReviewSequence({ customerId: 'prior-staff-ask', serviceType: 'pest control', techName: 'Bea' });
        expect(result.started).toBe(true);
        if (hoursAgo < 72) {
          expect(result.firstTouch).toMatchObject({ deferred: true, reason: 'spacing' });
          expect(result.sequence.next_run_at.getTime()).toBe(manualAt.getTime() + 72 * 3600000);
          expect(mockSendCustomerMessage).not.toHaveBeenCalled();
        } else {
          expect(result.firstTouch.sent).toBe(true);
          expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
        }
      } finally {
        jest.useRealTimers();
      }
    });

    test('a pre-enrollment staff ask does not space a private check-in', async () => {
      const mock = makeMock({
        customers: [{ id: 'staff-checkin', first_name: 'Ana', nearest_location_id: 'sarasota' }],
        sms_log: [{ customer_id: 'staff-checkin', direction: 'outbound', status: 'sent', created_at: new Date(Date.now() - 2 * 3600000), message_body: 'Please leave a review: https://g.page/r/example/review' }],
      });
      db.mockImplementation(mock);
      const result = await ReviewService.startReviewSequence({ customerId: 'staff-checkin', serviceType: 'pest control', techName: 'Bea', plan: [{ day: 0, channel: 'sms', templateKey: 'resolution_check' }] });
      expect(result.firstTouch.sent).toBe(true);
      expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    test('a failed 72-hour staff-ask lookup defers even when the since-enrollment lookup succeeds', async () => {
      const mock = makeMock({ customers: [{ id: 'staff-spacing-error', nearest_location_id: 'sarasota' }] });
      db.mockImplementation(mock);
      const lookup = jest.spyOn(ReviewService, 'manualReviewAskSentRecently').mockImplementation(async (_id, opts) => {
        if (opts.returnAt) throw new Error('staff lookup unavailable');
        return false;
      });
      try {
        const result = await ReviewService.startReviewSequence({ customerId: 'staff-spacing-error', serviceType: 'pest control', techName: 'Bea' });
        expect(result.firstTouch).toMatchObject({ deferred: true, reason: 'spacing_lookup_unavailable' });
        expect(result.sequence.next_run_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60000);
        expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    });

    test('a failed staff-sent-ask lookup defers an ask step instead of sending inside 72h (codex #4141 r4 P1)', async () => {
      const mock = makeMock(fixture('seq-sl', { lastAskAgoMs: 100 * 3600000 }), { throwSelectWhen: (q) => q.table === 'sms_log' });
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      expect(out).toMatchObject({ sent: 0, deferred: 1 });
      const seq = mock.__state.rows.review_sequences[0];
      expect(seq.status).toBe('active');
      expect(parse(seq.decision)).toMatchObject({ reason: 'spacing_lookup_unavailable' });
    });

    test('the runner anchors to the LATER delivered channel — a Both ask whose email retried after the text (codex #4154 r2 P1)', async () => {
      const smsAt = new Date(Date.now() - 80 * 3600000); // 80 h ago: alone, the reminder would send
      const emailAt = new Date(Date.now() - 20 * 3600000); // the email leg went out 20 h ago
      const fx = fixture('seq-lt', { lastAskAgoMs: 80 * 3600000 });
      fx.review_requests[0] = { ...fx.review_requests[0], channel: 'both', sms_sent_at: smsAt, sent_at: emailAt, created_at: smsAt };
      const mock = makeMock(fx);
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      expect(out).toMatchObject({ sent: 0, deferred: 1 });
      const seq = mock.__state.rows.review_sequences[0];
      expect(parse(seq.decision)).toMatchObject({ reason: 'spacing' });
      // weekdaysOnly is not set on the default fixture step, so the hold is exactly email + 72 h
      expect(new Date(seq.next_run_at).getTime()).toBe(emailAt.getTime() + 72 * 3600000);
    });

    test('the first ask has no timing gate: a Day-0 step with no prior ask sends at its scheduled time', async () => {
      const mock = makeMock({
        customers: [{ id: 'fa-c', first_name: 'Ana', last_name: 'M', phone: '+19410000151', nearest_location_id: 'sarasota' }],
        review_sequences: [{
          id: 'seq-fa', customer_id: 'fa-c', status: 'active', current_step: 0, touches_sent: 0, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'day0_ask' }]),
          started_at: new Date(Date.now() - 600000), next_run_at: new Date(Date.now() - 60000),
        }],
      });
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
    });
  });

  test('"Customer asked for the link" against an ACTIVE cadence is recorded on that cadence, its schedule untouched (codex #4140 r4 P2)', async () => {
    mockGates.reviewSequences = true;
    const nextRun = new Date(Date.now() + 3 * 3600000);
    const mock = makeMock({
      customers: [{ id: 'aa-1', first_name: 'Lee', last_name: 'K', phone: '+19410000144', nearest_location_id: 'venice' }],
      review_sequences: [{ id: 'seq-aa1', customer_id: 'aa-1', status: 'active', current_step: 1, touches_sent: 1, plan: JSON.stringify([{ day: 0 }, { day: 4 }]), started_at: new Date(), next_run_at: nextRun, updated_at: new Date(Date.now() - 3600000), decision: JSON.stringify({ reason: 'follow_up_scheduled', ownerAction: 'none' }) }],
    });
    db.mockImplementation(mock);
    const requested = { by: 'tech-1', byName: 'Adam', at: new Date().toISOString(), source: 'completion_panel' };

    const result = await ReviewService.startReviewSequence({ customerId: 'aa-1', serviceType: 'pest control', techName: 'Adam', customerRequested: requested, decision: { reason: 'customer_requested' } });

    expect(result).toMatchObject({ started: false, reason: 'already_active', requestRecorded: true });
    expect(mock.__state.rows.review_sequences).toHaveLength(1);
    const active = mock.__state.rows.review_sequences[0];
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    expect(parse(active.customer_requested)).toEqual(requested);
    // Schedule and decision belong to the running cadence; the runner's claim
    // stamp (updated_at) is not refreshed by a request capture.
    expect(active.next_run_at).toBe(nextRun);
    expect(parse(active.decision)).toMatchObject({ reason: 'follow_up_scheduled' });
    expect(active.updated_at.getTime()).toBeLessThan(Date.now() - 3000000);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a request capture survives the enrollment race — a unique-index loss records it on the WINNING cadence (codex #4140 r9 P2)', async () => {
    mockGates.reviewSequences = true;
    const requested = { by: 'tech-2', byName: 'Bea', at: new Date().toISOString(), source: 'completion_panel' };
    // No active row at the up-front lookup; another enrollment wins the
    // unique index between that lookup and this insert.
    const mock = makeMock({
      customers: [{ id: 'rc-1', first_name: 'Ray', last_name: 'C', phone: '+19410000146', nearest_location_id: 'venice' }],
    }, {
      onInsert: (table, row, state) => {
        if (table !== 'review_sequences' || row.customer_id !== 'rc-1') return null;
        state.rows.review_sequences.push({ id: 'seq-winner', customer_id: 'rc-1', status: 'active', current_step: 0, touches_sent: 0, plan: '[{"day":0}]', started_at: new Date(), next_run_at: new Date(Date.now() + 3600000) });
        return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      },
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'rc-1', serviceType: 'pest control', techName: 'Bea', customerRequested: requested, decision: { reason: 'customer_requested' } });

    expect(result).toMatchObject({ started: false, reason: 'already_active', requestRecorded: true });
    const winner = mock.__state.rows.review_sequences.find((r) => r.id === 'seq-winner');
    expect(JSON.parse(winner.customer_requested)).toEqual(requested);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([false, true])('the first request capture survives a later completion (concurrent writer: %s)', async (concurrent) => {
    const first = { by: 'first-tech', at: '2030-01-01T16:00:00Z', source: 'completion_panel' };
    const later = { by: 'later-tech', at: '2030-01-02T16:00:00Z', source: 'completion_panel' };
    const mock = makeMock({
      customers: [{ id: 'capture-once' }],
      review_sequences: [{ id: 'capture-seq', customer_id: 'capture-once', status: 'active',
        customer_requested: concurrent ? null : JSON.stringify(first) }],
    }, {
      onUpdate: (table, patch, state) => {
        if (concurrent && table === 'review_sequences' && patch.customer_requested) {
          state.rows.review_sequences[0].customer_requested = JSON.stringify(first);
        }
      },
    });
    db.mockImplementation(mock);
    const result = await ReviewService.startReviewSequence({ customerId: 'capture-once', customerRequested: later });
    expect(result).toMatchObject({ reason: 'already_active', requestRecorded: true });
    expect(JSON.parse(mock.__state.rows.review_sequences[0].customer_requested)).toEqual(first);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('request capture retries enrollment when the active cadence settles before the update', async () => {
    const requested = { by: 'tech-1', at: new Date().toISOString(), source: 'completion_panel' };
    const firstTouchAt = new Date(Date.now() + 3600000);
    const mock = makeMock({
      customers: [{ id: 'capture-race' }],
      review_sequences: [{ id: 'settled', customer_id: 'capture-race', status: 'active' }],
    }, {
      onUpdate: (table, patch, state) => {
        if (table === 'review_sequences' && patch.customer_requested) state.rows.review_sequences[0].status = 'completed';
      },
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'capture-race', serviceType: 'pest control', techName: 'Bea', customerRequested: requested, firstTouchAt });

    expect(result).toMatchObject({ started: true, scheduledFor: firstTouchAt });
    expect(JSON.parse(result.sequence.customer_requested)).toEqual(requested);
    expect(mock.__state.rows.review_sequences[0].customer_requested).toBeUndefined();
    expect(mock.__state.rows.review_sequences.filter(row => row.status === 'active')).toHaveLength(1);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([false, true])('a vanished unique-index winner retries with the delivery cap rechecked (delivered: %s)', async (delivered) => {
    const requested = { by: 'tech-1', at: new Date().toISOString(), source: 'completion_panel' };
    let collided = false;
    const mock = makeMock({ customers: [{ id: 'vanished-winner' }] }, {
      onInsert: (table, row, state) => {
        if (table !== 'review_sequences' || collided) return null;
        collided = true;
        if (delivered) state.rows.review_requests.push({ id: 'winner-ask', customer_id: row.customer_id, status: 'sent', sent_at: new Date(), template_key: 'day0_ask' });
        return Object.assign(new Error('concurrent enrollment settled'), { code: '23505' });
      },
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'vanished-winner', serviceType: 'pest control', techName: 'Bea', customerRequested: requested, firstTouchAt: new Date(Date.now() + 3600000) });

    if (delivered) {
      expect(result).toMatchObject({ started: false, reason: 'cooldown' });
      expect(mock.__state.rows.review_sequences).toHaveLength(0);
    } else {
      expect(result.started).toBe(true);
      expect(JSON.parse(result.sequence.customer_requested)).toEqual(requested);
    }
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('persistent enrollment contention fails visibly after a bounded capture retry', async () => {
    let attempts = 0;
    const mock = makeMock({ customers: [{ id: 'capture-contention' }] }, {
      onInsert: (table) => {
        if (table !== 'review_sequences') return null;
        attempts += 1;
        return Object.assign(new Error('concurrent enrollment settled'), { code: '23505' });
      },
    });
    db.mockImplementation(mock);

    await expect(ReviewService.startReviewSequence({ customerId: 'capture-contention', serviceType: 'pest control', techName: 'Bea', customerRequested: { source: 'completion_panel' } }))
      .rejects.toThrow('Active review cadence changed during request capture');
    expect(attempts).toBe(2);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an already_active result without a request leaves the cadence untouched and reports requestRecorded:false', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'aa-2', first_name: 'Mo', last_name: 'B', phone: '+19410000145', nearest_location_id: 'venice' }],
      review_sequences: [{ id: 'seq-aa2', customer_id: 'aa-2', status: 'active', current_step: 0, touches_sent: 0, plan: '[]', started_at: new Date(), next_run_at: new Date() }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'aa-2', serviceType: 'pest control', techName: 'Adam' });

    expect(result).toMatchObject({ started: false, reason: 'already_active', requestRecorded: false });
    expect(mock.__state.rows.review_sequences[0].customer_requested == null).toBe(true);
  });

  describe('the planned send is the worker tick, not the eligibility instant (codex #4140 r4 P2)', () => {
    const { nextCadenceTickAt, REVIEW_CADENCE_TICK_MINUTES } = ReviewService.__private;

    test('the scheduler cron and the tick table name the same minutes', () => {
      const fs = require('fs');
      const path = require('path');
      const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
      expect(scheduler).toContain(`cron.schedule('${REVIEW_CADENCE_TICK_MINUTES.join(',')} * * * *'`);
    });

    test('the legacy scheduler cron (processScheduled, */15) and the legacy tick table name the same minutes (codex #4140 r18 P2)', () => {
      const fs = require('fs');
      const path = require('path');
      const { LEGACY_REVIEW_TICK_MINUTES } = ReviewService.__private;
      const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
      const legacy = scheduler.slice(scheduler.indexOf("cron.schedule('*/15 * * * *'"), scheduler.indexOf('ReviewService.processScheduled()'));
      expect(legacy).toContain("cron.schedule('*/15 * * * *'");
      expect(LEGACY_REVIEW_TICK_MINUTES).toEqual([0, 15, 30, 45]);
      // The preview route hands the panel both tick tables.
      const route = fs.readFileSync(path.join(__dirname, '../routes/admin-reviews.js'), 'utf8');
      expect(route).toContain('legacyTickMinutesOfHour: ReviewService.__private.LEGACY_REVIEW_TICK_MINUTES');
    });

    test.each([
      ['4:30:00 → 4:44', '2026-05-26T20:30:00.000Z', '2026-05-26T20:44:00.000Z'],
      ['4:45:00 → 5:14', '2026-05-26T20:45:00.000Z', '2026-05-26T21:14:00.000Z'],
      ['4:14:00 exactly → 4:14 (the tick fires on it)', '2026-05-26T20:14:00.000Z', '2026-05-26T20:14:00.000Z'],
      ['4:14:30 → 4:44 (the :14 tick already ran)', '2026-05-26T20:14:30.000Z', '2026-05-26T20:44:00.000Z'],
      ['11:50 PM → 12:14 AM next day', '2026-05-26T23:50:00.000Z', '2026-05-27T00:14:00.000Z'],
    ])('%s', (_label, from, expected) => {
      expect(nextCadenceTickAt(new Date(from)).toISOString()).toBe(expected);
    });

    test('getActiveSequencesForCustomers exposes nextSendTickAt for the Reviews page, null while the runner holds the claim', async () => {
      const mock = makeMock({
        review_sequences: [
          { id: 'seq-t1', customer_id: 't-1', status: 'active', current_step: 0, plan: '[{"day":0}]', next_run_at: new Date('2026-05-26T20:30:00Z') },
          { id: 'seq-t2', customer_id: 't-2', status: 'active', current_step: 0, plan: '[{"day":0}]', next_run_at: null, updated_at: new Date() },
        ],
      });
      db.mockImplementation(mock);
      // Pinned before the row's schedule: the tick is computed from the row.
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-26T20:00:00Z').getTime());
      try {
        const map = await ReviewService.getActiveSequencesForCustomers(['t-1', 't-2']);
        expect(map['t-1'].nextSendTickAt.toISOString()).toBe('2026-05-26T20:44:00.000Z');
        expect(map['t-2']).toMatchObject({ nextSendTickAt: null, sending: true });
      } finally {
        nowSpy.mockRestore();
      }
    });

    test('an SMS step whose tick falls outside the 8 AM–8 PM window shows the first tick after it reopens; an email ask step is not windowed (codex #4140 r11 P2)', async () => {
      mockGates.smsSendWindow = true;
      // 7:50 PM ET on 2026-05-26 (EDT, UTC-4) = 23:50Z; the 8:14 PM tick is outside the window.
      const eveningRow = new Date('2026-05-26T23:50:00Z');
      const mock = makeMock({
        review_sequences: [
          { id: 'seq-w1', customer_id: 'w-1', status: 'active', current_step: 0, plan: '[{"day":0,"channel":"sms","templateKey":"day0_ask"}]', next_run_at: eveningRow },
          { id: 'seq-w2', customer_id: 'w-2', status: 'active', current_step: 0, plan: '[{"day":0,"channel":"email","templateKey":"day0_ask"}]', next_run_at: eveningRow },
        ],
      });
      db.mockImplementation(mock);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-26T23:00:00Z').getTime());
      try {
        const map = await ReviewService.getActiveSequencesForCustomers(['w-1', 'w-2']);
        // Next morning 8:00 AM EDT = 12:00Z; first tick after it is 8:14.
        expect(map['w-1'].nextSendTickAt.toISOString()).toBe('2026-05-27T12:14:00.000Z');
        // Either ask step can swap channel at send time (codex #4140 r14, r16 P2):
        // the SMS step's email fallback escapes the window; the email step's SMS fallback meets it.
        expect(map['w-1']).toMatchObject({ fallbackChannel: 'email', plannedChannel: 'text' });
        expect(map['w-1'].fallbackTickAt.toISOString()).toBe('2026-05-27T00:14:00.000Z');
        expect(map['w-2'].nextSendTickAt.toISOString()).toBe('2026-05-27T00:14:00.000Z');
        expect(map['w-2']).toMatchObject({ fallbackChannel: 'text', plannedChannel: 'email' });
        expect(map['w-2'].fallbackTickAt.toISOString()).toBe('2026-05-27T12:14:00.000Z');
      } finally {
        nowSpy.mockRestore();
        mockGates.smsSendWindow = false;
      }
    });

    test.each(['deferred', 'redeeming'])('a %s final rechecks at night without an SMS-window hold', async status => {
      mockGates.smsSendWindow = true;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-27T01:00:00Z').getTime());
      const mock = makeMock({ review_sequences: [{ id: 'parked-night', customer_id: 'night-customer', status,
        current_step: 0, plan: '[{"day":0,"channel":"sms","templateKey":"day0_ask"}]',
        next_run_at: new Date('2026-05-27T01:05:00Z') }] });
      db.mockImplementation(mock);
      try {
        const map = await ReviewService.getActiveSequencesForCustomers(['night-customer']);
        expect(map['night-customer'].nextSendTickAt.toISOString()).toBe('2026-05-27T01:14:00.000Z');
        expect(map['night-customer']).toMatchObject({ parked: true, fallbackTickAt: null, fallbackChannel: null, plannedChannel: null });
      } finally { nowSpy.mockRestore(); mockGates.smsSendWindow = false; }
    });

    test('a parked series final is a cadence in the candidate map (parked, next re-check), and an active row wins over it (codex #4140 r12 P2)', async () => {
      const parkAt = new Date(Date.now() + 20 * 60000);
      const mock = makeMock({
        review_sequences: [
          { id: 'seq-pk1', customer_id: 'pk-1', status: 'deferred', stop_reason: 'opener_in_flight', current_step: 0, plan: '[{"day":0},{"day":4}]', next_run_at: parkAt, decision: JSON.stringify({ reason: 'opener_in_flight', enrollmentReason: 'customer_requested' }) },
          { id: 'seq-pk2a', customer_id: 'pk-2', status: 'active', current_step: 1, plan: '[{"day":0},{"day":4}]', next_run_at: new Date(Date.now() + 3600000) },
          { id: 'seq-pk2d', customer_id: 'pk-2', status: 'redeeming', current_step: 0, plan: '[{"day":0}]', next_run_at: parkAt },
        ],
      });
      db.mockImplementation(mock);

      const map = await ReviewService.getActiveSequencesForCustomers(['pk-1', 'pk-2']);
      expect(map['pk-1']).toMatchObject({ id: 'seq-pk1', parked: true, sending: false, stranded: false, totalSteps: 2, decision: { reason: 'opener_in_flight' } });
      expect(new Date(map['pk-1'].nextRunAt).getTime()).toBe(parkAt.getTime());
      expect(map['pk-2']).toMatchObject({ id: 'seq-pk2a', parked: false, currentStep: 1 });
    });

    test('an overdue row (missed tick, gate re-enabled between ticks) shows the next tick from now, never one already past (codex #4140 r8)', async () => {
      const mock = makeMock({
        review_sequences: [
          { id: 'seq-t3', customer_id: 't-3', status: 'active', current_step: 0, plan: '[{"day":0}]', next_run_at: new Date('2026-05-26T20:30:00Z') },
        ],
      });
      db.mockImplementation(mock);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-26T22:50:00Z').getTime());
      try {
        const map = await ReviewService.getActiveSequencesForCustomers(['t-3']);
        expect(map['t-3'].nextSendTickAt.toISOString()).toBe('2026-05-26T23:14:00.000Z');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  test('enrollPostService is idempotent per customer — an active cadence blocks a second enrollment', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'en-3', first_name: 'Roy', last_name: 'T', phone: '+19410000033', nearest_location_id: 'venice' }],
      review_sequences: [{ id: 'seq-live', customer_id: 'en-3', status: 'active', current_step: 0, touches_sent: 0, plan: '[]', started_at: new Date(), next_run_at: new Date() }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'en-3', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('already_active');
    expect(mock.__state.rows.review_sequences).toHaveLength(1);
  });

  test('enrollPostService never throws — an archived customer under the gate reports started:false', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'en-4', first_name: 'Gil', last_name: 'B', deleted_at: new Date(), nearest_location_id: 'bradenton' }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'en-4', completedAt: new Date() });
    expect(result.started).toBe(false);
    expect(mock.__state.rows.review_sequences).toHaveLength(0);
  });

  test('a recurring-plan visit enrolls the single-ask plan (owner spec 2026-08-05)', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'rc-1', first_name: 'Sue', last_name: 'H', phone: '+19410000040', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-rc', customer_id: 'rc-1', scheduled_service_id: 'ss-rc', service_type: 'Quarterly Pest Control Service' }],
      scheduled_services: [{ id: 'ss-rc', customer_id: 'rc-1', is_recurring: true, status: 'completed', scheduled_date: '2026-08-01' }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'rc-1', serviceRecordId: 'sr-rc', completedAt: new Date() });

    expect(result.started).toBe(true);
    const plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ day: 0, channel: 'sms' });
  });

  test('a customer with live recurring coverage gets the single ask even off an unlinked completion', async () => {
    mockGates.reviewSequences = true;
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'rc-2', first_name: 'Ted', last_name: 'L', phone: '+19410000041', nearest_location_id: 'venice' }],
      scheduled_services: [{ id: 'ss-fut', customer_id: 'rc-2', is_recurring: true, status: 'confirmed', scheduled_date: future }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'rc-2', completedAt: new Date() });

    expect(result.started).toBe(true);
    expect(JSON.parse(mock.__state.rows.review_sequences[0].plan)).toHaveLength(1);
  });

  test('multi-treatment series: first visit sends the one cap-exempt ask, middle sends nothing, final runs the full cadence', async () => {
    mockGates.reviewSequences = true;
    const future = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

    // FIRST visit: a follow-up child is on the books.
    let mock = makeMock({
      customers: [{ id: 'mt-1', first_name: 'Ivy', last_name: 'R', phone: '+19410000042', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-mt1', customer_id: 'mt-1', scheduled_service_id: 'ss-first' }],
      scheduled_services: [
        { id: 'ss-first', customer_id: 'mt-1', status: 'completed', scheduled_date: '2026-08-01' },
        { id: 'ss-child', customer_id: 'mt-1', parent_service_id: 'ss-first', status: 'confirmed', scheduled_date: future },
      ],
    });
    db.mockImplementation(mock);
    let result = await ReviewService.enrollPostService({ customerId: 'mt-1', serviceRecordId: 'sr-mt1', completedAt: new Date() });
    expect(result.started).toBe(true);
    let plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');

    // MIDDLE visit: itself a child AND another child scheduled → nothing.
    mock = makeMock({
      customers: [{ id: 'mt-2', first_name: 'Ken', last_name: 'D', phone: '+19410000043', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-mt2', customer_id: 'mt-2', scheduled_service_id: 'ss-mid' }],
      scheduled_services: [
        { id: 'ss-mid', customer_id: 'mt-2', parent_service_id: 'ss-root', status: 'completed', scheduled_date: '2026-08-01' },
        { id: 'ss-next', customer_id: 'mt-2', parent_service_id: 'ss-mid', status: 'confirmed', scheduled_date: future },
      ],
    });
    db.mockImplementation(mock);
    result = await ReviewService.enrollPostService({ customerId: 'mt-2', serviceRecordId: 'sr-mt2', completedAt: new Date() });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('multi_treatment_middle');
    expect(mock.__state.rows.review_sequences).toHaveLength(0);

    // FINAL visit: a child with nothing further scheduled → full cadence.
    mock = makeMock({
      customers: [{ id: 'mt-3', first_name: 'Ora', last_name: 'P', phone: '+19410000044', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-mt3', customer_id: 'mt-3', scheduled_service_id: 'ss-final' }],
      scheduled_services: [
        { id: 'ss-final', customer_id: 'mt-3', parent_service_id: 'ss-root2', status: 'completed', scheduled_date: '2026-08-01' },
      ],
    });
    db.mockImplementation(mock);
    result = await ReviewService.enrollPostService({ customerId: 'mt-3', serviceRecordId: 'sr-mt3', completedAt: new Date() });
    expect(result.started).toBe(true);
    plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(3);
    expect(plan.map((s) => s.day)).toEqual([0, 4, 7]);
  });

  test('an owner-named multi-treatment service (roach/bed bug) works without child linkage: first visit = one ask, repeat visit inside 60d = full cadence', async () => {
    mockGates.reviewSequences = true;
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

    // First roach visit — no prior same-service completion → single ask.
    // (The mock's leftJoin is a no-op, so the catalog key rides the visit row.)
    let mock = makeMock({
      customers: [{ id: 'mt-4', first_name: 'Ada', last_name: 'Q', phone: '+19410000045', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-mt4', customer_id: 'mt-4', scheduled_service_id: 'ss-roach1' }],
      scheduled_services: [{ id: 'ss-roach1', customer_id: 'mt-4', service_id: 'svc-roach', status: 'completed', scheduled_date: recent, service_key: 'cockroach_control' }],
    });
    db.mockImplementation(mock);
    let result = await ReviewService.enrollPostService({ customerId: 'mt-4', serviceRecordId: 'sr-mt4', completedAt: new Date() });
    expect(result.started).toBe(true);
    let plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');

    // Second roach visit 10 days later — prior completion exists → full cadence.
    const today = new Date().toISOString().slice(0, 10);
    mock = makeMock({
      customers: [{ id: 'mt-5', first_name: 'Eli', last_name: 'S', phone: '+19410000048', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-mt5', customer_id: 'mt-5', scheduled_service_id: 'ss-roach3' }],
      scheduled_services: [
        { id: 'ss-roach2', customer_id: 'mt-5', service_id: 'svc-roach', status: 'completed', scheduled_date: recent, service_key: 'cockroach_control' },
        { id: 'ss-roach3', customer_id: 'mt-5', service_id: 'svc-roach', status: 'completed', scheduled_date: today, service_key: 'cockroach_control' },
      ],
    });
    db.mockImplementation(mock);
    result = await ReviewService.enrollPostService({ customerId: 'mt-5', serviceRecordId: 'sr-mt5', completedAt: new Date() });
    expect(result.started).toBe(true);
    plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(3);
    // The series-final flag is persisted for the step runner's cap check.
    expect(mock.__state.rows.review_sequences[0].series_final).toBe(true);
  });

  test('trapping family (owner 2026-08-06) is multi-treatment: first visit = one ask; a cross-key follow-up check inside the 30d family window = full cadence', async () => {
    mockGates.reviewSequences = true;

    // First wildlife trapping visit — no prior family completion → single ask.
    let mock = makeMock({
      customers: [{ id: 'tr-1', first_name: 'Ava', last_name: 'T', phone: '+19410000061', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-tr1', customer_id: 'tr-1', scheduled_service_id: 'ss-wt1' }],
      scheduled_services: [
        { id: 'ss-wt1', customer_id: 'tr-1', service_id: 'svc-wt', status: 'completed', scheduled_date: new Date().toISOString().slice(0, 10), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
    });
    db.mockImplementation(mock);
    let result = await ReviewService.enrollPostService({ customerId: 'tr-1', serviceRecordId: 'sr-tr1', completedAt: new Date() });
    expect(result.started).toBe(true);
    let plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');

    // Return check 20 days later, booked under its OWN catalog row
    // (rodent_trapping_followup, different service_id) — same-service
    // matching would miss the initial visit, and the raw 2x-interval window
    // (interval 3 → 6d) would too. Family match + 30d floor classify it
    // series-final → full cadence.
    const twentyAgo = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
    mock = makeMock({
      customers: [{ id: 'tr-2', first_name: 'Ivy', last_name: 'U', phone: '+19410000062', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-tr2', customer_id: 'tr-2', scheduled_service_id: 'ss-tf2' }],
      scheduled_services: [
        { id: 'ss-tp1', customer_id: 'tr-2', service_id: 'svc-trap', status: 'completed', scheduled_date: twentyAgo, service_key: 'rodent_trapping' },
        { id: 'ss-tf2', customer_id: 'tr-2', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: new Date().toISOString().slice(0, 10), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
    });
    db.mockImplementation(mock);
    result = await ReviewService.enrollPostService({ customerId: 'tr-2', serviceRecordId: 'sr-tr2', completedAt: new Date() });
    expect(result.started).toBe(true);
    plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(3);
    expect(mock.__state.rows.review_sequences[0].series_final).toBe(true);

    // The exemption lookup walks the same family window: the first visit's
    // sequence is exempt for the final visit's cap/cooldown check even
    // though the two visits carry different catalog rows.
    mock.__state.rows.review_sequences.push({ id: 'seq-first-trap', customer_id: 'tr-2', scheduled_service_id: 'ss-tp1', status: 'completed' });
    const exempt = await ReviewService._seriesExemptSequenceIds('tr-2', { scheduledServiceId: 'ss-tf2' });
    expect(exempt).toContain('seq-first-trap');
  });

  test('an unlinked trapping program with a LATER booked check stands down at the middle visit (codex #3243 r1)', async () => {
    mockGates.reviewSequences = true;
    const tenAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const inFive = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    // Three unlinked family visits booked up front; completing visit 2 finds
    // visit 1 behind AND visit 3 ahead → middle, no cadence yet.
    const mock = makeMock({
      customers: [{ id: 'tr-3', first_name: 'Mia', last_name: 'V', phone: '+19410000063', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-tr3', customer_id: 'tr-3', scheduled_service_id: 'ss-mid' }],
      scheduled_services: [
        { id: 'ss-first', customer_id: 'tr-3', service_id: 'svc-trap', status: 'completed', scheduled_date: tenAgo, service_key: 'rodent_trapping' },
        { id: 'ss-mid', customer_id: 'tr-3', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: today, service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
        { id: 'ss-later', customer_id: 'tr-3', service_id: 'svc-trap-fu', status: 'scheduled', scheduled_date: inFive, service_key: 'rodent_trapping_followup' },
      ],
    });
    db.mockImplementation(mock);
    const result = await ReviewService.enrollPostService({ customerId: 'tr-3', serviceRecordId: 'sr-tr3', completedAt: new Date() });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('multi_treatment_middle');
    // A cancelled later booking does NOT hold the series open.
    mock.__state.rows.scheduled_services.find((r) => r.id === 'ss-later').status = 'cancelled';
    const rerun = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'tr-3', scheduledServiceId: 'ss-mid' });
    expect(rerun.seriesFinal).toBe(true);
    expect(rerun.plan).toHaveLength(3);
  });

  test('trapping series position respects service line and property; a deferred first visit stands down once the series completed past it (codex #3243 r2)', async () => {
    mockGates.reviewSequences = true;
    const tenAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const inFive = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

    // Wildlife history does NOT make a first rodent visit series-final.
    let mock = makeMock({
      scheduled_services: [
        { id: 'ss-wl', customer_id: 'ln-1', service_id: 'svc-wt', status: 'completed', scheduled_date: tenAgo, service_key: 'wildlife_trapping' },
        { id: 'ss-rt', customer_id: 'ln-1', service_id: 'svc-trap', status: 'completed', scheduled_date: today, service_key: 'rodent_trapping', follow_up_interval_days: 3 },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'ln-1', scheduledServiceId: 'ss-rt' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // A prior program at ANOTHER property does not make this visit final.
    mock = makeMock({
      scheduled_services: [
        { id: 'ss-pa', customer_id: 'pp-1', service_id: 'svc-trap', status: 'completed', scheduled_date: tenAgo, service_key: 'rodent_trapping', property_id: 'prop-rental' },
        { id: 'ss-pb', customer_id: 'pp-1', service_id: 'svc-trap', status: 'completed', scheduled_date: today, service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: null },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'pp-1', scheduledServiceId: 'ss-pb' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // Deferred FIRST visit: a later COMPLETED check proves the series moved
    // past it → stand down; a merely BOOKED later check keeps the first ask.
    mock = makeMock({
      scheduled_services: [
        { id: 'ss-df', customer_id: 'df-1', service_id: 'svc-trap', status: 'completed', scheduled_date: tenAgo, service_key: 'rodent_trapping', follow_up_interval_days: 3 },
        { id: 'ss-dl', customer_id: 'df-1', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: today, service_key: 'rodent_trapping_followup' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'df-1', scheduledServiceId: 'ss-df' });
    expect(plan.skip).toBe('series_completed');

    mock = makeMock({
      scheduled_services: [
        { id: 'ss-df2', customer_id: 'df-2', service_id: 'svc-trap', status: 'completed', scheduled_date: today, service_key: 'rodent_trapping', follow_up_interval_days: 3 },
        { id: 'ss-dl2', customer_id: 'df-2', service_id: 'svc-trap-fu', status: 'scheduled', scheduled_date: inFive, service_key: 'rodent_trapping_followup' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'df-2', scheduledServiceId: 'ss-df2' });
    expect(plan.plan).toHaveLength(1);
    expect(plan.plan[0].templateKey).toBe('first_treatment_ask');
  });

  test('mixed-linkage trapping programs, primary-premise equivalence, and the opener trace (codex #3243 r3)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
    const inFive = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

    // LINKED visit 2 + UNLINKED booked visit 3: the structural final return
    // must yield to the family look-ahead → middle, no cadence yet.
    let mock = makeMock({
      scheduled_services: [
        { id: 'mx-1', customer_id: 'mx', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping' },
        { id: 'mx-2', customer_id: 'mx', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', parent_service_id: 'mx-1', follow_up_interval_days: 3 },
        { id: 'mx-3', customer_id: 'mx', service_id: 'svc-trap-fu', status: 'scheduled', scheduled_date: inFive, service_key: 'rodent_trapping_followup' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'mx', scheduledServiceId: 'mx-2' });
    expect(plan.skip).toBe('multi_treatment_middle');

    // Inverse shape: UNLINKED completed opener + LINKED live child — the
    // liveChild branch must not restart the series with another first ask.
    mock = makeMock({
      scheduled_services: [
        { id: 'iv-1', customer_id: 'iv', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping' },
        { id: 'iv-2', customer_id: 'iv', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
        { id: 'iv-3', customer_id: 'iv', service_id: 'svc-trap-fu', status: 'scheduled', scheduled_date: inFive, service_key: 'rodent_trapping_followup', parent_service_id: 'iv-2' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'iv', scheduledServiceId: 'iv-2' });
    expect(plan.skip).toBe('multi_treatment_middle');

    // Legacy NULL rows and backfilled-primary rows are ONE premise: a prior
    // stamped with the primary property id still makes a NULL-row final.
    mock = makeMock({
      customer_properties: [{ id: 'prop-primary', customer_id: 'pe', is_primary: true }],
      scheduled_services: [
        { id: 'pe-1', customer_id: 'pe', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: 'prop-primary' },
        { id: 'pe-2', customer_id: 'pe', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, property_id: null },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'pe', scheduledServiceId: 'pe-2' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);

    // Opener trace: days 0/20/40 — the final's direct window (30d) misses
    // the day-40 opener, the hop via day-20 reaches it and exempts its ask.
    mock = makeMock({
      scheduled_services: [
        { id: 'op-1', customer_id: 'op', service_id: 'svc-trap', status: 'completed', scheduled_date: d(40), service_key: 'rodent_trapping' },
        { id: 'op-2', customer_id: 'op', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(20), service_key: 'rodent_trapping_followup' },
        { id: 'op-3', customer_id: 'op', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-opener', customer_id: 'op', scheduled_service_id: 'op-1', status: 'completed' }],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('op', { scheduledServiceId: 'op-3' });
    expect(exempt).toContain('seq-opener');

    // Family history MERGES with linked ancestry (codex #3243 r4): the final
    // links only to the middle visit, the opener is unlinked — its sequence
    // must still be exempted, not dropped because linked ancestry was found.
    mock = makeMock({
      scheduled_services: [
        { id: 'mg-1', customer_id: 'mg', service_id: 'svc-trap', status: 'completed', scheduled_date: d(20), service_key: 'rodent_trapping' },
        { id: 'mg-2', customer_id: 'mg', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping_followup' },
        { id: 'mg-3', customer_id: 'mg', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', parent_service_id: 'mg-2', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-mg-opener', customer_id: 'mg', scheduled_service_id: 'mg-1', status: 'completed' }],
    });
    db.mockImplementation(mock);
    const merged = await ReviewService._seriesExemptSequenceIds('mg', { scheduledServiceId: 'mg-3' });
    expect(merged).toContain('seq-mg-opener');
  });

  test('NULL-property premises with different stamped addresses stay separate; same-day setup/removal orders by window (codex #3243 r5)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // Two caller-stated addresses, both unmatched (property_id NULL) but
    // stamped differently: rental A's program must not make rental B's
    // first visit series-final.
    let mock = makeMock({
      scheduled_services: [
        { id: 'ad-1', customer_id: 'ad', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '12 Palm Ave', service_address_zip: '34205' },
        { id: 'ad-2', customer_id: 'ad', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: null, service_address_line1: '99 Oak St', service_address_zip: '34293' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'ad', scheduledServiceId: 'ad-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // Same-day setup + capture/removal: the 1:00pm removal sees the 9:00am
    // setup as its prior → series-final; the setup with the removal still
    // booked keeps the first ask.
    mock = makeMock({
      scheduled_services: [
        { id: 'sd-1', customer_id: 'sd', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1, window_start: '09:00' },
        { id: 'sd-2', customer_id: 'sd', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1, window_start: '13:00' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'sd', scheduledServiceId: 'sd-2' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);

    mock.__state.rows.scheduled_services.find((r) => r.id === 'sd-2').status = 'scheduled';
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'sd', scheduledServiceId: 'sd-1' });
    expect(plan.plan).toHaveLength(1);
    expect(plan.plan[0].templateKey).toBe('first_treatment_ask');
  });

  test('canonical street keys, stamped-rental vs unstamped-legacy premises, and long-chain exemption (codex #3243 r6)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // Equivalent formats are ONE premise: "12 Palm Ave" priors "12 Palm Avenue".
    let mock = makeMock({
      scheduled_services: [
        { id: 'cf-1', customer_id: 'cf', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '12 Palm Ave.', service_address_zip: '34205' },
        { id: 'cf-2', customer_id: 'cf', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, property_id: null, service_address_line1: '12 Palm Avenue', service_address_zip: '34205-1234' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'cf', scheduledServiceId: 'cf-2' });
    expect(plan.seriesFinal).toBe(true);

    // A stamped UNMATCHED rental (stamp differs from the on-file primary)
    // must not adopt an unstamped legacy visit as its prior.
    mock = makeMock({
      customers: [{ id: 'sr', first_name: 'Lee', address_line1: '12 Palm Ave', zip: '34205' }],
      scheduled_services: [
        { id: 'sr-1', customer_id: 'sr', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null },
        { id: 'sr-2', customer_id: 'sr', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: null, service_address_line1: '99 Oak St', service_address_zip: '34293' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'sr', scheduledServiceId: 'sr-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // A ~160-day chain of adjacent checks reaches the opener's sequence.
    const chain = [];
    for (let i = 0; i < 9; i += 1) {
      chain.push({ id: `lc-${i}`, customer_id: 'lc', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(160 - i * 20), service_key: 'rodent_trapping_followup' });
    }
    chain.push({ id: 'lc-final', customer_id: 'lc', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 });
    mock = makeMock({
      scheduled_services: chain,
      review_sequences: [{ id: 'seq-lc-opener', customer_id: 'lc', scheduled_service_id: 'lc-0', status: 'completed' }],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('lc', { scheduledServiceId: 'lc-final' });
    expect(exempt).toContain('seq-lc-opener');
  });

  test('unit-level premises, fail-closed premise errors, and opener supersession by the series final (codex #3243 r7)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // Two units at one street are different premises (streetKey is
    // unit-stripped; the unit leg must separate them).
    let mock = makeMock({
      scheduled_services: [
        { id: 'un-1', customer_id: 'un', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '100 Main St', service_address_line2: 'Apt 4', service_address_zip: '34205' },
        { id: 'un-2', customer_id: 'un', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: null, service_address_line1: '100 Main St', service_address_line2: 'Apt 9', service_address_zip: '34205' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'un', scheduledServiceId: 'un-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // A premise-lookup failure suppresses the enrollment (plan_resolution_failed
    // path) instead of falling open to customer-wide history.
    const base = makeMock({
      scheduled_services: [
        { id: 'fc-1', customer_id: 'fc', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping' },
        { id: 'fc-2', customer_id: 'fc', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3 },
      ],
    });
    const throwingConn = jest.fn((tbl) => {
      if (String(tbl).startsWith('customers')) throw new Error('pg blip');
      return base(tbl);
    });
    throwingConn.__state = base.__state;
    db.mockImplementation(throwingConn);
    const failed = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'fc', scheduledServiceId: 'fc-2' });
    expect(failed.error).toBe(true);

    // A zero-sent opener sequence yields to its own series' final: the final
    // enrolls and the opener stops as superseded_by_final.
    mock = makeMock({
      customers: [{ id: 'os', first_name: 'Ray', last_name: 'W', phone: '+19410000064', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-os', customer_id: 'os', scheduled_service_id: 'os-2' }],
      scheduled_services: [
        { id: 'os-1', customer_id: 'os', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'os-2', customer_id: 'os', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [{ id: 'seq-opener-live', customer_id: 'os', scheduled_service_id: 'os-1', status: 'active', current_step: 0, next_run_at: new Date(Date.now() + 3600000), plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
    });
    db.mockImplementation(mock);
    const result = await ReviewService.enrollPostService({ customerId: 'os', serviceRecordId: 'sr-os', completedAt: new Date() });
    expect(result.started).toBe(true);
    const opener = mock.__state.rows.review_sequences.find((r) => r.id === 'seq-opener-live');
    expect(opener.status).toBe('stopped');
    expect(opener.stop_reason).toBe('superseded_by_final');
  });

  test('a re-linked rental matches its pre-linkage stamped visits, never unstamped legacy rows (codex #3243 r8)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // Opener booked before the rental's property row existed (NULL +
    // stamp); the follow-up is linked to the later-created row for the
    // same address → one series, final cadence.
    let mock = makeMock({
      customer_properties: [{ id: 'prop-oak', customer_id: 'rl', is_primary: false, address_line1: '99 Oak St', zip: '34293' }],
      scheduled_services: [
        { id: 'rl-1', customer_id: 'rl', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '99 Oak Street', service_address_zip: '34293' },
        { id: 'rl-2', customer_id: 'rl', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, property_id: 'prop-oak' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'rl', scheduledServiceId: 'rl-2' });
    expect(plan.seriesFinal).toBe(true);

    // An UNSTAMPED legacy visit (the primary premise) still never priors
    // the linked rental.
    mock = makeMock({
      customer_properties: [{ id: 'prop-oak2', customer_id: 'rl2', is_primary: false, address_line1: '99 Oak St', zip: '34293' }],
      scheduled_services: [
        { id: 'rl2-1', customer_id: 'rl2', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null },
        { id: 'rl2-2', customer_id: 'rl2', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: 'prop-oak2' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'rl2', scheduledServiceId: 'rl2-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);
  });

  test('one-sided units, declared initial setups, and the vanished-opener race (codex #3243 r10)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // "Apt 4" vs the unitless PRIMARY at the same street = different
    // premises (r15 refined: the divergence is against the primary — the
    // unitless prior reads as the on-file whole-street address, never the
    // sub-unit).
    let mock = makeMock({
      customers: [{ id: 'ou', first_name: 'Bo', address_line1: '100 Main St', zip: '34205' }],
      scheduled_services: [
        { id: 'ou-1', customer_id: 'ou', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '100 Main St', service_address_zip: '34205' },
        { id: 'ou-2', customer_id: 'ou', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: null, service_address_line1: '100 Main St', service_address_line2: 'Apt 4', service_address_zip: '34205' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'ou', scheduledServiceId: 'ou-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // A declared 'Initial setup' never inherits an earlier program's
    // position, even inside the history window.
    mock = makeMock({
      service_records: [{ id: 'sr-di', customer_id: 'di', scheduled_service_id: 'di-2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'di-1', customer_id: 'di', service_id: 'svc-trap', status: 'completed', scheduled_date: d(12), service_key: 'rodent_trapping' },
        { id: 'di-2', customer_id: 'di', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3 },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'di', serviceRecordId: 'sr-di' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);
    expect(plan.plan[0].templateKey).toBe('first_treatment_ask');

    // Vanished-opener race: the opener stops ITSELF between the proof and
    // the transactional stop — the final's cadence is still created.
    const base = makeMock({
      customers: [{ id: 'vr', first_name: 'Kim', last_name: 'X', phone: '+19410000065', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-vr', customer_id: 'vr', scheduled_service_id: 'vr-2' }],
      scheduled_services: [
        { id: 'vr-1', customer_id: 'vr', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'vr-2', customer_id: 'vr', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [{ id: 'seq-race', customer_id: 'vr', scheduled_service_id: 'vr-1', status: 'active', current_step: 0, next_run_at: new Date(Date.now() + 3600000), plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
    });
    // Simulate the concurrent self-stop: the first post-proof write path
    // (the pending-ask suppression on review_requests) flips the opener.
    const raceConn = jest.fn((tbl) => {
      if (String(tbl) === 'review_requests') {
        const opener = base.__state.rows.review_sequences.find((r) => r.id === 'seq-race');
        if (opener && opener.status === 'active') {
          opener.status = 'stopped';
          opener.stop_reason = 'series_completed';
        }
      }
      return base(tbl);
    });
    raceConn.__state = base.__state;
    db.mockImplementation(raceConn);
    const result = await ReviewService.enrollPostService({ customerId: 'vr', serviceRecordId: 'sr-vr', completedAt: new Date() });
    expect(result.started).toBe(true);
    const opener = base.__state.rows.review_sequences.find((r) => r.id === 'seq-race');
    expect(opener.stop_reason).toBe('series_completed');
    const replacement = base.__state.rows.review_sequences.find((r) => r.id !== 'seq-race');
    expect(replacement).toBeTruthy();
    expect(replacement.status).toBe('active');
  });

  test('the exemption walk stops at a declared opener, and opener engagement stands the final down (codex #3243 r11)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // Old program's visit sits inside the window, but the declared initial
    // bounds the series: its own sequence is exempt, the old one is NOT.
    let mock = makeMock({
      service_records: [{ id: 'sr-ni', customer_id: 'sw', scheduled_service_id: 'sw-2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'sw-1', customer_id: 'sw', service_id: 'svc-trap', status: 'completed', scheduled_date: d(25), service_key: 'rodent_trapping' },
        { id: 'sw-2', customer_id: 'sw', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping' },
        { id: 'sw-3', customer_id: 'sw', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [
        { id: 'seq-old-opener', customer_id: 'sw', scheduled_service_id: 'sw-1', status: 'completed' },
        { id: 'seq-new-opener', customer_id: 'sw', scheduled_service_id: 'sw-2', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('sw', { scheduledServiceId: 'sw-3' });
    expect(exempt).toContain('seq-new-opener');
    expect(exempt).not.toContain('seq-old-opener');

    // Opener engagement (private 3/10 rating on the first ask) suppresses
    // the final cadence entirely.
    mock = makeMock({
      scheduled_services: [
        { id: 'en-1', customer_id: 'en', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'en-2', customer_id: 'en', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-engaged', customer_id: 'en', scheduled_service_id: 'en-1', status: 'completed' }],
      review_requests: [{ id: 'req-rated', customer_id: 'en', sequence_id: 'seq-engaged', status: 'rated' }],
    });
    db.mockImplementation(mock);
    const plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'en', scheduledServiceId: 'en-2' });
    expect(plan.skip).toBe('series_engaged');
  });

  test('linked finals honor engagement, the walk bound survives dequeues, declared initials override linkage, and omitted units inherit the primary (codex #3243 r12)', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // LINKED final + engaged opener → series_engaged, not the full cadence.
    let mock = makeMock({
      scheduled_services: [
        { id: 'lf-1', customer_id: 'lf', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'lf-2', customer_id: 'lf', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, parent_service_id: 'lf-1' },
      ],
      review_sequences: [{ id: 'seq-lf', customer_id: 'lf', scheduled_service_id: 'lf-1', status: 'completed' }],
      review_requests: [{ id: 'req-lf', customer_id: 'lf', sequence_id: 'seq-lf', status: 'rated' }],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'lf', scheduledServiceId: 'lf-2' });
    expect(plan.skip).toBe('series_engaged');

    // Walk bound persists across dequeues: final d0 → middle d5 → declared
    // initial d10; the old program's d20 visit stays outside even when the
    // middle's own window rediscovers it.
    mock = makeMock({
      service_records: [{ id: 'sr-bd', customer_id: 'bd', scheduled_service_id: 'bd-init', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'bd-old', customer_id: 'bd', service_id: 'svc-trap', status: 'completed', scheduled_date: d(20), service_key: 'rodent_trapping' },
        { id: 'bd-init', customer_id: 'bd', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping' },
        { id: 'bd-mid', customer_id: 'bd', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(5), service_key: 'rodent_trapping_followup' },
        { id: 'bd-fin', customer_id: 'bd', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [
        { id: 'seq-bd-old', customer_id: 'bd', scheduled_service_id: 'bd-old', status: 'completed' },
        { id: 'seq-bd-init', customer_id: 'bd', scheduled_service_id: 'bd-init', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('bd', { scheduledServiceId: 'bd-fin' });
    expect(exempt).toContain('seq-bd-init');
    expect(exempt).not.toContain('seq-bd-old');

    // A declared initial wrongly LINKED to an old visit still opens a new
    // series (single opener ask), not middle/final.
    mock = makeMock({
      service_records: [{ id: 'sr-dl', customer_id: 'dl', scheduled_service_id: 'dl-2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'dl-1', customer_id: 'dl', service_id: 'svc-trap', status: 'completed', scheduled_date: d(12), service_key: 'rodent_trapping' },
        { id: 'dl-2', customer_id: 'dl', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, parent_service_id: 'dl-1' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'dl', serviceRecordId: 'sr-dl' });
    expect(plan.plan).toHaveLength(1);
    expect(plan.plan[0].templateKey).toBe('first_treatment_ask');

    // A phone-booked stamp that omits the unit inherits the primary's unit:
    // it still priors the fully stamped visit at that unit.
    mock = makeMock({
      customers: [{ id: 'iu', first_name: 'Ann', address_line1: '100 Main St', address_line2: 'Apt 7', zip: '34205' }],
      scheduled_services: [
        { id: 'iu-1', customer_id: 'iu', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '100 Main St', service_address_line2: 'Apt 7', service_address_zip: '34205' },
        { id: 'iu-2', customer_id: 'iu', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, property_id: null, service_address_line1: '100 Main St', service_address_zip: '34205' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'iu', scheduledServiceId: 'iu-2' });
    expect(plan.seriesFinal).toBe(true);
  });

  test('r13: strict engagement failures defer, ancestry cuts at declared openers, later declared initials bound the look-ahead, embedded primary units inherit, low-score taps engage', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① A walk failure during the engagement check DEFERS (error), never
    // "not engaged".
    let base = makeMock({
      scheduled_services: [
        { id: 'se-1', customer_id: 'se', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'se-2', customer_id: 'se', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
    });
    const throwSeq = jest.fn((tbl) => {
      if (String(tbl).startsWith('review_sequences')) throw new Error('pg blip');
      return base(tbl);
    });
    throwSeq.__state = base.__state;
    db.mockImplementation(throwSeq);
    let out = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'se', scheduledServiceId: 'se-2' });
    expect(out.error).toBe(true);

    // ④ A service_records failure while reading the declaration also defers.
    base = makeMock({
      scheduled_services: [
        { id: 'sd4-1', customer_id: 'sd4', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'sd4-2', customer_id: 'sd4', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3 },
      ],
    });
    const throwSr = jest.fn((tbl) => {
      if (String(tbl).startsWith('service_records')) throw new Error('pg blip');
      return base(tbl);
    });
    throwSr.__state = base.__state;
    db.mockImplementation(throwSr);
    out = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'sd4', scheduledServiceId: 'sd4-2' });
    expect(out.error).toBe(true);

    // ② A final linked THROUGH a declared initial to the old program: the
    // old program's sequence is cut from the exemption set.
    let mock = makeMock({
      service_records: [{ id: 'sr-ac', customer_id: 'ac', scheduled_service_id: 'ac-init', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'ac-old', customer_id: 'ac', service_id: 'svc-trap', status: 'completed', scheduled_date: d(18), service_key: 'rodent_trapping' },
        { id: 'ac-init', customer_id: 'ac', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping', parent_service_id: 'ac-old' },
        { id: 'ac-fin', customer_id: 'ac', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, parent_service_id: 'ac-init' },
      ],
      review_sequences: [
        { id: 'seq-ac-old', customer_id: 'ac', scheduled_service_id: 'ac-old', status: 'completed' },
        { id: 'seq-ac-init', customer_id: 'ac', scheduled_service_id: 'ac-init', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('ac', { scheduledServiceId: 'ac-fin' });
    expect(exempt).toContain('seq-ac-init');
    expect(exempt).not.toContain('seq-ac-old');

    // ③ A deferred old final whose window contains the NEW program's
    // declared initial still classifies series-final (the boundary is a
    // new series, not this one continuing).
    mock = makeMock({
      service_records: [{ id: 'sr-nb', customer_id: 'nb', scheduled_service_id: 'nb-new', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'nb-open', customer_id: 'nb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(20), service_key: 'rodent_trapping' },
        { id: 'nb-fin', customer_id: 'nb', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
        { id: 'nb-new', customer_id: 'nb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(5), service_key: 'rodent_trapping' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'nb', scheduledServiceId: 'nb-fin' });
    expect(plan.seriesFinal).toBe(true);

    // ⑤ A primary whose unit is embedded in line 1 still lends it to a
    // unit-omitting phone stamp.
    mock = makeMock({
      customers: [{ id: 'eu', first_name: 'Joy', address_line1: '100 Main St Apt 7', zip: '34205' }],
      scheduled_services: [
        { id: 'eu-1', customer_id: 'eu', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '100 Main St Apt 7', service_address_zip: '34205' },
        { id: 'eu-2', customer_id: 'eu', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, property_id: null, service_address_line1: '100 Main St', service_address_zip: '34205' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'eu', scheduledServiceId: 'eu-2' });
    expect(plan.seriesFinal).toBe(true);

    // ⑥ An abandoned non-promoter score tap counts as engagement.
    mock = makeMock({
      scheduled_services: [
        { id: 'ls-1', customer_id: 'ls', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'ls-2', customer_id: 'ls', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-ls', customer_id: 'ls', scheduled_service_id: 'ls-1', status: 'completed' }],
      review_requests: [{ id: 'req-ls', customer_id: 'ls', sequence_id: 'seq-ls', status: 'sent', score: 3, category: 'detractor' }],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'ls', scheduledServiceId: 'ls-2' });
    expect(plan.skip).toBe('series_engaged');
  });

  test('r14: walk-discovered openers prune linked seeds, declared follow-ups take the final cadence, absent primary keeps stamps distinct', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① Final links through a middle to the OLD program while the current
    // program's declared initial is UNLINKED: the walk's bound must prune
    // the linked old ancestor from the seeds too.
    let mock = makeMock({
      service_records: [{ id: 'sr-up', customer_id: 'up', scheduled_service_id: 'up-init', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'up-oldanc', customer_id: 'up', service_id: 'svc-trap', status: 'completed', scheduled_date: d(18), service_key: 'rodent_trapping' },
        { id: 'up-init', customer_id: 'up', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'up-mid', customer_id: 'up', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(4), service_key: 'rodent_trapping_followup', parent_service_id: 'up-oldanc' },
        { id: 'up-fin', customer_id: 'up', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, parent_service_id: 'up-mid' },
      ],
      review_sequences: [
        { id: 'seq-up-oldanc', customer_id: 'up', scheduled_service_id: 'up-oldanc', status: 'completed' },
        { id: 'seq-up-init', customer_id: 'up', scheduled_service_id: 'up-init', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('up', { scheduledServiceId: 'up-fin' });
    expect(exempt).toContain('seq-up-init');
    expect(exempt).not.toContain('seq-up-oldanc');

    // ② A declared "Follow-up check" whose real prior fell outside the
    // window still carries the final cadence, not another opener ask.
    mock = makeMock({
      service_records: [{ id: 'sr-fc', customer_id: 'fc2', scheduled_service_id: 'fc2-2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Follow-up check' } } }) }],
      scheduled_services: [
        { id: 'fc2-1', customer_id: 'fc2', service_id: 'svc-trap', status: 'completed', scheduled_date: d(45), service_key: 'rodent_trapping' },
        { id: 'fc2-2', customer_id: 'fc2', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'fc2', serviceRecordId: 'sr-fc' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);

    // ③ A customer with NO primary address on file: a stamped visit never
    // merges with an unstamped legacy visit.
    mock = makeMock({
      customers: [{ id: 'np2', first_name: 'Sky' }],
      scheduled_services: [
        { id: 'np2-1', customer_id: 'np2', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null },
        { id: 'np2-2', customer_id: 'np2', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: null, service_address_line1: '55 Pine Rd', service_address_zip: '34275' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'np2', scheduledServiceId: 'np2-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);
  });

  test('r15: declared follow-ups honor out-of-window engagement, exclusion keeps its tight window, wildlife derives from trap_actions, unmatched premises inherit units', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① Declared follow-up with a rated out-of-window opener → stand down.
    let mock = makeMock({
      service_records: [{ id: 'sr-oe', customer_id: 'oe', scheduled_service_id: 'oe-2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Follow-up check' } } }) }],
      scheduled_services: [
        { id: 'oe-1', customer_id: 'oe', service_id: 'svc-trap', status: 'completed', scheduled_date: d(45), service_key: 'rodent_trapping' },
        { id: 'oe-2', customer_id: 'oe', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-oe', customer_id: 'oe', scheduled_service_id: 'oe-1', status: 'completed' }],
      review_requests: [{ id: 'req-oe', customer_id: 'oe', sequence_id: 'seq-oe', status: 'rated' }],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'oe', serviceRecordId: 'sr-oe' });
    expect(plan.skip).toBe('series_engaged');

    // ② A NEW exclusion program 20 days after the old one is a new series
    // (7d interval → 14d window, no 30d floor for plain exclusion).
    mock = makeMock({
      scheduled_services: [
        { id: 'ex-1', customer_id: 'ex', service_id: 'svc-excl', status: 'completed', scheduled_date: d(20), service_key: 'rodent_exclusion' },
        { id: 'ex-2', customer_id: 'ex', service_id: 'svc-excl', status: 'completed', scheduled_date: d(0), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'ex', scheduledServiceId: 'ex-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // ③ Wildlife with a pure 'Trap installed' report is a declared initial
    // even with a prior program in the window.
    mock = makeMock({
      service_records: [{ id: 'sr-wi', customer_id: 'wi', scheduled_service_id: 'wi-2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'wildlife_trapping', values: { trap_actions: ['Trap installed'] } } }) }],
      scheduled_services: [
        { id: 'wi-1', customer_id: 'wi', service_id: 'svc-wt', status: 'completed', scheduled_date: d(12), service_key: 'wildlife_trapping' },
        { id: 'wi-2', customer_id: 'wi', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'wi', serviceRecordId: 'sr-wi' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);
    expect(plan.plan[0].templateKey).toBe('first_treatment_ask');

    // ④ Two unmatched-rental visits where the earlier phone stamp omitted
    // the unit: the current visit's unit inherits onto it → one series.
    mock = makeMock({
      customers: [{ id: 'ui', first_name: 'Max', address_line1: '1 Beach Blvd', zip: '34229' }],
      scheduled_services: [
        { id: 'ui-1', customer_id: 'ui', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '77 Bay St', service_address_zip: '34293' },
        { id: 'ui-2', customer_id: 'ui', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, property_id: null, service_address_line1: '77 Bay St', service_address_line2: 'Unit B', service_address_zip: '34293' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'ui', scheduledServiceId: 'ui-2' });
    expect(plan.seriesFinal).toBe(true);
  });

  test('r16: comma-joined trap_actions parse, and old-program engagement does not cross a declared opener', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ② The chips control persists trap_actions as a comma-joined STRING —
    // a normal wildlife setup declaration must still parse.
    let mock = makeMock({
      service_records: [{ id: 'sr-ws', customer_id: 'ws', scheduled_service_id: 'ws-2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'wildlife_trapping', values: { trap_actions: 'Trap installed, Bait/lure refreshed' } } }) }],
      scheduled_services: [
        { id: 'ws-1', customer_id: 'ws', service_id: 'svc-wt', status: 'completed', scheduled_date: d(12), service_key: 'wildlife_trapping' },
        { id: 'ws-2', customer_id: 'ws', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'ws', serviceRecordId: 'sr-ws' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // ③ A rated ask from an OLDER program (behind the current program's
    // declared opener) does not suppress the current final cadence.
    mock = makeMock({
      service_records: [
        { id: 'sr-cb1', customer_id: 'cb', scheduled_service_id: 'cb-init', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) },
        { id: 'sr-cb2', customer_id: 'cb', scheduled_service_id: 'cb-fin', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Follow-up check' } } }) },
      ],
      scheduled_services: [
        { id: 'cb-old', customer_id: 'cb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(100), service_key: 'rodent_trapping' },
        { id: 'cb-init', customer_id: 'cb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(45), service_key: 'rodent_trapping' },
        { id: 'cb-fin', customer_id: 'cb', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-cb-old', customer_id: 'cb', scheduled_service_id: 'cb-old', status: 'completed' }],
      review_requests: [{ id: 'req-cb-old', customer_id: 'cb', sequence_id: 'seq-cb-old', status: 'rated' }],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'cb', serviceRecordId: 'sr-cb2' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);
  });

  test('r17: unit-omitting primary stamps classify against the primary first, and exclusion series keep their tight walk window', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① Primary is Apt 3; visit is unmatched Apt 4; an old unit-omitting
    // phone stamp of the primary must read as the primary, never inherit
    // Apt 4 into the rental's history.
    let mock = makeMock({
      customers: [{ id: 'p3', first_name: 'Ida', address_line1: '100 Main St', address_line2: 'Apt 3', zip: '34205' }],
      scheduled_services: [
        { id: 'p3-1', customer_id: 'p3', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', property_id: null, service_address_line1: '100 Main St', service_address_zip: '34205' },
        { id: 'p3-2', customer_id: 'p3', service_id: 'svc-trap', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping', follow_up_interval_days: 3, property_id: null, service_address_line1: '100 Main St', service_address_line2: 'Apt 4', service_address_zip: '34205' },
      ],
    });
    db.mockImplementation(mock);
    const plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'p3', scheduledServiceId: 'p3-2' });
    expect(plan.seriesFinal).not.toBe(true);
    expect(plan.plan).toHaveLength(1);

    // ② An exclusion program's return rides the generic followup SKU: the
    // walk borrows the nearest exclusion opener's tight window, so the
    // OLD exclusion program 20+ days back stays outside the series.
    mock = makeMock({
      scheduled_services: [
        { id: 'xw-old', customer_id: 'xw', service_id: 'svc-excl', status: 'completed', scheduled_date: d(27), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
        { id: 'xw-new', customer_id: 'xw', service_id: 'svc-excl', status: 'completed', scheduled_date: d(7), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
        { id: 'xw-fin', customer_id: 'xw', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [
        { id: 'seq-xw-old', customer_id: 'xw', scheduled_service_id: 'xw-old', status: 'completed' },
        { id: 'seq-xw-new', customer_id: 'xw', scheduled_service_id: 'xw-new', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('xw', { scheduledServiceId: 'xw-fin' });
    expect(exempt).toContain('seq-xw-new');
    expect(exempt).not.toContain('seq-xw-old');
  });

  test('r18: origin survives generic middles, in-flight openers are non-supersedable, booked future openers bound the look-ahead', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
    const inFive = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

    // ① Exclusion origin carries through generic middle checks: old
    // exclusion d27 / new opener d12 / generic checks d6 and d0.
    let mock = makeMock({
      scheduled_services: [
        { id: 'og-old', customer_id: 'og', service_id: 'svc-excl', status: 'completed', scheduled_date: d(27), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
        { id: 'og-new', customer_id: 'og', service_id: 'svc-excl', status: 'completed', scheduled_date: d(12), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
        { id: 'og-mid', customer_id: 'og', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(6), service_key: 'rodent_trapping_followup' },
        { id: 'og-fin', customer_id: 'og', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [
        { id: 'seq-og-old', customer_id: 'og', scheduled_service_id: 'og-old', status: 'completed' },
        { id: 'seq-og-new', customer_id: 'og', scheduled_service_id: 'og-new', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('og', { scheduledServiceId: 'og-fin' });
    expect(exempt).toContain('seq-og-new');
    expect(exempt).not.toContain('seq-og-old');

    // ② A claimed opener (next_run_at NULL = send in flight) is NOT
    // superseded — the final enrollment yields already_active.
    mock = makeMock({
      customers: [{ id: 'if', first_name: 'Gus', last_name: 'Y', phone: '+19410000066', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-if', customer_id: 'if', scheduled_service_id: 'if-2' }],
      scheduled_services: [
        { id: 'if-1', customer_id: 'if', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'if-2', customer_id: 'if', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [{ id: 'seq-inflight', customer_id: 'if', scheduled_service_id: 'if-1', status: 'active', current_step: 0, next_run_at: null, plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
    });
    db.mockImplementation(mock);
    const prevDelay = ReviewService._SUPERSEDE_RETRY_DELAY_MS;
    ReviewService._SUPERSEDE_RETRY_DELAY_MS = 1;
    let res;
    try {
      res = await ReviewService.enrollPostService({ customerId: 'if', serviceRecordId: 'sr-if', completedAt: new Date() });
    } finally {
      ReviewService._SUPERSEDE_RETRY_DELAY_MS = prevDelay;
    }
    expect(res.started).toBe(false);
    const inflight = mock.__state.rows.review_sequences.find((r) => r.id === 'seq-inflight');
    expect(inflight.status).toBe('active');

    // ③ A booked future UNLINKED base-SKU visit is a new program's opener:
    // the current final is still final, not a middle.
    mock = makeMock({
      scheduled_services: [
        { id: 'bf-1', customer_id: 'bf', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'bf-2', customer_id: 'bf', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
        { id: 'bf-3', customer_id: 'bf', service_id: 'svc-combo', status: 'scheduled', scheduled_date: inFive, service_key: 'rodent_trapping_exclusion' },
      ],
    });
    db.mockImplementation(mock);
    const plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'bf', scheduledServiceId: 'bf-2' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);
  });

  test('r19: exclusion lineage stops at the program opener, and completed report-less rows are not booking-inferred openers', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① Declared follow-up 35d after its exclusion opener: the engagement
    // lineage stops at that opener — an older exclusion program's rating
    // does not suppress the current final.
    let mock = makeMock({
      service_records: [{ id: 'sr-el', customer_id: 'el', scheduled_service_id: 'el-fin', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Follow-up check' } } }) }],
      scheduled_services: [
        { id: 'el-older', customer_id: 'el', service_id: 'svc-excl', status: 'completed', scheduled_date: d(90), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
        { id: 'el-open', customer_id: 'el', service_id: 'svc-excl', status: 'completed', scheduled_date: d(35), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
        { id: 'el-fin', customer_id: 'el', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-el-older', customer_id: 'el', scheduled_service_id: 'el-older', status: 'completed' }],
      review_requests: [{ id: 'req-el-older', customer_id: 'el', sequence_id: 'seq-el-older', status: 'rated' }],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'el', serviceRecordId: 'sr-el' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);

    // ② A COMPLETED report-less base-SKU later row is NOT a booking-level
    // opener: the deferred earlier visit stands down (series moved past).
    mock = makeMock({
      scheduled_services: [
        { id: 'cl-1', customer_id: 'cl', service_id: 'svc-trap', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping', follow_up_interval_days: 3 },
        { id: 'cl-2', customer_id: 'cl', service_id: 'svc-trap', status: 'completed', scheduled_date: d(2), service_key: 'rodent_trapping' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'cl', scheduledServiceId: 'cl-1' });
    expect(plan.skip).toBe('series_completed');
  });

  test('r20: report-less base rows never truncate the lineage, settled openers release the final, declared boundaries leave structural children', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① A completed report-less base rodent row between the final and its
    // engaged out-of-window opener does NOT truncate the lineage — the
    // rating still stands the cadence down.
    let mock = makeMock({
      service_records: [{ id: 'sr-nt', customer_id: 'nt', scheduled_service_id: 'nt-fin', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Follow-up check' } } }) }],
      scheduled_services: [
        { id: 'nt-open', customer_id: 'nt', service_id: 'svc-trap', status: 'completed', scheduled_date: d(45), service_key: 'rodent_trapping' },
        { id: 'nt-mid', customer_id: 'nt', service_id: 'svc-trap', status: 'completed', scheduled_date: d(20), service_key: 'rodent_trapping' },
        { id: 'nt-fin', customer_id: 'nt', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-nt-open', customer_id: 'nt', scheduled_service_id: 'nt-open', status: 'completed' }],
      review_requests: [{ id: 'req-nt-open', customer_id: 'nt', sequence_id: 'seq-nt-open', status: 'rated' }],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'nt', serviceRecordId: 'sr-nt' });
    expect(plan.skip).toBe('series_engaged');

    // ② An in-flight opener that settles to completed during the wait
    // releases the final: the fresh cadence enrolls.
    const base = makeMock({
      customers: [{ id: 'st', first_name: 'Ora', last_name: 'Z', phone: '+19410000067', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-st', customer_id: 'st', scheduled_service_id: 'st-2' }],
      scheduled_services: [
        { id: 'st-1', customer_id: 'st', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'st-2', customer_id: 'st', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [{ id: 'seq-settle', customer_id: 'st', scheduled_service_id: 'st-1', status: 'active', current_step: 0, next_run_at: null, plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
    });
    db.mockImplementation(base);
    const opener = base.__state.rows.review_sequences.find((r) => r.id === 'seq-settle');
    const settleTimer = setTimeout(() => {
      opener.status = 'completed';
      opener.stop_reason = 'completed';
    }, 25);
    const prev = ReviewService._SUPERSEDE_RETRY_DELAY_MS;
    ReviewService._SUPERSEDE_RETRY_DELAY_MS = 15;
    let res;
    try {
      res = await ReviewService.enrollPostService({ customerId: 'st', serviceRecordId: 'sr-st', completedAt: new Date() });
    } finally {
      ReviewService._SUPERSEDE_RETRY_DELAY_MS = prev;
      clearTimeout(settleTimer);
    }
    expect(res.started).toBe(true);
    expect(opener.stop_reason).toBe('completed');

    // ③ A LINKED later visit whose report declares 'Initial setup' does not
    // read as this series' structural child — the deferred final keeps its
    // cadence instead of series_completed.
    mock = makeMock({
      service_records: [{ id: 'sr-nb2', customer_id: 'nb2', scheduled_service_id: 'nb2-new', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) }],
      scheduled_services: [
        { id: 'nb2-open', customer_id: 'nb2', service_id: 'svc-trap', status: 'completed', scheduled_date: d(12), service_key: 'rodent_trapping' },
        { id: 'nb2-fin', customer_id: 'nb2', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(6), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
        { id: 'nb2-new', customer_id: 'nb2', service_id: 'svc-trap', status: 'completed', scheduled_date: d(1), service_key: 'rodent_trapping', parent_service_id: 'nb2-fin' },
      ],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'nb2', scheduledServiceId: 'nb2-fin' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);
  });

  test('r21: a stuck in-flight opener parks the final durably and the cron redeems it; report-less followup-SKU visits are never openers', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ② Retry window exhausts against a stuck in-flight opener → a
    // 'deferred' parking row persists the final; once the opener settles,
    // processReviewSequences redeems it into a real cadence.
    const mock = makeMock({
      customers: [{ id: 'pk', first_name: 'Ann', last_name: 'Q', phone: '+19410000068', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-pk', customer_id: 'pk', scheduled_service_id: 'pk-2' }],
      scheduled_services: [
        { id: 'pk-1', customer_id: 'pk', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'pk-2', customer_id: 'pk', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [{ id: 'seq-stuck', customer_id: 'pk', scheduled_service_id: 'pk-1', status: 'active', current_step: 0, next_run_at: null, plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
    });
    db.mockImplementation(mock);
    const prev = ReviewService._SUPERSEDE_RETRY_DELAY_MS;
    ReviewService._SUPERSEDE_RETRY_DELAY_MS = 1;
    let res;
    try {
      res = await ReviewService.enrollPostService({ customerId: 'pk', serviceRecordId: 'sr-pk', completedAt: new Date() });
    } finally {
      ReviewService._SUPERSEDE_RETRY_DELAY_MS = prev;
    }
    expect(res.started).toBe(false);
    expect(res.reason).toBe('deferred_inflight');
    const parked = mock.__state.rows.review_sequences.find((r) => r.status === 'deferred');
    expect(parked).toBeTruthy();
    expect(parked.stop_reason).toBe('opener_in_flight');

    // The opener settles; make the parking row due and run the cron sweep.
    const stuck = mock.__state.rows.review_sequences.find((r) => r.id === 'seq-stuck');
    stuck.status = 'completed';
    parked.next_run_at = new Date(Date.now() - 1000);
    const out = await ReviewService.processReviewSequences();
    expect(out.redeemed).toBe(1);
    const replacement = mock.__state.rows.review_sequences.find((r) => r.status === 'active');
    expect(replacement).toBeTruthy();
    expect(JSON.parse(replacement.plan)).toHaveLength(3);

    // ③ A followup-SKU visit with NO report and an out-of-window opener is
    // still a follow-up by catalog definition — final cadence, not an
    // opener ask.
    const mock2 = makeMock({
      scheduled_services: [
        { id: 'fk-1', customer_id: 'fk', service_id: 'svc-trap', status: 'completed', scheduled_date: d(45), service_key: 'rodent_trapping' },
        { id: 'fk-2', customer_id: 'fk', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
    });
    db.mockImplementation(mock2);
    const plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'fk', scheduledServiceId: 'fk-2' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);
  });

  test('r22: a throwing redemption restores the parking row, and same-day boundary ties break by appointment order', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① startReviewSequence throws mid-redeem (customers lookup) → the
    // parking row is restored with backoff, not consumed.
    const base = makeMock({
      review_sequences: [{ id: 'seq-park', customer_id: 'rx', status: 'deferred', stop_reason: 'opener_in_flight', plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]), current_step: 0, touches_sent: 0, next_run_at: new Date(Date.now() - 1000), series_final: true, scheduled_service_id: 'rx-2', completed_at: new Date() }],
    });
    const throwCust = jest.fn((tbl) => {
      if (String(tbl).startsWith('customers')) throw new Error('pg blip');
      return base(tbl);
    });
    throwCust.__state = base.__state;
    db.mockImplementation(throwCust);
    const out = await ReviewService.processReviewSequences();
    expect(out.redeemed).toBe(0);
    const restored = base.__state.rows.review_sequences.find((r) => r.status === 'deferred');
    expect(restored).toBeTruthy();
    expect(restored.stop_reason).toBe('opener_in_flight');

    // ② Two same-day later openers: the EARLIER appointment bounds the
    // look-ahead, so the deferred final keeps its cadence.
    const mock = makeMock({
      service_records: [
        { id: 'sr-t1', customer_id: 'tb', scheduled_service_id: 'tb-n1', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) },
        { id: 'sr-t2', customer_id: 'tb', scheduled_service_id: 'tb-n2', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) },
      ],
      scheduled_services: [
        { id: 'tb-open', customer_id: 'tb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(20), service_key: 'rodent_trapping' },
        { id: 'tb-fin', customer_id: 'tb', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(10), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
        { id: 'tb-n1', customer_id: 'tb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(5), service_key: 'rodent_trapping', window_start: '09:00' },
        { id: 'tb-n2', customer_id: 'tb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(5), service_key: 'rodent_trapping', window_start: '13:00' },
      ],
    });
    db.mockImplementation(mock);
    const plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'tb', scheduledServiceId: 'tb-fin' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);
  });

  test('r23: plain-base future checks are not boundaries, and lineage same-day ties break by appointment order', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
    const inFive = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

    // ③ A booked future PLAIN rodent_trapping visit may be this program's
    // own check — it is NOT a booking-level boundary, so the middle visit
    // stands down.
    let mock = makeMock({
      scheduled_services: [
        { id: 'pb-1', customer_id: 'pb', service_id: 'svc-trap', status: 'completed', scheduled_date: d(8), service_key: 'rodent_trapping' },
        { id: 'pb-2', customer_id: 'pb', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
        { id: 'pb-3', customer_id: 'pb', service_id: 'svc-trap', status: 'scheduled', scheduled_date: inFive, service_key: 'rodent_trapping' },
      ],
    });
    db.mockImplementation(mock);
    let plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'pb', scheduledServiceId: 'pb-2' });
    expect(plan.skip).toBe('multi_treatment_middle');

    // ① Lineage same-day tie: the current program's declared opener (1pm)
    // shares a date with the old program's rated final (9am) — the opener
    // sorts first and bounds the walk, so the old rating does not suppress
    // the current final.
    mock = makeMock({
      service_records: [
        { id: 'sr-lt1', customer_id: 'lt', scheduled_service_id: 'lt-open', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Initial setup' } } }) },
        { id: 'sr-lt2', customer_id: 'lt', scheduled_service_id: 'lt-fin', service_data: JSON.stringify({ typedReportSnapshot: { type: 'rodent_trapping', values: { trap_visit_type: 'Follow-up check' } } }) },
      ],
      scheduled_services: [
        { id: 'lt-oldfin', customer_id: 'lt', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(35), service_key: 'rodent_trapping_followup', window_start: '09:00' },
        { id: 'lt-open', customer_id: 'lt', service_id: 'svc-trap', status: 'completed', scheduled_date: d(35), service_key: 'rodent_trapping', window_start: '13:00' },
        { id: 'lt-fin', customer_id: 'lt', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [{ id: 'seq-lt-oldfin', customer_id: 'lt', scheduled_service_id: 'lt-oldfin', status: 'completed' }],
      review_requests: [{ id: 'req-lt-oldfin', customer_id: 'lt', sequence_id: 'seq-lt-oldfin', status: 'rated' }],
    });
    db.mockImplementation(mock);
    plan = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'lt', serviceRecordId: 'sr-lt2' });
    expect(plan.seriesFinal).toBe(true);
    expect(plan.plan).toHaveLength(3);
  });

  test('r24: a still-in-flight opener releases the claimed parking row instead of consuming it', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'rp', first_name: 'Ivy', last_name: 'R', phone: '+19410000069', nearest_location_id: 'bradenton' }],
      scheduled_services: [
        { id: 'rp-1', customer_id: 'rp', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'rp-2', customer_id: 'rp', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [
        { id: 'seq-hung', customer_id: 'rp', scheduled_service_id: 'rp-1', status: 'active', current_step: 0, next_run_at: null, plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) },
        { id: 'seq-park2', customer_id: 'rp', status: 'deferred', stop_reason: 'opener_in_flight', plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]), current_step: 0, touches_sent: 0, next_run_at: new Date(Date.now() - 1000), series_final: true, scheduled_service_id: 'rp-2', completed_at: new Date() },
      ],
    });
    db.mockImplementation(mock);
    const prev = ReviewService._SUPERSEDE_RETRY_DELAY_MS;
    ReviewService._SUPERSEDE_RETRY_DELAY_MS = 1;
    let out;
    try {
      out = await ReviewService.processReviewSequences();
    } finally {
      ReviewService._SUPERSEDE_RETRY_DELAY_MS = prev;
    }
    expect(out.redeemed).toBe(0);
    const released = mock.__state.rows.review_sequences.find((r) => r.id === 'seq-park2');
    expect(released).toBeTruthy();
    expect(released.status).toBe('deferred');
    expect(new Date(released.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('r25: same-day origin ties in the walk peek pick the later appointment deterministically', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
    // Same-day base pair at d-7 (exclusion 9am, trapping setup 1pm): the
    // walk still reaches the current program's opener chain and stays
    // deterministic whichever DB order returns the pair. (The reachable
    // set is dominated by the larger-window key in the pair; the tie-break
    // fixes WHICH key anchors hop 1.)
    const mock = makeMock({
      scheduled_services: [
        { id: 'ot-excl', customer_id: 'ot', service_id: 'svc-excl', status: 'completed', scheduled_date: d(7), service_key: 'rodent_exclusion', follow_up_interval_days: 7, window_start: '09:00' },
        { id: 'ot-trap', customer_id: 'ot', service_id: 'svc-trap', status: 'completed', scheduled_date: d(7), service_key: 'rodent_trapping', follow_up_interval_days: 3, window_start: '13:00' },
        { id: 'ot-fin', customer_id: 'ot', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3 },
      ],
      review_sequences: [
        { id: 'seq-ot-trap', customer_id: 'ot', scheduled_service_id: 'ot-trap', status: 'completed' },
        { id: 'seq-ot-excl', customer_id: 'ot', scheduled_service_id: 'ot-excl', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('ot', { scheduledServiceId: 'ot-fin' });
    expect(exempt).toContain('seq-ot-trap');
    expect(exempt).toContain('seq-ot-excl');
  });

  test('r26: a same-day exclusion opener anchors the walk window, and a failing park write propagates', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

    // ① Exclusion opener 9am + its generic check 1pm the SAME day: the
    // opener anchors hop 1 with the 14-day exclusion window, so the old
    // program at d-16 stays out of the exemption walk.
    const mock = makeMock({
      scheduled_services: [
        { id: 'sd-old', customer_id: 'sdo', service_id: 'svc-excl', status: 'completed', scheduled_date: d(16), service_key: 'rodent_exclusion', follow_up_interval_days: 7 },
        { id: 'sd-open', customer_id: 'sdo', service_id: 'svc-excl', status: 'completed', scheduled_date: d(0), service_key: 'rodent_exclusion', follow_up_interval_days: 7, window_start: '09:00' },
        { id: 'sd-fin', customer_id: 'sdo', service_id: 'svc-trap-fu', status: 'completed', scheduled_date: d(0), service_key: 'rodent_trapping_followup', follow_up_interval_days: 3, window_start: '13:00' },
      ],
      review_sequences: [
        { id: 'seq-sd-old', customer_id: 'sdo', scheduled_service_id: 'sd-old', status: 'completed' },
        { id: 'seq-sd-open', customer_id: 'sdo', scheduled_service_id: 'sd-open', status: 'completed' },
      ],
    });
    db.mockImplementation(mock);
    const exempt = await ReviewService._seriesExemptSequenceIds('sdo', { scheduledServiceId: 'sd-fin' });
    expect(exempt).toContain('seq-sd-open');
    expect(exempt).not.toContain('seq-sd-old');

    // ② A parking-write failure PROPAGATES instead of degrading into
    // already_active with no durable retry.
    const base = makeMock({
      customers: [{ id: 'pw', first_name: 'Al', last_name: 'S', phone: '+19410000070', nearest_location_id: 'bradenton' }],
      scheduled_services: [
        { id: 'pw-1', customer_id: 'pw', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'pw-2', customer_id: 'pw', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [{ id: 'seq-hung2', customer_id: 'pw', scheduled_service_id: 'pw-1', status: 'active', current_step: 0, next_run_at: null, plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
    });
    let armed = false;
    const failInsert = jest.fn((tbl) => {
      const q = base(tbl);
      if (armed && String(tbl) === 'review_sequences') {
        const origInsert = q.insert.bind(q);
        q.insert = (row) => {
          if (row && row.status === 'deferred') throw new Error('pg blip on park');
          return origInsert(row);
        };
      }
      return q;
    });
    failInsert.__state = base.__state;
    db.mockImplementation(failInsert);
    armed = true;
    const prev = ReviewService._SUPERSEDE_RETRY_DELAY_MS;
    ReviewService._SUPERSEDE_RETRY_DELAY_MS = 1;
    let threw = false;
    try {
      await ReviewService.startReviewSequence({
        customerId: 'pw',
        plan: [{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }],
        seriesFinal: true,
        scheduledServiceId: 'pw-2',
      });
    } catch (err) {
      threw = true;
    } finally {
      ReviewService._SUPERSEDE_RETRY_DELAY_MS = prev;
    }
    expect(threw).toBe(true);
  });

  test('r27: a cron claim landing mid-supersession parks the final instead of already_active', async () => {
    mockGates.reviewSequences = true;
    const d = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
    const base = makeMock({
      customers: [{ id: 'mc', first_name: 'Kay', last_name: 'T', phone: '+19410000071', nearest_location_id: 'bradenton' }],
      scheduled_services: [
        { id: 'mc-1', customer_id: 'mc', service_id: 'svc-wt', status: 'completed', scheduled_date: d(2), service_key: 'wildlife_trapping' },
        { id: 'mc-2', customer_id: 'mc', service_id: 'svc-wt', status: 'completed', scheduled_date: d(0), service_key: 'wildlife_trapping', follow_up_interval_days: 1 },
      ],
      review_sequences: [{ id: 'seq-claimrace', customer_id: 'mc', scheduled_service_id: 'mc-1', status: 'active', current_step: 0, next_run_at: new Date(Date.now() + 3600000), plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]) }],
    });
    // Simulate the cron claiming the opener between the proof and the
    // transactional stop: the first review_requests probe (the zero-sent
    // check inside the proof) flips next_run_at to null.
    const claimConn = jest.fn((tbl) => {
      if (String(tbl) === 'review_requests') {
        const opener = base.__state.rows.review_sequences.find((r) => r.id === 'seq-claimrace');
        if (opener && opener.status === 'active') opener.next_run_at = null;
      }
      return base(tbl);
    });
    claimConn.__state = base.__state;
    db.mockImplementation(claimConn);
    const res = await ReviewService.startReviewSequence({
      customerId: 'mc',
      plan: [{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }],
      seriesFinal: true,
      scheduledServiceId: 'mc-2',
    });
    expect(res.reason).toBe('deferred_inflight');
    const parked = base.__state.rows.review_sequences.find((r) => r.status === 'deferred');
    expect(parked).toBeTruthy();
    const opener = base.__state.rows.review_sequences.find((r) => r.id === 'seq-claimrace');
    expect(opener.status).toBe('active');
  });

  test('the first-treatment exemption is scoped to the series-final enrollment (resolver seriesFinal flag)', async () => {
    mockGates.reviewSequences = true;
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    // Final roach visit → seriesFinal:true rides the plan resolution.
    const mock = makeMock({
      service_records: [{ id: 'sr-sf', customer_id: 'sf-1', scheduled_service_id: 'ss-r2' }],
      scheduled_services: [
        { id: 'ss-r1', customer_id: 'sf-1', service_id: 'svc-roach', status: 'completed', scheduled_date: recent, service_key: 'cockroach_control' },
        { id: 'ss-r2', customer_id: 'sf-1', service_id: 'svc-roach', status: 'completed', scheduled_date: today, service_key: 'cockroach_control' },
      ],
    });
    db.mockImplementation(mock);
    const finalVisit = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'sf-1', serviceRecordId: 'sr-sf' });
    expect(finalVisit.seriesFinal).toBe(true);
    expect(finalVisit.plan).toHaveLength(3);

    // Direct visit identity (no service_records row yet) resolves the same.
    const direct = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'sf-1', scheduledServiceId: 'ss-r2' });
    expect(direct.seriesFinal).toBe(true);

    // An unlinked one-time completion resolves WITHOUT the exemption flag —
    // its enrollment counts the first-treatment ask for cap/cooldown.
    const mock2 = makeMock({});
    db.mockImplementation(mock2);
    const unrelated = await ReviewService.resolveSequencePlanForEnrollment({ customerId: 'sf-2' });
    expect(unrelated.seriesFinal).not.toBe(true);
  });

  test('an OVERDUE but still-live follow-up child keeps the series classification (status-only liveness)', async () => {
    mockGates.reviewSequences = true;
    const pastDue = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'od-1', first_name: 'Ben', last_name: 'N', phone: '+19410000054', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-od', customer_id: 'od-1', scheduled_service_id: 'ss-od-src' }],
      scheduled_services: [
        { id: 'ss-od-src', customer_id: 'od-1', status: 'completed', scheduled_date: pastDue },
        // Follow-up was scheduled for 5 days ago and never worked — still live.
        { id: 'ss-od-child', customer_id: 'od-1', followup_source_service_id: 'ss-od-src', status: 'confirmed', scheduled_date: pastDue },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'od-1', serviceRecordId: 'sr-od', completedAt: new Date() });

    expect(result.started).toBe(true);
    const plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');
  });

  test('a forwarded short-template ask (review wording + /l/ short link) triggers the standdown', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'ma-5', first_name: 'Ivy', last_name: 'P', phone: '+19410000055', nearest_location_id: 'bradenton' }],
      sms_log: [{ id: 'sms-5', customer_id: 'ma-5', direction: 'outbound', status: 'sent', message_body: 'Hi Ivy! Just a quick nudge from Waves - that review link one more time: https://portal.wavespestcontrol.com/l/ab12c', created_at: new Date(Date.now() - 2 * 86400000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'ma-5', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('manual_ask_recent');
  });

  test('a second enrollment for the SAME service record is rejected even after the first sequence completed (cap-exempt dedupe)', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'dd-1', first_name: 'Kim', last_name: 'J', phone: '+19410000053', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-dd', customer_id: 'dd-1', scheduled_service_id: 'ss-dd' }],
      scheduled_services: [{ id: 'ss-dd', customer_id: 'dd-1', service_id: 'svc-roach', status: 'completed', scheduled_date: '2026-08-01', service_key: 'cockroach_control' }],
      // The visit-1 one-step sequence already ran to completion — its
      // cap-exempt ask is invisible to cap/cooldown, so only the per-record
      // dedupe stands between the paid-invoice re-enrollment and a
      // duplicate first-treatment text.
      review_sequences: [{ id: 'seq-dd', customer_id: 'dd-1', service_record_id: 'sr-dd', status: 'completed', stop_reason: 'completed', current_step: 1, touches_sent: 1, plan: '[]', started_at: new Date(Date.now() - 3600000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'dd-1', serviceRecordId: 'sr-dd', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('service_record_enrolled');
    expect(mock.__state.rows.review_sequences).toHaveLength(1);
  });

  test('an expired uncertain reservation does not prevent a new cadence enrollment', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'reservation-c', first_name: 'Synthetic', phone: '+12025550101', nearest_location_id: 'bradenton' }],
      sms_log: [{ id: 'reservation-sms', customer_id: 'reservation-c', direction: 'outbound', status: 'sending', message_body: 'Please leave a Google review.', metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 4 * 86400000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'reservation-c', completedAt: new Date() });

    expect(result.started).toBe(true);
    expect(mock.__state.rows.review_sequences).toHaveLength(1);
  });

  test('a hand-sent review ask in the last 30 days stands the cadence down (manual_ask_recent)', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'ma-1', first_name: 'Cat', last_name: 'F', phone: '+19410000046', nearest_location_id: 'bradenton' }],
      sms_log: [{ id: 'sms-1', customer_id: 'ma-1', direction: 'outbound', message_body: 'Loved seeing you today! A quick review here would mean a lot: https://g.page/r/waves-brdn/review', created_at: new Date(Date.now() - 2 * 86400000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'ma-1', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('manual_ask_recent');
    expect(mock.__state.rows.review_sequences).toHaveLength(0);
  });

  test('the pipeline\'s own review SMS does not trigger the manual-ask standdown (time-correlated to a review_requests send)', async () => {
    mockGates.reviewSequences = true;
    const sentAt = new Date(Date.now() - 5 * 86400000); // 5 days ago
    const mock = makeMock({
      customers: [{ id: 'ma-2', first_name: 'Ben', last_name: 'G', phone: '+19410000047', nearest_location_id: 'bradenton' }],
      sms_log: [{ id: 'sms-2', customer_id: 'ma-2', direction: 'outbound', message_body: 'Hi Ben! A quick Google review would help us: https://portal.test/l/abc', created_at: sentAt }],
      review_requests: [{ id: 'rr-corr', customer_id: 'ma-2', template_key: 'friendly_ask', status: 'sent', sms_sent_at: new Date(sentAt.getTime() + 60000), sent_at: new Date(sentAt.getTime() + 60000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'ma-2', completedAt: new Date() });

    // The correlated pipeline send must NOT read as a hand-sent ask — it falls
    // through to the normal 30-day cooldown instead of manual_ask_recent.
    expect(result.started).toBe(false);
    expect(result.reason).toBe('cooldown');
  });

  test('an explicit operator delay wins over the smart send window in cadence mode', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'td-1', first_name: 'Val', last_name: 'N', phone: '+19410000070', nearest_location_id: 'bradenton' }],
    });
    db.mockImplementation(mock);

    const before = Date.now();
    const result = await ReviewService.enrollPostService({ customerId: 'td-1', delayMinutes: 30, legacyDelayMinutes: 120, completedAt: new Date() });

    expect(result.started).toBe(true);
    const scheduled = result.scheduledFor.getTime();
    expect(scheduled).toBeGreaterThanOrEqual(before + 29 * 60000);
    expect(scheduled).toBeLessThanOrEqual(before + 31 * 60000);
  });

  test('paid webhook projections delegate packet ownership before the representative record review policy', async () => {
    const enroll = require('../services/visit-completion-packets').enrollVisitCompletionReviewForInvoice;
    enroll.mockResolvedValueOnce({ enrolled: false, reason: 'member_review_suppressed' });
    const individual = jest.spyOn(ReviewService, 'enrollPostService');
    const result = await ReviewService.enrollForPaidInvoice({ id: 'packet-invoice', customer_id: 'customer-1', service_record_id: 'representative-record' });
    expect(enroll).toHaveBeenCalledWith('packet-invoice');
    expect(individual).not.toHaveBeenCalled();
    expect(result).toEqual({ enrolled: false, reason: 'member_review_suppressed' });
    individual.mockRestore();
  });

  test('enrollForPaidInvoice parses a naive ET reviewScheduledFor as Eastern wall-clock', async () => {
    mockGates.reviewSequences = true;
    // The completion panel posts timezone-less ET ('YYYY-MM-DDTHH:mm'). Build
    // one ~6h out in ET and confirm the schedule lands on the ET instant, not
    // the (4-5h earlier) UTC misread.
    const targetMs = Date.now() + 6 * 3600000;
    const naiveEt = new Date(targetMs).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T').slice(0, 16);
    const mock = makeMock({
      customers: [{ id: 'et-1', first_name: 'Ria', last_name: 'W', phone: '+19410000075', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-et', customer_id: 'et-1', structured_notes: JSON.stringify({ requestReview: true, reviewScheduledFor: naiveEt }) }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.enrollForPaidInvoice({ id: 'inv-et', customer_id: 'et-1', service_record_id: 'sr-et' });

    expect(out.enrolled).toBe(true);
    const runAt = mock.__state.rows.review_sequences[0].next_run_at.getTime();
    expect(Math.abs(runAt - targetMs)).toBeLessThanOrEqual(120000);
  });

  test('enrollForPaidInvoice honors the completion panel timing stored on the service record', async () => {
    mockGates.reviewSequences = true;
    const scheduledAt = new Date(Date.now() + 6 * 3600000).toISOString(); // custom time, 6h out
    const mock = makeMock({
      customers: [{ id: 'pt-1', first_name: 'Iva', last_name: 'S', phone: '+19410000073', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-pt', customer_id: 'pt-1', structured_notes: JSON.stringify({ requestReview: true, visitOutcome: 'completed', reviewScheduledFor: scheduledAt }) }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.enrollForPaidInvoice({ id: 'inv-pt', customer_id: 'pt-1', service_record_id: 'sr-pt' });

    expect(out.enrolled).toBe(true);
    const runAt = mock.__state.rows.review_sequences[0].next_run_at.getTime();
    const target = new Date(scheduledAt).getTime();
    expect(Math.abs(runAt - target)).toBeLessThanOrEqual(90000);

    // An elapsed stored time sends immediately (first cron tick), not never.
    const mock2 = makeMock({
      customers: [{ id: 'pt-2', first_name: 'Ugo', last_name: 'T', phone: '+19410000074', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-pt2', customer_id: 'pt-2', structured_notes: JSON.stringify({ requestReview: true, reviewDelayMinutes: 0 }) }],
    });
    db.mockImplementation(mock2);
    const before = Date.now();
    const out2 = await ReviewService.enrollForPaidInvoice({ id: 'inv-pt2', customer_id: 'pt-2', service_record_id: 'sr-pt2' });
    expect(out2.enrolled).toBe(true);
    const runAt2 = mock2.__state.rows.review_sequences[0].next_run_at.getTime();
    expect(runAt2).toBeLessThanOrEqual(before + 60000 + 5000);
  });

  test('enrollForPaidInvoice enrolls a completion invoice and honors the completion opt-out', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'pi-1', first_name: 'Ned', last_name: 'C', phone: '+19410000071', nearest_location_id: 'venice' }],
      service_records: [{ id: 'sr-pi', customer_id: 'pi-1', structured_notes: JSON.stringify({ requestReview: true, visitOutcome: 'completed' }) }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.enrollForPaidInvoice({ id: 'inv-pi', customer_id: 'pi-1', service_record_id: 'sr-pi', invoice_number: 'WPC-1' }, { source: 'record_payment' });
    expect(out.enrolled).toBe(true);
    expect(mock.__state.rows.review_sequences).toHaveLength(1);

    // Opt-out recorded at completion blocks it.
    const mock2 = makeMock({
      customers: [{ id: 'pi-2', first_name: 'Oli', last_name: 'D', phone: '+19410000072', nearest_location_id: 'venice' }],
      service_records: [{ id: 'sr-pi2', customer_id: 'pi-2', structured_notes: JSON.stringify({ requestReview: false }) }],
    });
    db.mockImplementation(mock2);
    const out2 = await ReviewService.enrollForPaidInvoice({ id: 'inv-pi2', customer_id: 'pi-2', service_record_id: 'sr-pi2' });
    expect(out2).toEqual({ enrolled: false, reason: 'completion_opted_out' });
    expect(mock2.__state.rows.review_sequences).toHaveLength(0);

    // Standalone invoices (no service record) are a no-op here.
    const out3 = await ReviewService.enrollForPaidInvoice({ id: 'inv-pi3', customer_id: 'pi-2', service_record_id: null });
    expect(out3).toEqual({ enrolled: false, reason: 'not_completion_invoice' });
  });

  test('a cadence touch recovers technician_id + service_date from the service record (rate-page context)', async () => {
    const svcDate = '2026-07-27';
    const mock = makeMock({
      customers: [{ id: 'vc-1', first_name: 'Kim', last_name: 'H', phone: '+19410000050', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-1', customer_id: 'vc-1', service_type: 'Quarterly Pest Control', service_date: svcDate, technician_id: 'tech-7', scheduled_service_id: null }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'vc-1', serviceRecordId: 'sr-1', serviceType: 'Quarterly Pest Control', techName: 'Adam', startedBy: 'admin-1' });

    expect(result.started).toBe(true);
    const touch = mock.__state.rows.review_requests[0];
    expect(touch.technician_id).toBe('tech-7');
    expect(touch.service_date).toBe(svcDate);
    expect(touch.service_record_id).toBe('sr-1');
  });

  test('a step overdue by more than 7 days (gate toggled off/on) retires as stale instead of firing', async () => {
    const mock = makeMock({
      customers: [{ id: 'st-1', first_name: 'Ana', last_name: 'F', phone: '+19410000080', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-st', customer_id: 'st-1', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        // Due 10 days ago — the cron was frozen (gate off) and just came back.
        started_at: new Date(Date.now() - 13 * 86400000), next_run_at: new Date(Date.now() - 10 * 86400000),
      }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('stale');
  });

  test('a first touch legitimately scheduled ~30 days out fires when just-due (not stale)', async () => {
    const mock = makeMock({
      customers: [{ id: 'st-2', first_name: 'Bo', last_name: 'K', phone: '+19410000082', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-st2', customer_id: 'st-2', status: 'active', current_step: 0, touches_sent: 0,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
        // Operator scheduled the start 30 days out; it just came due.
        started_at: new Date(Date.now() - 30 * 86400000), next_run_at: new Date(Date.now() - 120000),
      }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mock.__state.rows.review_sequences[0].status).toBe('completed');
  });

  // codex #4338 P1, round 2: an uncertain provider handoff on a cadence step
  // used to fall into the generic deferred/transient branch, which reschedules
  // next_run_at +30 minutes — so the NEXT processReviewSequences tick re-ran
  // this same step and sent a second text. The sequence must hold instead.
  test('an uncertain provider handoff on a cadence step holds the whole sequence — no 30-minute reschedule, no second send', async () => {
    const mock = makeMock({
      customers: [{ id: 'unc-1', first_name: 'Uma', last_name: 'N', phone: '+19410000090', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-unc', customer_id: 'unc-1', status: 'active', current_step: 0, touches_sent: 0,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
        started_at: new Date(Date.now() - 60000), next_run_at: new Date(Date.now() - 60000),
      }],
    });
    db.mockImplementation(mock);
    mockSendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE' });

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(0);
    expect(out.stopped).toBe(0);
    expect(out.completed).toBe(0);
    const seq = mock.__state.rows.review_sequences[0];
    expect(seq.status).toBe('active'); // held, not stopped — an operator/later evidence can still resolve it
    expect(seq.current_step).toBe(0); // not advanced
    expect(seq.next_run_at).toBeNull(); // NOT rescheduled — the due-sweep will never re-pick this row
    expect(JSON.parse(seq.decision).reason).toBe('provider_outcome_uncertain');

    // A second cron tick must not re-send: with next_run_at null, this row
    // never re-enters the due query in the first place.
    mockSendCustomerMessage.mockClear();
    const out2 = await ReviewService.processReviewSequences();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out2.sent).toBe(0);
  });

  // codex #4338 P1, round 2: sendCustomerMessage can throw AFTER the provider
  // handoff (audit-persistence failure) instead of returning. _sendOutreachSms's
  // old catch retried blind on ANY throw; this proves the thrown case reaches
  // the SAME sequence-hold behavior as a returned uncertain result above.
  test('an uncertain provider handoff THROWN (not returned) also holds the sequence, end to end', async () => {
    const mock = makeMock({
      customers: [{ id: 'unc-2', first_name: 'Vic', last_name: 'N', phone: '+19410000091', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-unc2', customer_id: 'unc-2', status: 'active', current_step: 0, touches_sent: 0,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
        started_at: new Date(Date.now() - 60000), next_run_at: new Date(Date.now() - 60000),
      }],
    });
    db.mockImplementation(mock);
    mockSendCustomerMessage.mockImplementationOnce(() => {
      throw Object.assign(new Error('audit write failed'), {
        providerOutcome: { sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE' },
      });
    });

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(0);
    const seq = mock.__state.rows.review_sequences[0];
    expect(seq.status).toBe('active');
    expect(seq.next_run_at).toBeNull();
    expect(JSON.parse(seq.decision).reason).toBe('provider_outcome_uncertain');
    const req = mock.__state.rows.review_requests.find((r) => r.sequence_id === 'seq-unc2');
    expect(req.status).toBe('deferred');
  });

  // codex #4338 P1, round 3: a RETURNED uncertain result whose OWN
  // deferred-status DB write then fails used to be caught by
  // _sendOutreachSms's bookkeeping catch, which only special-cased
  // result.sent and fell back to `retryable: true` for everything else —
  // losing the known-uncertain marker and letting _runSequenceStep
  // reschedule a step whose send may already have landed.
  test('a bookkeeping failure on the deferred-status write still surfaces as uncertain, not a blind retryable', async () => {
    const mock = makeMock({
      customers: [{ id: 'unc-3', first_name: 'Wes', last_name: 'N', phone: '+19410000092', nearest_location_id: 'bradenton' }],
    }, {
      onUpdate: (table, patch) => {
        if (table === 'review_requests' && patch.status === 'deferred') throw new Error('pg blip on deferred-status write');
      },
    });
    db.mockImplementation(mock);
    mockSendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', auditLogId: 'audit-unc3',
    });

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'friendly_ask', manageRetryVia: 'sequence',
    });

    expect(out.ok).toBe(false);
    expect(out.uncertain).toBe(true);
    expect(out.deferred).toBe(true);
    expect(out.retryable).toBeUndefined(); // never the generic bookkeeping_failed shape
  });

  test('an ask delivered outside the sequence (legacy path while gate was off) supersedes the cadence', async () => {
    const mock = makeMock({
      customers: [{ id: 'sp-1', first_name: 'Eli', last_name: 'G', phone: '+19410000081', nearest_location_id: 'venice' }],
      review_sequences: [{
        id: 'seq-sp', customer_id: 'sp-1', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 5 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
      review_requests: [
        // The cadence's own touch — must NOT count as external.
        { id: 'rr-own', sequence_id: 'seq-sp', customer_id: 'sp-1', channel: 'sms', sms_sent_at: new Date(Date.now() - 5 * 86400000), created_at: new Date(Date.now() - 5 * 86400000) },
        // A legacy one-off ask delivered yesterday (no sequence linkage).
        { id: 'rr-ext', sequence_id: null, customer_id: 'sp-1', channel: 'sms', sms_sent_at: new Date(Date.now() - 86400000), created_at: new Date(Date.now() - 86400000) },
      ],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('superseded');
  });

  // A sequence sitting at its Day-4 reminder (step 1), Day-0 already sent 4
  // days ago — the drafter's remaining home after the Day-0 touch became
  // controlled composition (owner decision 2026-09-07).
  function reminderStepFixture(id, customer, extra = {}) {
    return {
      customers: [customer],
      review_sequences: [{
        id, customer_id: customer.id, status: 'active', current_step: 1, touches_sent: 1, service_type: 'pest control', tech_name: 'Adam',
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'day0_ask' }, { day: 4, channel: 'sms', templateKey: 'soft_reminder' }]),
        started_at: new Date(Date.now() - 4 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
      review_requests: [
        { id: `${id}-day0`, sequence_id: id, sequence_step: 0, customer_id: customer.id, channel: 'sms', template_key: 'day0_ask', status: 'sent', sms_sent_at: new Date(Date.now() - 4 * 86400000), created_at: new Date(Date.now() - 4 * 86400000) },
        ...(extra.review_requests || []),
      ],
    };
  }

  test('a personalized draft becomes the Day-4 reminder body (persisted as custom_body, link substituted)', async () => {
    const draft = 'Hi Stan, Adam here — hope the ants are staying gone after Tuesday. If we earned it: {review_url}. Anything off, just reply here.';
    mockDraftAskBody.mockResolvedValue(draft);
    const mock = makeMock(reminderStepFixture('seq-pd1', { id: 'pd-1', first_name: 'Stan', last_name: 'Q', phone: '+19410000040', nearest_location_id: 'bradenton' }));
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    expect(mockDraftAskBody).toHaveBeenCalledWith(expect.objectContaining({ serviceType: 'pest control', techName: 'Adam', recipientFirstName: 'Stan', sequenceStep: 1 }));
    const touch = mock.__state.rows.review_requests.find((r) => r.sequence_step === 1);
    expect(touch.custom_body).toBe(draft);
    // Personalized provenance: the outreach funnel groups by template_key, so
    // a drafted touch must not be credited to the control template.
    expect(touch.template_key).toBe('soft_reminder_personalized');
    // The sent SMS is the draft with {review_url} resolved to the tokenized link.
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).toContain('hope the ants are staying gone after Tuesday');
    expect(sentBody).toContain(`https://portal.test/rate/${touch.token}`);
    expect(sentBody).not.toContain('{review_url}');
  });

  test('a rejected/failed draft falls back to the standard template (reminder still sends)', async () => {
    mockDraftAskBody.mockResolvedValue(null);
    const mock = makeMock(reminderStepFixture('seq-pd2', { id: 'pd-2', first_name: 'Ada', last_name: 'V', phone: '+19410000041', nearest_location_id: 'venice' }));
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    const touch = mock.__state.rows.review_requests.find((r) => r.sequence_step === 1);
    expect(touch.custom_body == null).toBe(true);
    expect(touch.template_key).toBe('soft_reminder');
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).toContain('quick nudge from Waves'); // soft_reminder template copy
  });

  describe('controlled Day-0 composition (owner decision 2026-09-07)', () => {
    const { countSegments } = require('../services/messaging/segment-counter');
    const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
    const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');

    test('the Day-0 SMS is composed from verified fields — never the drafter, no "today", one segment as sent', async () => {
      mockDraftAskBody.mockResolvedValue('SHOULD NOT BE USED {review_url}');
      const mock = makeMock({
        customers: [{ id: 'd0-1', first_name: 'Christopher2', last_name: 'K', phone: '+19410000090', nearest_location_id: 'bradenton' }],
      });
      db.mockImplementation(mock);

      const result = await ReviewService.startReviewSequence({ customerId: 'd0-1', serviceType: 'Quarterly Pest Control', techName: 'Christopher Adams', startedBy: 'admin-1' });

      expect(result.started).toBe(true);
      expect(mockDraftAskBody).not.toHaveBeenCalled();
      const touch = mock.__state.rows.review_requests[0];
      expect(touch.template_key).toBe('day0_ask');
      expect(touch.custom_body == null).toBe(true);
      const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
      expect(sentBody).toBe(`Hi Christopher2! Christopher with Waves. If we earned it, a Google review means a lot: https://portal.test/rate/${touch.token} Reply if anything's off.`);
      expect(sentBody).not.toMatch(/\btoday\b|\btonight\b|\bthis morning\b/i);
      // As sent: scheme stripped at the Twilio boundary, GSM-normalized.
      const seg = countSegments(normalizeGsmPunctuation(stripSmsUrlScheme(sentBody.replace(`https://portal.test/rate/${touch.token}`, 'https://portal.wavespestcontrol.com/l/abcde'))));
      expect(seg).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
    });

    test('no technician on the record → the company signs, never "Your tech with Waves"', async () => {
      const mock = makeMock({
        customers: [{ id: 'd0-2', first_name: 'Mae', last_name: 'R', phone: '+19410000091', nearest_location_id: 'venice' }],
      });
      db.mockImplementation(mock);

      const result = await ReviewService.startReviewSequence({ customerId: 'd0-2', serviceType: 'pest control', startedBy: 'admin-1' });

      expect(result.started).toBe(true);
      const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
      expect(sentBody).toContain('Hi Mae! Waves Pest Control. If we earned it');
      expect(sentBody).not.toContain('Your tech');
    });

    test('a plan persisted before the change (friendly_ask at step 0) gets the controlled body too', async () => {
      mockDraftAskBody.mockResolvedValue('SHOULD NOT BE USED {review_url}');
      const mock = makeMock({
        customers: [{ id: 'd0-3', first_name: 'Robin', last_name: 'T', phone: '+19410000092', nearest_location_id: 'bradenton' }],
        review_sequences: [{
          id: 'seq-d03', customer_id: 'd0-3', status: 'active', current_step: 0, touches_sent: 0, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
          started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000),
        }],
      });
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
      expect(mockDraftAskBody).not.toHaveBeenCalled();
      const touch = mock.__state.rows.review_requests[0];
      expect(touch.template_key).toBe('day0_ask');
      expect(mockSendCustomerMessage.mock.calls[0][0].body).toContain('Hi Robin! Adam with Waves.');
    });

    test('a Day-0 draft persisted by an earlier deferred attempt is NOT reused — the controlled body sends', async () => {
      // Prod case 2026-08-25: drafted "Thanks for having us out today" at 8 PM,
      // held by quiet hours, sent verbatim at 8 AM the next day.
      const staleDraft = 'Thanks for having us out today, Robin! Mind leaving a review? {review_url}';
      const mock = makeMock({
        customers: [{ id: 'd0-4', first_name: 'Robin', last_name: 'T', phone: '+19410000093', nearest_location_id: 'bradenton' }],
        review_sequences: [{
          id: 'seq-d04', customer_id: 'd0-4', status: 'active', current_step: 0, touches_sent: 0, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
          started_at: new Date(Date.now() - 12 * 3600000), next_run_at: new Date(Date.now() - 60000),
        }],
        review_requests: [{ id: 'rr-d04', sequence_id: 'seq-d04', sequence_step: 0, customer_id: 'd0-4', channel: 'sms', template_key: 'friendly_ask_personalized', custom_body: staleDraft, status: 'deferred', created_at: new Date(Date.now() - 12 * 3600000) }],
      });
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
      const retry = mock.__state.rows.review_requests.find((r) => r.id !== 'rr-d04');
      expect(retry.custom_body == null).toBe(true);
      expect(retry.template_key).toBe('day0_ask');
      const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
      expect(sentBody).not.toContain('today');
      expect(sentBody).toContain('Hi Robin! Adam with Waves.');
    });

    test('the multi-treatment first-visit ask keeps its own template', async () => {
      const mock = makeMock({
        customers: [{ id: 'd0-5', first_name: 'Ken', last_name: 'T', phone: '+19410000094', nearest_location_id: 'venice' }],
        review_sequences: [{
          id: 'seq-d05', customer_id: 'd0-5', status: 'active', current_step: 0, touches_sent: 0, tech_name: 'Adam',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'first_treatment_ask' }]),
          started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000),
        }],
      });
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
      expect(mock.__state.rows.review_requests[0].template_key).toBe('first_treatment_ask');
      expect(mockSendCustomerMessage.mock.calls[0][0].body).toContain("First treatment's done");
    });

    test('a quiet-hours retry through sendSMS signs the Day-0 ask the same way: first name with Waves, else the company (codex #4139 r1)', async () => {
      const mock = makeMock({
        customers: [
          { id: 'd0-6', first_name: 'Lee', last_name: 'P', phone: '+19410000095', nearest_location_id: 'venice' },
          { id: 'd0-7', first_name: 'Kim', last_name: 'P', phone: '+19410000096', nearest_location_id: 'venice' },
        ],
        review_requests: [
          { id: 'rr-d06', customer_id: 'd0-6', channel: 'sms', status: 'pending', template_key: 'day0_ask', tech_name: 'Christopher Longname', token: 'tok-d06', location_id: 'venice' },
          { id: 'rr-d07', customer_id: 'd0-7', channel: 'sms', status: 'pending', template_key: 'day0_ask', tech_name: null, token: 'tok-d07', location_id: 'venice' },
        ],
      });
      db.mockImplementation(mock);

      await ReviewService.sendSMS('rr-d06');
      await ReviewService.sendSMS('rr-d07');

      const bodies = mockSendCustomerMessage.mock.calls.map((c) => c[0].body);
      expect(bodies[0]).toContain('Hi Lee! Christopher with Waves.');
      expect(bodies[0]).not.toContain('Longname');
      expect(bodies[1]).toContain('Hi Kim! Waves Pest Control.');
      expect(bodies[1]).not.toContain('Our team');
    });

    // codex #4338 P1, round 2: sendSMS's catch only handled a thrown pre-handoff
    // failure (network down, safe to retry). sendCustomerMessage can ALSO throw
    // AFTER the provider handoff (audit-persistence failure), attaching
    // err.providerOutcome — the old catch retried blind either way, risking a
    // duplicate text for an accepted-but-unaudited send, or for an uncertain one.
    test('sendSMS on a RETURNED accepted result whose sent stamp throws stays fenced, never re-dued (codex #4338 P1, round 4)', async () => {
      const due = new Date(Date.now() - 60000);
      const mock = makeMock({
        customers: [{ id: 'th-5', first_name: 'Ada', last_name: 'Q', phone: '+19410000105', nearest_location_id: 'venice' }],
        review_requests: [
          { id: 'rr-th5', customer_id: 'th-5', channel: 'sms', status: 'pending', template_key: 'day0_ask', token: 'tok-th5', location_id: 'venice', scheduled_for: due },
        ],
      }, {
        onUpdate: (table, patch) => {
          if (table === 'review_requests' && patch.status === 'sent') throw new Error('pg blip on sent stamp');
        },
      });
      db.mockImplementation(mock);
      mockSendCustomerMessage.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-th5', auditLogId: 'audit-th5' });

      const out = await ReviewService.sendSMS('rr-th5');

      expect(out).toEqual({ sent: true, unrecorded: true });
      const row = mock.__state.rows.review_requests[0];
      expect(row.status).toBe('pending');
      // Never the generic 5-minute retry: the pre-send fence holds.
      expect(row.scheduled_for.getTime()).toBeGreaterThan(Date.now() + 71 * 3600000);
    });

    test('sendSMS on a thrown ACCEPTED post-handoff error marks the row sent, never retries', async () => {
      const mock = makeMock({
        customers: [{ id: 'th-1', first_name: 'Rae', last_name: 'Q', phone: '+19410000097', nearest_location_id: 'venice' }],
        review_requests: [
          { id: 'rr-th1', customer_id: 'th-1', channel: 'sms', status: 'pending', template_key: 'day0_ask', token: 'tok-th1', location_id: 'venice' },
        ],
      });
      db.mockImplementation(mock);
      mockSendCustomerMessage.mockImplementationOnce(() => {
        throw Object.assign(new Error('audit write failed'), {
          providerOutcome: { sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-th1' },
        });
      });

      await ReviewService.sendSMS('rr-th1');

      const row = mock.__state.rows.review_requests[0];
      expect(row.status).toBe('sent');
      expect(row.sms_sent_at).toBeTruthy();
      expect(row.scheduled_for == null).toBe(true); // never queued for a retry that would duplicate the text (fence restored)
    });

    test('sendSMS on a thrown UNCERTAIN post-handoff error holds the row, never retries', async () => {
      const mock = makeMock({
        customers: [{ id: 'th-2', first_name: 'Sam', last_name: 'Q', phone: '+19410000098', nearest_location_id: 'venice' }],
        review_requests: [
          { id: 'rr-th2', customer_id: 'th-2', channel: 'sms', status: 'pending', template_key: 'day0_ask', token: 'tok-th2', location_id: 'venice' },
        ],
      });
      db.mockImplementation(mock);
      mockSendCustomerMessage.mockImplementationOnce(() => {
        throw Object.assign(new Error('audit write failed'), {
          providerOutcome: { sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE' },
        });
      });

      await ReviewService.sendSMS('rr-th2');

      const row = mock.__state.rows.review_requests[0];
      expect(row.status).toBe('deferred'); // held — processScheduled only picks status='pending'
      expect(row.scheduled_for == null).toBe(true); // never queued for a retry that could duplicate the text (fence restored)
    });

    // codex #4338 P1, round 3: a RETURNED uncertain result whose own
    // deferred-status DB write then fails used to let that write's exception
    // reach the generic 5-minute retry queue — the known ambiguous outcome
    // was lost the moment the bookkeeping call itself failed.
    test('sendSMS on a RETURNED uncertain result whose deferred-status write fails still never queues a retry', async () => {
      const mock = makeMock({
        customers: [{ id: 'th-4', first_name: 'Uri', last_name: 'Q', phone: '+19410000100', nearest_location_id: 'venice' }],
        review_requests: [
          { id: 'rr-th4', customer_id: 'th-4', channel: 'sms', status: 'pending', template_key: 'day0_ask', token: 'tok-th4', location_id: 'venice' },
        ],
      }, {
        onUpdate: (table, patch) => {
          if (table === 'review_requests' && patch.status === 'deferred') throw new Error('pg blip on deferred-status write');
        },
      });
      db.mockImplementation(mock);
      mockSendCustomerMessage.mockResolvedValueOnce({
        sent: false, blocked: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', auditLogId: 'audit-th4',
      });

      await ReviewService.sendSMS('rr-th4');

      const row = mock.__state.rows.review_requests[0];
      // The write failed, so status could not flip to 'deferred' — but the
      // row must never become DUE: the pre-send fence (codex #4338 P1, round
      // 4) pushed scheduled_for past the spacing window before the provider
      // call, so processScheduled (scheduled_for <= now) cannot resend a text
      // the customer may already hold.
      expect(row.status).toBe('pending');
      expect(row.scheduled_for.getTime()).toBeGreaterThan(Date.now() + 71 * 3600000);
    });

    test('sendSMS on an ordinary pre-handoff throw (no providerOutcome) still retries exactly as before', async () => {
      const mock = makeMock({
        customers: [{ id: 'th-3', first_name: 'Tia', last_name: 'Q', phone: '+19410000099', nearest_location_id: 'venice' }],
        review_requests: [
          { id: 'rr-th3', customer_id: 'th-3', channel: 'sms', status: 'pending', template_key: 'day0_ask', token: 'tok-th3', location_id: 'venice' },
        ],
      });
      db.mockImplementation(mock);
      mockSendCustomerMessage.mockImplementationOnce(() => { throw new Error('network down'); });

      await ReviewService.sendSMS('rr-th3');

      const row = mock.__state.rows.review_requests[0];
      expect(row.status).toBe('pending'); // unchanged
      expect(row.scheduled_for).toBeTruthy(); // queued for the cron's 5-minute retry
    });

    test('a record-scoped enrollment signs with the linked visit\'s technician, never a newer visit\'s (codex #4139 r2)', async () => {
      const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      const mock = makeMock({
        customers: [{ id: 'd0-9', first_name: 'Ivy', last_name: 'P', phone: '+19410000098', nearest_location_id: 'venice' }],
        service_records: [{ id: 'sr-d09', customer_id: 'd0-9', scheduled_service_id: 'ss-d09-old' }],
        // tech_name rides the visit rows (the mock's leftJoin is a no-op).
        scheduled_services: [
          { id: 'ss-d09-old', customer_id: 'd0-9', status: 'completed', scheduled_date: d(30), service_type: 'pest control', technician_id: 'tech-a', tech_name: 'Older Tech' },
          { id: 'ss-d09-new', customer_id: 'd0-9', status: 'completed', scheduled_date: d(1), service_type: 'pest control', technician_id: 'tech-b', tech_name: 'Newer Tech' },
        ],
        technicians: [{ id: 'tech-a', name: 'Older Tech' }, { id: 'tech-b', name: 'Newer Tech' }],
      });
      db.mockImplementation(mock);

      const result = await ReviewService.startReviewSequence({ customerId: 'd0-9', serviceRecordId: 'sr-d09', startedBy: 'invoice' });

      expect(result.started).toBe(true);
      expect(mock.__state.rows.review_sequences[0].tech_name).toBe('Older Tech');
      expect(mockSendCustomerMessage.mock.calls[0][0].body).toContain('Hi Ivy! Older with Waves.');
    });

    test('a cadence touch signs with the record\'s technician even when the sequence cached another name (codex #4139 r3)', async () => {
      const mock = makeMock({
        customers: [{ id: 'd0-10', first_name: 'Uma', last_name: 'P', phone: '+19410000099', nearest_location_id: 'venice' }],
        service_records: [{ id: 'sr-d10', customer_id: 'd0-10', technician_id: 'tech-a', service_type: 'pest control', service_date: '2026-09-01' }],
        technicians: [{ id: 'tech-a', name: 'Older Tech' }, { id: 'tech-b', name: 'Newer Tech' }],
        review_sequences: [{
          id: 'seq-d10', customer_id: 'd0-10', status: 'active', current_step: 0, touches_sent: 0,
          // Enrolled before the deployment: the cache holds a newer visit's tech.
          tech_name: 'Newer Tech', service_record_id: 'sr-d10',
          plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
          started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000),
        }],
      });
      db.mockImplementation(mock);

      const out = await ReviewService.processReviewSequences();

      expect(out.sent).toBe(1);
      expect(mockSendCustomerMessage.mock.calls[0][0].body).toContain('Hi Uma! Older with Waves.');
    });

    test('a drawer send with no techName resolves the technician from the latest completed visit (codex #4139 r1)', async () => {
      const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      const mock = makeMock({
        customers: [{ id: 'd0-8', first_name: 'Ora', last_name: 'P', phone: '+19410000097', nearest_location_id: 'venice' }],
        // The mock's leftJoin is a no-op, so the technician's name rides the
        // visit row under the joined alias.
        scheduled_services: [{ id: 'ss-d08', customer_id: 'd0-8', status: 'completed', scheduled_date: d(1), service_type: 'pest control', technician_id: 'tech-9', tech_name: 'Christopher Longname' }],
        technicians: [{ id: 'tech-9', name: 'Christopher Longname' }],
      });
      db.mockImplementation(mock);

      const result = await ReviewService.sendGatedAsk({ customerId: 'd0-8', channel: 'sms', templateId: 'day0_ask', triggeredBy: 'admin' });

      expect(result.outcome).toBe('sent');
      expect(mockSendCustomerMessage.mock.calls[0][0].body).toContain('Hi Ora! Christopher with Waves.');
    });
  });

  test('a one-off send (no sequence) NEVER drafts — the operator template is exactly what sends', async () => {
    mockDraftAskBody.mockResolvedValue('SHOULD NOT BE USED {review_url}');
    const mock = makeMock({
      customers: [{ id: 'oo-1', first_name: 'Ben', last_name: 'Z', phone: '+19410000060', nearest_location_id: 'bradenton' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'sms',
      templateId: 'friendly_ask',
      triggeredBy: 'admin',
    });

    expect(out.ok).toBe(true);
    expect(mockDraftAskBody).not.toHaveBeenCalled();
    const touch = mock.__state.rows.review_requests[0];
    expect(touch.custom_body == null).toBe(true);
    expect(touch.template_key).toBe('friendly_ask');
  });

  test('a retried reminder step reuses the previously persisted draft instead of re-drafting', async () => {
    const priorDraft = 'Hi Stan, hope the ants stayed gone. If we earned it: {review_url}. Anything off, just reply here.';
    const mock = makeMock(reminderStepFixture('seq-rt', { id: 'rt-1', first_name: 'Stan', last_name: 'P', phone: '+19410000061', nearest_location_id: 'bradenton' }, {
      // A prior attempt already drafted + persisted for this step (send deferred).
      review_requests: [{ id: 'rr-rt', sequence_id: 'seq-rt', sequence_step: 1, customer_id: 'rt-1', channel: 'sms', custom_body: priorDraft, status: 'deferred', created_at: new Date(Date.now() - 1800000) }],
    }));
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    expect(mockDraftAskBody).not.toHaveBeenCalled();
    const retry = mock.__state.rows.review_requests.find((r) => r.sequence_step === 1 && r.id !== 'rr-rt');
    expect(retry.custom_body).toBe(priorDraft);
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).toContain('hope the ants stayed gone');
  });

  test('a retry does NOT reuse a persisted draft when the recipient is no longer the account holder', async () => {
    const priorDraft = 'Hi Stan, hope the ants stayed gone. If we earned it: {review_url}. Anything off, just reply here.';
    const mock = makeMock(reminderStepFixture('seq-rc', {
      // SMS now routes to a service contact whose phone differs from the
      // account holder's — the account-holder draft must NOT follow them.
      id: 'rc-1', first_name: 'Stan', last_name: 'P', phone: '+19410000061', service_contact_phone: '+19419999999', nearest_location_id: 'bradenton',
    }, {
      review_requests: [{ id: 'rr-rc', sequence_id: 'seq-rc', sequence_step: 1, customer_id: 'rc-1', channel: 'sms', custom_body: priorDraft, status: 'deferred', created_at: new Date(Date.now() - 1800000) }],
    }));
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    expect(mockDraftAskBody).not.toHaveBeenCalled();
    const retry = mock.__state.rows.review_requests.find((r) => r.sequence_step === 1 && r.id !== 'rr-rc');
    expect(retry.custom_body == null).toBe(true);
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).not.toContain('hope the ants stayed gone');
    expect(sentBody).toContain('quick nudge from Waves'); // soft_reminder template
  });

  test('a scheduled-but-never-sent review-looking SMS does not trigger the manual-ask standdown', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'ma-3', first_name: 'Joy', last_name: 'H', phone: '+19410000049', nearest_location_id: 'bradenton' }],
      sms_log: [{ id: 'sms-3', customer_id: 'ma-3', direction: 'outbound', status: 'scheduled', message_body: 'review us: https://g.page/r/waves/review', created_at: new Date(Date.now() - 86400000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'ma-3', completedAt: new Date() });

    expect(result.started).toBe(true);
  });

  test('a manual ask sent AFTER enrollment stops the cadence at the next touch (manual_ask_recent)', async () => {
    const startedAt = new Date(Date.now() - 3 * 86400000);
    const mock = makeMock({
      customers: [{ id: 'ma-4', first_name: 'Ana', last_name: 'K', phone: '+19410000050', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-ma', customer_id: 'ma-4', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 4, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true }]),
        started_at: startedAt, next_run_at: new Date(Date.now() - 60000),
      }],
      // Owner hand-sent an ask a day after enrollment — no correlated
      // review_requests send within ±10 min.
      sms_log: [{ id: 'sms-4', customer_id: 'ma-4', direction: 'outbound', status: 'sent', message_body: 'Hey Ana, would love a Google review: https://g.page/r/waves/review', created_at: new Date(startedAt.getTime() + 86400000) }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('manual_ask_recent');
  });

  test('a reservation opened just before enrollment but confirmed sent afterward still retires the cadence (codex review-request.js:1476 P1)', async () => {
    const startedAt = new Date(Date.now() - 3 * 86400000);
    // Communications opened the reservation moments before post-service
    // enrollment ran — includeReservations: false missed it there because
    // it was still 'sending'. The provider then confirmed delivery a
    // moment AFTER the sequence started; the reservation's created_at
    // still predates started_at (the placeholder is opened before the
    // send), but its confirmation (updated_at) does not.
    const reservedAt = new Date(startedAt.getTime() - 30000);
    const confirmedAt = new Date(startedAt.getTime() + 45000);
    const mock = makeMock({
      customers: [{ id: 'ma-5', first_name: 'Reserved', last_name: 'K', phone: '+19410000051', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-ma-reserve', customer_id: 'ma-5', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 4, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true }]),
        started_at: startedAt, next_run_at: new Date(Date.now() - 60000),
      }],
      sms_log: [{
        id: 'sms-5', customer_id: 'ma-5', direction: 'outbound', status: 'sent',
        message_body: 'https://wavespest.co/l/abc123', metadata: { review_ask_reservation: true },
        created_at: reservedAt, updated_at: confirmedAt,
      }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('manual_ask_recent');
  });

  test('a booked follow-up child via followup_source_service_id drives the multi-treatment plans (canonical CTA linkage)', async () => {
    mockGates.reviewSequences = true;
    const future = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'fs-1', first_name: 'Max', last_name: 'V', phone: '+19410000051', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-fs1', customer_id: 'fs-1', scheduled_service_id: 'ss-src' }],
      scheduled_services: [
        { id: 'ss-src', customer_id: 'fs-1', status: 'completed', scheduled_date: '2026-08-01' },
        { id: 'ss-inc', customer_id: 'fs-1', followup_source_service_id: 'ss-src', status: 'confirmed', scheduled_date: future },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'fs-1', serviceRecordId: 'sr-fs1', completedAt: new Date() });

    expect(result.started).toBe(true);
    const plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');
  });

  test('an email-resolved first-treatment ask keeps its cap-exempt provenance (first_treatment_ask_email)', async () => {
    const mock = makeMock({
      customers: [{ id: 'fe-1', first_name: 'Lea', last_name: 'B', phone: '+19410000052', email: 'x@y.com', nearest_location_id: 'bradenton' }],
      notification_prefs: [{ customer_id: 'fe-1', review_request: true, sms_enabled: true, email_enabled: true, review_request_channel: 'email' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'sms', templateId: 'first_treatment_ask',
      sequenceId: 'seq-fe', sequenceStep: 0, manageRetryVia: 'sequence',
    });

    expect(out.ok).toBe(true);
    expect(out.channel).toBe('email');
    expect(mock.__state.rows.review_requests[0].template_key).toBe('first_treatment_ask_email');
  });

  test('a cadence stops with reason "clicked" once a touch was redirected to Google (direct-link engagement)', async () => {
    const mock = makeMock({
      customers: [{ id: 'cl-1', first_name: 'Ivy', last_name: 'W', phone: '+19410000034', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-cl', customer_id: 'cl-1', status: 'active', current_step: 1, touches_sent: 1,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }, { day: 3, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true }]),
        started_at: new Date(Date.now() - 3 * 86400000), next_run_at: new Date(Date.now() - 60000),
      }],
      review_requests: [{ id: 'rr-cl', sequence_id: 'seq-cl', customer_id: 'cl-1', channel: 'sms', sms_sent_at: new Date(Date.now() - 3 * 86400000), redirected_at: new Date(Date.now() - 2 * 86400000), redirected_to_google: true }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(out.stopped).toBe(1);
    expect(mock.__state.rows.review_sequences[0].stop_reason).toBe('clicked');
  });
});

describe('codex #3235 r6 — series correlation + personalization gating', () => {
  test('another series\' first-treatment ask still counts: cross-series final enrollment inside 30d is cooldown-blocked', async () => {
    mockGates.reviewSequences = true;
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    const recent = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'xs-1', first_name: 'Amy', last_name: 'T', phone: '+19410000060', nearest_location_id: 'bradenton' }],
      // Series A (bed bug) delivered its cap-exempt first ask 10 days ago.
      review_sequences: [{ id: 'seq-A', customer_id: 'xs-1', service_record_id: 'sr-A1', status: 'completed', stop_reason: 'completed', plan: '[]', started_at: tenDaysAgo }],
      review_requests: [{ id: 'rr-A', customer_id: 'xs-1', sequence_id: 'seq-A', template_key: 'first_treatment_ask', channel: 'sms', status: 'sent', sms_sent_at: tenDaysAgo, sent_at: tenDaysAgo }],
      // Series B (roach) is now completing its FINAL visit.
      service_records: [
        { id: 'sr-A1', customer_id: 'xs-1', scheduled_service_id: 'ss-A1' },
        { id: 'sr-B2', customer_id: 'xs-1', scheduled_service_id: 'ss-B2' },
      ],
      scheduled_services: [
        { id: 'ss-A1', customer_id: 'xs-1', service_id: 'svc-bedbug', status: 'completed', scheduled_date: recent, service_key: 'bed_bug_treatment' },
        { id: 'ss-B1', customer_id: 'xs-1', service_id: 'svc-roach', status: 'completed', scheduled_date: recent, service_key: 'cockroach_control' },
        { id: 'ss-B2', customer_id: 'xs-1', service_id: 'svc-roach', status: 'completed', scheduled_date: new Date().toISOString().slice(0, 10), service_key: 'cockroach_control', parent_service_id: 'ss-B1' },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'xs-1', serviceRecordId: 'sr-B2', completedAt: new Date() });

    // Series B's final-visit exemption covers only series B's own sequences —
    // series A's ask 10 days ago keeps the cooldown in force.
    expect(result.started).toBe(false);
    expect(result.reason).toBe('cooldown');
  });

  test('the SAME series\' first-treatment ask is exempt: final-visit enrollment proceeds', async () => {
    mockGates.reviewSequences = true;
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    const recent = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'xs-2', first_name: 'Leo', last_name: 'U', phone: '+19410000061', nearest_location_id: 'bradenton' }],
      review_sequences: [{ id: 'seq-C1', customer_id: 'xs-2', service_record_id: 'sr-C1', status: 'completed', stop_reason: 'completed', plan: '[]', started_at: tenDaysAgo }],
      review_requests: [{ id: 'rr-C', customer_id: 'xs-2', sequence_id: 'seq-C1', template_key: 'first_treatment_ask', channel: 'sms', status: 'sent', sms_sent_at: tenDaysAgo, sent_at: tenDaysAgo }],
      service_records: [
        { id: 'sr-C1', customer_id: 'xs-2', scheduled_service_id: 'ss-C1' },
        { id: 'sr-C2', customer_id: 'xs-2', scheduled_service_id: 'ss-C2' },
      ],
      scheduled_services: [
        { id: 'ss-C1', customer_id: 'xs-2', service_id: 'svc-roach', status: 'completed', scheduled_date: recent, service_key: 'cockroach_control' },
        { id: 'ss-C2', customer_id: 'xs-2', service_id: 'svc-roach', status: 'completed', scheduled_date: new Date().toISOString().slice(0, 10), service_key: 'cockroach_control', parent_service_id: 'ss-C1' },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'xs-2', serviceRecordId: 'sr-C2', completedAt: new Date() });

    expect(result.started).toBe(true);
    expect(JSON.parse(mock.__state.rows.review_sequences.find((r) => r.id !== 'seq-C1').plan)).toHaveLength(3);
  });

  test('email personalization is skipped when the active template lacks {{intro_paragraph}}', async () => {
    mockDraftEmailIntro.mockResolvedValue('should never be requested');
    const mock = makeMock({
      email_templates: [{ id: 'tpl-x', template_key: 'review_request_email', active_version_id: 'ver-x' }],
      // Operator republished without the variable — drafting must not run.
      email_template_versions: [{ id: 'ver-x', blocks: '[{"type":"paragraph","content":"Operator copy"}]' }],
      customers: [{ id: 'pg-1', first_name: 'Deb', last_name: 'Z', phone: '+19410000062', email: 'x@y.com', nearest_location_id: 'sarasota' }],
      notification_prefs: [{ customer_id: 'pg-1', review_request: true, sms_enabled: true, email_enabled: true, review_request_channel: 'sms' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'email', templateId: 'final_nudge',
      sequenceId: 'seq-pg', sequenceStep: 2, manageRetryVia: 'sequence',
    });

    expect(out.ok).toBe(true);
    expect(mockDraftEmailIntro).not.toHaveBeenCalled();
    expect(mock.__state.rows.review_requests[0].template_key).toBe('review_request_email');
  });
});

describe('codex #3235 r7 — lineage walk + visit-context exemption', () => {
  test('a 3-visit chain: the final visit exempts the FIRST visit\'s ask through the middle hop', async () => {
    mockGates.reviewSequences = true;
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'ch-1', first_name: 'Rob', last_name: 'W', phone: '+19410000063', nearest_location_id: 'bradenton' }],
      review_sequences: [{ id: 'seq-v1', customer_id: 'ch-1', service_record_id: 'sr-v1', status: 'completed', stop_reason: 'completed', plan: '[]', started_at: tenDaysAgo }],
      review_requests: [{ id: 'rr-v1', customer_id: 'ch-1', sequence_id: 'seq-v1', template_key: 'first_treatment_ask', channel: 'sms', status: 'sent', sms_sent_at: tenDaysAgo, sent_at: tenDaysAgo }],
      service_records: [
        { id: 'sr-v1', customer_id: 'ch-1', scheduled_service_id: 'ss-v1' },
        { id: 'sr-v3', customer_id: 'ch-1', scheduled_service_id: 'ss-v3' },
      ],
      scheduled_services: [
        { id: 'ss-v1', customer_id: 'ch-1', status: 'completed', scheduled_date: d(14) },
        { id: 'ss-v2', customer_id: 'ch-1', parent_service_id: 'ss-v1', status: 'completed', scheduled_date: d(7) },
        { id: 'ss-v3', customer_id: 'ch-1', parent_service_id: 'ss-v2', status: 'completed', scheduled_date: d(0) },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'ch-1', serviceRecordId: 'sr-v3', completedAt: new Date() });

    expect(result.started).toBe(true);
    const seq = mock.__state.rows.review_sequences.find((r) => r.id !== 'seq-v1');
    expect(JSON.parse(seq.plan)).toHaveLength(3);
  });

  test('a final visit completed with only a scheduled_services id (no record row) still exempts its series ask', async () => {
    mockGates.reviewSequences = true;
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'nv-1', first_name: 'Mia', last_name: 'X', phone: '+19410000064', nearest_location_id: 'bradenton' }],
      review_sequences: [{ id: 'seq-n1', customer_id: 'nv-1', service_record_id: 'sr-n1', status: 'completed', stop_reason: 'completed', plan: '[]', started_at: tenDaysAgo }],
      review_requests: [{ id: 'rr-n1', customer_id: 'nv-1', sequence_id: 'seq-n1', template_key: 'first_treatment_ask', channel: 'sms', status: 'sent', sms_sent_at: tenDaysAgo, sent_at: tenDaysAgo }],
      service_records: [{ id: 'sr-n1', customer_id: 'nv-1', scheduled_service_id: 'ss-n1' }],
      scheduled_services: [
        { id: 'ss-n1', customer_id: 'nv-1', status: 'completed', scheduled_date: d(10) },
        { id: 'ss-n2', customer_id: 'nv-1', followup_source_service_id: 'ss-n1', status: 'completed', scheduled_date: d(0) },
      ],
    });
    db.mockImplementation(mock);

    // No service_records row for the final visit — only the visit id.
    const result = await ReviewService.enrollPostService({ customerId: 'nv-1', scheduledServiceId: 'ss-n2', completedAt: new Date() });

    expect(result.started).toBe(true);
    const seq = mock.__state.rows.review_sequences.find((r) => r.id !== 'seq-n1');
    expect(JSON.parse(seq.plan)).toHaveLength(3);
    // The visit identity is persisted for the runner's own lineage walk.
    expect(seq.scheduled_service_id).toBe('ss-n2');
  });
});

describe('codex #3235 r8 — record-less sequence corners', () => {
  test('a record-less first-visit sequence (scheduled_service_id only) is still exempt at the final visit', async () => {
    mockGates.reviewSequences = true;
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'rl-1', first_name: 'Sam', last_name: 'Y', phone: '+19410000065', nearest_location_id: 'bradenton' }],
      // Visit-1 sequence enrolled BEFORE its service_records row existed:
      // service_record_id NULL, only the persisted visit id.
      review_sequences: [{ id: 'seq-rl1', customer_id: 'rl-1', service_record_id: null, scheduled_service_id: 'ss-rl1', status: 'completed', stop_reason: 'completed', plan: '[]', started_at: tenDaysAgo }],
      review_requests: [{ id: 'rr-rl1', customer_id: 'rl-1', sequence_id: 'seq-rl1', template_key: 'first_treatment_ask', channel: 'sms', status: 'sent', sms_sent_at: tenDaysAgo, sent_at: tenDaysAgo }],
      service_records: [{ id: 'sr-rl2', customer_id: 'rl-1', scheduled_service_id: 'ss-rl2' }],
      scheduled_services: [
        { id: 'ss-rl1', customer_id: 'rl-1', status: 'completed', scheduled_date: d(10) },
        { id: 'ss-rl2', customer_id: 'rl-1', parent_service_id: 'ss-rl1', status: 'completed', scheduled_date: d(0) },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'rl-1', serviceRecordId: 'sr-rl2', completedAt: new Date() });

    expect(result.started).toBe(true);
    const seq = mock.__state.rows.review_sequences.find((r) => r.id !== 'seq-rl1');
    expect(JSON.parse(seq.plan)).toHaveLength(3);
  });

  test('a touch on a record-less sequence recovers date/tech from the persisted visit id', async () => {
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'rl-2', first_name: 'Kay', last_name: 'V', phone: '+19410000066', nearest_location_id: 'bradenton' }],
      scheduled_services: [{ id: 'ss-rl3', customer_id: 'rl-2', status: 'completed', scheduled_date: d(1), service_type: 'Bed Bug Treatment', technician_id: 'tech-9' }],
      technicians: [{ id: 'tech-9', name: 'Adam Benetti' }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.sendOutreachTouch({
      customer: mock.__state.rows.customers[0],
      channel: 'sms', templateId: 'first_treatment_ask',
      scheduledServiceId: 'ss-rl3',
      sequenceId: 'seq-rl3', sequenceStep: 0, manageRetryVia: 'sequence',
    });

    expect(out.ok).toBe(true);
    const row = mock.__state.rows.review_requests[0];
    // Visit context recovered from the scheduled_services row (the mock's
    // leftJoin is a no-op, so tech name resolution stays best-effort here —
    // date + type + technician_id are the load-bearing recoveries).
    expect(row.service_type).toBe('Bed Bug Treatment');
    expect(row.service_date).toBe(d(1));
    expect(row.technician_id).toBe('tech-9');
  });
});

describe('codex #3235 r9 — canonical liveness + late-booked follow-up', () => {
  test('a RESCHEDULED follow-up child still marks the source visit first-in-series', async () => {
    mockGates.reviewSequences = true;
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'rs-1', first_name: 'Joe', last_name: 'M', phone: '+19410000067', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-rs1', customer_id: 'rs-1', scheduled_service_id: 'ss-rs1' }],
      scheduled_services: [
        { id: 'ss-rs1', customer_id: 'rs-1', status: 'completed', scheduled_date: d(0) },
        // The booked follow-up is mid-reschedule — the obligation lane treats
        // it as live (only cancelled/skipped/no_show are dead).
        { id: 'ss-rs2', customer_id: 'rs-1', followup_source_service_id: 'ss-rs1', status: 'rescheduled', scheduled_date: future },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'rs-1', serviceRecordId: 'sr-rs1', completedAt: new Date() });

    expect(result.started).toBe(true);
    const plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');
  });

  test('a follow-up booked AFTER enrollment reclassifies the still-unsent sequence at first send', async () => {
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const threeTouch = JSON.stringify([
      { day: 0, channel: 'sms', templateKey: 'friendly_ask' },
      { day: 4, channel: 'sms', templateKey: 'soft_reminder', weekdaysOnly: true },
      { day: 6, channel: 'email', templateKey: 'final_nudge' },
    ]);
    const mock = makeMock({
      customers: [{ id: 'lb-1', first_name: 'Ann', last_name: 'O', phone: '+19410000068', nearest_location_id: 'bradenton' }],
      // Enrolled as one-time at completion…
      review_sequences: [{ id: 'seq-lb', customer_id: 'lb-1', service_record_id: 'sr-lb1', status: 'active', current_step: 0, touches_sent: 0, started_by: 'post_service', plan: threeTouch, started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000) }],
      service_records: [{ id: 'sr-lb1', customer_id: 'lb-1', scheduled_service_id: 'ss-lb1' }],
      scheduled_services: [
        { id: 'ss-lb1', customer_id: 'lb-1', status: 'completed', scheduled_date: d(0) },
        // …then staff booked the follow-up minutes later.
        { id: 'ss-lb2', customer_id: 'lb-1', followup_source_service_id: 'ss-lb1', status: 'confirmed', scheduled_date: future },
      ],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    const seq = mock.__state.rows.review_sequences[0];
    expect(JSON.parse(seq.plan)).toHaveLength(1);
    expect(JSON.parse(seq.plan)[0].templateKey).toBe('first_treatment_ask');
    const body = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(body).toMatch(/First treatment's done/);
  });
});

describe('codex #3235 r10 — failure propagation, record-less dedupe, history anchoring', () => {
  test('a plan-resolution failure skips enrollment instead of defaulting to the 3-touch cadence', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'pf-1', first_name: 'Ida', last_name: 'R', phone: '+19410000069', nearest_location_id: 'bradenton' }],
    });
    db.mockImplementation(mock);
    const spy = jest.spyOn(ReviewService, 'resolveSequencePlanForEnrollment').mockResolvedValue({ error: true });
    try {
      const result = await ReviewService.enrollPostService({ customerId: 'pf-1', completedAt: new Date() });
      expect(result.started).toBe(false);
      expect(result.reason).toBe('plan_resolution_failed');
      expect(mock.__state.rows.review_sequences).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('a record-less enrollment dedupes by the persisted scheduled visit id', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'vd-1', first_name: 'Ora', last_name: 'S', phone: '+19410000070', nearest_location_id: 'bradenton' }],
      scheduled_services: [{ id: 'ss-vd', customer_id: 'vd-1', status: 'completed', scheduled_date: new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10) }],
      review_sequences: [{ id: 'seq-vd', customer_id: 'vd-1', service_record_id: null, scheduled_service_id: 'ss-vd', status: 'completed', stop_reason: 'completed', plan: '[]', started_at: new Date(Date.now() - 40 * 86400000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'vd-1', scheduledServiceId: 'ss-vd', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('service_record_enrolled');
    expect(mock.__state.rows.review_sequences).toHaveLength(1);
  });

  test('a later completed treatment cannot make an earlier visit look final (history anchored to the visit)', async () => {
    mockGates.reviewSequences = true;
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'ha-1', first_name: 'Zed', last_name: 'Q', phone: '+19410000071', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-ha1', customer_id: 'ha-1', scheduled_service_id: 'ss-ha1' }],
      scheduled_services: [
        // Visit 1 (enrolling late, e.g. via a delayed invoice payment)…
        { id: 'ss-ha1', customer_id: 'ha-1', service_id: 'svc-roach', status: 'completed', scheduled_date: d(20), service_key: 'cockroach_control' },
        // …while visit 2 has ALREADY happened. It is LATER than visit 1, so
        // it must not count as visit 1's "prior" treatment.
        { id: 'ss-ha2', customer_id: 'ha-1', service_id: 'svc-roach', status: 'completed', scheduled_date: d(6), service_key: 'cockroach_control' },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'ha-1', serviceRecordId: 'sr-ha1', completedAt: new Date() });

    expect(result.started).toBe(true);
    const plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');
  });
});

describe('codex #3235 r11 — completed descendants, package separation, long chains', () => {
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  test('a late-paid middle visit whose child already COMPLETED is not classified final (series_completed)', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'cd-1', first_name: 'Tia', last_name: 'A', phone: '+19410000072', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-cd2', customer_id: 'cd-1', scheduled_service_id: 'ss-cd2' }],
      scheduled_services: [
        { id: 'ss-cd1', customer_id: 'cd-1', status: 'completed', scheduled_date: d(20) },
        { id: 'ss-cd2', customer_id: 'cd-1', parent_service_id: 'ss-cd1', status: 'completed', scheduled_date: d(12) },
        { id: 'ss-cd3', customer_id: 'cd-1', parent_service_id: 'ss-cd2', status: 'completed', scheduled_date: d(4) },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'cd-1', serviceRecordId: 'sr-cd2', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('series_completed');
  });

  test('a new package starting outside 2x the follow-up interval is a FIRST visit, not the old package\'s final', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'np-1', first_name: 'Gus', last_name: 'B', phone: '+19410000073', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-np2', customer_id: 'np-1', scheduled_service_id: 'ss-np2' }],
      scheduled_services: [
        // Previous package's visit 45 days ago; catalog interval 14d → window 28d.
        { id: 'ss-np1', customer_id: 'np-1', service_id: 'svc-roach', status: 'completed', scheduled_date: d(45), service_key: 'cockroach_control', follow_up_interval_days: 14 },
        { id: 'ss-np2', customer_id: 'np-1', service_id: 'svc-roach', status: 'completed', scheduled_date: d(0), service_key: 'cockroach_control', follow_up_interval_days: 14 },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'np-1', serviceRecordId: 'sr-np2', completedAt: new Date() });

    expect(result.started).toBe(true);
    const plan = JSON.parse(mock.__state.rows.review_sequences[0].plan);
    expect(plan).toHaveLength(1);
    expect(plan[0].templateKey).toBe('first_treatment_ask');
  });

  test('a 9-visit linked chain still reaches the root sequence for the exemption', async () => {
    mockGates.reviewSequences = true;
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    const visits = [];
    for (let i = 1; i <= 9; i += 1) {
      visits.push({
        id: `ss-l${i}`, customer_id: 'lc-1', status: 'completed',
        scheduled_date: d(30 - i * 3),
        ...(i > 1 ? { parent_service_id: `ss-l${i - 1}` } : {}),
      });
    }
    const mock = makeMock({
      customers: [{ id: 'lc-1', first_name: 'Roy', last_name: 'C', phone: '+19410000074', nearest_location_id: 'bradenton' }],
      review_sequences: [{ id: 'seq-root', customer_id: 'lc-1', service_record_id: null, scheduled_service_id: 'ss-l1', status: 'completed', stop_reason: 'completed', plan: '[]', started_at: tenDaysAgo }],
      review_requests: [{ id: 'rr-root', customer_id: 'lc-1', sequence_id: 'seq-root', template_key: 'first_treatment_ask', channel: 'sms', status: 'sent', sms_sent_at: tenDaysAgo, sent_at: tenDaysAgo }],
      service_records: [{ id: 'sr-l9', customer_id: 'lc-1', scheduled_service_id: 'ss-l9' }],
      scheduled_services: visits,
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'lc-1', serviceRecordId: 'sr-l9', completedAt: new Date() });

    expect(result.started).toBe(true);
    const seq = mock.__state.rows.review_sequences.find((r) => r.id !== 'seq-root');
    expect(JSON.parse(seq.plan)).toHaveLength(3);
  });
});

describe('codex #3235 r12 — ET dates, 1:1 correlation, manual cap-exempt sends', () => {
  test('a pg UTC-midnight Date anchor stays on its ET calendar day (window boundaries hold)', async () => {
    mockGates.reviewSequences = true;
    const dayStr = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mock = makeMock({
      customers: [{ id: 'et-9', first_name: 'Ned', last_name: 'D', phone: '+19410000075', nearest_location_id: 'bradenton' }],
      service_records: [{ id: 'sr-et2', customer_id: 'et-9', scheduled_service_id: 'ss-et2' }],
      scheduled_services: [
        { id: 'ss-et1', customer_id: 'et-9', service_id: 'svc-roach', status: 'completed', scheduled_date: dayStr(14), service_key: 'cockroach_control', follow_up_interval_days: 14 },
        // Anchor arrives as a pg-style UTC-midnight Date — 8 PM ET the night
        // before; a naive ET conversion would shift the window a day back.
        { id: 'ss-et2', customer_id: 'et-9', service_id: 'svc-roach', status: 'completed', scheduled_date: new Date(`${dayStr(0)}T00:00:00.000Z`), service_key: 'cockroach_control', follow_up_interval_days: 14 },
      ],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'et-9', serviceRecordId: 'sr-et2', completedAt: new Date() });

    // Visit 14 days earlier sits INSIDE the 28-day window → final visit.
    expect(result.started).toBe(true);
    expect(JSON.parse(mock.__state.rows.review_sequences[0].plan)).toHaveLength(3);
  });

  test('a hand-sent ask minutes after an automated one is still detected (1:1 correlation)', async () => {
    mockGates.reviewSequences = true;
    const base = Date.now() - 2 * 86400000;
    const mock = makeMock({
      customers: [{ id: 'oo-1', first_name: 'Pia', last_name: 'E', phone: '+19410000076', nearest_location_id: 'bradenton' }],
      sms_log: [
        // The automated pipeline ask…
        { id: 'sms-a', customer_id: 'oo-1', direction: 'outbound', status: 'sent', message_body: 'Hi Pia! A quick Google review would mean the world: https://portal.test/l/aaa', created_at: new Date(base) },
        // …and the owner's hand-sent ask 4 minutes later.
        { id: 'sms-b', customer_id: 'oo-1', direction: 'outbound', status: 'sent', message_body: 'Pia it was great seeing you, review us here: https://g.page/r/waves/review', created_at: new Date(base + 4 * 60000) },
      ],
      review_requests: [{ id: 'rr-oo', customer_id: 'oo-1', template_key: 'friendly_ask', channel: 'sms', status: 'sent', sms_sent_at: new Date(base), sent_at: new Date(base) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'oo-1', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('manual_ask_recent');
  });

  test('a manual (sequence-less) send of a cap-exempt template never triggers the legacy follow-up', async () => {
    const mock = makeMock({
      customers: [{ id: 'mx-1', first_name: 'Ugo', last_name: 'F', phone: '+19410000077', nearest_location_id: 'bradenton' }],
    });
    db.mockImplementation(mock);

    await ReviewService.sendOutreachTouch({ customer: mock.__state.rows.customers[0], channel: 'sms', templateId: 'first_treatment_ask', manageRetryVia: 'cron' });

    expect(mock.__state.rows.review_requests[0].followup_sent).toBe(true);
  });
});

describe('codex #3235 r13 — orphaned pipeline sends', () => {
  test('a pipeline send with no sms_log row of its own cannot excuse a manual ask', async () => {
    mockGates.reviewSequences = true;
    const base = Date.now() - 2 * 86400000;
    const mock = makeMock({
      customers: [{ id: 'or-1', first_name: 'Lil', last_name: 'G', phone: '+19410000078', nearest_location_id: 'bradenton' }],
      // ONLY the manual text exists in sms_log — the automated send's log
      // insert failed (twilio.js swallows that error), leaving an orphaned
      // review_requests timestamp 4 minutes earlier.
      sms_log: [
        { id: 'sms-m', customer_id: 'or-1', direction: 'outbound', status: 'sent', message_body: 'Lil, review us here: https://g.page/r/waves/review', created_at: new Date(base + 4 * 60000) },
      ],
      review_requests: [{ id: 'rr-or', customer_id: 'or-1', template_key: 'friendly_ask', channel: 'sms', status: 'sent', sms_sent_at: new Date(base), sent_at: new Date(base) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'or-1', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('manual_ask_recent');
  });
});

describe('codex #3235 r15 — review-scoped orphan correspondence', () => {
  test('an unrelated outbound text near an orphaned review send does not legitimize it', async () => {
    mockGates.reviewSequences = true;
    const base = Date.now() - 2 * 86400000;
    const mock = makeMock({
      customers: [{ id: 'ur-1', first_name: 'Bea', last_name: 'H', phone: '+19410000079', nearest_location_id: 'bradenton' }],
      sms_log: [
        // An invoice text 30s after the orphaned review send — NOT review-looking.
        { id: 'sms-inv', customer_id: 'ur-1', direction: 'outbound', status: 'sent', message_body: 'Your Waves invoice is ready: https://portal.test/pay/xyz', created_at: new Date(base + 30000) },
        // The owner's manual ask 5 minutes later.
        { id: 'sms-man', customer_id: 'ur-1', direction: 'outbound', status: 'sent', message_body: 'Bea, review us here: https://g.page/r/waves/review', created_at: new Date(base + 5 * 60000) },
      ],
      review_requests: [{ id: 'rr-ur', customer_id: 'ur-1', template_key: 'friendly_ask', channel: 'sms', status: 'sent', sms_sent_at: new Date(base), sent_at: new Date(base) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'ur-1', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('manual_ask_recent');
  });
});

describe('codex #3235 r18 — Maps links count as manual asks', () => {
  test('a hand-sent maps.app.goo.gl review link triggers the standdown', async () => {
    mockGates.reviewSequences = true;
    const mock = makeMock({
      customers: [{ id: 'mp-1', first_name: 'Dot', last_name: 'I', phone: '+19410000080', nearest_location_id: 'bradenton' }],
      sms_log: [{ id: 'sms-mp', customer_id: 'mp-1', direction: 'outbound', status: 'sent', message_body: 'Please share your feedback: https://maps.app.goo.gl/AbC123', created_at: new Date(Date.now() - 86400000) }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.enrollPostService({ customerId: 'mp-1', completedAt: new Date() });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('manual_ask_recent');
  });
});

describe('codex #3235 r19 — first-send re-resolution failure defers', () => {
  test('a failed re-resolution defers the touch instead of sending the stale plan', async () => {
    const threeTouch = JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]);
    const mock = makeMock({
      customers: [{ id: 'df-1', first_name: 'Hal', last_name: 'J', phone: '+19410000081', nearest_location_id: 'bradenton' }],
      review_sequences: [{ id: 'seq-df', customer_id: 'df-1', service_record_id: 'sr-df', status: 'active', current_step: 0, touches_sent: 0, started_by: 'post_service', plan: threeTouch, started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000) }],
    });
    db.mockImplementation(mock);
    const spy = jest.spyOn(ReviewService, 'resolveSequencePlanForEnrollment').mockResolvedValue({ error: true });
    try {
      const out = await ReviewService.processReviewSequences();
      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      expect(out.sent).toBe(0);
      const seq = mock.__state.rows.review_sequences[0];
      expect(seq.status).toBe('active');
      expect(new Date(seq.next_run_at).getTime()).toBeGreaterThan(Date.now());
    } finally {
      spy.mockRestore();
    }
  });
});

// The Twilio adapter catches provider errors and reports them as
// `sent: false` / PROVIDER_FAILURE instead of raising. On a row the summary
// handoff left `sending`, the request WAS made and its response was lost, so
// the deferral bookkeeping would reset the row and send a second ask on top of
// a delivered one (audit P1).
describe('legacy sendSMS — ambiguous returned provider failure', () => {
  const rows = () => ({
    customers: [{ id: 'unc-1', first_name: 'Lee', last_name: 'P', phone: '+19410000195', nearest_location_id: 'venice' }],
    review_requests: [{
      id: 'rr-unc-1', customer_id: 'unc-1', channel: 'sms', status: 'sending', template_key: 'day0_ask',
      tech_name: null, token: 'tok-unc-1', location_id: 'venice', claimed_at: new Date(),
    }],
  });

  test('keeps the claim standing instead of requeuing it', async () => {
    // The row is `pending` when sendSMS starts (the pre-send fence only
    // stores against a pending row); the summary handoff inside the
    // provider call is what marks it `sending` before the request is made.
    const state = rows();
    state.review_requests[0].status = 'pending';
    const mock = makeMock(state);
    db.mockImplementation(mock);
    mockSendCustomerMessage.mockImplementationOnce(async () => {
      mock.__state.rows.review_requests[0].status = 'sending';
      return {
        sent: false, blocked: false, code: 'PROVIDER_FAILURE', reason: 'connection reset',
        retryable: true, deferred: true, nextAllowedAt: new Date(Date.now() + 300000).toISOString(),
      };
    });

    const out = await ReviewService.sendSMS('rr-unc-1');

    expect(out).toMatchObject({ sent: false, uncertain: true, reason: 'provider_uncertain' });
    expect(mock.__state.rows.review_requests[0].status).toBe('sending');
    expect(mock.__state.rows.review_requests[0].sms_sent_at).toBeFalsy();
  });

  test('a released row takes the ordinary deferral', async () => {
    const state = rows();
    state.review_requests[0].status = 'pending';
    state.review_requests[0].claimed_at = null;
    const mock = makeMock(state);
    db.mockImplementation(mock);
    mockSendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: false, code: 'PROVIDER_FAILURE', reason: 'connection reset',
      retryable: true, deferred: true, nextAllowedAt: new Date(Date.now() + 300000).toISOString(),
    });

    // The deferral path returns nothing — the row IS the verdict.
    expect(await ReviewService.sendSMS('rr-unc-1')).toBeUndefined();
    expect(mock.__state.rows.review_requests[0].status).toBe('pending');
    expect(mock.__state.rows.review_requests[0].scheduled_for).toBeTruthy();
  });
});

describe('shared ask history foundation', () => {
  const history = require('../services/review-ask-history');
  const base = new Date('2035-01-01T15:00:00Z').getTime();
  function installHistory({ sms = [], sends = [] } = {}) {
    const mock = makeMock({
      sms_log: sms.map(({ at, body, status = 'sent', metadata = {} }) => ({
        customer_id: 'history-customer', direction: 'outbound', status, metadata,
        message_body: body || 'Please review us: https://g.page/r/example/review', created_at: new Date(at),
      })),
      review_requests: sends.map(at => ({ customer_id: 'history-customer', sms_sent_at: new Date(at) })),
    });
    db.mockImplementation(mock);
    return mock;
  }

  test('the newest manual ask retains its own timestamp after a pipeline ask', async () => {
    installHistory({ sms: [{ at: base }, { at: base + 240000 }], sends: [base] });
    const at = await ReviewService.manualReviewAskSentRecently('history-customer', {
      since: new Date(base - 1), returnAt: true, failClosed: true,
    });
    expect(at).toEqual(new Date(base + 240000));
    expect(at.getTime() + history.ASK_SPACING_MS).toBe(base + 240000 + 72 * 3600000);
  });

  test('a manual ask inside the correspondence window cannot steal the exact pipeline match', async () => {
    installHistory({ sms: [{ at: base }, { at: base + 30000 }], sends: [base] });
    expect(await history.lastManualAskAt('history-customer', { since: new Date(base - 1) }))
      .toEqual(new Date(base + 30000));
  });

  test('correlation includes the pipeline log immediately before the history boundary', async () => {
    installHistory({ sms: [{ at: base - 30000 }, { at: base + 30000 }], sends: [base - 30000] });
    expect(await history.lastManualAskAt('history-customer', { since: new Date(base) }))
      .toEqual(new Date(base + 30000));
  });

  test('multiple pipeline logs are each consumed once before selecting a manual ask', async () => {
    installHistory({ sms: [{ at: base }, { at: base + 60000 }, { at: base + 90000 }], sends: [base, base + 60000] });
    expect(await history.lastManualAskAt('history-customer', { since: new Date(base - 1) }))
      .toEqual(new Date(base + 90000));
  });

  test('an orphan pipeline stamp does not erase a later manual ask', async () => {
    installHistory({ sms: [{ at: base + 240000 }], sends: [base] });
    expect(await history.lastManualAskAt('history-customer', { since: new Date(base - 1) }))
      .toEqual(new Date(base + 240000));
  });

  test.each([
    'Thanks for your Google review',
    'We really appreciate your Google review.',
    'Your Google review meant the world to us.',
    'Thanks for leaving us a Google review',
    'Office directions: https://maps.app.goo.gl/abc123',
    'Meet here: https://goo.gl/maps/abc123',
    'https://maps.google.com/?q=office',
    'Our office: https://g.page/office-location',
    'Please review your invoice: https://portal.test/pay/abc',
    'Please review and sign your agreement: https://portal.test/contract/abc',
    'Could you review the service report?',
    'Please submit your review of the attached estimate.',
    'Please submit your review for the attached estimate.',
    // codex #4326 finding 2: a noun ("comments"/"feedback"/"notes") between
    // "review" and the document preposition must not defeat the carve-out.
    'Please share your review comments on the attached estimate.',
    'Share your review notes for the updated contract, please.',
    'Please add your review feedback on the attached proposal.',
    'Shipping details: https://vendor.example/rate/abc',
    'Please review your invoice: https://portal.test/l/abc123',
    'Your invoice is ready: https://portal.test/l/abc123',
    'We discussed your Google review yesterday.',
    'Thanks so much for the Google review you left us!',
    // codex #4326 r3: support chatter about the link is not a request.
    'The review link is broken; I’ll resend it later.',
    'I fixed the review link.',
    'Let me know if the review link works now.',
  ])('unrelated acknowledgment/support text is not an ask: %s', async body => {
    installHistory({ sms: [{ at: base, body }] });
    expect(await history.lastManualAskAt('history-customer', { since: new Date(base - 1) })).toBeNull();
  });

  test.each([
    'Could you leave a Google review?',
    'Could I ask you for a Google review?',
    'Can we ask for your honest review?',
    'https://portal.wavespestcontrol.com/rate/abc',
    'portal.wavespestcontrol.com/api/rate/abc/go',
    'We’d appreciate a Google review.',
    'We’d be grateful for a Google review.',
    'A quick Google review would make my day.',
    'A quick Google review would mean the world.',
    'A Google review would be greatly appreciated.',
    'A 5-star Google review would mean the world.',
    'We would appreciate a five-star review.',
    'Could I ask you for a five-star Google review?',
    'We would really love your honest review.',
    'A review could help our little crew.',
    'Would you mind leaving us a Google review?',
    'https://g.page/office-slug/review',
    'A quick review helps: https://portal.test/l/abc123',
    'A quick review means a lot: https://portal.test/l/abc123',
    'Please consider posting a Google review.',
    'How about writing a review?',
    'Please review us when you have a moment.',
    'Share your experience in a review.',
    'A review would mean a lot: https://portal.test/l/abc123',
    'https://www.yelp.com/writeareview/biz/example',
    'https://facebook.com/example/reviews',
    'Please leave a review: https://maps.app.goo.gl/abc123',
    'We’d appreciate it if you left us a Google review.',
    'It would mean a lot if you left us a review.',
    'If you could leave us a quick Google review, that would help.',
    // codex #4326 finding 1: present-tense invitations (no would/could) —
    // this is the repo's own Day-0 template wording (review-outreach-templates.js).
    'If we earned it, a Google review means a lot.',
    'A quick review helps us out a ton.',
    'A quick Google review really helps.',
    'A 5-star review supports our small crew.',
    'That review link one more time:',
    'Here is that review link one more time.',
    'Here’s your review link again.',
    'Review link: https://portal.test/l/abc123',
  ])('request intent and review destinations count: %s', body => {
    expect(history.looksLikeReviewAsk(body)).toBe(true);
  });

  test('every real ask template in review-outreach-templates.js is recognized on its own wording', () => {
    // Rendered with review_url stripped: a staff member forwarding this exact
    // wording without the (per-customer) link must still trip the standdown
    // (codex #4326 finding 1 — the repo's own Day-0 wording was the reported
    // gap). Two templates lean entirely on the link with no textual review
    // mention at all ("If we earned it:" / "sharing your experience?") — that
    // is a structural template-design limit, not a classifier bug, so they
    // are pinned here as known link-dependent rather than silently ignored.
    const templates = require('../services/review-outreach-templates');
    const LINK_DEPENDENT_ONLY = new Set(['service_specific_pest', 'recovery_review']);
    for (const t of templates.OUTREACH_TEMPLATES) {
      if (!templates.isAskTemplate(t.id)) continue; // no-link check-ins are not asks
      const linkFreeBody = templates.renderOutreachBody(t.body, {
        first: 'Jamie', tech: 'Bob', sender: 'Bob with Waves', review_url: '',
      });
      const detected = history.looksLikeReviewAsk(linkFreeBody);
      if (LINK_DEPENDENT_ONLY.has(t.id)) {
        expect(detected).toBe(false);
      } else {
        expect(detected).toBe(true);
      }
    }
  });

  test('an unresolved manual review reservation cannot be matched away by a pipeline stamp', async () => {
    installHistory({ sms: [{ at: base, status: 'sending', metadata: { review_ask_reservation: true } }], sends: [base] });
    expect(await history.lastManualAskAt('history-customer', { since: new Date(base - 1) })).toEqual(new Date(base));
  });

  test('a confirmed review reservation is staff-ask evidence even when reservations are excluded and only a short link remains', async () => {
    installHistory({
      sms: [{ at: base, status: 'sent', body: 'https://wavespest.co/l/abc123', metadata: { review_ask_reservation: true } }],
    });
    expect(history.looksLikeReviewAsk('https://wavespest.co/l/abc123')).toBe(false);
    expect(await ReviewService.manualReviewAskSentRecently('history-customer', {
      since: new Date(base - 1), returnAt: true, failClosed: true, includeReservations: false,
    })).toEqual(new Date(base));
  });

  test('a confirmed reservation still correlates to its automated request, while an unresolved one stays excluded', async () => {
    installHistory({
      sms: [{ at: base, status: 'sent', body: 'https://wavespest.co/l/abc123', metadata: { review_ask_reservation: true } }],
      sends: [base],
    });
    expect(await history.lastManualAskAt('history-customer', {
      since: new Date(base - 1), includeReservations: false,
    })).toBeNull();

    installHistory({
      sms: [{ at: base, status: 'sending', body: 'https://wavespest.co/l/abc123', metadata: { review_ask_reservation: true } }],
    });
    expect(await history.lastManualAskAt('history-customer', {
      since: new Date(base - 1), includeReservations: false,
    })).toBeNull();
    expect(await history.lastManualAskAt('history-customer', {
      since: new Date(base - 1), includeReservations: true,
    })).toEqual(new Date(base));
  });

  test('a reservation confirmed after the boundary is evidence via its confirmation time, even though its placeholder predates the boundary (codex review-request.js:1476 P1)', async () => {
    const reservedAt = new Date(base - 300000);
    const confirmedAt = new Date(base + 120000);
    const mock = makeMock({
      sms_log: [{
        customer_id: 'history-customer', direction: 'outbound', status: 'sent',
        message_body: 'https://wavespest.co/l/abc123', metadata: { review_ask_reservation: true },
        created_at: reservedAt, updated_at: confirmedAt,
      }],
    });
    db.mockImplementation(mock);

    expect(await history.lastManualAskAt('history-customer', {
      since: new Date(base), includeReservations: false,
    })).toEqual(confirmedAt);

    // An unconfirmed (still 'sending') reservation opened before the
    // boundary is NOT evidence — only a resolved confirmation anchors past
    // its placeholder's created_at.
    const stillSending = makeMock({
      sms_log: [{
        customer_id: 'history-customer', direction: 'outbound', status: 'sending',
        message_body: 'https://wavespest.co/l/abc123', metadata: { review_ask_reservation: true },
        created_at: reservedAt, updated_at: reservedAt,
      }],
    });
    db.mockImplementation(stillSending);
    expect(await history.lastManualAskAt('history-customer', {
      since: new Date(base), includeReservations: false,
    })).toBeNull();
  });

  test('ordinary in-flight messages do not count as accepted review asks', async () => {
    installHistory({ sms: [{ at: base, status: 'sending' }] });
    expect(await history.lastManualAskAt('history-customer', { since: new Date(base - 1) })).toBeNull();
  });

  test('no manual ask returns null for timestamps and false for the enrollment contract', async () => {
    installHistory({ sms: [{ at: base }], sends: [base] });
    expect(await ReviewService.manualReviewAskSentRecently('history-customer', { since: new Date(base - 1), returnAt: true })).toBeNull();
    expect(await ReviewService.manualReviewAskSentRecently('history-customer', { since: new Date(base - 1) })).toBe(false);
  });

  test('dispatch history errors propagate while enrollment retains its fail-open contract', async () => {
    db.mockImplementation(() => { throw new Error('history unavailable'); });
    await expect(ReviewService.manualReviewAskSentRecently('history-customer', { failClosed: true, returnAt: true })).rejects.toThrow('history unavailable');
    expect(await ReviewService.manualReviewAskSentRecently('history-customer')).toBe(false);
  });

  test('the later delivered channel anchors spacing even when requests arrive out of order', () => {
    expect(history.latestDeliveredAt([
      { sms_sent_at: new Date(base), sent_at: new Date(base + 3600000) },
      { sms_sent_at: new Date(base + 60000), sent_at: null },
    ])).toEqual(new Date(base + 3600000));
    expect(history.latestDeliveredAt([{ sms_sent_at: null, sent_at: null }])).toBeNull();
  });

  // codex #4326 finding 3: processFollowups (review-request.js) delivers the
  // separate review_request_followup SMS several days after the original
  // ask. The reducer must count that delivery too, or a caller enforcing
  // ASK_SPACING_MS from this shared history under-counts the elapsed time
  // and can fire the next ask too soon. (followup_delivered_at is what
  // deliveredAskRows resolves from messaging_audit_log — see its postgres
  // coverage in review-ask-history-postgres.test.js for why the raw
  // review_requests.followup_sent_at column is NOT used directly: it is
  // also stamped for dedup/no-consent/blocked paths that never reached the
  // customer.)
  test('a delivered legacy follow-up outranks the original ask timestamp', () => {
    expect(history.latestDeliveredAt([
      { sms_sent_at: new Date(base), sent_at: null, followup_delivered_at: new Date(base + 4 * 86400000) },
    ])).toEqual(new Date(base + 4 * 86400000));
  });

  test('a row with only a follow-up timestamp still counts', () => {
    expect(history.latestDeliveredAt([
      { sms_sent_at: null, sent_at: null, followup_delivered_at: new Date(base) },
    ])).toEqual(new Date(base));
    expect(history.latestDeliveredAt([{ sms_sent_at: null, sent_at: null, followup_delivered_at: null }])).toBeNull();
  });
});


test('the real cadence runner waits for a manual dispatch and then observes its delivered ask', async () => {
  const { dispatchReviewAsk } = require('../services/review-ask-dispatch');
  const now = new Date();
  const mock = makeMock({
    customers: [{ id: 'manual-race', first_name: 'Synthetic', phone: '+12025550101' }],
    review_sequences: [{ id: 'race-seq', customer_id: 'manual-race', status: 'active',
      current_step: 0, touches_sent: 0, plan: '[{"day":0,"channel":"sms","templateKey":"day0_ask"}]',
      started_at: new Date(now.getTime() - 3600000), next_run_at: new Date(now.getTime() - 1) }],
    sms_log: [],
  });
  db.mockImplementation(mock);
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  const staff = dispatchReviewAsk('manual-race', async () => {
    entered();
    await wait;
    mock.__state.rows.sms_log.push({ customer_id: 'manual-race', direction: 'outbound', status: 'sent',
      message_body: 'Please leave a Google review.', created_at: new Date() });
    return { sent: true };
  });
  try {
    await started;
    expect(await ReviewService._runSequenceStep('race-seq')).toMatchObject({ ran: false, reason: 'customer_lock_held' });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  } finally { finish(); }
  await staff;
  expect(await ReviewService._runSequenceStep('race-seq')).toMatchObject({ ran: false, reason: 'manual_ask_recent' });
  expect(mockSendCustomerMessage).not.toHaveBeenCalled();
});
