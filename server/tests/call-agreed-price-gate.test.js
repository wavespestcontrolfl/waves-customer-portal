// Owner ruling 2026-09-24 ("the spoken word beats the estimator" — the $300
// flea call where a price was agreed live still spawned a $387 estimator
// draft two minutes later): processRecording's own estimator-engine gate
// must not fire the engine for a call that already carries an agreed price.
//
// processRecording is a single ~10,000-line method (see
// call-processor-ownership-fences.test.js for the same file's own
// precedent of testing it this way): driving it end-to-end through
// customer/lead/booking creation, past a live V2 model dispatch, purely to
// observe one boolean gate near its tail is impractical and would produce a
// brittle, unmaintainable test. This pins the ACTUAL SHIPPED gate — the
// exact source the running process executes — the same way the
// ownership-fence contract pins this file's other end-to-end invariants.
// Runtime coverage for the two units either side of this wiring lives in:
//   - call-multi-property-quote.test.js (resolveCallAgreedPrice, the pure
//     helper that decides whether a call has an agreed price)
//   - estimator-agreed-price-skip.test.js (maybeDraftEstimateForCall, the
//     engine's OWN entry-point refusal — proves the engine genuinely does
//     not run for an agreed-price call, and genuinely does for a plain
//     quote-requested one, calling the real production function)
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

describe('processRecording estimator-engine gate — agreed-price exclusion', () => {
  test('callAgreedPrice is resolved from the V2 canonical extraction alone, right alongside the quote signals', () => {
    // codex #4815 r1 P1: V2 ONLY — no `extracted` (V1) argument.
    const at = source.indexOf('const callAgreedPrice = resolveCallAgreedPrice(v2CanonicalExtraction);');
    expect(at).toBeGreaterThan(-1);
    const quoteSignalsAt = source.indexOf('resolveCallQuoteSignals(extracted, v2CanonicalExtraction);');
    expect(quoteSignalsAt).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(quoteSignalsAt);
    expect(at - quoteSignalsAt).toBeLessThan(200);
  });

  test('the estimator-engine eligibility gate requires callAgreedPrice == null', () => {
    const gateAt = source.indexOf('if (estimatorEngineOn() && !extracted.is_spam');
    expect(gateAt).toBeGreaterThan(-1);
    const gateClause = source.slice(gateAt, gateAt + 300);
    expect(gateClause).toContain('(callQuotePromised || callQuoteRequested)');
    expect(gateClause).toContain('callAgreedPrice == null');
    // The agreed-price exclusion applies to BOTH quote-promised and
    // quote-requested calls — it must not be scoped inside the
    // parenthesized OR (which would only cover one signal).
    const orAt = gateClause.indexOf('(callQuotePromised || callQuoteRequested)');
    const exclusionAt = gateClause.indexOf('callAgreedPrice == null');
    expect(exclusionAt).toBeGreaterThan(orAt + '(callQuotePromised || callQuoteRequested)'.length);
  });

  test('the non-eligible branch (gate off / agreed price / spam) still logs the specific reason and reconciles draft links', () => {
    const elseAt = source.indexOf('} else {\n      // Reconcile-only pass');
    expect(elseAt).toBeGreaterThan(-1);
    const elseBody = source.slice(elseAt, elseAt + 3300);
    expect(elseBody).toContain("skipped:'price_agreed_on_call'");
    expect(elseBody).toContain('if (callAgreedPrice != null)');
    expect(elseBody).toContain('reconcileOnlyDraftLinksPending = true;');
  });

  // codex #4815 r1 P1: reconcileDraftLinksForCall alone only re-links a
  // draft's lead — it does nothing when the lead is unchanged, so a
  // force-reprocess that newly finds an agreed price left a stale
  // (possibly differently-priced) draft sendable with nothing refusing a
  // detached composer's late insert. The fix reuses the SAME forced-
  // invalidation helper the identity-conflict quarantine and the
  // spam/voicemail terminal verdict already use, in two passes: one before
  // finalization (this pass still holds its own claim) and one after (a
  // belt-and-braces sweep for anything that raced in between) — the exact
  // two-pass shape the spam/voicemail terminal branch uses higher up in
  // this same file.
  test('an agreed price synchronously invalidates any existing draft AND stamps the call-level block, fenced to this pass\'s claim', () => {
    const elseAt = source.indexOf('} else {\n      // Reconcile-only pass');
    const ifAgreedAt = source.indexOf('if (callAgreedPrice != null) {', elseAt);
    expect(ifAgreedAt).toBeGreaterThan(elseAt);
    const block = source.slice(ifAgreedAt, ifAgreedAt + 1300);
    expect(block).toContain("require('./estimator-engine');");
    expect(block).toContain('invalidateDraftForCall(call.id, {');
    expect(block).toContain("reason: 'price_agreed_on_call',");
    expect(block).toContain('ownershipFence: { callLogId: call.id, procToken, procGeneration }');
    expect(block).toContain('agreedPriceDraftSweepPending = true;');
  });

  test('a second, post-finalization sweep re-runs the same invalidation, fenced the same way as the reconcile-only pass', () => {
    const sweepAt = source.indexOf('if (finalized > 0 && agreedPriceDraftSweepPending) {');
    expect(sweepAt).toBeGreaterThan(-1);
    // Must run alongside (guarded the same way as) the existing
    // reconcile-only pass, i.e. AFTER finalization cleared the token.
    const reconcileAt = source.indexOf('if (finalized > 0 && reconcileOnlyDraftLinksPending) {');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(reconcileAt);
    const block = source.slice(sweepAt, sweepAt + 1300);
    expect(block).toContain("invalidateDraftForCall: invalidateAgreedPriceAgain } = require('./estimator-engine');");
    expect(block).toContain("reason: 'price_agreed_on_call',");
    expect(block).toContain('ownershipFence: { callLogId: call.id, procToken, procGeneration }');
  });

  test('resolveCallAgreedPrice is exported for reuse/testing (contract with the engine-entry backstop)', () => {
    const CallRecordingProcessor = require('../services/call-recording-processor');
    expect(typeof CallRecordingProcessor._test.resolveCallAgreedPrice).toBe('function');
  });
});
