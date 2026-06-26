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
  getServiceContact: (c) => ({ phone: c.phone || '+19410000000', email: c.email || 'x@y.com', name: c.first_name || 'Stan' }),
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

  test('the final email step completes the sequence', async () => {
    const mock = makeMock({
      customers: [{ id: 'cust-3', first_name: 'Lee', last_name: 'P', email: 'lee@x.com', nearest_location_id: 'sarasota' }],
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
