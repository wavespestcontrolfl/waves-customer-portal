jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()) }));
jest.mock('../services/call-commitments', () => ({
  listSlotKeptCallIds: jest.fn(async () => []),
  refreshFulfillment: jest.fn(async () => ({ reopened: 0, failed: 0 })),
}));

const { isEnabled } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');
const commitments = require('../services/call-commitments');
const { runSlotProofReconciler } = require('../services/slot-proof-reconciler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
});

test('gate off: nothing is read or written', async () => {
  isEnabled.mockReturnValue(false);
  expect(await runSlotProofReconciler()).toEqual({ skipped: true, reason: 'gated_off' });
  expect(isEnabled).toHaveBeenCalledWith('callCommitments');
  expect(runExclusive).not.toHaveBeenCalled();
  expect(commitments.listSlotKeptCallIds).not.toHaveBeenCalled();
});

test('gate on: refreshes every call whose slot proof lapsed, under its own lock, and counts what reopened (codex #5081 r8 P2)', async () => {
  commitments.listSlotKeptCallIds.mockResolvedValueOnce(['call-a', 'call-b']);
  commitments.refreshFulfillment.mockResolvedValueOnce({ reopened: 1 }).mockResolvedValueOnce({ reopened: 0 });
  expect(await runSlotProofReconciler()).toEqual({ checked: 2, reopened: 1 });
  expect(runExclusive).toHaveBeenCalledWith('slot-proof-reconciler', expect.any(Function));
  expect(commitments.refreshFulfillment.mock.calls.map((c) => c[1])).toEqual(['call-a', 'call-b']);
});

test('a refresh that failed — thrown or a failed lookup — does not stop the others and fails the tick for job health', async () => {
  commitments.listSlotKeptCallIds.mockResolvedValueOnce(['call-a', 'call-b', 'call-c']);
  commitments.refreshFulfillment
    .mockRejectedValueOnce(new Error('connection reset'))
    .mockResolvedValueOnce({ reopened: 0, failed: 1 })
    .mockResolvedValueOnce({ reopened: 1 });
  await expect(runSlotProofReconciler()).rejects.toThrow('Slot proof re-judge incomplete for 2 promise(s)');
  expect(commitments.refreshFulfillment).toHaveBeenCalledTimes(3);
});
