/**
 * Finding #4 (round 4 P1, PR #4807): in the documented prod shadow posture
 * (CALL_EXTRACTION_V2_ENABLED=true, CALL_EXTRACTION_V2_DRIVES_ROUTING=false)
 * the enforce-only branch (guarded by
 * `if (CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED)`) is
 * the ONLY place that armed v2SmsBlocked + callbackNumberNeededHoldActive
 * for a callback_number_needed call — the shadow branch merged the same
 * deterministic flag into bridgeTriageFlags but never read it, so shadow
 * mode created no review card and no durable hold, and kept texting the
 * disclaimed ANI.
 *
 * A full functional run through processRecording() is impractical to mock
 * end-to-end (see admin-call-recordings-process-conflict.test.js's own
 * source-text pins for the same reason on an adjacent fix) — this pins the
 * fix STRUCTURALLY: the shadow branch now calls callbackNumberNeededBlocksSms
 * on the SAME merged bridgeTriageFlags the review card is filed from, and
 * arms the same two variables the enforce branch does.
 */
const processorSource = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

describe('shadow-mode callback_number_needed hold arming', () => {
  test('the shadow branch (V2_ENABLED && !DRIVES_ROUTING) arms v2SmsBlocked + callbackNumberNeededHoldActive from bridgeTriageFlags', () => {
    const shadowGateAt = processorSource.indexOf('if (CALL_EXTRACTION_V2_ENABLED && !CALL_EXTRACTION_V2_DRIVES_ROUTING) {');
    expect(shadowGateAt).toBeGreaterThan(-1);
    // Bounded to the bridge's own try block — up to the deriveCallReviewBridge
    // call that consumes the same bridgeTriageFlags.
    const bridgeCallAt = processorSource.indexOf('const { normalizedAddress, normalizedEmail, needsConfirmation } = deriveCallReviewBridge({', shadowGateAt);
    expect(bridgeCallAt).toBeGreaterThan(shadowGateAt);
    const shadowSection = processorSource.slice(shadowGateAt, bridgeCallAt);
    expect(shadowSection).toContain('callbackNumberNeededBlocksSms(bridgeTriageFlags)');
    expect(shadowSection).toContain('v2SmsBlocked = true');
    expect(shadowSection).toContain('callbackNumberNeededHoldActive = true');
  });

  test('the enforce branch (DRIVES_ROUTING && V2_ENABLED) still arms the same two variables — the shadow fix does not touch it', () => {
    const enforceGateAt = processorSource.indexOf('if (CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED) {');
    expect(enforceGateAt).toBeGreaterThan(-1);
    const callAt = processorSource.indexOf('callbackNumberNeededBlocksSms(finalFlags)', enforceGateAt);
    expect(callAt).toBeGreaterThan(enforceGateAt);
    const enforceSection = processorSource.slice(callAt, callAt + 600);
    expect(enforceSection).toContain('v2SmsBlocked = true');
    expect(enforceSection).toContain('callbackNumberNeededHoldActive = true');
  });

  test('v2SmsBlocked/callbackNumberNeededHoldActive are declared ONCE, outside both branches, so either branch\'s write reaches the shared downstream consumers (confirmation gate, registerScheduleSideEffects)', () => {
    const declAt = processorSource.indexOf('let v2SmsBlocked = false;');
    const enforceGateAt = processorSource.indexOf('if (CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED) {');
    const shadowGateAt = processorSource.indexOf('if (CALL_EXTRACTION_V2_ENABLED && !CALL_EXTRACTION_V2_DRIVES_ROUTING) {');
    expect(declAt).toBeGreaterThan(-1);
    expect(declAt).toBeLessThan(enforceGateAt);
    expect(declAt).toBeLessThan(shadowGateAt);
  });
});
