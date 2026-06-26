// Cadence-engine behavior: start → advance → auto-stop on review → complete.
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true, auditLogId: 'audit-1' }));
const mockEmailSendTemplate = jest.fn(async () => ({ sent: true, message: { id: 'em-1' } }));

jest.mock('../models/db', () => jest.fn());
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
}));

const db = require('../models/db');
const ReviewService = require('../services/review-request');

function valueFor(row, column) { return row[String(column).split('.').pop()]; }

function makeMock(initial = {}) {
  const state = { rows: { customers: [], review_sequences: [], review_requests: [], notification_prefs: [], google_reviews: [], scheduled_services: [], activity_log: [], ...initial } };
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
      async update(patch) { const rows = filtered(this); rows.forEach((r) => Object.assign(r, patch)); return rows.length; },
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
