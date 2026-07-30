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
  test('the CTA gate uses the SAME shared verdict chain as the completion', () => {
    const routeIdx = dispatchSource.indexOf("router.post('/:serviceId/schedule-followup'");
    const routeTail = dispatchSource.slice(routeIdx);
    const verdictIdx = routeTail.indexOf('const suggestion = typedFollowupVerdict({');
    expect(verdictIdx).toBeGreaterThan(-1);
    // Snapshot-driven, and still fails closed on missing/mismatched snapshots.
    expect(routeTail.slice(0, verdictIdx)).toContain('followup_no_typed_completion');
    const afterVerdict = routeTail.slice(verdictIdx, verdictIdx + 700);
    expect(afterVerdict).toContain('values: snapshot?.values || {}');
    expect(afterVerdict).toContain('followup_not_required');
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
  test('hook is guarded to cancelled/skipped, lazy-required, and runs POST-COMMIT on both trx paths', () => {
    const hookDef = jobStatusSource.indexOf('function maybeReparkFollowupObligation()');
    expect(hookDef).toBeGreaterThan(-1);
    const hookBody = jobStatusSource.slice(hookDef, hookDef + 1600);
    expect(hookBody).toContain("['cancelled', 'skipped'].includes(String(toStatus || ''))");
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
    expect(handler).toContain("whereNotIn('status', ['cancelled', 'skipped'])");
    expect(handler).toContain("skipped: 'replacement_live'");
    // …and the verdict is re-derived from the committed snapshot, not assumed.
    expect(handler).toContain('typedFollowupObligationForCompletedSource');
    expect(handler).toContain("source: 'followup_cancelled'");
  });

  test('parkFollowupAlert dedupe pre-check is load-bearing (createAlertOnce onConflict does not dedupe)', () => {
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
