/**
 * Texting AI gap 5 (owner 2026-11-26 "BUILD 1-6"): LABEL FACTS for the visit the customer asks about, and PRODUCT NOTES.
 * - An earlier visit of the last 14 days the customer names by its service ("the lawn treatment") or its date gets that visit's label
 *   sentences; nothing clearly named keeps the latest visit, as before; a named service no recent visit had gets none on file.
 * - The section may carry the service report's own published product wording (how it works, a no-timing pets-and-kids line) and a
 *   "labeled for" line for a pest the customer named, under the same exact-sentence contract: verbatim copies only, never an answer
 *   to a re-entry or rain question, re-derived from the visit's products at send time.
 * All names and data here are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const labelFactsLib = require('../services/sms-label-facts');

const COPY_GATE = 'GATE_REPORT_PRODUCT_COPY';
let priorCopyGate;
beforeEach(() => { priorCopyGate = process.env[COPY_GATE]; process.env[COPY_GATE] = 'true'; });
afterEach(() => { if (priorCopyGate === undefined) delete process.env[COPY_GATE]; else process.env[COPY_GATE] = priorCopyGate; });

const TODAY = '2026-11-25';
const day = (date, families = [], unknown = false) => ({ date, families: new Set(families), unknown });

describe('namedServiceFamilies: service-shaped words only', () => {
  test.each([
    ['When can the dog go out after the lawn treatment?', ['lawn']],
    ['Did the fertilizer go down today?', ['lawn']],
    ['Can the kids play outside after the pest control visit?', ['interior_pest']],
    ['is the mosquito spray dry yet', ['mosquito']],
    // a place or a pest is not a service: "the lawn" after a pest visit asks about that pest visit
    ['Can the dog go on the lawn?', []],
    ['I still see roaches in the kitchen', []],
    ['The lawn guy and the pest control tech both came', ['interior_pest', 'lawn']],
  ])('%s', (text, families) => {
    expect([...labelFactsLib.namedServiceFamilies(text)].sort()).toEqual(families.sort());
  });
});

describe('pickAskedVisitDate', () => {
  const days = [day('2026-11-24', ['interior_pest']), day('2026-11-18', ['lawn']), day('2026-11-12', ['lawn'])];
  const pick = (text, list = days) => labelFactsLib.pickAskedVisitDate(list, [text], TODAY);

  test('nothing named, or the latest visit named: the latest visit, as before (null)', () => {
    expect(pick('When can the dog go out?')).toBeNull();
    expect(pick('Can my dog go on the lawn now?')).toBeNull();
    expect(pick('Is the pest control spray dry yet?')).toBeNull();
    expect(pick('You came yesterday, can the dog go out?')).toBeNull(); // yesterday IS the latest visit
  });

  test('one service named: the newest visit of the window that had it', () => {
    expect(pick('When can the dog go out after the lawn treatment?')).toBe('2026-11-18');
  });

  test('a named service no recent visit had: none on file (never the latest visit\'s figures for another service)', () => {
    expect(pick('Is the mosquito spray dry yet?')).toBe(labelFactsLib.NO_ASKED_VISIT);
    // a newer visit whose service no guide family covers could be it: not certain, so none on file
    expect(pick('after the lawn treatment can the dog go out?', [day('2026-11-24', ['interior_pest']), day('2026-11-21', [], true), day('2026-11-18', ['lawn'])])).toBe(labelFactsLib.NO_ASKED_VISIT);
  });

  test('two services named: ambiguous, the latest visit (null)', () => {
    expect(pick('the lawn treatment or the pest control visit, which one?')).toBeNull();
  });

  test('a date: the one earlier visit every date reference resolves to', () => {
    expect(pick('Can the kids play on the grass after the Nov 18 visit?')).toBe('2026-11-18');
    expect(pick('About the 11/12 lawn treatment, is it dry?')).toBe('2026-11-12');
    // a date that is no visit of the window, or a vague "last week": no pick (labelFactsForInbound then gives none on file)
    expect(pick('Is the Nov 15 treatment dry?')).toBeNull();
    expect(pick('Is the treatment from last week dry?')).toBeNull();
    // a date and a service that disagree: no pick
    expect(pick('the Nov 18 pest control visit')).toBeNull();
  });

  test('a short follow-up takes the service named earlier in the thread', () => {
    expect(labelFactsLib.pickAskedVisitDate(days, ['is it ok now?', 'when can the dog go out after the lawn treatment'], TODAY)).toBe('2026-11-18');
  });

  test('no recent visit at all: the latest visit (null)', () => {
    expect(labelFactsLib.pickAskedVisitDate([], ['after the lawn treatment?'], TODAY)).toBeNull();
  });
});

// A product as readLastVisitLabelFacts returns it (frozen identity included).
const product = (over) => ({ additive: false, phrase: 'an insecticide', rainfastMinutes: 60, reiHours: 0, reentrySummary: 'Keep people and pets off treated areas until dry.', reentryText: null, labelVerifiedAt: '2026-11-01', ...over });
const ANT_GEL = { epaReg: '100-1498', name: 'Advion Ant Bait Gel' };
const ROACH_GEL = { epaReg: '100-1484', name: 'Advion Evolution Cockroach Gel Bait' };
const BARRIER = { epaReg: '10404-120', name: 'LESCO Crosscheck Plus' };
const visit = (products, over = {}) => ({ customerId: 'c1', serviceDate: '2026-11-18', recordIds: ['r1'], products, unverifiedCount: 0, ...over });
const ANT_GEL_HOW = 'Worker ants carry the gel home and feed it to the queen and young — that’s how whole colonies go down, not just the ants you see.';

describe('PRODUCT NOTES', () => {
  test('the report\'s own wording for each product, a no-timing pets-and-kids line, and labeled-for only for a pest the customer named', () => {
    const plain = labelFactsLib.productNoteSentences(visit([product(ANT_GEL), product(BARRIER)]));
    expect(plain.map((n) => n.text)).toEqual([
      ANT_GEL_HOW,
      'A long-lasting barrier on soil, walls and eaves. Insects that crawl across or rest on treated surfaces pick up a dose — our main barrier against spiders and crawling invaders.',
      'Leave the placements undisturbed.',
    ]);
    // the barrier's "Stay off treated areas until the application has dried." states a stay-off: only the whole-visit sentence may
    expect(plain.map((n) => n.text).join(' ')).not.toMatch(/stay off|until/i);
    const asked = labelFactsLib.labelFactsForInbound(visit([product(ANT_GEL), product(BARRIER)]), ['Will this take care of the ghost ants?'], TODAY);
    expect(labelFactsLib.productNoteSentences(asked)[0].text).toBe('A treatment applied at your Nov 18 visit is one labeled for ghost ants.');
  });

  test('none with the report wording gate off, an unverified product on the visit, an additive or an unreviewed product', () => {
    delete process.env[COPY_GATE];
    expect(labelFactsLib.productNoteSentences(visit([product(ANT_GEL)]))).toEqual([]);
    process.env[COPY_GATE] = 'true';
    expect(labelFactsLib.productNoteSentences(visit([product(ANT_GEL)], { unverifiedCount: 1 }))).toEqual([]);
    expect(labelFactsLib.productNoteSentences(visit([product({ ...ANT_GEL, additive: true })]))).toEqual([]);
    expect(labelFactsLib.productNoteSentences(visit([product({ epaReg: '999-1', name: 'Advion Ant Bait Gel' })]))).toEqual([]); // EPA number decides
  });

  test('the section: timing first, then the notes, within the structural bounds; notes with no timing carry the no-timing line', () => {
    const text = labelFactsLib.renderLabelFactsSection(visit([product(ANT_GEL), product(ROACH_GEL), product(BARRIER)]));
    expect(new RegExp(`^${labelFactsLib.LABEL_SECTION_REGEX_SRC}$`).test(text.replace(/\n$/, ''))).toBe(true);
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toMatch(/^- For the products applied at your Nov 18 visit, the label says rain/);
    expect(lines.length).toBeLessThanOrEqual(labelFactsLib.LABEL_LINES_MAX);
    const noTiming = labelFactsLib.renderLabelFactsSection(visit([product({ ...ANT_GEL, rainfastMinutes: null, reiHours: null, reentrySummary: 'Varies.' })]));
    expect(noTiming).toContain('- No product timing is on file for this visit.');
    expect(noTiming).toContain(`- ${ANT_GEL_HOW}`);
  });

  test('an asked-about earlier visit says so in its header', () => {
    const text = labelFactsLib.renderLabelFactsSection(visit([product(ANT_GEL)], { asked: true, latestDate: '2026-11-24', sinceRecordIds: ['r1', 'r9'] }));
    expect(text.startsWith('LABEL FACTS (from the labels of products applied at the visit the customer asked about on 2026-11-18):\n')).toBe(true);
    expect(labelFactsLib.LABEL_FACTS_FILLED_HEADER_RE.test(text.split('\n')[0])).toBe(true);
  });

  test('a note is copyable verbatim, never answers a re-entry or rain question, and nothing typed in its shape is authorized', () => {
    const facts = labelFactsLib.labelFactsForInbound(visit([product(ANT_GEL)]), ['Will this get the ghost ants?'], TODAY);
    const section = labelFactsLib.renderLabelFactsSection(facts);
    const held = (body, inbound) => labelFactsLib.replyClaimsUngroundedLabelTiming(body, section, labelFactsLib.askedLabelKinds(inbound));
    expect(held(`A treatment applied at your Nov 18 visit is one labeled for ghost ants. ${ANT_GEL_HOW}`, 'Will this get the ghost ants?')).toBe(false);
    // a note beside the re-entry sentence is fine; a note in place of it, or a clearance added, is held
    const reentry = 'For the products applied at your Nov 18 visit, the label says to keep people and pets off treated areas until dry.';
    expect(held(`${reentry} Leave the placements undisturbed.`, 'When can the dog go out?')).toBe(false);
    expect(held('Leave the placements undisturbed.', 'When can the dog go out?')).toBe(true);
    expect(held('Leave the placements undisturbed. The dogs can go out now.', 'When can the dog go out?')).toBe(true);
    // a labeled-for line for a pest the section does not carry, or an unknown pest term, authorizes nothing
    expect(labelFactsLib.isProductNoteText('A treatment applied at your Nov 18 visit is one labeled for dragons.')).toBe(false);
    expect(labelFactsLib.labelSentencesIn(section).map((s) => s.kind)).toEqual(['rainfast', 'reentry', 'product', 'product', 'product']);
  });
});

describe('the asked-about visit: read and send-time recheck (mock knex)', () => {
  // A chainable fake over two performed visits: r9 (Nov 24, pest, latest) and r1 (Nov 18, lawn). `extra` adds performed records.
  function fakeConn({ extra = [], products = { r1: [ANT_GEL] } } = {}) {
    const records = [
      { id: 'r9', service_date: '2026-11-24', service_type: 'Pest Control', structured_notes: null },
      { id: 'r1', service_date: '2026-11-18', service_type: 'Lawn Fertilization Treatment', structured_notes: null },
      ...extra,
    ];
    const facts = (id) => Object.fromEntries((products[id] || []).map((p, i) => [`p-${id}-${i}`, { productType: 'pesticide', name: p.name, epaRegNumber: p.epaReg, category: 'insecticide', rainfastMinutes: 60, reentryHours: 0, reentrySummary: 'Keep people and pets off treated areas until dry.', labelVerifiedAt: '2026-11-01' }]));
    const conn = (table) => {
      const q = { ops: [] };
      for (const m of ['where', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy']) q[m] = (...a) => { q.ops.push([m, ...a]); return q; };
      q.max = () => { q.ops.push(['max']); return q; };
      const dateFilter = () => {
        let rows = records;
        for (const o of q.ops) {
          if (o[0] !== 'where') continue;
          if (o[1] === 'service_records.service_date' && o[2] === '>=') rows = rows.filter((r) => r.service_date >= o[3]);
          else if (o[1] === 'service_records.service_date' && o[2] === '<=') rows = rows.filter((r) => r.service_date <= o[3]);
          else if (o[1] === 'service_records.service_date') rows = rows.filter((r) => r.service_date === o[2]);
        }
        return rows;
      };
      q.first = async () => (q.ops.some((o) => o[0] === 'max') ? { service_date: [...records].sort((a, b) => (a.service_date < b.service_date ? 1 : -1))[0].service_date } : null);
      q.select = async () => {
        if (table === 'scheduled_services' || table === 'customer_properties') return [];
        if (table === 'service_products as sp') {
          const ids = q.ops.find((o) => o[0] === 'whereIn')[2];
          return ids.flatMap((id) => (products[id] || []).map((p, i) => ({ id: `${id}-${i}`, service_record_id: id, product_id: `p-${id}-${i}`, product_name: p.name, active_ingredient: 'x', product_category: 'insecticide' })));
        }
        if (q.ops.some((o) => o[0] === 'where' && o[1] && typeof o[1] === 'object' && 'service_date' in o[1])) return [];
        return dateFilter().map((r) => ({ ...r, service_data: { reportIdentitySnapshot: { version: 1, productFacts: facts(r.id) } } }));
      };
      return q;
    };
    return conn;
  }

  test('fetchLabelFacts reads the lawn visit the customer named, with every later record beside it', async () => {
    const out = await labelFactsLib.fetchLabelFacts({ customerId: 'c1', conn: fakeConn({ products: { r1: [ANT_GEL], r9: [BARRIER] } }), inbound: ['when can the dog go out after the lawn treatment?'] });
    expect(out).toMatchObject({ serviceDate: '2026-11-18', recordIds: ['r1'], asked: true, latestDate: '2026-11-24', sinceRecordIds: ['r1', 'r9'] });
    // nothing named: the latest visit, same shape as before
    const latest = await labelFactsLib.fetchLabelFacts({ customerId: 'c1', conn: fakeConn({ products: { r1: [ANT_GEL], r9: [BARRIER] } }), inbound: ['when can the dog go out?'] });
    expect(latest).toMatchObject({ serviceDate: '2026-11-24', recordIds: ['r9'] });
    expect(latest.asked).toBeUndefined();
    // a named service no recent visit had: none on file
    expect(await labelFactsLib.fetchLabelFacts({ customerId: 'c1', conn: fakeConn({ products: { r9: [BARRIER] } }), inbound: ['is the mosquito spray dry?'] })).toBeNull();
  });

  test('an asked-about date outside the window, or after the latest visit, reads nothing', async () => {
    const read = (serviceDate) => labelFactsLib.readLastVisitLabelFacts({ customerId: 'c1', conn: fakeConn(), today: TODAY, serviceDate });
    expect(await read('2026-11-18')).toMatchObject({ serviceDate: '2026-11-18', asked: true });
    expect(await read('2026-11-01')).toBeNull();
    expect(await read('2026-11-30')).toBeNull();
    expect(await read('not-a-date')).toBeNull();
  });

  test('send time: the same asked-about visit and the same later visits pass; a visit landing in between refuses', async () => {
    const facts = await labelFactsLib.readLastVisitLabelFacts({ customerId: 'c1', conn: fakeConn(), today: TODAY, serviceDate: '2026-11-18' });
    const section = labelFactsLib.renderLabelFactsSection(facts);
    const body = `For the products applied at your Nov 18 visit, the label says to keep people and pets off treated areas until dry. ${ANT_GEL_HOW}`;
    const snapshot = labelFactsLib.labelFactsSnapshotFor({ labelFacts: facts, reply: body, sectionText: section, asked: ['reentry'] });
    expect(snapshot).toMatchObject({ visit_date: '2026-11-18', asked_visit: true, since_record_ids: ['r1', 'r9'] });
    expect(snapshot.sentences).toContain(ANT_GEL_HOW);
    const check = (conn) => labelFactsLib.labelFactsSendBlockReason({ snapshot, body, inbound: 'when can the dog go out after the lawn treatment?', conn, today: TODAY });
    expect(await check(fakeConn())).toBeNull();
    expect(await check(fakeConn({ extra: [{ id: 'r10', service_date: '2026-11-25', service_type: 'Pest Control', structured_notes: null }], products: { r1: [ANT_GEL], r10: [BARRIER] } }))).toBe('label_facts_visit_changed');
    // the product is no longer on the visit: the note is no longer true of it
    expect(await check(fakeConn({ products: { r1: [ROACH_GEL] } }))).toBe('label_facts_changed');
    // an edited note is no longer an authorized copy
    expect(await labelFactsLib.labelFactsSendBlockReason({ snapshot, body: body.replace('queen', 'king'), conn: fakeConn(), today: TODAY })).toBe('label_facts_unauthorized_claim');
  });
});
