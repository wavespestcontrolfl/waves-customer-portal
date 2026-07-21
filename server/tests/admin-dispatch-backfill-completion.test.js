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
 * first of them. Fix round 5 (Codex P1 + P2 ×2): the resume re-derivation
 * freezes the mode in BOTH directions AND the typed duration (the retry
 * body — hash-excluded on `backfill`/`timeOnSite` — has no vote; a flagged
 * retry of a committed normal completion stays LOUD, and a committed
 * backfill's duration never comes from the retry's auto-elapsed timer), via
 * the exported frozenResumeCompletionState; and the backfill mint opts out
 * of payer-statement accrual (skipAccrual) so a NET-terms review invoice
 * never lands on the payer's open consolidated statement before review.
 * Fix round 7 (Codex P0): the typed one-time backfill's REQUIRED mint is
 * fail-closed — the shared backfillTypedOneTimeMintRequired predicate
 * decides both the mint and the enforcement, a required-mint failure
 * releases the attempt to the immediately-resumable side_effects_pending
 * state (never finalized succeeded) with an actionable 503, the resume
 * claim re-attempts the mint from frozen/hash-pinned/row inputs, and every
 * non-required mint failure keeps the non-blocking behavior exactly.
 * Fix round 8 (Codex P0 + P1): the required-mint POSTURE is frozen into
 * structured_notes inside the completion transaction (the billing profile
 * is mutable DB state the request hash cannot pin — a live recomputation
 * on resume could flip false after a profile edit/removal and finalize the
 * closeout uninvoiced), resume reads it back via frozenResumeCompletionState
 * and shouldAutoInvoiceCompletion honors it in BOTH directions; and the
 * route checks releaseCompletionAttemptForResume's outcome — a no-op
 * release answers with the real stale-window retry horizon instead of
 * promising an immediate retry the claim would 409.
 * Fix round 9 (Codex P1 ×2): the REQUIRED-mint posture broadens from the
 * typed one-time population to EVERY backfill shape the mint decision
 * bills (backfillExpectedMintAtCommit delegates to
 * shouldAutoInvoiceCompletion itself, so frozen-required ≡ will-mint at
 * commit by construction, and the frozen posture governs every branch in
 * both directions on resume); and the unknown-duration backfill shape now
 * stamps completed_at = ET noon of the service day (Billing Recovery's
 * leak window keys on ss.completed_at — a NULL hid the exact uninvoiced
 * backfills the workbench exists to catch), with the sub-day pair readers
 * guarding on the durable structured_notes.backfill marker instead.
 */
const fs = require('fs');
const path = require('path');
const {
  backfillCompletionPlan,
  applyBackfillDurationPolicy,
  applyBackfillRecordTimingPolicy,
  backfillCompletionEndInstant,
  backfillTimeOnSiteMinutes,
  frozenResumeCompletionState,
  BACKFILL_MAX_TIME_ON_SITE_MINUTES,
  BACKFILL_INFERRED_START_FIELDS,
  BACKFILL_LIFECYCLE_END_FIELDS,
  BACKFILL_RECORD_END_FIELDS,
  shouldAutoInvoiceCompletion,
  backfillTypedOneTimeMintRequired,
  backfillExpectedMintAtCommit,
  shouldCaptureApplicationConditions,
} = require('../routes/admin-dispatch')._test;
const { buildCompletionLifecycleUpdates } = require('../utils/service-duration-capture');
const { etDateString } = require('../utils/datetime-et');
const { buildServiceRecordCompletionTimingFields } = require('../services/service-report/service-record-timing');
const { computeOnSiteMin } = require('../services/service-report/metrics-band');
const {
  hashCompletionRequest,
  requestHashMatches,
  resumeHashMatches,
  coreHashSegment,
  claimCompletionAttempt,
  releaseCompletionAttemptForResume,
} = require('../services/completion-attempts');

// Fix round 6 (Codex P2): the recap-delivery refusal tests drive the real
// sendRecap against a knex mock — the SMS provider module is mocked so an
// approved recap in the control case "sends" without touching messaging.
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendRecap } = require('../services/service-report/recap-delivery');

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

describe('backfillCompletionEndInstant — kept end stamps carry the backdated service day (Codex P2 ×3, fix round 4)', () => {
  // The reported hazards on head 213e3d64c: (1) an empty scheduled_services
  // UPDATE crashed the blank-duration checked-in closeout; (2) markComplete's
  // wall-clock completed_at fed backfilled visits into pricing-reality-check's
  // CURRENT window with fabricated arrived_at→completed_at spans; (3) the end
  // stamps the policies KEEP (typed-duration rows; startless rows) started
  // termite-bond terms on the closeout date (lifecycle-email-sweeps prefers
  // actual_end_time/check_out_time/completed_at over scheduled_date). One
  // rule resolves all three: every kept backfill end instant = the visit's
  // backdated service day.
  const SERVICE_DATE = '2026-07-01';
  const REAL_START = '2026-07-01T13:07:00Z'; // 09:07 ET on the service day
  const CHECKED_IN = {
    status: 'on_site',
    actual_start_time: REAL_START,
    check_in_time: REAL_START,
  };
  const NEVER_STARTED = { status: 'pending' };
  const CLOSEOUT_AT = new Date('2026-07-19T16:00:00Z'); // weeks later

  test('real row-backed start + typed duration → start + duration (the pair IS the operator statement)', () => {
    const instant = backfillCompletionEndInstant(SERVICE_DATE, 45, CHECKED_IN);
    expect(instant).toEqual(new Date(new Date(REAL_START).getTime() + 45 * 60000));
    expect(etDateString(instant)).toBe(SERVICE_DATE);
  });

  test('real row-backed start + blank duration → ET noon of the service day (recovery-visible; the pair readers guard on the marker) — fix round 9', () => {
    // Round 7 returned NULL here so no instant could complete a fabricated
    // pair against the kept stale start — but a NULL completed_at also hid
    // a priced-but-uninvoiced backfill from Billing Recovery's
    // `ss.completed_at >= now() - window` leak query. The instant is now
    // the same honest day-scale noon the no-start shape always stamped;
    // the sub-day pair readers (pricing-reality-check, estimate-actuals,
    // the report visit-timeline) skip marked rows instead. The lifecycle/
    // record END-FIELD strips for this shape are unchanged — only the
    // tracker's completed_at carries the instant.
    for (const blank of [undefined, null]) {
      const instant = backfillCompletionEndInstant(SERVICE_DATE, blank, CHECKED_IN);
      expect(etDateString(instant)).toBe(SERVICE_DATE);
      expect(instant.toISOString()).toBe('2026-07-01T16:00:00.000Z'); // noon EDT
    }
    // An over-cap "typed" value degrades to absent — same sanitizer as the
    // duration policy, so instant and persisted minutes can never disagree.
    const overCap = backfillCompletionEndInstant(SERVICE_DATE, BACKFILL_MAX_TIME_ON_SITE_MINUTES + 1, CHECKED_IN);
    expect(overCap.toISOString()).toBe('2026-07-01T16:00:00.000Z');
  });

  test('no start anywhere → ET noon of the service day, typed or blank', () => {
    for (const typed of [45, undefined]) {
      const instant = backfillCompletionEndInstant(SERVICE_DATE, typed, NEVER_STARTED);
      expect(etDateString(instant)).toBe(SERVICE_DATE);
      expect(instant.toISOString()).toBe('2026-07-01T16:00:00.000Z'); // noon EDT
    }
  });

  test('EVERY backfill shape now yields an instant — Billing Recovery visibility is unconditional (fix round 9)', () => {
    // The leak workbench windows on ss.completed_at (admin-billing-recovery
    // uninvoicedLeakQuery) — pinned below against the real source — so the
    // write side must never leave a backfill completion NULL there again.
    for (const svcShape of [CHECKED_IN, NEVER_STARTED]) {
      for (const typed of [45, undefined, null, BACKFILL_MAX_TIME_ON_SITE_MINUTES + 1]) {
        const instant = backfillCompletionEndInstant(SERVICE_DATE, typed, svcShape);
        expect(instant).toBeInstanceOf(Date);
        expect(etDateString(instant)).toBe(SERVICE_DATE);
      }
    }
    // The recovery query really does key on completed_at recency — if this
    // pin breaks, re-verify the visibility story before changing either side.
    const recoverySource = fs.readFileSync(
      path.join(__dirname, '../routes/admin-billing-recovery.js'), 'utf8',
    );
    expect(recoverySource).toContain(
      `.whereRaw("ss.completed_at >= now() - (? * interval '1 day')", [days])`,
    );
  });

  test('lifecycle leg composed as the route wires it: kept end stamps land on the service day, not the closeout day', () => {
    // Typed duration, never-started row — the shape that KEEPS its end
    // stamps with starts stripped. The route feeds the helper's instant as
    // the builder's `at` (source contract below).
    const endAt = backfillCompletionEndInstant(SERVICE_DATE, 45, NEVER_STARTED);
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(NEVER_STARTED, endAt || CLOSEOUT_AT, { elapsed: 45 }),
      45,
      NEVER_STARTED,
    );
    expect(etDateString(updates.actual_end_time)).toBe(SERVICE_DATE);
    expect(etDateString(updates.check_out_time)).toBe(SERVICE_DATE);
    expect(updates.service_time_minutes).toBe(45);
    for (const field of BACKFILL_INFERRED_START_FIELDS) {
      expect(updates).not.toHaveProperty(field);
    }
    // Termite-bond sync preference (actual_end_time first) now resolves to
    // the visit's day — the bond term anchors correctly.
    expect(etDateString(updates.actual_end_time || updates.check_out_time)).toBe(SERVICE_DATE);
  });

  test('lifecycle leg composed: checked-in + typed duration keeps history AND the pair equals the typed minutes', () => {
    const endAt = backfillCompletionEndInstant(SERVICE_DATE, 45, CHECKED_IN);
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(CHECKED_IN, endAt || CLOSEOUT_AT, { elapsed: 45 }),
      45,
      CHECKED_IN,
    );
    expect(updates.service_time_minutes).toBe(45);
    // The kept end completes the REAL pair exactly: start + 45.
    const pairMinutes = (new Date(updates.actual_end_time) - new Date(REAL_START)) / 60000;
    expect(pairMinutes).toBe(45);
    expect(etDateString(updates.actual_end_time)).toBe(SERVICE_DATE);
  });

  test('record leg composed: the report row end stamps carry the service day too', () => {
    const endAt = backfillCompletionEndInstant(SERVICE_DATE, 45, NEVER_STARTED);
    const lifecycleUpdates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(NEVER_STARTED, endAt || CLOSEOUT_AT, { elapsed: 45 }),
      45,
      NEVER_STARTED,
    );
    const fields = applyBackfillRecordTimingPolicy(
      buildServiceRecordCompletionTimingFields({
        scheduledService: NEVER_STARTED,
        lifecycleUpdates,
        completedAt: endAt || CLOSEOUT_AT,
        serviceRecordCols: {
          started_at: true, arrived_at: true, actual_start_time: true, check_in_time: true,
          ended_at: true, completed_at: true, actual_end_time: true, check_out_time: true,
        },
      }),
      45,
      NEVER_STARTED,
    );
    expect(etDateString(fields.ended_at)).toBe(SERVICE_DATE);
    expect(etDateString(fields.completed_at)).toBe(SERVICE_DATE);
    expect(fields.started_at).toBeNull();
  });
});

describe('empty scheduled_services update — the blank-duration checked-in closeout completes (Codex P2, fix round 4)', () => {
  const STALE_CHECKED_IN = {
    status: 'on_site',
    actual_start_time: '2026-06-20T14:00:00Z',
    check_in_time: '2026-06-20T14:00:00Z',
  };
  const CLOSEOUT_AT = new Date('2026-07-19T16:00:00Z');

  // The exact assembly the route performs for this shape.
  function scheduledServiceUpdateFor(svc, timeOnSite) {
    const endAt = backfillCompletionEndInstant('2026-06-20', timeOnSite, svc);
    const lifecycleUpdates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(svc, endAt || CLOSEOUT_AT, { elapsed: timeOnSite }),
      timeOnSite,
      svc,
    );
    return { ...lifecycleUpdates }; // non-WaveGuard: no protocol fields join it
  }

  test('the hazard is real: knex throws on an empty .update() — the pre-fix closeout failed here', () => {
    const knex = require('knex')({ client: 'pg' });
    expect(() => knex('scheduled_services').where({ id: 'svc-1' }).update({}).toString())
      .toThrow(/Empty \.update\(\)/);
    // And this shape genuinely produces the empty object: blank typed time +
    // real stale check-in strips every key the helper built.
    expect(scheduledServiceUpdateFor(STALE_CHECKED_IN, undefined)).toEqual({});
  });

  test('the guard predicate skips exactly the empty shape and nothing else', () => {
    // Empty (blank duration + real start) → skipped.
    expect(Object.keys(scheduledServiceUpdateFor(STALE_CHECKED_IN, undefined)).length).toBe(0);
    // Typed duration → writes minutes + service-day end stamps.
    const typed = scheduledServiceUpdateFor(STALE_CHECKED_IN, 45);
    expect(Object.keys(typed).length).toBeGreaterThan(0);
    expect(typed.service_time_minutes).toBe(45);
    // Never-started blank-duration → still writes the service-day end stamps.
    const startless = scheduledServiceUpdateFor({ status: 'pending' }, undefined);
    expect(Object.keys(startless).length).toBeGreaterThan(0);
    expect(etDateString(startless.actual_end_time)).toBe('2026-06-20');
    // (The route-side guard + ordering are pinned in the source contracts.)
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

describe('hashCompletionRequest — flagless backfill resumes reach the re-derivation, pre-commit retries stay strict (Codex P2 fix round; narrowed round 10)', () => {
  // The crash-resume contract: after the service record commits, a retry may
  // arrive WITHOUT `backfill` (fresh panel mount). The committed-record
  // resume claim (claimSideEffectsRun) compares the hash's CORE segment
  // only, so the route's structured_notes re-derivation can heal the flag —
  // hashed there, the committed quiet completion stranded on
  // completion_resume_payload_mismatch with its invoice/side effects never
  // run. But the round-6 exclusion was FILE-WIDE: a same-key retry after a
  // PRE-commit failure could flip loud↔quiet (or the typed duration) while
  // passing the idempotency check — no committed record exists there, so
  // the body is the only truth. Round 10 narrows: `backfill`/`timeOnSite`
  // hash into a second MODE segment; every pre-commit comparison matches
  // the FULL composite, and only claimSideEffectsRun matches on the core.
  const committedBody = {
    idempotencyKey: 'key-1',
    notes: 'Quarterly service completed',
    visitOutcome: 'routine',
    backfill: true,
    timeOnSite: 45,
  };

  test('the flag splits the FULL hash (pre-commit strictness) but never the CORE the resume claim compares', () => {
    const original = hashCompletionRequest(committedBody);
    const flaglessRetry = { ...committedBody };
    delete flaglessRetry.backfill;
    // Pre-commit: a flipped mode is a different payload now.
    expect(hashCompletionRequest(flaglessRetry)).not.toBe(original);
    expect(requestHashMatches(original, hashCompletionRequest(flaglessRetry))).toBe(false);
    // Committed-record resume: the core matches, so the flagless retry
    // reaches the structured_notes re-derivation exactly as in round 6.
    expect(resumeHashMatches(original, hashCompletionRequest(flaglessRetry))).toBe(true);
    expect(coreHashSegment(hashCompletionRequest(flaglessRetry))).toBe(coreHashSegment(original));
    // Same-intent flag spellings do not split even the full hash: omitted ≡
    // explicit false (both mean "not a backfill").
    expect(hashCompletionRequest({ ...flaglessRetry, backfill: false }))
      .toBe(hashCompletionRequest(flaglessRetry));
    // The panel's auto-elapsed timer is the same class: full splits, core
    // does not — the frozen timeOnSite governs the committed resume.
    const retimed = hashCompletionRequest({ ...committedBody, timeOnSite: 20160 });
    expect(retimed).not.toBe(original);
    expect(resumeHashMatches(original, retimed)).toBe(true);
  });

  test('real payload changes mismatch BOTH segments — resume never accepts different work', () => {
    expect(hashCompletionRequest({ ...committedBody, notes: 'different work entirely' }))
      .not.toBe(hashCompletionRequest(committedBody));
    expect(resumeHashMatches(
      hashCompletionRequest(committedBody),
      hashCompletionRequest({ ...committedBody, notes: 'different work entirely' }),
    )).toBe(false);
    expect(resumeHashMatches(
      hashCompletionRequest(committedBody),
      hashCompletionRequest({ ...committedBody, visitOutcome: 'customer_concern' }),
    )).toBe(false);
  });

  test('the segment split stays exact: telemetry+key out entirely; backfill+timeOnSite in the MODE segment only', () => {
    const attemptsSource = fs.readFileSync(path.join(__dirname, '../services/completion-attempts.js'), 'utf8');
    expect(attemptsSource).toMatch(/const \{ idempotencyKey, timeOnSite, completionTelemetry, backfill, \.\.\.stableBody \} = body \|\| \{\};/);
    expect(attemptsSource).toMatch(/backfill: backfill === true,\s*\n\s*timeOnSite: timeOnSite \?\? null,/);
    // The resume claim is the ONLY core-segment comparison site; the
    // pending/failed/succeeded sites go through the strict matcher.
    expect(attemptsSource).toMatch(/if \(!resumeHashMatches\(row\.request_hash, requestHash\)\) \{/);
    expect((attemptsSource.match(/resumeHashMatches\(/g) || []).length).toBe(2); // definition + the claimSideEffectsRun call
    expect(attemptsSource).toMatch(/const hashMismatch = !requestHashMatches\(existing\.request_hash, requestHash\);/);
    expect(attemptsSource).toMatch(/if \(!requestHashMatches\(priorSuccess\.request_hash, requestHash\)\) \{/);
    // Telemetry stays hash-free everywhere — a retry's timings never 409.
    expect(hashCompletionRequest({ ...committedBody, completionTelemetry: { submitClickedAt: 1 } }))
      .toBe(hashCompletionRequest(committedBody));
  });
});

describe('frozenResumeCompletionState — resume derives mode AND duration from the frozen record (Codex P2 ×2, fix round 5)', () => {
  // The hash exclusions above mean a resumed retry can legally disagree with
  // the committed record on `backfill` and `timeOnSite`. This helper is the
  // single answer the route reads on the side-effect resume path: the frozen
  // structured_notes decide BOTH, the retry body has no vote — its signature
  // cannot even receive a request duration.

  test('flagless retry of a committed backfill stays QUIET, with the frozen typed duration', () => {
    const out = frozenResumeCompletionState(
      { backfill: true, timeOnSite: 45 },
      { requestBackfill: false },
    );
    expect(out.isBackfillCompletion).toBe(true);   // quiet path holds
    expect(out.effectiveTimeOnSite).toBe(45);      // committed typed duration
    expect(out.bodyDisagreed).toBe(true);          // route logs the mismatch
  });

  test('flagged retry of a committed NORMAL completion stays LOUD — the checkbox cannot quiet a committed completion', () => {
    // The committed record froze no backfill flag: the transaction ran the
    // normal contract, so the resumed sends/charges must run loud too.
    const out = frozenResumeCompletionState(
      { timeOnSite: 30 },
      { requestBackfill: true },
    );
    expect(out.isBackfillCompletion).toBe(false);
    expect(out.bodyDisagreed).toBe(true);
    // Entirely empty notes (legacy record) downgrade the same way.
    expect(frozenResumeCompletionState({}, { requestBackfill: true }).isBackfillCompletion).toBe(false);
    expect(frozenResumeCompletionState(null, { requestBackfill: true }).isBackfillCompletion).toBe(false);
  });

  test('frozen duration wins over the retry timer — the helper has no request-duration input at all', () => {
    // A flagless retry carries the panel's auto-elapsed value in its body;
    // the helper's shape makes it unforwardable: duration comes ONLY from the
    // frozen stamp, and an absent stamp is the unknown-duration shape (null),
    // never any elapsed math.
    expect(frozenResumeCompletionState({ backfill: true }, { requestBackfill: false }).effectiveTimeOnSite).toBeNull();
    expect(frozenResumeCompletionState({ backfill: true, timeOnSite: null }, { requestBackfill: true }).effectiveTimeOnSite).toBeNull();
    expect(frozenResumeCompletionState({ backfill: true, timeOnSite: 90 }, { requestBackfill: true }).effectiveTimeOnSite).toBe(90);
    // Even smuggling an elapsed value through the request options changes
    // nothing — the mode flag is the only request input the helper reads.
    expect(
      frozenResumeCompletionState(
        { backfill: true },
        { requestBackfill: false, timeOnSite: 20160, effectiveTimeOnSite: 20160 },
      ).effectiveTimeOnSite,
    ).toBeNull();
  });

  test('agreement in either direction reports no disagreement', () => {
    expect(frozenResumeCompletionState({ backfill: true }, { requestBackfill: true }).bodyDisagreed).toBe(false);
    expect(frozenResumeCompletionState({}, { requestBackfill: false }).bodyDisagreed).toBe(false);
  });

  test('only boolean true quiets — a truthy-string frozen flag is not a backfill (mirrors backfillCompletionPlan)', () => {
    const out = frozenResumeCompletionState({ backfill: 'true', timeOnSite: 45 }, { requestBackfill: false });
    expect(out.isBackfillCompletion).toBe(false);
  });

  test('the REQUIRED-mint posture rides the freeze — a flagless retry still surfaces it (fix round 8)', () => {
    const out = frozenResumeCompletionState(
      { backfill: true, backfillMintRequired: true, timeOnSite: 45 },
      { requestBackfill: false },
    );
    expect(out.isBackfillCompletion).toBe(true);
    expect(out.backfillMintRequired).toBe(true);
  });

  test('posture is strict-boolean and gated on the frozen backfill mode — nothing can smuggle a requirement in', () => {
    // Absent stamp = not required (legacy committed records included).
    expect(frozenResumeCompletionState({ backfill: true }, {}).backfillMintRequired).toBe(false);
    // Truthy-string stamp is not a posture (mirrors the backfill flag rule).
    expect(frozenResumeCompletionState({ backfill: true, backfillMintRequired: 'true' }, {}).backfillMintRequired).toBe(false);
    // A NORMAL completion's record can never carry a mint requirement, even
    // with a stray stamp — the posture only exists under the frozen mode.
    expect(frozenResumeCompletionState({ backfillMintRequired: true }, {}).backfillMintRequired).toBe(false);
    expect(frozenResumeCompletionState(null, {}).backfillMintRequired).toBe(false);
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

describe('backfillTypedOneTimeMintRequired — ONE predicate decides the mint AND the fail-closed enforcement (Codex P0, fix round 7)', () => {
  // The population whose fail-closed pre-gate the backfill bypassed. The
  // route's invoice catch fail-closes on exactly this function, and the
  // shouldAutoInvoiceCompletion backfill branch delegates to it — so what
  // mints and what refuses to finalize without a mint cannot drift.
  const REQUIRED = {
    isBackfillCompletion: true,
    typedOneTimeBilling: true,
    hasVisitPrice: true,
    visitPerformed: true,
    isCallback: false,
    serviceType: 'Bed Bug Treatment',
  };

  test('the required shape is required; every single-leg flip is not', () => {
    expect(backfillTypedOneTimeMintRequired(REQUIRED)).toBe(true);
    expect(backfillTypedOneTimeMintRequired({ ...REQUIRED, isBackfillCompletion: false })).toBe(false);
    expect(backfillTypedOneTimeMintRequired({ ...REQUIRED, typedOneTimeBilling: false })).toBe(false);
    expect(backfillTypedOneTimeMintRequired({ ...REQUIRED, hasVisitPrice: false })).toBe(false);
    expect(backfillTypedOneTimeMintRequired({ ...REQUIRED, visitPerformed: false })).toBe(false);
    expect(backfillTypedOneTimeMintRequired({ ...REQUIRED, isCallback: true })).toBe(false);
    expect(backfillTypedOneTimeMintRequired({ ...REQUIRED, serviceType: 'Bed Bug Follow-Up Visit' })).toBe(false);
  });

  test('full-lattice equivalence with the mint decision — for the signal-free base, required ⇔ mints, and a supplied posture governs (fix round 8)', () => {
    // Suppressor-free, no other billing signal (no scheduler flag, no tier,
    // no explicit lane, priced-visits gate off): the ONLY branch that can
    // mint is the typed backfill branch, which delegates to the predicate.
    // The frozen dimension: backfillMintRequired null (live/legacy) must
    // decide exactly like the predicate; a supplied boolean posture must
    // decide the branch ENTIRELY — true mints for any backfill combo (even
    // one whose live profile inputs no longer agree), false never mints.
    const base = {
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      createInvoiceOnComplete: false,
      waveguardTier: null,
      explicitMembership: false,
      explicitPerVisitLane: false,
      perApplicationBilling: false,
      annualPrepayBilling: false,
      invoiceAmount: 350,
      autoInvoicePricedVisits: false,
      annualPrepayCovered: false,
    };
    const bools = [true, false];
    for (const backfillMintRequired of [null, true, false]) {
      for (const isBackfillCompletion of bools) {
        for (const typedOneTimeBilling of bools) {
          for (const hasVisitPrice of bools) {
            for (const visitPerformed of bools) {
              for (const isCallback of bools) {
                for (const serviceType of ['Bed Bug Treatment', 'Bed Bug Follow-Up Visit']) {
                  const combo = {
                    isBackfillCompletion, typedOneTimeBilling, hasVisitPrice,
                    visitPerformed, isCallback, serviceType,
                  };
                  const expected = backfillMintRequired == null
                    ? backfillTypedOneTimeMintRequired(combo)
                    : (backfillMintRequired === true && isBackfillCompletion);
                  expect(shouldAutoInvoiceCompletion({ ...base, ...combo, backfillMintRequired }))
                    .toBe(expected);
                }
              }
            }
          }
        }
      }
    }
  });

  test('the frozen posture survives a CHANGED live profile — the P0 sequence mints on resume (fix round 8)', () => {
    const base = {
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      createInvoiceOnComplete: false,
      waveguardTier: null,
      invoiceAmount: 350,
      autoInvoicePricedVisits: false,
      annualPrepayCovered: false,
      isBackfillCompletion: true,
      hasVisitPrice: true,
      visitPerformed: true,
      isCallback: false,
      serviceType: 'Bed Bug Treatment',
    };
    // Profile edited/removed between the released mint failure and the
    // retry: typedOneTimeBilling recomputes FALSE live — the frozen posture
    // still mints the owed review invoice.
    expect(shouldAutoInvoiceCompletion({
      ...base, typedOneTimeBilling: false, backfillMintRequired: true,
    })).toBe(true);
    // Suppressors still win over the posture: an invoice already in place
    // (the partial-mint convergence) IS the promise kept — never a double
    // mint.
    expect(shouldAutoInvoiceCompletion({
      ...base, typedOneTimeBilling: false, backfillMintRequired: true,
      existingCompletionInvoice: { id: 'inv' },
    })).toBe(false);
    // The reverse mutation cannot surprise-bill: committed NOT-required, a
    // profile flipped INTO one_time before the resume — the posture governs
    // and the branch declines (a return, never a tier fall-through).
    expect(shouldAutoInvoiceCompletion({
      ...base, typedOneTimeBilling: true, backfillMintRequired: false,
    })).toBe(false);
    expect(shouldAutoInvoiceCompletion({
      ...base, typedOneTimeBilling: true, backfillMintRequired: false, waveguardTier: 'gold',
    })).toBe(false);
  });

  test('the narrow typed predicate still refuses non-typed shapes — but the COMMIT POSTURE now covers them (fix round 9)', () => {
    // Round 8's fail-closed scope keyed on this predicate alone, so a
    // scheduler-flag backfill mint failure fell through the non-blocking
    // catch: finalized unbilled — the exact P0 shape. The narrow predicate
    // is unchanged (it is the typed BRANCH decision); the broadened
    // commit-time posture below is what the route freezes and enforces on.
    const schedulerFlagBackfill = {
      isBackfillCompletion: true,
      typedOneTimeBilling: false,
      hasVisitPrice: true,
      visitPerformed: true,
      isCallback: false,
      serviceType: 'Quarterly Pest Control Service',
    };
    expect(backfillTypedOneTimeMintRequired(schedulerFlagBackfill)).toBe(false);
    expect(backfillExpectedMintAtCommit({
      ...schedulerFlagBackfill,
      createInvoiceOnComplete: true,
      invoiceAmount: 129,
    })).toBe(true);
    // Live completions are never required here either — the live pre-gate
    // still owns them.
    expect(backfillTypedOneTimeMintRequired({
      ...schedulerFlagBackfill, typedOneTimeBilling: true, isBackfillCompletion: false,
    })).toBe(false);
  });
});

describe('backfillExpectedMintAtCommit — frozen-required ≡ will-mint at commit for EVERY branch (Codex P1, fix round 9)', () => {
  // The commit posture IS shouldAutoInvoiceCompletion evaluated on the same
  // commit-time branch inputs, settlement suppressors neutralized. These
  // tests pin (1) the exact codex populations round 8 missed, (2) the
  // full-lattice equivalence with the live decision, and (3) the broadened
  // posture governing every branch in both directions on resume.
  const AMOUNT_BASE = {
    isBackfillCompletion: true,
    recapReviewOnly: false,
    createInvoiceOnComplete: false,
    waveguardTier: null,
    explicitMembership: false,
    explicitPerVisitLane: false,
    perApplicationBilling: false,
    annualPrepayBilling: false,
    hasVisitPrice: false,
    invoiceAmount: 129,
    autoInvoicePricedVisits: false,
    serviceType: 'Quarterly Pest Control Service',
    isCallback: false,
    visitPerformed: true,
    typedOneTimeBilling: false,
  };

  test('the codex P1 population: typed one-time + NO row price + scheduler flag (monthly-rate amount) freezes REQUIRED', () => {
    // resolveProjectCompletionBilling treats the cioc-gated monthly-rate
    // amount as REQUIRED (project-completion.js) — live, this visit would
    // 409 into the checkout detour. Backfilled, the mint rides the
    // createInvoiceOnComplete branch; round 8 froze false (no row price) and
    // a transient mint failure finalized the closeout unbilled.
    expect(backfillExpectedMintAtCommit({
      ...AMOUNT_BASE,
      typedOneTimeBilling: true,
      createInvoiceOnComplete: true,
      hasVisitPrice: false,
      invoiceAmount: 89, // the monthly rate via completionInvoiceAmount
    })).toBe(true);
    // …and the monthly-rate/tier branch shape (unpriced legacy member row).
    expect(backfillExpectedMintAtCommit({
      ...AMOUNT_BASE,
      waveguardTier: 'gold',
      hasVisitPrice: false,
      invoiceAmount: 89,
    })).toBe(true);
    // The typed+priced round-8 population still freezes REQUIRED.
    expect(backfillExpectedMintAtCommit({
      ...AMOUNT_BASE, typedOneTimeBilling: true, hasVisitPrice: true, invoiceAmount: 350,
      serviceType: 'Bed Bug Treatment',
    })).toBe(true);
  });

  test('dues coverage participates in the freeze — covered-at-commit freezes NOT-required, and the coverage-lapse resume cannot surprise-bill (Codex P2, fix round 12)', () => {
    // The reported sequence: a backfilled monthly/WaveGuard visit that
    // membershipDuesCoverVisit covers at commit. Forcing autopayCoversVisit
    // false in the derivation froze required=TRUE; live shouldInvoice still
    // suppressed on run one (no visible divergence), but a crash before
    // succeed + a dues/autopay change before the retry made the resume
    // honor frozen TRUE and mint for a visit that was covered when it
    // completed. Coverage is a COMMIT-TIME business rule (payer + autopay +
    // svc fields, all hoisted above the transaction), so it now freezes
    // with its real value: covered → required=false — no mint was ever owed.
    const coveredMemberVisit = {
      ...AMOUNT_BASE,
      waveguardTier: 'gold',
      hasVisitPrice: false,
      invoiceAmount: 89, // the dues rate the tier branch would bill
      autopayCoversVisit: true,
    };
    expect(backfillExpectedMintAtCommit(coveredMemberVisit)).toBe(false);
    // …the surprise-bill resume is dead: frozen FALSE governs even though
    // the live tier branch would now mint (coverage lapsed post-commit).
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false, // dues/autopay changed before the retry
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      annualPrepayCovered: false,
      createInvoiceOnComplete: false,
      waveguardTier: 'gold',
      hasVisitPrice: false,
      invoiceAmount: 89,
      autoInvoicePricedVisits: false,
      serviceType: 'Quarterly Pest Control Service',
      isCallback: false,
      visitPerformed: true,
      typedOneTimeBilling: false,
      isBackfillCompletion: true,
      backfillMintRequired: false, // the frozen posture
    })).toBe(false);
    // UNCOVERED at commit is unchanged: freezes required=true, and a
    // later coverage change cannot drop the owed mint — the resume still
    // mints at the frozen money (posture governs).
    const uncoveredMemberVisit = { ...coveredMemberVisit, autopayCoversVisit: false };
    expect(backfillExpectedMintAtCommit(uncoveredMemberVisit)).toBe(true);
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: true, // autopay re-enabled before the retry
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      annualPrepayCovered: false,
      createInvoiceOnComplete: false,
      waveguardTier: 'gold',
      hasVisitPrice: false,
      invoiceAmount: 89,
      autoInvoicePricedVisits: false,
      serviceType: 'Quarterly Pest Control Service',
      isCallback: false,
      visitPerformed: true,
      typedOneTimeBilling: false,
      isBackfillCompletion: true,
      backfillMintRequired: true, // the frozen posture
    })).toBe(false); // live coverage is a SUPPRESSOR — it still wins at mint
    // (that suppression is the settle-guard convergence, not a dropped
    // mint: with coverage genuinely back, dues own the visit again. With
    // coverage still lapsed the posture mints:)
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      annualPrepayCovered: false,
      createInvoiceOnComplete: false,
      waveguardTier: null, // tier even cleared post-commit
      hasVisitPrice: false,
      invoiceAmount: 89,
      autoInvoicePricedVisits: false,
      serviceType: 'Quarterly Pest Control Service',
      isCallback: false,
      visitPerformed: true,
      typedOneTimeBilling: false,
      isBackfillCompletion: true,
      backfillMintRequired: true,
    })).toBe(true);
  });

  test('shapes with no expected mint freeze NOT-required: non-backfill, recap-only, $0, always-free, callback lanes', () => {
    expect(backfillExpectedMintAtCommit({ ...AMOUNT_BASE, isBackfillCompletion: false, createInvoiceOnComplete: true })).toBe(false);
    expect(backfillExpectedMintAtCommit({ ...AMOUNT_BASE, recapReviewOnly: true, createInvoiceOnComplete: true })).toBe(false);
    expect(backfillExpectedMintAtCommit({ ...AMOUNT_BASE, createInvoiceOnComplete: true, invoiceAmount: 0 })).toBe(false);
    // No billing signal at all → no branch mints → not required.
    expect(backfillExpectedMintAtCommit({ ...AMOUNT_BASE })).toBe(false);
    // Explicit per-visit lane excludes callbacks/always-free even priced.
    expect(backfillExpectedMintAtCommit({
      ...AMOUNT_BASE, explicitPerVisitLane: true, hasVisitPrice: true, isCallback: true,
    })).toBe(false);
    expect(backfillExpectedMintAtCommit({
      ...AMOUNT_BASE, explicitPerVisitLane: true, hasVisitPrice: true,
      serviceType: 'Pest Re-Service',
    })).toBe(false);
    // Annual-prepay unpriced visits stay owned by the renewal flow.
    expect(backfillExpectedMintAtCommit({
      ...AMOUNT_BASE, annualPrepayBilling: true, hasVisitPrice: false, waveguardTier: 'gold',
    })).toBe(false);
  });

  test('full-lattice equivalence: for every branch-input combo, frozen-required equals the live mint decision at commit', () => {
    // The SETTLE-STATE suppressors are fixed OFF (they are post-transaction
    // settlement lookups; at commit the posture is the settle-state-free
    // will-mint) and amount fixed positive — the dimensions below are
    // exactly the branch inputs the decision reads, PLUS the commit-time
    // business suppressor autopayCoversVisit, which participates with its
    // REAL value on both sides (fix round 12). Delegation makes equality
    // structural; this pins it against future drift in either function.
    const bools = [true, false];
    const settleStateFree = {
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      annualPrepayCovered: false,
      invoiceAmount: 129,
    };
    for (const autopayCoversVisit of bools) {
      for (const createInvoiceOnComplete of bools) {
        for (const waveguardTier of ['gold', null]) {
          for (const explicitPerVisitLane of bools) {
            for (const perApplicationBilling of bools) {
              for (const annualPrepayBilling of bools) {
                for (const hasVisitPrice of bools) {
                  for (const typedOneTimeBilling of bools) {
                    for (const autoInvoicePricedVisits of bools) {
                      for (const visitPerformed of bools) {
                        for (const serviceType of ['Quarterly Pest Control Service', 'Pest Re-Service']) {
                          const combo = {
                            autopayCoversVisit,
                            createInvoiceOnComplete,
                            waveguardTier,
                            explicitMembership: false,
                            explicitPerVisitLane,
                            perApplicationBilling,
                            annualPrepayBilling,
                            hasVisitPrice,
                            typedOneTimeBilling,
                            autoInvoicePricedVisits,
                            visitPerformed,
                            serviceType,
                            isCallback: false,
                          };
                          const frozen = backfillExpectedMintAtCommit({
                            ...combo, isBackfillCompletion: true, recapReviewOnly: false,
                            invoiceAmount: settleStateFree.invoiceAmount,
                          });
                          const willMint = shouldAutoInvoiceCompletion({
                            ...settleStateFree, ...combo,
                            isBackfillCompletion: true,
                            backfillMintRequired: null,
                          });
                          expect(frozen).toBe(willMint);
                          // Coverage is a SUPPRESSOR in the live decision, so
                          // covered combos can never freeze required.
                          if (autopayCoversVisit) expect(frozen).toBe(false);
                          // …and a SUPPLIED posture governs the same combo in
                          // both directions (round 8's doctrine, broadened to
                          // every branch): mutated live state can neither drop
                          // the owed mint nor surprise-bill the resume. (The
                          // posture-true leg holds for coverage-free resumes;
                          // live coverage still suppresses ahead of it — the
                          // settle-guard convergence, pinned separately.)
                          expect(shouldAutoInvoiceCompletion({
                            ...settleStateFree, ...combo,
                            autopayCoversVisit: false,
                            isBackfillCompletion: true,
                            backfillMintRequired: true,
                          })).toBe(true);
                          expect(shouldAutoInvoiceCompletion({
                            ...settleStateFree, ...combo,
                            isBackfillCompletion: true,
                            backfillMintRequired: false,
                          })).toBe(false);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  test('the P0 sequence, broadened: cioc flag cleared between commit and resume — the frozen TRUE still mints', () => {
    // Commit: scheduler-flag backfill, frozen REQUIRED. Between the released
    // mint failure and the retry an admin unchecks create_invoice_on_complete
    // — the live branch would now decline, exactly the round-8 P0 shape on a
    // population round 8 did not freeze.
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      annualPrepayCovered: false,
      createInvoiceOnComplete: false, // cleared post-commit
      waveguardTier: null,
      invoiceAmount: 129,
      autoInvoicePricedVisits: false,
      serviceType: 'Quarterly Pest Control Service',
      isCallback: false,
      visitPerformed: true,
      typedOneTimeBilling: false,
      hasVisitPrice: true,
      isBackfillCompletion: true,
      backfillMintRequired: true,
    })).toBe(true);
    // Reverse mutation: committed NOT-required, cioc flag set afterwards —
    // the resumed quiet closeout is not surprise-billed.
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      annualPrepayCovered: false,
      createInvoiceOnComplete: true, // set post-commit
      waveguardTier: 'gold',
      invoiceAmount: 129,
      autoInvoicePricedVisits: true,
      serviceType: 'Quarterly Pest Control Service',
      isCallback: false,
      visitPerformed: true,
      typedOneTimeBilling: false,
      hasVisitPrice: true,
      isBackfillCompletion: true,
      backfillMintRequired: false,
    })).toBe(false);
    // Suppressors still beat a TRUE posture: settlement is the promise kept.
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: { id: 'inv' },
      annualPrepayCovered: false,
      createInvoiceOnComplete: true,
      waveguardTier: null,
      invoiceAmount: 129,
      autoInvoicePricedVisits: false,
      serviceType: 'Quarterly Pest Control Service',
      isCallback: false,
      visitPerformed: true,
      typedOneTimeBilling: false,
      hasVisitPrice: true,
      isBackfillCompletion: true,
      backfillMintRequired: true,
    })).toBe(false);
    // Non-backfill callers are untouched by any supplied posture.
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      annualPrepayCovered: false,
      createInvoiceOnComplete: true,
      waveguardTier: null,
      invoiceAmount: 129,
      autoInvoicePricedVisits: false,
      serviceType: 'Quarterly Pest Control Service',
      isCallback: false,
      visitPerformed: true,
      typedOneTimeBilling: false,
      hasVisitPrice: true,
      isBackfillCompletion: false,
      backfillMintRequired: false,
    })).toBe(true);
  });
});

describe('frozen required-mint MONEY — the amount can neither vanish nor change on resume (Codex P0, fix round 10)', () => {
  const suppressorFree = {
    recapReviewOnly: false,
    alreadyPaid: false,
    prepaidCovered: false,
    autopayCoversVisit: false,
    preMintedInvoice: null,
    existingCompletionInvoice: null,
    annualPrepayCovered: false,
    createInvoiceOnComplete: false,
    waveguardTier: null,
    autoInvoicePricedVisits: false,
    serviceType: 'Bed Bug Treatment',
    isCallback: false,
    visitPerformed: true,
    typedOneTimeBilling: false,
    hasVisitPrice: false,
  };

  test('frozenResumeCompletionState restores the frozen cents as dollars, and the tax basis, ONLY under the required backfill mode', () => {
    const frozen = frozenResumeCompletionState(
      { backfill: true, backfillMintRequired: true, backfillMintAmountCents: 35000, backfillMintTaxRate: 0.07, timeOnSite: 45 },
      { requestBackfill: false },
    );
    expect(frozen.backfillMintRequired).toBe(true);
    expect(frozen.backfillMintAmount).toBe(350);
    expect(frozen.backfillMintTaxRate).toBe(0.07);
    // Fractional cents round-trip exactly (the freeze stamps integer cents).
    expect(frozenResumeCompletionState(
      { backfill: true, backfillMintRequired: true, backfillMintAmountCents: 12999 },
      {},
    ).backfillMintAmount).toBe(129.99);
    // A record that is not a required backfill can never smuggle money in —
    // same strictness as the posture itself.
    expect(frozenResumeCompletionState(
      { backfill: true, backfillMintAmountCents: 35000, backfillMintTaxRate: 0.07 },
      {},
    )).toMatchObject({ backfillMintRequired: false, backfillMintAmount: null, backfillMintTaxRate: null });
    expect(frozenResumeCompletionState(
      { backfillMintRequired: true, backfillMintAmountCents: 35000 },
      {},
    )).toMatchObject({ backfillMintRequired: false, backfillMintAmount: null });
  });

  test('invalid frozen money restores null — the route then fail-closes instead of minting it', () => {
    const base = { backfill: true, backfillMintRequired: true };
    for (const cents of [undefined, null, 0, -100, 129.5, '35000', Number.NaN, Infinity]) {
      expect(frozenResumeCompletionState(
        { ...base, backfillMintAmountCents: cents },
        {},
      ).backfillMintAmount).toBeNull();
    }
    for (const rate of [undefined, null, -0.07, 1, 1.5, '0.07', Number.NaN]) {
      expect(frozenResumeCompletionState(
        { ...base, backfillMintAmountCents: 35000, backfillMintTaxRate: rate },
        {},
      ).backfillMintTaxRate).toBeNull();
    }
    // …and a valid zero tax rate is a real value, not "missing".
    expect(frozenResumeCompletionState(
      { ...base, backfillMintAmountCents: 35000, backfillMintTaxRate: 0 },
      {},
    ).backfillMintTaxRate).toBe(0);
  });

  test('the P0 sequence: price CLEARED after a released mint failure — the frozen amount keeps the decision true and prices the mint', () => {
    // Commit froze required + $350 (cents). Post-commit the visit price is
    // cleared: the live derivation now yields 0. Round 9's amount guard ran
    // FIRST and returned false — shouldInvoice=false, the retry finalized
    // WITHOUT the required invoice. The route now feeds the guard the
    // frozen amount (mintInvoiceAmount), and the posture governs from above
    // the guard, so the decision stays true and the mint prices at $350.
    const frozen = frozenResumeCompletionState(
      { backfill: true, backfillMintRequired: true, backfillMintAmountCents: 35000, backfillMintTaxRate: 0 },
      { requestBackfill: false },
    );
    const mintInvoiceAmount = frozen.backfillMintRequired && frozen.backfillMintAmount != null
      ? frozen.backfillMintAmount
      : 0; // live derivation after the price was cleared
    expect(mintInvoiceAmount).toBe(350);
    expect(shouldAutoInvoiceCompletion({
      ...suppressorFree,
      invoiceAmount: mintInvoiceAmount,
      isBackfillCompletion: frozen.isBackfillCompletion,
      backfillMintRequired: frozen.backfillMintRequired,
    })).toBe(true);
    // Even a live-zero amount cannot skip a REQUIRED decision anymore (the
    // frozen-missing legacy resume): the posture sits above the guard, so
    // the decision reaches the mint block — which refuses the recomputed
    // amount and fail-closes through the release/503 catch (source pins).
    expect(shouldAutoInvoiceCompletion({
      ...suppressorFree,
      invoiceAmount: 0,
      isBackfillCompletion: true,
      backfillMintRequired: true,
    })).toBe(true);
    // Unchanged posture-null and posture-false semantics around the guard:
    // no live branch mints $0, and a committed not-required stays declined.
    expect(shouldAutoInvoiceCompletion({
      ...suppressorFree,
      createInvoiceOnComplete: true,
      invoiceAmount: 0,
      isBackfillCompletion: true,
      backfillMintRequired: null,
    })).toBe(false);
    expect(shouldAutoInvoiceCompletion({
      ...suppressorFree,
      createInvoiceOnComplete: true,
      invoiceAmount: 0,
      isBackfillCompletion: true,
      backfillMintRequired: false,
    })).toBe(false);
    // Suppressors still beat the frozen money: an invoice already in place
    // IS the promise kept — never a second mint at the frozen amount.
    expect(shouldAutoInvoiceCompletion({
      ...suppressorFree,
      existingCompletionInvoice: { id: 'inv' },
      invoiceAmount: 350,
      isBackfillCompletion: true,
      backfillMintRequired: true,
    })).toBe(false);
  });

  test('every backfill mint IS a required mint — the replay bypass therefore covers 100% of backfill mints (fix round 11)', () => {
    // The route always passes a boolean posture for a backfill (the commit
    // derivation first-run, the frozen value on resume) — never null — and
    // a FALSE posture returns before any branch can mint. So there is no
    // "non-required backfill mint": under backfill, reaching the mint block
    // implies posture true, and the frozen-money shape (single line at the
    // frozen amount, replay off) is the only backfill mint shape. Pinned
    // across every mint signal at once:
    expect(shouldAutoInvoiceCompletion({
      ...suppressorFree,
      createInvoiceOnComplete: true,
      waveguardTier: 'gold',
      explicitMembership: true,
      explicitPerVisitLane: true,
      autoInvoicePricedVisits: true,
      typedOneTimeBilling: true,
      hasVisitPrice: true,
      invoiceAmount: 129,
      isBackfillCompletion: true,
      backfillMintRequired: false,
    })).toBe(false);
    // …and the same all-signals shape with posture true mints, priced by
    // the frozen amount the route threads (source pins above).
    expect(shouldAutoInvoiceCompletion({
      ...suppressorFree,
      createInvoiceOnComplete: true,
      invoiceAmount: 129,
      isBackfillCompletion: true,
      backfillMintRequired: true,
    })).toBe(true);
  });

  test('the WRONG-amount leg: an edited price cannot change the resumed mint — the frozen cents win over the live derivation', () => {
    const frozen = frozenResumeCompletionState(
      { backfill: true, backfillMintRequired: true, backfillMintAmountCents: 35000, backfillMintTaxRate: 0.07 },
      { requestBackfill: false },
    );
    const liveRecomputedAmount = 899; // price edited post-commit
    const mintInvoiceAmount = frozen.backfillMintRequired && frozen.backfillMintAmount != null
      ? frozen.backfillMintAmount
      : liveRecomputedAmount;
    const mintInvoiceTaxRate = frozen.backfillMintRequired && frozen.backfillMintTaxRate != null
      ? frozen.backfillMintTaxRate
      : 0; // property_type flipped residential post-commit
    expect(mintInvoiceAmount).toBe(350);
    expect(mintInvoiceTaxRate).toBe(0.07);
  });
});

describe('required-mint failure leaves the closeout resumable — fail-closed bypass leg (Codex P0, fix round 7)', () => {
  // Behavioral leg drives the real completion-attempts machinery against an
  // ops-queue knex mock (same style as completion-attempts.test.js): a
  // released attempt must be claimable IMMEDIATELY — that claim is what
  // makes "retry the closeout" true, and the re-entered route re-derives
  // the mint from the frozen/hash-pinned inputs (composition test below).
  function makeOpsKnex(ops) {
    const calls = [];
    const knex = jest.fn((table) => {
      const op = ops.shift();
      if (!op) throw new Error(`Unexpected table call: ${table}`);
      calls.push({ table, op });
      const chain = {
        where: jest.fn((criteria) => { op.whereCriteria = criteria; return chain; }),
        whereIn: jest.fn((col, values) => { op.whereIn = { col, values }; return chain; }),
        andWhere: jest.fn((...args) => { op.andWhereArgs = args; return chain; }),
        orderBy: jest.fn(() => chain),
        update: jest.fn((payload) => {
          if (op.updateError) throw op.updateError;
          op.updatePayload = payload;
          return chain;
        }),
        returning: jest.fn(async () => op.returning || []),
        first: jest.fn(async () => op.first),
      };
      return chain;
    });
    knex.calls = calls;
    return knex;
  }

  test('release flips the running claim to side_effects_pending and records the mint error — never failed, never succeeded', async () => {
    const knex = makeOpsKnex([{ returning: [{ id: 'attempt-1', status: 'side_effects_pending' }] }]);
    const ok = await releaseCompletionAttemptForResume(
      { id: 'attempt-1' },
      new Error('invoice mint blew up'),
      knex,
    );
    expect(ok).toBe(true);
    const op = knex.calls[0].op;
    // Conditional on the running status — a finalized attempt can never be
    // flipped back by a late release.
    expect(op.whereCriteria).toEqual({ id: 'attempt-1', status: 'side_effects_running' });
    expect(op.updatePayload.status).toBe('side_effects_pending');
    expect(op.updatePayload.error).toBe('invoice mint blew up');
    expect(op.updatePayload.updated_at).toBeInstanceOf(Date);
  });

  test('release is guarded and swallowing: zero-row match → false, update throw → false, no attempt → knex untouched', async () => {
    const guarded = makeOpsKnex([{ returning: [] }]);
    await expect(releaseCompletionAttemptForResume({ id: 'attempt-1' }, new Error('x'), guarded))
      .resolves.toBe(false);
    const throwing = makeOpsKnex([{ updateError: new Error('db down') }]);
    await expect(releaseCompletionAttemptForResume({ id: 'attempt-1' }, new Error('x'), throwing))
      .resolves.toBe(false);
    const untouched = makeOpsKnex([]);
    await expect(releaseCompletionAttemptForResume(null, new Error('x'), untouched))
      .resolves.toBe(false);
    expect(untouched.calls.length).toBe(0);
  });

  const RELEASED_ROW = {
    id: 'attempt-1',
    service_id: 'svc-1',
    status: 'side_effects_pending',
    service_record_id: 'rec-1',
    request_hash: 'hash-1',
    updated_at: new Date(), // seconds old — NO stale wait required
  };

  test('a released attempt claims as an immediate resume — no stale-window wait, straight back into the side effects', async () => {
    const knex = makeOpsKnex([
      { first: undefined },      // no prior success
      { first: RELEASED_ROW },   // resumable lookup finds the released row
      { returning: [{ ...RELEASED_ROW, status: 'side_effects_running' }] }, // the claim
    ]);
    const result = await claimCompletionAttempt(
      { serviceId: 'svc-1', idempotencyKey: 'key-2', requestHash: 'hash-1' },
      knex,
    );
    expect(result.action).toBe('resume');
    expect(result.serviceRecordId).toBe('rec-1');
    const claimOp = knex.calls[2].op;
    expect(claimOp.whereCriteria).toEqual({ id: 'attempt-1', status: 'side_effects_pending' });
    // The pending state carries NO stale-cutoff clause — that gate exists
    // only for side_effects_running. This is the machinery fact the whole
    // fail-closed shape rests on.
    expect(claimOp.andWhereArgs).toBeUndefined();
    expect(claimOp.updatePayload.status).toBe('side_effects_running');
  });

  test('contrast: WITHOUT the release, a fresh running row 409s the retry for the whole stale window', async () => {
    const knex = makeOpsKnex([
      { first: undefined },
      { first: { ...RELEASED_ROW, status: 'side_effects_running' } },
    ]);
    const result = await claimCompletionAttempt(
      { serviceId: 'svc-1', idempotencyKey: 'key-2', requestHash: 'hash-1' },
      knex,
    );
    expect(result.action).toBe('conflict');
    expect(result.payload.code).toBe('completion_side_effects_running');
  });

  test('the resume claim is hash-guarded — a retry with a DIFFERENT body cannot claim the released attempt', async () => {
    // Frozen-inputs enforcement: every request-body input to the required
    // predicate (visitOutcome, oneTimeRecapOnly, structuredFindings, …) is
    // part of the request hash, so a resumed run can only ever re-derive the
    // SAME predicate the committed run used.
    const knex = makeOpsKnex([
      { first: undefined },
      { first: RELEASED_ROW },
    ]);
    const result = await claimCompletionAttempt(
      { serviceId: 'svc-1', idempotencyKey: 'key-2', requestHash: 'hash-DIFFERENT' },
      knex,
    );
    expect(result.action).toBe('conflict');
    expect(result.payload.code).toBe('completion_resume_payload_mismatch');
  });

  test('frozen-inputs pin: the predicate body inputs split the hash; mode is frozen; the resumed decision re-mints', () => {
    // The hash pins the body inputs (a changed visitOutcome/oneTimeRecapOnly
    // can never ride a resume claim)…
    const body = { idempotencyKey: 'k', visitOutcome: 'completed', oneTimeRecapOnly: false, structuredFindings: { severity: 'high' } };
    expect(hashCompletionRequest({ ...body, visitOutcome: 'inspection_only' })).not.toBe(hashCompletionRequest(body));
    expect(hashCompletionRequest({ ...body, oneTimeRecapOnly: true })).not.toBe(hashCompletionRequest(body));
    // …the completion MODE **and the REQUIRED-mint posture** come from the
    // structured_notes freeze even on a flagless retry (fix round 8: the
    // posture is stamped in the commit transaction because the billing
    // profile is MUTABLE DB state the hash cannot pin)…
    const frozen = frozenResumeCompletionState(
      { backfill: true, backfillMintRequired: true, timeOnSite: 45 },
      { requestBackfill: false },
    );
    expect(frozen.isBackfillCompletion).toBe(true);
    expect(frozen.backfillMintRequired).toBe(true);
    // …and the resumed decision honors the FROZEN posture — here with the
    // live profile CHANGED since commit (typedOneTimeBilling recomputes
    // false) — so the mint still retries: no invoice was created, no
    // suppressor blocks it, the owed review invoice mints.
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      createInvoiceOnComplete: false,
      waveguardTier: null,
      invoiceAmount: 350,
      autoInvoicePricedVisits: false,
      annualPrepayCovered: false,
      isBackfillCompletion: frozen.isBackfillCompletion,
      backfillMintRequired: frozen.backfillMintRequired,
      typedOneTimeBilling: false, // profile removed post-commit
      hasVisitPrice: true,
      visitPerformed: true,
      isCallback: false,
      serviceType: 'Bed Bug Treatment',
    })).toBe(true);
  });

  describe('route wiring (source contracts)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

    test('the posture derives ONCE at commit from the same input sources as the mint decision, and is FROZEN in the record transaction (fix round 8; broadened round 9)', () => {
      // Commit-time derivation: the BROADENED expected-mint posture, fed the
      // same hoisted derivations and row columns the shouldInvoice call
      // reads — the frozen posture can never describe a different population
      // than the one the mint decision bills.
      expect(source).toMatch(/const backfillMintRequiredAtCommit = backfillExpectedMintAtCommit\(\{\s*\n\s*isBackfillCompletion,\s*\n\s*recapReviewOnly,\s*\n\s*autopayCoversVisit,\s*\n\s*createInvoiceOnComplete: svc\.create_invoice_on_complete,\s*\n\s*waveguardTier: svc\.cust_waveguard_tier,\s*\n\s*explicitMembership: explicitMembershipLane,\s*\n\s*explicitPerVisitLane,\s*\n\s*perApplicationBilling,\s*\n\s*annualPrepayBilling,\s*\n\s*hasVisitPrice,\s*\n\s*invoiceAmount,\s*\n\s*autoInvoicePricedVisits: process\.env\.GATE_AUTOINVOICE_PRICED_VISITS === 'true',\s*\n\s*serviceType: svc\.service_type,\s*\n\s*isCallback: svc\.is_callback,\s*\n\s*visitPerformed,\s*\n\s*typedOneTimeBilling: typedOneTimeBillingProfile,\s*\n\s*\}\);/);
      // Dues coverage joins the freeze with its REAL value (fix round 12):
      // the coverage derivation is hoisted above the transaction — one
      // derivation shared with the invoice block, like every other input —
      // and the freeze sits after it.
      expect((source.match(/const autopayCoversVisit = membershipDuesCoverVisit\(\{/g) || []).length).toBe(1);
      expect((source.match(/const customerAutopayActive = await customerOnAutopay\(\{/g) || []).length).toBe(1);
      expect((source.match(/let visitIsPayerBilled = false;/g) || []).length).toBe(1);
      const coverageDeriveAt = source.indexOf('const autopayCoversVisit = membershipDuesCoverVisit({');
      const freezeCallAt = source.indexOf('const backfillMintRequiredAtCommit = backfillExpectedMintAtCommit({');
      expect(coverageDeriveAt).toBeGreaterThan(-1);
      expect(freezeCallAt).toBeGreaterThan(coverageDeriveAt);
      // Neutralization boundary: settle-state suppressors stay forced off in
      // the derivation; the commit-time business suppressors pass through.
      expect(source).toMatch(/recapReviewOnly,\s*\n\s*autopayCoversVisit,\s*\n\s*alreadyPaid: false,\s*\n\s*prepaidCovered: false,\s*\n\s*preMintedInvoice: null,\s*\n\s*existingCompletionInvoice: null,\s*\n\s*annualPrepayCovered: false,/);
      // The stamp lives in the SAME structured_notes object the completion
      // transaction inserts — between the trx open and the serialize — so a
      // crash can never leave a committed-but-unfrozen record. Since fix
      // round 10 the stamp carries the required mint's MONEY beside the
      // posture: integer cents + the tax basis, from the same hoisted
      // derivations, gated on the same required-mint condition (lean notes).
      const stamp = '...(isBackfillCompletion && backfillMintRequiredAtCommit ? {';
      const stampAt = source.indexOf(stamp);
      expect(stampAt).toBeGreaterThan(-1);
      expect(source).toMatch(/\.\.\.\(isBackfillCompletion && backfillMintRequiredAtCommit \? \{\s*\n\s*backfillMintRequired: true,\s*\n(?:\s*\/\/[^\n]*\n)*\s*backfillMintAmountCents: Math\.round\(Number\(invoiceAmount\) \* 100\),\s*\n\s*backfillMintTaxRate: completionInvoiceTaxRate,\s*\n\s*\} : \{\}\),/);
      // The tax basis is hoisted beside the amount — one derivation feeds
      // the freeze AND the mint (property_type is a mutable input).
      expect((source.match(/const completionInvoiceTaxRate = /g) || []).length).toBe(1);
      // The COMPLETION transaction is the nearest trx open above the stamp
      // (the file has other, earlier transactions on other routes).
      const trxAt = source.lastIndexOf("await db.transaction(async (trx) => {", stampAt);
      const serializeAt = source.indexOf('structured_notes: serializeJsonb(structuredNotes),');
      expect(stampAt).toBeGreaterThan(trxAt);
      expect(serializeAt).toBeGreaterThan(stampAt);
      // The commit derivation itself sits BEFORE the transaction — it reads
      // the billing state the operator saw, and every input it shares with
      // the invoice block is hoisted and derived exactly once (deriving any
      // of these twice is the frozen-vs-mint drift round 9 closes).
      const deriveAt = source.indexOf('const backfillMintRequiredAtCommit = backfillExpectedMintAtCommit({');
      expect(deriveAt).toBeGreaterThan(-1);
      expect(trxAt).toBeGreaterThan(deriveAt);
      expect((source.match(/const hasVisitPrice = /g) || []).length).toBe(1);
      expect((source.match(/const visitPerformed = /g) || []).length).toBe(1);
      expect((source.match(/const perApplicationBilling = /g) || []).length).toBe(1);
      expect((source.match(/const annualPrepayBilling = /g) || []).length).toBe(1);
      expect((source.match(/const invoiceAmount = completionInvoiceAmount\(\{/g) || []).length).toBe(1);
      expect((source.match(/const explicitPerVisitLane = /g) || []).length).toBe(1);
      expect((source.match(/const explicitMembershipLane = /g) || []).length).toBe(1);
      // The derivation is the mint decision itself: backfillExpectedMintAtCommit
      // delegates to shouldAutoInvoiceCompletion with the settlement
      // suppressors neutralized — equivalence by construction, not by
      // parallel logic.
      expect(source).toMatch(/function backfillExpectedMintAtCommit\(\{[\s\S]{0,1400}return shouldAutoInvoiceCompletion\(\{[\s\S]{0,900}backfillMintRequired: null,\s*\n\s*isBackfillCompletion: true,\s*\n\s*\}\);/);
      // The decision side still delegates to the narrow typed predicate on
      // the live (posture-null) path…
      expect(source).toMatch(/if \(isBackfillCompletion && typedOneTimeBilling && hasVisitPrice\) \{[\s\S]{0,900}return backfillTypedOneTimeMintRequired\(\{\s*\n\s*isBackfillCompletion,\s*\n\s*typedOneTimeBilling,\s*\n\s*hasVisitPrice,\s*\n\s*visitPerformed,\s*\n\s*isCallback,\s*\n\s*serviceType,\s*\n\s*\}\);/);
      // …and a supplied posture governs EVERY branch, in both directions,
      // directly below the SUPPRESSORS but ABOVE the amount guard (round 9;
      // reordered round 10): invoiceAmount is live-derived from mutable
      // billing fields, and a price cleared after a released required-mint
      // failure must not flip the guard false and finalize the closeout
      // without its required invoice. The governed returns sit between the
      // suppressor block and the amount guard; the first live branch (the
      // scheduler flag) follows the guard.
      expect(source).toMatch(/if \(isBackfillCompletion && backfillMintRequired === true\) return true;\s*\n\s*if \(isBackfillCompletion && backfillMintRequired != null\) return false;\s*\n\s*if \(!\(Number\(invoiceAmount\) > 0\)\) return false;/);
      const amountGuardAt = source.indexOf('if (!(Number(invoiceAmount) > 0)) return false;');
      const governTrueAt = source.indexOf('if (isBackfillCompletion && backfillMintRequired === true) return true;');
      const suppressorGateAt = source.indexOf('|| preMintedInvoice || existingCompletionInvoice) {');
      const ciocBranchAt = source.indexOf('if (createInvoiceOnComplete) return true;');
      expect(suppressorGateAt).toBeGreaterThan(-1);
      expect(governTrueAt).toBeGreaterThan(suppressorGateAt);
      expect(amountGuardAt).toBeGreaterThan(governTrueAt);
      expect(ciocBranchAt).toBeGreaterThan(amountGuardAt);
    });

    test('the required mint\'s MONEY is frozen, restored, and threaded to BOTH the amount guard and the mint (Codex P0, fix round 10)', () => {
      // Resume restores the validated frozen money right beside the posture…
      expect(source).toMatch(/backfillReviewMintRequired = frozenResume\.backfillMintRequired;[\s\S]{0,600}backfillFrozenMintAmount = frozenResume\.backfillMintAmount;\s*\n\s*backfillFrozenMintTaxRate = frozenResume\.backfillMintTaxRate;/);
      // …ONE derivation decides the number both consumers read: the frozen
      // amount on a required resume, the live derivation otherwise…
      expect(source).toMatch(/const mintInvoiceAmount = backfillReviewMintRequired && backfillFrozenMintAmount != null\s*\n\s*\? backfillFrozenMintAmount\s*\n\s*: invoiceAmount;/);
      expect(source).toMatch(/const mintInvoiceTaxRate = backfillReviewMintRequired && backfillFrozenMintTaxRate != null\s*\n\s*\? backfillFrozenMintTaxRate\s*\n\s*: completionInvoiceTaxRate;/);
      // …the decision's amount guard reads it…
      expect(source).toMatch(/const shouldInvoice = shouldAutoInvoiceCompletion\(\{[\s\S]*?invoiceAmount: mintInvoiceAmount,[\s\S]*?\}\);/);
      // …and the mint itself reads the SAME pair — never the live values.
      expect(source).toMatch(/invoice = await InvoiceService\.createFromService\(record\.id, \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*amount: mintInvoiceAmount,\s*\n\s*description: svc\.service_type,\s*\n\s*taxRate: mintInvoiceTaxRate,/);
      expect(source).not.toMatch(/amount: invoiceAmount,/);
      // Frozen-money mints bypass scheduled replay (Codex P0, fix round
      // 11): with the flag on, createFromService rebuilds the line items
      // from the CURRENT scheduled row/add-ons/discounts and the frozen
      // amount degrades to a fallback — a post-commit edit changed the
      // minted total despite the freeze. Backfill mints (all REQUIRED —
      // the posture governs every branch) mint a single line at the frozen
      // amount on BOTH first run and resume; live completions keep replay.
      expect(source).toMatch(/taxRate: mintInvoiceTaxRate,\s*\n(?:\s*\/\/[^\n]*\n)*\s*useScheduledReplay: !isBackfillCompletion,/);
      // No unconditional replay remains anywhere on this route — the other
      // replay callers (billing-recovery bill, card-hold charge) live in
      // files the backfill quiet path never mints through.
      expect((source.match(/useScheduledReplay: true/g) || []).length).toBe(0);
      // A required resume MISSING its frozen amount refuses to mint a
      // recomputed number — the throw sits INSIDE the try, before the mint,
      // so the existing release/503 catch owns the outcome.
      const throwAt = source.indexOf("throw new Error('required backfill mint amount missing from the frozen structured_notes — refusing to mint a recomputed amount');");
      const mintAt = source.indexOf('invoice = await InvoiceService.createFromService(record.id, {');
      const tryAt = source.lastIndexOf('if (shouldInvoice) {', mintAt);
      expect(throwAt).toBeGreaterThan(tryAt);
      expect(mintAt).toBeGreaterThan(throwAt);
      expect(source).toMatch(/if \(backfillReviewMintRequired && resumingCommittedCompletion\s*\n\s*&& backfillFrozenMintAmount == null\) \{/);
    });

    test('resume swaps the live posture for the FROZEN one before any consumer — invoice decision included (fix round 8)', () => {
      // The resume block assigns the frozen posture alongside the frozen
      // mode/duration…
      const resumeAssign = 'backfillReviewMintRequired = frozenResume.backfillMintRequired;';
      const resumeAssignAt = source.indexOf(resumeAssign);
      expect(resumeAssignAt).toBeGreaterThan(source.indexOf('const frozenResume = frozenResumeCompletionState('));
      // …before the invoice decision reads it…
      const invoiceDecisionAt = source.indexOf('const shouldInvoice = shouldAutoInvoiceCompletion({');
      expect(invoiceDecisionAt).toBeGreaterThan(resumeAssignAt);
      // …and the decision call carries the effective posture.
      expect(source).toMatch(/const shouldInvoice = shouldAutoInvoiceCompletion\(\{[\s\S]*?backfillMintRequired: backfillReviewMintRequired,[\s\S]*?\}\);/);
      // No consumer recomputes either predicate from live state past the
      // commit derivation: the narrow typed predicate is called only from
      // the decision helper's own live path (plus its definition), and the
      // broadened commit posture only at the single freeze site (plus its
      // definition).
      expect((source.match(/backfillTypedOneTimeMintRequired\(\{/g) || []).length).toBe(2);
      expect((source.match(/function backfillTypedOneTimeMintRequired\(\{/g) || []).length).toBe(1);
      expect((source.match(/return backfillTypedOneTimeMintRequired\(\{/g) || []).length).toBe(1);
      expect((source.match(/backfillExpectedMintAtCommit\(\{/g) || []).length).toBe(2);
      expect((source.match(/function backfillExpectedMintAtCommit\(\{/g) || []).length).toBe(1);
      expect((source.match(/= backfillExpectedMintAtCommit\(\{/g) || []).length).toBe(1);
    });

    test('required + no invoice row → release for immediate resume + actionable 503; the attempt is never finalized succeeded', () => {
      const catchBlock = source.match(/\} catch \(invErr\) \{([\s\S]*?)\n {6}\}\n {4}\} else if \(preMintedInvoice\) \{/);
      expect(catchBlock).not.toBeNull();
      const body = catchBlock[1];
      // Fail-closed on the ROUTE-LEVEL effective posture (frozen on resume)
      // and only when no invoice row exists (a partial createFromService
      // that DID insert converges on resume via the existing-invoice
      // suppressors).
      const guardAt = body.indexOf("if (backfillReviewMintRequired && !invoice?.id) {");
      expect(guardAt).toBeGreaterThan(-1);
      // The catch never recomputes the predicate from the live profile.
      expect(body).not.toContain('backfillTypedOneTimeMintRequired');
      // Release BEFORE the response, inside the guard — outcome CHECKED.
      const releaseAt = body.indexOf('const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, invErr);');
      expect(releaseAt).toBeGreaterThan(guardAt);
      // Actionable error: names the state (saved but NOT finalized) and the
      // action (retry), with a machine code + the committed record id.
      const returnAt = body.indexOf('return res.status(503).json({');
      expect(returnAt).toBeGreaterThan(releaseAt);
      expect(body).toContain('saved but NOT finalized. Retry the closeout');
      expect(body).toContain("code: 'backfill_invoice_mint_failed',");
      expect(body).toContain('serviceRecordId: record.id,');
      // The return exits the handler before any success finalize — and the
      // non-blocking log is the FALLTHROUGH for every non-required shape,
      // preserved verbatim after the guard.
      const nonBlockingAt = body.indexOf('Auto-invoice failed (non-blocking)');
      expect(nonBlockingAt).toBeGreaterThan(returnAt);
      expect(body).not.toContain('markCompletionAttemptSucceeded');
    });

    test('a no-op release answers with the REAL retry horizon, echoed from the stale-window constant (Codex P1, fix round 8)', () => {
      const catchBlock = source.match(/\} catch \(invErr\) \{([\s\S]*?)\n {6}\}\n {4}\} else if \(preMintedInvoice\) \{/);
      const body = catchBlock[1];
      // The release outcome branches the response: released → "retry now";
      // not released → the closeout stays claimed until the stale window
      // reclaims it, so the copy and a machine-readable retryAfterMs say so
      // — both derived from the exported constant, never a literal.
      expect(body).toContain('if (!released) {');
      expect(body).toMatch(/error: released\s*\n\s*\? 'The review invoice could not be created — the closeout is saved but NOT finalized\. Retry the closeout to mint the invoice\.'\s*\n\s*: `The review invoice could not be created — the closeout is saved but NOT finalized\. It will become retryable within about \$\{Math\.ceil\(CompletionAttempts\.STALE_SIDE_EFFECTS_MS \/ 60000\)\} minutes — retry the closeout then\.`/);
      expect(body).toContain('...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),');
      // Loud log on the no-op path, naming the horizon too.
      expect(body).toMatch(/if \(!released\) \{[\s\S]{0,900}logger\.error\(`\[dispatch\] release-for-resume did NOT release attempt \$\{completionAttempt\?\.id\}/);
      // No hardcoded minutes anywhere in the catch — the echo follows the
      // constant if the window ever changes.
      expect(body).not.toMatch(/10 minutes|ten minutes/i);
      // And the constant is really exported for the route to read.
      const attempts = require('../services/completion-attempts');
      expect(Number.isInteger(attempts.STALE_SIDE_EFFECTS_MS)).toBe(true);
      expect(attempts.STALE_SIDE_EFFECTS_MS).toBeGreaterThan(0);
    });

    test('success finalizes exist only at the two legitimate sites — none reachable from the fail-closed return', () => {
      // The incomplete-visit early return and the end-of-route finalize.
      expect((source.match(/markCompletionAttemptSucceeded\(completionAttempt/g) || []).length).toBe(2);
    });

    test('the release helper really parks the attempt in the immediately-claimable state', () => {
      const attemptsSource = fs.readFileSync(path.join(__dirname, '../services/completion-attempts.js'), 'utf8');
      expect(attemptsSource).toMatch(/\.where\(\{ id: attempt\.id, status: 'side_effects_running' \}\)\s*\n\s*\.update\(\{\s*\n\s*status: 'side_effects_pending',/);
      // claimSideEffectsRun applies the stale-window clause ONLY to running
      // rows — a pending row claims unconditionally (behavioral proof above).
      expect(attemptsSource).toMatch(/if \(row\.status === 'side_effects_running'\) \{\s*\n\s*query = query\.andWhere\('updated_at', '<', staleCutoff\);\s*\n\s*\}/);
    });
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
    // And the resume path recovers the frozen flag — through the shared
    // helper (behavioral coverage above), gated to the resume claim, with
    // BOTH mode and duration assigned from its answer (fix round 5).
    expect(source).toMatch(/if \(resumingCommittedCompletion\) \{\s*\n\s*const frozenResume = frozenResumeCompletionState\(\s*\n\s*parseJsonObject\(record\.structured_notes\),\s*\n\s*\{ requestBackfill: isBackfillCompletion \},\s*\n\s*\);/);
    expect(source).toMatch(/isBackfillCompletion = frozenResume\.isBackfillCompletion;\s*\n\s*effectiveTimeOnSite = frozenResume\.effectiveTimeOnSite;\s*\n\s*\}/);
  });

  test('a disagreeing resume body is logged, and a downgraded (committed-normal) resume restores the LOUD posture (fix round 5)', () => {
    // The mismatch log names both sides…
    expect(source).toMatch(/frozenResume\.bodyDisagreed\) \{\s*\n\s*logger\.warn\(`\[completion\] resume of service \$\{svc\.id\}: retry body says backfill=\$\{isBackfillCompletion\} but the committed record froze backfill=\$\{frozenResume\.isBackfillCompletion\} — the frozen mode wins`\);/);
    // …and the stray body flag's intake suppression is undone from the SAME
    // posture source the intake used, only when the frozen record says the
    // completion was normal.
    expect(source).toMatch(/if \(!frozenResume\.isBackfillCompletion\) \{[\s\S]{0,700}suppressTypedCustomerComms = deliveryPosture\.suppressCustomerComms;\s*\n\s*effectiveSendCompletionSms = sendCompletionSms && !suppressTypedCustomerComms;\s*\n\s*\}/);
    // Ordering: the restore happens before the frozen-delivery re-derivation
    // and the backfill re-force — i.e. before ANY read of the comms flags —
    // so the two later corrections still own the final posture. (Anchor on
    // the downgrade guard: it exists only inside the resume block.)
    const restoreAt = source.indexOf('if (!frozenResume.isBackfillCompletion) {');
    const frozenDeliveryAt = source.indexOf('const frozenDelivery = parseJsonObject(record.structured_notes)?.typedReportDelivery;');
    expect(restoreAt).toBeGreaterThan(-1);
    expect(frozenDeliveryAt).toBeGreaterThan(restoreAt);
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
    // …with the backdated first-visit instant so the public card's "First
    // visit" date shows the day the visit happened, not office-entry day.
    expect(source).toMatch(/firstVisitAt: isBackfillCompletion \? toETNoonServiceDate\(record\.service_date\) : null,/);
    // …and the service honors it: the email leg is gated, everything before
    // it (card row / promoter enroll / short link) still runs, and both
    // first_visit_completed_at stamp sites use the caller's instant.
    const cardSource = fs.readFileSync(path.join(__dirname, '../services/customer-card.js'), 'utf8');
    expect(cardSource).toMatch(/async function ensureCardForCompletion\(\{ customerId, serviceRecordId = null, scheduledServiceId = null, suppressIssuedEmail = false, firstVisitAt = null \}\)/);
    expect(cardSource).toMatch(/if \(!suppressIssuedEmail\) \{\s*\n\s*await maybeSendCardEmail\(card, customer\);\s*\n\s*\}/);
    expect((cardSource.match(/first_visit_completed_at: firstVisitStamp\(\)/g) || []).length).toBe(1);
    expect(cardSource).toMatch(/first_visit_completed_at: stamp,/);
    expect(cardSource).not.toMatch(/first_visit_completed_at: new Date\(\)/);
    // Backward correction: a backfilled OLDER visit closed out after a later
    // completion minted the card must pull the stamp back to the true first
    // day — earlier caller instant wins, an existing stamp never moves
    // forward, and absent/invalid firstVisitAt never rewrites an existing
    // stamp with wall-clock now.
    expect(cardSource).toMatch(/const shouldStamp = !existing\s*\n\s*\|\| \(firstVisitAt instanceof Date && !Number\.isNaN\(firstVisitAt\.getTime\(\)\) && firstVisitAt < existing\);/);
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
    const rederivation = source.indexOf('const frozenResume = frozenResumeCompletionState(');
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
    expect(source).toMatch(/const lifecycleUpdates = buildCompletionLifecycleUpdates\(svc, completionLifecycleAt, \{ elapsed: effectiveTimeOnSite \}\);[\s\S]{0,600}if \(isBackfillCompletion\) applyBackfillDurationPolicy\(lifecycleUpdates, effectiveTimeOnSite, svc\);/);
  });

  test('the kept lifecycle stamps are built from the backdated end instant, and the wall clock survives only as policy input (fix round 4)', () => {
    // Under backfill the builder's `at` is backfillCompletionEndInstant's
    // service-day instant — so every end stamp the policy KEEPS already
    // carries the visit's day. For the unknown-end shape the helper returns
    // null and the wall clock flows in instead, but the duration policy
    // strips those rows' end stamps entirely (behavioral coverage above), so
    // no wall-clock end instant can reach the row.
    expect(source).toMatch(/const backfillEndedAt = isBackfillCompletion\s*\n\s*\? backfillCompletionEndInstant\(completionServiceDate, effectiveTimeOnSite, svc\)\s*\n\s*: null;\s*\n\s*const completionLifecycleAt = backfillEndedAt \|\| completionEndedAt;/);
  });

  test('an empty scheduled_services timing update is skipped — the blank-duration checked-in closeout must complete (fix round 4)', () => {
    // For a backfilled real-stale-check-in row with a blank typed duration
    // the policy strips EVERY key the helper produced; spreading that into
    // scheduledServiceUpdate and calling knex .update({}) throws (behavioral
    // proof below), which failed the closeout for exactly the shape the UI
    // allows. The route guards the call; transitionJobStatus immediately
    // after owns the status flip + updated_at bump on the same row, so
    // nothing downstream loses its row-touch.
    expect(source).toMatch(/if \(Object\.keys\(scheduledServiceUpdate\)\.length\) \{\s*\n\s*await trx\('scheduled_services'\)\.where\(\{ id: svc\.id \}\)\.update\(scheduledServiceUpdate\);\s*\n\s*\}/);
    // Ordering: the guarded update sits before the canonical status flip.
    const guardAt = source.indexOf('if (Object.keys(scheduledServiceUpdate).length) {');
    const flipAt = source.indexOf("// 5. Status flip via the canonical sole-writer.");
    expect(guardAt).toBeGreaterThan(-1);
    expect(flipAt).toBeGreaterThan(guardAt);
    // And the sole-writer really does bump updated_at on the flip.
    const jobStatusSource = fs.readFileSync(path.join(__dirname, '../services/job-status.js'), 'utf8');
    expect(jobStatusSource).toMatch(/\.update\(\{ status: toStatus, updated_at: t\.fn\.now\(\) \}\)/);
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
    // `let` (fix round 5): the crash-resume block overwrites it with the
    // FROZEN structured_notes stamp — the only later assignment (contract
    // above) — so a retry's auto-elapsed timer can never reach a consumer.
    expect(source).toMatch(/let effectiveTimeOnSite = isBackfillCompletion\s*\n\s*\? backfillTimeOnSiteMinutes\(timeOnSite\)\s*\n\s*: timeOnSite;/);
    // A rejected value logs a note — the closeout still succeeds (no 400
    // path exists between the sanitation and the log).
    expect(source).toMatch(/if \(isBackfillCompletion && effectiveTimeOnSite == null && timeOnSite != null && timeOnSite !== ''\) \{\s*\n\s*logger\.warn\([\s\S]{0,300}recorded as unknown/);
    // The structured_notes stamp — the report's on-site metric reads it via
    // computeOnSiteMin — carries the sanitized value, never the raw span.
    expect(source).toMatch(/timeOnSite: effectiveTimeOnSite \|\| null,/);
    // And no other consumer still reads the raw body value: `timeOnSite`
    // appears only in the destructure, the sanitation, and the helpers'
    // definitions/comments — never as a bare argument past the intake.
    const afterIntake = source.slice(source.indexOf('let effectiveTimeOnSite = isBackfillCompletion'));
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
    // the first call failed) — must flag the span untrusted AND carry the
    // backdated completed_at stamp (fix round 4).
    const flaggedCalls = source.match(
      /trackTransitions\.markComplete\(svc\.id, \{\s*\n\s*actorType: 'admin',\s*\n\s*actorId: req\.technicianId,\s*\n(?:\s*\/\/[^\n]*\n)*\s*untrustedLifecycleSpan: isBackfillCompletion,\s*\n\s*completedAt: backfillTrackerCompletedAt,\s*\n\s*\}\)/g,
    ) || [];
    expect(flaggedCalls.length).toBe(2);
    // Exactly these two sites exist on the backfill-capable route; the third
    // markComplete in this file belongs to PUT /:id/status, where backfill
    // is unreachable (contract below) and the default rebuild is correct.
    expect((source.match(/trackTransitions\.markComplete\(/g) || []).length).toBe(3);
    // The crash-resume re-derivation sits BEFORE the first flagged call, so
    // a flagless resumed retry that still owes the tracker flip reads the
    // healed flag, not the body's stale `false`.
    const rederivation = source.indexOf('const frozenResume = frozenResumeCompletionState(');
    const firstFlagged = source.indexOf('untrustedLifecycleSpan: isBackfillCompletion,');
    expect(rederivation).toBeGreaterThan(-1);
    expect(firstFlagged).toBeGreaterThan(rederivation);
    // And the tracker honors the flag: the lifecycle rebuild is skipped
    // wholesale under it (track_state/updated_at bookkeeping still lands;
    // behavioral coverage in track-transitions.test.js).
    const trackerSource = fs.readFileSync(path.join(__dirname, '../services/track-transitions.js'), 'utf8');
    expect(trackerSource).toMatch(/\.\.\.\(opts\.untrustedLifecycleSpan \? \{\} : buildCompletionLifecycleUpdates\(svc, now\)\),/);
  });

  test('tracker completed_at rides the same backdated end-instant rule — an instant for EVERY shape since fix round 9', () => {
    // The route derives the stamp ONCE, from the same helper the
    // transaction used — svc's row-backed starts + scheduled_date + the
    // typed duration. No body fallback chain anymore (fix round 5): on
    // resume effectiveTimeOnSite already IS the frozen structured_notes
    // value, so the stamp reads the single sanitized source directly.
    // (Round 7's NULL for the unknown-end shape is gone — the helper now
    // returns ET noon of the service day there too, so Billing Recovery's
    // completed_at window can see the visit; instant coverage above.)
    expect(source).toMatch(/const backfillTrackerCompletedAt = isBackfillCompletion\s*\n\s*\? backfillCompletionEndInstant\(\s*\n\s*serviceDateOnly\(svc\.scheduled_date\),\s*\n\s*effectiveTimeOnSite,\s*\n\s*svc,\s*\n\s*\)\s*\n\s*: null;/);
    // Derived AFTER the crash-resume re-derivation (it reads the healed
    // flag AND the frozen duration), BEFORE the first markComplete that
    // consumes it.
    const rederivation = source.indexOf('const frozenResume = frozenResumeCompletionState(');
    const stampAt = source.indexOf('const backfillTrackerCompletedAt = isBackfillCompletion');
    const firstCall = source.indexOf('completedAt: backfillTrackerCompletedAt,');
    expect(stampAt).toBeGreaterThan(rederivation);
    expect(firstCall).toBeGreaterThan(stampAt);
    // And the tracker enforces the contract: under the flag completed_at is
    // written only from the caller's instant (finiteDate-validated); absent
    // → the column is omitted, never a wall-clock fallback.
    const trackerSource = fs.readFileSync(path.join(__dirname, '../services/track-transitions.js'), 'utf8');
    expect(trackerSource).toMatch(/const completedAtStamp = opts\.untrustedLifecycleSpan \? finiteDate\(opts\.completedAt\) : now;/);
    expect(trackerSource).toMatch(/\.\.\.\(completedAtStamp \? \{ completed_at: completedAtStamp \} : \{\}\),/);
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
    const rederivation = source.indexOf('const frozenResume = frozenResumeCompletionState(');
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
      // payer-statement accrual skip + reviewer breadcrumb (fix round 5)
      'skipAccrual: isBackfillCompletion,',
      'payer-statement accrual SKIPPED',
      // job-costing labor guard
      'untrustedLifecycleSpan: true',
      // required-mint fail-closed guard (fix rounds 7-8) — reads the
      // route-level posture the resume block swaps to the FROZEN value, so a
      // flagless resumed retry of a failed required mint can neither
      // evaluate as non-required nor finalize uninvoiced
      'if (backfillReviewMintRequired && !invoice?.id) {',
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
    expect(source).toMatch(/const recordTimingFields = buildServiceRecordCompletionTimingFields\(\{\s*\n\s*scheduledService: svc,\s*\n\s*lifecycleUpdates,\s*\n(?:\s*\/\/[^\n]*\n)*\s*completedAt: completionLifecycleAt,\s*\n\s*serviceRecordCols,\s*\n\s*\}\);[\s\S]{0,500}if \(isBackfillCompletion\) applyBackfillRecordTimingPolicy\(recordTimingFields, effectiveTimeOnSite, svc\);\s*\n\s*Object\.assign\(recordInsert, recordTimingFields\);/);
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
    expect(source).toMatch(/invoice = await InvoiceService\.createFromService\(record\.id, \{[\s\S]{0,3600}skipDepositCredit: isBackfillCompletion,/);
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

  test('the backfill mint opts out of payer-statement accrual and leaves the reviewer a breadcrumb (fix round 5)', () => {
    // The route passes BOTH opt-outs on the completion mint — the same
    // options object, so the accrual skip rides the deposit skip's gate.
    expect(source).toMatch(/invoice = await InvoiceService\.createFromService\(record\.id, \{[\s\S]{0,3600}skipDepositCredit: isBackfillCompletion,[\s\S]{0,900}skipAccrual: isBackfillCompletion,\s*\n\s*\}\);/);
    // …and logs the skipped accrual for the reviewer — only when an accrual
    // WOULD have happened (payer-billed + gate + NET terms) — including the
    // operator's re-attach path (attachment exists only at create, so:
    // void + re-create to consolidate, or send individually to the AP).
    expect(source).toMatch(/if \(isBackfillCompletion && invoice\?\.payer_id && !invoice\.payer_statement_id\) \{[\s\S]{0,400}isEnabled\('payerStatements'\)[\s\S]{0,400}\['net15', 'net30'\]\.includes\(payerRow\?\.payment_terms\)[\s\S]{0,600}payer-statement accrual SKIPPED[\s\S]{0,400}void \+ re-create/);

    // createFromService threads the option through to create() untouched.
    const invoiceSource = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
    expect(invoiceSource).toMatch(/skipAccrual = false,\s*\n\s*\},\s*\n\s*\) \{/);
    expect(invoiceSource).toMatch(/trustedStoredDiscountSources: scheduledInvoice\s*\n\s*\? \["scheduled_service"\]\s*\n\s*: \[\],\s*\n\s*skipAccrual,\s*\n\s*\};/);
    // And create() honors it at BOTH accrual sites: the NET-terms preflight
    // transaction wrap and the statement get-or-create/attach itself.
    expect(invoiceSource).toMatch(/if \(!skipAccrual && database === db && require\("\.\.\/config\/feature-gates"\)\.isEnabled\("payerStatements"\)\) \{/);
    expect(invoiceSource).toMatch(/if \(!skipAccrual\s*\n\s*&& resolvedPayerId\s*\n\s*&& \['net15', 'net30'\]\.includes\(resolvedPaymentTerms\)/);
    // Attachment is create-only — payer_statement_id is stamped exclusively
    // from the accrual result on the insert, so skipping accrual IS staying
    // off every statement (nothing later attaches an existing invoice).
    expect(invoiceSource).toMatch(/\.\.\.\(accruedStatementId \? \{ payer_statement_id: accruedStatementId \} : \{\}\),/);
    // Behavioral coverage (attach skipped, rollup untouched, default
    // unchanged) lives in invoice-deposit-credit-tax.test.js.
  });
});

describe('backfill keeps the pest recap quiet (Codex P2, PR #2897 fix round 6)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

  test('completion never enqueues the recap render under backfill — the pending row feeds an operator-reachable Approve & send card', () => {
    // The PEST_RECAP rail branches on isBackfillCompletion FIRST: quiet
    // closeouts log the skip…
    expect(source).toMatch(/if \(process\.env\.PEST_RECAP === 'true' && typedDeliveryMode === 'auto_send'[^\n]*record\.scheduled_service_id\) \{\s*\n\s*if \(isBackfillCompletion\) \{\s*\n\s*logger\.info\(`\[dispatch\] backfill completion: pest recap render NOT enqueued for visit \$\{svc\.id\}/);
    // …and the enqueue lives only in the else branch.
    expect(source).toMatch(/\} else \{\s*\n\s*try \{\s*\n\s*const \{ enqueueRecap \} = require\('\.\.\/services\/service-report\/recap-pipeline'\);[\s\S]{0,400}await enqueueRecap\(record\.scheduled_service_id, \{ force: true \}\);/);
    // The completion path has exactly one enqueue call site — no ungated twin.
    expect((source.match(/enqueueRecap\(record\.scheduled_service_id/g) || []).length).toBe(1);
  });

  // Defense in depth: even a recap row that existed BEFORE the quiet closeout
  // (pre-completion Generate) and got approved days later must not text the
  // customer about "today's visit". sendRecap reads the durable
  // structured_notes.backfill marker off the service record and refuses.
  function recapKnexMock({ recap, serviceRecord }) {
    const updates = [];
    const knex = jest.fn((table) => ({
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      first: jest.fn(async () => (table === 'service_recaps' ? recap : serviceRecord)),
      update: jest.fn((patch) => {
        updates.push({ table, patch });
        return Promise.resolve(1);
      }),
    }));
    knex.fn = { now: () => new Date('2026-07-19T16:00:00Z') };
    return { knex, updates };
  }

  const APPROVED_RECAP = { id: 'recap-1', status: 'approved', sent_at: null, send_attempt_at: null };
  const SERVICE_ROW = {
    id: 'rec-1',
    customer_id: 'cust-1',
    report_view_token: 'tok-1',
    first_name: 'Pat',
    phone: '+19415551234',
  };

  beforeEach(() => {
    sendCustomerMessage.mockReset();
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  test('sendRecap refuses a backfilled record — no claim, no SMS, reason names the quiet closeout', async () => {
    const { knex, updates } = recapKnexMock({
      recap: APPROVED_RECAP,
      serviceRecord: {
        ...SERVICE_ROW,
        structured_notes: JSON.stringify({ backfill: true, requestReview: false }),
      },
    });
    const result = await sendRecap('svc-backfilled', { knex });
    expect(result).toEqual({ ok: false, reason: 'backfill_quiet_closeout' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Refused BEFORE the send_attempt_at claim — the row stays untouched.
    expect(updates).toEqual([]);
  });

  test('the marker is the differentiator: the same approved recap on a normal record still sends', async () => {
    const { knex, updates } = recapKnexMock({
      recap: APPROVED_RECAP,
      serviceRecord: {
        ...SERVICE_ROW,
        structured_notes: JSON.stringify({ requestReview: true }),
      },
    });
    const result = await sendRecap('svc-normal', { knex });
    expect(result.ok).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // Claim then sent_at stamp — the quiet path above produced neither.
    expect(updates.length).toBe(2);
    expect(updates[1].patch).toHaveProperty('sent_at');
  });

  test('an object-shaped structured_notes marker (pre-serialization) refuses too', async () => {
    const { knex } = recapKnexMock({
      recap: APPROVED_RECAP,
      serviceRecord: { ...SERVICE_ROW, structured_notes: { backfill: true } },
    });
    const result = await sendRecap('svc-backfilled-obj', { knex });
    expect(result).toEqual({ ok: false, reason: 'backfill_quiet_closeout' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
