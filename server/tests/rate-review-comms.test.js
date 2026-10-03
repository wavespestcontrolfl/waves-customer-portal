/**
 * Annual rate review — COMMS lane (services/rate-review-comms.js).
 *
 * Observable behavior pinned here, against the apply lane's in-memory knex
 * stand-in (helpers/rate-review-apply-fixture.js, real table state):
 *   preview  — one letter per customer, channels on file, every suppression
 *              with its reason (late, inactive, no contact, unapproved), a
 *              digest that moves with the list AND the cost block;
 *   send     — refuses without a cost block or on digest drift, sends ONE
 *              email letter + the SMS pointer per customer, stamps sent_at
 *              (the 30-day clock) on every line, freezes the letter, moves
 *              the ranking rows to sent, never sends twice, releases or
 *              parks a failed send, stops when the gate is flipped off;
 *   letter   — the real email renderer over the seeded template: dollars
 *              per application, prepaid per year AND per application, the
 *              owner's cost block, banned wording absent;
 *   surfaces — the public page review payload (only once delivered) and
 *              the portal's upcoming-rate line;
 *   SMS      — the reused pointer renders within 2 segments, no scheme.
 * The two send legs (price-change-notices.js sendNoticeEmail/SMS) are spied
 * at their module boundary: nothing is sent to anyone. Every id, name,
 * address and number here is invented.
 */
process.env.GATE_RATE_REVIEW = 'true';

const fixture = require('./helpers/rate-review-apply-fixture');

const mockDb = fixture.createFakeDb();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The live-lane read (rate-review-apply.js resolveLiveLane) walks the
// prepaid terms through this helper — the same stand-in the apply suite uses.
jest.mock('../services/annual-prepay-renewals', () => ({
  coveredTermsAsOf: (dbh, today) => dbh('annual_prepay_terms as t')
    .whereIn('t.status', ['active', 'renewal_pending'])
    .where('t.term_start', '<=', today)
    .where('t.term_end', '>=', today),
}));

// The apply's own series-template questions (rate-review-apply.js
// perApplicationTemplateRefusal) read the schedule helpers; a faithful
// reduction of them, as the apply suite uses.
jest.mock('../routes/admin-schedule', () => {
  const { parseTemplateOverrides } = require('../services/recurring-template-overrides');
  const sum = (rows) => (rows || []).reduce((t, a) => t + (Number(a.estimated_price) > 0 ? Number(a.estimated_price) : 0), 0);
  return {
    _test: {
      calculateStoredVisitFinancials: (parent, addonRows, allParentAddonRows) => {
        const primaryGross = Number(parent.primary_line_price);
        let primaryNet = Number.isFinite(primaryGross) && primaryGross > 0 ? Math.max(0, primaryGross - (Number(parent.line_discount_dollars) > 0 ? Number(parent.line_discount_dollars) : 0)) : null;
        if (primaryNet == null) {
          const est = Number(parent.estimated_price);
          primaryNet = Number.isFinite(est) && est > 0 ? Math.max(0, est - sum(allParentAddonRows || addonRows)) : 0;
        }
        const subtotal = Math.round((primaryNet + sum(addonRows)) * 100) / 100;
        let discount = 0;
        if (parent.discount_type === 'percent') discount = Math.round(subtotal * Number(parent.discount_amount || 0)) / 100;
        else if (parent.discount_type === 'fixed') discount = Number(parent.discount_amount || 0);
        return { price: subtotal > 0 ? Math.max(0, Math.round((subtotal - discount) * 100) / 100) : null };
      },
      addonRecursAfterAnchor: (line) => (line?.recurring_pattern || line?.recurringPattern || null) !== 'one_time',
      loadStoredDiscountScope: async () => null,
      parseTemplateOverrides,
      readProvenanceOverrides: () => ({}),
    },
  };
});
process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';

const migration = require('../models/migrations/20261001200000_rate_review_letter_email_template');

jest.mock('../services/email-template-library', () => {
  const actual = jest.requireActual('../services/email-template-library');
  return {
    ...actual,
    loadTemplateByKey: jest.fn(async (key) => {
      const { TEMPLATE } = require('../models/migrations/20261001200000_rate_review_letter_email_template')._private;
      if (key !== TEMPLATE.key) return null;
      return {
        template: {
          template_key: TEMPLATE.key, name: TEMPLATE.name, mode: 'service', status: 'active', active_version_id: 'v1', send_stream: 'transactional_required',
          required_variables: JSON.stringify(TEMPLATE.required), allowed_variables: JSON.stringify([...TEMPLATE.required, ...TEMPLATE.optional]),
        },
        activeVersion: { id: 'v1', subject: TEMPLATE.subject, preview_text: TEMPLATE.preview, blocks: TEMPLATE.blocks, text_body: null },
      };
    }),
  };
});

const PriceChangeNotices = require('../services/price-change-notices');
const comms = require('../services/rate-review-comms');
const apply = require('../services/rate-review-apply');
const { CUSTOMER, ROW, BATCH_KEY, NOW } = fixture;

const COST_BLOCK = 'Technician pay is up [test]% since last January. Product and fuel costs went up too.';

const emailLeg = jest.spyOn(PriceChangeNotices, 'sendNoticeEmail');
const smsLeg = jest.spyOn(PriceChangeNotices, 'sendNoticeSms');

function customer(n, overrides = {}) {
  return fixture.customerRow(n, {
    first_name: `Testcust${n}`, last_name: 'Example', email: `cust${n}@example.com`, phone: `+1555555010${n}`,
    address_line1: `${n}00 Example Way`, active: true, ...overrides,
  });
}

function draft(n, overrides = {}) {
  return fixture.noticeRow(n, { status: 'draft', email_sent: false, sms_sent: false, sent_at: null, notice_token: `${String(n).repeat(32)}`.slice(0, 32), ...overrides });
}

// One open application per per-application notice on its plan line, on its
// effective date (the line-open check reads them through the fixture's
// synthetic _line / _cadence tags).
const parseJsonMeta = (n) => (typeof n.metadata === 'string' ? JSON.parse(n.metadata) : (n.metadata || {}));
function openVisitsFor(notices) {
  const perApp = notices.filter((n) => (n.billing_lane || 'per_application') === 'per_application');
  // ...and each series' completed parent, the template the apply's spawn test reads.
  const parents = perApp.filter((n) => parseJsonMeta(n).series_root_id).map((n) => ({
    id: parseJsonMeta(n).series_root_id, customer_id: n.customer_id, scheduled_date: '2025-12-05', status: 'completed',
    estimated_price: (Number(n.noticed_current_cents ?? 11700) / 100).toFixed(2), primary_line_price: null, discount_type: null, discount_amount: null, discount_dollars: null,
    line_discount_id: null, line_discount_dollars: null, annual_prepay_term_id: null, prepaid_amount: null, is_callback: false, is_recurring: true, recurring_parent_id: null,
    recurring_template_overrides: null, _line: n.family_key, _cadence: 'quarterly',
  }));
  return [...perApp.map((n, i) => ({
    id: `70000000-0000-4000-8000-00000000000${i + 1}`, customer_id: n.customer_id, scheduled_date: n.effective_date, status: 'pending', estimated_price: (Number(n.noticed_current_cents ?? 11700) / 100).toFixed(2),
    is_callback: false, is_recurring: true, recurring_parent_id: parseJsonMeta(n).series_root_id || null, _line: n.family_key, _cadence: 'quarterly',
  })), ...parents];
}

function book({ customers = [customer(1)], notices = [draft(1)], snapshots = null, costBlock = COST_BLOCK } = {}) {
  return {
    scheduled_services: openVisitsFor(notices),
    rate_review_batches: [fixture.batchRow()],
    rate_review_snapshots: snapshots || notices.map((nt, i) => fixture.snapshotRow(i + 1, { id: nt.rate_review_row_id, customer_id: nt.customer_id, notice_id: nt.id, treatment_minutes_median: 31 })),
    rate_review_config: [{ id: 1, cost_block: costBlock }],
    customers,
    price_change_notices: notices,
    notification_prefs: [],
  };
}

const notices = () => mockDb.store.price_change_notices;
const snapshots = () => mockDb.store.rate_review_snapshots;

beforeEach(() => {
  process.env.GATE_RATE_REVIEW = 'true';
  emailLeg.mockReset().mockResolvedValue({ sent: true, attempted: true });
  smsLeg.mockReset().mockResolvedValue({ sent: true, attempted: true });
  mockDb.reset();
});

async function previewDigest() {
  return (await comms.sendPreview(BATCH_KEY, { now: NOW })).digest;
}

describe('gate', () => {
  test('off: preview, letter and send return before any read, nothing sent', async () => {
    mockDb.reset(book());
    process.env.GATE_RATE_REVIEW = 'false';
    expect(await comms.sendPreview(BATCH_KEY, { now: NOW })).toEqual({ ok: false, reason: 'gate_off' });
    expect(await comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW })).toEqual({ ok: false, reason: 'gate_off' });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: 'x', now: NOW })).toEqual({ ok: false, reason: 'gate_off' });
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
    expect(emailLeg).not.toHaveBeenCalled();
    expect(smsLeg).not.toHaveBeenCalled();
  });
});

describe('sendPreview', () => {
  test('one letter per customer with the channels on file and the line it carries', async () => {
    mockDb.reset(book());
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.ok).toBe(true);
    expect(out.costBlockReady).toBe(true);
    expect(out.counts).toMatchObject({ letters: 1, lines: 1, email: 1, sms: 1, suppressedLines: 0, alreadySent: 0 });
    expect(out.customers[0]).toMatchObject({ customerId: CUSTOMER(1), channels: { email: true, sms: true }, reason: null });
    expect(out.customers[0].lines[0]).toMatchObject({ now: '$117 per application', new: '$121 per application (up $4)', effectiveDate: '2026-12-10' });
    expect(out.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('suppressions carry their reason: under 30 days, inactive, no contact, no longer approved', async () => {
    const notices4 = [
      draft(1, { effective_date: '2026-11-25' }),
      draft(2, { customer_id: CUSTOMER(2), rate_review_row_id: ROW(2) }),
      draft(3, { customer_id: CUSTOMER(3), rate_review_row_id: ROW(3) }),
      draft(4, { customer_id: CUSTOMER(4), rate_review_row_id: ROW(4) }),
    ];
    const b = book({ customers: [customer(1), customer(2, { deleted_at: new Date() }), customer(3, { email: null, phone: null }), customer(4)], notices: notices4 });
    b.rate_review_snapshots[3].status = 'green';
    mockDb.reset(b);
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    const by = Object.fromEntries(out.customers.map((c) => [c.customerId, c]));
    expect(by[CUSTOMER(1)].suppressedLines[0].reason).toBe('too_late');
    expect(by[CUSTOMER(2)].reason).toBe('customer_inactive');
    expect(by[CUSTOMER(3)].reason).toBe('no_contact');
    expect(by[CUSTOMER(4)].suppressedLines[0].reason).toBe('not_approved');
    expect(out.counts.letters).toBe(0);
  });

  test('the digest binds the channels and the rendered letter, not only the amounts', async () => {
    mockDb.reset(book({ customers: [customer(1, { phone: null })] }));
    const a = await previewDigest();
    mockDb.store.customers[0].phone = '+15555550109';
    const b = await previewDigest();
    expect(b).not.toBe(a);
    mockDb.store.customers[0].first_name = 'Renamed';
    expect(await previewDigest()).not.toBe(b);
  });

  test('an account whose billing lane changed since the notice was prepared is held (lane_changed)', async () => {
    mockDb.reset(book({ customers: [customer(1, { billing_mode: 'monthly_membership' })] }));
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.customers[0].suppressedLines[0].reason).toBe('lane_changed');
    expect(out.counts.letters).toBe(0);
  });

  test('a rate moved on file since the notice is held (rate_moved), never announced', async () => {
    const n = draft(1, { metadata: { source: 'rate_review', batch_key: BATCH_KEY, first_visit_id: 'v-1', series_root_id: fixture.VISIT(100) } });
    const b = book({ notices: [n] });
    b.scheduled_services = [{ id: 'v-1', scheduled_date: '2026-12-10', status: 'pending', estimated_price: '125.00' }];
    mockDb.reset(b);
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.customers[0].suppressedLines[0].reason).toBe('rate_moved');
  });

  test('a prepaid renewal needs 32 days (the apply writes the successor amount before the 30-day reminder)', () => {
    const plan = (eff) => {
      const notice = draft(1, {
        billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: eff,
        current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
        metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_id: 'term-1', coverage_visits: 4 },
      });
      const data = {
        notices: [notice], snapshots: new Map([[String(notice.id), fixture.snapshotRow(1)]]), customers: new Map([[CUSTOMER(1), customer(1)]]),
        prefs: new Map(), firstVisits: new Map(), declinedTerms: new Set(), liveLanes: new Map([[String(notice.id), 'annual_prepay']]), ratesMoved: new Set(), linesGone: new Map(),
      };
      return comms._private.planBatch(data, { today: '2026-11-02', now: NOW })[0];
    };
    expect(plan('2026-12-03').suppressedLines[0].reason).toBe('too_late'); // 31 days
    expect(plan('2026-12-04').lines).toHaveLength(1); // 32 days
  });

  test('the 30-day floor is inclusive: exactly 30 days out is sendable, 29 is too late', () => {
    const plan = (eff) => {
      const notice = draft(1, { effective_date: eff });
      const data = {
        notices: [notice], snapshots: new Map([[String(notice.id), fixture.snapshotRow(1)]]), customers: new Map([[CUSTOMER(1), customer(1)]]),
        prefs: new Map(), declinedTerms: new Set(), liveLanes: new Map([[String(notice.id), 'per_application']]), ratesMoved: new Set(), linesGone: new Map(),
      };
      return comms._private.planBatch(data, { today: '2026-11-02', now: NOW })[0];
    };
    expect(plan('2026-12-02').lines).toHaveLength(1); // 30 days
    expect(plan('2026-12-01').suppressedLines[0].reason).toBe('too_late'); // 29 days
  });

  test('a plan line cancelled since the notice was prepared (no open application left) is held (line_gone)', async () => {
    mockDb.reset(book());
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).counts.letters).toBe(1);
    mockDb.store.scheduled_services.forEach((v) => { v.status = 'cancelled'; });
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.customers[0].suppressedLines[0].reason).toBe('line_gone');
  });

  test('a later application of the line repriced since the notice holds it too (the apply refuses the whole change)', async () => {
    const b = book();
    b.scheduled_services.push({ ...b.scheduled_services[0], id: '70000000-0000-4000-8000-000000000099', scheduled_date: '2027-03-10', estimated_price: '100.00' });
    mockDb.reset(b);
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).customers[0].suppressedLines[0].reason).toBe('line_gone');
  });

  test('a prepaid term whose renewal date moved since the notice is held (rate_moved)', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15',
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_id: 'term-1', coverage_visits: 4, term_end: '2027-05-14' },
    });
    const b = book({ customers: [customer(1, { billing_mode: 'annual_prepay' })], notices: [prepay] });
    b.annual_prepay_terms = [{ id: 'term-1', customer_id: CUSTOMER(1), status: 'active', prepay_amount: '468.00', term_start: '2026-05-15', term_end: '2027-05-14', renewal_decision: null }];
    mockDb.reset(b);
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).counts.letters).toBe(1);
    mockDb.store.annual_prepay_terms[0].term_end = '2027-06-14';
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).customers[0].suppressedLines[0].reason).toBe('rate_moved');
  });

  test.each([
    ['the term\'s coverage visit count changed', (t) => { t.coverage_visit_count = 6; }],
    ['a different next-term amount is already recorded', (t) => { t.next_term_prepay_amount = '500.00'; }],
    ['the pinned term is no longer live (cancelled)', (t) => { t.status = 'cancelled'; }],
    ['the term\'s amount moved', (t) => { t.prepay_amount = '480.00'; }],
    ['the renewal reminder already went out for the term', (t) => { t.notice_30_sent_at = new Date().toISOString(); }],
  ])('a prepaid line is held when %s — the apply\'s own prepaid checks decide (prepayChecks)', async (_label, mutate) => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15',
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_id: 'term-1', coverage_visits: 4, per_application_current_cents: 11700, term_end: '2027-05-14' },
    });
    const b = book({ customers: [customer(1, { billing_mode: 'annual_prepay' })], notices: [prepay] });
    b.annual_prepay_terms = [{ id: 'term-1', customer_id: CUSTOMER(1), status: 'active', prepay_amount: '468.00', coverage_visit_count: 4, term_start: '2026-05-15', term_end: '2027-05-14', renewal_decision: null }];
    mockDb.reset(b);
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).counts.letters).toBe(1);
    mutate(mockDb.store.annual_prepay_terms[0]);
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.counts.letters).toBe(0);
    expect(out.customers[0].suppressedLines[0].reason).toMatch(/^(rate_moved|lane_changed|renewal_declined)$/);
  });

  test('a customer who turned texts off has no text channel; a last unreachable attempt is flagged', async () => {
    const b = book({ customers: [customer(1, { email: null })], notices: [draft(1, { status: 'unreachable' })] });
    b.notification_prefs = [{ customer_id: CUSTOMER(1), sms_enabled: false }];
    mockDb.reset(b);
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.customers[0]).toMatchObject({ reason: 'no_contact', lastAttemptUnreachable: true });
  });

  test('the digest moves with the cost block, not only the list', async () => {
    mockDb.reset(book());
    const a = await previewDigest();
    mockDb.store.rate_review_config[0].cost_block = `${COST_BLOCK} Edited.`;
    expect(await previewDigest()).not.toBe(a);
  });

  test('approved rows without a notice yet are counted as unscheduled', async () => {
    const b = book();
    b.rate_review_snapshots.push(fixture.snapshotRow(2, { customer_id: CUSTOMER(2), notice_id: null }));
    mockDb.reset(b);
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).unscheduled).toBe(1);
  });
});

describe('sendBatch', () => {
  test('no cost block: refused, nothing sent', async () => {
    mockDb.reset(book({ costBlock: null }));
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toEqual({ ok: false, reason: 'cost_block_missing' });
    expect(emailLeg).not.toHaveBeenCalled();
  });

  test('a digest from before a change refuses, nothing sent', async () => {
    mockDb.reset(book());
    const digest = await previewDigest();
    mockDb.store.price_change_notices[0].noticed_new_cents = 12500;
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW })).toEqual({ ok: false, reason: 'list_changed' });
    expect(emailLeg).not.toHaveBeenCalled();
  });

  test('sends the letter and the pointer, stamps delivery, freezes the letter, marks the row sent — once', async () => {
    mockDb.reset(book());
    const out = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), actorId: null, now: NOW });
    expect(out).toMatchObject({ ok: true, sent: 1, emailed: 1, texted: 1, failed: 0 });
    expect(emailLeg).toHaveBeenCalledTimes(1);
    const emailArgs = emailLeg.mock.calls[0][0];
    expect(emailArgs.templateKey).toBe('billing.rate_review_notice');
    expect(emailArgs.vars).toMatchObject({ line1_now: '$117 per application', line1_new: '$121 per application (up $4)', cost_block: COST_BLOCK });
    expect(emailArgs.vars.notice_url).toMatch(/\/price-change\/1{32}$/);
    expect(smsLeg.mock.calls[0][0]).toMatchObject({ operatorInitiated: true, vars: { price_change_url: emailArgs.vars.notice_url } });
    const n = notices()[0];
    expect(n).toMatchObject({ status: 'sent', email_sent: true, sms_sent: true });
    expect(n.sent_at).toBeInstanceOf(Date);
    const meta = typeof n.metadata === 'string' ? JSON.parse(n.metadata) : n.metadata;
    expect(meta.letter).toMatchObject({ cost_block: COST_BLOCK, lines: [{ current_cents: 11700, new_cents: 12100, effective_date: '2026-12-10' }] });
    expect(snapshots()[0].status).toBe('sent');
    // a second send finds nothing left to send
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toEqual({ ok: false, reason: 'nothing_to_send' });
    expect(emailLeg).toHaveBeenCalledTimes(1);
  });

  test('two reviewed lines on one account: ONE letter carrying both, both rows stamped', async () => {
    const lawn = draft(2, { customer_id: CUSTOMER(1), rate_review_row_id: ROW(2), family_key: 'lawn_care', effective_date: '2026-12-20', noticed_current_cents: 6100, noticed_new_cents: 6400, current_amount_cents: 6100, new_amount_cents: 6400 });
    const b = book({ notices: [draft(1), lawn] });
    b.rate_review_snapshots[1].customer_id = CUSTOMER(1);
    b.rate_review_snapshots[1].family_key = 'lawn_care';
    mockDb.reset(b);
    const out = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(out.sent).toBe(1);
    expect(emailLeg).toHaveBeenCalledTimes(1);
    expect(emailLeg.mock.calls[0][0].vars).toMatchObject({ line1_new: '$121 per application (up $4)', line2_new: '$64 per application (up $3)', effective_date: expect.stringContaining('December 10') });
    expect(notices().map((x) => x.status)).toEqual(['sent', 'sent']);
  });

  test('an uncertain outcome (a provider failure) is held send_uncertain with its words — never auto-retried', async () => {
    mockDb.reset(book());
    emailLeg.mockResolvedValue({ sent: false, attempted: true });
    smsLeg.mockResolvedValue({ sent: false, attempted: false });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ ok: false, uncertain: 1, sent: 0 });
    const n = notices()[0];
    expect(n).toMatchObject({ status: 'send_uncertain', sent_at: null });
    expect((typeof n.metadata === 'string' ? JSON.parse(n.metadata) : n.metadata).pending_letter.payload.cost_block).toBe(COST_BLOCK);
    const preview = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(preview.customers[0].suppressedLines[0].reason).toBe('send_uncertain');
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: preview.digest, now: NOW })).toEqual({ ok: false, reason: 'nothing_to_send' });
    expect(emailLeg).toHaveBeenCalledTimes(1);
    expect(snapshots()[0].status).toBe('approved');
    // the link that email may carry renders the frozen words
    expect(comms.publicReview(n)).toMatchObject({ costBlock: COST_BLOCK, delivered: false, lines: [{ current: '$117', next: '$121' }] });
  });

  test('never handed to a provider: parks unreachable without words, and is sendable again', async () => {
    mockDb.reset(book());
    emailLeg.mockResolvedValue({ sent: false, attempted: false });
    smsLeg.mockResolvedValue({ sent: false, attempted: false });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ unreachable: 1, sent: 0 });
    const n = notices()[0];
    expect(n.status).toBe('unreachable');
    expect((typeof n.metadata === 'string' ? JSON.parse(n.metadata) : n.metadata).pending_letter).toBeUndefined();
    expect(comms.publicReview(n)).toEqual({ unavailable: true });
    emailLeg.mockResolvedValue({ sent: true, attempted: true });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ sent: 1 });
  });

  test('a claim gone stale after a crash is held send_uncertain, never reclaimed', async () => {
    mockDb.reset(book({ notices: [draft(1, { status: 'sending', updated_at: new Date(NOW.getTime() - 60 * 60 * 1000) })] }));
    const preview = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(preview.customers[0].suppressedLines[0].reason).toBe('send_uncertain');
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: preview.digest, now: NOW })).toEqual({ ok: false, reason: 'nothing_to_send' });
    expect(emailLeg).not.toHaveBeenCalled();
  });

  test('the words are frozen on the rows before the provider call', async () => {
    mockDb.reset(book());
    emailLeg.mockImplementation(async () => {
      const meta = notices()[0].metadata;
      expect((typeof meta === 'string' ? JSON.parse(meta) : meta).pending_letter.payload.cost_block).toBe(COST_BLOCK);
      return { sent: true, attempted: true };
    });
    expect((await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).sent).toBe(1);
    const meta = notices()[0].metadata;
    expect((typeof meta === 'string' ? JSON.parse(meta) : meta).pending_letter).toBeUndefined();
  });

  test('a fresh in-flight claim is never re-sent', async () => {
    mockDb.reset(book({ notices: [draft(1, { status: 'sending', updated_at: NOW })] }));
    const preview = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(preview.customers[0].suppressedLines[0].reason).toBe('in_flight');
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: preview.digest, now: NOW })).toEqual({ ok: false, reason: 'nothing_to_send' });
  });

  test('a template published after the preview refuses the send', async () => {
    mockDb.reset(book());
    const digest = await previewDigest();
    const lib = require('../services/email-template-library');
    const original = lib.loadTemplateByKey.getMockImplementation();
    lib.loadTemplateByKey.mockImplementation(async (key) => {
      const out = await original(key);
      return out && { ...out, activeVersion: { ...out.activeVersion, subject: 'A different subject' } };
    });
    try {
      expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW })).toEqual({ ok: false, reason: 'list_changed' });
    } finally { lib.loadTemplateByKey.mockImplementation(original); }
    expect(emailLeg).not.toHaveBeenCalled();
  });

  test('the email leg is pinned to the reviewed template content', async () => {
    mockDb.reset(book());
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(emailLeg.mock.calls[0][0].sendOptions.expectedContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a prepaid renewal the customer declined is held back, never sent', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15',
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_id: 'term-1', coverage_visits: 4, term_end: '2027-05-14' },
    });
    const b = book({ notices: [prepay] });
    b.annual_prepay_terms = [{ id: 'term-1', status: 'active', renewal_decision: 'switch_plan' }];
    mockDb.reset(b);
    const preview = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(preview.customers[0].suppressedLines[0].reason).toBe('renewal_declined');
    expect(preview.counts.letters).toBe(0);
  });

  test('the gate flipped off mid-batch stops the rest', async () => {
    const b = book({ customers: [customer(1), customer(2)], notices: [draft(1), draft(2, { customer_id: CUSTOMER(2), rate_review_row_id: ROW(2) })] });
    mockDb.reset(b);
    const digest = await previewDigest();
    emailLeg.mockImplementation(async () => { process.env.GATE_RATE_REVIEW = 'false'; return { sent: true, attempted: true }; });
    const out = await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW });
    // both run in one concurrency slice; whichever started after the flip is stopped
    expect(out.sent + out.stoppedByGate).toBe(2);
  });
});

describe('the letter (real renderer over the seeded template)', () => {
  test('per application: dollars, the reason from stored facts, the cost block, no banned wording', async () => {
    mockDb.reset(book());
    const out = await comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW });
    expect(out.subject).toBe('Your Waves rate from December 10, 2026');
    const text = out.html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    expect(text).toContain("It's Adam at Waves");
    expect(text).toContain('Pest control · 100 Example Way');
    expect(text).toContain('$117 per application');
    expect(text).toContain('$121 per application (up $4)');
    expect(text).toContain('below what we charge a new customer for the same service today ($121)');
    expect(text).toContain('4 applications at your home, about 31 minutes of treatment each');
    expect(text).toContain(COST_BLOCK);
    expect(text).toContain('View your notice');
    expect(text).not.toMatch(/per visit|monthly|per month|-approved|renewal notice/i);
  });

  test('prepaid: per year AND per application, the current year unchanged', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15',
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_end: '2027-05-14', per_application_current_cents: 11700, per_application_new_cents: 12100 },
    });
    mockDb.reset(book({ notices: [prepay] }));
    const out = await comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW });
    const text = out.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('$468 per year ($117 per application)');
    expect(text).toContain('$484 per year ($121 per application) (up $16)');
    expect(text).toContain('unchanged through May 14, 2027');
    expect(text).toContain('Your prepaid year stays exactly as it is');
  });

  test('a row with no scheduled notice is a 404', async () => {
    const b = book();
    b.rate_review_snapshots[0].notice_id = null;
    mockDb.reset(b);
    await expect(comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW })).rejects.toMatchObject({ status: 404 });
  });

  test('the letter is never replayed from a stored copy (single-shot, gate-checked at the send)', () => {
    const { isSenderRenderedEmail } = require('../services/billing-email-no-replay');
    expect(isSenderRenderedEmail({ template_key: 'billing.rate_review_notice' })).toBe(true);
    // no later stage re-sends it: a provider block raises the final-notice alert
    expect(require('../services/billing-email-no-replay').isFinalSenderRenderedEmail({ template_key: 'billing.rate_review_notice' })).toBe(true);
  });

  test('the seeded template carries no banned wording', () => {
    const blob = JSON.stringify(migration._private.TEMPLATE);
    expect(blob).not.toMatch(/per visit|monthly|-approved|\p{Extended_Pictographic}/iu);
    expect(blob).toContain('Waves Pest Control');
  });
});

describe('letter wording and order', () => {
  const { whyFor, planBatch } = comms._private;
  test('a book-mode list price (cadence_mode) is never stated as the new-customer price', () => {
    const why = whyFor({ billing_lane: 'per_application', cadence_label: 'application' }, { current_rate_cents: 10500, proposed_rate_cents: 11700, list_rate_cents: 11700, list_rate_source: 'cadence_mode' });
    expect(why).not.toMatch(/new customer/);
    expect(why).toBe('This change keeps pace with the costs above.');
  });

  test('a proposal above the new-customer price never claims "not a dollar over it"', () => {
    const why = whyFor({ billing_lane: 'per_application', cadence_label: 'application' }, { current_rate_cents: 11600, proposed_rate_cents: 12000, list_rate_cents: 11700, list_rate_source: 'engine' });
    expect(why).toContain('The new rate of $120 keeps pace with the costs above.');
    expect(why).not.toContain('not a dollar over');
  });

  test('the first application is stated as the rule ("on or after"), never one visit\'s date', async () => {
    const n = draft(1, { metadata: { source: 'rate_review', batch_key: BATCH_KEY, first_visit_id: 'v-1', series_root_id: fixture.VISIT(100) } });
    const b = book({ notices: [n] });
    b.scheduled_services.push({ id: 'v-1', scheduled_date: '2026-12-12', status: 'confirmed', estimated_price: '117.00' });
    mockDb.reset(b);
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    await comms.sendBatch(BATCH_KEY, { expectedDigest: out.digest, now: NOW });
    expect(emailLeg.mock.calls[0][0].vars.line1_first).toBe('on or after December 10, 2026');
  });

  test('lines are ordered by effective date once, for the email and the frozen letter alike', async () => {
    const later = draft(2, { customer_id: CUSTOMER(1), rate_review_row_id: ROW(2), family_key: 'lawn_care', effective_date: '2026-12-20', noticed_current_cents: 6100, noticed_new_cents: 6400, current_amount_cents: 6100, new_amount_cents: 6400 });
    const b = book({ notices: [later, draft(1)] });
    b.rate_review_snapshots[0].customer_id = CUSTOMER(1);
    mockDb.reset(b);
    expect(typeof planBatch).toBe('function');
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(emailLeg.mock.calls[0][0].vars.line1_service).toMatch(/^Pest control/);
    const review = comms.publicReview(notices()[0]);
    expect(review.lines.map((l) => l.effectiveDate)).toEqual(['December 10, 2026', 'December 20, 2026']);
  });
});

describe('customer surfaces', () => {
  test('public review: undelivered is unavailable; delivered renders the frozen letter', async () => {
    mockDb.reset(book());
    expect(comms.publicReview(notices()[0])).toEqual({ unavailable: true });
    expect(comms.publicReview({ rate_review_row_id: null })).toBeNull();
    // delivered by another sender without a frozen letter: the plain page, never a 404
    expect(comms.publicReview({ rate_review_row_id: 'r', sent_at: new Date(), metadata: {} })).toBeNull();
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    const review = comms.publicReview(notices()[0]);
    expect(review).toMatchObject({ costBlock: COST_BLOCK, hasPrepay: false });
    expect(review.lines[0]).toMatchObject({ service: 'Pest control', unit: 'application', current: '$117', next: '$121', change: '$4', effectiveDate: 'December 10, 2026' });
    expect(JSON.stringify(review)).not.toContain('Example Way');
  });

  test('portal: a delivered, unapplied change shows the upcoming rate; drafts and applied ones do not', async () => {
    mockDb.reset(book());
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([
      { service: 'Pest control', unit: 'application', current: '$117', next: '$121', chargeCents: null, chargeDate: null, effectiveDate: '2026-12-10', noticePath: `/price-change/${'1'.repeat(32)}` },
    ]);
    notices()[0].applied_at = new Date();
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
    // a change the nightly apply is holding is not a guaranteed rate
    notices()[0].applied_at = null;
    notices()[0].apply_hold_reason = 'rate_moved_since_notice';
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('send: the email provider call runs under the comms fence and refuses a notice repointed before dispatch', async () => {
    mockDb.reset(book());
    let handoff = null;
    emailLeg.mockImplementation(async (args) => { handoff = args.sendOptions.withProviderHandoff; return { sent: true, attempted: true }; });
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    const dispatch = jest.fn(async () => {});
    const to = 'cust1@example.com';
    expect(await handoff(dispatch, { to })).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    // the recipient is judged under the fence: a corrected address, or a billing contact that moved, is refused
    mockDb.store.customers[0].email = 'corrected1@example.com';
    const moved = jest.fn(async () => {});
    expect(await handoff(moved, { to })).toEqual({ ok: false, reason: 'recipient_changed' });
    expect(await handoff(moved)).toEqual({ ok: false, reason: 'recipient_changed' });
    expect(moved).not.toHaveBeenCalled();
    mockDb.store.customers[0].email = to;
    mockDb.store.price_change_notices[0].customer_id = CUSTOMER(9);
    const late = jest.fn(async () => {});
    expect(await handoff(late, { to })).toEqual({ ok: false, reason: 'notice_repointed' });
    expect(late).not.toHaveBeenCalled();
    // the text leg's last abort point re-reads ownership the same way
    const check = smsLeg.mock.calls[0][0].sendOptions.preDispatchCheck;
    expect(await check()).toMatchObject({ ok: false, code: 'NOTICE_REPOINTED' });
    mockDb.store.price_change_notices[0].customer_id = CUSTOMER(1);
    expect(await check()).toEqual({ ok: true });
  });

  test('send: the text pointer holds the comms + phone fence through dispatch; a notice repointed after the pre-check sends no text and records the hold', async () => {
    mockDb.reset(book());
    emailLeg.mockResolvedValue({ sent: false, attempted: false });
    const dispatch = jest.fn(async () => ({ ok: true }));
    let order = null;
    smsLeg.mockImplementation(async ({ sendOptions }) => {
      // the canonical sender: pre-check passes, then provider preparation runs...
      expect(await sendOptions.preDispatchCheck()).toEqual({ ok: true });
      // ...and a merge undo lands before the locked handoff reaches Twilio
      mockDb.store.price_change_notices[0].customer_id = CUSTOMER(9);
      mockDb.raw.mockClear();
      const verdict = await sendOptions.withSmsHandoff(dispatch);
      order = mockDb.raw.mock.calls.map((c) => String(c[1] && c[1][0]));
      return { sent: false, attempted: false, blockedCode: verdict.code };
    });
    const res = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(dispatch).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, texted: 0, inFlight: 1 });
    expect(smsLeg.mock.calls[0][0].sendOptions.metadata).toEqual({ rate_review_letter: true });
    // customer-comms first, then the phone (the order every SMS authority takes)
    expect(order[0]).toMatch(/^customer-comms:/);
    expect(order[1]).toMatch(/^\+?1?5555550101$/);
    // released untouched (never parked unreachable) with the named reason on the line
    expect(notices()[0]).toMatchObject({ status: 'draft', sms_sent: false, email_sent: false, sent_at: null });
    expect(JSON.parse(notices()[0].metadata).send_hold).toMatchObject({ reason: 'notice_repointed' });
    expect(snapshots()[0].status).not.toBe('sent');
  });

  test('send: a recipient corrected after the leg resolved it is refused inside the email fence — nothing sent, released with the named hold', async () => {
    mockDb.reset(book());
    const dispatch = jest.fn(async () => {});
    smsLeg.mockResolvedValue({ sent: false, attempted: false });
    emailLeg.mockImplementation(async ({ sendOptions }) => {
      mockDb.store.customers[0].email = 'corrected1@example.com'; // landed after the leg resolved cust1@example.com
      mockDb.raw.mockClear();
      const verdict = await sendOptions.withProviderHandoff(dispatch, { to: 'cust1@example.com' });
      expect(verdict).toEqual({ ok: false, reason: 'recipient_changed' });
      // customer-comms, then the address key, held in that order
      expect(mockDb.raw.mock.calls.map((c) => String(c[1][0]))).toEqual([expect.stringMatching(/^customer-comms:/), 'customer-email:cust1@example.com']);
      return { sent: false, attempted: true }; // the library's aborted-before-dispatch shape
    });
    const res = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(dispatch).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, uncertain: 0, inFlight: 1 });
    expect(notices()[0]).toMatchObject({ status: 'draft', email_sent: false, sent_at: null });
    expect(JSON.parse(notices()[0].metadata).send_hold).toMatchObject({ reason: 'recipient_changed' });
  });

  test('send: the text pointer counts as delivered only on provider acceptance', async () => {
    mockDb.reset(book());
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(smsLeg.mock.calls[0][0].requireAccepted).toBe(true);
  });

  test.each([
    ['the account\'s billing lane changed', (st) => { st.customers[0].billing_mode = 'monthly_membership'; }, 'lane_changed'],
    ['the line was repriced', (st) => { st.scheduled_services[0].estimated_price = '130.00'; }, 'line_gone'],
    ['a discount landed on the series', (st) => { st.scheduled_services[0].discount_type = 'percent'; st.scheduled_services[0].discount_dollars = '11.70'; }, 'apply_hold'],
    ['the ranking row is no longer approved', (st) => { st.rate_review_snapshots[0].status = 'green'; }, 'not_approved'],
  ])('send: %s between the preview read and the claim holds the letter — released to draft with the reason, nothing dispatched', async (_label, mutate, reason) => {
    mockDb.reset(book());
    const digest = await previewDigest();
    let fired = false;
    mockDb.rawHandlers.push([/customer-comms|hashtextextended/, () => { if (!fired) { fired = true; mutate(mockDb.store); } return { rows: [] }; }]);
    const res = await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW });
    expect(fired).toBe(true);
    expect(res).toMatchObject({ sent: 0, inFlight: 1 });
    expect(emailLeg).not.toHaveBeenCalled();
    expect(smsLeg).not.toHaveBeenCalled();
    expect(notices()[0]).toMatchObject({ status: 'draft', sent_at: null });
    expect(JSON.parse(notices()[0].metadata).send_hold.reason).toBe(reason);
  });

  test('send: an amount changed on the claimed row since the preview is a line_changed hold, never sent on stale words', async () => {
    mockDb.reset(book());
    const digest = await previewDigest();
    let fired = false;
    mockDb.rawHandlers.push([/customer-comms|hashtextextended/, () => { if (!fired) { fired = true; mockDb.store.price_change_notices[0].noticed_new_cents = 12500; mockDb.store.price_change_notices[0].new_amount_cents = 12500; } return { rows: [] }; }]);
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW })).toMatchObject({ sent: 0, inFlight: 1 });
    expect(emailLeg).not.toHaveBeenCalled();
    expect(JSON.parse(notices()[0].metadata).send_hold.reason).toBe('line_changed');
  });

  test('preview: a structure the apply refuses is held with the apply\'s own reason (apply_hold)', async () => {
    mockDb.reset(book());
    mockDb.store.scheduled_service_addons = [{ id: 'ad-1', scheduled_service_id: mockDb.store.scheduled_services[0].id, estimated_price: '20.00', recurring_pattern: 'one_time' }];
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.counts.letters).toBe(0);
    expect(out.customers[0].suppressedLines[0]).toMatchObject({ reason: 'apply_hold', applyReason: 'visit_has_addons' });
  });

  test.each([
    ['a discount on the series parent while every future visit is flat', (st) => { st.scheduled_services.find((v) => v.status === 'completed').discount_type = 'percent'; st.scheduled_services.find((v) => v.status === 'completed').discount_amount = 10; }, 'series_template_complex'],
    ['a recurring add-on on the series parent', (st) => { st.scheduled_service_addons = [{ id: 'ad-9', scheduled_service_id: st.scheduled_services.find((v) => v.status === 'completed').id, estimated_price: '20.00', recurring_pattern: 'quarterly' }]; }, 'series_template_complex'],
  ])('preview + portal: %s is held with the apply\'s reason before any letter or projected charge', async (_label, mutate, reason) => {
    mockDb.reset(book());
    mutate(mockDb.store);
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.counts.letters).toBe(0);
    expect(out.customers[0].suppressedLines[0]).toMatchObject({ reason: 'apply_hold', applyReason: reason });
    // delivered, the same notice is not shown as upcoming
    mockDb.store.price_change_notices[0].status = 'sent';
    mockDb.store.price_change_notices[0].sent_at = NOW;
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('series price overrides switched off (the gate the apply reads at load): the shared template question answers template_overlay_gate_off', async () => {
    process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'false';
    let isolatedApply;
    jest.isolateModules(() => { isolatedApply = require('../services/rate-review-apply'); });
    process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';
    mockDb.reset(book());
    const visits = mockDb.store.scheduled_services.filter((v) => v.status === 'pending');
    const schedule = require('../routes/admin-schedule')._test;
    expect(await isolatedApply._private.perApplicationTemplateRefusal(mockDb, { visits, noticedNew: 12100, schedule })).toBe('template_overlay_gate_off');
    expect(await apply._private.perApplicationTemplateRefusal(mockDb, { visits, noticedNew: 12100, schedule })).toBeNull();
  });

  test('send: a definite email rejection (certain non-send) returns the lines to a retryable draft with the reason; an ambiguous failure parks as send_uncertain', async () => {
    mockDb.reset(book());
    smsLeg.mockResolvedValue({ sent: false, attempted: false });
    emailLeg.mockResolvedValue({ sent: false, attempted: true, definiteNonSend: true });
    const digest = await previewDigest();
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW })).toMatchObject({ sent: 0, failed: 1, uncertain: 0, ok: false });
    expect(notices()[0]).toMatchObject({ status: 'draft', sent_at: null, email_sent: false });
    expect(JSON.parse(notices()[0].metadata).send_hold.reason).toBe('email_rejected');
    expect(JSON.parse(notices()[0].metadata).pending_letter).toBeUndefined();
    // sendable again once the cause is fixed
    emailLeg.mockResolvedValue({ sent: true, attempted: true });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ sent: 1 });
    // an ambiguous failure is never retried automatically
    mockDb.reset(book());
    emailLeg.mockResolvedValue({ sent: false, attempted: true });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ sent: 0, uncertain: 1 });
    expect(notices()[0].status).toBe('send_uncertain');
  });

  test('send: a text-only customer whose SMS could not be prepared (template missing/inactive) is released to a retryable draft, not parked as send_uncertain', async () => {
    mockDb.reset(book({ customers: [customer(1, { email: null })] }));
    emailLeg.mockResolvedValue({ sent: false, attempted: false });
    smsLeg.mockResolvedValue({ sent: false, attempted: true, definiteNonSend: true });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ sent: 0, failed: 1, uncertain: 0 });
    expect(notices()[0]).toMatchObject({ status: 'draft', sent_at: null });
    expect(JSON.parse(notices()[0].metadata).send_hold.reason).toBe('sms_not_prepared');
    // an ambiguous failure of the sender itself still parks
    mockDb.reset(book({ customers: [customer(1, { email: null })] }));
    smsLeg.mockResolvedValue({ sent: false, attempted: true });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ uncertain: 1 });
  });

  test('send: a notice repointed between provider acceptance and the delivery stamp is settled — never reported sent, never left sending; the stamp holds the comms fence', async () => {
    mockDb.reset(book());
    const digest = await previewDigest();
    emailLeg.mockImplementation(async () => { mockDb.store.price_change_notices[0].customer_id = CUSTOMER(9); return { sent: true, attempted: true }; });
    smsLeg.mockResolvedValue({ sent: false, attempted: false });
    mockDb.raw.mockClear();
    const res = await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW });
    expect(res).toMatchObject({ sent: 0, uncertain: 1, ok: false });
    expect(notices()[0]).toMatchObject({ status: 'send_uncertain', sent_at: null });
    const meta = JSON.parse(notices()[0].metadata);
    expect(meta.delivered_repointed).toMatchObject({ letter_customer_id: CUSTOMER(1) });
    expect(meta.pending_letter).toBeTruthy(); // the delivered words stay behind the token
    expect(snapshots()[0].status).toBe('approved'); // not moved to sent
    // the stamp transaction took the customer-comms lock (after the claim and the legs)
    const locks = mockDb.raw.mock.calls.map((c) => String(c[1] && c[1][0])).filter((k) => k.startsWith('customer-comms:'));
    expect(locks.length).toBeGreaterThanOrEqual(2);
  });

  test('portal: a second same-family series at another cadence does not hide a delivered notice (the reviewed cadence is used)', async () => {
    const b = book({ notices: [draft(1, { status: 'sent', sent_at: NOW })] });
    b.scheduled_services.push({ ...b.scheduled_services[0], id: '70000000-0000-4000-8000-0000000000aa', recurring_parent_id: '30000000-0000-4000-8000-0000000009aa', estimated_price: '140.00', _cadence: 'monthly' });
    mockDb.reset(b);
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toHaveLength(1);
  });

  test('send: the locked text handoff dispatches inside the fence when clear, and refuses a number changed since the claim', async () => {
    mockDb.reset(book());
    const dispatch = jest.fn(async () => ({ ok: true }));
    const verdicts = [];
    smsLeg.mockImplementation(async ({ sendOptions }) => {
      verdicts.push(await sendOptions.withSmsHandoff(dispatch));
      mockDb.store.customers[0].phone = '+15555550177'; // corrected after the leg read it
      verdicts.push(await sendOptions.withSmsHandoff(dispatch));
      mockDb.store.customers[0].phone = '+15555550101';
      mockDb.store.customers[0].active = false;
      verdicts.push(await sendOptions.withSmsHandoff(dispatch));
      return { sent: true, attempted: true };
    });
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(verdicts[0]).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(verdicts[1]).toMatchObject({ ok: false, code: 'RECIPIENT_PHONE_CHANGED' });
    expect(verdicts[2]).toMatchObject({ ok: false, code: 'RECIPIENT_UNAVAILABLE' });
  });

  test('send: a withheld text pointer does not stop the email letter being stamped sent', async () => {
    mockDb.reset(book());
    smsLeg.mockResolvedValue({ sent: false, attempted: false, blockedCode: 'RECIPIENT_PHONE_CHANGED' });
    const res = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(res).toMatchObject({ sent: 1, emailed: 1, texted: 0 });
    expect(notices()[0]).toMatchObject({ status: 'sent', email_sent: true, sms_sent: false });
    expect(JSON.parse(notices()[0].metadata).sms_withheld).toBe('recipient_phone_changed');
  });

  test('portal: a prepaid change whose renewal is already recorded (a successor term) is not upcoming', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15', status: 'sent', sent_at: NOW, applied_at: NOW,
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_id: 'term-1', coverage_visits: 4 },
    });
    const b = book({ customers: [customer(1, { billing_mode: 'annual_prepay' })], notices: [prepay] });
    b.annual_prepay_terms = [
      { id: 'term-1', customer_id: CUSTOMER(1), status: 'active', renewal_decision: null, term_end: '2027-05-14', coverage_service_type: 'Quarterly Pest Control' },
    ];
    mockDb.reset(b);
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toHaveLength(1);
    // a legacy unlabeled term: the successor is matched through the notice's own plan line
    mockDb.store.annual_prepay_terms[0].coverage_service_type = null;
    mockDb.store.annual_prepay_terms.push({ id: 'term-2', customer_id: CUSTOMER(1), status: 'pending', renewed_from_term_id: null, term_start: '2027-05-15', coverage_service_type: 'Quarterly Pest Control' });
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('portal: a change whose account switched billing lanes since is not upcoming', async () => {
    mockDb.reset(book({ notices: [draft(1, { status: 'sent', sent_at: NOW })] }));
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toHaveLength(1);
    mockDb.store.customers[0].billing_mode = 'monthly_membership';
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('send: the recipient is re-read after the claim (a corrected address is the one used)', async () => {
    mockDb.reset(book());
    const digest = await previewDigest();
    mockDb.store.customers[0].email = 'corrected1@example.com';
    await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW });
    expect(emailLeg.mock.calls[0][0].customer.email).toBe('corrected1@example.com');
  });

  test('portal: a per-application change whose first visit was repriced since is not upcoming', async () => {
    const n = draft(1, { status: 'sent', sent_at: NOW, metadata: { source: 'rate_review', batch_key: BATCH_KEY, first_visit_id: 'v-1', series_root_id: fixture.VISIT(100) } });
    const b = book({ notices: [n] });
    b.scheduled_services.push({ id: 'v-1', scheduled_date: '2026-12-10', status: 'pending', estimated_price: '117.00' });
    mockDb.reset(b);
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toHaveLength(1);
    mockDb.store.scheduled_services.find((v) => v.id === 'v-1').estimated_price = '140.00';
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('the claim only lands while the notice still belongs to the letter\'s customer (customer-comms fence)', async () => {
    mockDb.reset(book());
    const digest = await previewDigest();
    // a merge undo repoints the notice after the batch read, just before the claim's fence
    mockDb.rawHandlers.push([/customer-comms|hashtextextended/, () => { mockDb.store.price_change_notices[0].customer_id = CUSTOMER(9); return { rows: [] }; }]);
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW })).toMatchObject({ sent: 0, inFlight: 1 });
    expect(emailLeg).not.toHaveBeenCalled();
  });

  test('portal: a monthly change charges the account dues moved by the delta, not the line rate', async () => {
    const monthly = draft(1, {
      billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: '2026-12-15', status: 'sent', sent_at: NOW,
      current_amount_cents: 4000, new_amount_cents: 4400, noticed_current_cents: 4000, noticed_new_cents: 4400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, current_rate_source: 'ledger_slice', slice_estimates: ['pest_control:'] },
    });
    const b = book({ customers: [customer(1, { monthly_rate: '100.00', billing_day: 1, billing_mode: 'monthly_membership' })], notices: [monthly] });
    b.customer_plan_rates = [{ customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '40.00' }, { customer_id: CUSTOMER(1), family_key: 'lawn_care', monthly_rate: '60.00' }];
    mockDb.reset(b);
    expect((await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW }))[0]).toMatchObject({ unit: 'month', next: '$44', chargeCents: 10400, chargeDate: '2027-01-01' });
    // delivered under 30 days before the effective date: the apply holds it — not upcoming
    mockDb.store.price_change_notices[0].sent_at = new Date('2026-11-25T15:00:00Z');
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
    mockDb.store.price_change_notices[0].sent_at = NOW;
    // the line's rate moved since the notice: the apply would refuse — not upcoming
    mockDb.store.customer_plan_rates[0].monthly_rate = '35.00';
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('portal: two monthly increases on one account project the cumulative dues', async () => {
    const mk = (n, eff) => draft(n, {
      customer_id: CUSTOMER(1), rate_review_row_id: ROW(n), billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: eff, status: 'sent', sent_at: NOW,
      current_amount_cents: 4000, new_amount_cents: 4400, noticed_current_cents: 4000, noticed_new_cents: 4400,
      family_key: n === 1 ? 'pest_control' : 'lawn_care', metadata: { source: 'rate_review', batch_key: BATCH_KEY, current_rate_source: 'ledger_slice', slice_estimates: [n === 1 ? 'pest_control:' : 'lawn_care:'] },
    });
    const bk = book({ customers: [customer(1, { monthly_rate: '100.00', billing_mode: 'monthly_membership' })], notices: [mk(1, '2026-12-15'), mk(2, '2026-12-15')] });
    bk.customer_plan_rates = [{ customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '40.00' }, { customer_id: CUSTOMER(1), family_key: 'lawn_care', monthly_rate: '40.00' }, { customer_id: CUSTOMER(1), family_key: 'mosquito', monthly_rate: '20.00' }];
    mockDb.reset(bk);
    const out = await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW });
    expect(out.map((c) => c.chargeCents)).toEqual([10800, 10800]);
  });

  test('portal: a monthly family whose account line moved to prepaid does not add to the other family\'s next charge', async () => {
    const mk = (n) => draft(n, {
      customer_id: CUSTOMER(1), rate_review_row_id: ROW(n), billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: '2026-12-15', status: 'sent', sent_at: NOW,
      current_amount_cents: 4000, new_amount_cents: 4400, noticed_current_cents: 4000, noticed_new_cents: 4400,
      family_key: n === 1 ? 'pest_control' : 'lawn_care', metadata: { source: 'rate_review', batch_key: BATCH_KEY, current_rate_source: 'ledger_slice', slice_estimates: [n === 1 ? 'pest_control:' : 'lawn_care:'] },
    });
    const bk = book({ customers: [customer(1, { monthly_rate: '100.00', billing_mode: 'monthly_membership' })], notices: [mk(1), mk(2)] });
    bk.customer_plan_rates = [{ customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '40.00' }, { customer_id: CUSTOMER(1), family_key: 'lawn_care', monthly_rate: '40.00' }, { customer_id: CUSTOMER(1), family_key: 'mosquito', monthly_rate: '20.00' }];
    mockDb.reset(bk);
    expect((await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).map((c) => c.chargeCents)).toEqual([10800, 10800]);
    // the lawn line is now covered by a prepaid term: the apply rejects its notice (billing_lane_changed)
    mockDb.store.annual_prepay_terms.push({ id: 'term-9', customer_id: CUSTOMER(1), status: 'active', renewal_decision: null, term_start: '2026-06-01', term_end: '2027-05-31', prepay_amount: '480.00', coverage_service_type: 'Lawn Care' });
    const out = await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW });
    expect(out.map((c) => c.service)).toEqual(['Pest control']);
    expect(out[0].chargeCents).toBe(10400); // only its own +$4, not the hidden family's
  });

  test('portal + preview: a monthly plan replaced at the same price (new accept provenance) is not upcoming and not sendable — the apply\'s plan-identity check', async () => {
    const monthly = draft(1, {
      billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: '2026-12-15', status: 'sent', sent_at: NOW,
      current_amount_cents: 4000, new_amount_cents: 4400, noticed_current_cents: 4000, noticed_new_cents: 4400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, current_rate_source: 'ledger_slice', slice_estimates: ['pest_control:est-1'] },
    });
    const b = book({ customers: [customer(1, { monthly_rate: '40.00', billing_mode: 'monthly_membership' })], notices: [monthly] });
    b.customer_plan_rates = [{ customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '40.00', source_estimate_id: 'est-1' }];
    mockDb.reset(b);
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toHaveLength(1);
    // the plan is re-accepted at the same $40: the writer rejects the old notice (plan_replaced)
    mockDb.store.customer_plan_rates[0].source_estimate_id = 'est-2';
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
    // ...and an unsent monthly letter is held before it is announced
    mockDb.store.price_change_notices[0].status = 'draft';
    mockDb.store.price_change_notices[0].sent_at = null;
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.customers[0].suppressedLines[0].reason).toBe('rate_moved');
    // a notice that never recorded its plan fails closed too
    mockDb.store.customer_plan_rates[0].source_estimate_id = 'est-1';
    const meta = { ...mockDb.store.price_change_notices[0].metadata }; delete meta.slice_estimates;
    mockDb.store.price_change_notices[0].metadata = meta;
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).customers[0].suppressedLines[0].reason).toBe('rate_moved');
  });

  test('portal: a declined prepaid renewal is not upcoming', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15', status: 'sent', sent_at: NOW,
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_id: 'term-1', coverage_visits: 4 },
    });
    const b = book({ notices: [prepay] });
    b.annual_prepay_terms = [{ id: 'term-1', status: 'active', renewal_decision: 'cancel' }];
    mockDb.reset(b);
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('portal: two monthly increases landing on the same debit both count, whatever their effective dates', async () => {
    const mk = (n, eff) => draft(n, {
      customer_id: CUSTOMER(1), rate_review_row_id: ROW(n), billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: eff, status: 'sent', sent_at: NOW,
      current_amount_cents: 4000, new_amount_cents: 4400, noticed_current_cents: 4000, noticed_new_cents: 4400,
      family_key: n === 1 ? 'pest_control' : 'lawn_care', metadata: { source: 'rate_review', batch_key: BATCH_KEY, current_rate_source: 'ledger_slice', slice_estimates: [n === 1 ? 'pest_control:' : 'lawn_care:'] },
    });
    const bk = book({ customers: [customer(1, { monthly_rate: '100.00', billing_day: 1, billing_mode: 'monthly_membership' })], notices: [mk(1, '2026-12-10'), mk(2, '2026-12-20')] });
    bk.customer_plan_rates = [{ customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '40.00' }, { customer_id: CUSTOMER(1), family_key: 'lawn_care', monthly_rate: '40.00' }, { customer_id: CUSTOMER(1), family_key: 'mosquito', monthly_rate: '20.00' }];
    mockDb.reset(bk);
    const out = await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW });
    expect(out.map((c) => [c.chargeDate, c.chargeCents])).toEqual([['2027-01-01', 10800], ['2027-01-01', 10800]]);
  });

  test('portal: a prepaid change stays upcoming after the nightly apply, until its renewal date', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15', status: 'sent', sent_at: NOW, applied_at: NOW,
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
    });
    mockDb.reset(book({ customers: [customer(1, { billing_mode: 'annual_prepay' })], notices: [prepay] }));
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([
      expect.objectContaining({ unit: 'year', current: '$468', next: '$484', chargeCents: null, effectiveDate: '2027-05-15' }),
    ]);
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: new Date('2027-05-16T14:00:00Z') })).toEqual([]);
  });
});

describe('SMS pointer (the existing price_change_notice template, reused unchanged)', () => {
  test('renders within 2 segments with a long date and a real-length notice link, scheme dropped, no emoji', () => {
    const { countSegments } = require('../services/messaging/segment-counter');
    const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
    const body = "Hello {first_name}, it's Waves. Your recurring service price changes on {effective_date}. New price and details: {price_change_url}"
      .replace('{first_name}', 'Christopher')
      .replace('{effective_date}', 'September 30, 2027')
      .replace('{price_change_url}', `https://portal.wavespestcontrol.com/price-change/${'a'.repeat(32)}`);
    const rendered = stripSmsUrlScheme(body);
    expect(rendered).not.toContain('https://');
    expect(rendered).not.toMatch(/\p{Extended_Pictographic}/u);
    const seg = countSegments(rendered);
    expect(seg.encoding).toBe('GSM_7');
    expect(seg.segmentCount).toBeLessThanOrEqual(2);
  });
});
