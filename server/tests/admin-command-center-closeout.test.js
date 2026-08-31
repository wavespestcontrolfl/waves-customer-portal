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
  const alerts = (await run()).filter((a) => String(a.type).startsWith('missing_required'));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ type: 'missing_required_service_report', summary: expect.stringMatching(/no completion record/) });
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
