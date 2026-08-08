/**
 * ReviewService.sendGatedAsk — the single entry point for every UNSCHEDULED
 * review ask (admin one-off + the customer-portal satisfaction prompt).
 *
 * The portal path used to text a bare g.page link with no review_requests row,
 * which meant it was invisible to the already-reviewed flag, the 3-ask cap, the
 * 30-day cooldown, the active-cadence block, and the outreach funnel. These
 * tests pin each of those gates, and pin that a sent ask is tokenized.
 */

const mockSendCustomerMessage = jest.fn(async () => ({ sent: true, auditLogId: 'audit-1' }));

jest.mock('../models/db', () => jest.fn());
const mockGates = { reviewSequences: true, reviewDirectLink: true };
jest.mock('../config/feature-gates', () => ({ isEnabled: (g) => !!mockGates[g], gates: mockGates }));
jest.mock('../services/review-ask-drafter', () => ({
  draftAskBody: async () => null,
  draftEmailIntro: async () => null,
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSendCustomerMessage(...a),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.test' }));
// The advisory lock is exercised by its own suite; here it just runs the body,
// with an opt-in "already held" mode for the concurrency case.
const lockState = { held: false };
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (_key, fn) => (lockState.held ? { skipped: true } : fn()),
}));
jest.mock('../services/customer-contact', () => ({
  getServiceContact: (c) => ({ phone: c.phone, email: c.email, name: c.first_name }),
  getServiceContactSmsRecipient: (c) => ({
    phone: c.phone !== undefined ? c.phone : '+19410000000',
    email: c.email !== undefined ? c.email : 'x@y.com',
    name: c.first_name || 'Sam',
  }),
  firstNameFrom: (v) => String(v == null ? '' : v).trim().split(/\s+/)[0] || '',
}));

const db = require('../models/db');
db.transaction = async (fn) => fn(db);
db.raw = (sql) => ({ __raw: sql });
const ReviewService = require('../services/review-request');

const val = (row, col) => row[String(col).split('.').pop()];

function installMock(initial = {}) {
  const state = {
    rows: {
      customers: [], review_requests: [], review_sequences: [],
      scheduled_services: [], google_reviews: [], activity_log: [], ...initial,
    },
  };
  const cmp = (l, op, v) => {
    // NOT IN follows SQL three-valued semantics loosely: a NULL column passes
    // (matches Postgres only when the list has no NULLs, which ours don't).
    if (op === 'notIn') return l == null || !v.includes(l);
    if (l == null) return false;
    return op === '>' ? l > v : op === '<' ? l < v : op === '>=' ? l >= v : op === '<=' ? l <= v : l === v;
  };
  // knex's .where(builder) groups the callback's clauses; whereNull/orWhere
  // inside it are OR'd, not AND'd onto the outer query. Modeling that matters
  // here: livePortalReviewUrlFor asks for "(expires_at IS NULL OR expires_at >
  // now)", and treating orWhere as a no-op would drop every row that HAS an
  // expiry — the opposite of what the query means.
  function orGroup(fn) {
    const branches = [];
    const sub = {
      whereNull(c) { branches.push((r) => val(r, c) == null); return sub; },
      whereNotNull(c) { branches.push((r) => val(r, c) != null); return sub; },
      where(c, op, v) { branches.push((r) => cmp(val(r, c), arguments.length === 3 ? op : '=', arguments.length === 3 ? v : op)); return sub; },
      orWhere(c, op, v) { return sub.where(c, op, v); },
      orWhereNull(c) { return sub.whereNull(c); },
      orWhereNotNull(c) { return sub.whereNotNull(c); },
    };
    fn.call(sub, sub);
    return (r) => branches.some((b) => b(r));
  }

  function filtered(q) {
    let rows = [...(state.rows[q.table] || [])];
    rows = rows.filter((r) => q.equals.every(([k, v]) => val(r, k) === v));
    rows = rows.filter((r) => q.notNull.every((k) => val(r, k) != null));
    rows = rows.filter((r) => q.nulls.every((k) => val(r, k) == null));
    rows = rows.filter((r) => q.orGroups.every((g) => g(r)));
    rows = rows.filter((r) => q.ops.every(([k, op, v]) => cmp(val(r, k), op, v)));
    if (q.order) {
      const [k, d] = q.order;
      rows.sort((a, b) => {
        const av = val(a, k); const bv = val(b, k);
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (d === 'desc' ? -1 : 1);
      });
    }
    return q.limitValue ? rows.slice(0, q.limitValue) : rows;
  }
  function make(tbl) {
    const t = String(tbl).split(/\s+as\s+/i)[0];
    const q = {
      table: t, equals: [], notNull: [], nulls: [], ops: [], orGroups: [], order: null, limitValue: null,
      where(a, op, v) {
        if (typeof a === 'function') { this.orGroups.push(orGroup(a)); return this; }
        if (a && typeof a === 'object') { Object.entries(a).forEach(([k, x]) => this.equals.push([k, x])); return this; }
        if (arguments.length === 3) { this.ops.push([a, op, v]); return this; }
        this.equals.push([a, op]); return this;
      },
      orWhere() { return this; },
      whereRaw() { return this; },
      whereIn() { return this; },
      whereNotIn(c, vals) { this.ops.push([c, 'notIn', vals]); return this; },
      whereNotNull(c) { this.notNull.push(c); return this; },
      whereNull(c) { this.nulls.push(c); return this; },
      leftJoin() { return this; },
      select() { return this; },
      orderBy(c, d = 'asc') { this.order = [c, d]; return this; },
      orderByRaw() { return this; },
      limit(n) { this.limitValue = n; return this; },
      async first() { return filtered(this)[0] || null; },
      count() {
        return { first: async () => ({ count: String(filtered(this).length) }) };
      },
      async insert(row) {
        const rows = Array.isArray(row) ? row : [row];
        const made = rows.map((r, i) => ({ id: `${t}-${(state.rows[t] || []).length + i + 1}`, ...r }));
        state.rows[t] = [...(state.rows[t] || []), ...made];
        return made;
      },
      async update(patch) {
        const hit = filtered(this);
        hit.forEach((r) => Object.assign(r, patch));
        return hit.length;
      },
      then(res, rej) { return Promise.resolve(filtered(this)).then(res, rej); },
      catch(f) { return Promise.resolve(filtered(this)).catch(f); },
    };
    q.insert = (row) => {
      const p = (async () => {
        const rows = Array.isArray(row) ? row : [row];
        const made = rows.map((r, i) => ({ id: `${t}-${(state.rows[t] || []).length + i + 1}`, ...r }));
        state.rows[t] = [...(state.rows[t] || []), ...made];
        return made;
      })();
      p.returning = () => p;
      return p;
    };
    return q;
  }
  db.mockImplementation((tbl) => make(tbl));
  return state;
}

const CUSTOMER = {
  id: 'cust-1', first_name: 'Testy', last_name: 'Testerson',
  city: 'Parrish', zip: '34219', phone: '+19410000000',
  has_left_google_review: false, deleted_at: null,
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const sentAsk = (over = {}) => ({
  id: `rr-${Math.random().toString(36).slice(2, 8)}`,
  customer_id: 'cust-1', template_key: null, sequence_id: null,
  sms_sent_at: daysAgo(200), sent_at: null, status: 'sent',
  scheduled_for: null, token: null, expires_at: null,
  redirected_at: null, submitted_at: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  lockState.held = false;
  mockGates.reviewSequences = true;
  mockGates.reviewDirectLink = true;
});

describe('sendGatedAsk — gates', () => {
  test('a customer already marked as reviewed is never asked', async () => {
    installMock({ customers: [{ ...CUSTOMER, has_left_google_review: true }] });
    const r = await ReviewService.sendGatedAsk({ customerId: 'cust-1' });
    expect(r.outcome).toBe('already_reviewed');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an archived customer is never asked', async () => {
    installMock({ customers: [{ ...CUSTOMER, deleted_at: new Date() }] });
    expect((await ReviewService.sendGatedAsk({ customerId: 'cust-1' })).outcome).toBe('archived');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an unknown customer is reported, not sent to', async () => {
    installMock({ customers: [] });
    expect((await ReviewService.sendGatedAsk({ customerId: 'nope' })).outcome).toBe('no_customer');
  });

  test('no consented SMS recipient blocks the ask', async () => {
    installMock({ customers: [{ ...CUSTOMER, phone: null }] });
    expect((await ReviewService.sendGatedAsk({ customerId: 'cust-1' })).outcome).toBe('no_contact');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('3 delivered asks inside the 180-day window is at cap', async () => {
    installMock({
      customers: [CUSTOMER],
      review_requests: [
        sentAsk({ sms_sent_at: daysAgo(150) }),
        sentAsk({ sms_sent_at: daysAgo(120) }),
        sentAsk({ sms_sent_at: daysAgo(90) }),
      ],
    });
    expect((await ReviewService.sendGatedAsk({ customerId: 'cust-1' })).outcome).toBe('at_cap');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an ask inside 30 days is in cooldown', async () => {
    installMock({ customers: [CUSTOMER], review_requests: [sentAsk({ sms_sent_at: daysAgo(5) })] });
    expect((await ReviewService.sendGatedAsk({ customerId: 'cust-1' })).outcome).toBe('cooldown');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an active cadence owns the customer while the gate is on', async () => {
    installMock({
      customers: [CUSTOMER],
      review_sequences: [{ id: 'seq-1', customer_id: 'cust-1', status: 'active' }],
    });
    expect((await ReviewService.sendGatedAsk({ customerId: 'cust-1' })).outcome).toBe('in_cadence');

    // Gate off, the cadence cron is frozen — a stranded row must not lock the
    // customer out of one-off asks forever.
    mockGates.reviewSequences = false;
    installMock({
      customers: [CUSTOMER],
      review_sequences: [{ id: 'seq-1', customer_id: 'cust-1', status: 'active' }],
    });
    expect((await ReviewService.sendGatedAsk({ customerId: 'cust-1' })).outcome).toBe('sent');
  });

  test('an already-queued ask is reused, not stacked', async () => {
    const when = new Date(Date.now() + 3600000);
    installMock({
      customers: [CUSTOMER],
      review_requests: [sentAsk({ status: 'pending', sms_sent_at: null, scheduled_for: when })],
    });
    const r = await ReviewService.sendGatedAsk({ customerId: 'cust-1' });
    expect(r.outcome).toBe('already_queued');
    expect(r.nextAllowedAt).toEqual(when);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a concurrent send to the same customer is rejected, not queued', async () => {
    installMock({ customers: [CUSTOMER] });
    lockState.held = true;
    expect((await ReviewService.sendGatedAsk({ customerId: 'cust-1' })).outcome).toBe('concurrent');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('sendGatedAsk — a clean send', () => {
  test('writes a tokenized review_requests row and returns its /go link', async () => {
    const state = installMock({ customers: [CUSTOMER] });
    const r = await ReviewService.sendGatedAsk({
      customerId: 'cust-1', templateId: 'friendly_ask', triggeredBy: 'portal_satisfaction',
    });

    expect(r.outcome).toBe('sent');
    expect(state.rows.review_requests).toHaveLength(1);
    const row = state.rows.review_requests[0];
    expect(row.token).toMatch(/^[a-f0-9]{64}$/);
    expect(row.triggered_by).toBe('portal_satisfaction');
    // Routed by the shared resolver — Parrish, not the default office.
    expect(row.location_id).toBe('parrish');
    expect(r.reviewUrl).toBe(`https://portal.test/api/rate/${row.token}/go`);

    // ...and the text carries the tokenized link, never a bare g.page URL.
    const body = mockSendCustomerMessage.mock.calls[0][0].body;
    expect(body).toContain(`https://portal.test/api/rate/${row.token}/go`);
    expect(body).not.toContain('g.page');
  });

  test('skipLegacyFollowup keeps the fold from adding a Day-3 touch', async () => {
    let state = installMock({ customers: [CUSTOMER] });
    await ReviewService.sendGatedAsk({ customerId: 'cust-1', templateId: 'friendly_ask' });
    // An admin one-off still gets the legacy follow-up.
    expect(state.rows.review_requests[0].followup_sent).toBe(false);

    state = installMock({ customers: [CUSTOMER] });
    await ReviewService.sendGatedAsk({
      customerId: 'cust-1', templateId: 'friendly_ask', skipLegacyFollowup: true,
    });
    expect(state.rows.review_requests[0].followup_sent).toBe(true);
  });

  test('the customer address decides the profile, not the default office', async () => {
    // Downtown Sarasota — the case straight-line distance used to send to the
    // Bradenton profile.
    const state = installMock({
      customers: [{ ...CUSTOMER, city: 'Sarasota', zip: '34236', latitude: 27.336, longitude: -82.545 }],
    });
    await ReviewService.sendGatedAsk({ customerId: 'cust-1', templateId: 'friendly_ask' });
    expect(state.rows.review_requests[0].location_id).toBe('sarasota');
  });
});

describe('livePortalReviewUrlFor', () => {
  test('returns the newest live token', async () => {
    installMock({
      customers: [CUSTOMER],
      review_requests: [
        sentAsk({ token: 'a'.repeat(64), expires_at: new Date(Date.now() + 86400000), created_at: daysAgo(3) }),
        sentAsk({ token: 'b'.repeat(64), expires_at: new Date(Date.now() + 86400000), created_at: daysAgo(1) }),
      ],
    });
    expect(await ReviewService.livePortalReviewUrlFor('cust-1'))
      .toBe(`https://portal.test/api/rate/${'b'.repeat(64)}/go`);
  });

  test('skips expired and already-redeemed tokens', async () => {
    installMock({
      customers: [CUSTOMER],
      review_requests: [
        sentAsk({ token: 'c'.repeat(64), expires_at: daysAgo(1) }),
        sentAsk({ token: 'd'.repeat(64), expires_at: new Date(Date.now() + 86400000), redirected_at: daysAgo(2) }),
        sentAsk({ token: 'e'.repeat(64), expires_at: new Date(Date.now() + 86400000), submitted_at: daysAgo(2) }),
      ],
    });
    expect(await ReviewService.livePortalReviewUrlFor('cust-1')).toBeNull();
  });

  test('skips legacy finalized rows (rated_at / status=rated, both redeemed fields null)', async () => {
    // A delivered legacy non-promoter ask can be finalized via rated_at or
    // status='rated' with redirected_at AND submitted_at both null — handing
    // that token out would bounce the customer to the already-submitted rate
    // page instead of Google (pre-push audit r4b).
    installMock({
      customers: [CUSTOMER],
      review_requests: [
        sentAsk({ token: 'f'.repeat(64), expires_at: new Date(Date.now() + 86400000), rated_at: daysAgo(2) }),
        sentAsk({ token: 'a'.repeat(64), expires_at: new Date(Date.now() + 86400000), status: 'rated', created_at: daysAgo(3) }),
      ],
    });
    expect(await ReviewService.livePortalReviewUrlFor('cust-1')).toBeNull();
  });

  test('never mints a token — a button render is not an ask', async () => {
    const state = installMock({ customers: [CUSTOMER] });
    expect(await ReviewService.livePortalReviewUrlFor('cust-1')).toBeNull();
    expect(state.rows.review_requests).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });
});
