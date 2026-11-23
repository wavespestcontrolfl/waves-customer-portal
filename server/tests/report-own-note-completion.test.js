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
  const pickAt = block.indexOf('const reportNotePick = ');
  const pick = block.slice(pickAt, pickAt + 1000);

  test('picked only with the gate on, for a performed untyped pest visit the recap sheet takes', () => {
    expect(pick).toMatch(/^const reportNotePick = require\('\.\.\/config\/feature-gates'\)\.reportOwnNoteLive\(\)/);
    expect(pick).toContain('&& completionInput.body?.reportNote != null');
    expect(pick).toContain("&& visitOutcome === 'completed' && !typedFindingsType && !isBackfillCompletion");
    // The preview route's own visit check, strict, through a savepoint read.
    expect(pick).toContain("&& (await failSoftRead(db, (k) => require('./pest-recap').resolveEligibility(svc.id, k, { strict: true }), null))?.eligible === true");
    expect(pick).toMatch(/: null;$/m);
  });

  test('screened again against the note this completion stores, for the visit\'s customer', () => {
    expect(pick).toContain("require('./service-report/report-own-note').reportNoteToStore({");
    expect(pick).toContain("note: typeof technicianNotes === 'string' ? technicianNotes.trim() : '',");
    expect(pick).toContain('customerId: svc.customer_id,');
  });

  test('picked before the record is written, and frozen with it', () => {
    expect(pickAt).toBeGreaterThan(0);
    expect(pickAt).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    expect(block).toContain('...(reportNotePick ? { reportNote: reportNotePick } : {}),');
  });

  test('a repoint under the lock drops it before the record is written', () => {
    const resolve = block.indexOf('frozenCompletionProfile = await resolveCompletionProfileForScheduledService(lockedSvcRow, trx);');
    const drop = block.indexOf('if (structuredNotes.reportNote && (!primaryFreezeTrusted');
    expect(drop).toBeGreaterThan(resolve);
    expect(drop).toBeLessThan(block.indexOf('structured_notes: serializeJsonb(structuredNotes),'));
    const dropBlock = block.slice(drop, drop + 800);
    expect(dropBlock).toContain("String(lockedSvcRow.service_type ?? '') !== String(svc.service_type ?? '')");
    expect(dropBlock).toContain("String(lockedSvcRow.service_id ?? '') !== String(svc.service_id ?? '')");
    expect(dropBlock).toContain("String(lockedSvcRow.customer_id ?? '') !== String(svc.customer_id ?? '')");
    expect(dropBlock).toContain("!require('./pest-recap').recapEligibleProfile(frozenCompletionProfile)");
    expect(dropBlock).toContain('delete structuredNotes.reportNote;');
  });
});
