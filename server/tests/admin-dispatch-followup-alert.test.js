/**
 * Typed-completion follow-up alerts (parity with the pre-cutover project
 * flow). ALERT-policy profiles (bed bug, cockroach two-treatment, German
 * knockdown, …) used to persist a follow_up_needed dispatch alert via
 * createProjectFollowupAlert when they completed through the project flow.
 * After the typed service-report cutover the suggestion only surfaced as
 * the transient success-overlay CTA — tapping "Done" dropped the owed
 * follow-up with no durable trace (no dispatch alert, no sweep re-finds
 * it). Reproduced live 2026-07-30 on a bed_bug_treatment completion:
 * followupSuggestion.required=true in the response, dispatch_alerts empty.
 *
 * The giant completion route can't be exercised end-to-end here, so these
 * are source contracts on the load-bearing lines, in the style of
 * admin-dispatch-backfill-completion.test.js:
 *  - the typed /complete path parks a follow_up_needed alert when the
 *    final (post-override) suggestion still requires one, deduped against
 *    any unresolved alert on the job, best-effort (never fails the
 *    already-durable completion);
 *  - the persist block runs AFTER every suggestion downgrade (species,
 *    included-visit, tech "No") so a withdrawn suggestion never mints an
 *    alert;
 *  - POST /:serviceId/schedule-followup resolves the parked alert once the
 *    CTA books the visit, so the exception clears when handled.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

describe('typed completion parks a follow_up_needed dispatch alert', () => {
  test('persist block exists: guarded on the FINAL suggestion, deduped, typed_completion source', () => {
    expect(source).toContain("if (followupSuggestion?.required) {");
    expect(source).toContain("source: 'typed_completion'");
    expect(source).toContain("existingPayloadSource: 'typed_completion'");
    // Dedup pre-check mirrors createProjectFollowupAlert: any unresolved
    // follow_up_needed on this job (incl. the visit-outcome path) wins.
    const persistBlock = source.slice(
      source.indexOf("if (followupSuggestion?.required) {"),
      source.indexOf("existingPayloadSource: 'typed_completion'"),
    );
    expect(persistBlock).toContain("{ type: 'follow_up_needed', job_id: svc.id }");
    expect(persistBlock).toContain(".whereNull('resolved_at')");
    expect(persistBlock).toContain("severity: 'info'");
    expect(persistBlock).toContain('suggestedFollowupDate: followupSuggestion.suggestedDate');
  });

  test('persist block is best-effort: alert failure warns instead of failing the durable completion', () => {
    const persistStart = source.indexOf("if (followupSuggestion?.required) {");
    const tail = source.slice(persistStart, persistStart + 2500);
    expect(tail).toContain('follow-up alert persist failed');
    expect(tail).toContain('logger.warn');
  });

  test('persist block runs after EVERY suggestion downgrade (withdrawn suggestions never mint alerts)', () => {
    const persistIdx = source.indexOf("if (followupSuggestion?.required) {");
    expect(persistIdx).toBeGreaterThan(-1);
    // Each downgrade writes required:false with a reason; all must precede
    // the persist guard so the guard sees the final verdict.
    for (const reason of ['species_not_german', 'included_followup_visit', 'tech_marked_not_required']) {
      const reasonIdx = source.indexOf(`reason: '${reason}'`);
      expect(reasonIdx).toBeGreaterThan(-1);
      expect(reasonIdx).toBeLessThan(persistIdx);
    }
    // The palmetto upgrade (tech_marked_needed) must also precede it, so a
    // none-policy profile whose checklist says Yes still parks the alert.
    const palmettoIdx = source.indexOf("reason: 'tech_marked_needed'");
    expect(palmettoIdx).toBeGreaterThan(-1);
    expect(palmettoIdx).toBeLessThan(persistIdx);
  });

  test('persist block sits inside the typed suggestion scope (no alerts for untyped or incomplete visits)', () => {
    const scopeStart = source.indexOf('let followupSuggestion = null;');
    const scopeGuard = source.indexOf('if (typedFindingsType && followupFindings && !isIncompleteVisit) {', scopeStart);
    const persistIdx = source.indexOf("if (followupSuggestion?.required) {");
    expect(scopeStart).toBeGreaterThan(-1);
    expect(scopeGuard).toBeGreaterThan(scopeStart);
    expect(persistIdx).toBeGreaterThan(scopeGuard);
    // The next route definition must come after the persist block — i.e.
    // the block lives in THIS handler, not a later one.
    const nextRoute = source.indexOf('router.', persistIdx);
    const persistBlockEnd = source.indexOf('follow-up alert persist failed', persistIdx);
    expect(persistBlockEnd).toBeGreaterThan(persistIdx);
    expect(nextRoute === -1 || nextRoute > persistBlockEnd).toBe(true);
  });

  test('crash-resume rehydrates typed values from the committed snapshot (Codex r1 P2)', () => {
    const scopeStart = source.indexOf('let followupSuggestion = null;');
    const scopeGuard = source.indexOf('if (typedFindingsType && followupFindings && !isIncompleteVisit) {', scopeStart);
    const rehydrate = source.slice(scopeStart, scopeGuard);
    // Resume path bypasses runTypedValidation (typedFindings stays null) —
    // the committed record's typedReportSnapshot supplies the values, gated
    // on the resume flag and a type match with the resolved profile.
    expect(rehydrate).toContain('let followupFindings = typedFindings;');
    expect(rehydrate).toContain('resumingCommittedCompletion && typedFindingsType');
    expect(rehydrate).toContain('typedReportSnapshot');
    expect(rehydrate).toContain("String(resumedSnapshot.type || '') === String(typedFindingsType)");
    // The override chain reads the rehydrated values, never bare
    // typedFindings — otherwise a resumed German "No" could park an alert
    // the original verdict withdrew.
    const overrideChain = source.slice(scopeGuard, source.indexOf("if (followupSuggestion?.required) {"));
    expect(overrideChain).not.toContain('typedFindings.values');
    expect(overrideChain).toContain('followupFindings.values');
  });
});

describe('schedule-followup resolves the parked alert', () => {
  test('resolver targets unresolved follow_up_needed alerts for the source job, best-effort', () => {
    const routeIdx = source.indexOf("router.post('/:serviceId/schedule-followup'");
    expect(routeIdx).toBeGreaterThan(-1);
    const routeTail = source.slice(routeIdx);
    const helperIdx = routeTail.indexOf('const resolveOpenFollowupAlerts = async () => {');
    expect(helperIdx).toBeGreaterThan(-1);
    const helper = routeTail.slice(helperIdx, routeTail.indexOf('};', helperIdx));
    expect(helper).toContain("{ type: 'follow_up_needed', job_id: svc.id }");
    expect(helper).toContain(".whereNull('resolved_at')");
    expect(helper).toContain('resolveAlert({ id: alert.id, resolvedBy: req.technicianId || null })');
    // Best-effort: resolution failure never fails the booking response.
    expect(helper).toContain('logger.warn');
    expect(helper).toContain('follow-up alert resolve failed');
  });

  test('EVERY booked-follow-up answer resolves: fresh insert, idempotent retry, 23505 race winner (Codex r1 P2)', () => {
    const routeIdx = source.indexOf("router.post('/:serviceId/schedule-followup'");
    const routeTail = source.slice(routeIdx);
    const calls = routeTail.split('await resolveOpenFollowupAlerts();').length - 1;
    expect(calls).toBe(3);
    // Idempotent retry: the existing-booking early return resolves BEFORE
    // answering alreadyScheduled — a crash between insert and resolve on the
    // first attempt must not strand the alert open forever.
    const existingIdx = routeTail.indexOf('if (existing) {');
    const existingBlock = routeTail.slice(existingIdx, routeTail.indexOf('}', routeTail.indexOf('alreadyScheduled: true', existingIdx)));
    expect(existingBlock).toContain('await resolveOpenFollowupAlerts();');
    // Race loser: the 23505 winner answer resolves too.
    const winnerIdx = routeTail.indexOf('if (winner) {');
    const winnerBlock = routeTail.slice(winnerIdx, routeTail.indexOf('});', winnerIdx));
    expect(winnerBlock).toContain('await resolveOpenFollowupAlerts();');
    // Fresh booking: resolution AFTER the insert succeeds — the alert only
    // clears once the follow-up actually exists on the schedule.
    const bookedIdx = routeTail.indexOf('follow-up ${appointment.id} booked');
    expect(bookedIdx).toBeGreaterThan(-1);
    const afterBooked = routeTail.slice(bookedIdx, bookedIdx + 300);
    expect(afterBooked).toContain('await resolveOpenFollowupAlerts();');
  });
});
