jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
// delivery-queue requires the real email sender at module load; stub it so the
// queue module loads without pulling SendGrid/template deps into the test.
jest.mock('../services/service-report/email-delivery', () => ({
  sendServiceReportV1Email: jest.fn(),
}));
jest.mock('../services/service-report/failure-alerts', () => ({
  alertServiceReportDeliveryFailed: jest.fn(async () => ({ ok: true })),
}));

const {
  recoverStaleServiceReportDeliveryClaims,
} = require('../services/service-report/delivery-queue');
const {
  alertServiceReportDeliveryFailed,
} = require('../services/service-report/failure-alerts');

// knex stub: only knex.raw is exercised by the recovery sweep. It resolves with
// the rows the `UPDATE ... RETURNING *` would yield.
function makeRawKnex(rows) {
  const knex = () => {
    throw new Error('unexpected table query in recoverStaleServiceReportDeliveryClaims');
  };
  knex.raw = jest.fn(async () => ({ rows }));
  return knex;
}

const NOW = new Date('2026-06-21T12:00:00Z');

describe('recoverStaleServiceReportDeliveryClaims — stale-claim failure alerting', () => {
  beforeEach(() => jest.clearAllMocks());

  test('raises an alert for every row flipped to failed, but not requeued rows', async () => {
    const rows = [
      { id: 'del-1', service_record_id: 'svc-1', customer_id: 'cust-1', attempts: 5, status: 'failed', last_error: 'SendGrid 550 rejected' },
      { id: 'del-2', service_record_id: 'svc-2', customer_id: 'cust-2', attempts: 2, status: 'queued', last_error: null },
      { id: 'del-3', service_record_id: 'svc-3', customer_id: 'cust-3', attempts: 5, status: 'failed', last_error: null },
    ];
    const knex = makeRawKnex(rows);

    const summary = await recoverStaleServiceReportDeliveryClaims(NOW, knex);

    // Return contract unchanged: stale 'sending' rows split into requeued vs failed.
    expect(summary).toEqual({ recovered: 3, retried: 1, failed: 2 });

    // Exactly the two failed rows alert; the requeued row does not.
    expect(alertServiceReportDeliveryFailed).toHaveBeenCalledTimes(2);
    const alertedIds = alertServiceReportDeliveryFailed.mock.calls.map((c) => c[0].delivery.id);
    expect(alertedIds).toEqual(['del-1', 'del-3']);

    // Each alert carries the full delivery row + the shared knex handle so the
    // dedupe/context lookups run against the same connection.
    expect(alertServiceReportDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ id: 'del-1', service_record_id: 'svc-1', attempts: 5 }),
        error: expect.any(Error),
      }),
      expect.objectContaining({ knex }),
    );

    // The row's last_error becomes the alert error message; null falls back to
    // the recovered-claim marker rather than alerting with no context.
    expect(alertServiceReportDeliveryFailed.mock.calls[0][0].error.message).toBe('SendGrid 550 rejected');
    expect(alertServiceReportDeliveryFailed.mock.calls[1][0].error.message).toBe('Recovered stale delivery claim');
  });

  test('does not alert when no stale claim reaches its attempt ceiling', async () => {
    const knex = makeRawKnex([
      { id: 'del-9', service_record_id: 'svc-9', attempts: 1, status: 'queued', last_error: null },
    ]);

    const summary = await recoverStaleServiceReportDeliveryClaims(NOW, knex);

    expect(summary).toEqual({ recovered: 1, retried: 1, failed: 0 });
    expect(alertServiceReportDeliveryFailed).not.toHaveBeenCalled();
  });

  test('missing queue table short-circuits without alerting', async () => {
    const knex = () => {
      throw new Error('unexpected table query');
    };
    const tableErr = new Error('relation "service_report_deliveries" does not exist');
    tableErr.code = '42P01';
    knex.raw = jest.fn(async () => { throw tableErr; });

    const summary = await recoverStaleServiceReportDeliveryClaims(NOW, knex);

    expect(summary).toEqual({ recovered: 0, retried: 0, failed: 0, skipped: true });
    expect(alertServiceReportDeliveryFailed).not.toHaveBeenCalled();
  });
});
