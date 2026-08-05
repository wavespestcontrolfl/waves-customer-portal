/**
 * Inspection credit — money invariants.
 *
 * The promise is recorded at closeout and mints ONLY at redemption, so the
 * tests that matter are the ones proving money never appears from nothing:
 * no offer without a billable amount, no mint without a won claim, no
 * second mint, no redemption after expiry, and nothing at all while dark.
 */
let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => (g === 'inspectionCredit' ? mockGateOn : false),
  gates: {},
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockPostCreditMovement = jest.fn(async () => ({ balanceAfter: 75, entry: { id: 'ledger-1' } }));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: (...a) => mockPostCreditMovement(...a),
}));

const mockNotifyAdmin = jest.fn(async () => ({ id: 'notif-1' }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...a) => mockNotifyAdmin(...a),
}));

let mockOffers = [];
let mockInsertResult = [{ id: 'offer-new', amount: '75.00', expires_at: new Date() }];
let mockClaimResult = 1;
let mockBookings = [];
let mockAlternates = [];
let mockInvoices = [];
let mockEvents = [];
const mockUpdates = [];
const mockChainCalls = [];
jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const chain = {};
    let joined = false;
    // The scheduled_service_id this chain filtered on, when it did — lets
    // an events read distinguish "is THIS row proven" probes (the r23
    // rebound-child fix makes two of them with different ids in one pass).
    let whereScheduledId;
    for (const m of ['where', 'whereNot', 'whereIn', 'whereNotIn', 'orderBy', 'orderByRaw', 'limit', 'whereNotNull', 'join', 'leftJoin', 'whereNull', 'whereRaw', 'select', 'onConflict', 'ignore', 'returning', 'forUpdate']) {
      chain[m] = jest.fn((...args) => {
        mockChainCalls.push({ m, args });
        if (m === 'join' || m === 'leftJoin') joined = true;
        if (m === 'where' && args[0] && typeof args[0] === 'object' && 'scheduled_service_id' in args[0]) {
          whereScheduledId = args[0].scheduled_service_id;
        }
        return chain;
      });
    }
    // select()/the builder itself resolves to the open-offer list
    // Table-aware: a scheduled_services lookup is a BOOKING probe, not an
    // offer read — conflating them made the reversal path think another
    // live booking existed. An events read is TWO different probes: joined
    // = the evidence/redemption join (mockAlternates); plain = a direct
    // event lookup (mockEvents) — the fast path's booking-moment read and
    // the reversal path's anchor-proven check.
    const t = String(table || '');
    const isEventsTable = t.includes('inspection_credit_booking_events');
    const isBookings = t.includes('scheduled_services') && !isEventsTable;
    const isInvoices = t === 'invoices' || t.startsWith('invoices ');
    // A plain events read honors the id it filtered on: rows carrying a
    // scheduled_service_id only match their own probe; rows without one
    // match any probe (legacy fixtures).
    const eventRows = () => mockEvents.filter((e) => !('scheduled_service_id' in e)
      || whereScheduledId === undefined || e.scheduled_service_id === whereScheduledId);
    const pickRows = () => (isEventsTable ? (joined ? mockAlternates : eventRows())
      : (isBookings ? mockBookings : (isInvoices ? mockInvoices : mockOffers)));
    chain.then = (res, rej) => Promise.resolve(pickRows()).then(res, rej);
    chain.first = jest.fn(async () => pickRows()[0] || null);
    chain.insert = jest.fn(() => {
      const ins = {};
      ins.onConflict = jest.fn(() => ins);
      ins.ignore = jest.fn(() => ins);
      ins.returning = jest.fn(async () => mockInsertResult);
      return ins;
    });
    chain.update = jest.fn(async (patch) => { mockUpdates.push(patch); return mockClaimResult; });
    return chain;
  };
  const db = jest.fn((table) => makeChain(table));
  // Pass-through: select(db.raw(...)) must not throw — without this the
  // recovery query died at arg-evaluation time and the catch swallowed it,
  // so recovery paths were silently untested.
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => 'NOW' };
  db.transaction = jest.fn(async (cb) => cb(db));
  // Savepoint support: a nested transaction on the same handle.
  db.transaction.bind = db.transaction.bind;
  return db;
});

const {
  recordInspectionCreditOffer,
  markBookingForInspectionCredit,
  reverseInspectionCreditForBooking,
  sweepInspectionCreditRedemptions,
  redeemInspectionCreditForBooking,
  inspectionCreditReceiptMemo,
  etEndOfDayAfterDays,
  creditWindowDaysForServiceKey,
  configuredCreditAmountForServiceKey,
  isCreditableInspectionProfile,
  DEFAULT_CREDIT_WINDOW_DAYS,
} = require('../services/inspection-credit');

beforeEach(() => {
  jest.clearAllMocks();
  mockGateOn = true;
  mockOffers = [];
  mockInsertResult = [{ id: 'offer-new', amount: '75.00', expires_at: new Date() }];
  mockClaimResult = 1;
  // Default: the booking being redeemed against exists and is live. The
  // service reads its authoritative created_at/status rather than
  // trusting the caller.
  mockBookings = [{ id: 'svc-2', created_at: new Date('2026-08-10'), status: 'confirmed' }];
  mockAlternates = [];
  mockInvoices = [];
  mockEvents = [];
  mockUpdates.length = 0;
  mockChainCalls.length = 0;
});

describe('recordInspectionCreditOffer — the promise, not the money', () => {
  it('is inert while the gate is dark', async () => {
    mockGateOn = false;
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res).toEqual({ recorded: false, reason: 'feature_disabled' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('credits the FLAT configured amount, not what the inspection was billed (owner ruling 2026-08-03)', async () => {
    // A comped or discounted inspection still earns the full credit — the
    // promise is "the inspection is worth $75 toward service", not a refund
    // of what was paid. No amount is passed: config decides.
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res.recorded).toBe(true);
    expect(res.amount).toBe(75);
  });

  it('a rodent inspection credits its QUOTED fee, never the flat default (r23 P0, owner ruling 2026-08-04)', async () => {
    // The public estimator has promised "$125 inspection (creditable for
    // 14 days toward remediation work)" on tokenized estimates since before
    // this feature — an in-flight estimate is a keep-working surface, so
    // freezing the flat $75 onto a rodent offer would short a promise
    // already sent.
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1', serviceKey: 'rodent_inspection',
    });
    expect(res.recorded).toBe(true);
    expect(res.amount).toBe(125); // RODENT.inspection.fee — the estimator's number
    expect(res.windowDays).toBe(14); // and rodent's own window
    // The override is rodent-specific: everything else keeps the flat default.
    expect(configuredCreditAmountForServiceKey('rodent_inspection')).toBe(125);
    expect(configuredCreditAmountForServiceKey('wdo_inspection')).toBe(75);
    expect(configuredCreditAmountForServiceKey(null)).toBe(75);
  });

  it('honors terms frozen at closeout over the current configuration (r21 P2)', async () => {
    // Recovery passes the amount and window the CLOSEOUT froze with its
    // consent marker — a pricing-config change between the failed insert
    // and the recovery pass must not change the promise the customer got.
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
      amount: 60, windowDays: 21, now: new Date('2026-08-03T12:00:00Z'),
    });
    expect(res.recorded).toBe(true);
    expect(res.amount).toBe(60);
    expect(res.windowDays).toBe(21);
  });

  it('freezes the amount and expiry, and mints NOTHING at closeout', async () => {
    const now = new Date('2026-08-03T12:00:00Z');
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1', now,
    });
    expect(res.recorded).toBe(true);
    expect(res.amount).toBe(75);
    expect(res.windowDays).toBe(DEFAULT_CREDIT_WINDOW_DAYS);
    // The deadline is the END of the ET day 30 days out — the receipt
    // prints a calendar date, so that whole day must remain bookable.
    // Asserted on the ET DATE (en-CA is ISO and stable across ICU builds),
    // never on a formatted clock string: the bug this pins was masked
    // locally because en-US renders midnight as "00:00" here and "24:00"
    // on CI.
    const etDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    // The last bookable second is still the named day...
    expect(etDay(new Date(res.expiresAt.getTime() - 1000))).toBe('2026-09-02');
    // ...and the expiry instant itself has rolled over to the next.
    expect(etDay(res.expiresAt)).toBe('2026-09-03');
    // The whole point: no ledger movement happens at closeout.
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('a completion replay reports the EXISTING terms rather than re-promising', async () => {
    mockInsertResult = []; // unique conflict → ignored
    mockOffers = [{ id: 'offer-existing', amount: '75.00', expires_at: new Date('2026-09-01'), status: 'offered' }];
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe('already_offered');
    // The receipt must state what the customer was ACTUALLY promised.
    expect(res.amount).toBe(75);
  });

  it('never throws — a credit failure must not fail the completion', async () => {
    const db = require('../models/db');
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    const res = await recordInspectionCreditOffer({
      customerId: 'cust-1', scheduledServiceId: 'svc-1',
    });
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe('error');
  });
});

describe('redeemInspectionCreditForBooking — exactly-once minting', () => {
  it('is inert while the gate is dark', async () => {
    mockGateOn = false;
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, reason: 'feature_disabled' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('does not redeem against a cancelled/no-show booking', async () => {
    // 'rescheduled' deliberately absent: the customer reschedule endpoint
    // stamps it while the visit simply MOVES — they are still booked.
    for (const status of ['cancelled', 'no_show', 'skipped']) {
      mockBookings = [{ id: 'svc-2', created_at: new Date('2026-08-10'), status }];
      const res = await redeemInspectionCreditForBooking({
        customerId: 'cust-1', scheduledServiceId: 'svc-2',
      });
      expect(res).toEqual({ redeemed: 0, reason: 'booking_not_live' });
    }
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('no open offer → nothing minted', async () => {
    mockOffers = [];
    mockEvents = [{ created_at: new Date('2026-08-10') }];
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, reason: 'no_open_offer' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('NO booking event → nothing minted, deferred to the sweep (r28 P2)', async () => {
    // A reused row (graduated hold, adopted appointment) carries a
    // reservation/placeholder created_at — falling back to it when the
    // savepoint evidence write missed let a hold reserved in-window but
    // accepted after expiry mint an unearned credit. Evidence-REQUIRED:
    // the sweep mints later from the recovered event's frozen stamp.
    mockEvents = [];
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, reason: 'no_booking_evidence' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('mints once, with the frozen amount and the inspection_credit source, and binds the ledger id', async () => {
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    mockEvents = [{ created_at: new Date('2026-08-10') }];
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 1, amount: 75 });
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);
    const [args] = mockPostCreditMovement.mock.calls[0];
    expect(args).toMatchObject({ customerId: 'cust-1', delta: 75, source: 'inspection_credit' });
    // The claim moves the row terminal BEFORE money posts...
    expect(mockUpdates[0]).toMatchObject({ status: 'redeemed', redeemed_scheduled_service_id: 'svc-2' });
    // ...and the mint is bound back as the exactly-once proof.
    expect(mockUpdates[1]).toMatchObject({ credit_ledger_id: 'ledger-1' });
  });

  it('a lost claim race mints NOTHING (the other booking won)', async () => {
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    mockEvents = [{ created_at: new Date('2026-08-10') }];
    mockClaimResult = 0; // status-guarded update matched no row
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, amount: 0 });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('a failed mint leaves nothing double-counted and never throws', async () => {
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    mockEvents = [{ created_at: new Date('2026-08-10') }];
    mockPostCreditMovement.mockRejectedValueOnce(new Error('ledger down'));
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 0, amount: 0 });
  });

  it('a graduated hold redeems by its BOOKING moment, never the reservation instant', async () => {
    // Hold reserved 08-01 (BEFORE the promise existed); accept graduated it
    // 08-10. The row's created_at is the reservation — judging by it would
    // find no offer and the invoice would deliver unreduced. The booking
    // EVENT (written at graduation) carries the real moment.
    mockBookings = [{ id: 'svc-2', created_at: new Date('2026-08-01'), status: 'confirmed' }];
    mockEvents = [{ created_at: new Date('2026-08-10') }];
    mockOffers = [{ id: 'offer-1', amount: '75.00', expires_at: new Date('2099-01-01') }];
    const res = await redeemInspectionCreditForBooking({ customerId: 'cust-1', scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ redeemed: 1, amount: 75 });
    // The ordering guard compared against the EVENT time, not the row time.
    const orderingWheres = mockChainCalls.filter((c) => c.m === 'where'
      && c.args[0] === 'created_at' && c.args[1] === '<=');
    expect(orderingWheres.length).toBeGreaterThan(0);
    const eventMs = new Date('2026-08-10').getTime();
    const holdMs = new Date('2026-08-01').getTime();
    expect(orderingWheres.every((c) => new Date(c.args[2]).getTime() === eventMs)).toBe(true);
    expect(orderingWheres.some((c) => new Date(c.args[2]).getTime() === holdMs)).toBe(false);
  });
});

describe('sweepInspectionCreditRedemptions — the durable guarantee', () => {
  it('is inert while the gate is dark', async () => {
    mockGateOn = false;
    const res = await sweepInspectionCreditRedemptions();
    expect(res).toMatchObject({ redeemed: 0, reason: 'feature_disabled' });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('recovers a missing offer ONLY from the durable opt-in marker, never from "an inspection completed"', async () => {
    // Inferring consent from completion could not tell a transient write
    // failure from the tech clearing the box — and on first gate enablement
    // would have turned every historical inspection into real credit.
    mockOffers = [];
    await sweepInspectionCreditRedemptions();
    // The recovery query must filter on the persisted opt-in marker.
    const raw = mockChainCalls.filter((c) => c.m === 'whereRaw');
    expect(raw.length).toBeGreaterThan(0);
  });

  it('credits an open offer ONLY when a proven booking event exists in its window', async () => {
    // Deliberately NOT "any later scheduled_services row": seeders, bulk
    // rebooks and imports create rows nobody booked, and prod data shows
    // no provenance column separates them. The booking EVENT is the proof —
    // and the working set IS the evidence join (evidence-first, so unbooked
    // offers sitting out their window can't starve provable ones).
    mockOffers = [];
    mockAlternates = [{
      offer_id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      booking_id: 'svc-booked', booked_at: new Date('2026-08-05'),
    }];
    mockBookings = [{ id: 'svc-booked', created_at: new Date('2026-08-05'), status: 'confirmed' }];
    const res = await sweepInspectionCreditRedemptions();
    expect(res.redeemed).toBe(1);
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);

    // With NO booking event the same offer earns nothing.
    jest.clearAllMocks();
    mockAlternates = [];
    const none = await sweepInspectionCreditRedemptions();
    expect(none.redeemed).toBe(0);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });

  it('fresh cancellations get first claim on the reversal batch; alerted rows only fill the remainder (r23 P2)', async () => {
    // A durably-failed reversal (credit spent, invoice unresolved) stays
    // `redeemed` with reversal_alerted_at set until the office resolves it.
    // Enough of those in one unordered batch would monopolize every hourly
    // run and newer cancellations would never be reversed.
    await sweepInspectionCreditRedemptions();
    const nullAt = mockChainCalls.findIndex((c) => c.m === 'whereNull' && c.args[0] === 'o.reversal_alerted_at');
    const notNullAt = mockChainCalls.findIndex((c) => c.m === 'whereNotNull' && c.args[0] === 'o.reversal_alerted_at');
    expect(nullAt).toBeGreaterThan(-1);
    expect(notNullAt).toBeGreaterThan(nullAt); // never-alerted rows selected first
    // Retries are sampled randomly, so no fixed subset of permanent
    // failures can permanently shadow the rest of the alerted set.
    expect(mockChainCalls.some((c) => c.m === 'orderByRaw' && /random/.test(String(c.args[0])))).toBe(true);
  });

  it('the mint re-validates the booking UNDER LOCK — a cancel that wins the race stops the money', async () => {
    // Every caller's liveness read happens before the claim transaction
    // starts; a cancellation can commit in between and its reversal finds
    // no redeemed offer yet. The in-transaction re-read (FOR UPDATE) is
    // what stops $75 landing against a cancelled booking.
    mockOffers = [];
    mockAlternates = [{
      offer_id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      booking_id: 'svc-booked', booked_at: new Date('2026-08-05'),
    }];
    mockBookings = [{ id: 'svc-booked', created_at: new Date('2026-08-05'), status: 'cancelled' }];
    const res = await sweepInspectionCreditRedemptions();
    expect(res.redeemed).toBe(0);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    // And the guard read really locked the row.
    expect(mockChainCalls.some((c) => c.m === 'forUpdate')).toBe(true);
  });

  it('rescues an offer the expiry race closed — expired is provisional, never money-terminal', async () => {
    // A booking's event can commit between the sweep's evidence check and
    // its expire UPDATE; the offer lands 'expired' holding a qualifying
    // booking. The rescue join finds it and the claim (which accepts
    // 'expired' precisely because of this race) re-validates the ordering.
    mockOffers = [];
    mockAlternates = [{
      offer_id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      booking_id: 'svc-9', booked_at: new Date('2026-08-10'),
    }];
    const res = await sweepInspectionCreditRedemptions();
    expect(res.redeemed).toBe(1);
    expect(mockPostCreditMovement).toHaveBeenCalledTimes(1);
    const [args] = mockPostCreditMovement.mock.calls[0];
    expect(args).toMatchObject({ customerId: 'cust-1', delta: 75, source: 'inspection_credit' });
  });
});

describe('reverseInspectionCreditForBooking — a cancelled booking gives it back', () => {
  it('still reverses while the gate is dark — minted money must come back', async () => {
    // Turning the gate off stops new promises; it must NOT strand credit
    // already in a customer's balance for a booking they cancelled.
    mockGateOn = false;
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 1 });
    expect(mockPostCreditMovement).toHaveBeenCalledWith(
      expect.objectContaining({ delta: -75 }), expect.anything(),
    );
  });

  it('reverses the ledger movement and reopens the offer inside its window', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2099-01-01'), credit_ledger_id: 'ledger-1',
    }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 1 });
    const [args] = mockPostCreditMovement.mock.calls[0];
    // NEGATIVE delta — the money goes back.
    expect(args).toMatchObject({ customerId: 'cust-1', delta: -75, source: 'inspection_credit' });
    // Reopened so a real booking can still earn it, the mint binding
    // cleared so it can mint again, and the alert marker cleared so the
    // reopened offer gets a fresh alert cycle (a stale marker from an
    // earlier failed attempt would suppress a future spent-credit alert).
    expect(mockUpdates[0]).toMatchObject({
      status: 'offered', credit_ledger_id: null, redeemed_at: null, reversal_alerted_at: null,
    });
  });

  it('rebinds instead of reversing when another live booking still stands in the window', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    // A PROVEN booking (another offer's marker points at a live visit),
    // not merely any live scheduled_services row.
    mockAlternates = [{ id: 'svc-other' }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    // Money stays with the customer — they still have a qualifying booking.
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    // A rebind starts a NEW booking lifecycle: the old booking's stale
    // alert marker must not suppress the new booking's one alert (r24 P2).
    expect(mockUpdates[0]).toMatchObject({ redeemed_scheduled_service_id: 'svc-other', reversal_alerted_at: null });
  });

  it('a lapsed offer closes out instead of dangling reopened', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2020-01-01'), credit_ledger_id: 'ledger-1',
    }];
    await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(mockUpdates[0]).toMatchObject({ status: 'expired' });
  });

  it('cancelling only the ANCHOR of a live series rebinds to a child, never claws back', async () => {
    // Seeded children carry no events of their own — only the anchor was
    // booked. If the series continues, the customer still earned the credit.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    mockAlternates = []; // no standalone proven alternate
    mockEvents = [{ id: 'evt-anchor' }]; // the cancelled anchor IS proven
    mockBookings = [{ id: 'svc-child', status: 'confirmed' }]; // live child
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-anchor' });
    expect(res).toEqual({ reversed: 0 });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(mockUpdates[0]).toMatchObject({ redeemed_scheduled_service_id: 'svc-child' });
  });

  it('cancelling a REBOUND seeded child rebinds to a live sibling of the proven anchor (r23 P1)', async () => {
    // Lifecycle: proven anchor A cancels → offer rebinds to seeded child B.
    // B then cancels while sibling C stays live. B has no booking event of
    // its own — its PARENT does — so provenance must resolve through
    // recurring_parent_id before the money is clawed back from a series
    // that is still going.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    mockAlternates = []; // no standalone proven alternate
    // Only the ANCHOR is proven — the cancelled child's own probe finds nothing.
    mockEvents = [{ id: 'evt-anchor', scheduled_service_id: 'svc-anchor' }];
    // Serves the parent lookup (recurring_parent_id), the sibling search,
    // and the rebind's liveness re-read.
    mockBookings = [{ id: 'svc-child-c', status: 'confirmed', recurring_parent_id: 'svc-anchor' }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-child-b' });
    expect(res).toEqual({ reversed: 0 });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(mockUpdates[0]).toMatchObject({ redeemed_scheduled_service_id: 'svc-child-c' });
  });

  it('rebinds through ANOTHER proven series whose anchor cancelled but child lives (r27 P2)', async () => {
    // Offer bound to standalone booking B; proven anchor C in the window
    // was cancelled while its seeded child D continues. C is non-live (not
    // an alternate) and D carries no event (seeded), so both earlier probes
    // miss — the in-window proven-anchor sweep must find D before money
    // is clawed back from a customer whose booked series still stands.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    mockAlternates = []; // C is non-live, so no standalone proven alternate
    mockEvents = [{ id: 'evt-c', scheduled_service_id: 'svc-anchor-c', customer_id: 'cust-1', created_at: new Date('2026-08-05') }];
    mockBookings = [{ id: 'svc-d', status: 'confirmed' }]; // C's live seeded child
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-b' });
    expect(res).toEqual({ reversed: 0 });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(mockUpdates[0]).toMatchObject({ redeemed_scheduled_service_id: 'svc-d', reversal_alerted_at: null });
  });

  it('an UNPROVEN cancelled row never rebinds through its children', async () => {
    // Descendants qualify only under a PROVEN anchor — a seeder parent's
    // children must not hold a credit alive.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    mockAlternates = [];
    mockEvents = []; // anchor has NO booking event
    mockBookings = [{ id: 'svc-child', status: 'confirmed' }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-seeded' });
    // Falls through to a full reversal — the money goes back.
    expect(res).toEqual({ reversed: 1 });
    expect(mockPostCreditMovement).toHaveBeenCalledWith(
      expect.objectContaining({ delta: -75 }), expect.anything(),
    );
  });

  it('an unresolved invoice blocks REBINDING too, not just reversal', async () => {
    // Rebinding while the cancelled booking's paid invoice still embeds the
    // credit would claim it belongs to another booking — office alert
    // instead; the sweep retries after the invoice resolves.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    mockAlternates = [{ id: 'svc-other' }]; // a rebind target exists...
    mockInvoices = [{ id: 'inv-9', status: 'paid' }]; // ...but money is unresolved
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    // No rebind happened — the only update is the alert-marker claim.
    expect(mockUpdates.some((p) => 'redeemed_scheduled_service_id' in p && p.redeemed_scheduled_service_id === 'svc-other')).toBe(false);
  });

  it('never reverses blind while an invoice for the booking still holds money', async () => {
    // Paid/processing/unverifiable invoices may hold the credit EMBEDDED —
    // a negative movement would consume UNRELATED balance while the invoice
    // keeps the discount. Office alert instead; when the invoice resolves,
    // the hourly sweep retries the reversal and it proceeds.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      created_at: new Date('2026-08-01'), expires_at: new Date('2099-01-01'),
      credit_ledger_id: 'ledger-1', source_scheduled_service_id: 'svc-insp',
    }];
    mockInvoices = [{ id: 'inv-9', status: 'paid' }];
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [, , , opts] = mockNotifyAdmin.mock.calls[0];
    expect(opts.metadata).toMatchObject({ offerId: 'offer-1', reason: 'invoice_unresolved' });
  });

  it('spent credit raises the office alert atomically with the marker claim', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2099-01-01'), credit_ledger_id: 'ledger-1',
    }];
    // The credit was already spent: the ledger refuses to go negative.
    // Fixture mirrors the REAL postCreditMovement throw — it stamps the
    // typed INSUFFICIENT_CREDIT code (customer-credit.js), and the alert
    // now keys on that code, not on failure in general (r18 P2).
    const spent = new Error('Insufficient account credit — balance is $0.00, cannot apply $75.00');
    spent.code = 'INSUFFICIENT_CREDIT';
    mockPostCreditMovement.mockRejectedValueOnce(spent);
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, , , opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('billing');
    expect(opts.metadata).toMatchObject({ offerId: 'offer-1', reason: 'credit_already_spent' });
    // The insert rides the SAME transaction as the marker claim, so a
    // crash between the two can't split them.
    expect(opts.connection).toBeDefined();
    // The claim itself: marker stamped, guarded on being unset.
    expect(mockUpdates.some((p) => p.reversal_alerted_at instanceof Date)).toBe(true);
  });

  it('a swallowed notification failure releases the marker claim for the next sweep', async () => {
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2099-01-01'), credit_ledger_id: 'ledger-1',
    }];
    const spent = new Error('Insufficient account credit — balance is $0.00, cannot apply $75.00');
    spent.code = 'INSUFFICIENT_CREDIT';
    mockPostCreditMovement.mockRejectedValueOnce(spent);
    // notifyAdmin returns null instead of throwing when its insert fails.
    mockNotifyAdmin.mockResolvedValueOnce(null);
    const res = await reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' });
    expect(res).toEqual({ reversed: 0 });
    // The claim is thrown back (transaction rollback) and logged for retry
    // — never marked as alerted when nothing landed.
    const logger = require('../services/logger');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('will retry next sweep'));
  });

  describe('etEndOfDayAfterDays — ET calendar days, never 24h multiples (r18 pre-push P1)', () => {
    const { etEndOfDayAfterDays } = require('../services/inspection-credit');
    // hourCycle 'h23', NEVER hour12:false (Codex #3178 r24 P2): hour12:false
    // resolves to the h24 cycle on Node 20's ICU, which renders these
    // midnight boundaries as "24:00:00" ON THE PREVIOUS DATE — the assertions
    // below would fail on CI while the computed instant is correct.
    const etString = (d) => d.toLocaleString('en-US', { timeZone: 'America/New_York', hourCycle: 'h23' });

    it('a late-evening EST closeout crossing spring-forward keeps the calendar contract', () => {
      // Mar 7 2026 11:30pm EST + 30 ET days = Apr 6; exclusive end = Apr 7 00:00 ET.
      // The 24h-multiple version drifted to 12:30am Apr 7 and printed Apr 7.
      const end = etEndOfDayAfterDays(new Date('2026-03-08T04:30:00Z'), 30);
      expect(etString(end)).toBe('4/7/2026, 00:00:00');
    });

    it('a late-evening EDT closeout crossing fall-back keeps the calendar contract', () => {
      // Oct 31 2026 11:30pm EDT + 30 ET days = Nov 30; end = Dec 1 00:00 ET.
      const end = etEndOfDayAfterDays(new Date('2026-11-01T03:30:00Z'), 30);
      expect(etString(end)).toBe('12/1/2026, 00:00:00');
    });

    it('the plain mid-season case is unchanged', () => {
      // Aug 3 + 30 = Sep 2; end = Sep 3 00:00 ET.
      const end = etEndOfDayAfterDays(new Date('2026-08-03T16:00:00Z'), 30);
      expect(etString(end)).toBe('9/3/2026, 00:00:00');
    });
  });

  it('a transient reversal fault never raises the billing alert — the sweep retries it (r18 P2)', () => {
    // A deadlock or dropped connection is NOT "the money is gone": the
    // balance may fully cover the reversal, and telling the office to
    // collect $75 that was never missing is a false instruction a later
    // successful retry cannot retract. Only the typed insufficient-balance
    // refusal alerts.
    mockOffers = [{
      id: 'offer-1', customer_id: 'cust-1', amount: '75.00',
      expires_at: new Date('2099-01-01'), credit_ledger_id: 'ledger-1',
    }];
    mockPostCreditMovement.mockRejectedValueOnce(new Error('deadlock detected'));
    return reverseInspectionCreditForBooking({ scheduledServiceId: 'svc-2' }).then((res) => {
      expect(res).toEqual({ reversed: 0 });
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
      // No alert marker claimed either — the offer stays clean for retry.
      expect(mockUpdates.some((p) => p.reversal_alerted_at instanceof Date)).toBe(false);
    });
  });
});

describe('cancellation reversal hook — one shared seam, not N wired copies', () => {
  it('voidOpenInvoicesForCancelledService reverses even when there is nothing to void', async () => {
    // The reversal lives in the void helper's `finally` so EVERY cancel
    // path that voids gets it for free (status-cancel, bulk, no-show,
    // offboarding, cancellation processor) — and a cancel with no open
    // invoice must still give the credit back.
    const InspectionCredit = require('../services/inspection-credit');
    const spy = jest.spyOn(InspectionCredit, 'reverseInspectionCreditForBooking')
      .mockResolvedValue({ reversed: 0 });
    try {
      const InvoiceService = require('../services/invoice');
      mockOffers = []; // invoice candidate scan resolves empty → early return path
      await InvoiceService.voidOpenInvoicesForCancelledService('svc-cancelled');
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: 'svc-cancelled' }));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('booking + redemption wiring — source contracts (routes too large to exercise here)', () => {
  const fs = require('fs');
  const path = require('path');

  it('graduating a held slot writes the booking marker on the SAME client (pre-push P0)', () => {
    // Both estimate-accept branches (one-time and recurring) book by
    // graduating the hold in commitReservation; the one-time path never
    // reaches the converter's marker, so the marker must live here.
    const source = fs.readFileSync(path.join(__dirname, '../services/slot-reservation.js'), 'utf8');
    expect(source).toContain("await require('./inspection-credit').markBookingForInspectionCredit(client, {");
  });

  it('outbound-review phone bookings earn evidence at CONFIRMATION, never at AI insert (pre-push P0)', () => {
    // A pending outbound-review row is not a closed deal until the office
    // confirms — evidence at insert would let the sweep mint $75 for an
    // appointment the customer never confirmed.
    const callProc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const guardAt = callProc.indexOf('if (!outboundReviewBooking) {');
    const markerAt = callProc.indexOf("markBookingForInspectionCredit(trx, {");
    expect(guardAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(guardAt); // marker sits inside the guard
    const confirmHook = fs.readFileSync(path.join(__dirname, '../services/outbound-review-confirm.js'), 'utf8');
    expect(confirmHook).toContain("markBookingForInspectionCredit(db, {");
  });

  it('redemption runs BEFORE the invoice mints/delivers on both conversion paths (pre-push P0)', () => {
    // The hourly sweep alone let the customer receive — or pay — the full
    // invoice before the promised $75 existed. Global-pool conversions
    // redeem before converter step 4; the public accept (converter rides
    // the accept trx, bookings invisible to the redeemer until commit)
    // redeems post-commit before delivery, where the send-time auto-apply
    // consumes the balance.
    const converter = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
    expect(converter).toContain('if (firstScheduledServiceId && !usingCallerDatabase) {');
    const acceptRoute = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');
    const redeemAt = acceptRoute.indexOf("createdBy: 'system:inspection_credit_estimate_accept'");
    const deliveryAt = acceptRoute.indexOf('Post-commit invoice delivery for every accept-minted invoice');
    expect(redeemAt).toBeGreaterThan(-1);
    expect(deliveryAt).toBeGreaterThan(redeemAt);
  });
});

describe('closeout route wiring — source contracts (the completion route is too large to exercise here)', () => {
  const fs = require('fs');
  const path = require('path');

  it('the promise moment is the COMMITTED closeout instant, never the retry clock (pre-push P0)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    // On a crash-resume, `record` is the previously committed service_records
    // row; stamping the retry time instead would fail the ordering guard for
    // any booking made between closeout and retry, permanently denying the
    // promised credit (the offer would exist, so recovery adoption never runs).
    expect(source).toContain("...(record?.created_at ? { now: new Date(record.created_at) } : {}),");
    // And the expiry window stays anchored to the inspection's service date.
    expect(source).toContain('...(inspectionMoment ? { windowAnchor: inspectionMoment } : {}),');
  });

  it('a completion resume re-promises the CLOSEOUT terms, never the live config (r23 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    // A crash-resume can run after a pricing-config change; the offer must
    // carry the amount and window frozen with the consent marker — the same
    // source the recovery sweep reads.
    expect(source).toContain("const frozenCreditTerms = parseJsonObject(record.service_data)?.inspectionCreditTerms || null;");
    expect(source).toContain('...(Number(frozenCreditTerms?.amount) > 0 ? { amount: Number(frozenCreditTerms.amount) } : {}),');
    expect(source).toContain('...(Number(frozenCreditTerms?.windowDays) > 0 ? { windowDays: Number(frozenCreditTerms.windowDays) } : {}),');
    // And the terms frozen at closeout are themselves service-aware —
    // rodent freezes its quoted fee, not the flat default (r23 P0).
    expect(source).toContain('amount: InspectionCredit.configuredCreditAmountForServiceKey(');
    expect(source).not.toContain('amount: InspectionCredit.configuredCreditAmount(),');
  });

  it('the receipt resend keys on the OFFER, not on first creation (r23 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    // A crash between the offer insert and the resend queue leaves the
    // retry returning already_offered with the memo still unsent — and the
    // recovery sweep skips the visit because its offer exists. The resend
    // is idempotent per offer, so it queues whenever an offerId is known.
    expect(source).toContain('if (inspectionCreditOffer?.offerId) {');
    expect(source).not.toContain('inspectionCreditOffer?.recorded && inspectionCreditOffer.offerId');
  });

  it('both closeout gates use the shared inspection predicate, never the bare category (r24 P0)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    // rodent_inspection's typed profile is category 'rodent' — a bare
    // category === 'inspection' gate silently excludes it, so neither the
    // durable marker nor the offer ever fires for the one service whose
    // estimator promise the credit must honor.
    const matches = source.match(/isCreditableInspectionProfile\(completionProfile\)/g) || [];
    expect(matches.length).toBe(2); // marker freeze + offer creation
    expect(source).not.toMatch(/completionProfile\?\.category \|\| ''\) === 'inspection'/);
    // The client renders the opt-out for rodent inspections too.
    const client = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/SchedulePage.jsx'), 'utf8');
    expect(client).toContain('service.completionProfile?.serviceKey === "rodent_inspection"');
  });

  it('every non-live transition runs the money seam in the ONE shared status writer (r25 P1)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/job-status.js'), 'utf8');
    // 'skipped' reached no route branch that ran the void/reversal seam,
    // leaving a skipped visit's redeemed credit spendable until the hourly
    // sweep. The seam lives in the shared writer's post-commit hook so no
    // transition surface can forget it.
    const guardAt = source.indexOf("['cancelled', 'skipped', 'no_show'].includes(String(toStatus || ''))");
    const seamAt = source.indexOf("require('./invoice').voidOpenInvoicesForCancelledService(jobId)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(seamAt).toBeGreaterThan(guardAt); // seam sits inside the non-live branch
  });

  it('the already-no_show replay re-runs the money seam (r25 P1)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    // A crash between the no-show status commit and its post-success block
    // loses the seam; the idempotent same-status retry is the recovery
    // vehicle, so it must run the helper before returning success.
    const replayAt = source.indexOf('alreadyNoShow: true');
    const seamAt = source.indexOf("require('../services/invoice').voidOpenInvoicesForCancelledService(svc.id)");
    expect(replayAt).toBeGreaterThan(-1);
    expect(seamAt).toBeGreaterThan(-1);
    expect(seamAt).toBeLessThan(replayAt); // seam runs before the replay success returns
  });

  it('the existing-appointment accept writes booking evidence in the accept trx (r25 P1)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');
    // The direct-update adoption path commits a real booking; without an
    // event the ordering guard falls back to the placeholder row's
    // created_at and the promised credit silently never redeems.
    expect(source).toContain("markBookingForInspectionCredit(trx, {");
    expect(source).toContain("source: 'estimate_accept_existing_appointment'");
  });

  it('the receipt memo answers to the persisted offer, never the live gate (r25 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice-email.js'), 'utf8');
    // A recovered dark-mode resend consumes its offer-scoped idempotency
    // key on THIS send — rendering it memo-less would permanently strand
    // the written deadline. Offers only exist for promises made while
    // live, so the offer row is the authority.
    const memoFnAt = source.indexOf('async function inspectionCreditMemoForInvoice');
    const memoFnEnd = source.indexOf('\n}', memoFnAt);
    const memoFn = source.slice(memoFnAt, memoFnEnd);
    expect(memoFnAt).toBeGreaterThan(-1);
    expect(memoFn).not.toContain("isEnabled('inspectionCredit')");
  });

  it('a deterministic resend miss raises the once-per-offer office alert (r25 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/inspection-credit.js'), 'utf8');
    // sendReceiptEmail reports no-recipient / suppressed / unavailable as
    // { ok:false } without throwing; this resend carries the only written
    // deadline, so a silent miss strands the promise. Deduped replays
    // return ok:true, so replays never false-alert.
    const sentCheckAt = source.indexOf('if (!sent?.ok) {');
    const alertAt = source.indexOf("alertOfficeOnce('receipt_resend_failed'");
    expect(sentCheckAt).toBeGreaterThan(-1);
    expect(alertAt).toBeGreaterThan(sentCheckAt);
  });

  it('the schedule route runs the no-show seam in its ONLY reachable no-show leg (r26 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    // Fresh no_show targets are rejected (no_show_wrong_route), so a
    // post-rejection `toStatus === 'no_show'` seam block was dead code —
    // the idempotent already-no_show replay is the one leg that can run,
    // and it must carry the seam.
    const replayAt = source.indexOf('alreadyNoShow: true');
    const seamAt = source.indexOf('no-show replay money seam');
    expect(replayAt).toBeGreaterThan(-1);
    expect(seamAt).toBeGreaterThan(-1);
    expect(seamAt).toBeLessThan(replayAt); // seam precedes the replay success
    // The unreachable block stays deleted.
    expect(source).not.toContain('no-show invoice void sweep failed');
  });

  it('booking evidence freezes its moment at call time, not at retry time (r26 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/inspection-credit.js'), 'utf8');
    // The post-commit retry reuses eventRow; a DB-default created_at would
    // stamp the RETRY time and shift the ordering evidence past a deadline
    // the booking actually beat.
    const fnAt = source.indexOf('async function markBookingForInspectionCredit');
    const rowAt = source.indexOf('const eventRow = {', fnAt);
    const frozenAt = source.indexOf('created_at: new Date(),', rowAt);
    const tryAt = source.indexOf('try {', fnAt);
    expect(frozenAt).toBeGreaterThan(rowAt);
    expect(frozenAt).toBeLessThan(tryAt); // frozen BEFORE the first insert attempt
  });

  it('marker-only booking paths fast-redeem after their event writes (r26/r27 P2)', () => {
    // A Charge Now / pay link sent before the hourly sweep would collect
    // the full amount while the credit strands afterwards.
    const ib = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/tools.js'), 'utf8');
    expect(ib).toContain("createdBy: 'system:inspection_credit_ib_booking'");
    const confirm = fs.readFileSync(path.join(__dirname, '../services/outbound-review-confirm.js'), 'utf8');
    expect(confirm).toContain("createdBy: 'system:inspection_credit_outbound_confirm'");
    const callProc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(callProc).toContain("createdBy: 'system:inspection_credit_call_booking'");
    const availability = fs.readFileSync(path.join(__dirname, '../services/availability.js'), 'utf8');
    expect(availability).toContain("createdBy: 'system:inspection_credit_availability_confirm'");
  });

  it('the outbound-confirm fast redeem requires the evidence write to land (r27 P2)', () => {
    const confirm = fs.readFileSync(path.join(__dirname, '../services/outbound-review-confirm.js'), 'utf8');
    // The outbound row was inserted when the AI opened the pending review;
    // without an event the redeemer falls back to that placeholder
    // created_at — a row opened in-window but confirmed after expiry would
    // mint a credit the booking did not earn. The sweep (event-only)
    // recovers once the post-commit retry lands the event.
    const markedAt = confirm.indexOf('const marked = await');
    const gateAt = confirm.indexOf('if (marked === 1) {');
    const redeemAt = confirm.indexOf("createdBy: 'system:inspection_credit_outbound_confirm'");
    expect(markedAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(markedAt);
    expect(redeemAt).toBeGreaterThan(gateAt); // redeem sits inside the gate
  });

  it('the tokenized receipt page carries the credit memo (r28 P2)', () => {
    // The SMS receipt leg only sends the page link — without the memo on
    // the page, an email-less customer never sees the written deadline and
    // the live-invoice alert suppression would be unearned.
    const route = fs.readFileSync(path.join(__dirname, '../routes/receipt-v2.js'), 'utf8');
    expect(route).toContain('inspectionCreditMemoForInvoice(data)');
    expect(route).toContain('creditMemo: creditMemo || null');
    const page = fs.readFileSync(path.join(__dirname, '../../client/src/pages/ReceiptPage.jsx'), 'utf8');
    expect(page).toContain('invoice.creditMemo && (');
  });

  it('the no-channel alert rechecks after the completion handler settles (r27 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/inspection-credit.js'), 'utf8');
    // setImmediate can outrun the handler's invoice mint — a first miss
    // defers and rechecks instead of paging billing for a normal visit
    // whose invoice lands moments later.
    const fnAt = source.indexOf('function queueCreditReceiptResend');
    const deferAt = source.indexOf('if (attempt < 1) {', fnAt);
    const alertAt = source.indexOf("alertOfficeOnce('no_receipt_channel'", fnAt);
    expect(deferAt).toBeGreaterThan(fnAt);
    expect(alertAt).toBeGreaterThan(deferAt); // defer decision precedes the alert
  });

  it('the no-receipt office alert waits out a LIVE unpaid invoice (r24 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/inspection-credit.js'), 'utf8');
    // An ordinary pay-after-service inspection has no PAID invoice at
    // closeout, but its unpaid invoice delivers the memo on its own receipt
    // when it settles — alerting then would page billing on every normal
    // visit. Only a visit with no deliverable customer invoice at all
    // escalates to a human.
    const helperAt = source.indexOf('function queueCreditReceiptResend');
    const guardAt = source.indexOf("whereNotIn('status', CANCELLED_SERVICE_RESOLVED_STATUSES)", helperAt);
    const alertAt = source.indexOf("alertOfficeOnce('no_receipt_channel'", helperAt);
    expect(helperAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(helperAt);
    expect(alertAt).toBeGreaterThan(guardAt); // guard runs before the alert
  });
});

describe('kill-switch posture — what must keep working while dark', () => {
  it('records booking EVIDENCE while dark, so a later gate-on can honor it', async () => {
    mockGateOn = false;
    const db = require('../models/db');
    const n = await markBookingForInspectionCredit(db, {
      customerId: 'cust-1', scheduledServiceId: 'svc-2', source: 'self_book',
    });
    // The event is a fact, not money — skipping it while dark would make an
    // offer promised beforehand unprovable and silently expire it.
    expect(n).toBe(1);
  });

  it('sweeps REVERSALS while dark but credits nothing', async () => {
    mockGateOn = false;
    const res = await sweepInspectionCreditRedemptions();
    // Crediting is paused...
    expect(res.redeemed).toBe(0);
    expect(res.reason).toBe('feature_disabled');
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
    // ...but the reversal half still ran (a cancelled booking's credit must
    // not stay spendable through a kill-switch period).
    expect(res).toHaveProperty('reversed');
  });

  it('recovers a COMMITTED opt-in marker while dark — the kill switch stops new promises, not old ones (r24 P2)', async () => {
    // A closeout that committed its marker while the lane was LIVE, whose
    // offer insert then crashed, must not stay stranded because the gate
    // went dark before the hourly recovery ran. Redemption stays gated —
    // the offer row is the record of the promise, not money.
    mockGateOn = false;
    mockOffers = [{
      id: 'svc-9', customer_id: 'cust-1', service_id: 'svcdef-1',
      record_id: 'rec-1', service_date: '2026-08-01',
      closed_out_at: new Date('2026-08-01T20:00:00Z'),
      frozen_terms: { amount: 75, windowDays: 30 },
    }];
    const res = await sweepInspectionCreditRedemptions();
    expect(res.recovered).toBe(1);
    expect(res.reason).toBe('feature_disabled');
    // Still NO money while dark.
    expect(res.redeemed).toBe(0);
    expect(mockPostCreditMovement).not.toHaveBeenCalled();
  });
});

describe('window + receipt copy', () => {
  it('rodent_inspection is a creditable inspection despite its family category (r24 P0)', () => {
    // The typed rodent-family cutover filed rodent_inspection's profile
    // under category 'rodent' — gating the credit on the category alone
    // silently excluded the one service whose estimator promise ($125
    // creditable) the credit must honor.
    expect(isCreditableInspectionProfile({ category: 'inspection', serviceKey: 'wdo_walkthrough' })).toBe(true);
    expect(isCreditableInspectionProfile({ category: 'rodent', serviceKey: 'rodent_inspection' })).toBe(true);
    expect(isCreditableInspectionProfile({ category: 'rodent', serviceKey: 'rodent_trapping_exclusion' })).toBe(false);
    expect(isCreditableInspectionProfile({ category: 'pest', serviceKey: 'pest_control' })).toBe(false);
    expect(isCreditableInspectionProfile(null)).toBe(false);
  });

  it('honors the existing rodent precedent, defaults everything else', () => {
    // rodent_inspection carries creditable_within_days in pricing_config.
    expect(creditWindowDaysForServiceKey('rodent_inspection')).toBeGreaterThan(0);
    expect(creditWindowDaysForServiceKey('wdo_inspection')).toBe(DEFAULT_CREDIT_WINDOW_DAYS);
    expect(creditWindowDaysForServiceKey(null)).toBe(DEFAULT_CREDIT_WINDOW_DAYS);
  });

  it('validates the admin-editable credit like every other money config', () => {
    const { validatePricingConfigData } = require('../routes/admin-pricing-config');
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 30 }).ok).toBe(true);
    expect(validatePricingConfigData('inspection_credit', { amount: 750, creditableWithinDays: 30 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 0, creditableWithinDays: 30 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75.001, creditableWithinDays: 30 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 0 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 400 }).ok).toBe(false);
    expect(validatePricingConfigData('inspection_credit', { amount: 75, creditableWithinDays: 1.5 }).ok).toBe(false);
  });

  it('names the LAST BOOKABLE day, not the exclusive expiry instant (r22 P1)', () => {
    // expires_at is ET midnight OPENING the day after the window, so
    // formatting it directly said "book by September 3" while a September 3
    // booking fails the redemption guard.
    const expiry = etEndOfDayAfterDays(new Date('2026-08-03T16:00:00Z'), 30);
    const memo = inspectionCreditReceiptMemo({ amount: 75, expiresAt: expiry });
    expect(memo).toContain('September 2, 2026');
    expect(memo).not.toContain('September 3');
  });

  it('states a flat SERVICE credit with the frozen deadline — never "your inspection fee"', () => {
    const memo = inspectionCreditReceiptMemo({ amount: 75, expiresAt: '2026-09-02T12:00:00Z' });
    expect(memo).toContain('$75.00 service credit');
    expect(memo).toContain('September 2, 2026');
    // The credit is FLAT, so calling it the fee paid would misstate a
    // comped or $125 inspection.
    expect(memo).not.toMatch(/your inspection fee/i);
    expect(inspectionCreditReceiptMemo({ amount: 0, expiresAt: '2026-09-02' })).toBeNull();
    expect(inspectionCreditReceiptMemo({ amount: 75 })).toBeNull();
    expect(inspectionCreditReceiptMemo({})).toBeNull();
  });
});
