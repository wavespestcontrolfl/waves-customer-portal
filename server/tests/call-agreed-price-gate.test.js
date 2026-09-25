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
    const elseEndAt = source.indexOf('reconcileOnlyDraftLinksPending = true;\n    }', elseAt);
    expect(elseEndAt).toBeGreaterThan(elseAt);
    const elseBody = source.slice(elseAt, elseEndAt);
    expect(elseBody).toContain("skipped:'price_agreed_on_call'");
    expect(elseBody).toContain('if (callAgreedPrice != null)');
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
  function priceAgreedSyncBlock() {
    const elseAt = source.indexOf('} else {\n      // Reconcile-only pass');
    const ifAgreedAt = source.indexOf('if (callAgreedPrice != null) {', elseAt);
    expect(ifAgreedAt).toBeGreaterThan(elseAt);
    const endAt = source.indexOf('agreedPriceDraftSweepPending = true;', ifAgreedAt);
    expect(endAt).toBeGreaterThan(ifAgreedAt);
    return source.slice(ifAgreedAt, endAt + 'agreedPriceDraftSweepPending = true;'.length);
  }

  test('an agreed price synchronously invalidates any existing draft AND stamps the call-level block, fenced to this pass\'s claim', () => {
    const block = priceAgreedSyncBlock();
    expect(block).toContain("require('./estimator-engine');");
    expect(block).toContain('invalidateDraftForCall(call.id, {');
    expect(block).toContain("reason: 'price_agreed_on_call',");
    // codex #4815 r2 P0: never an accepted/declined/expired row.
    expect(block).toContain("scope: 'nonterminal_drafts',");
    expect(block).toContain('ownershipFence: { callLogId: call.id, procToken, procGeneration }');
    expect(block).toContain('agreedPriceDraftSweepPending = true;');
  });

  test('a failed pre-write invalidation queues a durable retry (codex #4815 r2 P1)', () => {
    const block = priceAgreedSyncBlock();
    const notOkAt = block.indexOf('if (!invalidation.ok) {');
    expect(notOkAt).toBeGreaterThan(-1);
    const notOkBody = block.slice(notOkAt, block.indexOf('} else {', notOkAt));
    expect(notOkBody).toContain("markQuarantinePending(call.id, 'price_agreed_on_call', { procGeneration });");
  });

  test('a successful pre-write invalidation retires the prior estimator bell in place, never manufacturing a new one (codex #4815 r2 P2)', () => {
    const block = priceAgreedSyncBlock();
    const elseAt = block.indexOf('} else {');
    expect(elseAt).toBeGreaterThan(-1);
    const notifyBlock = block.slice(elseAt, block.indexOf('} catch (invalidateErr)', elseAt));
    expect(notifyBlock).toContain("notify: notifyEstimator } = require('./estimator-engine');");
    expect(notifyBlock).toContain("title: 'Price agreed on call — draft retired',");
    expect(notifyBlock).toContain('estimateId: null,');
    expect(notifyBlock).toContain('quotePromised: false,');
    expect(notifyBlock).toContain('forceUpdate: true,');
    expect(notifyBlock).toContain('updateOnly: true,');
  });

  function priceAgreedSweepBlock() {
    const sweepAt = source.indexOf('if (finalized > 0 && agreedPriceDraftSweepPending) {');
    expect(sweepAt).toBeGreaterThan(-1);
    // Must run alongside (guarded the same way as) the existing
    // reconcile-only pass, i.e. AFTER finalization cleared the token.
    const reconcileAt = source.indexOf('if (finalized > 0 && reconcileOnlyDraftLinksPending) {');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(reconcileAt);
    const endAt = source.indexOf('\n    // The pass did not complete', sweepAt);
    expect(endAt).toBeGreaterThan(sweepAt);
    return source.slice(sweepAt, endAt);
  }

  test('a second, post-finalization sweep re-runs the same invalidation, fenced and scoped the same way as the pre-write pass', () => {
    const block = priceAgreedSweepBlock();
    expect(block).toContain("invalidateDraftForCall: invalidateAgreedPriceAgain } = require('./estimator-engine');");
    expect(block).toContain("reason: 'price_agreed_on_call',");
    expect(block).toContain("scope: 'nonterminal_drafts',");
    expect(block).toContain('ownershipFence: { callLogId: call.id, procToken, procGeneration }');
  });

  test('the sweep queues a durable retry on failure and retires the bell on success, same as the pre-write pass (codex #4815 r2 P1/P2)', () => {
    const block = priceAgreedSweepBlock();
    expect(block).toContain("markQuarantinePending(call.id, 'price_agreed_on_call', { procGeneration });");
    expect(block).toContain("notify: notifyEstimatorSweep } = require('./estimator-engine');");
    expect(block).toContain('updateOnly: true,');
  });

  // codex #4815 r2 P2: the booking pre-draft hook (quotePromised:true, the
  // documented assessment exception) can clear this call's same-generation
  // estimator_draft_block while composing — the sweep must never race it.
  test('the sweep chains onto the SAME tracked booking-predraft promise (via bookingPreDraftAssessmentDrafted) and stands down when it drafted', () => {
    const block = priceAgreedSweepBlock();
    expect(block).toContain('const assessmentExceptionDrafted = await bookingPreDraftAssessmentDrafted(bookingPreDraftPromise);');
    expect(block).toContain('if (assessmentExceptionDrafted) {');
    // The invalidation call must be INSIDE the else (stood-down) branch —
    // never reached when the exception drafted.
    const standDownAt = block.indexOf('if (assessmentExceptionDrafted) {');
    const invalidateAt = block.indexOf('invalidateAgreedPriceAgain(call.id', standDownAt);
    const elseAt = block.indexOf('} else {', standDownAt);
    expect(elseAt).toBeGreaterThan(standDownAt);
    expect(invalidateAt).toBeGreaterThan(elseAt);
  });

  test('the booking pre-draft hook tracks its chain in bookingPreDraftPromise instead of discarding it (void)', () => {
    const hookAt = source.indexOf('const { bookingPreDraftsEnabled, maybePreDraftForBooking } = require');
    expect(hookAt).toBeGreaterThan(-1);
    const hookEndAt = source.indexOf('\n        }\n      } catch (predraftErr)', hookAt);
    expect(hookEndAt).toBeGreaterThan(hookAt);
    const hookBlock = source.slice(hookAt, hookEndAt);
    expect(hookBlock).toContain('bookingPreDraftPromise = (estimatorEnginePromise || Promise.resolve())');
    expect(hookBlock).not.toContain('void (estimatorEnginePromise');
    // The resolved outcome must survive the .then chain (not discarded) —
    // the sweep reads outcome.drafted off exactly this settled value.
    expect(hookBlock).toContain('return outcome;');
  });

  test('resolveCallAgreedPrice is exported for reuse/testing (contract with the engine-entry backstop)', () => {
    const CallRecordingProcessor = require('../services/call-recording-processor');
    expect(typeof CallRecordingProcessor._test.resolveCallAgreedPrice).toBe('function');
  });
});
