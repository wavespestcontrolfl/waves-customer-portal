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

// The reads table answers by its where clauses, newest first: one row (first) or every row (select, no limit).
function fakeKnex({ point, reads = [], throwOn = null }) {
  const knex = (table) => {
    const q = {};
    let where = {};
    let pointsOnly = false;
    q.where = (w) => { where = { ...where, ...w }; return q; };
    // The one raw filter the service uses: reads whose points the technician set (a list, or a cleared one).
    q.whereRaw = (sql) => {
      if (sql !== "(crop_lat IS NOT NULL OR (tech_pins IS NOT NULL AND jsonb_typeof(tech_pins) = 'array'))") throw new Error(`unexpected raw filter: ${sql}`);
      pointsOnly = true;
      return q;
    };
    q.orderBy = () => q;
    const list = () => {
      if (throwOn === table) throw Object.assign(new Error(`${table} down: 12 Synthetic Way, note "front left"`), { code: '57014' });
      return reads
        .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        .filter((r) => !pointsOnly || r.crop_lat != null || Array.isArray(r.tech_pins))
        .sort((a, b) => b.created_at - a.created_at);
    };
    q.select = async () => list();
    q.first = async () => {
      if (table !== 'estimate_roof_points') return list()[0];
      if (throwOn === table) throw Object.assign(new Error(`${table} down: 12 Synthetic Way, note "front left"`), { code: '57014' });
      return point;
    };
    return q;
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}
// The copy names the customer it was frozen for (the estimate's holder at that send).
const point = (over = {}) => ({ estimate_id: 'est-1', read_id: 'read-1', customer_id: 'cust-a', address: ADDRESS, snapshot: SNAPSHOT, delivered_at: new Date(SENT), ...over });
const frozenRead = (over = {}) => ({
  id: 'read-1', estimate_id: 'est-1', context_key: 'e:est-1', customer_id: 'cust-a', status: 'done', tech_pins: [{}], crop_lat: '27.46000',
  hide_on_estimate: false, created_at: new Date('2026-11-20T15:00:00Z'), ...over,
});
const est = (over = {}) => ({ id: 'est-1', customer_id: 'cust-a', address: ADDRESS, estimate_data: { deliveryState: { lastDeliveredAt: SENT } }, ...over });
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

  test('read A gave the copy, staff hid on newer read B (no points), then read C came with nothing hidden on it: still {}', async () => {
    // The hide is the estimate's choice. A fresh read must never bring the points back.
    const reads = [
      frozenRead(),
      frozenRead({ id: 'read-b', tech_pins: null, hide_on_estimate: true, created_at: new Date('2026-11-20T17:00:00Z') }),
      frozenRead({ id: 'read-c', tech_pins: null, created_at: new Date('2026-11-20T18:00:00Z') }),
    ];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).toEqual({});
  });

  test('a hidden read of the estimate hides the points whatever its age or status; another estimate\'s hidden read does not', async () => {
    const older = frozenRead({ id: 'read-0', hide_on_estimate: true, created_at: new Date('2026-11-19T15:00:00Z') });
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads: [older, frozenRead()] }) })).toEqual({});
    const pending = frozenRead({ id: 'read-p', status: 'pending', tech_pins: null, hide_on_estimate: true });
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads: [frozenRead(), pending] }) })).toEqual({});
    const elsewhere = frozenRead({ id: 'read-x', estimate_id: 'est-2', hide_on_estimate: true, created_at: new Date('2026-11-20T18:00:00Z') });
    expect((await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads: [frozenRead(), elsewhere] }) })).roofPoints).toEqual(SNAPSHOT);
  });

  test('the read the copy came from is hidden but no longer names the estimate: {}', async () => {
    const reads = [frozenRead({ estimate_id: null, hide_on_estimate: true })];
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads }) })).toEqual({});
  });

  test("the copy shows only while its read names the customer who holds the estimate now, or both name none", async () => {
    // The copy is frozen for the estimate's holder in each case, so only the read's side is judged here.
    const show = async (estimateRow, read) => (await roofPointsDocBlock(estimateRow, {
      knex: fakeKnex({ point: point({ customer_id: estimateRow.customer_id }), reads: read ? [read] : [] }),
    })).roofPoints;
    const forA = frozenRead({ context_key: 'e:est-1|c:cust-a', customer_id: 'cust-a' });
    const forB = frozenRead({ context_key: 'e:est-1|c:cust-b', customer_id: 'cust-b' });
    expect(await show(estimate, forA)).toEqual(SNAPSHOT);
    // The estimate went to another customer since the send, or has none now: A's read is not theirs.
    expect(await show(est({ customer_id: 'cust-b' }), forA)).toBeUndefined();
    expect(await show(est({ customer_id: null }), forA)).toBeUndefined();
    expect(await show(estimate, forB)).toBeUndefined();
    // After a duplicate merge the read's customer is the estimate's customer: it answers again (the roof read's own rule).
    expect(await show(estimate, { ...forB, customer_id: 'cust-a' })).toEqual(SNAPSHOT);
    // Points saved for a lead: the read names no customer. They show while the estimate has no customer. Once it has
    // one they are hidden until a person saves them again, so lead -> A -> B never reaches B (and nothing guesses A).
    const forLead = frozenRead({ customer_id: null });
    expect(await show(est({ customer_id: null }), forLead)).toEqual(SNAPSHOT);
    expect(await show(estimate, forLead)).toBeUndefined();
    expect(await show(est({ customer_id: 'cust-b' }), forLead)).toBeUndefined();
    // A plain read names the customer who held the estimate when its points were saved: A's alone (ids compare without case).
    const plainForA = frozenRead({ customer_id: 'CUST-A' });
    expect(await show(estimate, plainForA)).toEqual(SNAPSHOT);
    expect(await show(est({ customer_id: 'cust-b' }), plainForA)).toBeUndefined();
    expect(await show(est({ customer_id: null }), plainForA)).toBeUndefined();
    // A read of another estimate, or a copy whose read is gone, proves nothing.
    expect(await show(estimate, frozenRead({ context_key: 'e:est-2' }))).toBeUndefined();
    expect(await show(estimate, null)).toBeUndefined();
    expect((await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point({ read_id: null }), reads: [frozenRead()] }) })).roofPoints).toBeUndefined();
  });

  test('the copy is shown only to the customer it was frozen for, whatever its read says now', async () => {
    const show = async (estimateRow, copy, read = frozenRead({ customer_id: estimateRow.customer_id })) => (
      await roofPointsDocBlock(estimateRow, { knex: fakeKnex({ point: point(copy), reads: [read] }) })).roofPoints;
    // Frozen for a lead (no customer). The estimate then got customer A and staff saved points on the read, so the
    // read names A now: the lead's copy is still not A's. The next send freezes a copy for A.
    expect(await show(est({ customer_id: null }), { customer_id: null })).toEqual(SNAPSHOT);
    expect(await show(estimate, { customer_id: null })).toBeUndefined();
    // Frozen for A: shown to A (ids compare without case), never to B or on an estimate with no customer.
    expect(await show(estimate, { customer_id: 'CUST-A' })).toEqual(SNAPSHOT);
    expect(await show(est({ customer_id: 'cust-b' }), { customer_id: 'cust-a' })).toBeUndefined();
    expect(await show(est({ customer_id: null }), { customer_id: 'cust-a' })).toBeUndefined();
    // A copy from before the column existed carries no customer: it reads as frozen for no one.
    expect(await show(estimate, { customer_id: undefined })).toBeUndefined();
  });

  test('a stored label is screened again where it is shown: one that fails keeps the standard label of its point', async () => {
    const pins = [
      { n: 1, x: 0.2, y: 0.3, type: 'gable_vents', label: 'Gable vent, front left', action: 'seal' },
      { n: 2, x: 0.4, y: 0.5, type: 'gable_vents', label: 'Gable vent, gate code 1234', action: 'seal' },
      { n: 3, x: 0.6, y: 0.7, type: 'no_such_type', label: 'Entry point, safe to enter', action: 'seal' },
    ];
    const knex = fakeKnex({ point: point({ snapshot: { ...SNAPSHOT, pins } }), reads: [frozenRead()] });
    const shown = (await roofPointsDocBlock(estimate, { knex })).roofPoints.pins.map((p) => p.label);
    expect(shown[0]).toBe('Gable vent, front left');
    expect(shown[1]).not.toMatch(/1234|gate/i);
    expect(shown[1]).toBe(shown[0].split(',')[0]);
    expect(shown[2]).toBe('Entry point');
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
    // The same street line in another ZIP is another home; a ZIP+4 of the same ZIP is not.
    expect(await roofPointsDocBlock(est({ address: '12 Synthetic Way, Bradenton, FL 34208' }), { knex })).toEqual({});
    expect((await roofPointsDocBlock(est({ address: '12 Synthetic Way, Bradenton, FL 34203-1187' }), { knex })).roofPoints).toEqual(SNAPSHOT);
    // Case, spacing, punctuation, a trailing state and a ZIP on one side only do not make it another home.
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
