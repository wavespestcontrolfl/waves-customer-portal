// clearStampAndRestoreLead — attribution disposition on calls WITHOUT a
// metadata stamp (PR #3303). Definitive retirement is provenance-only, not
// stamp-gated: a sid-linked call carries source_call_id on its funnel row
// but never a stamp, and a force-reprocess that reclassifies it
// spam/voicemail/implausible/non-lead must not leave that row reporting
// funnel stage and revenue for a rejected call.

let mockCallRow = null;
let mockTokenMatches = true;
let mockSuccessorRow; // the retire primitives' settled-successor scan
let mockAttributionRows = []; // retireAll's affected-leads read
let mockAttrFirstQueue = []; // ordered ad_service_attribution .first reads
const mockDeletes = [];
const mockUpdates = [];

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = { _wheres: [] };
    for (const m of ['where', 'whereNull', 'whereNot', 'whereRaw', 'whereNotExists', 'forUpdate', 'orderBy', 'limit', 'select', 'modify']) {
      b[m] = (...a) => { b._wheres.push([m, ...a]); return b; };
    }
    b.first = async (...cols) => {
      // reconcileMovedCallAttributionRow's ordered row reads (old row →
      // conflict → stranded-legacy) consume a queue; default undefined
      // preserves the legacy no-row behavior.
      if (table === 'ad_service_attribution') {
        return mockAttrFirstQueue.length ? mockAttrFirstQueue.shift() : undefined;
      }
      if (table !== 'call_log') return undefined;
      const fenced = b._wheres.some((w) => w[0] === 'where' && w[1] === 'processing_token');
      // Fenced ownership reads carry the row's live metadata too (the
      // former-lead reconciliation re-reads the breadcrumb under the lock).
      if (fenced) return mockTokenMatches ? { id: 'call-1', ...(mockCallRow || {}) } : undefined;
      // The retire primitives' settled-successor scan is the only ordered
      // call_log read (orderBy created_at desc).
      if (b._wheres.some((w) => w[0] === 'orderBy')) return mockSuccessorRow;
      if (cols.includes('metadata')) return mockCallRow;
      return mockCallRow;
    };
    b.update = async (patch) => {
      mockUpdates.push({ table, wheres: b._wheres.slice(), patch });
      return mockTokenMatches ? 1 : 0;
    };
    b.del = async () => { mockDeletes.push({ table, wheres: b._wheres.slice() }); return 1; };
    b.then = (resolve, reject) => Promise.resolve(
      table === 'ad_service_attribution' ? mockAttributionRows : [],
    ).then(resolve, reject);
    return b;
  };
  const db = (table) => makeBuilder(table);
  db.raw = (sql) => sql;
  db.transaction = async (fn) => fn(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Bridge-target semantics (last-10 match on the shared Bradenton number) —
// mocked so the former-lead marker gating is deterministic here.
jest.mock('../services/ads/google-call-bridge', () => ({
  isBridgeTargetNumber: (p) => String(p || '').replace(/\D/g, '').endsWith('9413187612'),
}));

const CallRecordingProcessor = require('../services/call-recording-processor');
const { clearStampAndRestoreLead, reconcileFormerLeadLinkage } = CallRecordingProcessor._test;

const CALL = { id: 'call-1', twilio_call_sid: 'CA-sid-linked' };

beforeEach(() => {
  mockCallRow = { metadata: {} }; // sid-linked: NO metadata.lead_id stamp
  mockTokenMatches = true;
  mockSuccessorRow = undefined;
  mockAttributionRows = [{ lead_id: 'lead-9' }]; // one funnel row for the call
  mockAttrFirstQueue = [];
  mockDeletes.length = 0;
  mockUpdates.length = 0;
});

describe('clearStampAndRestoreLead without a stamp (sid-linked call)', () => {
  test("mode 'retire' still retires the call's funnel rows by provenance alone", async () => {
    const ok = await clearStampAndRestoreLead(CALL, 'tok-1', 'CA-sid-linked', null, { mode: 'retire' });

    expect(ok).toBe(true);
    const attributionDeletes = mockDeletes.filter((d) => d.table === 'ad_service_attribution');
    expect(attributionDeletes).toHaveLength(1);
    // Per-lead through the shared retire primitive (pre-push P0 r19):
    // rejection means THE CALL supports no lead — with no surviving
    // successor the row deletes, keyed on lead + exact provenance.
    expect(attributionDeletes[0].wheres).toContainEqual(['where', { lead_id: 'lead-9', source_call_id: 'call-1' }]);
  });

  test('a surviving settled successor INHERITS the row instead — history preserved (pre-push P0 r19)', async () => {
    mockSuccessorRow = { id: 'call-successor' };

    const ok = await clearStampAndRestoreLead(CALL, 'tok-1', 'CA-sid-linked', null, { mode: 'retire' });

    expect(ok).toBe(true);
    expect(mockDeletes.filter((d) => d.table === 'ad_service_attribution')).toHaveLength(0);
    const reassigned = mockUpdates.find((u) => u.table === 'ad_service_attribution'
      && u.patch.source_call_id === 'call-successor');
    expect(reassigned).toBeTruthy();
  });

  test('the retirement is fenced — a lost claim retires nothing and reports false', async () => {
    mockTokenMatches = false;

    const ok = await clearStampAndRestoreLead(CALL, 'tok-stale', 'CA-sid-linked', null, { mode: 'retire' });

    expect(ok).toBe(false);
    expect(mockDeletes.filter((d) => d.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test("modes 'keep' and 'transfer' touch nothing when no stamp exists", async () => {
    expect(await clearStampAndRestoreLead(CALL, 'tok-1', 'CA-sid-linked', null, { mode: 'keep' })).toBe(true);
    expect(await clearStampAndRestoreLead(CALL, 'tok-1', 'CA-sid-linked', null, { mode: 'transfer', transferToLeadId: 'lead-9' })).toBe(true);
    expect(mockDeletes).toHaveLength(0);
  });
});

describe('pre-stamp settle persists the former lead atomically with its clear (codex P1, PR #3303 r17)', () => {
  const findClear = () => mockUpdates.find((u) => u.table === 'call_log'
    && typeof u.patch.metadata === 'string'
    && u.patch.metadata.includes("- 'lead_id'"));

  test("mode 'keep' + preserveFormerLeadId writes attribution_former_lead_id in the SAME fenced clear", async () => {
    // The settle commits before the replacement stamp's transaction — if
    // that later transaction fails, the retry has no preSettleStampedLeadId
    // and would skip the legacy-blocker check, double-counting the call.
    mockCallRow = { metadata: { lead_id: 'lead-A' } };

    const ok = await clearStampAndRestoreLead(CALL, 'tok-1', 'CA-sid-linked', null, { mode: 'keep', preserveFormerLeadId: true });

    expect(ok).toBe(true);
    const clear = findClear();
    expect(clear).toBeTruthy();
    expect(clear.patch.metadata).toContain('attribution_former_lead_id');
    expect(clear.wheres).toContainEqual(['where', 'processing_token', 'tok-1']);
  });

  test("a plain 'keep' clear writes no breadcrumb", async () => {
    mockCallRow = { metadata: { lead_id: 'lead-A' } };

    await clearStampAndRestoreLead(CALL, 'tok-1', 'CA-sid-linked', null, { mode: 'keep' });

    const clear = findClear();
    expect(clear).toBeTruthy();
    expect(clear.patch.metadata).not.toContain('attribution_former_lead_id');
  });
});

describe('reconcileFormerLeadLinkage — stamp-less breadcrumb consumption (codex P1 r18)', () => {
  const SOURCE = { source_type: 'main_site', name: 'Sarasota city page', twilio_phone_number: '+19415550001' };
  const baseArgs = () => ({
    call: CALL,
    procToken: 'tok-1',
    callSid: 'CA-sid-linked',
    leadId: 'lead-new',
    leadSourceRow: SOURCE,
    extracted: { matched_service: 'Pest Control' },
    customerId: 'cust-1',
  });
  const callLogMetaUpdates = () => mockUpdates.filter((u) => u.table === 'call_log'
    && typeof u.patch.metadata === 'string');

  test('a stranded legacy row on the breadcrumb lead suppresses the write, arms the marker, and consumes the breadcrumb — one fenced update', async () => {
    mockCallRow = { metadata: { attribution_former_lead_id: 'lead-old' } };
    // reconcile: no provenanced row on the former lead ('none'), then the
    // stranded NULL-provenance read finds the frozen legacy row.
    mockAttrFirstQueue = [undefined, { id: 'legacy-row' }];

    const res = await reconcileFormerLeadLinkage(baseArgs());

    expect(res.conflictRetired).toBe(true);
    const writes = callLogMetaUpdates();
    expect(writes).toHaveLength(1);
    expect(writes[0].patch.metadata).toContain('attribution_transfer_pending');
    expect(writes[0].patch.metadata).toContain("- 'attribution_former_lead_id'");
    expect(writes[0].wheres).toContainEqual(['where', 'processing_token', 'tok-1']);
  });

  test('marker gating matches the stamped path — no customer, no marker; the breadcrumb still clears and the write stays suppressed', async () => {
    mockCallRow = { metadata: { attribution_former_lead_id: 'lead-old' } };
    mockAttrFirstQueue = [undefined, { id: 'legacy-row' }];

    const res = await reconcileFormerLeadLinkage({ ...baseArgs(), customerId: null });

    expect(res.conflictRetired).toBe(true);
    const writes = callLogMetaUpdates();
    expect(writes).toHaveLength(1);
    expect(writes[0].patch.metadata).not.toContain('attribution_transfer_pending');
    expect(writes[0].patch.metadata).toContain("- 'attribution_former_lead_id'");
  });

  test("the breadcrumb's row MOVES to the new lead when nothing blocks it, and the breadcrumb clears", async () => {
    mockCallRow = { metadata: { attribution_former_lead_id: 'lead-old' } };
    // reconcile: the former lead's provenanced row exists, the target slot
    // is empty → transferred.
    mockAttrFirstQueue = [{ id: 'row-1' }, undefined];

    const res = await reconcileFormerLeadLinkage(baseArgs());

    expect(res.conflictRetired).toBe(false);
    const moved = mockUpdates.find((u) => u.table === 'ad_service_attribution'
      && u.patch.lead_id === 'lead-new');
    expect(moved).toBeTruthy();
    const writes = callLogMetaUpdates();
    expect(writes).toHaveLength(1);
    expect(writes[0].patch.metadata).toContain("- 'attribution_former_lead_id'");
    expect(writes[0].patch.metadata).not.toContain('attribution_transfer_pending');
  });

  test('a same-lead breadcrumb (linkage returned home) clears without reconciliation', async () => {
    mockCallRow = { metadata: { attribution_former_lead_id: 'lead-new' } };
    mockAttrFirstQueue = [{ id: 'row-should-not-be-read' }];

    const res = await reconcileFormerLeadLinkage(baseArgs());

    expect(res.conflictRetired).toBe(false);
    // No reconcile reads consumed, no funnel-row mutations.
    expect(mockAttrFirstQueue).toHaveLength(1);
    expect(mockUpdates.filter((u) => u.table === 'ad_service_attribution')).toHaveLength(0);
    const writes = callLogMetaUpdates();
    expect(writes).toHaveLength(1);
    expect(writes[0].patch.metadata).toContain("- 'attribution_former_lead_id'");
  });

  test('a breadcrumb the stamp transaction already consumed no-ops under the lock', async () => {
    mockCallRow = { metadata: {} }; // fresh fenced read: breadcrumb gone

    const res = await reconcileFormerLeadLinkage(baseArgs());

    expect(res.conflictRetired).toBe(false);
    expect(callLogMetaUpdates()).toHaveLength(0);
    expect(mockUpdates.filter((u) => u.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test("a live-stamp TRANSFER's former lead is re-checked breadcrumb-less — clean 'none' writes nothing", async () => {
    mockCallRow = { metadata: {} }; // transfer settle already cleared the stamp
    mockAttrFirstQueue = [undefined, undefined]; // row already moved; no stranded legacy

    const res = await reconcileFormerLeadLinkage({ ...baseArgs(), transferredFormerLeadId: 'lead-old' });

    expect(res.conflictRetired).toBe(false);
    expect(callLogMetaUpdates()).toHaveLength(0);
  });

  test("a live-stamp TRANSFER blocked by a legacy row still suppresses and arms the marker", async () => {
    mockCallRow = { metadata: {} };
    mockAttrFirstQueue = [undefined, { id: 'legacy-row' }];

    const res = await reconcileFormerLeadLinkage({ ...baseArgs(), transferredFormerLeadId: 'lead-old' });

    expect(res.conflictRetired).toBe(true);
    const writes = callLogMetaUpdates();
    expect(writes).toHaveLength(1);
    expect(writes[0].patch.metadata).toContain('attribution_transfer_pending');
  });

  test('fence loss aborts into the retry lane — nothing reconciled', async () => {
    mockCallRow = { metadata: { attribution_former_lead_id: 'lead-old' } };
    mockTokenMatches = false;

    await expect(reconcileFormerLeadLinkage(baseArgs())).rejects.toMatchObject({ abortProcessing: true });
    expect(mockUpdates.filter((u) => u.table === 'ad_service_attribution')).toHaveLength(0);
    expect(callLogMetaUpdates()).toHaveLength(0);
  });

  test('the bridge-target number never gets a marker (its own rescan owns the story)', async () => {
    mockCallRow = { metadata: { attribution_former_lead_id: 'lead-old' } };
    mockAttrFirstQueue = [undefined, { id: 'legacy-row' }];

    const res = await reconcileFormerLeadLinkage({
      ...baseArgs(),
      leadSourceRow: { ...SOURCE, twilio_phone_number: '+19413187612' },
    });

    expect(res.conflictRetired).toBe(true);
    const writes = callLogMetaUpdates();
    expect(writes).toHaveLength(1);
    expect(writes[0].patch.metadata).not.toContain('attribution_transfer_pending');
  });
});
