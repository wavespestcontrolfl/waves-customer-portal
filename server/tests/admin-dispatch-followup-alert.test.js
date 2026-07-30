/**
 * Typed-completion follow-up obligations (parity with the pre-cutover
 * project flow). ALERT-policy profiles (bed bug, cockroach two-treatment,
 * knockdowns) promise a durable ops exception when a completed visit owes a
 * follow-up; the typed cutover left the suggestion as a transient
 * success-overlay CTA — "Done" dropped the owed follow-up silently
 * (reproduced live 2026-07-30 on a bed_bug_treatment completion). Codex
 * rounds 1–2 on PR #3091 then found the leak shapes of the bolt-on fix:
 * crash-resume (typedFindings null), idempotent /schedule-followup retries,
 * call-pipeline pre-booked children, cancelled children, and a post-commit
 * best-effort write that a finalized attempt could never retry.
 *
 * The consolidation: services/typed-followup-obligation.js owns the ONE
 * override chain + park/re-park helpers; /complete parks INSIDE the durable
 * completion transaction; /schedule-followup resolves on every booked
 * answer; the shared status writer re-parks when the booked child is
 * cancelled. Behavioral tests cover the pure verdict chain; the giant
 * routes are pinned with source contracts in the house style of
 * admin-dispatch-backfill-completion.test.js.
 */
const fs = require('fs');
const path = require('path');
const {
  typedFollowupVerdict,
  TWO_TREATMENT_PACKAGE_KEYS,
  KNOCKDOWN_FOLLOWUP_WINDOW_DAYS,
} = require('../services/typed-followup-obligation');

const dispatchSource = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
const jobStatusSource = fs.readFileSync(path.join(__dirname, '../services/job-status.js'), 'utf8');

const BED_BUG_PROFILE = {
  serviceKey: 'bed_bug_treatment',
  findingsType: 'bed_bug',
  followupPolicy: 'alert',
  defaultFollowupDays: 14,
};
const VISIT = { id: 'svc-1', scheduled_date: '2026-07-30', followup_included: false };

describe('typedFollowupVerdict — the shared override chain', () => {
  test('bed bug ALERT profile: visit 1 owes a follow-up at the profile interval', () => {
    const v = typedFollowupVerdict({
      scheduledService: VISIT,
      profile: BED_BUG_PROFILE,
      findingsType: 'bed_bug',
      values: { evidence_level: 'Moderate' },
    });
    expect(v.required).toBe(true);
    expect(v.days).toBe(14);
    expect(v.suggestedDate).toBe('2026-08-13');
    expect(v.alertType).toBe('follow_up_needed');
  });

  test('two-treatment packages stop at visit 2: the included follow-up owes nothing', () => {
    expect(TWO_TREATMENT_PACKAGE_KEYS.has('bed_bug_treatment')).toBe(true);
    expect(TWO_TREATMENT_PACKAGE_KEYS.has('cockroach_control')).toBe(true);
    const v = typedFollowupVerdict({
      scheduledService: { ...VISIT, followup_included: true },
      profile: BED_BUG_PROFILE,
      findingsType: 'bed_bug',
      values: {},
    });
    expect(v.required).toBe(false);
    expect(v.reason).toBe('included_followup_visit');
  });

  test('cockroach German-only rule, with the cockroach_control package exemption', () => {
    const roachProfile = { serviceKey: 'german_roach_knockdown', findingsType: 'cockroach', followupPolicy: 'alert', defaultFollowupDays: 14 };
    const nonGerman = typedFollowupVerdict({
      scheduledService: VISIT, profile: roachProfile, findingsType: 'cockroach', values: { species: 'American' },
    });
    expect(nonGerman.required).toBe(false);
    expect(nonGerman.reason).toBe('species_not_german');
    // cockroach_control sells the second visit regardless of species.
    const controlProfile = { ...roachProfile, serviceKey: 'cockroach_control' };
    const control = typedFollowupVerdict({
      scheduledService: VISIT, profile: controlProfile, findingsType: 'cockroach', values: { species: 'American' },
    });
    expect(control.required).toBe(true);
  });

  test("German knockdown: the tech's explicit No wins; the selected window drives the date", () => {
    const profile = { serviceKey: 'german_roach_knockdown', findingsType: 'german_roach_knockdown', followupPolicy: 'alert', defaultFollowupDays: 14 };
    const declined = typedFollowupVerdict({
      scheduledService: VISIT, profile, findingsType: 'german_roach_knockdown', values: { followup_required: 'No' },
    });
    expect(declined.required).toBe(false);
    expect(declined.reason).toBe('tech_marked_not_required');
    expect(KNOCKDOWN_FOLLOWUP_WINDOW_DAYS['2–3 weeks']).toBe(21);
    const window = typedFollowupVerdict({
      scheduledService: VISIT, profile, findingsType: 'german_roach_knockdown', values: { followup_required: 'Yes', followup_window: '2–3 weeks' },
    });
    expect(window.required).toBe(true);
    expect(window.days).toBe(21);
    expect(window.suggestedDate).toBe('2026-08-20');
  });

  test("palmetto knockdown: a checklist Yes earns the follow-up the none-policy profile withholds", () => {
    const profile = { serviceKey: 'palmetto_roach_knockdown', findingsType: 'palmetto_roach_knockdown', followupPolicy: 'none', defaultFollowupDays: null };
    const noAnswer = typedFollowupVerdict({
      scheduledService: VISIT, profile, findingsType: 'palmetto_roach_knockdown', values: {},
    });
    expect(noAnswer.required).toBe(false);
    const yes = typedFollowupVerdict({
      scheduledService: VISIT, profile, findingsType: 'palmetto_roach_knockdown', values: { followup_needed: 'Yes' },
    });
    expect(yes.required).toBe(true);
    expect(yes.days).toBe(14);
    expect(yes.reason).toBe('tech_marked_needed');
  });
});

describe('/complete parks the alert atomically (source contracts)', () => {
  test('verdict computed BEFORE the durable trx, on the proceed path only', () => {
    const verdictIdx = dispatchSource.indexOf('followupSuggestion = typedFollowupVerdict({');
    const recordDecl = dispatchSource.indexOf('let record;');
    expect(verdictIdx).toBeGreaterThan(-1);
    expect(verdictIdx).toBeLessThan(recordDecl);
    const guard = dispatchSource.slice(dispatchSource.lastIndexOf('if (', verdictIdx), verdictIdx);
    expect(guard).toContain('typedFindingsType && typedFindings && !isIncompleteVisit');
    expect(guard).toContain("claim.action === 'proceed'");
  });

  test('park runs INSIDE the completion trx, right after the service_record insert', () => {
    const insertIdx = dispatchSource.indexOf("[record] = await trx('service_records').insert(recordInsert)");
    const parkIdx = dispatchSource.indexOf('await parkFollowupAlert({', insertIdx);
    const photosIdx = dispatchSource.indexOf('await promoteStagedServicePhotos({', insertIdx);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(parkIdx).toBeGreaterThan(insertIdx);
    expect(parkIdx).toBeLessThan(photosIdx);
    const parkBlock = dispatchSource.slice(parkIdx, parkIdx + 600);
    expect(parkBlock).toContain('trx,');
    expect(parkBlock).toContain("source: 'typed_completion'");
    expect(parkBlock).toContain('serviceRecordId: record.id');
  });

  test('crash-resume re-derives from the committed snapshot for the response + deploy-boundary re-park, best-effort', () => {
    const resumeIdx = dispatchSource.indexOf('await typedFollowupObligationForCompletedSource({');
    expect(resumeIdx).toBeGreaterThan(-1);
    const guard = dispatchSource.slice(dispatchSource.lastIndexOf('if (resumingCommittedCompletion', resumeIdx), resumeIdx);
    expect(guard).toContain('typedFindingsType && !isIncompleteVisit && !followupSuggestion');
    const block = dispatchSource.slice(resumeIdx, resumeIdx + 1400);
    expect(block).toContain('resumed follow-up derivation failed');
    expect(block).toContain('logger.warn');
  });
});

describe('/schedule-followup (source contracts)', () => {
  test('the CTA books the FROZEN completion verdict; legacy records fall back to the shared chain', () => {
    const routeIdx = dispatchSource.indexOf("router.post('/:serviceId/schedule-followup'");
    const routeTail = dispatchSource.slice(routeIdx);
    const frozenIdx = routeTail.indexOf('const frozenCtaVerdict = parseJsonObject(sourceRecord?.structured_notes)?.typedFollowupVerdict;');
    expect(frozenIdx).toBeGreaterThan(-1);
    // Snapshot gate still fails closed on missing/mismatched snapshots.
    expect(routeTail.slice(0, frozenIdx)).toContain('followup_no_typed_completion');
    const verdictBlock = routeTail.slice(frozenIdx, frozenIdx + 900);
    expect(verdictBlock).toContain("typeof frozenCtaVerdict.required === 'boolean'");
    expect(verdictBlock).toContain(': typedFollowupVerdict({');
    expect(verdictBlock).toContain('values: snapshot?.values || {}');
    expect(verdictBlock).toContain('followup_not_required');
  });

  test('EVERY booked-follow-up answer resolves the parked alert: fresh insert, idempotent retry, 23505 race winner', () => {
    const routeIdx = dispatchSource.indexOf("router.post('/:serviceId/schedule-followup'");
    const routeTail = dispatchSource.slice(routeIdx);
    const helperIdx = routeTail.indexOf('const resolveOpenFollowupAlerts = async () => {');
    expect(helperIdx).toBeGreaterThan(-1);
    const helper = routeTail.slice(helperIdx, routeTail.indexOf('};', helperIdx));
    expect(helper).toContain("{ type: 'follow_up_needed', job_id: svc.id }");
    expect(helper).toContain(".whereNull('resolved_at')");
    expect(helper).toContain('resolveAlert({ id: alert.id, resolvedBy: req.technicianId || null })');
    expect(helper).toContain('logger.warn');
    const calls = routeTail.split('await resolveOpenFollowupAlerts();').length - 1;
    expect(calls).toBe(3);
    const existingIdx = routeTail.indexOf('if (existing) {');
    const existingBlock = routeTail.slice(existingIdx, routeTail.indexOf('}', routeTail.indexOf('alreadyScheduled: true', existingIdx)));
    expect(existingBlock).toContain('await resolveOpenFollowupAlerts();');
    const winnerIdx = routeTail.indexOf('if (winner) {');
    const winnerBlock = routeTail.slice(winnerIdx, routeTail.indexOf('});', winnerIdx));
    expect(winnerBlock).toContain('await resolveOpenFollowupAlerts();');
    const bookedIdx = routeTail.indexOf('follow-up ${appointment.id} booked');
    expect(routeTail.slice(bookedIdx, bookedIdx + 300)).toContain('await resolveOpenFollowupAlerts();');
  });
});

describe('shared status writer re-parks on child cancellation (source contracts)', () => {
  test('hook is guarded to cancelled/skipped/no_show, lazy-required, and runs POST-COMMIT on both trx paths', () => {
    const hookDef = jobStatusSource.indexOf('function maybeReparkFollowupObligation()');
    expect(hookDef).toBeGreaterThan(-1);
    const hookBody = jobStatusSource.slice(hookDef, hookDef + 1600);
    expect(hookBody).toContain("['cancelled', 'skipped', 'no_show'].includes(String(toStatus || ''))");
    expect(hookBody).toContain("require('./typed-followup-obligation')");
    expect(hookBody).toContain('handleFollowupChildCancellation({ jobId, toStatus })');
    // POST-COMMIT on both paths: an error inside a Postgres trx would abort
    // every later statement, so the hook must never run inside doWrites.
    const doWrites = jobStatusSource.slice(
      jobStatusSource.indexOf('async function doWrites'),
      jobStatusSource.indexOf('function emitBoth'),
    );
    expect(doWrites).not.toContain('maybeReparkFollowupObligation');
    const callerTrxPath = jobStatusSource.indexOf('maybeReparkFollowupObligation();', jobStatusSource.indexOf('trx.executionPromise'));
    expect(callerTrxPath).toBeGreaterThan(-1);
    const ownTrxPath = jobStatusSource.indexOf('maybeReparkFollowupObligation();', jobStatusSource.indexOf('// trx committed by here.', callerTrxPath - 4000) > -1 ? callerTrxPath + 10 : callerTrxPath);
    expect(ownTrxPath).toBeGreaterThan(callerTrxPath);
  });

  test('the cancellation handler re-parks only when the obligation is uncovered', () => {
    const moduleSource = fs.readFileSync(path.join(__dirname, '../services/typed-followup-obligation.js'), 'utf8');
    const handler = moduleSource.slice(moduleSource.indexOf('async function handleFollowupChildCancellation'));
    // A replacement child already on the schedule keeps the alert away…
    expect(handler).toContain("whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)");
    expect(handler).toContain("skipped: 'replacement_live'");
    // …and the verdict is re-derived from the committed snapshot, not assumed.
    expect(handler).toContain('typedFollowupObligationForCompletedSource');
    expect(handler).toContain("source: 'followup_cancelled'");
  });

  test('parkFollowupAlert guards: live-child skip before the cross-source dedupe pre-check', () => {
    const moduleSource = fs.readFileSync(path.join(__dirname, '../services/typed-followup-obligation.js'), 'utf8');
    const park = moduleSource.slice(moduleSource.indexOf('async function parkFollowupAlert'));
    // Live-child skip (call pipeline pre-books visit 2) BEFORE the alert query.
    const childIdx = park.indexOf("followup_source_service_id: scheduledService.id");
    const dedupeIdx = park.indexOf("{ type: 'follow_up_needed', job_id: scheduledService.id }");
    expect(childIdx).toBeGreaterThan(-1);
    expect(dedupeIdx).toBeGreaterThan(childIdx);
    expect(park).toContain(".whereNull('resolved_at')");
    expect(park).toContain("skipped: 'followup_already_booked'");
    expect(park).toContain("skipped: 'already_parked'");
  });
});

describe('codex r3 — double-card, no_show coverage, storage-level dedupe, IB writer (source contracts)', () => {
  const moduleSource = fs.readFileSync(path.join(__dirname, '../services/typed-followup-obligation.js'), 'utf8');

  test('visit-outcome follow_up_needed writer defers to the typed park (no double card)', () => {
    const idx = dispatchSource.indexOf("if (visitOutcome === 'follow_up_needed' && !followupSuggestion?.required) {");
    expect(idx).toBeGreaterThan(-1);
    // The old unconditional form must be gone.
    expect(dispatchSource).not.toContain("if (visitOutcome === 'follow_up_needed') {\n          await createAlert");
    const parkIdx = dispatchSource.indexOf('await parkFollowupAlert({');
    expect(parkIdx).toBeGreaterThan(-1);
    expect(parkIdx).toBeLessThan(idx);
  });

  test('no_show children never cover the obligation — one shared constant everywhere', () => {
    expect(require('../services/typed-followup-obligation').FOLLOWUP_CHILD_INACTIVE_STATUSES)
      .toEqual(['cancelled', 'skipped', 'no_show']);
    // Module: park live-child check + cancellation handler + otherLive all
    // use the constant; no stranded literal pair remains.
    expect(moduleSource).not.toContain("whereNotIn('status', ['cancelled', 'skipped'])");
    // Route: schedule-followup existing + 23505 winner lookups use it.
    const routeTail = dispatchSource.slice(dispatchSource.indexOf("router.post('/:serviceId/schedule-followup'"));
    expect(routeTail.split("whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)").length - 1).toBe(2);
    // Shared writer hook fires on no_show too.
    expect(jobStatusSource).toContain("['cancelled', 'skipped', 'no_show'].includes(String(toStatus || ''))");
    // Handler trigger uses the constant.
    expect(moduleSource).toContain('FOLLOWUP_CHILD_INACTIVE_STATUSES.includes(String(toStatus || ' + "''))");
  });

  test('storage-level dedupe: migration covers both typed sources and relaxes the link index for no_show', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260730500000_typed_followup_alert_dedupe.js'), 'utf8',
    );
    expect(migration).toContain('idx_dispatch_alerts_typed_followup_one_unresolved');
    expect(migration).toContain("payload->>'source' IN ('typed_completion', 'followup_cancelled')");
    expect(migration).toContain("status NOT IN ('cancelled', 'skipped', 'no_show')");
    // Pre-index cleanup mirrors 20260521000007 (keeps rows, stamps migration).
    expect(migration).toContain('dedupedByMigration');
  });

  test('Intelligence Bar cancel_appointment routes through the shared status writer', () => {
    const ibSource = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/tools.js'), 'utf8');
    const fn = ibSource.slice(ibSource.indexOf('async function cancelAppointment'), ibSource.indexOf('async function draftSms'));
    expect(fn).toContain('transitionJobStatus({');
    expect(fn).toContain("toStatus: 'cancelled'");
    // The direct status write is gone — only the notes append remains.
    expect(fn).not.toContain("status: 'cancelled',");
  });
});

describe('codex r4 — frozen verdict, booking race, no-show retry, IB terminal guard, rollback safety', () => {
  const moduleSource = fs.readFileSync(path.join(__dirname, '../services/typed-followup-obligation.js'), 'utf8');

  test('completion FREEZES its final verdict into structured_notes (both directions)', () => {
    expect(dispatchSource).toContain('...(followupSuggestion ? { typedFollowupVerdict: followupSuggestion } : {}),');
    // Reader replays the frozen verdict verbatim and only re-derives from
    // the live profile for pre-freeze records.
    const reader = moduleSource.slice(moduleSource.indexOf('async function typedFollowupObligationForCompletedSource'));
    const frozenIdx = reader.indexOf('typedFollowupVerdict');
    const liveIdx = reader.indexOf('resolveCompletionProfileForScheduledService');
    expect(frozenIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(frozenIdx);
    expect(reader).toContain("typeof frozenVerdict.required === 'boolean'");
  });

  test('park closes the booking race with a post-COMMIT cross-check (both trx and standalone paths)', () => {
    const park = moduleSource.slice(moduleSource.indexOf('async function parkFollowupAlert'), moduleSource.indexOf('async function handleFollowupChildCancellation'));
    expect(park).toContain('const crossCheck = async () => {');
    expect(park).toContain('trx.executionPromise.then(crossCheck)');
    expect(park).toContain('await crossCheck();');
    // The cross-check resolves OUR OWN card when a child won the race.
    expect(park).toContain('resolveAlert({ id: alertId, resolvedBy: null })');
    expect(park).toContain('post-park cross-check failed');
  });

  test('idempotent no_show retries re-attempt the re-park in BOTH status routes', () => {
    const scheduleSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    for (const src of [dispatchSource, scheduleSource]) {
      const idx = src.indexOf('alreadyNoShow: true');
      expect(idx).toBeGreaterThan(-1);
      const before = src.slice(Math.max(0, idx - 900), idx);
      expect(before).toContain("handleFollowupChildCancellation({ jobId: svc.id, toStatus: 'no_show' })");
    }
  });

  test('IB cancel_appointment enforces the one-way terminal rule (idempotent on cancelled)', () => {
    const ibSource = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/tools.js'), 'utf8');
    const fn = ibSource.slice(ibSource.indexOf('async function cancelAppointment'), ibSource.indexOf('async function draftSms'));
    expect(fn).toContain('already_cancelled: true');
    expect(fn).toContain('TERMINAL_APPOINTMENT_STATUSES.includes(String(appt.status))');
    // Guard runs BEFORE the shared-writer transition.
    expect(fn.indexOf('TERMINAL_APPOINTMENT_STATUSES')).toBeLessThan(fn.indexOf('transitionJobStatus({'));
  });

  test('migration rollback decides the index by CHECKING rows — no exception path in a transactional migration', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260730500000_typed_followup_alert_dedupe.js'), 'utf8',
    );
    const down = migration.slice(migration.indexOf('exports.down'));
    expect(down).toContain('HAVING count(*) > 1');
    expect(down).toContain('conflicting.rows.length ? NEW_LINK_INDEX : ORIGINAL_LINK_INDEX');
    expect(down).not.toContain('} catch (err) {');
  });
});

describe('codex r5 — IB idempotent retry re-park + atomic reason (source contracts)', () => {
  test('already_cancelled retry re-attempts the re-park; reason commits with the transition', () => {
    const ibSource = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/tools.js'), 'utf8');
    const fn = ibSource.slice(ibSource.indexOf('async function cancelAppointment'), ibSource.indexOf('async function draftSms'));
    // Idempotent retry path re-attempts the dedup-guarded re-park.
    const alreadyIdx = fn.indexOf('already_cancelled: true');
    expect(alreadyIdx).toBeGreaterThan(-1);
    const beforeReturn = fn.slice(0, alreadyIdx);
    expect(beforeReturn).toContain("handleFollowupChildCancellation({ jobId: appointment_id, toStatus: 'cancelled' })");
    // Status transition and reason append share ONE caller-owned trx.
    expect(fn).toContain('await db.transaction(async (trx) => {');
    const trxBlock = fn.slice(fn.indexOf('await db.transaction(async (trx) => {'));
    expect(trxBlock.indexOf('transitionJobStatus({')).toBeGreaterThan(-1);
    expect(trxBlock).toContain('trx,');
    expect(trxBlock.indexOf("await trx('scheduled_services')")).toBeGreaterThan(trxBlock.indexOf('transitionJobStatus({'));
    // No stray post-commit notes write remains.
    expect(fn).not.toContain("await db('scheduled_services').where('id', appointment_id).update({");
  });
});

describe('local audit P1s — frozen CTA verdict + compensated-cancellation revival', () => {
  test('a child transitioning back to a covering status resolves the typed cards (both hook directions wired)', () => {
    const moduleSource = fs.readFileSync(path.join(__dirname, '../services/typed-followup-obligation.js'), 'utf8');
    const revival = moduleSource.slice(moduleSource.indexOf('async function handleFollowupChildRevival'));
    // Only typed sources — project_completion / visit-outcome cards have
    // their own lifecycles.
    expect(revival).toContain("payload->>'source' IN ('typed_completion', 'followup_cancelled')");
    expect(revival).toContain("skipped: 'not_revival'");
    // job-status dispatches BOTH directions post-commit.
    expect(jobStatusSource).toContain('handleFollowupChildRevival({ jobId, toStatus })');
    const hook = jobStatusSource.slice(jobStatusSource.indexOf('function maybeReparkFollowupObligation()'));
    expect(hook.indexOf('handleFollowupChildCancellation')).toBeLessThan(hook.indexOf('handleFollowupChildRevival'));
  });
});
