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
  test('callAgreedPrice is resolved from BOTH extractors before the gate is evaluated', () => {
    const at = source.indexOf('const callAgreedPrice = resolveCallAgreedPrice(extracted, v2CanonicalExtraction);');
    expect(at).toBeGreaterThan(-1);
    // Computed right alongside the quote signals it must be checked
    // together with (same call site, same inputs).
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
    const elseBody = source.slice(elseAt, elseAt + 1100);
    expect(elseBody).toContain("skipped:'price_agreed_on_call'");
    expect(elseBody).toContain('if (callAgreedPrice != null)');
    expect(elseBody).toContain('reconcileOnlyDraftLinksPending = true;');
  });

  test('resolveCallAgreedPrice is exported for reuse/testing (contract with the engine-entry backstop)', () => {
    const CallRecordingProcessor = require('../services/call-recording-processor');
    expect(typeof CallRecordingProcessor._test.resolveCallAgreedPrice).toBe('function');
  });
});
