// sweepPendingAttributionTransfers — the retry lane for processor repoints
// blocked by a legacy (NULL source_call_id) row on the former lead (codex
// P1, PR #3303 r12). The processor suppresses the funnel write and persists
// metadata.attribution_transfer_pending; this sweep completes the write
// against the LIVE stamped lead once the blocking row is resolved, and
// clears the marker when the write is positively impossible.

let scanRows = [];
let scanRejects = false;
let leadRows = {};
let lockedCallRow = null;
let provenancedRow = null; // ad_service_attribution first for {source_call_id}
let legacyRowByLead = {}; // fromLeadId -> legacy NULL-provenance row
let existingByLead = {}; // leadId -> existing funnel row (record's dedup lookup)
const updates = [];
const inserts = [];

const mockDb = jest.fn((table) => {
  const b = { _wheres: [] };
  ['where', 'whereNot', 'whereRaw', 'whereNull', 'forUpdate', 'select', 'orderBy', 'orderByRaw', 'limit'].forEach((m) => {
    b[m] = (...a) => { b._wheres.push([m, ...a]); return b; };
  });
  // Real knex .modify invokes the callback with the builder — the shared
  // source-identity predicate in reconcileMovedCallAttributionRow (orphan
  // NULL-lead support, pre-push P1 r22) is applied through it.
  b.modify = (fn) => { fn.call(b, b); return b; };
  const whereObj = (key) => {
    const w = b._wheres.find((x) => x[0] === 'where' && x[1] && typeof x[1] === 'object' && key in x[1]);
    return w ? w[1][key] : undefined;
  };
  b.first = async () => {
    if (table === 'leads') {
      const id = whereObj('id');
      const row = leadRows[id];
      if (!row || row.deleted_at) return undefined;
      return row;
    }
    if (table === 'call_log') return lockedCallRow || undefined;
    if (table === 'ad_service_attribution') {
      const bySource = whereObj('source_call_id');
      if (bySource !== undefined) return provenancedRow || undefined;
      const byLead = whereObj('lead_id');
      const wantsNullProvenance = b._wheres.some((x) => x[0] === 'whereNull' && x[1] === 'source_call_id');
      if (wantsNullProvenance) return legacyRowByLead[byLead] || undefined;
      return existingByLead[byLead] || undefined;
    }
    return undefined;
  };
  b.update = (patch) => { updates.push({ table, wheres: b._wheres.slice(), patch }); return Promise.resolve(1); };
  b.insert = (row) => { inserts.push({ table, row }); return b; };
  b.onConflict = () => b;
  b.ignore = () => b;
  b.then = (res, rej) => {
    if (table === 'call_log' && scanRejects) return Promise.reject(new Error('db down')).then(res, rej);
    const val = table === 'call_log' ? scanRows : [1];
    return Promise.resolve(val).then(res, rej);
  };
  return b;
});
mockDb.raw = (sql) => sql;
mockDb.transaction = jest.fn(async (fn) => fn(mockDb));

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({
  etDateString: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '2026-08-09'),
}));

const { sweepPendingAttributionTransfers } = require('../services/ads/call-attribution');

const PENDING = {
  from_lead_id: 'lead-A',
  lead_source: 'waves_website',
  is_paid: false,
  detail: 'Sarasota city page',
  service_interest: 'Pest Control',
};

const markerClearUpdates = () => updates.filter((u) => u.table === 'call_log'
  && typeof u.patch.metadata === 'string'
  && u.patch.metadata.includes("- 'attribution_transfer_pending'"));

beforeEach(() => {
  jest.clearAllMocks();
  scanRejects = false;
  scanRows = [{ id: 'call-1', metadata: { lead_id: 'lead-B', attribution_transfer_pending: PENDING }, created_at: '2026-08-09T12:00:00Z' }];
  leadRows = { 'lead-B': { id: 'lead-B', customer_id: 'cust-1' } };
  lockedCallRow = { id: 'call-1', processing_token: null, metadata: { lead_id: 'lead-B', attribution_transfer_pending: PENDING }, created_at: '2026-08-09T12:00:00Z' };
  provenancedRow = null;
  legacyRowByLead = {};
  existingByLead = {};
  updates.length = 0;
  inserts.length = 0;
});

describe('sweepPendingAttributionTransfers', () => {
  test('a still-present legacy row on the former lead keeps the marker — the retry lane — and stamps last_attempt_at', async () => {
    legacyRowByLead['lead-A'] = { id: 'legacy-1' };

    const s = await sweepPendingAttributionTransfers();

    expect(s.blocked).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(0);
    // Fair-ordering stamp (codex P2 r13): blocked markers rotate behind
    // never-tried ones instead of pinning the scan window.
    const attemptStamps = updates.filter((u) => u.table === 'call_log'
      && typeof u.patch.metadata === 'string'
      && u.patch.metadata.includes('last_attempt_at'));
    expect(attemptStamps).toHaveLength(1);
  });

  test('a resolved legacy row completes the deferred write against the LIVE stamped lead and clears the marker', async () => {
    const s = await sweepPendingAttributionTransfers();

    expect(s.recorded).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('ad_service_attribution');
    expect(inserts[0].row).toMatchObject({
      lead_id: 'lead-B',
      customer_id: 'cust-1', // the LOCKED lead's live owner
      source_call_id: 'call-1',
      lead_source: 'waves_website', // the CALL-TIME decision from the marker
      is_paid: false,
      funnel_stage: 'lead',
    });
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a settled call with no live stamp clears the marker without writing — positively dead linkage', async () => {
    lockedCallRow.metadata = { attribution_transfer_pending: PENDING };

    const s = await sweepPendingAttributionTransfers();

    expect(s.cleared).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a re-claimed call (live processing_token) is skipped — the in-flight pass owns the decision', async () => {
    lockedCallRow.processing_token = 'tok-live';

    const s = await sweepPendingAttributionTransfers();

    expect(s.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(0);
  });

  test('an already-provenanced row ON THE LIVE LEAD clears the marker without a second write', async () => {
    provenancedRow = { id: 'row-9', lead_id: 'lead-B' };

    const s = await sweepPendingAttributionTransfers();

    expect(s.cleared).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a provenanced row on the FORMER lead (operator assigned this call) is TRANSFERRED to the live lead, not abandoned', async () => {
    // codex P1 r13: clearing here stranded funnel history on the obsolete
    // lead while the durable stamp named the new one.
    provenancedRow = { id: 'row-p', lead_id: 'lead-A' };

    const s = await sweepPendingAttributionTransfers();

    expect(s.recorded).toBe(1);
    expect(inserts).toHaveLength(0); // moved, never re-inserted
    const transfer = updates.find((u) => u.table === 'ad_service_attribution' && u.patch.lead_id === 'lead-B');
    expect(transfer).toBeTruthy();
    expect(transfer.patch.customer_id).toBe('cust-1'); // the locked live owner
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('an extraction_failed call (NULL token but a FAILED retryable attempt) is skipped — but attempt-stamped', async () => {
    // codex P1 r13: token-NULL alone is not settled-successful — the same
    // allowlist as callStillAttributable (processed / legacy NULL only).
    // codex P2 r14: the skip still stamps last_attempt_at — a call whose
    // retry budget is exhausted stays extraction_failed forever, and an
    // unstamped marker would sort first every scan and starve the lane.
    lockedCallRow.processing_status = 'extraction_failed';

    const s = await sweepPendingAttributionTransfers();

    expect(s.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(0); // marker survives
    const attemptStamps = updates.filter((u) => u.table === 'call_log'
      && typeof u.patch.metadata === 'string'
      && u.patch.metadata.includes('last_attempt_at'));
    expect(attemptStamps).toHaveLength(1);
  });

  test('a stamp repointed since the scan is skipped — the next run locks the right lead', async () => {
    lockedCallRow.metadata = { lead_id: 'lead-C', attribution_transfer_pending: PENDING };

    const s = await sweepPendingAttributionTransfers();

    expect(s.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(0);
  });

  test("a definitive refusal (the live lead owns ANOTHER call's row) clears the marker instead of retrying forever", async () => {
    existingByLead['lead-B'] = { id: 'row-x', lead_source: 'waves_website', source_call_id: 'call-OTHER' };

    const s = await sweepPendingAttributionTransfers();

    expect(s.cleared).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('an unclaimed live lead keeps the marker — recordCallPpcAttribution refuses a NULL owner', async () => {
    leadRows['lead-B'].customer_id = null;

    const s = await sweepPendingAttributionTransfers();

    expect(s.blocked).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(0);
  });

  test('a marker without a funnel decision clears — no producer writes payload-less markers (pre-push P0 r19)', async () => {
    const bare = { from_lead_id: 'lead-A' };
    scanRows = [{ id: 'call-1', metadata: { lead_id: 'lead-B', attribution_transfer_pending: bare }, created_at: '2026-08-09T12:00:00Z' }];
    lockedCallRow.metadata = { lead_id: 'lead-B', attribution_transfer_pending: bare };

    const s = await sweepPendingAttributionTransfers();

    expect(s.cleared).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a scan failure reports scanFailed so the cron can surface degradation in job health', async () => {
    // codex P2 r16: the internal catch returned a zeroed summary the cron
    // read as a healthy tick with zero work.
    scanRejects = true;

    const s = await sweepPendingAttributionTransfers();

    expect(s.scanFailed).toBe(true);
    expect(s.scanned).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('a durable no_attribution verdict clears the marker — the non-lead call can never take the write', async () => {
    lockedCallRow.metadata = { lead_id: 'lead-B', no_attribution: true, attribution_transfer_pending: PENDING };

    const s = await sweepPendingAttributionTransfers();

    expect(s.cleared).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a STAMP-LESS marker naming its target (to_lead_id) records against that lead instead of clearing (codex P1 r19)', async () => {
    // reconcileFormerLeadLinkage's relink is deliberately stamp-less
    // (gained-phone / sid-linked) — deriving the target exclusively from
    // metadata.lead_id read this marker as positively-cleared linkage and
    // deleted it without writing the attribution it carried.
    const pending = { ...PENDING, to_lead_id: 'lead-B' };
    scanRows = [{ id: 'call-1', metadata: { attribution_transfer_pending: pending }, created_at: '2026-08-09T12:00:00Z' }];
    lockedCallRow = { id: 'call-1', processing_token: null, metadata: { attribution_transfer_pending: pending }, created_at: '2026-08-09T12:00:00Z' };

    const s = await sweepPendingAttributionTransfers();

    expect(s.recorded).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({ lead_id: 'lead-B', customer_id: 'cust-1', source_call_id: 'call-1' });
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a live stamp takes PRECEDENCE over the marker-named target — a repoint re-decides the lead (codex P1 r19)', async () => {
    const pending = { ...PENDING, to_lead_id: 'lead-B' };
    const md = { lead_id: 'lead-C', attribution_transfer_pending: pending };
    scanRows = [{ id: 'call-1', metadata: md, created_at: '2026-08-09T12:00:00Z' }];
    lockedCallRow = { id: 'call-1', processing_token: null, metadata: md, created_at: '2026-08-09T12:00:00Z' };
    leadRows = { 'lead-C': { id: 'lead-C', customer_id: 'cust-9' } };

    const s = await sweepPendingAttributionTransfers();

    expect(s.recorded).toBe(1);
    expect(inserts[0].row).toMatchObject({ lead_id: 'lead-C', customer_id: 'cust-9' });
  });

  test('a REJECTION-REPAIR marker (no from_lead_id) records without touching the legacy-row lane (codex P1 r20)', async () => {
    // The processor arms this when it clears a no_attribution verdict on a
    // pass that created no lead: there is no former lead to wait on, and
    // an undefined binding on the legacy check would throw the sweep into
    // its failure lane forever.
    const repair = {
      to_lead_id: 'lead-B',
      lead_source: 'waves_website',
      is_paid: false,
      detail: 'Sarasota city page',
      service_interest: 'Pest Control',
      repair_of_rejection: true,
    };
    const md = { attribution_transfer_pending: repair };
    scanRows = [{ id: 'call-1', metadata: md, created_at: '2026-08-09T12:00:00Z' }];
    lockedCallRow = { id: 'call-1', processing_token: null, metadata: md, created_at: '2026-08-09T12:00:00Z' };
    // A legacy row keyed to UNDEFINED must never be consulted.
    legacyRowByLead[undefined] = { id: 'should-not-be-read' };

    const s = await sweepPendingAttributionTransfers();

    expect(s.failed).toBe(0);
    expect(s.recorded).toBe(1);
    expect(inserts[0].row).toMatchObject({ lead_id: 'lead-B', customer_id: 'cust-1', source_call_id: 'call-1' });
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a REPAIR marker RECLAIMS the legacy row this rejection demoted, instead of retrying forever (codex P1 r25)', async () => {
    // The retire preserves history by clearing source_call_id, so the
    // corrected pass finds a legacy row on the live lead and
    // recordCallPpcAttribution refuses with 'unprovenanced_row' — a retry
    // lane that for a repair marker can never resolve on its own.
    const repair = {
      to_lead_id: 'lead-B',
      lead_source: 'waves_website',
      is_paid: false,
      detail: 'Sarasota city page',
      repair_of_rejection: true,
    };
    const md = { attribution_transfer_pending: repair };
    scanRows = [{ id: 'call-1', metadata: md, created_at: '2026-08-09T12:00:00Z' }];
    lockedCallRow = { id: 'call-1', processing_token: null, metadata: md, created_at: '2026-08-09T12:00:00Z' };
    // The lead already carries the demoted (NULL-provenance) row.
    existingByLead['lead-B'] = { id: 'asa-legacy', lead_source: 'waves_website' };

    const s = await sweepPendingAttributionTransfers();

    expect(s.recorded).toBe(1);
    expect(s.blocked).toBe(0);
    const reclaim = updates.find((u) => u.table === 'ad_service_attribution'
      && u.patch.source_call_id === 'call-1');
    expect(reclaim).toBeTruthy();
    // Conditioned on the row still being unprovenanced.
    expect(reclaim.wheres).toContainEqual(['whereNull', 'source_call_id']);
    expect(markerClearUpdates()).toHaveLength(1);
  });

  test('a stamp-less marker whose target lead is gone/soft-deleted clears — the lock re-applies the live predicate (codex P1 r19)', async () => {
    const pending = { ...PENDING, to_lead_id: 'lead-B' };
    scanRows = [{ id: 'call-1', metadata: { attribution_transfer_pending: pending }, created_at: '2026-08-09T12:00:00Z' }];
    lockedCallRow = { id: 'call-1', processing_token: null, metadata: { attribution_transfer_pending: pending }, created_at: '2026-08-09T12:00:00Z' };
    leadRows = { 'lead-B': { id: 'lead-B', customer_id: 'cust-1', deleted_at: '2026-08-09' } };

    const s = await sweepPendingAttributionTransfers();

    expect(s.cleared).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(markerClearUpdates()).toHaveLength(1);
  });
});
