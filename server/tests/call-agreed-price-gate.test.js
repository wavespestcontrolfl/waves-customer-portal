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

  // codex #4815 r5 P1: the durable queue write for a failed pre-write
  // invalidation is no longer attempted synchronously here, with its own
  // fallback ladder (a live-owner retry-lane push, then a parallel
  // finalStatus='extraction_failed' flip) — that parallel transition wrote
  // through NORMAL finalization, never touched extraction_attempts, and
  // reported success:true, so processAllPending retried the call every 10
  // minutes forever instead of stopping at CALL_EXTRACTION_MAX_ATTEMPTS.
  // Deferred instead: this site only remembers the marker to write
  // (pendingQuarantineMarker), and the finalization transaction writes it
  // atomically with the terminal status — see the block below.
  test('a failed pre-write invalidation defers the durable retry marker to the finalization transaction, not a synchronous write here (codex #4815 r5 P1)', () => {
    const block = priceAgreedSyncBlock();
    const notOkAt = block.indexOf('if (!invalidation.ok) {');
    expect(notOkAt).toBeGreaterThan(-1);
    const notOkBody = block.slice(notOkAt, block.indexOf('} else {', notOkAt));
    expect(notOkBody).toContain("pendingQuarantineMarker = { reason: 'price_agreed_on_call', procGeneration };");
    // No synchronous markQuarantinePending call, no liveOwner retry-lane
    // push, and no parallel finalStatus flip at this site any more.
    expect(notOkBody).not.toContain('markQuarantinePending(');
    expect(notOkBody).not.toContain('pushCallToRetryLaneAfterQuarantineFailure({');
    expect(notOkBody).not.toContain("finalStatus = 'extraction_failed';");
  });

  test('a thrown pre-write invalidation attempt ALSO defers the durable retry marker (codex #4815 r5 P1)', () => {
    const block = priceAgreedSyncBlock();
    const catchAt = block.indexOf('} catch (invalidateErr) {');
    expect(catchAt).toBeGreaterThan(-1);
    const catchBody = block.slice(catchAt, block.indexOf('agreedPriceDraftSweepPending = true;', catchAt));
    expect(catchBody).toContain("pendingQuarantineMarker = { reason: 'price_agreed_on_call', procGeneration };");
  });

  test('the finalization transaction writes the deferred quarantine marker atomically with the terminal status, fenced on written > 0 (codex #4815 r5 P1)', () => {
    const trxAt = source.indexOf('const finalized = await db.transaction(async (trx) => {');
    expect(trxAt).toBeGreaterThan(-1);
    const trxEndAt = source.indexOf('return written;\n    });', trxAt);
    expect(trxEndAt).toBeGreaterThan(trxAt);
    const trxBody = source.slice(trxAt, trxEndAt);
    const markAt = trxBody.indexOf('if (written > 0 && pendingQuarantineMarker) {');
    expect(markAt).toBeGreaterThan(-1);
    // Must land AFTER the `written` update (it reads `written`) and inside
    // this same transaction callback (before the callback's own return).
    const writtenUpdateAt = trxBody.indexOf("const written = await trx('call_log')");
    expect(writtenUpdateAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(writtenUpdateAt);
    const markBody = trxBody.slice(markAt, markAt + 400);
    expect(markBody).toContain("const { markQuarantinePending } = require('./estimator-engine');");
    expect(markBody).toContain('await markQuarantinePending(call.id, pendingQuarantineMarker.reason, {');
    expect(markBody).toContain('procGeneration: pendingQuarantineMarker.procGeneration,');
    expect(markBody).toContain('trx,');
  });

  test('lead-creation failure sets finalStatus unconditionally — extraction_failed is no longer a possible prior value (codex #4815 r5 P1)', () => {
    expect(source).toContain(
      "if ((workableUnnamedLead || sameCallOwnershipRejected) && !leadId) {\n      finalStatus = 'lead_creation_failed';",
    );
    // The dead r4 guard (a parallel finalStatus='extraction_failed' flip no
    // longer exists anywhere in this file to protect against overwriting).
    expect(source).not.toContain("if (finalStatus !== 'extraction_failed') finalStatus = 'lead_creation_failed';");
    expect(source).not.toContain("finalStatus = 'extraction_failed';");
  });

  test('a successful pre-write invalidation delegates bell retirement to the shared helper, passing invalidated + callQuotePromised through (codex #4815 r2 P2, refined r3 P1)', () => {
    const block = priceAgreedSyncBlock();
    const elseAt = block.indexOf('} else {');
    expect(elseAt).toBeGreaterThan(-1);
    const notifyBlock = block.slice(elseAt, block.indexOf('} catch (invalidateErr)', elseAt));
    expect(notifyBlock).toContain('await retirePriceAgreedEstimatorBell({');
    expect(notifyBlock).toContain('call, callSid, callerName, callAgreedPrice, callQuotePromised,');
    expect(notifyBlock).toContain('invalidated: invalidation.invalidated === true,');
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

  test('the sweep falls back to the shared retry-lane push on a failed markQuarantinePending write (codex #4815 r3 P1)', () => {
    const block = priceAgreedSweepBlock();
    expect(block).toContain("const queued = await markQuarantinePending(call.id, 'price_agreed_on_call', { procGeneration });");
    expect(block).toContain('if (!queued) {');
    expect(block).toContain('await pushCallToRetryLaneAfterQuarantineFailure({');
  });

  test('a sweep that LANDS the invalidation retires its own generation\'s queued retry, never on an ownership loss (codex #4815 r7 P0)', () => {
    const block = priceAgreedSweepBlock();
    const successAt = block.indexOf('} else {', block.indexOf('if (!sweepInvalidation.ok) {'));
    expect(successAt).toBeGreaterThan(-1);
    const success = block.slice(successAt);
    const guardAt = success.indexOf('if (!sweepInvalidation.ownershipLost) {');
    const clearAt = success.indexOf("await clearOwnQuarantinePending(call.id, { reason: 'price_agreed_on_call', generation: procGeneration });");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(guardAt);
    // Only the success branch clears — the failure branch QUEUES.
    expect(block.slice(0, successAt)).not.toContain('clearOwnQuarantinePending');
  });

  // codex #4815 r9 P2: the queued entry the sweep cleared is what refused
  // the assessment pre-draft that ran first — re-run it, only when THIS
  // sweep actually cleared its own entry, and after the bell retirement (the
  // re-run's own bell must not be the one retired).
  test('a sweep that clears its own queued entry re-runs the blocked assessment pre-draft after retiring the bell (codex #4815 r9 P2)', () => {
    const block = priceAgreedSweepBlock();
    const successAt = block.indexOf('} else {', block.indexOf('if (!sweepInvalidation.ok) {'));
    const success = block.slice(successAt);
    const clearAt = success.indexOf('clearedOwnEntry = await clearOwnQuarantinePending(');
    const retireAt = success.indexOf('await retirePriceAgreedEstimatorBell({');
    const rerunGuardAt = success.indexOf('if (clearedOwnEntry > 0) {');
    const rerunAt = success.indexOf('await rerunAssessmentPreDraftAfterQuarantineClear({');
    expect(clearAt).toBeGreaterThan(-1);
    expect(retireAt).toBeGreaterThan(clearAt);
    expect(rerunGuardAt).toBeGreaterThan(retireAt);
    expect(rerunAt).toBeGreaterThan(rerunGuardAt);
    expect(success.slice(rerunAt, rerunAt + 200)).toContain('bookingPreDraftPromise, rerun: rerunBookingPreDraft, callSid');
    // The re-run carries the SAME pass identity as the first run.
    const hookAt = source.indexOf('rerunBookingPreDraft = () => maybePreDraftForBooking(preDraftBookingId, {');
    expect(hookAt).toBeGreaterThan(-1);
    expect(source.slice(hookAt, hookAt + 200)).toContain('ownerProcGeneration: procGeneration');
    expect(source).toContain('.then(() => rerunBookingPreDraft())');
    // The refusing verdict travels creator → engine result → pre-draft
    // outcome (the pre-draft passthrough is exercised in
    // estimator-booking-predraft.test.js).
    const builder = fs.readFileSync(require.resolve('../services/estimator-engine/draft-builder'), 'utf8');
    const rejectedAt = builder.indexOf("reason: 'call_rejected',");
    expect(builder.slice(rejectedAt, rejectedAt + 500)).toContain('rejectedBy: rejected,');
    const engine = fs.readFileSync(require.resolve('../services/estimator-engine/index'), 'utf8');
    expect(engine).toContain('result.blockedBy = draft.duplicateBlock?.rejectedBy || null;');
  });

  test('the sweep delegates bell retirement to the shared helper on success, same contract as the pre-write pass (codex #4815 r2 P2, refined r3 P1)', () => {
    const block = priceAgreedSweepBlock();
    expect(block).toContain('await retirePriceAgreedEstimatorBell({');
    expect(block).toContain('call, callSid, callerName, callAgreedPrice, callQuotePromised,');
    expect(block).toContain('invalidated: sweepInvalidation.invalidated === true,');
  });

  // codex #4815 r3 P2: awaiting bookingPreDraftAssessmentDrafted here
  // blocked the SEQUENTIAL processAllPending batch on a minutes-long
  // composer — the sweep must be DETACHED (fire-and-forget, chained with
  // .then) rather than awaited inline in processRecording, while still
  // never running before the SAME tracked pre-draft promise settles.
  test('the sweep chains fire-and-forget (never awaited inline) onto the SAME tracked booking-predraft promise', () => {
    const block = priceAgreedSweepBlock();
    expect(block).toContain('void bookingPreDraftAssessmentDrafted(bookingPreDraftPromise).then(async (assessmentExceptionDrafted) => {');
    // Never a plain inline await of the helper — that was the r2 shape
    // this P2 fix replaced.
    expect(block).not.toContain('const assessmentExceptionDrafted = await bookingPreDraftAssessmentDrafted(bookingPreDraftPromise);');
    // The chain itself must carry a .catch — bookingPreDraftAssessmentDrafted
    // never rejects, but the fire-and-forget promise still needs one so a
    // hypothetical throw doesn't become an unhandled rejection.
    expect(block).toContain('.catch((chainErr) => {');
  });

  test('within the chained callback, a drafted exception stands the sweep down BEFORE the invalidation call is ever reached', () => {
    const block = priceAgreedSweepBlock();
    const thenAt = block.indexOf('.then(async (assessmentExceptionDrafted) => {');
    expect(thenAt).toBeGreaterThan(-1);
    const standDownAt = block.indexOf('if (assessmentExceptionDrafted) {', thenAt);
    const returnAt = block.indexOf('return;', standDownAt);
    const invalidateAt = block.indexOf('invalidateAgreedPriceAgain(call.id', standDownAt);
    expect(returnAt).toBeGreaterThan(standDownAt);
    expect(returnAt).toBeLessThan(invalidateAt);
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

  test('the processor gate and the engine-entry backstop read ONE shared resolver + formatter (codex #4815 r6 P2)', () => {
    // Two mirrored copies both dropped the billing unit; the shared module
    // is the only definition now.
    const engineSource = fs.readFileSync(require.resolve('../services/estimator-engine/index.js'), 'utf8');
    expect(source).toContain("const { resolveCallAgreedPrice, formatAgreedPriceLabel } = require('../utils/call-agreed-price');");
    expect(engineSource).toContain("const { resolveCallAgreedPrice, formatAgreedPriceLabel } = require('../../utils/call-agreed-price');");
    expect(source).not.toMatch(/function resolveCallAgreedPrice\(/);
    expect(source).not.toMatch(/function formatAgreedPriceLabel\(/);
    expect(engineSource).not.toMatch(/function formatAgreedPriceLabel\(/);
  });

  test('the identity-conflict quarantine catch reuses the SAME shared retry-lane fallback, not its own inline copy (codex #4815 r3 P1)', () => {
    const identityAt = source.indexOf("if (engineErr.quarantineFailed) {");
    expect(identityAt).toBeGreaterThan(-1);
    const identityEndAt = source.indexOf('\n          }\n        });', identityAt);
    expect(identityEndAt).toBeGreaterThan(identityAt);
    const identityBlock = source.slice(identityAt, identityEndAt);
    expect(identityBlock).toContain('await pushCallToRetryLaneAfterQuarantineFailure({');
    expect(identityBlock).toContain("reason: 'email_identity_conflict',");
    // No duplicated inline copy of the fallback (its own db('call_log')...
    // extraction_failed write) at this site any more.
    expect(identityBlock).not.toContain("processing_status: 'extraction_failed'");
  });

  test('pushCallToRetryLaneAfterQuarantineFailure and retirePriceAgreedEstimatorBell are exported for reuse/testing', () => {
    const CallRecordingProcessor = require('../services/call-recording-processor');
    expect(typeof CallRecordingProcessor._test.pushCallToRetryLaneAfterQuarantineFailure).toBe('function');
    expect(typeof CallRecordingProcessor._test.retirePriceAgreedEstimatorBell).toBe('function');
  });
});

// codex #4815 r8 P1: a verdict that lands ONLY as retry-lane state stops
// blocking once the retry budget is spent (or the call ages out) —
// callReprocessInFlight then reads the call as settled. Every path that
// routes a failed quarantine into extraction_failed therefore writes the
// verdict into the multi-entry quarantine queue in the SAME statement.
describe('processRecording — failed quarantines never ride the retry lane alone (codex #4815 r8 P1)', () => {
  test('pendingQuarantineMarker is pass-scoped: declared before the outer guard so its catch can see it', () => {
    const declAt = source.indexOf('let pendingQuarantineMarker = null;');
    expect(declAt).toBeGreaterThan(-1);
    expect(source.indexOf('let pendingQuarantineMarker = null;', declAt + 1)).toBe(-1);
    const guardAt = source.indexOf('    // Outer guard: any unhandled throw between the claim above and the');
    expect(guardAt).toBeGreaterThan(declAt);
  });

  test('the outer guard\'s extraction_failed release writes the pending verdict atomically with the retry-lane transition', () => {
    const catchAt = source.indexOf('    } catch (procErr) {\n      logger.error(`[call-proc] Unhandled error processing');
    expect(catchAt).toBeGreaterThan(-1);
    const body = source.slice(catchAt, source.indexOf('throw procErr;', catchAt));
    const updateAt = body.indexOf(".where('processing_token', procToken)");
    expect(updateAt).toBeGreaterThan(-1);
    const update = body.slice(updateAt, body.indexOf(".returning(['extraction_attempts'])", updateAt));
    expect(update).toContain("processing_status: 'extraction_failed',");
    expect(update).toContain('...(pendingQuarantineMarker ? {');
    expect(update).toContain('metadata: db.raw(QUARANTINE_QUEUE_APPEND_SQL, [');
  });

  test('the spam/voicemail verdict hands a failed queue write to that same release', () => {
    const at = source.indexOf("const rejectionReason = extracted.is_spam ? 'call_rejected_spam' : 'call_rejected_voicemail';");
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf('throw new Error(`draft invalidation failed on the', at));
    expect(block).toContain('const queued = await markQuarantinePending(call.id, rejectionReason, { procGeneration });');
    expect(block).toContain('if (!queued) pendingQuarantineMarker = { reason: rejectionReason, procGeneration };');
  });
});
