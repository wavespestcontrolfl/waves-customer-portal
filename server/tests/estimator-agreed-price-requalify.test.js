/**
 * codex #4815 r6 (P0 + P1) — the agreed-price call marker is ROW-SCOPED.
 *
 * P0: an agreed-price reprocess leaves an ACCEPTED estimate untouched, but
 * the call-level estimator_draft_block it writes used to be applied to
 * EVERY engine draft of the call by callSideBlockForEstimateData and
 * staleCallLinkageReason — so the accepted estimate's public token and
 * customer operations were rejected anyway. Every reader now goes through
 * ONE predicate (callDraftVerdict): a row-scoped verdict blocks only the
 * rows it marked; call-wide verdicts (identity conflict, spam/voicemail)
 * are unchanged.
 *
 * P1: a re-qualified call (agreed price corrected away, or the Waves
 * Assessment exception) could never draft again — the creators' in-lock
 * callRejectedForDrafting refused the insert while the marker stood, and
 * the marker was only cleared AFTER a successful insert. The engine now
 * SUPERSEDES the row-scoped marker (generation-fenced) after the
 * existing-draft branch and before the pipeline, and creators read a
 * superseded row-scoped marker as no longer refusing NEW drafts, while the
 * stale rows it already marked stay blocked through their own stamps.
 *
 * Fixtures fictitious (call-1 / est-*); no real customer data.
 */

let mockCallRow;
const mockOps = [];
jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const op = { table, whereRaw: [] };
    const b = {};
    for (const m of ['where', 'orWhere', 'orWhereNull', 'whereNull', 'whereNotIn', 'orderBy', 'select', 'forUpdate', 'limit']) {
      b[m] = (...a) => {
        if (typeof a[0] === 'function') a[0].call(b, b);
        return b;
      };
    }
    b.whereRaw = (sql, bindings) => { op.whereRaw.push({ sql, bindings }); return b; };
    b.first = async () => (table === 'call_log' ? mockCallRow : null);
    b.update = async (row) => { mockOps.push({ ...op, update: row }); return 1; };
    b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return b;
  };
  const db = (table) => makeBuilder(table);
  db.raw = (sql, bindings) => ({ sql, bindings });
  db.transaction = async (fn) => fn(db);
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
// The pipeline itself is not under test: a composer that fails schema
// validation ends it RED right after property gathering.
const mockComposeIntent = jest.fn(async () => ({ intent: null, errors: ['test stub'] }));
jest.mock('../services/estimator-engine/intent-composer', () => ({
  composeIntent: (...args) => mockComposeIntent(...args),
}));

const { maybeDraftEstimateForCall } = require('../services/estimator-engine');
const {
  callRejectedForDrafting, staleCallLinkageReason, completePendingInvalidation,
} = require('../services/admin-estimate-persistence');
const { callSideBlockForEstimateData, callDraftVerdict } = require('../utils/estimate-claim-sql');

const agreedBlock = (extra = {}) => ({ reason: 'price_agreed_on_call', at: '2026-09-25T07:00:00.000Z', generation: 5, ...extra });
const engineData = (eng = {}) => ({ estimatorEngine: { callLogId: 'call-1', ...eng } });

const supersedeWrites = () => mockOps.filter((o) => o.table === 'call_log'
  && typeof o.update?.metadata?.sql === 'string' && o.update.metadata.bindings?.[0]?.includes('superseded_at'));

beforeEach(() => {
  jest.clearAllMocks();
  mockOps.length = 0;
  mockCallRow = {
    id: 'call-1', processing_status: 'processed', processing_token: null, processing_generation: 5,
    metadata: { estimator_draft_block: agreedBlock() },
  };
});

describe('P0 — an agreed-price marker never blocks rows it did not mark', () => {
  test('an ACCEPTED estimate of the call keeps its token: callSideBlockForEstimateData and staleCallLinkageReason both pass it', async () => {
    const accepted = engineData({ lane: 'green' });
    await expect(callSideBlockForEstimateData(require('../models/db'), accepted)).resolves.toBeNull();
    await expect(staleCallLinkageReason(require('../models/db'), accepted)).resolves.toBeNull();
  });

  test('the stale draft the verdict ARCHIVED, or DEFERRED behind a live send, stays blocked on every reader', async () => {
    const db = require('../models/db');
    const archived = engineData({ linkage_invalidated_at: '2026-09-25T07:00:01Z', invalidation_reason: 'price_agreed_on_call' });
    const deferred = engineData({ invalidation_pending_at: '2026-09-25T07:00:01Z', invalidation_pending_reason: 'price_agreed_on_call' });
    for (const data of [archived, deferred]) {
      await expect(callSideBlockForEstimateData(db, data)).resolves.toBe('price_agreed_on_call');
      await expect(staleCallLinkageReason(db, data)).resolves.toBe('call_draft_block');
    }
  });

  test('a CALL-WIDE verdict (identity conflict) still blocks every row, accepted included — unchanged', async () => {
    mockCallRow.metadata = { estimator_draft_block: { reason: 'email_identity_conflict', at: 'x', generation: 5 } };
    const db = require('../models/db');
    await expect(callSideBlockForEstimateData(db, engineData())).resolves.toBe('email_identity_conflict');
    await expect(staleCallLinkageReason(db, engineData())).resolves.toBe('call_draft_block');
  });

  test('a QUEUED agreed-price quarantine (the invalidation never landed) still fails closed for every row', () => {
    const md = { estimator_quarantine_pending: { reason: 'price_agreed_on_call', at: 'x', generation: 5 } };
    expect(callDraftVerdict(md, { estimateData: engineData() })).toEqual({ marker: 'quarantine_pending', reason: 'price_agreed_on_call' });
  });

  test('a deferred agreed-price invalidation meeting a row the customer ACCEPTED in the meantime is dropped, never stamped', async () => {
    const trxWrites = [];
    const trx = (table) => ({
      where() { return this; },
      update: async (row) => { trxWrites.push({ table, row }); return 1; },
    });
    trx.fn = { now: () => 'now()' };
    const data = engineData({ lane: 'green' });
    const out = await completePendingInvalidation(trx, 'est-accepted', {
      row: { status: 'accepted', archived_at: null },
      data,
      pending: { at: 'x', reason: 'price_agreed_on_call', generation: 5 },
    });
    expect(out).toMatchObject({ obsolete: true, status: 'accepted' });
    expect(trxWrites).toHaveLength(1);
    const written = JSON.parse(trxWrites[0].row.estimate_data);
    expect(written.estimatorEngine.linkage_invalidated_at).toBeUndefined();
    expect(trxWrites[0].row.archived_at).toBeUndefined();
    expect(trxWrites[0].row.status).toBeUndefined();
  });

  test('a scoped marker write never DOWNGRADES a standing call-wide marker', async () => {
    const { invalidateDraftForCall } = require('../services/estimator-engine');
    await invalidateDraftForCall('call-1', { reason: 'price_agreed_on_call', scope: 'nonterminal_drafts' });
    const markerWrite = mockOps.find((o) => o.table === 'call_log' && String(o.update?.metadata?.sql).includes('estimator_draft_block'));
    expect(markerWrite.update.metadata.sql).toMatch(/NOT IN \('', 'price_agreed_on_call'\)\s+THEN COALESCE\(metadata, '\{\}'::jsonb\)/);
    mockOps.length = 0;
    await invalidateDraftForCall('call-1', { reason: 'email_identity_conflict', identityConflict: true });
    const wideWrite = mockOps.find((o) => o.table === 'call_log' && String(o.update?.metadata?.sql).includes('estimator_draft_block'));
    expect(wideWrite.update.metadata.sql).not.toContain('CASE');
  });
});

describe('P1 — a re-qualified call can draft again', () => {
  test('creators refuse NEW drafts while the agreed-price marker stands, and accept once it is superseded', async () => {
    const db = require('../models/db');
    await expect(callRejectedForDrafting(db, 'call-1', { lockCallRow: true })).resolves.toBe('price_agreed_on_call');
    mockCallRow.metadata = { estimator_draft_block: agreedBlock({ superseded_at: '2026-09-25T07:05:00Z', superseded_by_generation: 5 }) };
    await expect(callRejectedForDrafting(db, 'call-1', { lockCallRow: true })).resolves.toBeNull();
    // …while the stale draft it archived stays dead through its own stamp.
    const archived = engineData({ linkage_invalidated_at: 'y', invalidation_reason: 'price_agreed_on_call' });
    await expect(callSideBlockForEstimateData(db, archived)).resolves.toBe('price_agreed_on_call');
  });

  test('superseded_at never lifts a CALL-WIDE verdict or a queued quarantine for creators', () => {
    expect(callDraftVerdict({ estimator_draft_block: { reason: 'email_identity_conflict', superseded_at: 'z' } }, { forNewDraft: true }))
      .toEqual({ marker: 'draft_block', reason: 'email_identity_conflict' });
    expect(callDraftVerdict({
      estimator_draft_block: agreedBlock({ superseded_at: 'z' }),
      estimator_quarantine_pending: { reason: 'price_agreed_on_call', at: 'x', generation: 5 },
    }, { forNewDraft: true })).toEqual({ marker: 'quarantine_pending', reason: 'price_agreed_on_call' });
  });

  test.each([
    ['the agreed price was corrected away (successful read, no agreed price)', { quotePromised: false }, { service_request: { quote_requested: true } }],
    ['the Waves Assessment exception (explicit quotePromised)', { quotePromised: true }, { service_request: { price: { amount_usd: 300, accepted: true } } }],
  ])('%s ⇒ the engine supersedes the block, generation-fenced, BEFORE the pipeline composes', async (_label, args, extraction) => {
    mockExtractionFromCall.mockReturnValue({ source: 'enriched', extraction });
    mockBuildCallContext.mockResolvedValue({ call: { id: 'call-1' }, extraction: {} });
    mockExistingDraftForCall.mockResolvedValue(null);
    mockComposeIntent.mockImplementation(async () => {
      // The supersede has already landed by the time anything composes.
      expect(supersedeWrites()).toHaveLength(1);
      return { intent: null, errors: ['test stub'] };
    });

    await maybeDraftEstimateForCall({ callLogId: 'call-1', ownerProcGeneration: 5, ...args });

    expect(mockComposeIntent).toHaveBeenCalled();
    const [write] = supersedeWrites();
    const fence = write.whereRaw.map((w) => w.sql).join('\n');
    expect(fence).toContain("IN ('price_agreed_on_call')");
    expect(fence).toContain("superseded_at', '') = ''");
    // Generation fence: only markers of generation <= this pass's own.
    const genFence = write.whereRaw.find((w) => w.sql.includes("->>'generation')::int <= ?"));
    expect(genFence.bindings[0]).toBe(5);
    expect(JSON.parse(write.update.metadata.bindings[0])).toMatchObject({ superseded_by_generation: 5 });
  });

  test('an agreed-price READ ERROR fails open but proves nothing — no supersede', async () => {
    mockExtractionFromCall.mockImplementation(() => { throw new Error('db blip'); });
    mockBuildCallContext.mockResolvedValue({ call: { id: 'call-1' }, extraction: {} });
    mockExistingDraftForCall.mockResolvedValue(null);

    await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false, ownerProcGeneration: 5 });

    expect(mockComposeIntent).toHaveBeenCalled();
    expect(supersedeWrites()).toHaveLength(0);
  });

  test('a reusable EXISTING draft is returned as-is and nothing is superseded', async () => {
    mockExtractionFromCall.mockReturnValue({ source: 'enriched', extraction: { service_request: { quote_requested: true } } });
    mockBuildCallContext.mockResolvedValue({ call: { id: 'call-1' }, extraction: {} });
    mockExistingDraftForCall.mockResolvedValue({
      id: 'est-existing', estimate_data: JSON.stringify(engineData({ lane: 'yellow' })), monthly_total: 50, onetime_total: 0,
    });

    const result = await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false, ownerProcGeneration: 5 });

    expect(result.lane).toBe('existing');
    expect(supersedeWrites()).toHaveLength(0);
    expect(mockComposeIntent).not.toHaveBeenCalled();
  });

  test('a dry run never supersedes', async () => {
    mockExtractionFromCall.mockReturnValue({ source: 'enriched', extraction: { service_request: { quote_requested: true } } });
    mockBuildCallContext.mockResolvedValue({ call: { id: 'call-1' }, extraction: {} });

    await maybeDraftEstimateForCall({ callLogId: 'call-1', quotePromised: false, ownerProcGeneration: 5, dryRun: true });

    expect(supersedeWrites()).toHaveLength(0);
  });
});
