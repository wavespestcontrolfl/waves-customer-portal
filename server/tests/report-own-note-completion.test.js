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
  const sentAt = block.indexOf('const reportNoteSent = ');
  const pick = block.slice(sentAt, sentAt + 1800);

  test('asked only with the gate on and a note sent, for a performed untyped non-backfill visit', () => {
    expect(pick).toMatch(/^const reportNoteSent = require\('\.\.\/config\/feature-gates'\)\.reportOwnNoteLive\(\) && completionInput\.body\?\.reportNote != null;/);
    expect(pick).toContain("reportNoteSent && visitOutcome === 'completed' && !typedFindingsType && !isBackfillCompletion");
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
    expect(pick).toContain('const reportNoteUnverified = reportNoteVisit === null;');
    const reject = block.indexOf("if (claim.action === 'proceed' && reportNoteUnverified) {");
    expect(reject).toBeGreaterThan(0);
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    expect(block.slice(reject, reject + 500)).toMatch(/markCompletionAttemptFailed[\s\S]*status: 503[\s\S]*code: 'REPORT_NOTE_UNVERIFIED'/);
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
    const dropBlock = block.slice(drop, drop + 1200);
    expect(dropBlock).toContain("String(lockedSvcRow.service_id ?? '') !== String(svc.service_id ?? '')");
    expect(dropBlock).toContain("String(lockedSvcRow.customer_id ?? '') !== String(svc.customer_id ?? '')");
    expect(dropBlock).toContain("savepointScope(trx, (k) => require('./pest-recap').resolveEligibility(svc.id, k, { strict: true }))");
    expect(dropBlock).toContain("code: 'visit_identity_changed'");
  });
});
