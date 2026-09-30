// Codex r15 P1 (PR #5021): the sibling-split sweep re-runs the exact,
// never-overwriting stamp backfill over recent invoices on every tick, so an
// accept an OLD pod processed after the pre-deploy migration finished (and
// therefore never stamped) is picked up within one tick. This pins the
// wiring: the bound it passes, and that a reconciliation failure never
// blocks the sweep.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-first-application-invoice', () => ({
  ...jest.requireActual('../services/estimate-first-application-invoice'),
  backfillFirstApplicationInvoiceStamps: jest.fn(),
}));

const { backfillFirstApplicationInvoiceStamps } = require('../services/estimate-first-application-invoice');
const logger = require('../services/logger');
const {
  reconcileRecentUnstampedAccepts, RECENT_STAMP_RECONCILE_DAYS,
} = require('../services/first-application-sibling-split');

beforeEach(() => jest.clearAllMocks());

test('runs the exact backfill bounded to the last 14 days on the given connection', async () => {
  backfillFirstApplicationInvoiceStamps.mockResolvedValue({ scanned: 3, stamped: 2, ambiguous: 0 });
  const conn = {};
  const result = await reconcileRecentUnstampedAccepts(conn);
  expect(RECENT_STAMP_RECONCILE_DAYS).toBe(14);
  expect(backfillFirstApplicationInvoiceStamps).toHaveBeenCalledWith(conn, { sinceDays: 14 });
  expect(result).toEqual({ scanned: 3, stamped: 2, ambiguous: 0 });
  expect(logger.info).toHaveBeenCalledTimes(1);
});

test('stays quiet when nothing needed stamping', async () => {
  backfillFirstApplicationInvoiceStamps.mockResolvedValue({ scanned: 3, stamped: 0, ambiguous: 0 });
  await reconcileRecentUnstampedAccepts({});
  expect(logger.info).not.toHaveBeenCalled();
});

test('a reconciliation failure is logged and swallowed so the sweep still runs', async () => {
  backfillFirstApplicationInvoiceStamps.mockRejectedValue(new Error('db down'));
  await expect(reconcileRecentUnstampedAccepts({})).resolves.toBeNull();
  expect(logger.warn).toHaveBeenCalledTimes(1);
});
