// clearStampAndRestoreLead — attribution disposition on calls WITHOUT a
// metadata stamp (PR #3303). Definitive retirement is provenance-only, not
// stamp-gated: a sid-linked call carries source_call_id on its funnel row
// but never a stamp, and a force-reprocess that reclassifies it
// spam/voicemail/implausible/non-lead must not leave that row reporting
// funnel stage and revenue for a rejected call.

let mockCallRow = null;
let mockTokenMatches = true;
const mockDeletes = [];

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = { _wheres: [] };
    for (const m of ['where', 'whereNull', 'whereNot', 'whereRaw', 'forUpdate', 'orderBy', 'limit', 'select', 'modify']) {
      b[m] = (...a) => { b._wheres.push([m, ...a]); return b; };
    }
    b.first = async (...cols) => {
      if (table !== 'call_log') return undefined;
      const fenced = b._wheres.some((w) => w[0] === 'where' && w[1] === 'processing_token');
      if (fenced) return mockTokenMatches ? { id: 'call-1' } : undefined;
      if (cols.includes('metadata')) return mockCallRow;
      return mockCallRow;
    };
    b.update = async () => (mockTokenMatches ? 1 : 0);
    b.del = async () => { mockDeletes.push({ table, wheres: b._wheres.slice() }); return 1; };
    b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return b;
  };
  const db = (table) => makeBuilder(table);
  db.raw = (sql) => sql;
  db.transaction = async (fn) => fn(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CallRecordingProcessor = require('../services/call-recording-processor');
const { clearStampAndRestoreLead } = CallRecordingProcessor._test;

const CALL = { id: 'call-1', twilio_call_sid: 'CA-sid-linked' };

beforeEach(() => {
  mockCallRow = { metadata: {} }; // sid-linked: NO metadata.lead_id stamp
  mockTokenMatches = true;
  mockDeletes.length = 0;
});

describe('clearStampAndRestoreLead without a stamp (sid-linked call)', () => {
  test("mode 'retire' still retires the call's funnel rows by provenance alone", async () => {
    const ok = await clearStampAndRestoreLead(CALL, 'tok-1', 'CA-sid-linked', null, { mode: 'retire' });

    expect(ok).toBe(true);
    const attributionDeletes = mockDeletes.filter((d) => d.table === 'ad_service_attribution');
    expect(attributionDeletes).toHaveLength(1);
    // Provenance-wide: keyed on source_call_id only — no lead_id filter,
    // because rejection means the call supports no lead at all.
    expect(attributionDeletes[0].wheres).toContainEqual(['where', { source_call_id: 'call-1' }]);
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
