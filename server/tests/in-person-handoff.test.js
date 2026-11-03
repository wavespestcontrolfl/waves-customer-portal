/**
 * Book at the Table, estimate terms at the table (GATE_IN_PERSON_CARD, owner 2026-11-02)
 * — services/in-person-handoff.js:
 *   - markTermsRequired flags the visit's pending card request when its estimate still
 *     needs the acceptance terms (or the Florida notice).
 *   - buildTermsPayload adds `terms` / `consumerNotice` to GET /api/public/secure-card/:token
 *     for a flagged, ready or prepay_selected request only, on any device; a prepay_selected
 *     page withholds its pay link until the terms are recorded. Everything else is the
 *     payload it always was.
 *   - recordCardPageTerms stamps the SAME acceptance-terms fields the online accept stamps
 *     (method 'card_page_terms'), runs none of the accept's side effects, is idempotent.
 *   - assertTermsRecorded is the enforcement the card save and the prepay choice call.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockGates = { inPersonCardLive: jest.fn(), estimateConsumerNoticeLive: jest.fn(), isEnabled: jest.fn() };
jest.mock('../config/feature-gates', () => mockGates);
const mockRoute = {
  acceptanceTermsApplyTo: jest.fn(),
  parseEstimateDataSafe: jest.fn(() => ({})),
  buildPricingBundle: jest.fn(async () => ({})),
  acceptanceTermsScopeFor: jest.fn(() => 'plan'),
};
jest.mock('../routes/estimate-public', () => mockRoute);
const mockNotice = { consumerNoticeBlocksAccept: jest.fn(async () => false), HANDOFF_NOTICE_TEXT: 'Florida notice text.' };
jest.mock('../services/estimate-consumer-notice', () => mockNotice);
const mockAudit = jest.fn(async () => 'audit-1');
const mockStillNeeded = jest.fn();
jest.mock('../services/appointment-card-request', () => ({ secureVisitStillNeedsCard: (...a) => mockStillNeeded(...a) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));

const db = require('../models/db');
const acceptanceTerms = require('../services/acceptance-terms-text');
const { markTermsRequired, buildTermsPayload, assertTermsRecorded, recordCardPageTerms, ACCEPTANCE_METHOD } = require('../services/in-person-handoff');

const TOKEN = 'a'.repeat(22);
const VERSION = acceptanceTerms.ACCEPTANCE_TERMS_VERSION;
const ESTIMATE = { id: 'est-1', customer_id: 'cust-1', status: 'accepted', terms_version: null, estimate_slug: 'EST-2026-0001' };

let rows;
let writes;
let lockedEstimate;

function makeBuilder(table) {
  const q = {};
  q.where = (arg) => {
    if (typeof arg === 'function') arg({ whereNull: () => ({ orWhere: () => ({}) }) });
    return q;
  };
  q.forUpdate = () => q;
  q.whereNull = (col) => { (q.nulls = q.nulls || []).push(col); return q; };
  q.first = jest.fn(async () => (table === 'estimates' && q.locked ? lockedEstimate : rows[table]));
  q.insert = jest.fn(async (data) => { writes.push({ table, op: 'insert', data }); return [{ id: 'acc-1' }]; });
  q.update = jest.fn(async (data) => { writes.push({ table, op: 'update', data }); return 1; });
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = {
    appointment_card_requests: { id: 'req-1', kind: 'visit', status: 'pending', customer_id: 'cust-1', scheduled_service_id: 'visit-1', in_person_terms_required: true },
    scheduled_services: { id: 'visit-1', source_estimate_id: 'est-1', recurring_parent_id: null },
    estimates: { ...ESTIMATE },
  };
  lockedEstimate = { id: 'est-1', customer_id: 'cust-1', status: 'accepted', terms_version: null };
  writes = [];
  mockGates.inPersonCardLive.mockReturnValue(true);
  mockGates.estimateConsumerNoticeLive.mockReturnValue(false);
  mockGates.isEnabled.mockImplementation((gate) => gate === 'estimateAcceptanceTerms');
  mockRoute.acceptanceTermsApplyTo.mockReturnValue(true);
  mockRoute.acceptanceTermsScopeFor.mockReturnValue('plan');
  mockNotice.consumerNoticeBlocksAccept.mockResolvedValue(false);
  mockStillNeeded.mockResolvedValue({ ok: true });
  db.mockImplementation((table) => makeBuilder(table));
  const trxFn = (table) => { const q = makeBuilder(table); q.locked = true; return q; };
  trxFn.raw = (sql) => `RAW:${sql}`;
  db.transaction = jest.fn(async (cb) => cb(trxFn));
});

const block = (data = { state: 'ready', firstName: 'Pat' }) => buildTermsPayload({ token: TOKEN, data });

describe('buildTermsPayload (GET /api/public/secure-card/:token)', () => {
  test('a flagged, ready request adds the terms for the estimate scope, verbatim, on any device', async () => {
    const result = await block();
    expect(result).toEqual({
      terms: {
        estimateRef: 'EST-2026-0001',
        version: VERSION,
        scope: 'plan',
        lines: acceptanceTerms.acceptanceTermsSnapshot('plan').split('\n'),
      },
    });
    expect(mockRoute.acceptanceTermsScopeFor).toHaveBeenCalled();
    // The public payload never carries internal ids.
    expect(JSON.stringify(result)).not.toMatch(/est-1|visit-1|cust-1/);
  });

  test.each([
    ['an unmarked request (the texted flow)', () => { rows.appointment_card_requests = { kind: 'visit', scheduled_service_id: 'visit-1', in_person_terms_required: false }; return block(); }],
    ['a dark gate', () => { mockGates.inPersonCardLive.mockReturnValue(false); return block(); }],
    ['a closed page', () => block({ state: 'closed' })],
    ['a secured page', () => block({ state: 'secured' })],
    ['the acceptance-terms gate off', () => { mockGates.isEnabled.mockReturnValue(false); return block(); }],
    ['terms already recorded', () => { rows.estimates = { ...ESTIMATE, terms_version: 'v2026-09' }; return block(); }],
    ['an estimate not accepted yet', () => { rows.estimates = { ...ESTIMATE, status: 'sent' }; return block(); }],
    ['no linked estimate', () => { rows.scheduled_services = { id: 'visit-1', source_estimate_id: null, recurring_parent_id: null }; return block(); }],
    ['terms that do not apply (commercial, invoice mode)', () => { mockRoute.acceptanceTermsApplyTo.mockReturnValue(false); return block(); }],
    ['a standalone Auto Pay link', () => { rows.appointment_card_requests = { kind: 'customer', scheduled_service_id: null }; return block(); }],
  ])('adds nothing for %s', async (_name, run) => {
    expect(await run()).toBeNull();
  });

  test('with a dark gate nothing is read', async () => {
    mockGates.inPersonCardLive.mockReturnValue(false);
    await block();
    expect(db).not.toHaveBeenCalled();
  });

  test('a prepay_selected page carries the terms and withholds its pay link until they are recorded', async () => {
    // The customer chose prepay on their own phone before the office marked the request.
    const result = await block({ state: 'prepay_selected', payUrl: 'https://portal.test/pay/inv-token' });
    expect(result).toMatchObject({ terms: { estimateRef: 'EST-2026-0001', version: VERSION, scope: 'plan' }, payUrl: null });
    // Once recorded nothing is added, so the page keeps the pay link it was built with.
    rows.estimates = { ...ESTIMATE, terms_version: VERSION };
    expect(await block({ state: 'prepay_selected', payUrl: 'https://portal.test/pay/inv-token' })).toBeNull();
  });

  test('a termite notice alone never withholds the pay link', async () => {
    mockGates.estimateConsumerNoticeLive.mockReturnValue(true);
    mockNotice.consumerNoticeBlocksAccept.mockResolvedValue(true);
    mockRoute.acceptanceTermsApplyTo.mockReturnValue(false);
    expect(await block({ state: 'prepay_selected', payUrl: 'https://portal.test/pay/inv-token' }))
      .toEqual({ consumerNotice: { text: 'Florida notice text.' } });
  });

  test('a termite estimate\'s notice rides on its own; terms stay excluded', async () => {
    mockGates.estimateConsumerNoticeLive.mockReturnValue(true);
    mockNotice.consumerNoticeBlocksAccept.mockResolvedValue(true);
    mockRoute.acceptanceTermsApplyTo.mockReturnValue(false);
    expect(await block()).toEqual({ consumerNotice: { text: 'Florida notice text.' } });
  });

  test('a series occurrence falls back to its parent visit\'s estimate', async () => {
    let call = 0;
    db.mockImplementation((table) => {
      const q = makeBuilder(table);
      if (table === 'scheduled_services') {
        call += 1;
        q.first = jest.fn(async () => (call === 1
          ? { id: 'visit-1', source_estimate_id: null, recurring_parent_id: 'parent-1' }
          : { source_estimate_id: 'est-1' }));
      }
      return q;
    });
    expect((await block()).terms.estimateRef).toBe('EST-2026-0001');
  });
});

const REQUEST = { id: 'req-1', kind: 'visit', status: 'pending', customer_id: 'cust-1', scheduled_service_id: 'visit-1', in_person_terms_required: true };

describe('recordCardPageTerms', () => {
  const args = (over = {}) => ({
    request: { ...REQUEST }, termsVersion: VERSION, termsScope: 'plan', consumerNoticeShown: false, ip: '203.0.113.9', userAgent: 'jest', ...over,
  });

  test('stamps the same fields the online accept stamps, as a card-page record', async () => {
    const result = await recordCardPageTerms(args());
    expect(result).toEqual({ ok: true, recorded: true });
    const byTable = (t) => writes.filter((w) => w.table === t);
    expect(byTable('estimate_acceptances')[0].data).toMatchObject({
      estimate_id: 'est-1',
      customer_id: 'cust-1',
      method: ACCEPTANCE_METHOD,
      terms_version: VERSION,
      terms_text: acceptanceTerms.acceptanceTermsSnapshot('plan'),
      ip: '203.0.113.9',
      user_agent: 'jest',
    });
    expect(byTable('estimate_acceptances')[0].data.accepted_at).toBeInstanceOf(Date);
    expect(byTable('estimates').map((w) => w.data)).toEqual([
      { terms_version: VERSION },
      { estimate_data: expect.stringContaining('rateReviewDisclosedAtAccept') },
    ]);
    expect(byTable('customers')[0].data).toEqual({ accepted_terms_version: VERSION });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      actor_type: 'customer', actor_id: 'cust-1', action: 'estimate.acceptance_terms.card_page',
      resource_type: 'estimate', resource_id: 'est-1', critical: true,
      metadata: expect.objectContaining({ visit_id: 'visit-1', request_id: 'req-1', terms_version: VERSION, scope: 'plan', consumer_notice_shown: false }),
    }));
  });

  test('runs no accept side effects: only the four record tables are written', async () => {
    await recordCardPageTerms(args());
    expect([...new Set(writes.map((w) => w.table))].sort()).toEqual(['customers', 'estimate_acceptances', 'estimates']);
    // No status, accepted_at, schedule, invoice or message write on the estimate.
    for (const w of writes.filter((x) => x.table === 'estimates')) {
      expect(Object.keys(w.data)).not.toEqual(expect.arrayContaining(['status']));
      expect(Object.keys(w.data)).not.toEqual(expect.arrayContaining(['accepted_at']));
    }
  });

  test('a base-scope estimate gets no rate-review stamp', async () => {
    mockRoute.acceptanceTermsScopeFor.mockReturnValue('base');
    await recordCardPageTerms(args({ termsScope: 'base' }));
    expect(writes.filter((w) => w.table === 'estimates').map((w) => w.data)).toEqual([{ terms_version: VERSION }]);
    expect(writes.find((w) => w.table === 'estimate_acceptances').data.terms_text).toBe(acceptanceTerms.acceptanceTermsSnapshot('base'));
  });

  test('is idempotent: a second call, or a terms version already on the estimate, writes nothing', async () => {
    rows.estimates = { ...ESTIMATE, terms_version: VERSION };
    expect(await recordCardPageTerms(args())).toEqual({ ok: true, recorded: false });
    expect(writes).toEqual([]);
    // The terms landed between the read and the lock (a second tap, an online accept).
    rows.estimates = { ...ESTIMATE };
    lockedEstimate = { ...lockedEstimate, terms_version: VERSION };
    expect(await recordCardPageTerms(args())).toEqual({ ok: true, recorded: false });
    expect(writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the scope the customer saw must match the locked estimate: a mismatch is a reloadable 409 and writes nothing', async () => {
    // The page showed 'base' terms; the estimate now computes 'plan' (the rate review sentence).
    const result = await recordCardPageTerms(args({ termsScope: 'base' }));
    expect(result).toEqual({ ok: false, status: 409, code: 'terms_changed', error: 'The terms changed. Reload this page to see them.' });
    expect(writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
    // And the other way round.
    mockRoute.acceptanceTermsScopeFor.mockReturnValue('base');
    expect(await recordCardPageTerms(args({ termsScope: 'plan' }))).toMatchObject({ ok: false, status: 409, code: 'terms_changed' });
    expect(writes).toEqual([]);
  });

  test('the scope is judged on the estimate under the row lock', async () => {
    await recordCardPageTerms(args());
    // The lock read returns the full row, and the scope is computed from it.
    expect(mockRoute.acceptanceTermsScopeFor).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'est-1', status: 'accepted' }), expect.anything(), expect.anything());
  });

  test.each([[undefined], [''], ['wide']])('a missing or unknown scope (%p) is refused as terms_changed', async (termsScope) => {
    expect(await recordCardPageTerms(args({ termsScope }))).toMatchObject({ ok: false, status: 409, code: 'terms_changed' });
    expect(writes).toEqual([]);
  });

  test('a matching base scope records the base text', async () => {
    mockRoute.acceptanceTermsScopeFor.mockReturnValue('base');
    expect(await recordCardPageTerms(args({ termsScope: 'base' }))).toEqual({ ok: true, recorded: true });
  });

  test('a version other than the current one is refused before anything is read', async () => {
    const result = await recordCardPageTerms(args({ termsVersion: 'v2026-01' }));
    expect(result).toMatchObject({ ok: false, status: 409, code: 'TERMS_VERSION_STALE', error: 'The terms changed. Reload this page to see them.' });
    expect(db).not.toHaveBeenCalled();
  });

  test('an unknown visit is 404 and a visit with no estimate records nothing', async () => {
    rows.scheduled_services = undefined;
    expect(await recordCardPageTerms(args())).toMatchObject({ ok: false, status: 404 });
    rows.scheduled_services = { id: 'visit-1', source_estimate_id: null, recurring_parent_id: null };
    expect(await recordCardPageTerms(args())).toEqual({ ok: true, recorded: false });
    expect(writes).toEqual([]);
  });

  test('terms that do not apply are refused', async () => {
    mockRoute.acceptanceTermsApplyTo.mockReturnValue(false);
    expect(await recordCardPageTerms(args())).toMatchObject({ ok: false, status: 409, code: 'terms_not_applicable' });
    expect(writes).toEqual([]);
  });

  test('when the Florida notice applies, the page must have shown it', async () => {
    mockGates.estimateConsumerNoticeLive.mockReturnValue(true);
    mockNotice.consumerNoticeBlocksAccept.mockResolvedValue(true);
    expect(await recordCardPageTerms(args({ consumerNoticeShown: false }))).toMatchObject({ ok: false, status: 409, code: 'consumer_notice_required' });
    expect(writes).toEqual([]);
    expect(await recordCardPageTerms(args({ consumerNoticeShown: true }))).toEqual({ ok: true, recorded: true });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ consumer_notice_shown: true }) }));
  });
});

describe('who may record: only a flagged, open request', () => {
  const run = (request, over = {}) => recordCardPageTerms({ request, termsVersion: VERSION, termsScope: 'plan', consumerNoticeShown: false, ...over });

  test.each([
    ['no request (unknown token)', undefined],
    ['an unflagged request (the texted flow)', { ...REQUEST, in_person_terms_required: false }],
    ['a standalone Auto Pay link', { ...REQUEST, kind: 'customer' }],
  ])('%s is the uniform 404 and writes nothing', async (_n, request) => {
    expect(await run(request)).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(writes).toEqual([]);
  });

  test('a dark gate is the same 404', async () => {
    mockGates.inPersonCardLive.mockReturnValue(false);
    expect(await run({ ...REQUEST })).toMatchObject({ ok: false, status: 404 });
    expect(writes).toEqual([]);
  });

  test('a completed or closed request is a 409 request_closed', async () => {
    expect(await run({ ...REQUEST, status: 'completed' })).toMatchObject({ ok: false, status: 409, code: 'request_closed' });
    expect(writes).toEqual([]);
  });

  test('the request is re-read under the lock: completed meanwhile is a 409 and writes nothing', async () => {
    rows.appointment_card_requests = { ...REQUEST, status: 'completed' };
    expect(await run({ ...REQUEST })).toMatchObject({ ok: false, status: 409, code: 'request_closed' });
    expect(writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a visit that closed after the page loaded (past, cancelled, unpriced, payer) records nothing', async () => {
    mockStillNeeded.mockResolvedValue({ ok: false, code: 'no_longer_needed' });
    expect(await run({ ...REQUEST })).toMatchObject({ ok: false, status: 409, code: 'request_closed' });
    expect(writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
    // The same check the card save runs, on the locked request, inside the write transaction.
    expect(mockStillNeeded).toHaveBeenCalledWith(expect.objectContaining({ id: 'req-1', status: 'pending' }), { database: expect.any(Function) });
  });

  test('a failed visit check is a retryable 503 and records nothing', async () => {
    mockStillNeeded.mockResolvedValue({ ok: false, code: 'completion_failed' });
    expect(await run({ ...REQUEST })).toMatchObject({ ok: false, status: 503, code: 'try_again' });
    expect(writes).toEqual([]);
  });
});

describe('markTermsRequired (the in-person route)', () => {
  const marked = () => writes.filter((w) => w.table === 'appointment_card_requests');

  test('flags the visit\'s pending visit-kind request when its estimate still needs the terms', async () => {
    expect(await markTermsRequired('visit-1')).toEqual({ marked: true });
    expect(marked()[0].data).toMatchObject({ in_person_terms_required: true });
  });

  test('one compare-and-set: pending, visit-kind, no prepay invoice; a miss is refused, not silent', async () => {
    const seen = [];
    db.mockImplementation((table) => {
      const q = makeBuilder(table);
      if (table === 'appointment_card_requests') {
        const where = q.where;
        q.where = (arg) => { seen.push(arg); return where(arg); };
        q.update = jest.fn(async () => 0); // already saved, being saved, or prepay chosen
      }
      return q;
    });
    expect(await markTermsRequired('visit-1')).toEqual({ marked: false, refused: true });
    expect(seen).toContainEqual({ scheduled_service_id: 'visit-1', kind: 'visit', status: 'pending' });
  });

  test('the compare-and-set skips a request with a prepay invoice already chosen', async () => {
    let nulls = null;
    db.mockImplementation((table) => {
      const q = makeBuilder(table);
      if (table === 'appointment_card_requests') {
        const update = q.update;
        q.update = async (data) => { nulls = q.nulls; return update(data); };
      }
      return q;
    });
    await markTermsRequired('visit-1');
    expect(nulls).toEqual(['prepay_invoice_id']);
  });

  test('flags a termite estimate for the separate-signature notice', async () => {
    mockGates.estimateConsumerNoticeLive.mockReturnValue(true);
    mockNotice.consumerNoticeBlocksAccept.mockResolvedValue(true);
    mockRoute.acceptanceTermsApplyTo.mockReturnValue(false);
    expect(await markTermsRequired('visit-1')).toEqual({ marked: true });
  });

  test.each([
    ['terms already recorded', () => { rows.estimates = { ...ESTIMATE, terms_version: VERSION }; }],
    ['an estimate not accepted', () => { rows.estimates = { ...ESTIMATE, status: 'sent' }; }],
    ['terms that do not apply', () => { mockRoute.acceptanceTermsApplyTo.mockReturnValue(false); }],
    ['no linked estimate', () => { rows.scheduled_services = { id: 'visit-1', source_estimate_id: null, recurring_parent_id: null }; }],
    ['the acceptance-terms gate off', () => { mockGates.isEnabled.mockReturnValue(false); }],
  ])('marks nothing for %s', async (_n, arrange) => {
    arrange();
    expect(await markTermsRequired('visit-1')).toEqual({ marked: false });
    expect(marked()).toEqual([]);
  });

  test('a dark gate does nothing', async () => {
    mockGates.inPersonCardLive.mockReturnValue(false);
    expect(await markTermsRequired('visit-1')).toEqual({ marked: false });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('assertTermsRecorded (the enforcement)', () => {
  test('an unmarked request is never held and reads nothing', async () => {
    expect(await assertTermsRecorded({ ...REQUEST, in_person_terms_required: false })).toBeNull();
    expect(await assertTermsRecorded(undefined)).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('a marked request is refused terms_required while the terms are outstanding', async () => {
    expect(await assertTermsRecorded({ ...REQUEST })).toEqual({
      ok: false, status: 409, code: 'terms_required', error: 'Please accept the estimate terms first.',
    });
  });

  test('and let through once the terms are recorded, the terms no longer apply, or the gate is dark', async () => {
    rows.estimates = { ...ESTIMATE, terms_version: VERSION };
    expect(await assertTermsRecorded({ ...REQUEST })).toBeNull();
    rows.estimates = { ...ESTIMATE };
    mockRoute.acceptanceTermsApplyTo.mockReturnValue(false);
    expect(await assertTermsRecorded({ ...REQUEST })).toBeNull();
    mockRoute.acceptanceTermsApplyTo.mockReturnValue(true);
    mockGates.inPersonCardLive.mockReturnValue(false);
    expect(await assertTermsRecorded({ ...REQUEST })).toBeNull();
  });

  test('the full sequence: refused, accept-terms, then allowed', async () => {
    expect(await assertTermsRecorded({ ...REQUEST })).toMatchObject({ code: 'terms_required' });
    expect(await recordCardPageTerms({ request: { ...REQUEST }, termsVersion: VERSION, termsScope: 'plan', consumerNoticeShown: false })).toEqual({ ok: true, recorded: true });
    // The estimate row now carries the version the transaction wrote.
    rows.estimates = { ...ESTIMATE, terms_version: VERSION };
    expect(await assertTermsRecorded({ ...REQUEST })).toBeNull();
  });
});
