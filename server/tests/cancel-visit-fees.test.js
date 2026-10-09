'use strict';

// The scheduled-visit fee exposure shared by the office cancel dialog
// (previewVisitFees) and the customer's cancel screens (customerLateFeeFacts).
// Regression: the customer preview hardcoded lateCancelFee:null while the
// processor charged the fee, so a customer first saw it after confirming.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockHold = jest.fn();
const mockAppt = jest.fn();
jest.mock('../services/estimate-card-holds', () => ({ cardHoldCancelPreview: (...a) => mockHold(...a) }));
jest.mock('../services/appointment-card-request', () => ({ appointmentCardCancelPreview: (...a) => mockAppt(...a) }));
const mockInvoiceOpen = jest.fn();
jest.mock('../services/invoice', () => ({ previewUnresolvedInvoiceAfterCancelVoid: (...a) => mockInvoiceOpen(...a) }));

const { previewVisitFees, customerLateFeeFacts } = require('../services/cancellation-resolution/visit-fees');

beforeEach(() => {
  mockHold.mockReset().mockResolvedValue({ held: false });
  mockAppt.mockReset().mockResolvedValue({ secured: false });
  mockInvoiceOpen.mockReset().mockResolvedValue(false);
});

describe('customerLateFeeFacts', () => {
  test('no pulled visits: no fee, and no preview call', async () => {
    expect(await customerLateFeeFacts([])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: false });
    expect(mockHold).not.toHaveBeenCalled();
  });

  test('pulled visits with no card on either lane: no fee', async () => {
    expect(await customerLateFeeFacts(['v1:2026-10-09', 'v2:2026-11-09'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: false });
    expect(mockHold).toHaveBeenCalledTimes(2);
    expect(mockHold.mock.calls[0][0]).toBe('v1'); // the key's visit id, not the "id:date" key
  });

  test('a card hold inside its window: the exact dollars the commit charges', async () => {
    mockHold.mockImplementation(async (id) => (id === 'v1' ? { held: true, feeApplies: true, feeAmount: 75 } : { held: false }));
    expect(await customerLateFeeFacts(['v1:2026-10-09', 'v2:2026-11-09'])).toEqual({ lateCancelFee: 75, lateCancelFeeVisits: 1, lateCancelFeeMayApply: false });
  });

  test('a card hold OUTSIDE its window is not a fee', async () => {
    mockHold.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 75 });
    expect(await customerLateFeeFacts(['v1:2026-12-01'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: false });
  });

  test('both lanes sum: a hold on one visit and an appointment card on another', async () => {
    mockHold.mockImplementation(async (id) => (id === 'v1' ? { held: true, feeApplies: true, feeAmount: 75 } : { held: false }));
    mockAppt.mockImplementation(async (id) => (id === 'v2' ? { secured: true, feeApplies: true, feeAmount: 50 } : { secured: false }));
    expect(await customerLateFeeFacts(['v1:d', 'v2:d'])).toEqual({ lateCancelFee: 125, lateCancelFeeVisits: 2, lateCancelFeeMayApply: false });
  });

  test('a fee applies but the amount is unknown: may-apply, never a dollar figure', async () => {
    mockHold.mockResolvedValue({ held: true, feeApplies: true, feeAmount: null, unresolved: true });
    expect(await customerLateFeeFacts(['v1:d'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: true });
  });

  test('a KNOWN amount whose window could not be verified (unresolved) is may-apply, never a promised charge', async () => {
    mockHold.mockResolvedValue({ held: true, feeApplies: true, feeAmount: 75, unresolved: true });
    expect(await customerLateFeeFacts(['v1:d'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: true });
    // one verified + one unverified visit: still no dollar promise
    mockHold.mockImplementation(async (id) => ({ held: true, feeApplies: true, feeAmount: 75, unresolved: id === 'v2' }));
    expect(await customerLateFeeFacts(['v1:d', 'v2:d'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: true });
  });

  test('an invoice still attached to a fee-applying visit: the commit may skip the fee step, so may-apply (Codex r1 P2)', async () => {
    mockHold.mockResolvedValue({ held: true, feeApplies: true, feeAmount: 75 });
    mockInvoiceOpen.mockImplementation(async (id) => id === 'v2');
    expect(await customerLateFeeFacts(['v1:d', 'v2:d'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: true });
    // only fee-applying visits are checked, and a failed invoice read is may-apply too
    mockInvoiceOpen.mockReset().mockRejectedValue(new Error('read failed'));
    expect(await customerLateFeeFacts(['v1:d'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: true });
  });

  test('no fee-applying visit: the invoice read never runs', async () => {
    await customerLateFeeFacts(['v1:d']);
    expect(mockInvoiceOpen).not.toHaveBeenCalled();
  });

  test('a preview lookup that throws is may-apply, never a silent "no fee"', async () => {
    mockHold.mockRejectedValue(new Error('db down'));
    expect(await customerLateFeeFacts(['v1:d'])).toEqual({ lateCancelFee: null, lateCancelFeeVisits: 0, lateCancelFeeMayApply: true });
  });
});

describe('previewVisitFees (office shape, unchanged by the move)', () => {
  test('lists only fee-applying visits with lane, amount and total', async () => {
    mockHold.mockImplementation(async (id) => (id === 'v1' ? { held: true, feeApplies: true, feeAmount: 75 } : { held: false }));
    mockAppt.mockImplementation(async (id) => (id === 'v2' ? { secured: true, feeApplies: false, feeAmount: 75 } : { secured: false }));
    expect(await previewVisitFees(['v1:d', 'v2:d', 'v3:d'])).toEqual({
      applies: true, unresolved: false, total: 75,
      visits: [{ id: 'v1', lane: 'card_hold', feeApplies: true, feeAmount: 75, unresolved: false }],
    });
  });
});
