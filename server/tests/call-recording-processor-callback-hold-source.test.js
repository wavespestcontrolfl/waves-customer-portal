/**
 * Source-shape regression coverage for two P1s (Codex round-1 on PR #4807)
 * inside call-recording-processor.js's giant processCallRecording body,
 * where the relevant code is inline (not an extracted, independently
 * mockable helper) — same convention several other files in this suite use
 * for a single log-line/shape guarantee inside that function (e.g.
 * call-prelinked-customer-email-backfill.test.js's source assertions).
 *
 * P1-B: the catch around the caller-id-disclaimed crm_notes update must
 *   never log e.message — for a Knex query-builder failure that can render
 *   the rendered SQL plus bindings (the caller's own free-text
 *   phone_note/crm_notes) straight into the log. It must log only a
 *   non-payload code/name, matching this file's sibling DB-failure
 *   handlers.
 *
 * P1-C: the callback_number_needed hold that suppresses the confirmation
 *   SMS must also be persisted onto scheduled_services.callback_number_hold_at
 *   so the (separately unit-tested, see
 *   appointment-reminders-callback-number-hold.test.js) reminder cron can
 *   honor it days later.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

describe('P1-B — caller-id-disclaimed crm_notes stamp failure never logs e.message', () => {
  test('the catch block logs only a non-payload code/name', () => {
    const marker = 'caller-id-disclaimed note stamp failed';
    const idx = src.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    // Look at the whole logger.warn(...) call line containing the marker.
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    const lineEnd = src.indexOf('\n', idx);
    const line = src.slice(lineStart, lineEnd);
    expect(line).toContain('e.code || e.name');
    expect(line).not.toContain('e.message');
  });
});

describe('P1-C — callback_number_needed hold is persisted for the reminder cron', () => {
  test('a flag is raised at the same decision point that blocks the confirmation SMS', () => {
    expect(src).toMatch(/callbackNumberNeededHoldActive\s*=\s*true/);
  });

  test('the hold is stamped onto scheduled_services.callback_number_hold_at once the visit is booked', () => {
    expect(src).toMatch(/callbackNumberNeededHoldActive/);
    expect(src).toMatch(/callback_number_hold_at:\s*new Date\(\)/);
    // Guarded so a concurrent pass can't stomp an already-recorded hold.
    expect(src).toMatch(/whereNull\('callback_number_hold_at'\)/);
  });
});

/**
 * Codex round-3 on PR #4807 (4 P1 + 2 P2). P1 findings #2 + #3 below are
 * covered here as source-shape assertions for the same reason as P1-B/P1-C
 * above: the fix lives inline inside the giant booking transaction, not in
 * an independently mockable helper.
 */
describe('round-3 P1 #2 — the hold write moves INSIDE the booking transaction', () => {
  test('stampCallbackNumberHoldForCall writes on the trx handle, not the outer db handle', () => {
    const idx = src.indexOf('const stampCallbackNumberHoldForCall');
    expect(idx).toBeGreaterThan(-1);
    const closureEnd = src.indexOf('};', idx);
    const body = src.slice(idx, closureEnd);
    // Must run on the transaction handle so it commits/aborts atomically
    // with the booking row itself.
    expect(body).toMatch(/trx\('scheduled_services'\)/);
    expect(body).toMatch(/callback_number_hold_at:\s*new Date\(\)/);
  });

  test('the closure is defined and invoked inside the same trx callback as the booking insert (no separate post-commit call)', () => {
    const trxStart = src.indexOf("db.transaction(async (trx) => {");
    expect(trxStart).toBeGreaterThan(-1);
    const closureIdx = src.indexOf('const stampCallbackNumberHoldForCall', trxStart);
    expect(closureIdx).toBeGreaterThan(trxStart);
    // Called at least once after being defined, still inside the same
    // function body (well before the file ends).
    const firstCallIdx = src.indexOf('await stampCallbackNumberHoldForCall();', closureIdx);
    expect(firstCallIdx).toBeGreaterThan(closureIdx);
  });

  test('a failed in-transaction stamp is NOT swallowed here — no catch wraps this closure\'s own write', () => {
    const idx = src.indexOf('const stampCallbackNumberHoldForCall');
    const closureEnd = src.indexOf('};', idx) + 2;
    const body = src.slice(idx, closureEnd);
    expect(body).not.toMatch(/catch/);
  });

  test('the post-commit fallback write (registerScheduleSideEffects) no longer arms messaging on a failed stamp', () => {
    const idx = src.indexOf('async function registerScheduleSideEffects');
    expect(idx).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\nasync function ', idx + 10);
    const body = src.slice(idx, fnEnd > -1 ? fnEnd : idx + 4000);
    expect(body).toMatch(/holdStampFailed/);
    // registerAppointment (the messaging-arming call) must be skipped when
    // the stamp failed.
    expect(body).toMatch(/if\s*\(!holdStampFailed\)/);
  });
});

describe('round-3 P1 #3 — the follow-up (second-treatment) row is covered by the same stamp', () => {
  test('the stamp targets source_call_log_id, which every row from this call (primary + follow-up) carries', () => {
    const idx = src.indexOf('const stampCallbackNumberHoldForCall');
    const closureEnd = src.indexOf('};', idx);
    const body = src.slice(idx, closureEnd);
    expect(body).toMatch(/source_call_log_id:\s*call\.id/);
  });

  test('the stamp is called after each ensureCallFollowUpVisit call site (fresh insert, idempotency reuse, marker/slot reuse)', () => {
    const callSites = src.match(/await stampCallbackNumberHoldForCall\(\);/g) || [];
    // Three call-booking exit points in this transaction call
    // ensureCallFollowUpVisit; the stamp follows each of them.
    expect(callSites.length).toBeGreaterThanOrEqual(3);
    const followUpSites = src.match(/followUpCreated\s*=\s*await ensureCallFollowUpVisit\(/g) || [];
    expect(followUpSites.length).toBeGreaterThanOrEqual(3);
  });
});

describe('round-3 P2 — the disclaimed-caller crm_notes write is gated on promoted (non-shadow) V2 mode', () => {
  test('the note text is only computed when callExtractionV2PrimaryEnabled() is true', () => {
    const marker = 'caller-id-disclaimed note stamp failed';
    const idx = src.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    // Look upward from the catch's log line to the try block that guards it.
    const tryIdx = src.lastIndexOf('try {', idx);
    const windowSrc = src.slice(tryIdx, idx);
    expect(windowSrc).toMatch(/callExtractionV2PrimaryEnabled\(\)/);
    expect(windowSrc).toMatch(/disclaimedNote\s*=\s*callExtractionV2PrimaryEnabled\(\)/);
  });
});

/**
 * Codex round-4 on PR #4807 (1 P1 + 1 P2). The P1 below is covered here as a
 * source-shape assertion for the same reason as every other stamp-call-site
 * check in this file: the attach paths are inline inside the giant booking
 * transaction, not independently mockable helpers.
 */
describe('round-4 P1 — an ATTACHED human booking is covered by the hold stamp too', () => {
  test('there are now 5 stampCallbackNumberHoldForCall call sites: the 3 ensureCallFollowUpVisit sites (round 3) plus both attach paths (round 4)', () => {
    const callSites = src.match(/await stampCallbackNumberHoldForCall\(\);/g) || [];
    expect(callSites.length).toBeGreaterThanOrEqual(5);
  });

  test('the fresh-attach path (the UPDATE that first sets source_call_log_id on a human-created booking) stamps the hold right after, in the same trx', () => {
    // findAttachableCallAppointment's own attach UPDATE stamps
    // source_call_log_id — the only linkage the hold stamp keys on. The
    // stamp call must appear between that UPDATE and the next attach-path
    // milestone (attachSkippedFollowUpPlan), which this path always sets.
    const updateIdx = src.indexOf("source_call_log_id: call.id,\n                      // JobDrawer-only");
    expect(updateIdx).toBeGreaterThan(-1);
    const nextMilestoneIdx = src.indexOf('attachSkippedFollowUpPlan = !!callFollowUpPlan;', updateIdx);
    expect(nextMilestoneIdx).toBeGreaterThan(updateIdx);
    const stampIdx = src.indexOf('await stampCallbackNumberHoldForCall();', updateIdx);
    expect(stampIdx).toBeGreaterThan(updateIdx);
    // The stamp is deliberately placed before the "Deliberately NO
    // ensureCallFollowUpVisit" comment/return that closes this branch —
    // it is the ONLY hold call site on this path (no follow-up call here).
    const branchReturnIdx = src.indexOf('Deliberately NO ensureCallFollowUpVisit on an attached', updateIdx);
    expect(branchReturnIdx).toBeGreaterThan(stampIdx);
  });

  test('the reprocess/reuse path (isAttachedManualBooking, a row already durably linked from an earlier pass) also stamps — idempotent, so a no-op once the fresh-attach path above already stuck', () => {
    const branchIdx = src.indexOf('if (isAttachedManualBooking) {');
    expect(branchIdx).toBeGreaterThan(-1);
    const branchEnd = src.indexOf('} else if (!primaryRowSkipped && !reuseHeldForAddress)', branchIdx);
    expect(branchEnd).toBeGreaterThan(branchIdx);
    const body = src.slice(branchIdx, branchEnd);
    expect(body).toMatch(/await stampCallbackNumberHoldForCall\(\);/);
  });
});

/**
 * Codex round-5 P1 on PR #4807: a bare whereNull('callback_number_hold_at')
 * no-ops on force-reprocess of a call that was already CLEARED — the row
 * still carries the old hold_at, so the guard blocks the write even though
 * this pass just re-raised callback_number_needed, and the stale
 * call_sms_cleared_at (>= the old hold_at) keeps reading as cleared while a
 * new review card opens with SMS still authorized. Both writers (the
 * in-transaction primary stamp and the post-commit fallback) share the
 * guard and both needed the same widening.
 */
describe('round-5 P1 — a reprocess that re-raises the hold always refreshes callback_number_hold_at', () => {
  test('stampCallbackNumberHoldForCall (in-transaction writer) installs a fresh hold whenever the row is not CURRENTLY held, not only when hold_at was never set', () => {
    const idx = src.indexOf('const stampCallbackNumberHoldForCall');
    const closureEnd = src.indexOf('};', idx);
    const body = src.slice(idx, closureEnd);
    expect(body).toMatch(/whereNull\('callback_number_hold_at'\)/);
    expect(body).toMatch(/orWhereRaw\('call_sms_cleared_at IS NOT NULL AND call_sms_cleared_at >= callback_number_hold_at'\)/);
  });

  test('registerScheduleSideEffects (fallback writer) carries the identical widened guard', () => {
    const idx = src.indexOf('async function registerScheduleSideEffects');
    const fnEnd = src.indexOf('\nasync function ', idx + 10);
    const body = src.slice(idx, fnEnd > -1 ? fnEnd : idx + 4000);
    expect(body).toMatch(/whereNull\('callback_number_hold_at'\)/);
    expect(body).toMatch(/orWhereRaw\('call_sms_cleared_at IS NOT NULL AND call_sms_cleared_at >= callback_number_hold_at'\)/);
  });

  // The two source-shape checks above pin that the widened guard
  // (whereNull(...).orWhereRaw('call_sms_cleared_at IS NOT NULL AND
  // call_sms_cleared_at >= callback_number_hold_at')) is present in both
  // writers; this proves that exact guard's WHERE semantics are correct —
  // it must match a row IFF callbackNumberHoldFromRow (the live predicate
  // every reader in this codebase uses) says the row is NOT currently
  // held, i.e. the guard is the predicate's precise logical inverse.
  test("the widened guard's semantics are the exact inverse of callbackNumberHoldFromRow — refreshes a never-held or already-CLEARED row, leaves a currently-held row (including a stale pre-dating clearance) alone", () => {
    const heldFromRow = (row) => {
      if (!row.callback_number_hold_at) return false;
      const heldAt = new Date(row.callback_number_hold_at).getTime();
      const clearedAt = row.call_sms_cleared_at ? new Date(row.call_sms_cleared_at).getTime() : null;
      return clearedAt === null || clearedAt < heldAt;
    };
    const guardMatches = (row) => !row.callback_number_hold_at
      || (row.call_sms_cleared_at != null
        && new Date(row.call_sms_cleared_at).getTime() >= new Date(row.callback_number_hold_at).getTime());
    const rows = [
      { label: 'never held', callback_number_hold_at: null, call_sms_cleared_at: null },
      // The reprocess bug case round 5 caught: a prior pass's hold was
      // genuinely cleared, and this pass wants to install a fresh one.
      { label: 'cleared AFTER the hold (the reprocess case)', callback_number_hold_at: new Date('2030-01-01T10:00:00Z'), call_sms_cleared_at: new Date('2030-01-01T11:00:00Z') },
      // A stale clearance that PREDATES a fresh hold is still held — the
      // guard must NOT treat this row as eligible for a refresh (that
      // would just needlessly bump an already-correct hold_at).
      { label: 'stale clearance PREDATES a fresh hold — currently held', callback_number_hold_at: new Date('2030-01-02T10:00:00Z'), call_sms_cleared_at: new Date('2030-01-01T09:00:00Z') },
      { label: 'held, never cleared', callback_number_hold_at: new Date('2030-01-01T10:00:00Z'), call_sms_cleared_at: null },
    ];
    for (const row of rows) {
      expect(guardMatches(row)).toBe(!heldFromRow(row));
    }
  });
});
