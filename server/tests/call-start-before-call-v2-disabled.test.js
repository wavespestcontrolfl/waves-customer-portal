/**
 * Codex #4919 round-3 P1: with CALL_EXTRACTION_V2_DRIVES_ROUTING=true but
 * CALL_EXTRACTION_V2_ENABLED=false, boot documents this combination as bare
 * legacy V1 routing (both the enforce gate AND the shadow bridge are dead —
 * see the boot-time flag audit's own WARNING at the top of this file).
 * v2ApprovedExtraction never gets set in this combination (its only writer
 * is gated on `CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED`),
 * so the enforce-mode approved-but-unbooked fallback further down (guarded
 * on `v2ApprovedExtraction`) never fires. The start_before_call stale-start
 * card must therefore still file HERE, in what looks like "enforce mode" by
 * DRIVES_ROUTING alone but is actually plain V1 routing with no fallback of
 * its own — keyed on the EFFECTIVE enforce state (`DRIVES_ROUTING &&
 * V2_ENABLED`), the same expression boot's own audit and every other
 * "are we really in enforce mode" site in this file already computes, not
 * on DRIVES_ROUTING alone.
 *
 * A full functional run through processRecording() is impractical to mock
 * end-to-end (see admin-call-recordings-process-conflict.test.js's own
 * source-text pins for the same reason on an adjacent fix) — this pins the
 * fix STRUCTURALLY, the established pattern in this suite for these branches
 * (see call-shadow-callback-hold-arming.test.js).
 */
const processorSource = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

describe('start_before_call card files even when DRIVES_ROUTING is true but V2_ENABLED is false (codex #4919 round-3 P1)', () => {
  test('the shadow/legacy card-filing branch is keyed on the EFFECTIVE enforce state, not DRIVES_ROUTING alone', () => {
    const skipAt = processorSource.indexOf("skippedReason: 'start_before_call',");
    expect(skipAt).toBeGreaterThan(-1);
    const branchGateAt = processorSource.indexOf(
      'if (!(CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED)) {',
      skipAt,
    );
    expect(branchGateAt).toBeGreaterThan(skipAt);
    // Bounded to just before the next top-level statement, so a stale plain
    // `!CALL_EXTRACTION_V2_DRIVES_ROUTING` check re-added elsewhere in the
    // function does not accidentally satisfy this assertion.
    const nextStatementAt = processorSource.indexOf('if (scheduledDate && scheduledDate < callDateET) {', branchGateAt);
    expect(nextStatementAt).toBeGreaterThan(branchGateAt);
    const branchSection = processorSource.slice(branchGateAt, nextStatementAt);
    expect(branchSection).not.toContain('if (!CALL_EXTRACTION_V2_DRIVES_ROUTING)');
    expect(branchSection).toContain("skipped_reason: 'start_before_call'");
  });

  test('the writer that sets v2ApprovedExtraction is gated on the SAME effective-enforce expression — confirming the enforce-mode fallback really is unreachable in this combination', () => {
    const writerGateAt = processorSource.indexOf('if (CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED) {');
    expect(writerGateAt).toBeGreaterThan(-1);
    const writeAt = processorSource.indexOf('v2ApprovedExtraction = v2Extraction;', writerGateAt);
    expect(writeAt).toBeGreaterThan(writerGateAt);
    // The enforce-mode approved-but-unbooked fallback (further down) requires
    // v2ApprovedExtraction truthy — never set outside the gate above, so
    // DRIVES_ROUTING-without-V2_ENABLED leaves it null and that fallback
    // guarded on it structurally cannot fire.
    const fallbackGateAt = processorSource.indexOf('CALL_EXTRACTION_V2_DRIVES_ROUTING && v2ApprovedExtraction && extracted.appointment_confirmed');
    expect(fallbackGateAt).toBeGreaterThan(writeAt);
  });
});
