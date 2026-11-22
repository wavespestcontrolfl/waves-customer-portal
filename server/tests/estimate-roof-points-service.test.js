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
function fakeKnex({ point, reads = [], throwOn = null, onLock = null }) {
  const knex = (table) => {
    const q = {};
    let where = {};
    let pointsOnly = false;
    // An object of equalities, or the one comparison the service uses: a copy not newer than a handoff time.
    let notAfter = null;
    q.where = (...args) => {
      if (args.length === 1) { where = { ...where, ...args[0] }; return q; }
      if (args[0] !== 'delivered_at' || args[1] !== '<=') throw new Error(`unexpected filter: ${args.slice(0, 2).join(' ')}`);
      [, , notAfter] = args;
      return q;
    };
    const inTime = () => notAfter == null || new Date(point.delivered_at) <= new Date(notAfter);
    const noted = (write) => (notAfter == null ? write : { ...write, notAfter });
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
    // Writes to the copy table are recorded, not applied. An update answers 1 when its where clauses name the copy.
    let unnamedOnly = false;
    q.whereNull = (column) => { unnamedOnly = column === 'customer_id'; return q; };
    q.del = async () => { knex.writes.push(noted({ del: where })); return point && inTime() ? 1 : 0; };
    q.update = async (patch) => {
      knex.writes.push(noted({ update: patch, where }));
      return point && inTime() && Object.entries(where).every(([k, v]) => point[k] === v) && (!unnamedOnly || point.customer_id == null) ? 1 : 0;
    };
    q.insert = (record) => ({ onConflict: () => ({ merge: async () => { knex.writes.push({ insert: record }); } }) });
    // A row lock is recorded. `onLock` stands for what a transaction that held the row committed meanwhile.
    q.forShare = () => { knex.locks.push({ table, where }); if (onLock) onLock(reads); return q; };
    return q;
  };
  knex.fn = { now: () => 'NOW' };
  knex.writes = [];
  knex.locks = [];
  knex.raws = [];
  knex.raw = async (sql) => { knex.raws.push(sql); };
  knex.transaction = async (work) => work(knex);
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
      { n: 1, x: 0.2, y: 0.3, type: 'gable_vents', label: 'Gable vent, front left', action: 'screen' },
      { n: 2, x: 0.4, y: 0.5, type: 'gable_vents', label: 'Gable vent, gate code 1234', action: 'screen' },
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

// Staff preview: what the NEXT send would freeze, before there is a copy the customer can see. The copy and the next-send
// points come from one function, so the freeze and the preview cannot disagree.
describe('roofPointsDocBlock: staff preview', () => {
  // A read whose points the technician set (a real list, a crop centre and a photo year), saved for ADDRESS, no copy yet.
  const draftRead = (over = {}) => frozenRead({
    tech_pins: [
      { x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', note: 'front left' },
      { x: 0.7, y: 0.55, type: 'trees_touching_roof', note: 'gate code 1234' },
    ],
    crop_lat: '27.46000', crop_lng: '-82.50000', crop_zoom: 20, image_source: 'manatee_2025_rgb', image_year: 2025,
    points_address: ADDRESS, ...over,
  });
  const noCopy = (reads) => fakeKnex({ point: undefined, reads });
  const preview = (reads, row = estimate) => roofPointsDocBlock(row, { knex: noCopy(reads), staffPreview: true });

  test('no copy yet, staff preview, a confirmed list: the block the next send would freeze, marked preview, labels screened', async () => {
    const out = await preview([draftRead()]);
    expect(Object.keys(out)).toEqual(['roofPoints']);
    const block = out.roofPoints;
    expect(block.preview).toBe(true);
    expect(Object.keys(block).sort()).toEqual(['imageUrl', 'imageYear', 'pins', 'preview']);
    expect(block.imageYear).toBe(2025);
    expect(block.imageUrl).toEqual(expect.any(String));
    expect(block.pins.map((p) => p.n)).toEqual([1, 2]);
    expect(block.pins[0].label).toBe('Roof return, front left');
    expect(block.pins[0].action).toBe('seal');
    // The note that fails the customer-copy screen never shows: the standard label of the point stays.
    expect(block.pins[1].label).not.toMatch(/1234|gate/i);
    expect(block.pins[1].label).toBe('Branch touching the roof');
    expect(Object.keys(block.pins[0]).sort()).toEqual(['action', 'label', 'n', 'type', 'x', 'y']);
  });

  test('the preview block is the block the freeze would store (one function): same photo, year and pins', async () => {
    const knex = noCopy([draftRead()]);
    const insert = jest.fn(() => ({ onConflict: () => ({ merge: async () => {} }) }));
    const writer = (table) => (table === 'estimate_roof_points' ? { insert } : knex(table));
    writer.fn = knex.fn;
    expect(await freezeRoofPointsForEstimate(estimate, { knex: writer, deliveredAt: SENT })).toBe('frozen');
    const stored = JSON.parse(insert.mock.calls[0][0].snapshot);
    const { preview: _marker, ...shown } = (await preview([draftRead()])).roofPoints;
    expect(shown.imageUrl).toBe(stored.imageUrl);
    expect(shown.imageYear).toBe(stored.imageYear);
    expect(shown.pins.map(({ n, x, y, type, action }) => ({ n, x, y, type, action }))).toEqual(stored.pins.map(({ n, x, y, type, action }) => ({ n, x, y, type, action })));
  });

  test.each([undefined, false, 'true', 1, null])('a customer (staffPreview %p) with no copy gets {} even with confirmed points', async (staffPreview) => {
    const out = await roofPointsDocBlock(estimate, { knex: noCopy([draftRead()]), ...(staffPreview === undefined ? {} : { staffPreview }) });
    expect(out).toEqual({});
  });

  test('omitting the options keeps today\'s answers: no preview key on the customer block, {} with no copy', async () => {
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads: [frozenRead()] }) })).toEqual({ roofPoints: SNAPSHOT });
    expect(await roofPointsDocBlock(estimate, { knex: fakeKnex({ point: point(), reads: [frozenRead()] }), staffPreview: false })).toEqual({ roofPoints: SNAPSHOT });
    expect(await roofPointsDocBlock(estimate, { knex: noCopy([draftRead()]) })).toEqual({});
  });

  test('hidden points: {} in the preview, whether the points read or any other read of the estimate is hidden', async () => {
    expect(await preview([draftRead({ hide_on_estimate: true })])).toEqual({});
    const other = frozenRead({ id: 'read-2', tech_pins: null, hide_on_estimate: true, created_at: new Date('2026-11-20T18:00:00Z') });
    expect(await preview([draftRead(), other])).toEqual({});
    // An OLDER hidden read: the newest points read is the visible one, so only the any-read rule hides the preview.
    const older = frozenRead({ id: 'read-0', tech_pins: null, hide_on_estimate: true, created_at: new Date('2026-11-19T15:00:00Z') });
    expect(await preview([draftRead(), older])).toEqual({});
    // A hidden read of another estimate changes nothing.
    const elsewhere = frozenRead({ id: 'read-x', estimate_id: 'est-2', context_key: 'e:est-2', hide_on_estimate: true, created_at: new Date('2026-11-19T15:00:00Z') });
    expect((await preview([draftRead(), elsewhere])).roofPoints.preview).toBe(true);
  });

  test('points saved for another address, or with no address: {} in the preview', async () => {
    expect(await preview([draftRead({ points_address: '99 Other Road, Sarasota, FL 34232' })])).toEqual({});
    expect(await preview([draftRead({ points_address: null })])).toEqual({});
    expect(await preview([draftRead()], est({ address: '99 Other Road, Sarasota, FL 34232' }))).toEqual({});
    expect(await preview([draftRead({ points_address: '12 Synthetic Way, Bradenton, FL 34208' })])).toEqual({});
  });

  test('a read that names another customer, or no customer once the estimate has one: {} in the preview', async () => {
    expect(await preview([draftRead({ customer_id: 'cust-b', context_key: 'e:est-1|c:cust-b' })])).toEqual({});
    expect(await preview([draftRead({ customer_id: null })])).toEqual({});
    expect(await preview([draftRead({ context_key: 'e:est-2' })])).toEqual({});
    // A lead (no customer on either side) previews its own read.
    expect((await preview([draftRead({ customer_id: null })], est({ customer_id: null }))).roofPoints.preview).toBe(true);
  });

  test('an empty or cleared list, an unfinished read and no read at all: {} in the preview', async () => {
    expect(await preview([draftRead({ tech_pins: [] })])).toEqual({});
    expect(await preview([draftRead({ tech_pins: null })])).toEqual({});
    expect(await preview([draftRead({ status: 'pending' })])).toEqual({});
    expect(await preview([])).toEqual({});
  });

  test('the customer copy is shown to staff as it is, with no preview key (staff see what the customer sees)', async () => {
    const knex = fakeKnex({ point: point(), reads: [frozenRead(), draftRead({ id: 'read-3', created_at: new Date('2026-11-20T20:00:00Z') })] });
    const out = await roofPointsDocBlock(estimate, { knex, staffPreview: true });
    expect(out).toEqual({ roofPoints: SNAPSHOT });
    expect(out.roofPoints).not.toHaveProperty('preview');
  });

  test('a stale copy the customer cannot see gives the staff preview of the next send, not the stale copy', async () => {
    const knex = fakeKnex({ point: point({ delivered_at: new Date('2026-11-19T16:00:00Z') }), reads: [draftRead({ id: 'read-3' })] });
    const out = await roofPointsDocBlock(estimate, { knex, staffPreview: true });
    expect(out.roofPoints.preview).toBe(true);
    expect(out.roofPoints.imageUrl).not.toBe(SNAPSHOT.imageUrl);
  });

  test.each(['estimate_roof_points', 'roof_entry_reads'])('a storage failure on %s in the preview omits the section and never throws', async (table) => {
    const knex = fakeKnex({ point: undefined, reads: [draftRead()], throwOn: table });
    expect(await roofPointsDocBlock(estimate, { knex, staffPreview: true })).toEqual({});
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

// Owner follow-up "keep" (2026-11-21): the copy a lead already holds stays for the first customer the estimate takes.
// The copy carries the estimate's count of customer changes at its send (lead_changes); the estimate row carries the
// count now (customer_changes, kept by a database trigger: estimate-roof-points-keep-postgres.test.js).
describe('a lead\'s copy and the first customer of the estimate', () => {
  const leadRead = (over = {}) => frozenRead({
    customer_id: null,
    tech_pins: [{ x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', note: 'front left' }],
    crop_lat: '27.46000', crop_lng: '-82.50000', crop_zoom: 20, image_source: 'manatee_2025_rgb', image_year: 2025,
    points_address: ADDRESS, ...over,
  });
  const leadCopy = (over = {}) => point({ customer_id: null, lead_changes: 3, ...over });
  const shows = async (estimateRow, copy = leadCopy(), reads = [leadRead()]) => Boolean(
    (await roofPointsDocBlock(estimateRow, { knex: fakeKnex({ point: copy, reads }) })).roofPoints);
  const lead = (changes) => est({ customer_id: null, customer_changes: changes });
  const customer = (changes, id = 'cust-a') => est({ customer_id: id, customer_changes: changes });

  test('it shows to the same lead, and to the first customer the estimate takes after that send', async () => {
    expect(await shows(lead(3))).toBe(true);
    expect(await shows(customer(4))).toBe(true);
    expect((await roofPointsDocBlock(customer(4), { knex: fakeKnex({ point: leadCopy(), reads: [leadRead()] }) })).roofPoints).toEqual(SNAPSHOT);
  });

  test('it shows to no one after any other change of the estimate\'s customer', async () => {
    // A second customer, or a duplicate merge of the first: two changes.
    expect(await shows(customer(5, 'cust-b'))).toBe(false);
    expect(await shows(customer(5))).toBe(false);
    // The estimate lost its customer again: the next lead is not the lead that copy was sent to.
    expect(await shows(lead(5))).toBe(false);
    expect(await shows(lead(4))).toBe(false);
    // And the customer after that.
    expect(await shows(customer(6, 'cust-b'))).toBe(false);
    // Counts that the trigger never produces together prove nothing: a customer with no change, a count that went back.
    expect(await shows(customer(3))).toBe(false);
    expect(await shows(customer(2))).toBe(false);
    expect(await shows(lead(2))).toBe(false);
  });

  test.each([undefined, null, '4', 4.5, NaN])('an estimate row that carries no whole count (%p) shows no counted copy, to a customer or to a lead', async (changes) => {
    expect(await shows(est({ customer_id: 'cust-a', customer_changes: changes }))).toBe(false);
    expect(await shows(est({ customer_id: null, customer_changes: changes }))).toBe(false);
  });

  test('a lead\'s copy from before the count keeps its rule: the lead only, never a customer', async () => {
    for (const none of [null, undefined]) {
      expect(await shows(lead(0), leadCopy({ lead_changes: none }))).toBe(true);
      expect(await shows(est({ customer_id: null }), leadCopy({ lead_changes: none }))).toBe(true);
      expect(await shows(lead(7), leadCopy({ lead_changes: none }))).toBe(true);
      expect(await shows(customer(1), leadCopy({ lead_changes: none }))).toBe(false);
    }
    // A count that is not a whole number is no count for the first customer, and is not the lead's own either.
    expect(await shows(customer(4), leadCopy({ lead_changes: '3' }))).toBe(false);
    expect(await shows(lead(3), leadCopy({ lead_changes: '3' }))).toBe(false);
  });

  test('a customer\'s copy is judged by its customer alone, whatever the counts say', async () => {
    const own = [frozenRead()];
    expect(await shows(customer(4), point({ lead_changes: 3 }), own)).toBe(true);
    expect(await shows(customer(9), point({ lead_changes: null }), own)).toBe(true);
    expect(await shows(customer(4, 'cust-b'), point({ lead_changes: 3 }), [frozenRead({ customer_id: 'cust-b' })])).toBe(false);
    expect(await shows(lead(3), point({ lead_changes: 3 }), [leadRead()])).toBe(false);
    // Nor does a count on it let a read that names no customer stand in for the customer's own read.
    expect(await shows(customer(4), point({ lead_changes: 3 }), [leadRead()])).toBe(false);
  });

  test('the first customer keeps the copy only while its read is still the lead\'s, or theirs by now', async () => {
    const first = customer(4);
    // Staff pressed Save points since: the read names this customer. The lead's copy stays until the next send.
    expect(await shows(first, leadCopy(), [leadRead({ customer_id: 'cust-a' })])).toBe(true);
    // A read that names another customer, a read made for a named customer (the two-part key), another estimate's
    // read, a read that is gone, and a copy with no read: not shown.
    expect(await shows(first, leadCopy(), [leadRead({ customer_id: 'cust-b' })])).toBe(false);
    expect(await shows(first, leadCopy(), [leadRead({ context_key: 'e:est-1|c:cust-b' })])).toBe(false);
    expect(await shows(first, leadCopy(), [leadRead({ context_key: 'e:est-2' })])).toBe(false);
    expect(await shows(first, leadCopy(), [])).toBe(false);
    expect(await shows(first, leadCopy({ read_id: null }))).toBe(false);
    // The same lead, with a read that was given a customer: not the lead's.
    expect(await shows(lead(3), leadCopy(), [leadRead({ customer_id: 'cust-a' })])).toBe(false);
  });

  test('every other page rule still applies to the first customer: hidden, another address, an older handoff', async () => {
    const first = customer(4);
    expect(await shows(first, leadCopy(), [leadRead({ hide_on_estimate: true })])).toBe(false);
    expect(await shows(first, leadCopy(), [leadRead(), frozenRead({ id: 'read-2', customer_id: 'cust-a', hide_on_estimate: true })])).toBe(false);
    expect(await shows({ ...first, address: '99 Other Road, Bradenton, FL 34203' })).toBe(false);
    expect(await shows({ ...first, estimate_data: { deliveryState: { lastDeliveredAt: LATER } } })).toBe(false);
  });

  describe('a send', () => {
    const freeze = async (estimateRow, { copy, reads = [leadRead()], at = LATER, onLock } = {}) => {
      const knex = fakeKnex({ point: copy, reads, onLock });
      const out = await freezeRoofPointsForEstimate(estimateRow, { knex, deliveredAt: at });
      locks = knex.locks;
      raws = knex.raws;
      return { out, writes: knex.writes };
    };
    // The row locks and the raw statements of the last freeze.
    let locks;
    let raws;
    const ESTIMATE_LOCK = [{ table: 'estimates', where: { id: 'est-1' } }];
    // The keep and the clear of a first customer's send name only a copy no later handoff wrote (notAfter).
    const KEPT = [{ update: { delivered_at: LATER }, where: { estimate_id: 'est-1', read_id: 'read-1', lead_changes: 3 }, notAfter: LATER }];
    const CLEARED_NOT_NEWER = [{ del: { estimate_id: 'est-1' }, notAfter: LATER }];
    // Every other send with no points clears as before.
    const CLEARED = [{ del: { estimate_id: 'est-1' } }];

    test('to a lead writes the estimate\'s count on the copy; to a customer, or from a row with no count, it writes none', async () => {
      const stamp = async (estimateRow, reads) => (await freeze(estimateRow, { reads })).writes.map((w) => [w.insert.customer_id, w.insert.lead_changes]);
      expect(await stamp(lead(3))).toEqual([[null, 3]]);
      expect(await stamp(lead(0))).toEqual([[null, 0]]);
      expect(await stamp(customer(4), [leadRead({ customer_id: 'cust-a' })])).toEqual([['cust-a', null]]);
      for (const changes of [undefined, null, '3', 2.5]) {
        expect(await stamp(est({ customer_id: null, customer_changes: changes }))).toEqual([[null, null]]);
      }
    });

    test('to the first customer, with no points saved for them, keeps the lead\'s copy and gives it this handoff\'s time', async () => {
      expect(await freeze(customer(4), { copy: leadCopy() })).toEqual({ out: 'kept', writes: KEPT });
    });

    test('decides to keep, freeze or clear under a lock on the estimate row, with a 5 second wait; no other send takes that lock', async () => {
      await freeze(customer(4), { copy: leadCopy() });
      expect([locks, raws]).toEqual([ESTIMATE_LOCK, ["SET LOCAL lock_timeout = '5s'"]]);
      // The first customer's lead copy that will be cleared is judged under the lock too.
      await freeze(customer(4), { copy: leadCopy(), reads: [leadRead({ tech_pins: null })] });
      expect(locks).toEqual(ESTIMATE_LOCK);
      // A send to a lead, to a second customer, to a customer with no lead copy, and one that freezes points: no lock.
      const unlocked = [
        [lead(3), { copy: leadCopy() }],
        [lead(3), { copy: leadCopy(), reads: [] }],
        [customer(5, 'cust-b'), { copy: leadCopy() }],
        [customer(4), { copy: undefined }],
        [customer(4), { copy: leadCopy({ lead_changes: null }) }],
        [customer(4), { copy: leadCopy(), reads: [leadRead({ customer_id: 'cust-a' })] }],
      ];
      for (const [estimateRow, options] of unlocked) {
        await freeze(estimateRow, options);
        expect([locks, raws]).toEqual([[], []]);
      }
    });

    test('a points save for the first customer that lands while the send waits for the lock is seen: their points are frozen, or their clear clears', async () => {
      // The save named the customer on the lead's read. Before the lock that read was the lead's; after it, the customer's.
      const named = (reads) => { reads[0].customer_id = 'cust-a'; };
      const frozen = await freeze(customer(4), { copy: leadCopy(), onLock: named });
      expect(frozen.out).toBe('frozen');
      expect(frozen.writes.map((w) => [w.insert.read_id, w.insert.customer_id, w.insert.lead_changes])).toEqual([['read-1', 'cust-a', null]]);
      // The save cleared the points for the customer: the read is theirs and holds none.
      const clearedForThem = (reads) => { Object.assign(reads[0], { customer_id: 'cust-a', tech_pins: null }); };
      expect(await freeze(customer(4), { copy: leadCopy(), onLock: clearedForThem })).toEqual({ out: 'cleared', writes: CLEARED_NOT_NEWER });
      // A newer read of their own with cleared points, beside the lead's untouched read: their read decides.
      const ownCleared = (reads) => { reads.push(leadRead({ id: 'read-2', customer_id: 'cust-a', tech_pins: null, created_at: new Date('2026-11-20T15:30:00Z') })); };
      expect(await freeze(customer(4), { copy: leadCopy(), onLock: ownCleared })).toEqual({ out: 'cleared', writes: CLEARED_NOT_NEWER });
    });

    test('a lock that cannot be had in time skips the freeze: nothing is written and only the code is logged', async () => {
      const busy = () => { throw Object.assign(new Error('canceling statement due to lock timeout: 12 Synthetic Way'), { code: '55P03' }); };
      expect(await freeze(customer(4), { copy: leadCopy(), onLock: busy })).toEqual({ out: 'skipped', writes: [] });
      expect(logger.warn).toHaveBeenLastCalledWith('[estimate-roof-points] freeze skipped for estimate est-1: 55P03');
    });

    test('to the first customer clears the copy, as before, when the page does not show it', async () => {
      const cleared = async (estimateRow, options, writes = CLEARED) => expect(await freeze(estimateRow, options)).toEqual({ out: 'cleared', writes });
      // No copy, a copy from before the count, a second customer: not a first customer's lead copy.
      await cleared(customer(4), { copy: undefined });
      await cleared(customer(4), { copy: leadCopy({ lead_changes: null }) });
      await cleared(customer(5, 'cust-b'), { copy: leadCopy() });
      // A first customer's lead copy under an older handoff, for another address, or hidden.
      await cleared(customer(4), { copy: leadCopy({ delivered_at: new Date('2026-11-20T10:00:00.000Z') }) }, CLEARED_NOT_NEWER);
      await cleared({ ...customer(4), address: '99 Other Road, Bradenton, FL 34203' }, { copy: leadCopy() }, CLEARED_NOT_NEWER);
      await cleared(customer(4), { copy: leadCopy(), reads: [leadRead({ hide_on_estimate: true })] }, CLEARED_NOT_NEWER);
    });

    test('to the first customer clears the copy when the lead\'s read would no longer be sent to a lead', async () => {
      const cleared = async (reads) => expect(await freeze(customer(4), { copy: leadCopy(), reads })).toEqual({ out: 'cleared', writes: CLEARED_NOT_NEWER });
      // The lead's points were cleared, or confirmed as none, after that send.
      await cleared([leadRead({ tech_pins: null })]);
      await cleared([leadRead({ tech_pins: [] })]);
      // They were saved for another address.
      await cleared([leadRead({ points_address: '99 Other Road, Bradenton, FL 34203' })]);
      // A newer points read of the lead exists: the copy is not from the newest one.
      await cleared([leadRead(), leadRead({ id: 'read-2', created_at: new Date('2026-11-20T15:30:00Z') })]);
    });

    test('to the first customer with a points read of their own follows that read: frozen for them, or cleared', async () => {
      const own = leadRead({ id: 'read-2', customer_id: 'cust-a', created_at: new Date('2026-11-20T15:30:00Z') });
      const frozen = await freeze(customer(4), { copy: leadCopy(), reads: [leadRead(), own] });
      expect(frozen.out).toBe('frozen');
      expect(frozen.writes.map((w) => [w.insert.read_id, w.insert.customer_id, w.insert.lead_changes])).toEqual([['read-2', 'cust-a', null]]);
      // Their own read with the points cleared: the lead's copy goes.
      expect(await freeze(customer(4), { copy: leadCopy(), reads: [leadRead(), { ...own, tech_pins: null }] })).toEqual({ out: 'cleared', writes: CLEARED });
    });

    test('a copy a later handoff wrote is left as it is: this send does not take its time back and does not delete it', async () => {
      const newer = leadCopy({ delivered_at: new Date('2026-11-20T21:00:00.000Z') });
      // The keep names a copy not newer than this handoff: it matches no row, and nothing else is written.
      expect(await freeze(customer(4), { copy: newer })).toEqual({ out: 'skipped', writes: KEPT });
      // So does the clear (here: the points are hidden, so there is nothing to keep).
      expect(await freeze(customer(4), { copy: newer, reads: [leadRead({ hide_on_estimate: true })] })).toEqual({ out: 'cleared', writes: CLEARED_NOT_NEWER });
    });

    test('to a lead with no points clears the copy; a copy another send replaced meanwhile is neither kept nor deleted', async () => {
      expect(await freeze(lead(3), { copy: leadCopy(), reads: [] })).toEqual({ out: 'cleared', writes: CLEARED });
      // The update names the copy it judged (read and count, no customer). A copy that is another one by then
      // answers 0 rows: that send's copy stays as it is, and this send reports skipped.
      const knex = fakeKnex({ point: leadCopy(), reads: [leadRead()] });
      const table = (name) => {
        const q = knex(name);
        if (name === 'estimate_roof_points') q.update = async () => 0;
        return q;
      };
      Object.assign(table, { fn: knex.fn, raw: knex.raw, transaction: async (work) => work(table) });
      expect(await freezeRoofPointsForEstimate(customer(4), { knex: table, deliveredAt: LATER })).toBe('skipped');
      expect(knex.writes).toEqual([]);
    });
  });
});
