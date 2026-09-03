/**
 * Command-center closeout alerts derive from the canonical closeout-status
 * service (#3647), not inline queries. The contract under test:
 *  - alert types/ids/labels are byte-identical to the pre-swap ones (the
 *    admin_alerts lifecycle keys on them);
 *  - `unknown` facts (lookup outages) and `not_required` rules (frozen
 *    posture, backfill, non-performed outcome, catalog) fire NOTHING —
 *    the old `.catch(() => [])` behavior rendered outages as "missing";
 *  - a completed visit with no completion record is ONE card, not three;
 *  - all-retracted application rows still fire (the #3419 rule, now via
 *    the service's `failed` state).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/admin-alerts', () => ({
  syncCommandCenterAlerts: jest.fn(async () => new Map()),
  applyAlertLifecycle: jest.fn((sections) => sections),
  updateAlert: jest.fn(),
  listEvents: jest.fn(async () => []),
}));
jest.mock('../services/closeout-status', () => ({
  getCloseoutStatus: jest.fn(),
}));
const { __private: closeoutAlertsPrivate } = require('../services/closeout-alerts');

const db = require('../models/db');
const { getCloseoutStatus } = require('../services/closeout-status');
const { __private } = require('../routes/admin-command-center');

const DATE = '2026-08-31';

function jobRow(id, status = 'completed') {
  return {
    id,
    customer_id: `cust-${id}`,
    technician_id: 'tech-1',
    service_id: 'cat-pest',
    service_type: 'Quarterly Pest Control',
    scheduled_date: DATE,
    window_start: '09:00',
    window_end: '10:00',
    status,
    first_name: 'Pat',
    last_name: 'Doe',
    tech_name: 'Adam',
  };
}

function installJobs(rows) {
  db.mockImplementation(() => {
    const chain = {
      leftJoin: () => chain,
      where: () => chain,
      whereILike: () => chain,
      select: () => chain,
      orderByRaw: () => chain,
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  });
}

function fact(state, reason, extra = {}) { return { state, reason, ...extra }; }

function closeout(overrides = {}) {
  return {
    found: true,
    requirements: { requiresServiceReport: true, requiresApplicationLog: true, requiredPhotoCount: 0, source: 'catalog_v2', asOf: 'current_catalog' },
    facts: {
      completion: fact('done', 'record_exists'),
      application: fact('done', 'active_application_rows'),
      photos: fact('not_required', 'catalog_zero_required_photos'),
      report: fact('done', 'report_published'),
      reportDelivery: fact('done', 'delivery_sent'),
      invoice: fact('done', 'invoice_exists'),
      invoiceDelivery: fact('done', 'invoice_delivered'),
      comms: fact('done', 'completion_sms_sent'),
      followUp: fact('not_required', 'no_typed_followup_obligation'),
      license: fact('not_required', 'catalog_no_license_required'),
      ...overrides.facts,
    },
    ...overrides,
  };
}

const run = () => __private.getJobsNeedingAttention({ date: DATE, technicianId: null, serviceLine: null });

beforeEach(() => {
  jest.clearAllMocks();
  closeoutAlertsPrivate.memo.clear();
  delete process.env.GATE_CLOSEOUT_MONEY_COMMS_ALERTS;
});

test('money + comms facts render per-visit cards with their labels only behind GATE_CLOSEOUT_MONEY_COMMS_ALERTS', async () => {
  const facts = {
    comms: fact('failed', 'completion_sms_failed'),
    invoice: fact('pending', 'expected_invoice_not_minted'),
    invoiceDelivery: fact('pending', 'no_invoice_yet'),
  };
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({ facts }));
  const moneyTypes = ['completion_notice_failed', 'invoice_not_minted', 'invoice_delivery_incomplete'];
  // Gate off: byte-identical to today — nothing.
  expect((await run()).filter((a) => moneyTypes.includes(a.type))).toEqual([]);
  process.env.GATE_CLOSEOUT_MONEY_COMMS_ALERTS = 'true';
  closeoutAlertsPrivate.memo.clear();
  const cards = (await run()).filter((a) => moneyTypes.includes(a.type));
  expect(cards).toEqual([
    expect.objectContaining({ id: 'svc-1_completion_notice_failed', type: 'completion_notice_failed', label: 'Completion notice failed', severity: 'medium', metadata: expect.objectContaining({ closeoutFact: 'comms', closeoutReason: 'completion_sms_failed' }) }),
    expect.objectContaining({ id: 'svc-1_invoice_not_minted', type: 'invoice_not_minted', label: 'Invoice owed but not minted', metadata: expect.objectContaining({ closeoutFact: 'invoice' }) }),
  ]);
  closeoutAlertsPrivate.memo.clear();
  getCloseoutStatus.mockResolvedValue(closeout({ facts: { invoiceDelivery: fact('failed', 'receipt_delivery_exhausted') } }));
  expect((await run()).filter((a) => moneyTypes.includes(a.type))).toEqual([
    expect.objectContaining({ id: 'svc-1_invoice_delivery_incomplete', label: 'Invoice or receipt delivery incomplete', summary: expect.stringMatching(/failed after retries/) }),
  ]);
});

test('fully closed-out visit fires no closeout alerts', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout());
  const attention = await run();
  expect(attention.filter((a) => String(a.type).startsWith('missing_required'))).toEqual([]);
});

test('open report / all-retracted application / short photos fire the three legacy alert types with identical ids', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({
    facts: {
      report: fact('pending', 'no_report_artifact'),
      application: fact('failed', 'all_application_rows_retracted', { retractedCount: 3 }),
      photos: fact('pending', 'photo_count_short', { required: 2, actual: 1 }),
    },
  }));
  const attention = await run();
  const byType = Object.fromEntries(attention.map((a) => [a.type, a]));
  expect(byType.missing_required_service_report).toMatchObject({ id: 'svc-1_missing_required_service_report', severity: 'medium' });
  expect(byType.missing_required_material_log.summary).toMatch(/retracted/);
  expect(byType.missing_required_photos).toMatchObject({
    metadata: expect.objectContaining({ actualPhotoCount: 1, requiredPhotoCount: 2, closeoutReason: 'photo_count_short' }),
  });
  expect(byType.missing_required_photos.summary).toBe('Completed job has 1 of 2 required closeout photos.');
});

test('two contradiction codes on one visit get DISTINCT ids — one shared id would double-hit the sync dedupe_key (pre-push r17 P1)', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({
    contradictions: [
      { code: 'invoice_on_covered_visit', detail: 'x' },
      { code: 'applications_on_non_performed_visit', detail: 'y' },
    ],
  }));
  const attention = await run();
  const contradictionCards = attention.filter((a) => a.type === 'closeout_contradiction');
  expect(contradictionCards.map((a) => a.id).sort()).toEqual([
    'svc-1_closeout_contradiction:applications_on_non_performed_visit',
    'svc-1_closeout_contradiction:invoice_on_covered_visit',
  ]);
  expect(new Set(contradictionCards.map((a) => a.id)).size).toBe(2);
  expect(contradictionCards[0].label).toBe('Closeout records contradict');
});

test('unknown facts (lookup outage) fire NOTHING — an outage is not a compliance gap', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({
    facts: {
      report: fact('unknown', 'requirements_unavailable'),
      application: fact('unknown', 'application_history_lookup_failed'),
      photos: fact('unknown', 'service_photos_lookup_failed'),
    },
  }));
  expect((await run()).filter((a) => String(a.type).startsWith('missing_required'))).toEqual([]);
});

test('not_required rules (frozen posture / non-performed outcome) fire nothing', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({
    facts: {
      report: fact('not_required', 'frozen_posture_disabled'),
      application: fact('not_required', 'visit_outcome_inspection_only'),
    },
  }));
  expect((await run()).filter((a) => String(a.type).startsWith('missing_required'))).toEqual([]);
});

test('completed visit with no completion record is ONE accurate card, not three', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({
    facts: {
      completion: fact('pending', 'completed_visit_without_record'),
      report: fact('pending', 'awaiting_completion'),
      application: fact('pending', 'awaiting_completion'),
      photos: fact('pending', 'awaiting_completion'),
    },
  }));
  const alerts = (await run()).filter((a) => ['completion_not_committed', 'missing_required_service_report', 'missing_required_material_log', 'missing_required_photos'].includes(a.type));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ type: 'completion_not_committed', id: 'svc-1_completion_not_committed', label: 'Completion not committed', summary: expect.stringMatching(/no completion record/) });
});

test('stuck resumable completion is the single closeout card (codex r1)', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({
    facts: {
      completion: fact('pending', 'completion_side_effects_resumable'),
      report: fact('pending', 'awaiting_completion'),
      application: fact('pending', 'awaiting_completion'),
    },
  }));
  const alerts = (await run()).filter((a) => a.type === 'completion_not_committed');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].summary).toMatch(/stuck mid-commit/);
  // A RUNNING completion stays silent — transient, not a gap.
  closeoutAlertsPrivate.memo.clear();
  getCloseoutStatus.mockResolvedValue(closeout({
    facts: { completion: fact('pending', 'completion_running'), report: fact('pending', 'awaiting_completion') },
  }));
  expect((await run()).filter((a) => String(a.type).startsWith('missing_required'))).toEqual([]);
});

test('published report with exhausted delivery fires the report card; queued delivery stays silent (GH r1)', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout({ facts: { reportDelivery: fact('failed', 'delivery_exhausted', { attempts: 5 }) } }));
  const alerts = (await run()).filter((a) => a.type === 'report_delivery_incomplete');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ id: 'svc-1_report_delivery_incomplete', label: 'Report delivery incomplete', summary: expect.stringMatching(/delivery failed after retries/), metadata: expect.objectContaining({ closeoutFact: 'reportDelivery' }) });
  closeoutAlertsPrivate.memo.clear();
  getCloseoutStatus.mockResolvedValue(closeout({ facts: { reportDelivery: fact('pending', 'delivery_queued') } }));
  expect((await run()).filter((a) => a.type === 'report_delivery_incomplete')).toEqual([]);
});

test('closeout loads are memoised for 90s per visit; outages memoise for a SHORT TTL so a poll does not re-pay the probe fan-out (GH r1, pre-push r14)', async () => {
  installJobs([jobRow('svc-1')]);
  getCloseoutStatus.mockResolvedValue(closeout());
  await run(); await run();
  expect(getCloseoutStatus).toHaveBeenCalledTimes(1);
  closeoutAlertsPrivate.memo.clear();
  getCloseoutStatus.mockRejectedValueOnce(new Error('down')).mockResolvedValue(closeout());
  await run(); await run(); // the failure is cached for the 20s error TTL
  expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
  // A read with a MAPPED fact unknown is an outage too — short-TTL memo (codex r3, pre-push r14).
  closeoutAlertsPrivate.memo.clear();
  getCloseoutStatus.mockReset();
  getCloseoutStatus.mockResolvedValue(closeout({ facts: { photos: fact('unknown', 'service_photos_lookup_failed') }, unavailable: [{ lookup: 'service_photos', error: 'timeout' }] }));
  await run(); await run();
  expect(getCloseoutStatus).toHaveBeenCalledTimes(1);
  // An UNRELATED probe failing with all mapped facts known is fully read → 90s memo (pre-push r14).
  closeoutAlertsPrivate.memo.clear();
  getCloseoutStatus.mockReset();
  getCloseoutStatus.mockResolvedValue(closeout({ unavailable: [{ lookup: 'billing_context', error: 'timeout' }] }));
  await run(); await run();
  expect(getCloseoutStatus).toHaveBeenCalledTimes(1);
});

test('closeout loads are bounded to 2 concurrent (codex r1)', async () => {
  installJobs(Array.from({ length: 12 }, (_, i) => jobRow(`svc-${i}`)));
  let inFlight = 0; let peak = 0;
  getCloseoutStatus.mockImplementation(async () => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return closeout();
  });
  await run();
  expect(getCloseoutStatus).toHaveBeenCalledTimes(12);
  expect(peak).toBeLessThanOrEqual(2);
});

test('getCloseoutStatus throwing or found:false fires nothing (never fabricate a gap)', async () => {
  installJobs([jobRow('svc-1'), jobRow('svc-2')]);
  getCloseoutStatus
    .mockRejectedValueOnce(new Error('db down'))
    .mockResolvedValueOnce({ found: false, lookupFailed: true });
  expect((await run()).filter((a) => String(a.type).startsWith('missing_required'))).toEqual([]);
});

test('non-completed jobs never consult the closeout service', async () => {
  installJobs([jobRow('svc-1', 'confirmed')]);
  await run();
  expect(getCloseoutStatus).not.toHaveBeenCalled();
});
