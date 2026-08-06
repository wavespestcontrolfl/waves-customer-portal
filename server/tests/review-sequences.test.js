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
// Personalized-ask drafter (own suite: review-ask-drafter.test.js). Default
// null = template path, matching the gate-off production posture.
const mockDraftAskBody = jest.fn(async () => null);
const mockDraftEmailIntro = jest.fn(async () => null);
jest.mock('../services/review-ask-drafter', () => ({
  draftAskBody: (...a) => mockDraftAskBody(...a),
  draftEmailIntro: (...a) => mockDraftEmailIntro(...a),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
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
      table: t, equals: [], notEquals: [], notNull: [], nulls: [], ops: [], ins: [], notIns: [], order: null, limitValue: null,
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
      whereNotIn(c, vs) { this.notIns.push([c, vs]); return this; },
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
    expect(plan.map((s) => s.day)).toEqual([0, 4, 6]);
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

  test('a personalized draft becomes the touch body (persisted as custom_body, link substituted)', async () => {
    const draft = 'Hi Stan, Adam here — hope the ants are staying gone after Tuesday. If we earned it: {review_url}. Anything off, just reply here.';
    mockDraftAskBody.mockResolvedValue(draft);
    const mock = makeMock({
      customers: [{ id: 'pd-1', first_name: 'Stan', last_name: 'Q', phone: '+19410000040', nearest_location_id: 'bradenton' }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'pd-1', serviceType: 'pest control', techName: 'Adam', startedBy: 'admin-1' });

    expect(result.started).toBe(true);
    expect(mockDraftAskBody).toHaveBeenCalledWith(expect.objectContaining({ serviceType: 'pest control', techName: 'Adam', recipientFirstName: 'Stan' }));
    const touch = mock.__state.rows.review_requests[0];
    expect(touch.custom_body).toBe(draft);
    // Personalized provenance: the outreach funnel groups by template_key, so
    // a drafted touch must not be credited to the control template.
    expect(touch.template_key).toBe('friendly_ask_personalized');
    // The sent SMS is the draft with {review_url} resolved to the tokenized link.
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).toContain('hope the ants are staying gone after Tuesday');
    expect(sentBody).toContain(`https://portal.test/rate/${touch.token}`);
    expect(sentBody).not.toContain('{review_url}');
  });

  test('a rejected/failed draft falls back to the standard template (ask still sends)', async () => {
    mockDraftAskBody.mockResolvedValue(null);
    const mock = makeMock({
      customers: [{ id: 'pd-2', first_name: 'Ada', last_name: 'V', phone: '+19410000041', nearest_location_id: 'venice' }],
    });
    db.mockImplementation(mock);

    const result = await ReviewService.startReviewSequence({ customerId: 'pd-2', serviceType: 'pest control', techName: 'Adam', startedBy: 'admin-1' });

    expect(result.started).toBe(true);
    const touch = mock.__state.rows.review_requests[0];
    expect(touch.custom_body == null).toBe(true);
    expect(touch.template_key).toBe('friendly_ask');
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).toContain('quick Google review would mean the world'); // friendly_ask template copy
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

  test('a retried cadence step reuses the previously persisted draft instead of re-drafting', async () => {
    const priorDraft = 'Hi Stan, hope the ants stayed gone. If we earned it: {review_url}. Anything off, just reply here.';
    const mock = makeMock({
      customers: [{ id: 'rt-1', first_name: 'Stan', last_name: 'P', phone: '+19410000061', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-rt', customer_id: 'rt-1', status: 'active', current_step: 0, touches_sent: 0,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
        started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000),
      }],
      // A prior attempt already drafted + persisted for this step (send deferred).
      review_requests: [{ id: 'rr-rt', sequence_id: 'seq-rt', sequence_step: 0, customer_id: 'rt-1', channel: 'sms', custom_body: priorDraft, status: 'deferred', created_at: new Date(Date.now() - 1800000) }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    expect(mockDraftAskBody).not.toHaveBeenCalled();
    const retry = mock.__state.rows.review_requests.find((r) => r.id !== 'rr-rt');
    expect(retry.custom_body).toBe(priorDraft);
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).toContain('hope the ants stayed gone');
  });

  test('a retry does NOT reuse a persisted draft when the recipient is no longer the account holder', async () => {
    const priorDraft = 'Hi Stan, hope the ants stayed gone. If we earned it: {review_url}. Anything off, just reply here.';
    const mock = makeMock({
      // SMS now routes to a service contact whose phone differs from the
      // account holder's — the account-holder draft must NOT follow them.
      customers: [{ id: 'rc-1', first_name: 'Stan', last_name: 'P', phone: '+19410000061', service_contact_phone: '+19419999999', nearest_location_id: 'bradenton' }],
      review_sequences: [{
        id: 'seq-rc', customer_id: 'rc-1', status: 'active', current_step: 0, touches_sent: 0,
        plan: JSON.stringify([{ day: 0, channel: 'sms', templateKey: 'friendly_ask' }]),
        started_at: new Date(Date.now() - 3600000), next_run_at: new Date(Date.now() - 60000),
      }],
      review_requests: [{ id: 'rr-rc', sequence_id: 'seq-rc', sequence_step: 0, customer_id: 'rc-1', channel: 'sms', custom_body: priorDraft, status: 'deferred', created_at: new Date(Date.now() - 1800000) }],
    });
    db.mockImplementation(mock);

    const out = await ReviewService.processReviewSequences();

    expect(out.sent).toBe(1);
    expect(mockDraftAskBody).not.toHaveBeenCalled();
    const retry = mock.__state.rows.review_requests.find((r) => r.id !== 'rr-rc');
    expect(retry.custom_body == null).toBe(true);
    const sentBody = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(sentBody).not.toContain('hope the ants stayed gone');
    expect(sentBody).toContain('quick Google review would mean the world'); // friendly_ask template
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
    expect(body).toMatch(/Treatment 1 done/);
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
