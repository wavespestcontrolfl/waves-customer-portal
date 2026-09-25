/**
 * Owner ruling 2026-09-24 ("the spoken word beats the estimator"): the
 * $300 flea call — "just to confirm one more time, it's $300, that's two
 * treatments" / "Yep" — still spawned a $387 estimator-engine draft two
 * minutes later. maybeDraftEstimateForCall must refuse to draft for any
 * call that already carries an agreed price UNLESS the caller explicitly
 * asserts quotePromised (a written quote can still be genuinely owed even
 * though a verbal price was also agreed — that path is kept running).
 *
 * This is the ENGINE-ENTRY backstop (server/services/estimator-engine/index.js),
 * independent of the call-recording-processor's own upstream check, so
 * every other caller (booking-predraft, admin re-draft, the replay CLI)
 * gets the same refusal. Drives maybeDraftEstimateForCall directly with
 * context-builder mocked; fixtures fictitious (555-01xx numbers).
 *
 * codex #4815 r1 P1s: the agreed-price signal is V2 ONLY (a V1-only call
 * never gates the engine — downstream composer decisions never read the
 * unvalidated V1 blob), and V2's OWN narrower `quoted_price_usd` field
 * counts on its own, independent of the broader `price` object.
 */

let mockCallRow;
jest.mock('../models/db', () => {
  const db = (table) => ({
    where() { return this; },
    whereRaw() { return this; },
    whereNull() { return this; },
    orderBy() { return this; },
    select() { return this; },
    limit() { return this; },
    async first() { return table === 'call_log' ? mockCallRow : null; },
    async update() { return 1; },
  });
  db.transaction = async (cb) => cb(db);
  db.raw = () => ({});
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockExtractionFromCall = jest.fn();
const mockBuildCallContext = jest.fn();
const mockExistingDraftForCall = jest.fn();
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: (...args) => mockBuildCallContext(...args),
  existingDraftForCall: (...args) => mockExistingDraftForCall(...args),
  _private: { extractionFromCall: (...args) => mockExtractionFromCall(...args) },
}));

const { maybeDraftEstimateForCall, _private: { formatAgreedPriceLabel } } = require('../services/estimator-engine');

beforeEach(() => {
  jest.clearAllMocks();
  mockCallRow = { id: 'call-1' };
  mockBuildCallContext.mockRejectedValue(new Error('test stub — context not needed for this assertion'));
  mockExistingDraftForCall.mockResolvedValue(null);
});

describe('maybeDraftEstimateForCall — agreed-price refusal (owner ruling 2026-09-24)', () => {
  test('quotePromised=false + V2 accepted price on the call ⇒ skipped without ever building context', async () => {
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 300, accepted: true, caller_response: 'accepted', stated_by: 'agent' } } },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false });

    expect(result.skipped).toBe('price_agreed_on_call');
    expect(mockBuildCallContext).not.toHaveBeenCalled();
  });

  test('quotePromised=false + V2 quoted_price_usd on the call (no price object at all) ⇒ skipped', async () => {
    // The schema's own narrower "agent quoted AND caller accepted" field —
    // codex #4815 r1 P1 — must gate the engine on its own, independent of
    // the broader price/prices[] object.
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { quoted_price_usd: 300 } },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false });

    expect(result.skipped).toBe('price_agreed_on_call');
    expect(mockBuildCallContext).not.toHaveBeenCalled();
  });

  test('quotePromised=false + V1 quoted_price/appointment_confirmed, but NO valid V2 extraction ⇒ the engine still runs', async () => {
    // codex #4815 r1 P1: downstream composer decisions read V2 plus the
    // raw transcript, never the unvalidated V1 blob — a V1-only call
    // (extractionFromCall source 'v1') must never suppress a legitimate
    // draft, however price-like its V1 fields look.
    mockExtractionFromCall.mockReturnValue({
      source: 'v1',
      extraction: { quoted_price: 387, appointment_confirmed: true },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false });

    expect(result.skipped).not.toBe('price_agreed_on_call');
    expect(mockBuildCallContext).toHaveBeenCalledWith('call-1');
  });

  test('quotePromised=false + quote-REQUESTED call with no agreed price ⇒ the engine still runs', async () => {
    // The exact contrast case: a caller who asked for pricing but never
    // agreed to a figure must still get the normal drafting attempt.
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { quote_requested: true, price: undefined } },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false });

    expect(result.skipped).not.toBe('price_agreed_on_call');
    expect(mockBuildCallContext).toHaveBeenCalledWith('call-1');
  });

  test('quotePromised=false + a DECLINED price (not agreed) ⇒ the engine still runs', async () => {
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 387, accepted: false, caller_response: 'declined' } } },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false });

    expect(result.skipped).not.toBe('price_agreed_on_call');
    expect(mockBuildCallContext).toHaveBeenCalledWith('call-1');
  });

  test('quotePromised=true (a written quote is genuinely owed) ⇒ engine still runs even with an agreed price', async () => {
    // "keep that path" — an assessment/booking delegation or a real
    // promise to send a written quote must not be swallowed by this
    // refusal just because a verbal price was also agreed on the call.
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 300, accepted: true } } },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: true });

    expect(result.skipped).not.toBe('price_agreed_on_call');
    expect(mockBuildCallContext).toHaveBeenCalledWith('call-1');
  });

  test('omitted quotePromised is NOT the written-quote exception (codex #4815 r4 P2) — the replay CLI\'s dry run is skipped like the live processor', async () => {
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 300, accepted: true } } },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', dryRun: true });

    expect(result.skipped).toBe('price_agreed_on_call');
    expect(mockBuildCallContext).not.toHaveBeenCalled();
  });

  test('omitted quotePromised with no agreed price still drafts', async () => {
    mockExtractionFromCall.mockReturnValue({ source: 'enriched', extraction: { service_request: {} } });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', dryRun: true });

    expect(result.skipped).not.toBe('price_agreed_on_call');
    expect(mockBuildCallContext).toHaveBeenCalledWith('call-1');
  });

  test('a clarify-reply re-price (supersedeEstimateId set) is never blocked by the pre-check', async () => {
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 300, accepted: true } } },
    });

    const result = await maybeDraftEstimateForCall({
      callLogId: 'call-1',
      quotePromised: false,
      supersedeEstimateId: 'est-1',
    });

    expect(result.skipped).not.toBe('price_agreed_on_call');
    expect(mockBuildCallContext).toHaveBeenCalledWith('call-1');
  });

  // codex #4815 r3 P1: this backstop is deliberately FAIL-OPEN on a read
  // error, unlike sweepPendingQuarantines's use of the same resolver (which
  // must fail CLOSED — leave a durable block standing rather than clear it
  // on a blip). This is the SECOND layer behind the processor's own primary
  // check, which already refused to invoke this function at all for a
  // plain agreed-price call — a transient failure here only loses this one
  // defensive layer for this one call, never eats a genuine draft the
  // processor already correctly allowed through.
  test('a resolveAgreedPriceForCall READ ERROR fails OPEN — the engine still runs (this is a backstop, not the primary gate)', async () => {
    mockExtractionFromCall.mockImplementation(() => {
      throw new Error('transient read failure');
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false });

    expect(result.skipped).not.toBe('price_agreed_on_call');
    expect(mockBuildCallContext).toHaveBeenCalledWith('call-1');
  });

  // codex #4815 r3 P2: a genuinely accepted RANGE still gates the engine
  // (there is no single engine number to draft from either way) — the
  // range-vs-exact distinction only matters for how it's REPORTED
  // (formatAgreedPriceLabel), not whether it gates.
  test('quotePromised=false + an accepted RANGE (amount_usd low end + amount_max_usd high end) ⇒ still skipped', async () => {
    mockExtractionFromCall.mockReturnValue({
      source: 'enriched',
      extraction: { service_request: { price: { amount_usd: 90, amount_max_usd: 100, accepted: true } } },
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false });

    expect(result.skipped).toBe('price_agreed_on_call');
    expect(mockBuildCallContext).not.toHaveBeenCalled();
  });
});

describe('estimator-engine formatAgreedPriceLabel (mirrors the processor\'s own formatter)', () => {
  test('exact vs range, same contract as call-recording-processor.js', () => {
    expect(formatAgreedPriceLabel({ amount: 90 })).toBe('$90.00');
    expect(formatAgreedPriceLabel({ amount: 90, amountMax: 100 })).toBe('$90.00–$100.00');
  });
});
