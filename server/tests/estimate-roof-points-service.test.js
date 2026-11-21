// estimate-roof-points: the /data block for the customer page (owner ruling 2026-11-20, choice 4A). It prints the frozen
// copy, but staff hiding is immediate (the frozen read, the estimate's newest finished read with or without points, or its
// newest read with saved points, hidden NOW), and an estimate that has moved to another address prints nothing. Any miss
// is `{}` so the response stays byte-identical.
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

function fakeKnex({ point, reads = [], throwOn = null }) {
  const knex = (table) => {
    const q = {};
    let where = {};
    q.where = (w) => { where = { ...where, ...w }; return q; };
    q.whereRaw = () => q;
    q.orderBy = () => q;
    q.limit = () => q;
    const matching = () => {
      if (throwOn === table) throw Object.assign(new Error(`${table} down: 12 Synthetic Way, note "front left"`), { code: '57014' });
      return reads.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).sort((a, b) => b.created_at - a.created_at);
    };
    q.first = async () => (table === 'estimate_roof_points' && throwOn !== table ? point : matching()[0]);
    q.select = async () => matching();
    return q;
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}
const point = (over = {}) => ({ estimate_id: 'est-1', read_id: 'read-1', address: ADDRESS, snapshot: SNAPSHOT, ...over });
const frozenRead = (over = {}) => ({ id: 'read-1', estimate_id: 'est-1', status: 'done', tech_pins: [{}], hide_on_estimate: false, created_at: new Date('2026-11-20T15:00:00Z'), ...over });
const estimate = { id: 'est-1', address: ADDRESS };

describe('roofPointsDocBlock', () => {
  test('a frozen copy that is not hidden and still matches the address is published as { imageUrl, imageYear, pins }', async () => {
    const out = await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads: [frozenRead()] }) });
    expect(out).toEqual({ roofPoints: SNAPSHOT });
  });

  test('the snapshot may arrive as a JSON string', async () => {
    const out = await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point({ snapshot: JSON.stringify(SNAPSHOT) }), reads: [frozenRead()] }) });
    expect(out.roofPoints.pins).toHaveLength(2);
  });

  test('no frozen copy: {}', async () => {
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: undefined, reads: [frozenRead()] }) })).toEqual({});
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

  test('a newer read of the estimate hidden NOW: {} even though the frozen read is not hidden', async () => {
    const reads = [frozenRead(), frozenRead({ id: 'read-2', hide_on_estimate: true, created_at: new Date('2026-11-20T18:00:00Z') })];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).toEqual({});
  });

  test('the estimate moved to another address since the send: {}; a missing address on either side still shows', async () => {
    const knex = fakeKnex({ point: point(), reads: [frozenRead()] });
    expect(await roofPointsDocBlock({ id: 'est-1', address: '99 Other Road, Sarasota, FL 34232' }, { knex })).toEqual({});
    expect((await roofPointsDocBlock({ id: 'est-1', address: null }, { knex })).roofPoints).toBeDefined();
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
    expect(await freezeRoofPointsForEstimate({ id: 'est-1', address: ADDRESS }, { knex })).toBe('skipped');
    expect(logger.warn).toHaveBeenLastCalledWith('[estimate-roof-points] freeze skipped for estimate est-1: 57014');
    expect(await freezeRoofPointsForEstimate({}, { knex })).toBe('skipped');
    expect(await freezeRoofPointsForEstimate(null, { knex })).toBe('skipped');
  });
});
