/**
 * appointment-cancel-impact.js — the deterministic pre-commit impact
 * computation for cancel_appointment (PR A of the cancel-pinned-effects
 * lane). Every rail (fee merge, invoice-void preview, inspection-credit
 * reversal preview) is mocked wholesale here — this suite proves the
 * ORCHESTRATION (fee-rail mapping to the {applies, amount, unresolved, rail}
 * shape authorization-contract.js reads, and the drift-comparison engine),
 * not the internals of those rail modules (covered by invoice.js /
 * inspection-credit.js's own callers and by the authorization-contract
 * suite's fixtures). Synthetic ids/names throughout — no real customer data.
 * No DATABASE_URL required: every DB call is mocked.
 */

let mockAppointmentRow = null;
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    leftJoin: () => db.__qb,
    where: () => db.__qb,
    first: async () => mockAppointmentRow,
  }));
  db.__qb = {
    leftJoin: () => db.__qb,
    where: () => db.__qb,
    first: async () => mockAppointmentRow,
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockCardHoldPreview = jest.fn();
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldCancelPreview: (...a) => mockCardHoldPreview(...a),
}));
const mockMayReseed = jest.fn(() => false);
jest.mock('../services/recurring-series-cancel-reseed', () => ({
  cancelMayReseedPlan: (...a) => mockMayReseed(...a),
}));
const mockApptCardPreview = jest.fn();
jest.mock('../services/appointment-card-request', () => ({
  appointmentCardCancelPreview: (...a) => mockApptCardPreview(...a),
}));
// admin-dispatch.js's mergeCardHoldPreviews is deliberately NOT mocked (same
// pattern as admin-dispatch-card-hold-preview.test.js) — this suite proves
// the actual reference-equality mapping in previewCancelFee against the
// REAL merge, not a stand-in for it.
const mockInvoicePreview = jest.fn();
const mockUnresolvedAfterVoid = jest.fn();
jest.mock('../services/invoice', () => ({
  previewInvoiceVoidForCancelledService: (...a) => mockInvoicePreview(...a),
  previewUnresolvedInvoiceAfterCancelVoid: (...a) => mockUnresolvedAfterVoid(...a),
}));
const mockCreditPreview = jest.fn();
jest.mock('../services/inspection-credit', () => ({
  previewInspectionCreditReversalForBooking: (...a) => mockCreditPreview(...a),
}));
const mockNoticeVerdict = jest.fn();
jest.mock('../services/job-status', () => ({
  previewCancellationNoticeVerdict: (...a) => mockNoticeVerdict(...a),
}));

const {
  computeCancelAppointmentImpact,
  cancelImpactsMatch,
} = require('../services/appointment-cancel-impact');

beforeEach(() => {
  jest.clearAllMocks();
  mockAppointmentRow = {
    id: 'svc-synthetic-1',
    status: 'confirmed',
    scheduled_date: '2026-10-02',
    service_type: 'pest_control',
    first_name: 'Synthia',
    last_name: 'Tester',
  };
  mockInvoicePreview.mockResolvedValue([]);
  mockUnresolvedAfterVoid.mockResolvedValue(false);
  mockCreditPreview.mockResolvedValue(null);
  mockNoticeVerdict.mockResolvedValue('none');
});

test('returns null for an appointment that no longer exists', async () => {
  mockAppointmentRow = null;
  const impact = await computeCancelAppointmentImpact('missing-id');
  expect(impact).toBeNull();
});

test('fee applies: an in-window held card hold wins outright', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: true, feeAmount: 49, unresolved: false, rule: { code: 'in_window' } });
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.appointment).toEqual({
    id: 'svc-synthetic-1', status: 'confirmed', scheduled_date: '2026-10-02',
    service_type: 'pest_control', customer_name: 'Synthia Tester', window: null, address: null,
  });
  expect(impact.fee).toEqual({ applies: true, amount: 49, unresolved: false, rail: 'card_hold', blocked_by_invoice: false });
  // The appointment rail was never even asked — the hold answered outright.
  expect(mockApptCardPreview).not.toHaveBeenCalled();
});

test('fee does not apply: an outside-window card hold is still a card rail', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 49, rule: { code: 'outside_window' } });

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.fee).toEqual({ applies: false, amount: 49, unresolved: false, rail: 'card_hold', blocked_by_invoice: false });
});

test('fee does not apply: a PARKED card hold is still a card rail', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 49, parked: true, rule: { code: 'hold_parked' } });

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.fee).toEqual({ applies: false, amount: 49, unresolved: false, rail: 'card_hold', blocked_by_invoice: false });
});

test('fee rail is the appointment card when no hold exists and the card is secured', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
  mockApptCardPreview.mockResolvedValue({ secured: true, feeApplies: true, feeAmount: 49, rule: { code: 'in_window' } });

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.fee).toEqual({ applies: true, amount: 49, unresolved: false, rail: 'appointment_card', blocked_by_invoice: false });
});

test('no card at all: fee rail is none and nothing is flagged', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.fee).toEqual({ applies: false, amount: null, unresolved: false, rail: 'none', blocked_by_invoice: false });
});

test('an unresolved hold lookup is reported, never silently treated as no fee', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: true, feeAmount: null, unresolved: true, rule: { code: 'unresolved', willCharge: null } });
  // The appointment rail must say "definitely no charge" (willCharge: false)
  // for the merge to defer to it over an unresolved hold — mirrors
  // admin-dispatch-card-hold-preview.test.js's own fixture convention.
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card', willCharge: false } });

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.fee.unresolved).toBe(true);
  expect(impact.fee.applies).toBe(true);
});

test('invoice void: the exact set is passed through with amounts and ids', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  mockInvoicePreview.mockResolvedValue([
    { id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 0, deposit_credit: 0, payment_intent: false },
  ]);

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.invoices).toEqual([
    { id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 0, deposit_credit: 0, payment_intent: false },
  ]);
});

test('invoice void: none, when nothing is voidable', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  mockInvoicePreview.mockResolvedValue([]);

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.invoices).toEqual([]);
});

test('inspection credit reversal rides through untouched (reverse + deferred cases)', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  mockCreditPreview.mockResolvedValue([
    { id: 'offer-1', amount: 75, would_reverse: true, deferred: false },
    { id: 'offer-2', amount: 75, would_reverse: false, deferred: true },
  ]);

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.inspection_credit_reversal).toEqual([
    { id: 'offer-1', amount: 75, would_reverse: true, deferred: false },
    { id: 'offer-2', amount: 75, would_reverse: false, deferred: true },
  ]);
});

test('the credit and fee gates see POST-void state: invoices the void would resolve are passed through as resolved', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: true, feeAmount: 49, unresolved: false, rule: { code: 'in_window' } });
  mockInvoicePreview.mockResolvedValue([
    { id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 0 },
  ]);

  await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(mockUnresolvedAfterVoid).toHaveBeenCalledWith('svc-synthetic-1', { voidedInvoiceIds: ['inv-1'] });
  expect(mockCreditPreview).toHaveBeenCalledWith('svc-synthetic-1', { voidedInvoiceIds: ['inv-1'] });
});

test('an invoice still holding money after the void blocks the fee step (rail verdict kept for the office)', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: true, feeAmount: 49, unresolved: false, rule: { code: 'in_window' } });
  mockUnresolvedAfterVoid.mockResolvedValue(true);

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.fee).toEqual({ applies: true, amount: 49, unresolved: false, rail: 'card_hold', blocked_by_invoice: true });
});

test.each([
  ['the invoice-void preview', () => mockInvoicePreview.mockRejectedValue(new Error('invoice read failed'))],
  ['the post-void invoice gate', () => mockUnresolvedAfterVoid.mockRejectedValue(new Error('gate read failed'))],
  ['the credit-reversal preview', () => mockCreditPreview.mockRejectedValue(new Error('offer read failed'))],
  ['the card-hold preview', () => mockCardHoldPreview.mockRejectedValue(new Error('hold read failed'))],
])('a failed read in %s makes the whole impact undeterminable (throws), never "no effect"', async (_label, arrange) => {
  mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  arrange();
  await expect(computeCancelAppointmentImpact('svc-synthetic-1')).rejects.toThrow();
});

test('invoices carry the deposit credit the void would restore', async () => {
  mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
  mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  mockInvoicePreview.mockResolvedValue([
    { id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 50, credit_applied: 0, deposit_credit: 75 },
  ]);

  const impact = await computeCancelAppointmentImpact('svc-synthetic-1');

  expect(impact.invoices[0].deposit_credit).toBe(75);
});

describe('appointment.window (Codex round-3/round-4 P1: show the visit\'s time so same-day visits are distinguishable, from the AUTHORITATIVE bounds)', () => {
  const noCard = () => {
    mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
    mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  };

  // Codex round-4 P1: the IB reschedule writer (tools.js ~3517) updates
  // window_start/window_end on every move but does NOT also rewrite the
  // legacy time_window label — a stale label must never win over the
  // bounds that actually moved.
  test('prefers formatting window_start–window_end over a stale stored time_window label', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, time_window: 'Morning', window_start: '13:00:00', window_end: '15:00:00' };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.appointment.window).toBe('1:00 PM–3:00 PM');
  });

  test('falls back to the stored time_window label only when no window_start bound is stored at all', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, time_window: 'Morning', window_start: null, window_end: null };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.appointment.window).toBe('Morning');
  });

  test('window_start only (no window_end): a single formatted time', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, time_window: null, window_start: '09:00:00', window_end: null };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.appointment.window).toBe('9:00 AM');
  });

  test('neither time_window nor window_start: null, not a broken string', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, time_window: null, window_start: null, window_end: null };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.appointment.window).toBeNull();
  });
});

describe('appointment.address (Codex round-4 P1: show the visit\'s effective service address, since switchAppointmentProperty can move it off the customer\'s primary)', () => {
  const noCard = () => {
    mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
    mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  };

  test('prefers the stamped service_address_* columns on the row', async () => {
    noCard();
    mockAppointmentRow = {
      ...mockAppointmentRow,
      service_address_line1: '123 Main St', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_state: 'FL', service_address_zip: '34209',
      customer_address_line1: '999 Other Rd', customer_city: 'Sarasota', customer_state: 'FL', customer_zip: '34231',
    };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.appointment.address).toBe('123 Main St, Bradenton, FL, 34209');
  });

  test('falls back to the customer\'s primary address when the row has no stamped service address (legacy row)', async () => {
    noCard();
    mockAppointmentRow = {
      ...mockAppointmentRow,
      service_address_line1: null,
      customer_address_line1: '999 Other Rd', customer_city: 'Sarasota', customer_state: 'FL', customer_zip: '34231',
    };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.appointment.address).toBe('999 Other Rd, Sarasota, FL, 34231');
  });

  test('no address anywhere: null, not a broken string', async () => {
    noCard();
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.appointment.address).toBeNull();
  });
});

describe('identity_fingerprint (Codex round-2 through round-4 P1s: pin the WHOLE scheduled_services row, not a hand-picked subset)', () => {
  const noCard = () => {
    mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
    mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  };

  test('is present and stable across two reads of the identical row', async () => {
    noCard();
    const a = await computeCancelAppointmentImpact('svc-synthetic-1');
    const b = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(typeof a.identity_fingerprint).toBe('string');
    expect(a.identity_fingerprint.length).toBeGreaterThan(0);
    expect(a.identity_fingerprint).toBe(b.identity_fingerprint);
  });

  // Codex round-2 P1: a same-day window move or a repoint to a same-named
  // customer must still drift the fingerprint even where it's plausible
  // the OTHER display facts (status/scheduled_date/service_type/
  // customer_name) read identical. window_start/window_end are bare
  // Postgres TIME columns (e.g. '13:00:00'), never a timestamp.
  test('changes when the window moves (same date, same status) — Codex round-3 P1 also surfaces it on the card via `window`', async () => {
    noCard();
    const before = await computeCancelAppointmentImpact('svc-synthetic-1');
    mockAppointmentRow = { ...mockAppointmentRow, window_start: '13:00:00', window_end: '15:00:00' };
    const after = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(after.identity_fingerprint).not.toBe(before.identity_fingerprint);
    // The window now ALSO shows up in the display facts themselves — the
    // operator sees the new window on a fresh card, and the fingerprint
    // independently drift-refuses a stale one that was never re-shown.
    expect(after.appointment.window).not.toBe(before.appointment.window);
    expect(after.appointment.window).toBe('1:00 PM–3:00 PM');
  });

  test('changes when the visit is repointed to a different customer_id (identically named account)', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, customer_id: 'cust-original' };
    const before = await computeCancelAppointmentImpact('svc-synthetic-1');
    mockAppointmentRow = { ...mockAppointmentRow, customer_id: 'cust-repointed' };
    const after = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(after.identity_fingerprint).not.toBe(before.identity_fingerprint);
    // Same displayed name both times (first_name/last_name unchanged) — the
    // card would print identically; only the fingerprint catches the repoint.
    expect(after.appointment.customer_name).toBe(before.appointment.customer_name);
  });

  // The technician is NOT part of the display facts at all (id/status/
  // scheduled_date/service_type/customer_name/window) — this is the clean
  // case proving the fingerprint catches identity drift the card's own
  // rendered text can never show.
  test('changes when the technician changes (never shown on the card at all)', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, technician_id: 'tech-1' };
    const before = await computeCancelAppointmentImpact('svc-synthetic-1');
    mockAppointmentRow = { ...mockAppointmentRow, technician_id: 'tech-2' };
    const after = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(after.identity_fingerprint).not.toBe(before.identity_fingerprint);
    expect(after.appointment).toEqual(before.appointment);
  });

  test('does NOT change on a volatile/display-only re-read with nothing actually different', async () => {
    noCard();
    const a = await computeCancelAppointmentImpact('svc-synthetic-1');
    // A fresh row object, same values — proves the hash isn't accidentally
    // keyed on object identity or insertion order.
    mockAppointmentRow = { ...mockAppointmentRow };
    const b = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(a.identity_fingerprint).toBe(b.identity_fingerprint);
  });

  // Codex round-4 STRUCTURAL fix: pin the WHOLE row (bar a tiny denylist)
  // instead of a hand-picked column subset, so a future column that turns
  // out to matter needs no hand-added entry to be caught as drift.
  test('changes when an arbitrary column NOT on the denylist changes, even one no display fact or refusal reads today', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, internal_notes: 'first note' };
    const before = await computeCancelAppointmentImpact('svc-synthetic-1');
    mockAppointmentRow = { ...mockAppointmentRow, internal_notes: 'a different note' };
    const after = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(after.identity_fingerprint).not.toBe(before.identity_fingerprint);
  });

  // The denylist itself (appointment-cancel-impact.js's
  // ROW_FINGERPRINT_DENYLIST): each entry is operational churn unrelated to
  // what cancelling this visit does, so changing ONLY a denylisted column
  // must NOT drift-refuse an otherwise-unchanged, still-pending card.
  test.each([
    ['updated_at', { updated_at: '2026-10-01T00:00:00.000Z' }, { updated_at: '2026-10-02T12:00:00.000Z' }],
    ['route_order', { route_order: 3 }, { route_order: 7 }],
    ['stops_ahead_min_shown + stops_ahead_shown_date', { stops_ahead_min_shown: 2, stops_ahead_shown_date: '2026-10-01' }, { stops_ahead_min_shown: 1, stops_ahead_shown_date: '2026-10-02' }],
    // A concurrent operator's note append (tools.js's own SQL-side
    // concat_ws is designed to let this survive, Codex round-1 P1) must not
    // block an otherwise-unchanged pending cancel either.
    ['notes', { notes: 'first note' }, { notes: 'a different note from another operator' }],
  ])('does NOT change when only %s changes (denylisted — pure operational churn)', async (_label, beforeFields, afterFields) => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, ...beforeFields };
    const before = await computeCancelAppointmentImpact('svc-synthetic-1');
    mockAppointmentRow = { ...mockAppointmentRow, ...afterFields };
    const after = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(after.identity_fingerprint).toBe(before.identity_fingerprint);
  });
});

describe('customer_notice (Codex round-1 P1: disclose, never silently suppress, the real cancellation-notice hook)', () => {
  const noCard = () => {
    mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
    mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  };

  test('rides through untouched from job-status.previewCancellationNoticeVerdict: none', async () => {
    noCard();
    mockNoticeVerdict.mockResolvedValue('none');
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.customer_notice).toBe('none');
    expect(mockNoticeVerdict).toHaveBeenCalledWith('svc-synthetic-1');
  });

  test('rides through untouched: may_send', async () => {
    noCard();
    mockNoticeVerdict.mockResolvedValue('may_send');
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.customer_notice).toBe('may_send');
  });

  test('a failed read makes the whole impact undeterminable (throws), never silently "none"', async () => {
    noCard();
    mockNoticeVerdict.mockRejectedValue(new Error('notice lookup failed'));
    await expect(computeCancelAppointmentImpact('svc-synthetic-1')).rejects.toThrow('notice lookup failed');
  });
});

describe('card_cancel_refusals (owner ruling 2026-09-28: the bar cancels simple visits only)', () => {
  const noCard = () => {
    mockCardHoldPreview.mockResolvedValue({ held: false, feeApplies: false, rule: { code: 'no_card' } });
    mockApptCardPreview.mockResolvedValue({ secured: false, feeApplies: false, rule: { code: 'no_card' } });
  };

  test('a plain visit (no card rail, plain invoice, no plan make-up) has no refusals', async () => {
    noCard();
    mockInvoicePreview.mockResolvedValue([{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'draft', total: 89, credit_applied: 0, deposit_credit: 0, payment_intent: false }]);
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual([]);
  });

  test.each([
    ['unresolved with no rail named', { applies: true, amount: null, unresolved: true, rail: 'none' }],
    ['a fee with no rail named', { applies: true, amount: 49, unresolved: false, rail: 'none' }],
  ])('an unreadable card lane is refused: %s', (_label, fee) => {
    const { feeRailClear } = require('../services/appointment-cancel-impact');
    expect(feeRailClear(fee)).toBe(false);
    expect(feeRailClear({ applies: false, amount: null, unresolved: false, rail: 'none' })).toBe(true);
  });

  test('any card fee rail is refused, fee or no fee', async () => {
    mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 49, rule: { code: 'outside_window' } });
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual(['card_fee_agreement']);
  });

  test('an invoice carrying a card PaymentIntent, a legacy deposit, or a possible plan make-up visit is refused', async () => {
    noCard();
    mockInvoicePreview.mockResolvedValue([
      { id: 'inv-1', status: 'sent', total: 50, credit_applied: 0, deposit_credit: 75, payment_intent: false },
      { id: 'inv-2', status: 'sent', total: 20, credit_applied: 0, deposit_credit: 0, payment_intent: true },
    ]);
    mockMayReseed.mockReturnValueOnce(true);
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual(['card_payment_on_invoice', 'estimate_deposit', 'plan_makeup_visit']);
    expect(mockMayReseed).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-synthetic-1', status: 'confirmed' }));
  });

  // Codex round-1 P1: card_payment_on_invoice above only covers a
  // PaymentIntent on a WOULD-VOID candidate invoice — it misses money
  // already collected on an invoice the void preview excludes entirely
  // (paid, processing, or on a finalized statement). fee.blocked_by_invoice
  // is the SAME verdict visit-cancellation-followthrough.js's own
  // office-review gate acts on, so reusing it here can never disagree with
  // what actually happens at commit.
  test('an invoice that would still hold money after the void is refused (invoice_holds_money) even with an otherwise plain visit', async () => {
    noCard();
    mockUnresolvedAfterVoid.mockResolvedValue(true);
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.fee.blocked_by_invoice).toBe(true);
    expect(impact.card_cancel_refusals).toEqual(['invoice_holds_money']);
  });

  test('invoice_holds_money sorts alongside the other refusal codes', async () => {
    mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 49, rule: { code: 'outside_window' } });
    mockUnresolvedAfterVoid.mockResolvedValue(true);
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual(['card_fee_agreement', 'invoice_holds_money']);
  });

  // Codex round-2 P1, owner's simple-visits ruling: the commit's own
  // follow-through voids/reverses only the PINNED set the card showed, but
  // inspection-credit.js's independent HOURLY sweep
  // (sweepInspectionCreditRedemptions) later re-derives ANY stale redeemed
  // offer on a non-live booking and calls voidOpenInvoicesForCancelledService
  // UNPINNED — refuse outright rather than let that sweep touch a
  // bar-cancelled booking at all.
  test.each([
    ['reversed', [{ id: 'offer-1', amount: 75, would_reverse: true, deferred: false }]],
    ['deferred to office review', [{ id: 'offer-1', amount: 75, would_reverse: false, deferred: true }]],
    ['rebound to a live alternate booking', [{ id: 'offer-1', amount: 75, would_reverse: false, deferred: false }]],
  ])('a redeemed inspection-credit offer (%s) is refused even with an otherwise plain visit', async (_label, offers) => {
    noCard();
    mockCreditPreview.mockResolvedValue(offers);
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual(['inspection_credit']);
  });

  test('no redeemed offer at all (null): no inspection_credit refusal', async () => {
    noCard();
    mockCreditPreview.mockResolvedValue(null);
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual([]);
  });

  test('inspection_credit sorts alongside the other refusal codes', async () => {
    mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 49, rule: { code: 'outside_window' } });
    mockCreditPreview.mockResolvedValue([{ id: 'offer-1', amount: 75, would_reverse: true, deferred: false }]);
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual(['card_fee_agreement', 'inspection_credit']);
  });

  // Codex round-4 P2: cancelling a grouped visit's row runs
  // visit-groups.js's handleChildTerminal (detach or dissolve the group) —
  // a side effect this card never disclosed. Refusing it outright means
  // the bar never has a grouped visit to reach that side effect from.
  test('a grouped visit (visit_id set) is refused even with an otherwise plain visit', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, visit_id: 'visit-grp-1' };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual(['grouped_visit']);
  });

  test('a plain, ungrouped visit (visit_id null) has no grouped_visit refusal', async () => {
    noCard();
    mockAppointmentRow = { ...mockAppointmentRow, visit_id: null };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual([]);
  });

  test('grouped_visit sorts alongside the other refusal codes', async () => {
    mockCardHoldPreview.mockResolvedValue({ held: true, feeApplies: false, feeAmount: 49, rule: { code: 'outside_window' } });
    mockAppointmentRow = { ...mockAppointmentRow, visit_id: 'visit-grp-1' };
    const impact = await computeCancelAppointmentImpact('svc-synthetic-1');
    expect(impact.card_cancel_refusals).toEqual(['card_fee_agreement', 'grouped_visit']);
  });
});

describe('cancelImpactsMatch (the commit-time drift check)', () => {
  const base = () => ({
    appointment: { id: 'svc-1', status: 'confirmed', scheduled_date: '2026-10-02', service_type: 'pest_control', customer_name: 'Synthia Tester' },
    fee: { applies: true, amount: 49, unresolved: false, rail: 'card_hold' },
    invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 0 }],
    inspection_credit_reversal: null,
  });

  test('identical impacts match regardless of key order', () => {
    const a = base();
    const b = { invoices: a.invoices, fee: a.fee, appointment: a.appointment, inspection_credit_reversal: null };
    expect(cancelImpactsMatch(a, b)).toBe(true);
  });

  test('a changed fee amount is drift', () => {
    const a = base();
    const b = { ...base(), fee: { ...a.fee, amount: 99 } };
    expect(cancelImpactsMatch(a, b)).toBe(false);
  });

  test('an invoice that appears (or disappears) is drift', () => {
    const a = base();
    const b = { ...base(), invoices: [] };
    expect(cancelImpactsMatch(a, b)).toBe(false);
  });

  test('a credit reversal appearing where there was none is drift', () => {
    const a = base();
    const b = { ...base(), inspection_credit_reversal: [{ id: 'offer-1', amount: 75, would_reverse: true, deferred: false }] };
    expect(cancelImpactsMatch(a, b)).toBe(false);
  });

  test('null vs null matches; null vs an object never does', () => {
    expect(cancelImpactsMatch(null, null)).toBe(true);
    expect(cancelImpactsMatch(null, base())).toBe(false);
  });
});
