/**
 * AI call bookings — schedule-conflict + time-sanity ADVISORY flags
 * (schedule-conflict lane, owner's chosen behavior): the insert txn's only
 * date-collision guard is customer-scoped, inbound bookings auto-confirm
 * with an immediate SMS, and the transcript-parsed time has no 8–5/weekend
 * clamp ("Sunday 7pm" books 19:00). The fix NEVER blocks: the booking
 * proceeds exactly as before, and a triage card (booking_time_conflict /
 * booking_out_of_hours) + admin bell surface the clash for the office.
 *
 * Detection is two-phase (round 3): the IN-TXN read is the lock-free fast
 * path — it races unlocked, so two concurrent call bookings (or a call
 * booking interleaving a rung-1 writer whose global predicate ran before
 * this insert committed) could EACH see nothing and land overlapping rows
 * with no card. The AUTHORITATIVE read is the POST-COMMIT recheck
 * (recheckCallBookingConflicts): a dedicated short transaction holding
 * rung 1 for one shared-module read. The booking txn itself still takes no
 * scheduling lock — it must never wait on (or lose to) one, and holding
 * rung 1 across its lead/customer/estimate row writes would invert against
 * the estimate-accept txn's row-locks-then-rung-1 order.
 *
 * The pure sanity helper + the recheck txn are tested directly via _test;
 * the wiring through the 500-line insert txn needs a live DB, so — matching
 * the established pattern (booking-availability-weekends.test.js) — the
 * load-bearing wiring is asserted at source level.
 */
const fs = require('fs');
const path = require('path');
const dbModule = require('../models/db');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { buildTriageItem } = require('../services/call-routing-gates');

const { callBookingTimeSanityFlags, recheckCallBookingConflicts } = CallRecordingProcessor._test;

describe('callBookingTimeSanityFlags', () => {
  test('weekday visit that starts AND ends inside 8a–5p is clean', () => {
    // 2099-01-05 is a Monday.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '09:00' })).toEqual([]);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '08:00' })).toEqual([]);
    // Ends exactly at close — the boundary is inclusive, a visit ending at
    // 17:00 has not run past it.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '16:00' })).toEqual([]);
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: '17:00',
    })).toEqual([]);
    // A short visit late in the day still fits.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', durationMinutes: 20,
    })).toEqual([]);
  });

  // The P1: the check only ever looked at the START, so a 60-minute booking
  // at 16:30 ran until 17:30 and passed clean. Advisory only — the booking
  // still lands; this just puts it on the same out-of-hours card.
  test('an in-hours start whose visit RUNS PAST close flags ends_after_business_hours', () => {
    // Duration-derived end (no explicit windowEnd): 16:30 + 60 = 17:30.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '16:30' }))
      .toEqual(['ends_after_business_hours']);
    // Explicit windowEnd is preferred over the duration.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:00', windowEnd: '18:00',
    })).toEqual(['ends_after_business_hours']);
    // A long duration overruns from a start nowhere near close.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '14:00', durationMinutes: 240,
    })).toEqual(['ends_after_business_hours']);
    // One minute past close is past close.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:00', windowEnd: '17:01',
    })).toEqual(['ends_after_business_hours']);
    // Combines with the weekend flag on the same card (2099-01-03 = Saturday).
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-03', windowStart: '16:30', windowEnd: '17:30',
    })).toEqual(['weekend', 'ends_after_business_hours']);
  });

  test('an already-out-of-hours START is not double-flagged for its equally-late end', () => {
    // 19:00 + 60 = 20:00, past close — but 'outside_business_hours' already
    // says everything the card needs; a second flag is noise.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '19:00', windowEnd: '20:00',
    })).toEqual(['outside_business_hours']);
  });

  test('an unusable windowEnd falls back to the duration instead of clearing the flag', () => {
    // End at/behind start (parse noise, or a window crossing midnight) is not
    // evidence the visit fits — fall back to the duration: 16:30 + 60.
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: '16:30',
    })).toEqual(['ends_after_business_hours']);
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: '00:30',
    })).toEqual(['ends_after_business_hours']);
    expect(callBookingTimeSanityFlags({
      scheduledDate: '2099-01-05', windowStart: '16:30', windowEnd: 'garbage',
    })).toEqual(['ends_after_business_hours']);
  });

  test('evening / early-morning starts flag outside_business_hours (the "Sunday 7pm" clamp gap)', () => {
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '19:00' }))
      .toEqual(['outside_business_hours']);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '07:59' }))
      .toEqual(['outside_business_hours']);
    // 17:00 start means the visit runs past close — flagged.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-05', windowStart: '17:00' }))
      .toEqual(['outside_business_hours']);
  });

  test('weekend dates flag (Sat and Sun), combining with hour flags', () => {
    // 2099-01-04 is a Sunday, 2099-01-03 a Saturday.
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-04', windowStart: '10:00' }))
      .toEqual(['weekend']);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-03', windowStart: '10:00' }))
      .toEqual(['weekend']);
    expect(callBookingTimeSanityFlags({ scheduledDate: '2099-01-04', windowStart: '19:00' }))
      .toEqual(['weekend', 'outside_business_hours']);
  });

  test('missing pieces degrade to no flags, never a throw', () => {
    expect(callBookingTimeSanityFlags({})).toEqual([]);
    expect(callBookingTimeSanityFlags({ scheduledDate: null, windowStart: null })).toEqual([]);
    expect(callBookingTimeSanityFlags({ scheduledDate: 'garbage', windowStart: 'garbage' })).toEqual([]);
  });
});

describe('recheckCallBookingConflicts — the authoritative post-commit read', () => {
  // knex defines `transaction` non-writable (but configurable) on the
  // instance — a plain assignment silently no-ops, so patch via
  // defineProperty and restore the original descriptor.
  const realTransactionDescriptor = Object.getOwnPropertyDescriptor(dbModule, 'transaction');
  const patchTransaction = (fn) => Object.defineProperty(dbModule, 'transaction', {
    value: fn, writable: true, configurable: true,
  });
  afterEach(() => {
    Object.defineProperty(dbModule, 'transaction', realTransactionDescriptor);
    jest.clearAllMocks();
  });

  // Knex-ish chain for the shared occupancy read: rows resolve at orderBy
  // (the chain tail), snapshotted AT QUERY TIME so a row committed between
  // two rechecks shows up in the second one.
  function makeProbeBuilder(liveRows) {
    const builder = {};
    Object.assign(builder, {
      where: jest.fn(function where(arg) {
        if (typeof arg === 'function') arg.call(builder, builder);
        return builder;
      }),
      whereNotIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      orWhereRaw: jest.fn().mockReturnThis(),
      orWhereNull: jest.fn().mockReturnThis(),
      orWhereNot: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn(() => Promise.resolve(liveRows.slice())),
    });
    return builder;
  }
  function wireRecheck(liveRows) {
    const builders = [];
    const trxs = [];
    const transaction = jest.fn(async (callback) => {
      const builder = makeProbeBuilder(liveRows);
      builders.push(builder);
      const trx = jest.fn(() => builder);
      trx.raw = jest.fn().mockResolvedValue(undefined);
      trxs.push(trx);
      return callback(trx);
    });
    patchTransaction(transaction);
    return { builders, trxs, transaction };
  }

  test('takes the rung-1 date lock in its OWN short txn, granted BEFORE the shared read', async () => {
    const { builders, trxs, transaction } = wireRecheck([{ id: 'svc-existing', window_start: '09:30:00' }]);

    const rows = await recheckCallBookingConflicts({
      scheduledDate: '2099-01-05',
      windowStart: '09:00',
      windowEnd: '10:00',
      excludeCustomerId: 'cust-1',
      excludeServiceIds: ['svc-fresh', undefined],
    });

    // Findings carry the which-visit annotation (the one-visit legacy form
    // is a primary-only recheck with no created-row id). same_customer can
    // never be true here — the primary probe excludes the customer's rows.
    expect(rows).toEqual([{
      id: 'svc-existing',
      window_start: '09:30:00',
      overlaps_visit: 'primary',
      overlaps_service_id: null,
      same_customer: false,
    }]);
    // A dedicated transaction — not the booking txn.
    expect(transaction).toHaveBeenCalledTimes(1);
    // Rung 1 on the booking's date, same shared key shape as every writer...
    expect(trxs[0].raw).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['slot-reserve', 'occupancy:2099-01-05'],
    );
    // ...and GRANTED before the conflict read — the serialization IS the
    // reliability: any rung-1 writer mid-commit finishes first and is seen.
    expect(trxs[0].raw.mock.invocationCallOrder[0])
      .toBeLessThan(builders[0].where.mock.invocationCallOrder[0]);
    // Same exclusion semantics as the in-txn advisory read (same-customer
    // rows are the same-day guard's business) + this run's fresh rows,
    // falsy entries dropped.
    expect(builders[0].orWhereNot).toHaveBeenCalledWith('customer_id', 'cust-1');
    expect(builders[0].whereNotIn).toHaveBeenCalledWith('id', ['svc-fresh']);
  });

  test('a conflict ABSENT at the pre-insert check but committed by recheck time IS returned (the race the lock closes)', async () => {
    const committedRows = [];
    wireRecheck(committedRows);
    const args = {
      scheduledDate: '2099-01-05',
      windowStart: '09:00',
      windowEnd: '10:00',
      excludeCustomerId: 'cust-1',
      excludeServiceIds: ['svc-fresh'],
    };

    // The in-txn advisory read's moment: the concurrent writer hasn't
    // committed yet — nothing to see.
    await expect(recheckCallBookingConflicts(args)).resolves.toEqual([]);

    // The concurrent booking commits its overlapping row...
    committedRows.push({ id: 'svc-concurrent', window_start: '09:15:00' });

    // ...and the post-commit recheck — the read that feeds the triage card —
    // sees it.
    await expect(recheckCallBookingConflicts(args)).resolves.toEqual([
      {
        id: 'svc-concurrent',
        window_start: '09:15:00',
        overlaps_visit: 'primary',
        overlaps_service_id: null,
        same_customer: false,
      },
    ]);
  });

  // Per-probe FIFO wiring for the multi-visit form: each findConflictingVisits
  // read consumes the next builder, so the two created rows' probes can
  // resolve different committed truths.
  function wireRecheckQueue(rowsPerProbe) {
    const builders = [];
    const trxs = [];
    const transaction = jest.fn(async (callback) => {
      const queue = rowsPerProbe.map((rows) => makeProbeBuilder(rows));
      builders.push(...queue);
      const trx = jest.fn(() => queue.shift());
      trx.raw = jest.fn().mockResolvedValue(undefined);
      trxs.push(trx);
      return callback(trx);
    });
    patchTransaction(transaction);
    return { builders, trxs, transaction };
  }

  test('multi-visit form (codex P1): the follow-up child is rechecked against its OWN date and the finding names it', async () => {
    // Primary window clean — the overlap sits on the +14d follow-up's own
    // date, which the old primary-window query could never see (the child
    // was merely EXCLUDED from it).
    const { builders, trxs } = wireRecheckQueue([
      [], // primary probe
      [{ id: 'svc-existing-fu', window_start: '09:30:00' }], // follow-up probe
    ]);

    const rows = await recheckCallBookingConflicts({
      visits: [
        { id: 'svc-primary', role: 'primary', scheduledDate: '2099-01-05', windowStart: '09:00', windowEnd: '10:00' },
        { id: 'svc-followup', role: 'follow_up', scheduledDate: '2099-01-19', windowStart: '09:00', windowEnd: '10:00' },
      ],
      excludeCustomerId: 'cust-1',
      excludeServiceIds: ['svc-primary', 'svc-followup'],
    });

    // The finding says WHICH created visit clashes — the card is unreadable
    // without it (the headline names the primary's date).
    expect(rows).toEqual([{
      id: 'svc-existing-fu',
      window_start: '09:30:00',
      overlaps_visit: 'follow_up',
      overlaps_service_id: 'svc-followup',
      same_customer: false,
    }]);
    // Customer exclusion is PRIMARY-ONLY (round-4 P1): the in-txn same-day
    // guard vets same-customer rows on the primary's date and no other, so
    // the follow-up's probe must keep the customer's own visits in view.
    expect(builders[0].orWhereNot).toHaveBeenCalledWith('customer_id', 'cust-1');
    expect(builders[1].orWhereNot).not.toHaveBeenCalled();
    // One rung-1 key per distinct date, both granted BEFORE the first probe
    // read (still one dedicated short transaction).
    const lockCalls = trxs[0].raw.mock.calls
      .filter((c) => String(c[0]).includes('pg_advisory_xact_lock'));
    expect(lockCalls.map((c) => c[1])).toEqual([
      ['slot-reserve', 'occupancy:2099-01-05'],
      ['slot-reserve', 'occupancy:2099-01-19'],
    ]);
    expect(trxs[0].raw.mock.invocationCallOrder[1])
      .toBeLessThan(builders[0].where.mock.invocationCallOrder[0]);
    // EVERY probe excludes ALL of this call's fresh rows — the row being
    // checked and its sibling (deduped against the belt-and-braces
    // excludeServiceIds the call site also passes).
    expect(builders[0].whereNotIn).toHaveBeenCalledWith('id', ['svc-primary', 'svc-followup']);
    expect(builders[1].whereNotIn).toHaveBeenCalledWith('id', ['svc-primary', 'svc-followup']);
  });

  test('a SAME-CUSTOMER clash on the follow-up\'s own date IS returned, marked, with the primary still customer-excluded (round-4 P1)', async () => {
    // The +14d follow-up lands on a date where THIS customer already has a
    // visit. The in-txn same-day guard only ever vetted the PRIMARY's date,
    // and the old recheck passed excludeCustomerId on every probe — so this
    // clash produced no card at all. The follow-up probe now keeps the
    // customer's rows in view and the finding is marked same_customer so
    // the card doesn't read as a cross-customer double-booking.
    const { builders } = wireRecheckQueue([
      [], // primary probe — clean
      [{ id: 'svc-own-visit', customer_id: 'cust-1', window_start: '09:30:00' }],
    ]);

    const rows = await recheckCallBookingConflicts({
      visits: [
        { id: 'svc-primary', role: 'primary', scheduledDate: '2099-01-05', windowStart: '09:00', windowEnd: '10:00' },
        { id: 'svc-followup', role: 'follow_up', scheduledDate: '2099-01-19', windowStart: '09:00', windowEnd: '10:00' },
      ],
      excludeCustomerId: 'cust-1',
      excludeServiceIds: ['svc-primary', 'svc-followup'],
    });

    expect(rows).toEqual([{
      id: 'svc-own-visit',
      customer_id: 'cust-1',
      window_start: '09:30:00',
      overlaps_visit: 'follow_up',
      overlaps_service_id: 'svc-followup',
      same_customer: true,
    }]);
    // The primary keeps its exclusion (same-day guard owns those semantics);
    // the follow-up probe carries none — but both still exclude this call's
    // own fresh rows.
    expect(builders[0].orWhereNot).toHaveBeenCalledWith('customer_id', 'cust-1');
    expect(builders[1].orWhereNot).not.toHaveBeenCalled();
    expect(builders[1].whereNotIn).toHaveBeenCalledWith('id', ['svc-primary', 'svc-followup']);
  });

  test('multi-date rung-1 keys are acquired in SORTED order regardless of visit order (deadlock-free contract)', async () => {
    const { trxs } = wireRecheckQueue([[], []]);

    // Follow-up entry FIRST — the lock sequence must still come out
    // ascending (acquireOccupancyLocks dedups + sorts), or two concurrent
    // multi-date lockers could grab a shared pair in opposite orders.
    await recheckCallBookingConflicts({
      visits: [
        { id: 'svc-followup', role: 'follow_up', scheduledDate: '2099-01-19', windowStart: '09:00', windowEnd: '10:00' },
        { id: 'svc-primary', role: 'primary', scheduledDate: '2099-01-05', windowStart: '09:00', windowEnd: '10:00' },
      ],
      excludeCustomerId: 'cust-1',
    });

    expect(trxs[0].raw.mock.calls
      .filter((c) => String(c[0]).includes('pg_advisory_xact_lock'))
      .map((c) => c[1])).toEqual([
      ['slot-reserve', 'occupancy:2099-01-05'],
      ['slot-reserve', 'occupancy:2099-01-19'],
    ]);
  });
});

describe('booking conflict wiring (source-level — behavior needs a live DB)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the occupancy check runs inside the insert txn, cross-customer, and NEVER blocks the insert', () => {
    // Between the same-day hold and insertData: the shared-module call with
    // the same-customer exclusion.
    const txnSlice = src.slice(
      src.indexOf("reason: 'existing_appointment_same_date'"),
      src.indexOf('const insertData = {'),
    );
    expect(txnSlice).toContain("require('./scheduling/occupancy')");
    expect(txnSlice).toContain('excludeCustomerId: customerId');
    // Advisory only: the check has no throw and its failure path books
    // unflagged rather than failing the booking.
    expect(txnSlice).not.toContain('throw');
    expect(txnSlice).toContain('booking proceeds unflagged');
    // The booking txn itself stays LOCK-FREE: it must never wait on (or
    // deadlock-abort against) a scheduling lock — its post-insert work
    // row-locks leads/customers/estimates, tables the estimate-accept txn
    // locks BEFORE taking rung 1 inside commitReservation. The lock lives
    // in the post-commit recheck's own txn instead.
    expect(txnSlice).not.toContain('acquireOccupancyLock');
  });

  test('the AUTHORITATIVE recheck runs post-commit under rung 1 and its result feeds the card', () => {
    // Helper: its own db.transaction, the sorted multi-date rung-1
    // acquisition granted before every per-row shared read, nothing else
    // inside.
    const helperIdx = src.indexOf('async function recheckCallBookingConflicts(');
    expect(helperIdx).toBeGreaterThan(-1);
    const helper = src.slice(helperIdx, helperIdx + 2600);
    expect(helper).toContain('db.transaction');
    expect(helper.indexOf('await acquireOccupancyLocks(trx, targets.map((v) => v.scheduledDate));'))
      .toBeLessThan(helper.indexOf('await findConflictingVisits({'));
    expect(helper.indexOf('await acquireOccupancyLocks(trx, targets.map((v) => v.scheduledDate));')).toBeGreaterThan(-1);
    // Customer exclusion is PRIMARY-ONLY inside the helper (round-4 P1) —
    // the follow-up probe must see the customer's own rows on its date.
    expect(helper).toContain('excludeCustomerId: isPrimary ? excludeCustomerId : null');

    // Call site: fresh inserts only (inside the !scheduleWasReused card
    // block), REASSIGNS bookingTimeConflicts before the card condition reads
    // it, rechecks the follow-up child against its OWN date/window (codex
    // P1 — it used to be merely excluded from the primary's query),
    // excludes this run's own fresh rows, and falls back to the in-txn
    // findings on failure instead of dropping the card.
    const cardSlice = src.slice(
      src.indexOf("flag: 'unassigned_auto_booking'"),
      src.indexOf('const timeSanityFlags = callBookingTimeSanityFlags({'),
    );
    expect(cardSlice).toContain('bookingTimeConflicts = await recheckCallBookingConflicts({');
    expect(cardSlice).toContain('visits: recheckVisits');
    expect(cardSlice).toContain("role: 'follow_up'");
    expect(cardSlice).toContain('scheduledDate: callBookingDateOnly(followUpCreated.scheduled_date)');
    expect(cardSlice).toContain('windowEnd: followUpCreated.window_end');
    expect(cardSlice).toContain('excludeServiceIds: [svc.id, followUpCreated?.id]');
    expect(cardSlice).toContain('excludeCustomerId: customerId');
    expect(cardSlice).toContain('falling back to in-txn advisory findings');
    const recheckIdx = src.indexOf('bookingTimeConflicts = await recheckCallBookingConflicts({');
    // Post-commit: after the booking transaction's own insert...
    expect(recheckIdx).toBeGreaterThan(src.indexOf('const insertData = {'));
    // ...and before the card condition that consumes the result.
    expect(recheckIdx).toBeLessThan(src.indexOf('if (bookingTimeConflicts.length || timeSanityFlags.length)'));
  });

  test('the card + bell say WHICH created visit clashes — primary vs the follow-up child', () => {
    const cardSlice = src.slice(
      src.indexOf('conflicting_visits: bookingTimeConflicts.map'),
      src.indexOf('attachedManualBookingId && attachSkippedFollowUpPlan'),
    );
    // Each conflicting-visit entry is attributed (in-txn fallback rows were
    // probed against the primary's window only, so 'primary' is the honest
    // default there)...
    expect(cardSlice).toContain("overlaps_visit: r.overlaps_visit || 'primary'");
    // ...a same-customer follow-up clash is marked so it doesn't read as a
    // cross-customer double-booking (false is honest for the customer-
    // excluded in-txn fallback rows)...
    expect(cardSlice).toContain('same_customer: r.same_customer || false');
    // ...the card resolves a follow_up tag to the concrete child row...
    expect(cardSlice).toContain('follow_up: followUpCreated ?');
    // ...and the admin bell's message + metadata carry the attribution too,
    // including the same-customer wording.
    expect(cardSlice).toContain("on the follow-up visit's date");
    expect(cardSlice).toContain("the customer's own existing visit");
    expect(cardSlice).toContain('followUpScheduledServiceId');
  });

  test('a fresh booking with findings gets the advisory triage card + admin bell', () => {
    const cardSlice = src.slice(
      src.indexOf("flag: 'unassigned_auto_booking'"),
      src.indexOf('attachedManualBookingId && attachSkippedFollowUpPlan'),
    );
    expect(cardSlice).toContain("'booking_time_conflict'");
    expect(cardSlice).toContain("'booking_out_of_hours'");
    expect(cardSlice).toContain("severity: 'advisory'");
    expect(cardSlice).toContain('conflicting_visits');
    expect(cardSlice).toContain('time_sanity_flags');
    // Same open-card dedupe upsert as every other triage insert here.
    expect(cardSlice).toContain("onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\\'open\\', \\'in_progress\\')'))");
    // Admin bell rides the shared notification channel.
    expect(cardSlice).toContain("require('./notification-service').notifyAdmin");
    expect(cardSlice).toContain("'schedule'");
  });

  test('the sanity helper is fed the visit END, not just its start', () => {
    const callSlice = src.slice(
      src.indexOf('const timeSanityFlags = callBookingTimeSanityFlags({'),
      src.indexOf("if (bookingTimeConflicts.length || timeSanityFlags.length)"),
    );
    // Same end + duration the visit row was inserted with — an end-past-close
    // flag computed from anything else would describe a different visit.
    expect(callSlice).toContain('windowEnd:');
    expect(callSlice).toContain('durationMinutes:');
    expect(callSlice).toContain('DEFAULT_CALL_BOOKING_DURATION_MINUTES');
    // The card carries the end so the office can read the overrun.
    const cardSlice = src.slice(
      src.indexOf("flag: conflictFlag"),
      src.indexOf('conflicting_visits'),
    );
    expect(cardSlice).toContain('window_end:');
  });

  test('both flags map to the time_ambiguous review lane', () => {
    expect(buildTriageItem({ callLogId: 'c1', flag: 'booking_time_conflict' }).category).toBe('time_ambiguous');
    expect(buildTriageItem({ callLogId: 'c1', flag: 'booking_out_of_hours' }).category).toBe('time_ambiguous');
  });
});
