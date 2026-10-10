/**
 * name_spelling_differs: the card-only use of a name the caller spelled out.
 *
 * Nothing is written from the spelling. When a grounded spelling the model gave to the
 * caller differs (letters, any case) from the name being saved for the caller, ONE advisory
 * card goes to the office with the spelling, the saved name, and the caller turn. Synthetic
 * names only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const mockLock = jest.fn().mockResolvedValue(undefined);
const mockSyncStatus = jest.fn().mockResolvedValue('open');
jest.mock('../utils/triage-locks', () => ({
  lockTriageCall: (...a) => mockLock(...a),
  syncCallReviewStatus: (...a) => mockSyncStatus(...a),
}));

const fs = require('fs');
const path = require('path');
const { _test } = require('../services/call-recording-processor');
const { sanitizeNameEntries } = require('../services/contact-dictation');

const { fileNameSpellingCard } = _test;
const TURN = 'Caller: my last name is Serov, S-E-R-O-V';
const dictation = (over = {}, ...sources) => ({
  emails: [],
  addresses: [],
  names: sanitizeNameEntries([
    { raw_spoken: 'S-E-R-O-V', spelled_value: 'Serov', field: 'last_name', whose: 'caller', confidence: 0.92, ...over },
  ], sources.length ? sources : [TURN]),
});

// Minimal knex stand-in: customers.first, triage_items settled-lookup, and the insert upsert.
function makeConn({ customer = null, settled = [], claimHeld = true, openCards = 0 } = {}) {
  const writes = [];
  const settledWheres = [];
  const conn = (table) => {
    if (table === 'customers') {
      const read = async () => { conn.customerReads.push({ inTx: !!conn.locked, lockedRow: !!conn.rowLocked }); return customer; };
      return { where: () => ({ first: read, forUpdate: () => { conn.rowLocked = true; return { first: read }; } }) };
    }
    if (table === 'call_log') {
      return {
        where: (w) => ({
          forUpdate: () => ({ first: async () => { conn.fenced = w; return claimHeld ? { id: w.id } : undefined; } }),
          update: async () => 1,
          count: () => ({ first: async () => ({ n: 1 }) }),
        }),
      };
    }
    return {
      where: (w) => {
        settledWheres.push(w);
        return {
          whereIn: () => ({ select: async () => settled }),
          whereIn2: null,
          count: () => ({ first: async () => ({ n: 1 }) }),
          update: async (u) => { conn.retired.push({ where: w, update: u }); return openCards; },
        };
      },
      insert: (row) => ({
        onConflict: (target) => ({
          merge: (cols) => ({ where: async (col, val) => { writes.push({ row, target, cols, mergeWhere: [col, val] }); } }),
        }),
      }),
    };
  };
  conn.settledWheres = settledWheres;
  conn.raw = (sql) => sql;
  conn.transaction = async (fn) => { conn.locked = true; return fn(conn); };
  conn.writes = writes;
  conn.customerReads = [];
  conn.retired = [];
  return conn;
}
const dictationFor = (entries, ...sources) => ({ emails: [], addresses: [], names: sanitizeNameEntries(entries, sources) });
const file = (conn, over = {}) => fileNameSpellingCard(conn, {
  callLogId: 'call-1',
  customerId: null,
  extracted: { first_name: 'Quentrell', last_name: 'Sirov' },
  dictation: dictation(),
  v2Result: { extraction: { meta: { call_summary: 'x' } } },
  ...over,
});

describe('fileNameSpellingCard', () => {
  beforeEach(() => { mockLock.mockClear(); mockSyncStatus.mockClear(); });

  test('files ONE advisory name_review card with the spelling, saved name, caller turn and confidence', async () => {
    const conn = makeConn();
    expect(await file(conn)).toBe(true);
    expect(conn.writes).toHaveLength(1);
    const { row, target, cols } = conn.writes[0];
    expect(row).toMatchObject({ call_log_id: 'call-1', reason_code: 'name_spelling_differs', category: 'name_review', severity: 'advisory', status: 'open' });
    const payload = JSON.parse(row.payload);
    expect(payload).toMatchObject({
      flag: 'name_spelling_differs',
      field: 'last_name',
      spelled_value: 'Serov',
      saved_value: 'Sirov',
      quote: TURN,
      confidence: 0.92,
      card_text: 'Caller spelled their name S-E-R-O-V; the record says Sirov. Fix the name if the spelling is theirs.',
    });
    // One open card per call, refreshed in place on a reprocess.
    expect(target).toBe("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')");
    expect(cols).toEqual(['payload', 'summary', 'updated_at']);
    // Only an OPEN card is refreshed (an operator's in_progress card is never touched).
    expect(conn.writes[0].mergeWhere).toEqual(['triage_items.status', 'open']);
    // Read + upsert ran inside a transaction, under the per-call triage lock, and the call's review status is synced.
    expect(conn.locked).toBe(true);
    expect(mockLock).toHaveBeenCalledWith(conn, 'call-1');
    expect(mockSyncStatus).toHaveBeenCalledWith(conn, 'call-1');
  });

  test('outbound calls file nothing (outbound diarization can swap the labels)', async () => {
    const conn = makeConn();
    expect(await file(conn, { isOutbound: true })).toBe(false);
    expect(conn.writes).toEqual([]);
  });

  test('fenced to the processing claim: the token row is locked FOR UPDATE inside the transaction; a lost claim files nothing', async () => {
    const held = makeConn();
    expect(await file(held, { procToken: 'tok-1' })).toBe(true);
    expect(held.fenced).toEqual({ id: 'call-1', processing_token: 'tok-1' });
    const lost = makeConn({ claimHeld: false });
    expect(await file(lost, { procToken: 'tok-1' })).toBe(false);
    expect(lost.writes).toEqual([]);
  });

  test('only a card a HUMAN settled suppresses a re-file', async () => {
    const conn = makeConn();
    await file(conn);
    expect(conn.settledWheres).toContainEqual({ call_log_id: 'call-1', reason_code: 'name_spelling_differs', resolution_source: 'human' });
  });

  test('the payload names the customer compared against (merge-survivor-resolved list), or says it was the heard name', async () => {
    const linked = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
    await file(linked, { customerId: 'cust-1' });
    expect(JSON.parse(linked.writes[0].row.payload)).toMatchObject({
      customer_ids: ['cust-1'],
      compared_against: { source: 'customer', name: 'Quentrell Sirov' },
    });
    const unlinked = makeConn();
    await file(unlinked);
    expect(JSON.parse(unlinked.writes[0].row.payload)).toMatchObject({
      customer_ids: [],
      compared_against: { source: 'extracted', name: 'Quentrell Sirov' },
    });
  });

  test('a human decision for customer A does not suppress the same discrepancy for customer B (or unlinked)', async () => {
    const forA = { payload: { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov', customer_ids: ['cust-a'], also: [] } };
    const rowOf = () => ({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
    expect(await file(makeConn({ ...rowOf(), settled: [forA] }), { customerId: 'cust-a' })).toBe(false);
    expect(await file(makeConn({ ...rowOf(), settled: [forA] }), { customerId: 'cust-b' })).toBe(true);
    // ...and an unlinked card is its own key.
    const unlinkedSettled = { payload: { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov', customer_ids: [] } };
    expect(await file(makeConn({ settled: [unlinkedSettled] }))).toBe(false);
    expect(await file(makeConn({ ...rowOf(), settled: [unlinkedSettled] }), { customerId: 'cust-b' })).toBe(true);
    expect(await file(makeConn({ settled: [forA] }))).toBe(true);
  });

  test.each(['family_member', 'real_estate_agent', 'lender', 'tenant', 'property_manager', 'employee', 'home_buyer', 'other'])(
    'a third-party caller (%s) is never compared with the linked account holder', async (relationship) => {
      const conn = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
      const v2Result = { extraction: { caller: { relationship_to_property: relationship }, meta: { call_summary: 'x' } } };
      expect(await file(conn, { customerId: 'cust-1', v2Result })).toBe(false);
      expect(conn.writes).toEqual([]);
    },
  );

  test('a third party on an UNLINKED call still gets a card against the extracted caller name; owner-equivalent callers compare with the customer', async () => {
    const v2Third = { extraction: { caller: { relationship_to_property: 'tenant' }, meta: { call_summary: 'x' } } };
    const unlinked = makeConn();
    expect(await file(unlinked, { v2Result: v2Third })).toBe(true);
    expect(JSON.parse(unlinked.writes[0].row.payload).compared_against.source).toBe('extracted');
    for (const rel of ['owner', 'spouse_partner', 'unknown', undefined]) {
      const conn = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
      const v2Result = { extraction: { caller: { relationship_to_property: rel }, meta: { call_summary: 'x' } } };
      expect(await file(conn, { customerId: 'cust-1', v2Result })).toBe(true);
    }
  });

  test('equal letters (any case): no card', async () => {
    const conn = makeConn();
    expect(await file(conn, { extracted: { first_name: 'Quentrell', last_name: 'SEROV' } })).toBe(false);
    expect(conn.writes).toEqual([]);
  });

  test('a blank stored field on a linked customer stays blank: no "record says" card from the extraction', async () => {
    const blankLast = makeConn({ customer: { first_name: 'Quentrell', last_name: null } });
    expect(await file(blankLast, { customerId: 'cust-1' })).toBe(false);
    expect(blankLast.writes).toEqual([]);
    // The same extraction on an unlinked call still compares against the name heard on the call.
    const unlinked = makeConn();
    expect(await file(unlinked)).toBe(true);
    expect(JSON.parse(unlinked.writes[0].row.payload).compared_against.source).toBe('extracted');
  });
  test.each(['job_applicant', 'vendor_or_partner'])(
    'a linked %s call (relationship unknown) is never compared with the prelinked customer', async (callNature) => {
      const conn = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
      const v2Result = { status: 'valid', extraction: { call_nature: callNature, caller: { relationship_to_property: 'unknown' }, meta: { call_summary: 'x' } } };
      expect(await file(conn, { customerId: 'cust-1', v2Result })).toBe(false);
      expect(conn.writes).toEqual([]);
      expect(conn.customerReads).toEqual([]);
      // The same call with an ordinary nature still compares.
      const ordinary = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
      const okResult = { status: 'valid', extraction: { call_nature: 'existing_customer', caller: { relationship_to_property: 'unknown' }, meta: { call_summary: 'x' } } };
      expect(await file(ordinary, { customerId: 'cust-1', v2Result: okResult })).toBe(true);
    },
  );

  test('the customer name is read live inside the card transaction, with the row locked', async () => {
    const conn = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
    expect(await file(conn, { customerId: 'cust-1' })).toBe(true);
    expect(conn.customerReads).toEqual([{ inTx: true, lockedRow: true }]);
    // The card carries the live stored value, not the extraction's.
    expect(JSON.parse(conn.writes[0].row.payload).saved_value).toBe('Sirov');
  });

  test('a live name that already matches files nothing and retires the open card', async () => {
    const conn = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Serov' }, openCards: 1 });
    expect(await file(conn, { customerId: 'cust-1' })).toBe(false);
    expect(conn.writes).toEqual([]);
    expect(conn.retired).toHaveLength(1);
    expect(conn.retired[0].where).toEqual({ call_log_id: 'call-1', reason_code: 'name_spelling_differs', status: 'open' });
    expect(conn.retired[0].update).toMatchObject({ status: 'resolved', resolution_source: 'auto' });
    expect(mockSyncStatus).toHaveBeenCalledWith(conn, 'call-1');
  });

  test('a linked customer\'s name is the saved name: the record is right, so no card; the record is wrong, a card', async () => {
    const right = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Serov' } });
    expect(await file(right, { customerId: 'cust-1' })).toBe(false);
    const wrong = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
    expect(await file(wrong, { customerId: 'cust-1', extracted: { first_name: 'Quentrell', last_name: 'Serov' } })).toBe(true);
    expect(JSON.parse(wrong.writes[0].row.payload).saved_value).toBe('Sirov');
  });

  test('a spelling the office already resolved or dismissed on this call is not re-filed', async () => {
    const conn = makeConn({ settled: [{ payload: { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov' } }] });
    expect(await file(conn)).toBe(false);
    const other = makeConn({ settled: [{ payload: JSON.stringify({ field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirof' }) }] });
    expect(await file(other)).toBe(true);
  });

  test('each discrepancy is deduped on its own against a settled card\'s main entry AND its also list', async () => {
    const both = dictationFor([
      { raw_spoken: 'S-E-R-O-V', spelled_value: 'Serov', field: 'last_name', whose: 'caller', confidence: 0.92 },
      { raw_spoken: 'K-W-E-N-T', spelled_value: 'Kwent', field: 'first_name', whose: 'caller', confidence: 0.9 },
    ], 'Caller: last name S-E-R-O-V and first name K-W-E-N-T');
    const settled = [{ payload: { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov', also: [] } }];
    const conn = makeConn({ settled });
    expect(await file(conn, { dictation: both })).toBe(true);
    const payload = JSON.parse(conn.writes[0].row.payload);
    // The settled last-name spelling is not re-filed; the first-name one is.
    expect(payload).toMatchObject({ field: 'first_name', spelled_value: 'Kwent', saved_value: 'Quentrell', also: [] });
    // A settled card that carried the first name in `also` settles it too.
    const viaAlso = makeConn({ settled: [{ payload: { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov', also: [{ field: 'first_name', spelled_value: 'Kwent', saved_value: 'Quentrell' }] } }] });
    expect(await file(viaAlso, { dictation: both })).toBe(false);
  });

  test('no card for a spelling the model gave to someone else, or one outside a caller turn', async () => {
    expect(await file(makeConn(), { dictation: dictation({ whose: 'other' }) })).toBe(false);
    expect(await file(makeConn(), { dictation: dictation({}, 'Agent: your last name is S-E-R-O-V\nCaller: yes') })).toBe(false);
  });

  test('fails open', async () => {
    const boom = () => { throw new Error('db down'); };
    boom.raw = (s) => s;
    boom.settledWheres = [];
    boom.transaction = async () => { throw new Error('db down'); };
    expect(await file(boom)).toBe(false);
  });

  test('nothing is written to the extraction, customers or leads: the processor only files the card', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).not.toMatch(/createNameFor|callerNameForWrites|spelledNameOverrides|nameOverrides|applyNameDictation/);
    const at = src.indexOf('await fileNameSpellingCard(db, {');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toMatch(/dictation: contactDictation,\n\s+v2Result,\n\s+procToken,\n\s+isOutbound: isOutboundCall\(call\),/);
  });
});

describe('the card is wired like the other name_review cards', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('category: name_review', () => {
    expect(read('../services/call-routing-gates.js')).toMatch(/name_spelling_differs: 'name_review'/);
  });

  test('version-bound Resolve / Dismiss, not swept by a sibling verdict, not itself a verdict (main\'s tables)', () => {
    const src = read('../routes/admin-triage.js');
    expect(src).toMatch(/const VERSION_BOUND_REASONS = \[[^\]]*'name_spelling_differs'/s);
    expect(src).toMatch(/\.whereNotIn\('reason_code', \[[^\]]*'name_spelling_differs'/s);
    expect(src).toMatch(/const NOT_A_VERDICT_MESSAGES = \{[^}]*name_spelling_differs/s);
    // Admin-only like the owed first name: hidden from techs, refused on every shared transition.
    // The card's customer list resolves to merge survivors like the other owed-customer cards.
    expect(src).toMatch(/const OWED_CUSTOMER_LIST_REASONS = \[[^\]]*'name_spelling_differs'/);
    expect(src).toMatch(/const ADMIN_ONLY_REASONS = \[[^\]]*'name_spelling_differs'/s);
  });

  test('the card does not survive a recording swap (it is evidence about the transcript)', () => {
    const { SUPERSEDE_KEPT_CARD_SQL } = require('../services/call-routing-gates');
    expect(SUPERSEDE_KEPT_CARD_SQL).not.toMatch(/name_spelling_differs/);
  });

  test('the inbox labels it, renders it through the evidence lookup, and gives it its own admin-only Resolve (no verdict)', () => {
    const src = read('../../client/src/pages/admin/TriageInboxTabV2.jsx');
    expect(src).toMatch(/name_spelling_differs: "Caller spelled their name — check it"/);
    expect(src).toMatch(/const EVIDENCE_BY_REASON = \{[^}]*name_spelling_differs: NameSpellingEvidence/);
    expect(src).toMatch(/const NO_VERDICT_REASONS = new Set\(\[[^\]]*"name_spelling_differs"/s);
    expect(src).toMatch(/const ADMIN_RESOLVE_REASONS = new Set\(\[[^\]]*"name_spelling_differs"/s);
  });
});
