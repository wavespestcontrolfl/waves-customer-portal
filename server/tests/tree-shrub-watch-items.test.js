// GATE_TS_WATCH_LIST freeze: the technician's Seen / Not seen choices on the
// visit month's watch list are normalized and frozen on the service record
// (structured_notes.treeShrubWatchItems). Tech-facing storage only. Synthetic data.
const fs = require('fs');
const path = require('path');
const {
  normalizeWatchItems, freezeWatchItems, visitWatchMonth,
} = require('../services/tree-shrub-watch-items');
const { MONTHS } = require('../config/tree-shrub-watch-list');

const saved = process.env.GATE_TS_WATCH_LIST;
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_TS_WATCH_LIST; else process.env.GATE_TS_WATCH_LIST = saved;
});

const NOW = new Date('2026-10-04T15:00:00.000Z');

describe('normalizeWatchItems', () => {
  test('keeps known keys on the month list with a valid state; adds the label; one extent only on a seen item', () => {
    expect(normalizeWatchItems([
      { key: 'scale', state: 'seen', extent: 'a_few', source: 'read' },
      { key: 'whitefly', state: 'not_seen', extent: 'many', source: 'read' },
      { key: 'bed_weeds', state: 'seen', source: 'tech' },
    ], 10)).toEqual([
      { key: 'scale', label: 'Scale', state: 'seen', extent: 'a_few', source: 'read' },
      { key: 'whitefly', label: 'Whitefly', state: 'not_seen', extent: null, source: 'read' },
      { key: 'bed_weeds', label: 'Bed weeds', state: 'seen', extent: null, source: 'tech' },
    ]);
  });
  test('a refer-only item never keeps an extent', () => {
    expect(normalizeWatchItems([{ key: 'trunk_conk_base', state: 'seen', extent: 'many', source: 'tech' }], 10))
      .toEqual([{ key: 'trunk_conk_base', label: 'Trunk conk at the base', state: 'seen', extent: null, source: 'tech' }]);
  });
  test('invalid entries drop: unknown key, a key not on the visit month, bad state, non-objects', () => {
    expect(normalizeWatchItems([
      { key: 'made_up', state: 'seen' },
      { key: 'aphids', state: 'seen' }, // not on October's list
      { key: 'scale', state: 'maybe' },
      { key: 'scale' },
      { key: 5, state: 'seen' },
      null, 'scale', 7, [],
      { key: 'scale', state: 'seen', extent: 'enormous', source: 'elsewhere' },
    ], 10)).toEqual([{ key: 'scale', label: 'Scale', state: 'seen', extent: null, source: 'tech' }]);
  });
  test('dedupes by key, first one wins', () => {
    expect(normalizeWatchItems([
      { key: 'scale', state: 'not_seen', source: 'read' },
      { key: 'scale', state: 'seen', extent: 'many', source: 'read' },
    ], 10)).toEqual([{ key: 'scale', label: 'Scale', state: 'not_seen', extent: null, source: 'read' }]);
  });
  test('capped: never more entries than the month list, however long the body', () => {
    const everyKey = MONTHS[10].map((key) => ({ key, state: 'seen', source: 'tech' }));
    const flood = Array.from({ length: 5000 }, (_, i) => ({ key: `junk_${i}`, state: 'seen' }));
    expect(normalizeWatchItems([...flood, ...everyKey], 10)).toEqual([]); // the cap looks only at the first entries
    expect(normalizeWatchItems([...everyKey, ...flood], 10)).toHaveLength(MONTHS[10].length);
    expect(normalizeWatchItems([...everyKey, ...everyKey], 10)).toHaveLength(MONTHS[10].length);
  });
  test('not a list, or a bad month = []', () => {
    for (const bad of [undefined, null, 'scale', 5, {}]) expect(normalizeWatchItems(bad, 10)).toEqual([]);
    expect(normalizeWatchItems([{ key: 'scale', state: 'seen' }], 13)).toEqual([]);
    expect(normalizeWatchItems([{ key: 'scale', state: 'seen' }], null)).toEqual([]);
  });
});

describe('freezeWatchItems', () => {
  const review = { watchItems: [{ key: 'scale', state: 'seen', extent: 'one_plant', source: 'read' }] };

  test('gate off: nothing is stored and the body field is ignored', () => {
    delete process.env.GATE_TS_WATCH_LIST;
    expect(freezeWatchItems(review, { month: 10, now: NOW })).toBeNull();
    process.env.GATE_TS_WATCH_LIST = 'false';
    expect(freezeWatchItems(review, { month: 10, now: NOW })).toBeNull();
  });
  test('gate on: the structured_notes fields', () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    expect(freezeWatchItems(review, { month: 10, now: NOW })).toEqual({
      treeShrubWatchItems: [{ key: 'scale', label: 'Scale', state: 'seen', extent: 'one_plant', source: 'read' }],
      treeShrubWatchItemsDecidedAt: NOW.toISOString(),
    });
  });
  test('gate on: nothing valid, no review or no month = null, never a throw', () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    expect(freezeWatchItems(undefined, { month: 10 })).toBeNull();
    expect(freezeWatchItems({}, { month: 10 })).toBeNull();
    expect(freezeWatchItems({ watchItems: [{ key: 'nope', state: 'seen' }] }, { month: 10 })).toBeNull();
    expect(freezeWatchItems(review, {})).toBeNull();
    expect(freezeWatchItems('garbage', { month: 10 })).toBeNull();
  });
  test('it rides a review that was never signed (no scores, no signature)', () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    expect(freezeWatchItems({ watchItems: review.watchItems }, { month: 10, now: NOW }).treeShrubWatchItems).toHaveLength(1);
  });
});

describe('visitWatchMonth reads the America/New_York month', () => {
  test('date-only strings and midnight-UTC dates are the calendar day', () => {
    expect(visitWatchMonth('2026-10-04')).toBe(10);
    expect(visitWatchMonth('2026-10-01T00:00:00.000Z')).toBe(10);
    expect(visitWatchMonth(new Date('2026-10-01T00:00:00.000Z'))).toBe(10);
  });
  test('an instant just after midnight UTC on the 1st is still the last day of the month in New York', () => {
    expect(visitWatchMonth(new Date('2026-10-01T02:00:00.000Z'))).toBe(9);
  });
  test('no date or an unreadable one is null', () => {
    for (const bad of [null, undefined, '', 'not a date']) expect(visitWatchMonth(bad)).toBeNull();
  });
});

describe('completion wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  test('the freeze is computed from the request body alone, outside the signature branch', () => {
    expect(src).toContain('? freezeWatchItems(completionInput.body?.treeShrubReview, {');
    const freezeIdx = src.indexOf('const treeShrubWatchItemsFreeze');
    expect(freezeIdx).toBeGreaterThan(-1);
    expect(freezeIdx).toBeLessThan(src.indexOf('const reviewSigned'));
  });
  test('it is T&S only and uses the backfill date when the closeout is a backfill', () => {
    const start = src.indexOf('const treeShrubWatchItemsFreeze');
    const block = src.slice(start, start + 450);
    expect(block).toContain("reportServiceLine === 'tree_shrub' || typedFindingsType === 'tree_shrub'");
    expect(block).toContain('backfillPlan.active ? backfillPlan.serviceDate : svc.scheduled_date');
  });
  test('one chokepoint: spread into the structuredNotes object the insert writes, beside the tech findings', () => {
    const notesStart = src.indexOf('const structuredNotes = {');
    const spread = src.indexOf('...(treeShrubWatchItemsFreeze || {}),');
    expect(spread).toBeGreaterThan(notesStart);
    expect(spread).toBeGreaterThan(src.indexOf('...(treeShrubTechFindingsFreeze || {}),'));
    expect(src.indexOf('structured_notes: serializeJsonb(structuredNotes)')).toBeGreaterThan(spread);
  });
  test('nothing customer-facing reads the frozen items', () => {
    const readers = ['services/service-report', 'routes/reports-public.js', 'services/context-aggregator.js', 'routes/admin-schedule.js']
      .flatMap((rel) => {
        const full = path.join(__dirname, '..', rel);
        return fs.statSync(full).isDirectory()
          ? fs.readdirSync(full).filter((f) => f.endsWith('.js')).map((f) => path.join(full, f))
          : [full];
      });
    for (const file of readers) expect(fs.readFileSync(file, 'utf8')).not.toContain('treeShrubWatchItems');
  });
});
