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
function makeConn({ customer = null, settled = [] } = {}) {
  const writes = [];
  const conn = (table) => {
    if (table === 'customers') return { where: () => ({ first: async () => customer }) };
    return {
      where: () => ({ whereIn: () => ({ select: async () => settled }) }),
      insert: (row) => ({
        onConflict: (target) => ({
          merge: async (cols) => { writes.push({ row, target, cols }); },
        }),
      }),
    };
  };
  conn.raw = (sql) => sql;
  conn.transaction = async (fn) => { conn.locked = true; return fn(conn); };
  conn.writes = writes;
  return conn;
}
const file = (conn, over = {}) => fileNameSpellingCard(conn, {
  callLogId: 'call-1',
  customerId: null,
  extracted: { first_name: 'Quentrell', last_name: 'Sirov' },
  dictation: dictation(),
  v2Result: { extraction: { meta: { call_summary: 'x' } } },
  ...over,
});

describe('fileNameSpellingCard', () => {
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
    // Read + upsert ran inside a transaction (the per-call triage lock is taken first).
    expect(conn.locked).toBe(true);
  });

  test('equal letters (any case): no card', async () => {
    const conn = makeConn();
    expect(await file(conn, { extracted: { first_name: 'Quentrell', last_name: 'SEROV' } })).toBe(false);
    expect(conn.writes).toEqual([]);
  });

  test('a linked customer\'s name is the saved name: the record is right, so no card; the record is wrong, a card', async () => {
    const right = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Serov' } });
    expect(await file(right, { customerId: 'cust-1' })).toBe(false);
    const wrong = makeConn({ customer: { first_name: 'Quentrell', last_name: 'Sirov' } });
    expect(await file(wrong, { customerId: 'cust-1', extracted: { first_name: 'Quentrell', last_name: 'Serov' } })).toBe(true);
    expect(JSON.parse(wrong.writes[0].row.payload).saved_value).toBe('Sirov');
  });

  test('a spelling the office already resolved or dismissed on this call is not re-filed', async () => {
    const conn = makeConn({ settled: [{ payload: { spelled_value: 'Serov', saved_value: 'Sirov' } }] });
    expect(await file(conn)).toBe(false);
    const other = makeConn({ settled: [{ payload: JSON.stringify({ spelled_value: 'Serov', saved_value: 'Sirof' }) }] });
    expect(await file(other)).toBe(true);
  });

  test('no card for a spelling the model gave to someone else, or one outside a caller turn', async () => {
    expect(await file(makeConn(), { dictation: dictation({ whose: 'other' }) })).toBe(false);
    expect(await file(makeConn(), { dictation: dictation({}, 'Agent: your last name is S-E-R-O-V\nCaller: yes') })).toBe(false);
  });

  test('fails open', async () => {
    const boom = () => { throw new Error('db down'); };
    boom.raw = (s) => s;
    boom.transaction = async () => { throw new Error('db down'); };
    expect(await file(boom)).toBe(false);
  });

  test('nothing is written to the extraction, customers or leads: the processor only files the card', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).not.toMatch(/createNameFor|callerNameForWrites|spelledNameOverrides|nameOverrides|applyNameDictation/);
    const at = src.indexOf('await fileNameSpellingCard(db, {');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toMatch(/dictation: contactDictation,\n\s+v2Result,/);
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
    // Open to the office: not in the admin-only set.
    expect(src).not.toMatch(/const ADMIN_ONLY_REASONS = \[[^\]]*name_spelling_differs/s);
  });

  test('the card does not survive a recording swap (it is evidence about the transcript)', () => {
    const { SUPERSEDE_KEPT_CARD_SQL } = require('../services/call-routing-gates');
    expect(SUPERSEDE_KEPT_CARD_SQL).not.toMatch(/name_spelling_differs/);
  });

  test('the inbox labels it, renders it through the evidence lookup, and gives it its own Resolve (no verdict)', () => {
    const src = read('../../client/src/pages/admin/TriageInboxTabV2.jsx');
    expect(src).toMatch(/name_spelling_differs: "Caller spelled their name — check it"/);
    expect(src).toMatch(/const EVIDENCE_BY_REASON = \{[^}]*name_spelling_differs: NameSpellingEvidence/);
    expect(src).toMatch(/const NO_VERDICT_REASONS = new Set\(\[[^\]]*"name_spelling_differs"/s);
    expect(src).not.toMatch(/const ADMIN_RESOLVE_REASONS = new Set\(\[[^\]]*name_spelling_differs/s);
  });
});
