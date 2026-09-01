// Shared-phone sibling visibility: a fresh lead minted while another open
// lead exists on the same phone must cross-note BOTH timelines. The
// duplicate itself is deliberate fail-closed behavior in several paths;
// what was missing was discoverability — a sent-and-viewed estimate lived
// on one row while the office worked the other, blind to it.
// Fixtures fictitious; phone is a reserved 555-01xx number.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CallRecordingProcessor = require('../services/call-recording-processor');
const { noteSharedPhoneSibling } = CallRecordingProcessor._test;

function makeDb({ sibling = null, siblings = null, byId = {}, failInsert = false } = {}) {
  const inserts = [];
  const database = (table) => {
    let idClause = null;
    const q = {
      whereNull: () => q,
      where: (clause) => {
        if (clause && typeof clause === 'object' && clause.id) idClause = clause;
        return q;
      },
      whereNot: () => q,
      whereNotIn: () => q,
      whereIn: (col, vals) => { database._statusFilters.push(vals); return q; },
      orderBy: () => q,
      limit: async () => {
        if (table !== 'leads') return [];
        if (siblings) return siblings.slice(0, 2);
        return sibling ? [sibling] : [];
      },
      first: async () => {
        if (table !== 'leads') return null;
        if (idClause) {
          const row = byId[idClause.id] || null;
          // The service revalidates the known sibling's phone in the clause.
          if (row && 'phone' in idClause && row.phone !== idClause.phone) return null;
          return row;
        }
        return sibling;
      },
      insert: async (rows) => {
        if (failInsert) throw new Error('insert boom');
        inserts.push({ table, rows });
        return rows;
      },
    };
    return q;
  };
  database._inserts = inserts;
  database._statusFilters = [];
  return database;
}

const PHONE = '+15555550188';

describe('noteSharedPhoneSibling', () => {
  test('cross-notes both leads and points at the estimate-bearing sibling', async () => {
    const db = makeDb({
      sibling: { id: 'lead-old', first_name: 'Kevin', last_name: null, status: 'estimate_viewed', estimate_id: 'est-1' },
    });
    const sibId = await noteSharedPhoneSibling(db, {
      leadId: 'lead-new', phone: PHONE, extracted: { first_name: 'dominic', last_name: 'calvert' },
    });
    expect(sibId).toBe('lead-old');
    expect(db._inserts).toHaveLength(1);
    const rows = db._inserts[0].rows;
    expect(rows.map((r) => r.lead_id)).toEqual(['lead-new', 'lead-old']);
    expect(rows[0].description).toContain('Kevin');
    expect(rows[0].description).toContain('already carries an estimate');
    expect(JSON.parse(rows[0].metadata).shared_phone_sibling_lead_id).toBe('lead-old');
    expect(rows[1].description).toContain('Dominic Calvert');
    expect(JSON.parse(rows[1].metadata).shared_phone_sibling_lead_id).toBe('lead-new');
    // Dedicated type — excluded by the staleness sweep and the estimator
    // evidence pack; and the id rides in the VISIBLE text (the timeline
    // renders only descriptions).
    expect(rows.every((r) => r.activity_type === 'shared_phone_note')).toBe(true);
    expect(rows[0].description).toContain('lead-old');
    expect(rows[1].description).toContain('lead-new');
    // Sibling selection is POSITIVE membership in the canonical open set —
    // an 'unresponsive'/'spam'/'cancelled' lead must never be elected as
    // "work that lead instead".
    expect(db._statusFilters.length).toBeGreaterThan(0);
    for (const vals of db._statusFilters) expect(vals).toEqual(['new', 'contacted', 'estimate_sent', 'estimate_viewed']);
  });

  test('a non-exact known id never elects a pair among multiple open siblings', async () => {
    // The lookup's newest-name-conflict id is NOT exact — with 2+ open
    // prospects the ambiguity guard must win over the hint.
    const db = makeDb({
      siblings: [
        { id: 'lead-a', first_name: 'Pat', status: 'new', estimate_id: null },
        { id: 'lead-b', first_name: 'Sam', status: 'contacted', estimate_id: null },
      ],
      byId: { 'lead-a': { id: 'lead-a', phone: PHONE, first_name: 'Pat', status: 'new', estimate_id: null } },
    });
    const sibId = await noteSharedPhoneSibling(db, {
      leadId: 'lead-new', phone: PHONE, extracted: {}, knownSiblingId: 'lead-a',
    });
    expect(sibId).toBeNull();
    const note = db._inserts[0].rows;
    expect((Array.isArray(note) ? note[0] : note).description).toContain('multiple other open leads');
  });

  test('a known sibling id wins over the newest open lead on the phone', async () => {
    const db = makeDb({
      // Newest open row is an UNRELATED prospect on the shared line.
      sibling: { id: 'lead-unrelated', first_name: 'Pat', status: 'new', estimate_id: null },
      byId: { 'lead-conflict': { id: 'lead-conflict', phone: PHONE, first_name: 'Kevin', status: 'estimate_viewed', estimate_id: 'est-9' } },
    });
    const sibId = await noteSharedPhoneSibling(db, {
      leadId: 'lead-new', phone: PHONE, extracted: {}, knownSiblingId: 'lead-conflict', knownSiblingExact: true,
    });
    expect(sibId).toBe('lead-conflict');
    expect(db._inserts[0].rows[1].lead_id).toBe('lead-conflict');
  });

  test('a deleted known sibling falls back to the newest open lead', async () => {
    const db = makeDb({
      sibling: { id: 'lead-fallback', first_name: 'Pat', status: 'new', estimate_id: null },
      byId: {}, // known id no longer resolvable (soft-deleted)
    });
    const sibId = await noteSharedPhoneSibling(db, {
      leadId: 'lead-new', phone: PHONE, extracted: {}, knownSiblingId: 'lead-gone', knownSiblingExact: true,
    });
    expect(sibId).toBe('lead-fallback');
  });

  test('two or more open siblings -> one neutral note, no pair election', async () => {
    const db = makeDb({
      siblings: [
        { id: 'lead-a', first_name: 'Pat', status: 'new', estimate_id: null },
        { id: 'lead-b', first_name: 'Sam', status: 'contacted', estimate_id: null },
      ],
    });
    const sibId = await noteSharedPhoneSibling(db, { leadId: 'lead-new', phone: PHONE, extracted: {} });
    expect(sibId).toBeNull();
    expect(db._inserts).toHaveLength(1);
    const row = db._inserts[0].rows;
    expect(Array.isArray(row) ? row : [row]).toHaveLength(1);
    const note = Array.isArray(row) ? row[0] : row;
    expect(note.lead_id).toBe('lead-new');
    expect(note.description).toContain('multiple other open leads');
  });

  test('a known sibling whose phone moved falls back instead of cross-linking strangers', async () => {
    const db = makeDb({
      sibling: { id: 'lead-fallback2', first_name: 'Pat', status: 'new', estimate_id: null },
      byId: { 'lead-moved': { id: 'lead-moved', phone: '+15555550999', first_name: 'Kim', status: 'new', estimate_id: null } },
    });
    const sibId = await noteSharedPhoneSibling(db, {
      leadId: 'lead-new', phone: PHONE, extracted: {}, knownSiblingId: 'lead-moved', knownSiblingExact: true,
    });
    expect(sibId).toBe('lead-fallback2');
  });

  test('a terminal known sibling is not consolidation-noted', async () => {
    // byId returns null for the known id (mock stands in for the open-filter
    // rejection of a won/lost sibling) and no open fallback exists.
    const db = makeDb({ byId: {}, sibling: null });
    const sibId = await noteSharedPhoneSibling(db, {
      leadId: 'lead-new', phone: PHONE, extracted: {}, knownSiblingId: 'lead-won', knownSiblingExact: true,
    });
    expect(sibId).toBeNull();
    expect(db._inserts).toHaveLength(0);
  });

  test('no sibling -> no notes', async () => {
    const db = makeDb({ sibling: null });
    expect(await noteSharedPhoneSibling(db, { leadId: 'lead-new', phone: PHONE, extracted: {} })).toBeNull();
    expect(db._inserts).toHaveLength(0);
  });

  test('phone-less mint never queries', async () => {
    const db = makeDb({ sibling: { id: 'x' } });
    expect(await noteSharedPhoneSibling(db, { leadId: 'lead-new', phone: null, extracted: {} })).toBeNull();
    expect(db._inserts).toHaveLength(0);
  });

  test('an insert failure is swallowed — processing never breaks on a note', async () => {
    const db = makeDb({ sibling: { id: 'lead-old', status: 'new' }, failInsert: true });
    expect(await noteSharedPhoneSibling(db, { leadId: 'lead-new', phone: PHONE, extracted: {} })).toBeNull();
  });

  test('name-less parties get neutral wording, not "undefined"', async () => {
    const db = makeDb({ sibling: { id: 'lead-old', first_name: null, last_name: null, status: 'new', estimate_id: null } });
    await noteSharedPhoneSibling(db, { leadId: 'lead-new', phone: PHONE, extracted: {} });
    const rows = db._inserts[0].rows;
    expect(rows[0].description).toContain('an unnamed caller');
    expect(rows[1].description).toContain('this caller');
    expect(rows[0].description).not.toContain('undefined');
  });
});
