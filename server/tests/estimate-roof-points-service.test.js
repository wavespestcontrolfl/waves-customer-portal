// estimate-roof-points: the /data block for the customer page (owner ruling 2026-11-20, choice 4A). It prints the frozen
// copy, but only the copy of the estimate's latest handoff, staff hiding is immediate (the frozen read, the estimate's
// newest finished read with or without points, or its newest read with saved points, hidden NOW), and an estimate that
// has moved to another address prints nothing. Any miss is `{}` so the response stays byte-identical.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { roofPointsDocBlock, freezeRoofPointsForEstimate } = require('../services/estimate-roof-points');

const SNAPSHOT = {
  imageUrl: 'https://example.test/aerial.jpg',
  imageYear: 2025,
  pins: [
    { n: 1, x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', label: 'Roof return, front left', action: 'seal' },
    { n: 2, x: 0.7, y: 0.55, type: 'trees_touching_roof', label: 'Branch touching the roof', action: 'trim back' },
  ],
};
const ADDRESS = '12 Synthetic Way, Bradenton, FL 34203';
const SENT = '2026-11-20T16:00:00.000Z';
const LATER = '2026-11-20T19:30:00.000Z';

// The reads table answers one row per query (first), as the service asks: there is no list and no limit to hide behind.
function fakeKnex({ point, reads = [], throwOn = null }) {
  const knex = (table) => {
    const q = {};
    let where = {};
    let pointsOnly = false;
    q.where = (w) => { where = { ...where, ...w }; return q; };
    // The one raw filter the service uses: reads that hold a saved points list.
    q.whereRaw = (sql) => {
      if (!/tech_pins IS NOT NULL AND jsonb_typeof\(tech_pins\) = 'array'/.test(sql)) throw new Error(`unexpected raw filter: ${sql}`);
      pointsOnly = true;
      return q;
    };
    q.orderBy = () => q;
    q.first = async () => {
      if (throwOn === table) throw Object.assign(new Error(`${table} down: 12 Synthetic Way, note "front left"`), { code: '57014' });
      if (table === 'estimate_roof_points') return point;
      return reads
        .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        .filter((r) => !pointsOnly || Array.isArray(r.tech_pins))
        .sort((a, b) => b.created_at - a.created_at)[0];
    };
    return q;
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}
const point = (over = {}) => ({ estimate_id: 'est-1', read_id: 'read-1', address: ADDRESS, snapshot: SNAPSHOT, delivered_at: new Date(SENT), ...over });
const frozenRead = (over = {}) => ({ id: 'read-1', estimate_id: 'est-1', status: 'done', tech_pins: [{}], hide_on_estimate: false, created_at: new Date('2026-11-20T15:00:00Z'), ...over });
const est = (over = {}) => ({ id: 'est-1', address: ADDRESS, estimate_data: { deliveryState: { lastDeliveredAt: SENT } }, ...over });
const estimate = est();

describe('roofPointsDocBlock', () => {
  test('a frozen copy that is not hidden and still matches the address is published as { imageUrl, imageYear, pins }', async () => {
    const out = await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads: [frozenRead()] }) });
    expect(out).toEqual({ roofPoints: SNAPSHOT });
  });

  test('the snapshot and the estimate data may arrive as JSON strings', async () => {
    const knex = fakeKnex({ point: point({ snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT }), reads: [frozenRead()] });
    const out = await roofPointsDocBlock(est({ estimate_data: JSON.stringify({ deliveryState: { lastDeliveredAt: SENT } }) }), { knex });
    expect(out.roofPoints.pins).toHaveLength(2);
  });

  test('no frozen copy: {}', async () => {
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: undefined, reads: [frozenRead()] }) })).toEqual({});
  });

  test('a copy older than the latest handoff: {} (a later send could not replace or delete it)', async () => {
    const knex = fakeKnex({ point: point(), reads: [frozenRead()] });
    expect(await roofPointsDocBlock(est({ estimate_data: { deliveryState: { lastDeliveredAt: LATER } } }), { knex })).toEqual({});
    // One millisecond is enough.
    expect(await roofPointsDocBlock(est({ estimate_data: { deliveryState: { lastDeliveredAt: '2026-11-20T16:00:00.001Z' } } }), { knex })).toEqual({});
  });

  test('a copy newer than the stamp on the estimate shows (the copy landed, the estimate write did not)', async () => {
    const knex = fakeKnex({ point: point({ delivered_at: new Date(LATER) }), reads: [frozenRead()] });
    expect((await roofPointsDocBlock(estimate, { knex })).roofPoints).toEqual(SNAPSHOT);
  });

  test.each([
    ['no delivery state on the estimate', est({ estimate_data: { result: {} } }), point()],
    ['no estimate data', est({ estimate_data: null }), point()],
    ['estimate data that is not JSON', est({ estimate_data: 'not json' }), point()],
    ['a handoff time that is not a date', est({ estimate_data: { deliveryState: { lastDeliveredAt: 'soon' } } }), point()],
    ['no handoff time on the copy', estimate, point({ delivered_at: null })],
  ])('%s: {} (nothing proves the copy is the latest send)', async (_name, row, copy) => {
    expect(await roofPointsDocBlock(row, { knex: fakeKnex({ point: copy, reads: [frozenRead()] }) })).toEqual({});
  });

  test('the frozen read hidden NOW: {} (hiding is immediate, the content stays frozen)', async () => {
    const knex = fakeKnex({ point: point(), reads: [frozenRead({ hide_on_estimate: true })] });
    expect(await roofPointsDocBlock(estimate, { knex })).toEqual({});
  });

  test('a newer finished read hidden with no points saved on it: {} (staff can hide without saving points)', async () => {
    const reads = [frozenRead(), frozenRead({ id: 'read-2', tech_pins: null, hide_on_estimate: true, created_at: new Date('2026-11-20T18:00:00Z') })];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).toEqual({});
  });

  test('the newest read with saved points hidden, under a newer unsaved read that is not: {}', async () => {
    const reads = [
      frozenRead(),
      frozenRead({ id: 'read-2', hide_on_estimate: true, created_at: new Date('2026-11-20T17:00:00Z') }),
      frozenRead({ id: 'read-3', tech_pins: null, created_at: new Date('2026-11-20T18:00:00Z') }),
    ];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).toEqual({});
  });

  test('the newest read with saved points hidden, under 60 newer reads with no points: {} (no count of reads un-hides it)', async () => {
    const newer = Array.from({ length: 60 }, (_, i) => frozenRead({
      id: `read-later-${i}`, tech_pins: null, created_at: new Date(Date.parse('2026-11-20T18:00:00Z') + i * 60000),
    }));
    const reads = [frozenRead(), frozenRead({ id: 'read-2', hide_on_estimate: true, created_at: new Date('2026-11-20T17:00:00Z') }), ...newer];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).toEqual({});
  });

  test('a newer read of the estimate hidden NOW: {} even though the frozen read is not hidden', async () => {
    const reads = [frozenRead(), frozenRead({ id: 'read-2', hide_on_estimate: true, created_at: new Date('2026-11-20T18:00:00Z') })];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).toEqual({});
  });

  test('an older hidden read under a newer visible one with points does not hide it; another estimate\'s hidden read does not either', async () => {
    const reads = [
      frozenRead({ id: 'read-0', hide_on_estimate: true, created_at: new Date('2026-11-19T15:00:00Z') }),
      frozenRead(),
      frozenRead({ id: 'read-x', estimate_id: 'est-2', hide_on_estimate: true, created_at: new Date('2026-11-20T18:00:00Z') }),
    ];
    expect((await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).roofPoints).toEqual(SNAPSHOT);
  });

  test('the estimate moved to another address since the send: {}; so does a missing or blank address on either side', async () => {
    const knex = fakeKnex({ point: point(), reads: [frozenRead()] });
    expect(await roofPointsDocBlock(est({ address: '99 Other Road, Sarasota, FL 34232' }), { knex })).toEqual({});
    expect(await roofPointsDocBlock(est({ address: null }), { knex })).toEqual({});
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point({ address: null }), reads: [frozenRead()] }) })).toEqual({});
    // Spaces or punctuation alone name no home, on either side or on both.
    for (const blank of ['   ', ' - ', '.,']) {
      expect(await roofPointsDocBlock(est({ address: blank }), { knex })).toEqual({});
      expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point({ address: blank }), reads: [frozenRead()] }) })).toEqual({});
      expect(await roofPointsDocBlock(est({ address: blank }), { knex: fakeKnex({ point: point({ address: ' - ' }), reads: [frozenRead()] }) })).toEqual({});
    }
    // Case, spacing, punctuation and a trailing ZIP or state do not make it another home.
    expect((await roofPointsDocBlock(est({ address: '12 synthetic way,  Bradenton FL' }), { knex })).roofPoints).toEqual(SNAPSHOT);
  });

  test('a copy with no photo or no points: {}', async () => {
    const reads = [frozenRead()];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point({ snapshot: { ...SNAPSHOT, pins: [] } }), reads }) })).toEqual({});
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point({ snapshot: { ...SNAPSHOT, imageUrl: '' } }), reads }) })).toEqual({});
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point({ snapshot: 'not json' }), reads }) })).toEqual({});
  });

  test.each(['estimate_roof_points', 'roof_entry_reads'])('a storage failure on %s omits the section, never throws, and logs only the code', async (table) => {
    const knex = fakeKnex({ point: point(), reads: [frozenRead()], throwOn: table });
    expect(await roofPointsDocBlock(estimate, { knex })).toEqual({});
    expect(logger.warn).toHaveBeenLastCalledWith('[estimate-roof-points] section skipped for estimate est-1: 57014');
  });

  test('an estimate with no id: {}', async () => {
    expect(await roofPointsDocBlock({}, { knex: fakeKnex({}) })).toEqual({});
  });
});

describe('freeze helpers never throw', () => {
  test('a failing read reports skipped and logs only the code; a row with no id is skipped', async () => {
    const knex = fakeKnex({ reads: [], throwOn: 'roof_entry_reads' });
    expect(await freezeRoofPointsForEstimate({ id: 'est-1', address: ADDRESS }, { knex, deliveredAt: SENT })).toBe('skipped');
    expect(logger.warn).toHaveBeenLastCalledWith('[estimate-roof-points] freeze skipped for estimate est-1: 57014');
    expect(await freezeRoofPointsForEstimate({}, { knex, deliveredAt: SENT })).toBe('skipped');
    expect(await freezeRoofPointsForEstimate(null, { knex, deliveredAt: SENT })).toBe('skipped');
  });

  test.each([undefined, null, '', 'soon'])('a freeze that names no handoff time (%p) is skipped and touches no table', async (deliveredAt) => {
    const knex = jest.fn();
    expect(await freezeRoofPointsForEstimate({ id: 'est-1', address: ADDRESS }, { knex, deliveredAt })).toBe('skipped');
    expect(knex).not.toHaveBeenCalled();
  });
});
