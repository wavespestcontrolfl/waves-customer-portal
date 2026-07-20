/**
 * Backdated quiet completion (`backfill: true` on POST /:serviceId/complete).
 * Unit-tests the past-date guard + service-date source via the exported
 * backfillCompletionPlan, then pins the route wiring with source contracts:
 * the giant completion route can't be exercised end-to-end here, but the
 * load-bearing lines — backdated completionServiceDate, forced comms/review
 * suppression (initial AND post-resume re-derivation), the structured_notes
 * freeze, the near-term invoice due date, the admin-only authz gate, the
 * quiet card mint, the account-credit skip, the prepaid-credit skip (the
 * rail mutates the invoice — reduces it, books a payments row, can flip it
 * paid — so it is GATED like the other money rails, not "safe by nature"),
 * the fully-prepaid review-invoice mint (out-of-band coverage must not
 * suppress the promised open invoice — behavioral via the exported
 * shouldAutoInvoiceCompletion), the no-fabricated-durations policy, the
 * no-fabricated-arrivals strip (a typed duration must not back-derive a
 * today-dated start onto a backdated row), the typed one-time pre-gate
 * bypass (backfill mints the draft review invoice instead of detouring to
 * checkout), and the labor-costing guard — must not be refactored away
 * silently. Fix round 2 (Codex, PR #2897) adds: the end-stamp policy (a
 * kept real stale check-in must never pair with today's closeout stamp, so
 * blank-typed durations stay UNKNOWN to every start→end fallback reader),
 * the conditions gate (no current-day weather on a backdated record or its
 * FDACS ledger rows), the deposit-credit skip (the review invoice mints at
 * face value; the estimate's deposit stays unapplied, logged for the
 * reviewer), and the flagless-resume hash exclusion (a crash-resumed retry
 * without the body flag must reach the structured_notes re-derivation, not
 * strand on completion_resume_payload_mismatch). Fix round 3 (Codex P1):
 * the tracker-completion leg — both post-commit markComplete calls flag the
 * span untrusted so the tracker's own lifecycle rebuild cannot re-stamp
 * what the policy stripped, and the resume re-derivation sits before the
 * first of them.
 */
const fs = require('fs');
const path = require('path');
const {
  backfillCompletionPlan,
  applyBackfillDurationPolicy,
  applyBackfillRecordTimingPolicy,
  backfillTimeOnSiteMinutes,
  BACKFILL_MAX_TIME_ON_SITE_MINUTES,
  BACKFILL_INFERRED_START_FIELDS,
  BACKFILL_LIFECYCLE_END_FIELDS,
  BACKFILL_RECORD_END_FIELDS,
  shouldAutoInvoiceCompletion,
  shouldCaptureApplicationConditions,
} = require('../routes/admin-dispatch')._test;
const { buildCompletionLifecycleUpdates } = require('../utils/service-duration-capture');
const { buildServiceRecordCompletionTimingFields } = require('../services/service-report/service-record-timing');
const { computeOnSiteMin } = require('../services/service-report/metrics-band');
const { hashCompletionRequest } = require('../services/completion-attempts');

const TODAY = '2026-07-19';

describe('backfillCompletionPlan', () => {
  test('absent/false flag → inactive, no error', () => {
    expect(backfillCompletionPlan({ scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
    expect(backfillCompletionPlan({ backfill: false, scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
  });

  test('only boolean true activates — truthy strings do not backdate', () => {
    expect(backfillCompletionPlan({ backfill: 'true', scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
    expect(backfillCompletionPlan({ backfill: 1, scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
  });

  test('past-dated row + admin → active, serviceDate comes from the row (not today)', () => {
    const plan = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-07-01', today: TODAY, role: 'admin' });
    expect(plan.active).toBe(true);
    expect(plan.serviceDate).toBe('2026-07-01');
  });

  test('normalizes a pg Date-object scheduled_date to the calendar date', () => {
    const plan = backfillCompletionPlan({
      backfill: true,
      scheduledDate: new Date('2026-07-01T00:00:00Z'),
      today: TODAY,
      role: 'admin',
    });
    expect(plan.active).toBe(true);
    expect(plan.serviceDate).toBe('2026-07-01');
  });

  test("today's visit is rejected — same-day completions stay on the normal path", () => {
    const plan = backfillCompletionPlan({ backfill: true, scheduledDate: TODAY, today: TODAY, role: 'admin' });
    expect(plan.active).toBe(false);
    expect(plan.error.code).toBe('backfill_not_past');
  });

  test('future-dated and missing scheduled_date are rejected', () => {
    expect(backfillCompletionPlan({ backfill: true, scheduledDate: '2026-08-01', today: TODAY, role: 'admin' }).error.code)
      .toBe('backfill_not_past');
    expect(backfillCompletionPlan({ backfill: true, scheduledDate: null, today: TODAY, role: 'admin' }).error.code)
      .toBe('backfill_not_past');
  });

  // Backfill is a financial/comms override (suppresses charges + customer
  // sends) on a requireTechOrAdmin route — a technician token must not be
  // able to invoke it.
  test('technician role → 403 backfill_admin_only, even for a valid past date', () => {
    const plan = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-07-01', today: TODAY, role: 'technician' });
    expect(plan.active).toBe(false);
    expect(plan.status).toBe(403);
    expect(plan.error.code).toBe('backfill_admin_only');
  });

  test('missing/unknown role fail-closes to 403 (authz checked before date validation)', () => {
    const missing = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-07-01', today: TODAY });
    expect(missing.status).toBe(403);
    expect(missing.error.code).toBe('backfill_admin_only');
    // Even an invalid date fails on authz first — no validation oracle for techs.
    const techFuture = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-08-01', today: TODAY, role: 'technician' });
    expect(techFuture.error.code).toBe('backfill_admin_only');
  });

  test('non-backfill requests never hit the role gate — techs complete visits normally', () => {
    expect(backfillCompletionPlan({ scheduledDate: '2026-07-01', today: TODAY, role: 'technician' })).toEqual({ active: false });
    expect(backfillCompletionPlan({ backfill: false, scheduledDate: '2026-07-01', today: TODAY, role: 'technician' })).toEqual({ active: false });
  });
});

describe('applyBackfillDurationPolicy — no fabricated durations (Codex P1, fix round)', () => {
  // A stale on_site row: checked in weeks ago, closed out from the office
  // today. The shared lifecycle helper's timestamp fallback would book the
  // whole gap as the service duration.
  const STALE_SVC = {
    status: 'on_site',
    actual_start_time: '2026-06-20T14:00:00Z',
    check_in_time: '2026-06-20T14:00:00Z',
  };
  const CLOSEOUT_AT = new Date('2026-07-19T16:00:00Z'); // 29 days later

  test('the hazard is real: without the policy, the helper books the stale gap as duration', () => {
    const raw = buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT);
    expect(raw.service_time_minutes).toBeGreaterThan(24 * 60); // weeks, not a visit
  });

  test('no explicit timeOnSite → duration keys stripped, columns stay unknown (never elapsed math)', () => {
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT),
      undefined,
      STALE_SVC,
    );
    expect(updates).not.toHaveProperty('service_time_minutes');
    expect(updates).not.toHaveProperty('actual_duration_minutes');
    // Fix round 2 (Codex P1): the end stamps are dropped too — with the
    // row's real stale check-in kept, today's actual_end_time/check_out_time
    // would complete a start→end pair every timeOnSite-null fallback reader
    // re-derives the stale span from (dedicated coverage below).
    expect(updates).not.toHaveProperty('actual_end_time');
    expect(updates).not.toHaveProperty('check_out_time');
  });

  test('explicit timeOnSite is honored in every shape the completion body sends', () => {
    for (const [input, expected] of [[45, 45], ['45', 45], ['0:45:00', 45], ['90 min', 90]]) {
      const updates = applyBackfillDurationPolicy(
        buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: input }),
        input,
      );
      expect(updates.service_time_minutes).toBe(expected);
      expect(updates.actual_duration_minutes).toBe(expected);
    }
  });

  // Codex P1 (PR #2897): the pre-fix panel auto-submitted its running
  // elapsed — the stale span itself, relabeled as "explicit" input. A
  // provided value is only explicit within a workday; beyond the cap it is
  // treated as absent (columns stay unknown), never a 400.
  test('an auto-elapsed-sized timeOnSite (2 weeks) is rejected by the workday cap — duration keys stripped', () => {
    for (const oversized of [20160, '20160', '336:00:00']) { // 2 weeks as number, string, H:MM:SS
      const updates = applyBackfillDurationPolicy(
        buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: oversized }),
        oversized,
      );
      expect(updates).not.toHaveProperty('service_time_minutes');
      expect(updates).not.toHaveProperty('actual_duration_minutes');
    }
  });

  test('the cap boundary: a full workday (720) is honored, one minute past it is not', () => {
    const atCap = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: 720 }),
      720,
    );
    expect(atCap.service_time_minutes).toBe(BACKFILL_MAX_TIME_ON_SITE_MINUTES);
    const pastCap = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: 721 }),
      721,
    );
    expect(pastCap).not.toHaveProperty('service_time_minutes');
    expect(pastCap).not.toHaveProperty('actual_duration_minutes');
  });

  test('garbage timeOnSite is not a fabrication license — falls back to unknown, not to the stale span', () => {
    for (const junk of ['', '  ', 'abc', -5, 0, null]) {
      const updates = applyBackfillDurationPolicy(
        buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: junk }),
        junk,
      );
      expect(updates).not.toHaveProperty('service_time_minutes');
      expect(updates).not.toHaveProperty('actual_duration_minutes');
    }
  });

  test('a never-checked-in stale row (pending/confirmed) stays unknown too — and keeps the closeout audit stamps', () => {
    const neverStarted = { status: 'pending' };
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(neverStarted, CLOSEOUT_AT),
      undefined,
      neverStarted,
    );
    expect(updates).not.toHaveProperty('service_time_minutes');
    expect(updates).not.toHaveProperty('actual_duration_minutes');
    // With no start anywhere there is no pair to poison: the end stamps stay
    // as the record of when the closeout was recorded.
    expect(updates.actual_end_time).toEqual(CLOSEOUT_AT);
    expect(updates.check_out_time).toEqual(CLOSEOUT_AT);
  });
});

describe('applyBackfillDurationPolicy — no fabricated arrivals (Codex P1, PR #2897)', () => {
  const CLOSEOUT_AT = new Date('2026-07-19T16:00:00Z');
  // A stale pending/confirmed row: nobody ever checked in, so the row has no
  // start timestamps at all.
  const NEVER_STARTED = { status: 'pending' };

  test('the hazard is real: a typed duration makes the shared helper back-derive a TODAY arrival', () => {
    const raw = buildCompletionLifecycleUpdates(NEVER_STARTED, CLOSEOUT_AT, { elapsed: 45 });
    const fabricated = new Date(CLOSEOUT_AT.getTime() - 45 * 60000);
    expect(raw.actual_start_time).toEqual(fabricated);
    expect(raw.check_in_time).toEqual(fabricated);
    expect(raw.arrived_at).toEqual(fabricated);
  });

  test('the strip list mirrors exactly the fields the helper infers from a typed duration', () => {
    const raw = buildCompletionLifecycleUpdates(NEVER_STARTED, CLOSEOUT_AT, { elapsed: 45 });
    const nonStartKeys = ['actual_end_time', 'check_out_time', 'service_time_minutes', 'actual_duration_minutes'];
    const inferredKeys = Object.keys(raw).filter((k) => !nonStartKeys.includes(k));
    expect([...inferredKeys].sort()).toEqual([...BACKFILL_INFERRED_START_FIELDS].sort());
  });

  test('row without start timestamps + typed 45 → no arrival fields written, duration kept', () => {
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(NEVER_STARTED, CLOSEOUT_AT, { elapsed: 45 }),
      45,
      NEVER_STARTED,
    );
    for (const field of BACKFILL_INFERRED_START_FIELDS) {
      expect(updates).not.toHaveProperty(field);
    }
    // The round-earlier policy still lands the typed duration…
    expect(updates.service_time_minutes).toBe(45);
    expect(updates.actual_duration_minutes).toBe(45);
    // …and the closeout audit stamps survive (they record when the closeout
    // was recorded, not the visit — see the route comment).
    expect(updates.actual_end_time).toEqual(CLOSEOUT_AT);
    expect(updates.check_out_time).toEqual(CLOSEOUT_AT);
  });

  test('a row WITH stale real timestamps keeps them untouched — historical truth is never stripped or rewritten', () => {
    const staleStarted = {
      status: 'on_site',
      actual_start_time: '2026-06-20T14:00:00Z',
      check_in_time: '2026-06-20T14:05:00Z',
      arrived_at: '2026-06-20T13:55:00Z',
    };
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(staleStarted, CLOSEOUT_AT, { elapsed: 45 }),
      45,
      staleStarted,
    );
    // The helper never rewrites an existing start, and the policy must not
    // turn "keep" into a null-out — the columns are simply absent from the
    // update, so the row's own (stale but real) values persist.
    for (const field of BACKFILL_INFERRED_START_FIELDS) {
      expect(updates).not.toHaveProperty(field);
    }
    expect(updates.service_time_minutes).toBe(45);
  });

  test('per-field contract: a start key survives ONLY where the row itself carries a real timestamp', () => {
    const synthetic = () => ({
      actual_start_time: new Date('2026-07-19T15:15:00Z'),
      check_in_time: new Date('2026-07-19T15:15:00Z'),
      arrived_at: new Date('2026-07-19T15:15:00Z'),
      service_time_minutes: 45,
      actual_duration_minutes: 45,
    });
    // Row backs one field → only that key may pass through.
    const rowWithOne = { check_in_time: '2026-06-20T14:00:00Z' };
    const kept = applyBackfillDurationPolicy(synthetic(), 45, rowWithOne);
    expect(kept).toHaveProperty('check_in_time');
    expect(kept).not.toHaveProperty('actual_start_time');
    expect(kept).not.toHaveProperty('arrived_at');
    // An unparseable row value is not a real timestamp — still stripped.
    const garbageRow = { actual_start_time: 'not-a-date' };
    expect(applyBackfillDurationPolicy(synthetic(), 45, garbageRow))
      .not.toHaveProperty('actual_start_time');
  });

  test('the backdated service RECORD carries no fabricated arrival either — timing fields fall back to null', () => {
    const allCols = {
      started_at: true, arrived_at: true, actual_start_time: true, check_in_time: true,
      ended_at: true, completed_at: true, actual_end_time: true, check_out_time: true,
    };
    const stripped = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(NEVER_STARTED, CLOSEOUT_AT, { elapsed: 45 }),
      45,
      NEVER_STARTED,
    );
    const fields = buildServiceRecordCompletionTimingFields({
      scheduledService: NEVER_STARTED,
      lifecycleUpdates: stripped,
      completedAt: CLOSEOUT_AT,
      serviceRecordCols: allCols,
    });
    expect(fields.started_at).toBeNull();
    expect(fields.arrived_at).toBeNull();
    expect(fields.actual_start_time).toBeNull();
    expect(fields.check_in_time).toBeNull();
    // A row with a real stale timestamp stamps THAT into the record (the
    // builder reads the scheduled row first).
    const staleRow = { arrived_at: '2026-06-20T13:55:00Z' };
    const staleFields = buildServiceRecordCompletionTimingFields({
      scheduledService: staleRow,
      lifecycleUpdates: applyBackfillDurationPolicy(
        buildCompletionLifecycleUpdates(staleRow, CLOSEOUT_AT, { elapsed: 45 }),
        45,
        staleRow,
      ),
      completedAt: CLOSEOUT_AT,
      serviceRecordCols: allCols,
    });
    expect(staleFields.arrived_at).toBe('2026-06-20T13:55:00Z');
  });
});

describe('backfill end-stamp policy — durations stay unknown despite a real stale check-in (Codex P1, PR #2897 fix round)', () => {
  const CLOSEOUT_AT = new Date('2026-07-19T16:00:00Z');
  // The reported shape: a stale on_site row with a REAL weeks-old check-in,
  // closed out with Time on site left blank. The kept start is historical
  // truth; today's end stamps are not — and every consumer that falls back
  // to start→end when structured_notes.timeOnSite is null (service-report
  // metrics-band computeOnSiteMin, pricing-reality-check
  // resolveActualMinutes) would re-derive the stale span AT READ TIME.
  const STALE_CHECKED_IN = {
    status: 'on_site',
    actual_start_time: '2026-06-20T14:00:00Z',
    check_in_time: '2026-06-20T14:00:00Z',
    arrived_at: '2026-06-20T13:55:00Z',
  };
  const ALL_RECORD_COLS = {
    started_at: true, arrived_at: true, actual_start_time: true, check_in_time: true,
    ended_at: true, completed_at: true, actual_end_time: true, check_out_time: true,
  };
  const buildRecordTiming = (svc, timeOnSite) => {
    const lifecycleUpdates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(svc, CLOSEOUT_AT, { elapsed: timeOnSite }),
      timeOnSite,
      svc,
    );
    return applyBackfillRecordTimingPolicy(
      buildServiceRecordCompletionTimingFields({
        scheduledService: svc,
        lifecycleUpdates,
        completedAt: CLOSEOUT_AT,
        serviceRecordCols: ALL_RECORD_COLS,
      }),
      timeOnSite,
      svc,
    );
  };

  test('the hazard is real: the codex-named reader books the stale span from a kept start against a today end', () => {
    // metrics-band with timeOnSite null falls back to started_at→ended_at —
    // the exact pair the pre-fix record carried.
    const derived = computeOnSiteMin({
      started_at: STALE_CHECKED_IN.check_in_time,
      ended_at: CLOSEOUT_AT.toISOString(),
      timeOnSite: null,
    });
    expect(derived).toBeGreaterThan(24 * 60); // weeks, not a visit
  });

  test('lifecycle leg: blank typed time + real check-in → NO end stamps, NO durations, start columns untouched', () => {
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_CHECKED_IN, CLOSEOUT_AT),
      undefined,
      STALE_CHECKED_IN,
    );
    for (const field of BACKFILL_LIFECYCLE_END_FIELDS) {
      expect(updates).not.toHaveProperty(field);
    }
    expect(updates).not.toHaveProperty('service_time_minutes');
    expect(updates).not.toHaveProperty('actual_duration_minutes');
    // The kept start is absent from the UPDATE — the row's own (real, stale)
    // values persist untouched; keeping is never a rewrite.
    for (const field of BACKFILL_INFERRED_START_FIELDS) {
      expect(updates).not.toHaveProperty(field);
    }
  });

  test('lifecycle leg: the strip list mirrors exactly the end fields the shared helper stamps', () => {
    const raw = buildCompletionLifecycleUpdates(STALE_CHECKED_IN, CLOSEOUT_AT);
    const endKeys = Object.keys(raw).filter((key) => raw[key] instanceof Date);
    expect([...endKeys].sort()).toEqual([...BACKFILL_LIFECYCLE_END_FIELDS].sort());
  });

  test('lifecycle leg: a typed duration keeps the end stamps — readers prefer the explicit minutes', () => {
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_CHECKED_IN, CLOSEOUT_AT, { elapsed: 45 }),
      45,
      STALE_CHECKED_IN,
    );
    expect(updates.service_time_minutes).toBe(45);
    expect(updates.actual_end_time).toEqual(CLOSEOUT_AT);
    expect(updates.check_out_time).toEqual(CLOSEOUT_AT);
  });

  test('record leg: blank typed time + real check-in → start kept as history, EVERY end field absent', () => {
    const fields = buildRecordTiming(STALE_CHECKED_IN, undefined);
    // Historical truth stays on the report row…
    expect(fields.started_at).toBe(STALE_CHECKED_IN.actual_start_time);
    expect(fields.arrived_at).toBe(STALE_CHECKED_IN.arrived_at);
    // …and no end field completes the pair (completed_at included — the
    // report's completion-time resolver reads it first).
    for (const field of BACKFILL_RECORD_END_FIELDS) {
      expect(fields).not.toHaveProperty(field);
    }
  });

  test('record leg: the strip list mirrors exactly the end fields the record builder stamps', () => {
    const raw = buildServiceRecordCompletionTimingFields({
      scheduledService: STALE_CHECKED_IN,
      lifecycleUpdates: {},
      completedAt: CLOSEOUT_AT,
      serviceRecordCols: ALL_RECORD_COLS,
    });
    const endKeys = Object.keys(raw).filter((key) => raw[key] === CLOSEOUT_AT);
    expect([...endKeys].sort()).toEqual([...BACKFILL_RECORD_END_FIELDS].sort());
  });

  test('end to end: the codex-named reader now reports UNKNOWN for the stale checked-in row', () => {
    const fields = buildRecordTiming(STALE_CHECKED_IN, undefined);
    expect(computeOnSiteMin({ ...fields, timeOnSite: null })).toBeNull();
  });

  test('record leg: a typed duration keeps the record end stamps and the explicit metric wins', () => {
    const fields = buildRecordTiming(STALE_CHECKED_IN, 45);
    expect(fields.ended_at).toEqual(CLOSEOUT_AT);
    expect(fields.completed_at).toEqual(CLOSEOUT_AT);
    expect(computeOnSiteMin({ ...fields, timeOnSite: 45 })).toBe(45);
  });

  test('record leg: a never-started row keeps the end stamps — no start anywhere, no pair to poison', () => {
    const fields = buildRecordTiming({ status: 'pending' }, undefined);
    expect(fields.started_at).toBeNull();
    expect(fields.ended_at).toEqual(CLOSEOUT_AT);
    expect(computeOnSiteMin({ ...fields, timeOnSite: null })).toBeNull();
  });

  test('non-backfill completions are untouched — the record policy only ever runs under isBackfillCompletion', () => {
    // The route wires the record policy behind the backfill flag (source
    // contract below); the function itself is also a no-op passthrough for
    // typed/startless shapes, so nothing here can leak into live closeouts.
    const fields = buildServiceRecordCompletionTimingFields({
      scheduledService: STALE_CHECKED_IN,
      lifecycleUpdates: {},
      completedAt: CLOSEOUT_AT,
      serviceRecordCols: ALL_RECORD_COLS,
    });
    const untouched = { ...fields };
    expect(applyBackfillRecordTimingPolicy(fields, 45, STALE_CHECKED_IN)).toEqual(untouched);
    expect(applyBackfillRecordTimingPolicy({ ...untouched }, undefined, { status: 'pending' })).toEqual(untouched);
  });
});

describe('shouldCaptureApplicationConditions — no current-day weather on backdated records (Codex P1, PR #2897 fix round)', () => {
  // The capture is CURRENT FAWN/Open-Meteo at closeout time and lands on
  // service_records.conditions, which compliance.js copies verbatim into the
  // FDACS application ledger (weather_conditions / wind_speed_mph). A
  // backfilled record is dated to the scheduled day, so today's sky must
  // never be recorded as that day's application conditions.
  const productLedgerShape = {
    hasConditionsColumn: true,
    useServiceReportV1: false,
    isIncompleteVisit: false,
    productCount: 3,
  };
  const v1ReportShape = {
    hasConditionsColumn: true,
    useServiceReportV1: true,
    isIncompleteVisit: false,
    productCount: 0,
  };

  test('backfill + products logged → NO capture (the FDACS-ledger trigger is the dangerous one)', () => {
    expect(shouldCaptureApplicationConditions({ ...productLedgerShape, isBackfillCompletion: true })).toBe(false);
  });

  test('backfill + V1 report completion → NO capture (report-render trigger gated too)', () => {
    expect(shouldCaptureApplicationConditions({ ...v1ReportShape, isBackfillCompletion: true })).toBe(false);
    // Even an incomplete-with-products backfill stays dark.
    expect(shouldCaptureApplicationConditions({
      ...productLedgerShape, isIncompleteVisit: true, isBackfillCompletion: true,
    })).toBe(false);
  });

  test('live completions are unchanged — both capture triggers still fire without the flag', () => {
    expect(shouldCaptureApplicationConditions(productLedgerShape)).toBe(true);
    expect(shouldCaptureApplicationConditions(v1ReportShape)).toBe(true);
    expect(shouldCaptureApplicationConditions({ ...productLedgerShape, isBackfillCompletion: false })).toBe(true);
    // The pre-change caller shape (no flag at all) keeps the identical truth
    // table — the default is inert.
    expect(shouldCaptureApplicationConditions({ ...v1ReportShape, isIncompleteVisit: true, productCount: 0 })).toBe(false);
  });

  test('a missing conditions column short-circuits everything, backfill or not', () => {
    expect(shouldCaptureApplicationConditions({ ...productLedgerShape, hasConditionsColumn: false })).toBe(false);
    expect(shouldCaptureApplicationConditions({
      ...productLedgerShape, hasConditionsColumn: false, isBackfillCompletion: true,
    })).toBe(false);
  });
});

describe('hashCompletionRequest — flagless backfill resumes reach the re-derivation (Codex P2, PR #2897 fix round)', () => {
  // The crash-resume contract: after the service record commits, a retry may
  // arrive WITHOUT `backfill` (fresh panel mount). claimCompletionAttempt
  // compares request hashes before the route's structured_notes
  // re-derivation can heal the flag — so the flag must not be part of the
  // hash, or the committed quiet completion strands on
  // completion_resume_payload_mismatch with its invoice/side effects never
  // run.
  const committedBody = {
    idempotencyKey: 'key-1',
    notes: 'Quarterly service completed',
    visitOutcome: 'routine',
    backfill: true,
    timeOnSite: 45,
  };

  test('the flag never splits the hash — a flagless retry hashes identically to the original', () => {
    const original = hashCompletionRequest(committedBody);
    const flaglessRetry = { ...committedBody };
    delete flaglessRetry.backfill;
    expect(hashCompletionRequest(flaglessRetry)).toBe(original);
    // …and an explicit false is equally irrelevant (mode truth lives in the
    // frozen structured_notes, either direction).
    expect(hashCompletionRequest({ ...committedBody, backfill: false })).toBe(original);
  });

  test('real payload changes still mismatch — the strip is surgical', () => {
    expect(hashCompletionRequest({ ...committedBody, notes: 'different work entirely' }))
      .not.toBe(hashCompletionRequest(committedBody));
    expect(hashCompletionRequest({ ...committedBody, visitOutcome: 'customer_concern' }))
      .not.toBe(hashCompletionRequest(committedBody));
  });

  test('the volatile-field strip list stays exact: idempotencyKey, timeOnSite, telemetry, backfill', () => {
    const attemptsSource = fs.readFileSync(path.join(__dirname, '../services/completion-attempts.js'), 'utf8');
    expect(attemptsSource).toMatch(/const \{ idempotencyKey, timeOnSite, completionTelemetry, backfill, \.\.\.stableBody \} = body \|\| \{\};/);
  });
});

describe('backfillTimeOnSiteMinutes — the shared workday-cap sanitizer (Codex P1, PR #2897)', () => {
  // One function feeds BOTH the persisted duration (applyBackfillDurationPolicy)
  // and the job-costing explicitLaborMinutes forward — so "rejected" here IS
  // "no explicit labor minutes forwarded" (calcLaborCost treats null as no
  // data and, with untrustedLifecycleSpan, books zero labor rather than the
  // stale span).
  test('a plausible visit duration passes through, in every completion-body shape', () => {
    expect(backfillTimeOnSiteMinutes(45)).toBe(45);
    expect(backfillTimeOnSiteMinutes('45')).toBe(45);
    expect(backfillTimeOnSiteMinutes('0:45:00')).toBe(45);
    expect(backfillTimeOnSiteMinutes('90 min')).toBe(90);
    expect(backfillTimeOnSiteMinutes(720)).toBe(720);
  });

  test('an auto-elapsed-sized value (2 weeks) or anything past a workday → null, never forwarded', () => {
    expect(backfillTimeOnSiteMinutes(20160)).toBeNull();
    expect(backfillTimeOnSiteMinutes('336:00:00')).toBeNull();
    expect(backfillTimeOnSiteMinutes(721)).toBeNull();
  });

  test('absent/zero/garbage → null', () => {
    for (const junk of [null, undefined, '', '  ', 0, -5, 'abc']) {
      expect(backfillTimeOnSiteMinutes(junk)).toBeNull();
    }
  });
});

describe('shouldAutoInvoiceCompletion — backfill review-invoice override (Codex P1)', () => {
  // The reported shape: a priced backfill visit whose operator recorded an
  // out-of-band prepaid_amount (cash/Zelle) fully covering the bill. The
  // route derives the composite prepaidCovered=true via the OUT-OF-BAND leg
  // (annualPrepayCovered=false) — which used to return false here and mint
  // no invoice at all, leaving the recorded prepayment with nothing to
  // reconcile against. The minted invoice lands OPEN ('draft' from
  // InvoiceService.create) with the prepayment UNAPPLIED — both pinned by
  // the prepaid-credit-skip source contract below.
  const prepaidBackfill = {
    recapReviewOnly: false,
    alreadyPaid: false,
    prepaidCovered: true,
    autopayCoversVisit: false,
    preMintedInvoice: null,
    existingCompletionInvoice: null,
    createInvoiceOnComplete: true,
    waveguardTier: null,
    hasVisitPrice: true,
    invoiceAmount: 129,
    autoInvoicePricedVisits: false,
    serviceType: 'Quarterly Pest Control Service',
    isCallback: false,
    visitPerformed: true,
    isBackfillCompletion: true,
    annualPrepayCovered: false,
  };

  test('backfill: a fully-covering out-of-band prepaid_amount no longer suppresses — the open review invoice mints', () => {
    expect(shouldAutoInvoiceCompletion(prepaidBackfill)).toBe(true);
  });

  test('non-backfill control: the same fully prepaid visit still mints NO invoice (live behavior unchanged)', () => {
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, isBackfillCompletion: false })).toBe(false);
    // …and a caller that never passes the new inputs (the pre-change shape)
    // gets the identical suppression — defaults are inert.
    const legacyShape = { ...prepaidBackfill };
    delete legacyShape.isBackfillCompletion;
    delete legacyShape.annualPrepayCovered;
    expect(shouldAutoInvoiceCompletion(legacyShape)).toBe(false);
  });

  test('annual-prepay coverage is EXCLUDED from the override — settled plan money never re-bills', () => {
    // annualPrepayCoversVisit feeds the same composite prepaidCovered flag,
    // but that money is genuinely settled on the annual prepay invoice (its
    // own paper trail via settleInvoiceAsAnnualPrepayCovered) — a fresh
    // collectible invoice would double-bill covered plan work.
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, annualPrepayCovered: true })).toBe(false);
  });

  test('autopay dues coverage is untouched by the override', () => {
    expect(shouldAutoInvoiceCompletion({
      ...prepaidBackfill, prepaidCovered: false, autopayCoversVisit: true,
    })).toBe(false);
  });

  test('every other suppressor still holds under backfill — already-billed work never double-mints', () => {
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, alreadyPaid: true })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, preMintedInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, existingCompletionInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, recapReviewOnly: true })).toBe(false);
  });

  test('the override removes only the prepaid suppression — an otherwise-unbillable visit still mints nothing', () => {
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, invoiceAmount: 0 })).toBe(false);
  });
});

describe('shouldAutoInvoiceCompletion — typed one-time backfill mints the review invoice (Codex P1, PR #2897)', () => {
  // The reported shape: a stale typed one-time visit (profile billingType
  // 'one_time') with no invoice anywhere. Live, the pre-transaction billing
  // gate 409s (completion_billing_required) and the client detours into
  // checkout — a payment interaction the quiet backdated closeout forbids,
  // so the visit could not take the quiet path AT ALL. Under backfill the
  // gate is bypassed and the draft review invoice must mint here instead.
  // No scheduler flag, no membership tier, no explicit customer lane,
  // priced-visits gate off — the exact population that previously fell
  // through every branch and completed uninvoiced.
  const typedOneTimeBackfill = {
    recapReviewOnly: false,
    alreadyPaid: false,
    prepaidCovered: false,
    autopayCoversVisit: false,
    preMintedInvoice: null,
    existingCompletionInvoice: null,
    createInvoiceOnComplete: false,
    waveguardTier: null,
    hasVisitPrice: true,
    invoiceAmount: 350, // = the row's own estimated_price (completionInvoiceAmount precedence)
    autoInvoicePricedVisits: false,
    serviceType: 'Bed Bug Treatment',
    isCallback: false,
    visitPerformed: true,
    typedOneTimeBilling: true,
    isBackfillCompletion: true,
    annualPrepayCovered: false,
  };

  test('backfill + typed one-time + row price → the draft review invoice mints at the row amount', () => {
    expect(shouldAutoInvoiceCompletion(typedOneTimeBackfill)).toBe(true);
  });

  test('live behavior unchanged: the same visit outside backfill still declines here — the pre-gate owns it', () => {
    expect(shouldAutoInvoiceCompletion({ ...typedOneTimeBackfill, isBackfillCompletion: false })).toBe(false);
    // …and a caller that never passes the new input (the pre-change shape)
    // keeps the identical decline — the default is inert.
    const legacyShape = { ...typedOneTimeBackfill };
    delete legacyShape.typedOneTimeBilling;
    expect(shouldAutoInvoiceCompletion(legacyShape)).toBe(false);
  });

  test('amount basis is the row price — an unpriced typed one-time never bills the legacy monthly-rate fallback', () => {
    // Pre-gate parity: projectCompletionInvoiceAmount reads estimated_price
    // first and bills the monthly rate ONLY behind create_invoice_on_complete
    // (which returns true on its own branch above). An unpriced visit
    // resolves not_billable live; under backfill it must equally mint
    // nothing, even when the legacy fallback computed a positive amount.
    expect(shouldAutoInvoiceCompletion({
      ...typedOneTimeBackfill, hasVisitPrice: false, invoiceAmount: 89,
    })).toBe(false);
  });

  test('performed, non-callback, non-always-free work only — the quiet path never invents a bill', () => {
    expect(shouldAutoInvoiceCompletion({ ...typedOneTimeBackfill, visitPerformed: false })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...typedOneTimeBackfill, isCallback: true })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...typedOneTimeBackfill, serviceType: 'Bed Bug Follow-Up Visit' })).toBe(false);
  });

  test('suppressors still win — already-billed or settled work never double-mints', () => {
    expect(shouldAutoInvoiceCompletion({ ...typedOneTimeBackfill, existingCompletionInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...typedOneTimeBackfill, preMintedInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...typedOneTimeBackfill, alreadyPaid: true })).toBe(false);
    // Annual-prepay-covered plan work stays settled on its own paper trail.
    expect(shouldAutoInvoiceCompletion({
      ...typedOneTimeBackfill, prepaidCovered: true, annualPrepayCovered: true,
    })).toBe(false);
  });

  test('an out-of-band prepaid stamp still mints the open invoice (the backfill prepaid override composes)', () => {
    // Cash/Zelle recorded on the visit: the invoice mints anyway and the
    // gated prepaid rail leaves it open with the amount unapplied — the
    // reviewer reconciles, same as every other backfill invoice.
    expect(shouldAutoInvoiceCompletion({
      ...typedOneTimeBackfill, prepaidCovered: true, annualPrepayCovered: false,
    })).toBe(true);
  });
});

describe('completion route wiring (source contracts)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

  test('route feeds the requester role into the plan and honors the 403 status', () => {
    expect(source).toMatch(/backfillCompletionPlan\(\{ backfill, scheduledDate: svc\.scheduled_date, role: req\.techRole \}\)/);
    expect(source).toMatch(/res\.status\(backfillPlan\.status \|\| 400\)\.json\(backfillPlan\.error\)/);
  });

  test('completionServiceDate is backdated from the plan under backfill', () => {
    expect(source).toMatch(/const completionServiceDate = isBackfillCompletion\s*\n\s*\? backfillPlan\.serviceDate\s*\n\s*: etDateString\(completionEndedAt\)/);
  });

  test('backfill forces customer comms off, including AFTER the frozen-posture re-derivation', () => {
    const forced = source.match(/if \(isBackfillCompletion\) \{\s*\n\s*suppressTypedCustomerComms = true;\s*\n\s*effectiveSendCompletionSms = false;\s*\n\s*\}/g) || [];
    // Once at the initial delivery-posture derivation, once after the
    // resume-path re-derivation (which could otherwise un-suppress).
    expect(forced.length).toBe(2);
  });

  test('backfill freezes review-request OFF and its own flag in structured_notes', () => {
    expect(source).toMatch(/requestReview: \(isIncompleteVisit \|\| isInternalOnlyCompletion \|\| isBackfillCompletion\) \? false : requestReview !== false/);
    expect(source).toMatch(/\.\.\.\(isBackfillCompletion \? \{ backfill: true \} : \{\}\)/);
    // And the resume path recovers the frozen flag.
    expect(source).toMatch(/parseJsonObject\(record\.structured_notes\)\?\.backfill === true/);
  });

  test('backfill invoices stay due near-term instead of minting instantly overdue', () => {
    expect(source).toMatch(/dueDate: isBackfillCompletion \? etDateString\(\) : serviceDateOnly\(record\.service_date\)/);
  });

  test('backfill suppresses the decline notice and the payer AP send', () => {
    expect(source).toMatch(/&& !invoice\.payer_id\s*\n\s*\/\/ Backfill closeouts are quiet end-to-end[\s\S]{0,200}&& !isBackfillCompletion\)/);
    expect(source).toMatch(/invoice\.payer_id && !payerInvoiceAlreadyDelivered && !isBackfillCompletion/);
  });

  test('backfill + saved payment method never auto-charges (per-application rail gated off)', () => {
    // The per-application saved-card/ACH rail — and with it the receipt
    // enqueue and combined-receipt arming that only happen inside it — runs
    // exclusively for non-backfill completions. Invoice minting is untouched
    // (shouldInvoice runs earlier), so a backfill invoice still mints, open
    // and uncharged, for operator collection.
    expect(source).toMatch(/if \(!isBackfillCompletion\n\s*&& perApplicationBilling && visitPerformed && invoice\?\.id && !alreadyPaid && !invoice\.payer_id/);
    // autoChargedReceiptPending starts false and is only ever set inside the
    // gated rail — no charge, no combined receipt claim.
    expect(source).toMatch(/let autoChargedReceiptPending = false;/);
  });

  test('backfill mints the digital card quietly — card.issued email suppressed', () => {
    // The mint call passes the quiet flag straight off the completion's
    // backfill state…
    expect(source).toMatch(/ensureCardForCompletion\(\{\s*\n\s*customerId: svc\.customer_id,\s*\n\s*serviceRecordId: record\.id,\s*\n\s*scheduledServiceId: svc\.id,\s*\n\s*suppressIssuedEmail: isBackfillCompletion,/);
    // …and the service honors it: the email leg is gated, everything before
    // it (card row / promoter enroll / short link) still runs.
    const cardSource = fs.readFileSync(path.join(__dirname, '../services/customer-card.js'), 'utf8');
    expect(cardSource).toMatch(/async function ensureCardForCompletion\(\{ customerId, serviceRecordId = null, scheduledServiceId = null, suppressIssuedEmail = false \}\)/);
    expect(cardSource).toMatch(/if \(!suppressIssuedEmail\) \{\s*\n\s*await maybeSendCardEmail\(card, customer\);\s*\n\s*\}/);
  });

  test('backfill never auto-applies account credit — invoice stays open for operator review', () => {
    // The auto-apply block is gated on !isBackfillCompletion BEFORE the
    // applyAccountCreditToInvoice call, so a backfilled invoice can neither
    // consume existing credit nor flip itself prepaid.
    expect(source).toMatch(/if \(!isBackfillCompletion\s*\n\s*&& invoice\?\.id && !alreadyPaid && !invoice\.payer_id\s*\n\s*&& !\['paid', 'prepaid'\][\s\S]{0,200}autoApplyAccountCredit\) \{[\s\S]{0,400}applyAccountCreditToInvoice\(\{ invoiceId: invoice\.id \}\)/);
  });

  test('backfill never auto-applies the prepaid credit — invoice mutation stays with the reviewer', () => {
    // applyPrepaidCreditToInvoice reduces the invoice total, inserts a
    // payments row, and can flip the invoice paid. Recording money the
    // operator already collected is still invoice mutation on the quiet
    // path, so the rail is gated INSIDE the helper — covering BOTH call
    // sites (fresh completion invoice and pre-minted Tap-to-Pay invoice) —
    // with a log line pointing review at the prepaid_amount on file.
    const helper = source.match(/const applyPrepaidCreditToInvoice = async \(invoiceRow\) => \{([\s\S]*?)\n {4}\};/);
    expect(helper).not.toBeNull();
    const gateAt = helper[1].indexOf('if (isBackfillCompletion) {');
    expect(gateAt).toBeGreaterThan(-1);
    // The gate returns the invoice untouched BEFORE the crediting transaction.
    expect(helper[1].indexOf('db.transaction')).toBeGreaterThan(gateAt);
    expect(helper[1]).toContain('prepaid credit NOT auto-applied');
    expect(helper[1]).toContain('prepaid_amount');
    // Both call sites still route through the gated helper.
    expect(source).toMatch(/invoice = await applyPrepaidCreditToInvoice\(invoice\);/);
    expect(source).toMatch(/preMintedInvoice = await applyPrepaidCreditToInvoice\(preMintedInvoice\);/);
  });

  test('fully prepaid backfill still mints the open review invoice — override wired into the invoice decision', () => {
    // The route feeds the backfill flag AND the annual-prepay leg into
    // shouldAutoInvoiceCompletion (behavioral coverage above): out-of-band
    // prepaid coverage stops suppressing, annual-prepay coverage keeps
    // suppressing.
    expect(source).toMatch(/const shouldInvoice = shouldAutoInvoiceCompletion\(\{[\s\S]*?visitPerformed,[\s\S]*?isBackfillCompletion,\s*\n\s*annualPrepayCovered,\s*\n\s*\}\);/);
    // And the structured_notes resume re-derivation sits BEFORE the invoice
    // decision, so a crash-resumed retry (body flag absent) reaches the same
    // override instead of silently re-suppressing the invoice.
    const rederivation = source.indexOf("parseJsonObject(record.structured_notes)?.backfill === true");
    const invoiceDecision = source.indexOf('const shouldInvoice = shouldAutoInvoiceCompletion({');
    expect(rederivation).toBeGreaterThan(-1);
    expect(invoiceDecision).toBeGreaterThan(rederivation);
    // The minted invoice is OPEN by construction ('draft' from
    // InvoiceService.create; near-term due date pinned above) and the
    // prepayment stays UNAPPLIED via the gated prepaid rail (contract
    // above) — reconciliation is the reviewer's explicit step.
  });

  test('backfill durations AND start timestamps come from the policy, not the stale lifecycle inference', () => {
    // The route builds lifecycle updates from the shared helper, then under
    // backfill immediately re-derives them through the policy — sanitized
    // timeOnSite or unknown for the duration, and the pre-update row (svc)
    // so inferred start fields are stripped while row-backed ones survive
    // (behavioral coverage above).
    expect(source).toMatch(/const lifecycleUpdates = buildCompletionLifecycleUpdates\(svc, completionEndedAt, \{ elapsed: effectiveTimeOnSite \}\);[\s\S]{0,600}if \(isBackfillCompletion\) applyBackfillDurationPolicy\(lifecycleUpdates, effectiveTimeOnSite, svc\);/);
  });

  test('typed one-time billing pre-gate: backfill bypasses the checkout detour, live keeps it', () => {
    // The gated population is hoisted to a named flag…
    expect(source).toMatch(/const typedOneTimeBillingProfile = !!typedFindingsType\s*\n\s*&& !isIncompleteVisit\s*\n\s*&& !recapReviewOnly\s*\n\s*&& String\(completionProfile\?\.billingType \|\| ''\)\.toLowerCase\(\) === 'one_time'\s*\n\s*&& svc\.followup_included !== true;/);
    // …and the pre-gate itself now excludes backfill completions, so the
    // 409 → checkout detour can no longer strand a stale typed one-time
    // visit outside the quiet path.
    expect(source).toMatch(/claim\.action === 'proceed'\s*\n\s*&& typedOneTimeBillingProfile\s*\n\s*&& !isBackfillCompletion\s*\n\s*\) \{/);
    // The detour is still live for non-backfill typed one-time completions.
    expect(source).toContain("code: 'completion_billing_required',");
    // Ordering: the backfill plan (and its admin-only 403) is derived at
    // intake, BEFORE the pre-gate reads isBackfillCompletion — a
    // non-admin/invalid backfill flag fails there and never reaches the
    // bypass.
    const planAt = source.indexOf('const backfillPlan = backfillCompletionPlan({ backfill, scheduledDate: svc.scheduled_date, role: req.techRole });');
    const gate409At = source.indexOf("code: 'completion_billing_required',");
    expect(planAt).toBeGreaterThan(-1);
    expect(gate409At).toBeGreaterThan(planAt);
    // And the bypassed population is fed into the in-transaction invoice
    // decision, where the backfill branch mints the draft review invoice
    // (behavioral coverage above).
    expect(source).toMatch(/typedOneTimeBilling: typedOneTimeBillingProfile,\s*\n(\s*\/\/[^\n]*\n)*\s*isBackfillCompletion,\s*\n\s*annualPrepayCovered,\s*\n\s*\}\);/);
  });

  test('timeOnSite is sanitized ONCE at intake — every consumer reads the same value or absence', () => {
    // Under backfill the raw body value is replaced by the workday-capped
    // minutes (or null); non-backfill completions pass through untouched.
    expect(source).toMatch(/const effectiveTimeOnSite = isBackfillCompletion\s*\n\s*\? backfillTimeOnSiteMinutes\(timeOnSite\)\s*\n\s*: timeOnSite;/);
    // A rejected value logs a note — the closeout still succeeds (no 400
    // path exists between the sanitation and the log).
    expect(source).toMatch(/if \(isBackfillCompletion && effectiveTimeOnSite == null && timeOnSite != null && timeOnSite !== ''\) \{\s*\n\s*logger\.warn\([\s\S]{0,300}recorded as unknown/);
    // The structured_notes stamp — the report's on-site metric reads it via
    // computeOnSiteMin — carries the sanitized value, never the raw span.
    expect(source).toMatch(/timeOnSite: effectiveTimeOnSite \|\| null,/);
    // And no other consumer still reads the raw body value: `timeOnSite`
    // appears only in the destructure, the sanitation, and the helpers'
    // definitions/comments — never as a bare argument past the intake.
    const afterIntake = source.slice(source.indexOf('const effectiveTimeOnSite = isBackfillCompletion'));
    expect(afterIntake).not.toMatch(/\{ elapsed: timeOnSite \}/);
    expect(afterIntake).not.toMatch(/applyBackfillDurationPolicy\(lifecycleUpdates, timeOnSite\)/);
    expect(afterIntake).not.toMatch(/minutesFromElapsed\(timeOnSite\)/);
  });

  test('backfill job costing never derives labor from the stale span (or the clock-in window over it)', () => {
    // The completion route flags the span untrusted and forwards the
    // operator's explicit minutes through the SAME workday-cap sanitizer
    // the duration policy uses — an oversized value forwards null, so
    // persisted duration and costed labor can never disagree…
    expect(source).toMatch(/JobCosting\.calculateJobCost\(svc\.id, undefined, isBackfillCompletion\s*\n\s*\? \{ untrustedLifecycleSpan: true, explicitLaborMinutes: backfillTimeOnSiteMinutes\(effectiveTimeOnSite\) \}\s*\n\s*: \{\}\)/);
    // …and calcLaborCost honors it: the technician clock-in-window fallback
    // and the actual_start/end span fallback are both skipped for untrusted
    // bounds; only direct job entries or the explicit minutes may count.
    const costingSource = fs.readFileSync(path.join(__dirname, '../services/job-costing.js'), 'utf8');
    expect(costingSource).toMatch(/if \(!minutes && !untrustedLifecycleSpan && technicianId && startTime && endTime\) \{/);
    expect(costingSource).toMatch(/if \(!minutes && untrustedLifecycleSpan\) \{\s*\n\s*const explicit = Number\(explicitLaborMinutes\);\s*\n\s*if \(Number\.isFinite\(explicit\) && explicit > 0\) minutes = Math\.round\(explicit\);\s*\n\s*\}/);
    expect(costingSource).toMatch(/if \(!minutes && !untrustedLifecycleSpan && startTime && endTime\) \{/);
    // calculateJobCost threads the options through to calcLaborCost.
    expect(costingSource).toMatch(/\{ untrustedLifecycleSpan, explicitLaborMinutes \},\s*\n\s*\);/);
  });

  test('tracker completion honors the duration policy at BOTH markComplete call sites (fix round 3)', () => {
    // markComplete's own UPDATE rebuilds lifecycle fields from the fresh row
    // AFTER the transaction commits — today's actual_end_time/check_out_time
    // plus a stale-start→now service_time_minutes/actual_duration_minutes —
    // and the job-costing durable guard prefers that persisted column as
    // explicit labor. Both post-commit call sites — the terminal flip and
    // the artifact-refresh re-emit (which performs the real flip whenever
    // the first call failed) — must flag the span untrusted.
    const flaggedCalls = source.match(
      /trackTransitions\.markComplete\(svc\.id, \{\s*\n\s*actorType: 'admin',\s*\n\s*actorId: req\.technicianId,\s*\n(?:\s*\/\/[^\n]*\n)*\s*untrustedLifecycleSpan: isBackfillCompletion,\s*\n\s*\}\)/g,
    ) || [];
    expect(flaggedCalls.length).toBe(2);
    // Exactly these two sites exist on the backfill-capable route; the third
    // markComplete in this file belongs to PUT /:id/status, where backfill
    // is unreachable (contract below) and the default rebuild is correct.
    expect((source.match(/trackTransitions\.markComplete\(/g) || []).length).toBe(3);
    // The crash-resume re-derivation sits BEFORE the first flagged call, so
    // a flagless resumed retry that still owes the tracker flip reads the
    // healed flag, not the body's stale `false`.
    const rederivation = source.indexOf('parseJsonObject(record.structured_notes)?.backfill === true');
    const firstFlagged = source.indexOf('untrustedLifecycleSpan: isBackfillCompletion,');
    expect(rederivation).toBeGreaterThan(-1);
    expect(firstFlagged).toBeGreaterThan(rederivation);
    // And the tracker honors the flag: the lifecycle rebuild is skipped
    // wholesale under it (bookkeeping — track_state/completed_at/updated_at
    // — still lands; behavioral coverage in track-transitions.test.js).
    const trackerSource = fs.readFileSync(path.join(__dirname, '../services/track-transitions.js'), 'utf8');
    expect(trackerSource).toMatch(/\.\.\.\(opts\.untrustedLifecycleSpan \? \{\} : buildCompletionLifecycleUpdates\(svc, now\)\),/);
  });

  test('backfill + card hold parks for review instead of charging', () => {
    // The card-hold rail takes a dedicated backfill branch BEFORE the charge
    // path: bell the office about the live hold, leave it held, and never
    // call the charge helpers.
    const backfillHoldBranch = source.match(/\} else if \(isBackfillCompletion\) \{([\s\S]*?)\} else try \{/);
    expect(backfillHoldBranch).not.toBeNull();
    expect(backfillHoldBranch[1]).toContain('heldCardForScheduledService');
    expect(backfillHoldBranch[1]).not.toContain('chargeCardHoldOnCompletion');
    expect(backfillHoldBranch[1]).not.toContain('chargeInvoiceWithSavedCard');
    // The real charge call survives, unreachable for backfill completions.
    expect(source).toMatch(/\} else try \{\s*\n\s*const CardHolds = require\('\.\.\/services\/estimate-card-holds'\);\s*\n\s*const holdCharge = await CardHolds\.chargeCardHoldOnCompletion/);
  });

  test('backfill never credits a referral — no $25 to either party, no referrer SMS/email', () => {
    // creditReferralOnFirstService posts real account credits to BOTH the
    // referrer and the referee AND messages the referrer, so the quiet path
    // must not reach it. The guard also protects the reward's single-use
    // idempotency: firing here would burn it on a visit nobody announced.
    expect(source).toMatch(/const referralVisitPerformed = closedDealVisitPerformed && !isBackfillCompletion;/);
    const referralBlock = source.match(/if \(referralVisitPerformed\) \{([\s\S]*?)\n {4}\}/);
    expect(referralBlock).not.toBeNull();
    expect(referralBlock[1]).toContain('creditReferralOnFirstService');
  });

  test('backfill never opens the mobile in-person payment sheet', () => {
    // invoicePaymentActionRequired drives DispatchPageV2's in-person payment
    // handoff. A backfilled closeout leaves its invoice for office review by
    // contract, so the flag must be forced false before any other condition
    // can turn it on.
    expect(source).toMatch(/const invoicePaymentActionRequired = !!invoice\s*\n(\s*\/\/[^\n]*\n)*\s*&& !isBackfillCompletion/);
  });

  test('lead conversion still runs on a backfill — pure data write, and there is no later completion', () => {
    // convertLeadFromEvent only resolves the originating lead and calls
    // leadAttribution.markConverted — no SMS/email/money anywhere in that
    // path — so it is NOT part of the quiet-path contract. It must stay OUT
    // of the referral guard: a stale-sweep closeout is the last completion
    // these rows ever get, so gating it would strand the lead open forever.
    expect(source).toMatch(/if \(closedDealVisitPerformed\) \{[\s\S]{0,600}convertLeadFromEvent\(\{ source: 'service_completed'/);
    // And the shared predicate itself carries no backfill term.
    expect(source).toMatch(/const closedDealVisitPerformed = visitOutcome !== 'inspection_only'\s*\n\s*&& visitOutcome !== 'customer_declined'\s*\n\s*&& !isIncompleteVisit;/);
    // Belt-and-braces: the referral engine is never reached from that block.
    const leadBlock = source.match(/if \(closedDealVisitPerformed\) \{([\s\S]*?)\n {4}\}/);
    expect(leadBlock[1]).not.toContain('creditReferralOnFirstService');
  });

  test('every post-commit backfill gate sits AFTER the crash-resume re-derivation', () => {
    // isBackfillCompletion is re-derived from the FROZEN structured_notes so a
    // crash-resumed retry (which may arrive without the body flag) stays
    // quiet. Any post-commit gate placed above that line would read a stale
    // `false` on resume and leak. Pin the ordering, not just the presence.
    const rederivation = source.indexOf("parseJsonObject(record.structured_notes)?.backfill === true");
    expect(rederivation).toBeGreaterThan(-1);
    const postCommitGates = [
      // account-credit auto-apply
      'if (!isBackfillCompletion\n      && invoice?.id && !alreadyPaid && !invoice.payer_id',
      // per-application saved-card / ACH auto-charge
      'if (!isBackfillCompletion\n      && perApplicationBilling && visitPerformed',
      // card-hold charge
      '} else if (isBackfillCompletion) {',
      // digital-business-card issued email
      'suppressIssuedEmail: isBackfillCompletion,',
      // payment-decline notice SMS
      '&& !isBackfillCompletion) {',
      // payer AP invoice email
      'invoice.payer_id && !payerInvoiceAlreadyDelivered && !isBackfillCompletion',
      // referral credit
      'const referralVisitPerformed = closedDealVisitPerformed && !isBackfillCompletion;',
      // prepaid-credit application (gate lives inside the helper, defined
      // and called after the re-derivation)
      'prepaid credit NOT auto-applied',
      // estimate-deposit roll-forward skip + reviewer breadcrumb (fix round 2)
      'skipDepositCredit: isBackfillCompletion,',
      'estimate deposit NOT auto-applied',
      // job-costing labor guard
      'untrustedLifecycleSpan: true',
    ];
    for (const gate of postCommitGates) {
      const at = source.indexOf(gate);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(rederivation);
    }
  });

  test('backfill is reachable ONLY through POST /complete — the other completion entry points ignore it', () => {
    // Backfill is a body flag on POST /:serviceId/complete. PUT
    // /:serviceId/status and admin-schedule's bare completed flip each run
    // their own (ungated) referral/review rails, so the sweep must never be
    // able to route through them. Neither destructures `backfill`.
    const statusRoute = source.slice(
      source.indexOf("router.put('/:serviceId/status'"),
      source.indexOf("router.get('/:serviceId/complete-preview'"),
    );
    expect(statusRoute.length).toBeGreaterThan(0);
    expect(statusRoute).not.toContain('backfill');

    const scheduleSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(scheduleSource).not.toMatch(/backfill\s*=\s*false|backfill\s*,/);
  });

  test('the record-timing policy is wired between the builder and the insert, backfill-gated (fix round 2)', () => {
    // The service_records timing fields are built into a variable, run
    // through applyBackfillRecordTimingPolicy under isBackfillCompletion
    // (same sanitized timeOnSite + pre-update row as the lifecycle leg),
    // and only then assigned onto the insert payload.
    expect(source).toMatch(/const recordTimingFields = buildServiceRecordCompletionTimingFields\(\{\s*\n\s*scheduledService: svc,\s*\n\s*lifecycleUpdates,\s*\n\s*completedAt: completionEndedAt,\s*\n\s*serviceRecordCols,\s*\n\s*\}\);[\s\S]{0,500}if \(isBackfillCompletion\) applyBackfillRecordTimingPolicy\(recordTimingFields, effectiveTimeOnSite, svc\);\s*\n\s*Object\.assign\(recordInsert, recordTimingFields\);/);
  });

  test('the conditions capture is backfill-gated at the single fetch site (fix round 2)', () => {
    // shouldCaptureApplicationConditions is the one authority deciding the
    // FAWN/Open-Meteo fetch, and the route feeds it the backfill flag; the
    // fetched object is only ever written via recordInsert.conditions, so
    // gating the capture gates the record AND the FDACS ledger copy
    // (compliance.js reads sr.conditions).
    expect(source).toMatch(/conditionsAtApplication = shouldCaptureApplicationConditions\(\{[\s\S]{0,700}isBackfillCompletion,\s*\n\s*\}\)/);
    expect(source).toMatch(/if \(serviceRecordCols\.conditions && conditionsAtApplication\) recordInsert\.conditions = serializeJsonb\(conditionsAtApplication\);/);
    // Exactly one fetch site in the completion path.
    expect(source.match(/fetchApplicationConditions\(/g) || []).toHaveLength(1);
  });

  test('the backfill mint opts out of the deposit roll-forward and leaves the reviewer a breadcrumb (fix round 2)', () => {
    // The route passes the opt-out on the completion mint…
    expect(source).toMatch(/invoice = await InvoiceService\.createFromService\(record\.id, \{[\s\S]{0,1200}skipDepositCredit: isBackfillCompletion,\s*\n\s*\}\);/);
    // …and logs the unapplied balance for review, like the prepaid skip.
    expect(source).toMatch(/if \(isBackfillCompletion && svc\.source_estimate_id\) \{[\s\S]{0,600}estimate deposit NOT auto-applied[\s\S]{0,300}left open for review/);
    // The service honors the opt-out BEFORE any ledger read: the
    // source-estimate lookup (and with it pendingDepositCredit /
    // consumeDepositCredit and the reconcile alert) is gated off.
    const invoiceSource = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
    expect(invoiceSource).toMatch(/skipDepositCredit = false,/);
    expect(invoiceSource).toMatch(/if \(!skipDepositCredit && sr\.scheduled_service_id\) \{/);
    // Behavioral coverage lives in invoice-deposit-credit-tax.test.js
    // (ledger untouched, full-value invoice, no reconcile alert).
  });
});
