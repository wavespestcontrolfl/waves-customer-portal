/**
 * The pest Fast Complete completion stores the technician's own note
 * (GATE_REPORT_OWN_NOTE, report speed plan step 2) on
 * structured_notes.reportNote. The sheet completes through
 * completeScheduledService, which is too large for a unit harness, so the
 * wiring is pinned by source here (as completion's blog post freeze,
 * report-blog-post.test.js); what is stored is proven on reportNoteToStore
 * (report-own-note.test.js "the note a completion stores").
 * Regression guarded: a note stored while the gate is off, for a visit the
 * sheet does not take, unscreened against the stored note, or kept after a
 * repoint under the lock.
 */
const fs = require('fs');
const path = require('path');

const completionSource = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
const block = completionSource.slice(completionSource.indexOf('async function completeScheduledService('));

describe('the completion\'s report note', () => {
  const sentAt = block.indexOf('const reportNoteLive = ');
  const pick = block.slice(sentAt, sentAt + 4500);

  test('asked only with the gate on and a note sent, for a performed untyped non-backfill visit', () => {
    expect(pick).toMatch(/^const reportNoteLive = require\('\.\.\/config\/feature-gates'\)\.reportOwnNoteLive\(\);/);
    expect(pick).toContain('const reportNoteSent = reportNoteLive && completionInput.body?.reportNote != null;');
    expect(pick).toContain("reportNoteSent && visitOutcome === 'completed' && !typedFindingsType && !isBackfillCompletion");
    expect(pick).toContain("&& detectServiceLine(svc.service_type || '') === 'pest'");
  });

  test('the visit check is the preview route\'s, strict, in a savepoint scope (no nested queue)', () => {
    expect(pick).toContain("await savepointScope(db, (k) => require('./pest-recap').resolveEligibility(svc.id, k, { strict: true })).catch(() => null)");
    expect(pick).toContain('const reportNotePick = reportNoteVisit?.eligible === true');
  });

  test('screened again against the note this completion stores, for the visit\'s customer', () => {
    expect(pick).toContain("require('./service-report/report-own-note').reportNoteToStore({");
    expect(pick).toContain("note: typeof technicianNotes === 'string' ? technicianNotes.trim() : '',");
    expect(pick).toContain('customerId: svc.customer_id,');
  });

  test('a sent note on a visit that could not be checked refuses a fresh attempt, before any write', () => {
    expect(pick).toContain('const reportNoteUnverified = reportNoteVisit === null || (reportNoteVisit?.ok === true && !reportNoteVisit.profile)');
    expect(pick).toContain("savepointScope(db, (k) => require('./area-addon-visit-rows').visitHasAreaAddOnRows(k, svc.id))");
    expect(pick).toContain('.then((hasRows) => hasRows !== true, () => true);');
    const reject = block.indexOf("if (claim.action === 'proceed' && reportNoteUnverified) {");
    expect(reject).toBeGreaterThan(0);
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    expect(block.slice(reject, reject + 500)).toMatch(/markCompletionAttemptFailed[\s\S]*status: 503[\s\S]*code: 'REPORT_NOTE_UNVERIFIED'/);
  });

  test('a sent note in no shape the sheet sends is a 400 for a fresh attempt, before any write', () => {
    expect(pick).toContain('const reportNoteInvalid = reportNoteSent && (reportNoteCompanions || reportNoteVisit === undefined');
    expect(pick).toContain("|| !require('./service-report/report-own-note').isSheetReportNote(completionInput.body.reportNote));");
    // A visit with a companion service never takes a note (its report shows the companion card).
    expect(pick).toContain('const reportNoteCompanions = Array.isArray(companionFindings) ? companionFindings.length > 0');
    expect(pick).toContain('const reportNotePick = reportNoteVisit?.eligible === true && !reportNoteInvalid');
    const reject = block.indexOf("if (claim.action === 'proceed' && reportNoteInvalid) {");
    expect(reject).toBeGreaterThan(0);
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    expect(block.slice(reject, reject + 500)).toMatch(/status: 400[\s\S]*code: 'REPORT_NOTE_INVALID'/);
  });

  test('a sent note on a visit the sheet no longer takes is a 409 changed visit, before any write', () => {
    expect(pick).toContain('const reportNoteVisitChanged = reportNoteVisit?.ok === true && reportNoteVisit.eligible !== true && !reportNoteUnverified;');
    const reject = block.indexOf("if (claim.action === 'proceed' && reportNoteVisitChanged && !reportNoteInvalid) {");
    expect(reject).toBeGreaterThan(0);
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    expect(block.slice(reject, reject + 500)).toMatch(/status: 409[\s\S]*code: 'visit_identity_changed'/);
  });

  test('a note sent while the gate is off refuses a fresh attempt (409), before any write', () => {
    expect(pick).toContain('const reportNoteStale = !reportNoteLive && completionInput.body?.reportNote != null;');
    const reject = block.indexOf("if (claim.action === 'proceed' && reportNoteStale) {");
    expect(reject).toBeGreaterThan(block.indexOf("if (claim.action === 'replay') {"));
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    expect(block.slice(reject, reject + 500)).toMatch(/status: 409[\s\S]*code: 'REPORT_NOTE_OFF'/);
  });

  test('frozen with the record; a frozen note is the customer recap (no model reads the raw note for one)', () => {
    expect(sentAt).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    expect(block).toContain('...(reportNotePick ? { reportNote: reportNotePick } : {}),');
    expect(block).toContain('let effectiveCustomerRecap = reportNotePick ? reportNotePick.text : customerRecap;');
  });

  test('a changed visit under the lock rolls the record back', () => {
    const resolve = block.indexOf('frozenCompletionProfile = await resolveCompletionProfileForScheduledService(lockedSvcRow, trx);');
    const drop = block.indexOf('if (structuredNotes.reportNote && (!primaryFreezeTrusted');
    expect(drop).toBeGreaterThan(resolve);
    expect(drop).toBeLessThan(block.indexOf('structured_notes: serializeJsonb(structuredNotes),'));
    const dropBlock = block.slice(drop, drop + 1500);
    expect(dropBlock).toContain("String(lockedSvcRow.service_id ?? '') !== String(svc.service_id ?? '')");
    expect(dropBlock).toContain("String(lockedSvcRow.customer_id ?? '') !== String(svc.customer_id ?? '')");
    expect(dropBlock).toContain("savepointScope(trx, (k) => require('./pest-recap').resolveEligibility(svc.id, k, { strict: true }))");
    expect(dropBlock).toContain("String(locked.profile?.serviceKey ?? '') !== String(reportNoteVisit?.profile?.serviceKey ?? '')");
    expect(dropBlock).toContain("code: 'visit_identity_changed'");
  });
});
