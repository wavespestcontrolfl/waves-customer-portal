/**
 * Book at the Table, hand-off mode (GATE_IN_PERSON_CARD, owner 2026-11-02) — the
 * server half of the D2 terms step (services/in-person-handoff.js):
 *   - GET /api/public/secure-card/:token gains an optional `handoff: { terms }`
 *     block ONLY with ?handoff=1, a live gate, a ready request, and an accepted
 *     estimate that has no recorded terms version. Everything else is the payload
 *     it always was, still 200, no sign-in involved.
 *   - recordInPersonTerms stamps the SAME acceptance-terms fields the online accept
 *     stamps, runs none of the accept's side effects, and is idempotent.
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
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));

const db = require('../models/db');
const acceptanceTerms = require('../services/acceptance-terms-text');
const { buildHandoffBlock, recordInPersonTerms, ACCEPTANCE_METHOD } = require('../services/in-person-handoff');

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
  q.first = jest.fn(async () => (table === 'estimates' && q.locked ? lockedEstimate : rows[table]));
  q.insert = jest.fn(async (data) => { writes.push({ table, op: 'insert', data }); return [{ id: 'acc-1' }]; });
  q.update = jest.fn(async (data) => { writes.push({ table, op: 'update', data }); return 1; });
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = {
    appointment_card_requests: { kind: 'visit', scheduled_service_id: 'visit-1' },
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
  db.mockImplementation((table) => makeBuilder(table));
  const trxFn = (table) => { const q = makeBuilder(table); q.locked = true; return q; };
  trxFn.raw = (sql) => `RAW:${sql}`;
  db.transaction = jest.fn(async (cb) => cb(trxFn));
});

const req = (query = { handoff: '1' }) => ({ query, headers: {} });
const block = (query, data = { state: 'ready', firstName: 'Pat' }) => buildHandoffBlock(req(query), { token: TOKEN, data });

describe('buildHandoffBlock (GET /api/public/secure-card/:token)', () => {
  test('?handoff=1 on a ready request adds the terms for the estimate scope, verbatim', async () => {
    const result = await block();
    expect(result).toEqual({
      terms: {
        estimateRef: 'EST-2026-0001',
        version: VERSION,
        scope: 'plan',
        lines: acceptanceTerms.acceptanceTermsSnapshot('plan').split('\n'),
        consumerNotice: null,
      },
    });
    expect(mockRoute.acceptanceTermsScopeFor).toHaveBeenCalled();
    // The public payload never carries internal ids.
    expect(JSON.stringify(result)).not.toMatch(/est-1|visit-1|cust-1/);
  });

  test.each([
    ['no handoff param', () => block({})],
    ['handoff=0', () => block({ handoff: '0' })],
    ['a dark gate', () => { mockGates.inPersonCardLive.mockReturnValue(false); return block(); }],
    ['a closed page', () => block({ handoff: '1' }, { state: 'closed' })],
    ['a secured page', () => block({ handoff: '1' }, { state: 'secured' })],
    ['the acceptance-terms gate off', () => { mockGates.isEnabled.mockReturnValue(false); return block(); }],
    ['terms already recorded', () => { rows.estimates = { ...ESTIMATE, terms_version: 'v2026-09' }; return block(); }],
    ['an estimate not accepted yet', () => { rows.estimates = { ...ESTIMATE, status: 'sent' }; return block(); }],
    ['no linked estimate', () => { rows.scheduled_services = { id: 'visit-1', source_estimate_id: null, recurring_parent_id: null }; return block(); }],
    ['terms that do not apply (commercial, invoice mode)', () => { mockRoute.acceptanceTermsApplyTo.mockReturnValue(false); return block(); }],
    ['a standalone Auto Pay link', () => { rows.appointment_card_requests = { kind: 'customer', scheduled_service_id: null }; return block(); }],
  ])('adds nothing for %s', async (_name, run) => {
    expect(await run()).toBeNull();
  });

  test('without ?handoff=1 or with a dark gate nothing is read', async () => {
    await block({});
    mockGates.inPersonCardLive.mockReturnValue(false);
    await block();
    expect(db).not.toHaveBeenCalled();
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

describe('recordInPersonTerms', () => {
  const args = (over = {}) => ({
    visitId: 'visit-1', technician: { id: 'tech-1' }, termsVersion: VERSION, termsScope: 'plan', consumerNoticeShown: false, ip: '203.0.113.9', userAgent: 'jest', ...over,
  });

  test('stamps the same fields the online accept stamps, as an in-person record', async () => {
    const result = await recordInPersonTerms(args());
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
      actor_type: 'technician', actor_id: 'tech-1', action: 'estimate.acceptance_terms.in_person',
      resource_type: 'estimate', resource_id: 'est-1', critical: true,
      metadata: expect.objectContaining({ visit_id: 'visit-1', terms_version: VERSION, scope: 'plan', consumer_notice_shown: false }),
    }));
  });

  test('runs no accept side effects: only the four record tables are written', async () => {
    await recordInPersonTerms(args());
    expect([...new Set(writes.map((w) => w.table))].sort()).toEqual(['customers', 'estimate_acceptances', 'estimates']);
    // No status, accepted_at, schedule, invoice or message write on the estimate.
    for (const w of writes.filter((x) => x.table === 'estimates')) {
      expect(Object.keys(w.data)).not.toEqual(expect.arrayContaining(['status']));
      expect(Object.keys(w.data)).not.toEqual(expect.arrayContaining(['accepted_at']));
    }
  });

  test('a base-scope estimate gets no rate-review stamp', async () => {
    mockRoute.acceptanceTermsScopeFor.mockReturnValue('base');
    await recordInPersonTerms(args({ termsScope: 'base' }));
    expect(writes.filter((w) => w.table === 'estimates').map((w) => w.data)).toEqual([{ terms_version: VERSION }]);
    expect(writes.find((w) => w.table === 'estimate_acceptances').data.terms_text).toBe(acceptanceTerms.acceptanceTermsSnapshot('base'));
  });

  test('is idempotent: a second call, or a terms version already on the estimate, writes nothing', async () => {
    rows.estimates = { ...ESTIMATE, terms_version: VERSION };
    expect(await recordInPersonTerms(args())).toEqual({ ok: true, recorded: false });
    expect(writes).toEqual([]);
    // The terms landed between the read and the lock (a second tap, an online accept).
    rows.estimates = { ...ESTIMATE };
    lockedEstimate = { ...lockedEstimate, terms_version: VERSION };
    expect(await recordInPersonTerms(args())).toEqual({ ok: true, recorded: false });
    expect(writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the scope the customer saw must match the locked estimate: a mismatch is a reloadable 409 and writes nothing', async () => {
    // The page showed 'base' terms; the estimate now computes 'plan' (the rate review sentence).
    const result = await recordInPersonTerms(args({ termsScope: 'base' }));
    expect(result).toEqual({ ok: false, status: 409, code: 'terms_changed', error: 'The terms changed. Reload this page to see them.' });
    expect(writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
    // And the other way round.
    mockRoute.acceptanceTermsScopeFor.mockReturnValue('base');
    expect(await recordInPersonTerms(args({ termsScope: 'plan' }))).toMatchObject({ ok: false, status: 409, code: 'terms_changed' });
    expect(writes).toEqual([]);
  });

  test('the scope is judged on the estimate under the row lock', async () => {
    await recordInPersonTerms(args());
    // The lock read returns the full row, and the scope is computed from it.
    expect(mockRoute.acceptanceTermsScopeFor).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'est-1', status: 'accepted' }), expect.anything(), expect.anything());
  });

  test.each([[undefined], [''], ['wide']])('a missing or unknown scope (%p) is refused as terms_changed', async (termsScope) => {
    expect(await recordInPersonTerms(args({ termsScope }))).toMatchObject({ ok: false, status: 409, code: 'terms_changed' });
    expect(writes).toEqual([]);
  });

  test('a matching base scope records the base text', async () => {
    mockRoute.acceptanceTermsScopeFor.mockReturnValue('base');
    expect(await recordInPersonTerms(args({ termsScope: 'base' }))).toEqual({ ok: true, recorded: true });
  });

  test('a version other than the current one is refused before anything is read', async () => {
    const result = await recordInPersonTerms(args({ termsVersion: 'v2026-01' }));
    expect(result).toMatchObject({ ok: false, status: 409, code: 'TERMS_VERSION_STALE', error: 'The terms changed. Reload this page to see them.' });
    expect(db).not.toHaveBeenCalled();
  });

  test('an unknown visit is 404 and a visit with no estimate records nothing', async () => {
    rows.scheduled_services = undefined;
    expect(await recordInPersonTerms(args())).toMatchObject({ ok: false, status: 404 });
    rows.scheduled_services = { id: 'visit-1', source_estimate_id: null, recurring_parent_id: null };
    expect(await recordInPersonTerms(args())).toEqual({ ok: true, recorded: false });
    expect(writes).toEqual([]);
  });

  test('terms that do not apply are refused', async () => {
    mockRoute.acceptanceTermsApplyTo.mockReturnValue(false);
    expect(await recordInPersonTerms(args())).toMatchObject({ ok: false, status: 409, code: 'terms_not_applicable' });
    expect(writes).toEqual([]);
  });

  test('when the Florida notice applies, the page must have shown it', async () => {
    mockGates.estimateConsumerNoticeLive.mockReturnValue(true);
    mockNotice.consumerNoticeBlocksAccept.mockResolvedValue(true);
    expect(await recordInPersonTerms(args({ consumerNoticeShown: false }))).toMatchObject({ ok: false, status: 409, code: 'consumer_notice_required' });
    expect(writes).toEqual([]);
    expect(await recordInPersonTerms(args({ consumerNoticeShown: true }))).toEqual({ ok: true, recorded: true });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ consumer_notice_shown: true }) }));
  });
});
