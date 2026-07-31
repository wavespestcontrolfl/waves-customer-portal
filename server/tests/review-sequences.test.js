// Cadence-engine behavior: start → advance → auto-stop on review → complete.
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true, auditLogId: 'audit-1' }));
const mockEmailSendTemplate = jest.fn(async () => ({ sent: true, message: { id: 'em-1' } }));

jest.mock('../models/db', () => jest.fn());
// Mutable gate flags for the 2026-07-30 revamp tests (post-service auto-enroll
// + direct Google link). Both default OFF = pre-rollout behavior.
const mockGates = { reviewSequences: false, reviewDirectLink: false };
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => !!mockGates[g],
  gates: mockGates,
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendCustomerMessage(...a) }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: (...a) => mockEmailSendTemplate(...a) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.test' }));
jest.mock('../services/customer-contact', () => ({
  // Honor explicit null/'' so tests can model a customer missing a channel.
  getServiceContact: (c) => ({
    phone: c.phone !== undefined ? c.phone : '+19410000000',
    email: c.email !== undefined ? c.email : 'x@y.com',
    name: c.first_name || 'Stan',
  }),
  // The SMS resolver mirrors getServiceContact in these fixtures (no
  // service-contact phones are modeled, so gating never diverges).
  getServiceContactSmsRecipient: (c) => ({
    phone: c.phone !== undefined ? c.phone : '+19410000000',
    email: c.email !== undefined ? c.email : 'x@y.com',
    name: c.first_name || 'Stan',
  }),
  firstNameFrom: (v) => String(v == null ? '' : v).trim().split(/\s+/)[0] || '',
}));

const db = require('../models/db');
const ReviewService = require('../services/review-request');

function valueFor(row, column) { return row[String(column).split('.').pop()]; }

function makeMock(initial = {}, opts = {}) {
  const state = { rows: { customers: [], review_sequences: [], review_requests: [], notification_prefs: [], google_reviews: [], scheduled_services: [], activity_log: [], ...initial } };
  const throwUpdateFor = new Set(opts.throwUpdateFor || []);
  function filtered(q) {
    let rows = [...(state.rows[q.table] || [])];
    rows = rows.filter((r) => q.equals.every(([k, v]) => valueFor(r, k) === v));
    rows = rows.filter((r) => q.notEquals.every(([k, v]) => valueFor(r, k) !== v));
    rows = rows.filter((r) => q.notNull.every((k) => valueFor(r, k) != null));
    rows = rows.filter((r) => q.nulls.every((k) => valueFor(r, k) == null));
    rows = rows.filter((r) => q.ins.every(([k, vs]) => vs.includes(valueFor(r, k))));
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
      table: t, equals: [], notEquals: [], notNull: [], nulls: [], ops: [], ins: [], order: null, limitValue: null,
      where(a, op, v) {
        if (typeof a === 'function') { a(this); return this; }
        if (a && typeof a === 'object') { Object.entries(a).forEach(([k, val]) => this.equals.push([k, val])); return this; }
        if (arguments.length === 3) { if (op === '!=') this.notEquals.push([a, v]); else this.ops.push([a, op, v]); return this; }
        this.equals.push([a, op]); return this;
      },
      orWhere() { return this; },
      whereRaw() { return this; },
      whereNot(c, v) { this.notEquals.push([c, v]); return this; },
      whereIn(c, vs) { this.ins.push([c, vs]); return this; },
      whereNotNull(c) { this.notNull.push(c); return this; },
      whereNull(c) { this.nulls.push(c); return this; },
      leftJoin() { return this; }, select() { return this; },
      orderBy(c, d = 'asc') { this.order = [c, d]; return this; },
      orderByRaw() { return this; }, groupBy() { return this; }, groupByRaw() { return this; },
      limit(n) { this.limitValue = n; return this; },
      async first() { return filtered(this)[0] || null; },
      count() { return { first: async () => ({ count: String(filtered(this).length), c: String(filtered(this).length) }) }; },
      insert(row) {
        if (!state.rows[this.table]) state.rows[this.table] = [];
        const inserted = { id: row.id || `${this.table}-${state.rows[this.table].length + 1}`, ...row };
        state.rows[this.table].push(inserted);
        return { returning: async () => [inserted] };
      },
      async update(patch) { if (throwUpdateFor.has(this.table)) throw new Error('pg blip on update'); const rows = filtered(this); rows.forEach((r) => Object.assign(r, patch)); return rows.length; },
      then(res, rej) { return Promise.resolve(filtered(this)).then(res, rej); },
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
    expect(touch).toMatchObject({ channel: 'sms', template_key: 'friendly_ask', sequence_step: 0, followup_sent: true, status: 'sent' });
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
    expect(mockSendCustomerMessage.mock.calls[0][0].body).toMatch(/great customer/i);
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
      // 2 SMS asks + 1 email ask, all delivered — the cap counts review_requests
      // across channels, not just sms_log.
      review_requests: [
        { customer_id: 'm3', channel: 'sms', sms_sent_at: new Date('2026-01-01') },
        { customer_id: 'm3', channel: 'sms', sms_sent_at: new Date('2026-01-02') },
        { customer_id: 'm3', channel: 'email', sent_at: new Date('2026-01-03') },
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

  test('an already-due later step keeps ~20h spacing after the touch that just sent (no back-to-back asks)', () => {
    // Weekend-shifted Day-3 SMS just fired Monday morning; the Day-4 email's
    // base time (Sunday) is already past — it must NOT fire a minute later.
    const now = new Date('2026-08-03T10:15:00-04:00');
    const at = nextTouchRunAt({ startedAt: WED, step: { day: 4, channel: 'email' }, now });
    expect(at.getTime()).toBe(now.getTime() + 20 * 3600000);
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
