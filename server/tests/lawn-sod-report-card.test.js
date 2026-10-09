// The lawn web report's New sod card (GATE_LAWN_NEW_SOD_REPORT_CARD): what is frozen at completion, the exact
// sentences the server builds from the frozen block, the payload key, and the guarantees around a failed read.
// Synthetic data; the completion transaction and the sheet context are fakes (the hold rules are
// lawn-sod-holds.js's own tests, the planned classes are lawn-sod-sheet.test.js's).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lawn-fast-complete', () => ({ buildLawnFastContext: jest.fn() }));

const logger = require('../services/logger');
const { buildLawnFastContext } = require('../services/lawn-fast-complete');
const card = require('../services/lawn-sod-report-card');
const fs = require('node:fs');
const path = require('node:path');

const PRODUCT_BAG = 'aaaaaaaa-0000-4000-8000-000000000001';
const PRODUCT_CELSIUS = 'aaaaaaaa-0000-4000-8000-000000000002';
const PRODUCT_SWAP = 'aaaaaaaa-0000-4000-8000-000000000003';
const SWAP_NAME = 'LESCO 24-0-11 with PolyPlus OPTI';

const GATES = ['GATE_LAWN_NEW_SOD_REPORT_CARD', 'GATE_LAWN_NEW_SOD_NOTE'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  GATES.forEach((name) => { process.env[name] = 'true'; });
  buildLawnFastContext.mockReset();
  logger.warn.mockClear();
});
afterEach(() => {
  GATES.forEach((name) => { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
});

// A fake completion transaction: trx.transaction runs the callback on a savepoint-like query function.
function fakeTrx({ updated = 1, updateError = null, catalog = [] } = {}) {
  const writes = [];
  const sp = jest.fn((table) => {
    const chain = {
      whereIn: (_column, ids) => { chain.ids = ids; return chain; },
      select: async () => catalog.filter((row) => chain.ids.includes(row.id)),
      where: () => chain,
      whereRaw: (sql) => { chain.guard = sql; return chain; },
      update: async (patch) => {
        if (updateError) throw updateError;
        writes.push({ table, guard: chain.guard, patch });
        return updated;
      },
    };
    return chain;
  });
  sp.raw = (sql, bindings) => ({ sql, bindings });
  const trx = { transaction: jest.fn(async (callback) => callback(sp)) };
  return { trx, writes };
}

// The sod record the sheet showed, as the sheet echoes it (lawnFast.sod).
const SEEN = { laidOn: '2026-10-03', covers: 'whole' };

const newSod = (extra = {}) => ({
  v: 1, day: 5, sodLaidOn: '2026-10-03', covers: 'whole', swap: null,
  plannedHeld: [
    { kind: 'fertilizer', until: '2026-11-02', rootedCheck: false, productIds: [PRODUCT_BAG] },
    { kind: 'weedKiller', until: '2026-11-02', rootedCheck: true, productIds: [PRODUCT_CELSIUS] },
  ],
  ...extra,
});
const contextOf = (sod, visitDate = '2026-10-07') => ({ ok: true, eligible: true, visitDate, newSod: sod });

const run = async (trx, extra = {}) => {
  const record = { id: 'rec-1', structured_notes: { existing: 'kept' } };
  const out = await card.freezeNewSodCard(trx, {
    svc: { id: 'visit-1' }, record, lawnFast: { sod: SEEN }, isIncompleteVisit: false, resumingCommittedCompletion: false, appliedProducts: [], ...extra,
  });
  return { out, record };
};

describe('freezeNewSodCard: what is frozen at completion', () => {
  test('whole lawn, day 5: the held planned classes with their dates, written once under lawnNewSod, kept in the in-memory notes', async () => {
    buildLawnFastContext.mockResolvedValue(contextOf(newSod()));
    const { trx, writes } = fakeTrx();
    const { out, record } = await run(trx);
    const frozen = {
      v: 1, visitDay: '2026-10-07', sodLaidOn: '2026-10-03', covers: 'whole', planRan: false,
      held: [{ kind: 'fertilizer', until: '2026-11-02', rootedCheck: false }, { kind: 'weedKiller', until: '2026-11-02', rootedCheck: true }],
      swap: null,
    };
    expect(out).toEqual(frozen);
    // The context is rebuilt on the transaction's savepoint, as a sod-aware sheet.
    expect(buildLawnFastContext).toHaveBeenCalledWith('visit-1', expect.objectContaining({ sodAware: true }));
    expect(writes).toHaveLength(1);
    expect(writes[0].guard).toBe("(structured_notes::jsonb -> 'lawnNewSod') IS NULL");
    expect(JSON.parse(writes[0].patch.structured_notes.bindings[0])).toEqual({ lawnNewSod: frozen });
    expect(record.structured_notes).toEqual({ existing: 'kept', lawnNewSod: frozen });
  });

  test('gate off, or the sheet gate off: no read and no write', async () => {
    for (const name of GATES) {
      process.env[name] = 'false';
      const { trx, writes } = fakeTrx();
      expect((await run(trx)).out).toBeNull();
      expect(trx.transaction).not.toHaveBeenCalled();
      expect(buildLawnFastContext).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      process.env[name] = 'true';
    }
    delete process.env.GATE_LAWN_NEW_SOD_REPORT_CARD;
    expect(require('../config/feature-gates').lawnNewSodReportCardLive()).toBe(false);
  });

  test('not a lawn sheet completion, an incomplete visit or a resumed completion: nothing', async () => {
    for (const extra of [{ lawnFast: null }, { isIncompleteVisit: true }, { resumingCommittedCompletion: true }]) {
      const { trx } = fakeTrx();
      expect((await run(trx, extra)).out).toBeNull();
      expect(trx.transaction).not.toHaveBeenCalled();
    }
  });

  test('nothing planned was held (no active hold, or only Tetrino held): nothing is frozen', async () => {
    const { trx, writes } = fakeTrx();
    buildLawnFastContext.mockResolvedValue(contextOf(null));
    expect((await run(trx)).out).toBeNull();
    buildLawnFastContext.mockResolvedValue(contextOf(newSod({ plannedHeld: [] })));
    expect((await run(trx)).out).toBeNull();
    expect(writes).toEqual([]);
  });

  test('the October bag swap: the pre-emergent is named and the swap is recorded when the swap bag was applied', async () => {
    const sod = newSod({
      sodLaidOn: '2026-08-01', day: 80,
      plannedHeld: [{ kind: 'preEmergent', until: '2027-10-01', rootedCheck: false, productIds: [PRODUCT_BAG] }],
      swap: { resolved: true, forProductId: PRODUCT_BAG, productId: PRODUCT_SWAP, name: SWAP_NAME },
    });
    buildLawnFastContext.mockResolvedValue(contextOf(sod, '2026-10-20'));
    const lawnFast = { sod: { laidOn: '2026-08-01', covers: 'whole' } };
    const applied = await run(fakeTrx().trx, { lawnFast, appliedProducts: [{ product_id: PRODUCT_SWAP.toUpperCase() }] });
    expect(applied.out).toMatchObject({ held: [{ kind: 'preEmergent', until: '2027-10-01', rootedCheck: false }], swap: { name: SWAP_NAME } });
    // The swap bag was not spread: no swap sentence.
    const notApplied = await run(fakeTrx().trx, { lawnFast, appliedProducts: [] });
    expect(notApplied.out.swap).toBeNull();
    // An unresolved swap (the bag was held "by hand") is never recorded.
    buildLawnFastContext.mockResolvedValue(contextOf({ ...sod, swap: { resolved: false, forProductId: PRODUCT_BAG } }, '2026-10-20'));
    expect((await run(fakeTrx().trx, { lawnFast, appliedProducts: [{ product_id: PRODUCT_SWAP }] })).out.swap).toBeNull();
  });

  test('a whole-lawn class the technician applied by hand anyway is not "held"; a part-of-lawn class is (the line ran on the rest)', async () => {
    buildLawnFastContext.mockResolvedValue(contextOf(newSod()));
    const whole = await run(fakeTrx().trx, { appliedProducts: [{ product_id: PRODUCT_BAG }] });
    expect(whole.out.held.map((entry) => entry.kind)).toEqual(['weedKiller']);
    buildLawnFastContext.mockResolvedValue(contextOf(newSod({ covers: 'part', area: 'Back left corner' })));
    const part = await run(fakeTrx().trx, { lawnFast: { sod: { laidOn: '2026-10-03', covers: 'part' } }, appliedProducts: [{ product_id: PRODUCT_BAG }] });
    expect(part.out).toMatchObject({ covers: 'part' });
    // The office's free-text area name is never frozen for the customer.
    expect(part.out).not.toHaveProperty('area');
    expect(part.out.held.map((entry) => entry.kind)).toEqual(['fertilizer', 'weedKiller']);
  });

  test('another product of a held class from the sheet search (not the planned one) also means the class was not held', async () => {
    buildLawnFastContext.mockResolvedValue(contextOf(newSod()));
    const OTHER_BAG = '99999999-9999-4999-8999-999999999999';
    const catalog = [{ id: OTHER_BAG, name: 'Other 16-0-8', category: 'Fertilizer', active_ingredient: '', analysis_n: 16, formulation: 'Granular' }];
    const { out } = await run(fakeTrx({ catalog }).trx, { appliedProducts: [{ product_id: OTHER_BAG, application_method: 'granular_broadcast' }] });
    expect(out.held.map((entry) => entry.kind)).toEqual(['weedKiller']);
  });

  test('the sheet echoes the sod record it showed: no echo, or a record that changed since, freezes no card', async () => {
    buildLawnFastContext.mockResolvedValue(contextOf(newSod()));
    for (const lawnFast of [{}, { sod: { laidOn: '2026-09-30', covers: 'whole' } }, { sod: { laidOn: '2026-10-03', covers: 'part' } }]) {
      const { trx, writes } = fakeTrx();
      expect((await run(trx, { lawnFast })).out).toBeNull();
      expect(writes).toEqual([]);
    }
  });

  test('"everything else ran" is frozen only when every other planned product was applied', async () => {
    const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    const withPlan = { ...contextOf(newSod()), plannedProducts: { items: [{ productId: PRODUCT_BAG }, { productId: OTHER }] } };
    buildLawnFastContext.mockResolvedValue(withPlan);
    // The held bag is not expected; the other planned product went down.
    expect((await run(fakeTrx().trx, { appliedProducts: [{ product_id: OTHER }] })).out.planRan).toBe(true);
    // The technician left the other planned product off.
    expect((await run(fakeTrx().trx, { appliedProducts: [] })).out.planRan).toBe(false);
  });

  test('a combined-stop lawn leg: the packet authorization reaches the context rebuild', async () => {
    buildLawnFastContext.mockResolvedValue(contextOf(newSod()));
    const allowGrouped = { packetContext: { packetId: 'packet-1' } };
    await run(fakeTrx().trx, { allowGrouped });
    expect(buildLawnFastContext).toHaveBeenCalledWith('visit-1', expect.objectContaining({ sodAware: true, allowGrouped }));
  });

  test('first writer wins: a block already on the record is never replaced (the guarded update matches nothing)', async () => {
    buildLawnFastContext.mockResolvedValue(contextOf(newSod()));
    const { trx } = fakeTrx({ updated: 0 });
    const { out, record } = await run(trx);
    expect(out).toBeNull();
    expect(record.structured_notes).toEqual({ existing: 'kept' });
  });

  describe('a failed read freezes nothing and never fails the visit', () => {
    test('the context build throws', async () => {
      buildLawnFastContext.mockRejectedValue(Object.assign(new Error('boom: SELECT secret'), { code: '57014' }));
      const { trx, writes } = fakeTrx();
      const { out, record } = await run(trx);
      expect(out).toBeNull();
      expect(writes).toEqual([]);
      expect(record.structured_notes).toEqual({ existing: 'kept' });
      // The warning carries the error code, never the driver message.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('57014'));
      expect(logger.warn.mock.calls[0][0]).not.toContain('SELECT secret');
    });

    test('the sheet could not read the sod record: the savepoint is rolled back (the callback throws), nothing is written', async () => {
      buildLawnFastContext.mockResolvedValue(contextOf({ v: 1, unavailable: true, message: 'Could not check' }));
      const { trx, writes } = fakeTrx();
      expect((await run(trx)).out).toBeNull();
      expect(writes).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    test('the write throws', async () => {
      buildLawnFastContext.mockResolvedValue(contextOf(newSod()));
      const { trx } = fakeTrx({ updateError: new Error('write failed') });
      const { out, record } = await run(trx);
      expect(out).toBeNull();
      expect(record.structured_notes).toEqual({ existing: 'kept' });
    });
  });
});

describe('cardOf: the exact words', () => {
  const block = (extra) => ({
    planRan: true,
    v: 1, visitDay: '2026-10-07', sodLaidOn: '2026-10-03', covers: 'whole', swap: null,
    held: [{ kind: 'fertilizer', until: '2026-11-02', rootedCheck: false }, { kind: 'weedKiller', until: '2026-11-02', rootedCheck: true }],
    ...extra,
  });

  test('whole lawn, day 5, fertilizer and weed killer held', () => {
    expect(card.cardOf(block())).toEqual({
      title: 'New sod (laid Oct 3)',
      lead: 'Today we held:',
      items: [
        'fertilizer until Nov 2. New sod needs 30 days to root.',
        'weed spot spray until Nov 2, and until the sod has been mowed twice and does not lift.',
      ],
      rest: null,
      swap: null,
      close: 'Everything else ran as normal. Same visit, same price.',
    });
  });

  test('a weed killer with no date waits only for the rooted check; the items print in the fixed order whatever the stored order', () => {
    const out = card.cardOf(block({
      held: [
        { kind: 'dylox', until: '2026-11-02', rootedCheck: false },
        { kind: 'weedKiller', until: null, rootedCheck: true },
        { kind: 'preEmergent', until: '2027-10-01', rootedCheck: false },
      ],
    }));
    expect(out.items).toEqual([
      'weed spot spray until the sod has been mowed twice and does not lift.',
      'pre-emergent until Oct 1, 2027, so the new runners can knit in.',
      'Dylox until Nov 2, while the new sod settles in.',
    ]);
  });

  test('an October visit with the bag swap: the pre-emergent and one plain swap sentence', () => {
    const out = card.cardOf(block({
      visitDay: '2026-10-20', sodLaidOn: '2026-08-01',
      held: [{ kind: 'preEmergent', until: '2027-10-01', rootedCheck: false }],
      swap: { name: SWAP_NAME },
    }));
    expect(out).toEqual({
      title: 'New sod (laid Aug 1)',
      lead: 'Today we held:',
      items: ['pre-emergent until Oct 1, 2027, so the new runners can knit in.'],
      rest: null,
      swap: 'We used a fertilizer without pre-emergent in place of the usual bag.',
      close: 'Everything else ran as normal. Same visit, same price.',
    });
  });

  test('another planned product was left off: no claim about the rest of the visit', () => {
    const out = card.cardOf(block({ covers: 'part', planRan: false }));
    expect(out.rest).toBeNull();
    expect(out.close).toBe('Same visit, same price.');
  });

  test('part of the lawn: the hold is on the new sod area (never the office name for it) and the rest ran as planned', () => {
    const out = card.cardOf(block({
      covers: 'part', area: 'Back left corner',
      held: [{ kind: 'fertilizer', until: '2026-11-02', rootedCheck: false }, { kind: 'preEmergent', until: '2027-10-01', rootedCheck: false }],
    }));
    expect(out).toEqual({
      title: 'New sod (laid Oct 3)',
      lead: 'Today we held these on the new sod area:',
      items: ['fertilizer until Nov 2. New sod needs 30 days to root.', 'pre-emergent until Oct 1, 2027, so the new runners can knit in.'],
      rest: 'The rest of the lawn was treated as planned.',
      swap: null,
      close: 'Everything else ran as normal. Same visit, same price.',
    });
  });

  test('a sod date from an earlier year prints its year', () => {
    expect(card.cardOf(block({ sodLaidOn: '2025-12-20', visitDay: '2026-01-05' })).title).toBe('New sod (laid Dec 20, 2025)');
  });

  test('no label or law, no large patch, fungicide, disease watch, discount or free product, no customer name', () => {
    const everything = card.cardOf(block({
      held: [
        { kind: 'fertilizer', until: '2026-11-02', rootedCheck: false }, { kind: 'weedKiller', until: '2026-11-02', rootedCheck: true },
        { kind: 'preEmergent', until: '2027-10-01', rootedCheck: false }, { kind: 'dylox', until: '2026-11-02', rootedCheck: false },
      ],
      covers: 'part', swap: { name: SWAP_NAME },
    }));
    const words = JSON.stringify(everything);
    expect(words).not.toMatch(/label|ordinance|law\b|large patch|fungicide|disease|discount|free|credit|\$/i);
  });

  test('a missing, damaged or empty block prints no card', () => {
    expect(card.cardOf(null)).toBeNull();
    expect(card.cardOf({})).toBeNull();
    expect(card.cardOf(block({ v: 2 }))).toBeNull();
    expect(card.cardOf(block({ held: [] }))).toBeNull();
    expect(card.cardOf(block({ held: [{ kind: 'tetrino', until: '2026-10-24' }] }))).toBeNull();
    expect(card.cardOf(block({ held: [{ kind: 'fertilizer', until: null }] }))).toBeNull();
    expect(card.cardOf(block({ sodLaidOn: 'last week' }))).toBeNull();
  });
});

describe('lawnNewSodPayload: the report payload key', () => {
  const frozen = {
    v: 1, visitDay: '2026-10-07', sodLaidOn: '2026-10-03', covers: 'whole', swap: null,
    held: [{ kind: 'fertilizer', until: '2026-11-02', rootedCheck: false }],
  };
  const notes = { lawnNewSod: frozen };

  test('gate on, lawn, frozen block: the built card, read from the notes alone (an object or a JSON string)', () => {
    const expected = { lawnNewSod: card.cardOf(frozen) };
    expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: notes })).toEqual(expected);
    expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: JSON.stringify(notes) })).toEqual(expected);
  });

  test('the live sod record is never read: a cleared record changes nothing about the frozen card', () => {
    // The page build has no sod read at all; a record cleared after completion cannot reach it.
    buildLawnFastContext.mockResolvedValue(contextOf(null));
    expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: notes }).lawnNewSod.title).toBe('New sod (laid Oct 3)');
    expect(buildLawnFastContext).not.toHaveBeenCalled();
  });

  test('gate off (either gate), another service line, no block or a damaged block: no key at all (byte-identical payload)', () => {
    expect(card.lawnNewSodPayload({ serviceLine: 'pest', structuredNotes: notes })).toEqual({});
    expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: {} })).toEqual({});
    expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: null })).toEqual({});
    expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: { lawnNewSod: { v: 1 } } })).toEqual({});
    expect(card.lawnNewSodPayload()).toEqual({});
    for (const name of GATES) {
      process.env[name] = 'false';
      expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: notes })).toEqual({});
      process.env[name] = 'true';
    }
    delete process.env.GATE_LAWN_NEW_SOD_REPORT_CARD;
    expect(card.lawnNewSodPayload({ serviceLine: 'lawn', structuredNotes: notes })).toEqual({});
  });

  test('the report build and the completion both call this module (a wiring guard)', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    expect(read('../services/service-report/report-data.js')).toContain('...lawnNewSodPayload({ serviceLine, structuredNotes: service.structured_notes })');
    expect(read('../services/complete-scheduled-service.js')).toContain("require('./lawn-sod-report-card').freezeNewSodCard(trx,");
  });
});

describe('the preview fixture (client dev preview) is the server\'s own words', () => {
  test('client/src/dev-preview/new-sod-cards.json matches cardOf for its three synthetic blocks', () => {
    const file = path.join(__dirname, '../../client/src/dev-preview/new-sod-cards.json');
    const { blocks, cards } = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(cards)).toEqual(Object.keys(blocks));
    for (const key of Object.keys(blocks)) expect(cards[key]).toEqual(card.cardOf(blocks[key]));
  });
});
