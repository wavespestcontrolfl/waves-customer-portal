// GATE_NIGHT_TOLD_LOCK: auto-dispatch/told-visits.js turns the no-show detector's promise reader into a set of
// visits the customer was told a time for. TOLD = the latest promise has a known slot (start_at != null).
// reminder_72h_sent is never read; an unknown-window promise is not told; a read failure throws (callers fail
// closed). The detector's own loadPromiseEvents / latestPromises are used for real except the db reads. Synthetic ids.
jest.mock('../services/no-show-detector', () => {
  const actual = jest.requireActual('../services/no-show-detector');
  return { ...actual, loadPromiseEvents: jest.fn() };
});

const detector = require('../services/no-show-detector');
const { loadToldVisitIds } = require('../services/auto-dispatch/told-visits');

const NOW = new Date('2026-11-10T09:00:00Z');

/** A knex-shaped fake over scheduled_services rows: whereIn(col, values).select(...) resolves to the matching rows. */
function fakeConn(rows = []) {
  return jest.fn(() => {
    const filters = [];
    const builder = {
      whereIn: (col, values) => { filters.push([col, values.map(String)]); return builder; },
      select: async () => rows.filter((r) => filters.every(([col, values]) => r[col] != null && values.includes(String(r[col])))),
    };
    return builder;
  });
}
const ev = (visit, over = {}) => ({ visit_id: visit, start_at: '2026-11-12T14:00:00.000Z', communicated_at: '2026-11-09T14:00:00Z', source: 'message', source_id: 1, ...over });

beforeEach(() => { detector.loadPromiseEvents.mockReset(); });

test('a visit whose latest promise has a known slot is told; others are not', async () => {
  detector.loadPromiseEvents.mockResolvedValue([ev('s1'), ev('s2', { start_at: null })]);
  const conn = fakeConn([{ id: 's1', visit_id: null, status: 'pending' }, { id: 's2', visit_id: null, status: 'pending' }]);
  const told = await loadToldVisitIds(conn, ['s1', 's2', 's3'], NOW);
  expect([...told]).toEqual(['s1']);
  expect(detector.loadPromiseEvents).toHaveBeenCalledTimes(1);
  expect(detector.loadPromiseEvents).toHaveBeenCalledWith(conn, ['s1', 's2', 's3'], { now: NOW });
});

test('a newer unknown-window notice outranks an older known slot (the latest promise decides)', async () => {
  detector.loadPromiseEvents.mockResolvedValue([ev('s1'), ev('s1', { start_at: null, communicated_at: '2026-11-10T08:00:00Z', source_id: 2 })]);
  expect([...await loadToldVisitIds(fakeConn(), ['s1'], NOW)]).toEqual([]);
});

test('a promise from the future is ignored', async () => {
  detector.loadPromiseEvents.mockResolvedValue([ev('s1', { communicated_at: '2026-11-11T08:00:00Z' })]);
  expect([...await loadToldVisitIds(fakeConn(), ['s1'], NOW)]).toEqual([]);
});

test('no ids: nothing is read', async () => {
  expect((await loadToldVisitIds(fakeConn(), [], NOW)).size).toBe(0);
  expect(detector.loadPromiseEvents).not.toHaveBeenCalled();
});

test('a failed read throws, so callers fail closed', async () => {
  detector.loadPromiseEvents.mockRejectedValue(new Error('db down'));
  await expect(loadToldVisitIds(fakeConn(), ['s1'], NOW)).rejects.toThrow('db down');
});

test('the module never reads reminder_72h_sent', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/auto-dispatch/told-visits.js'), 'utf8');
  expect(src.replace(/\/\*[\s\S]*?\*\//, '')).not.toMatch(/reminder_72h_sent|windows_preclosed/);
});

// Pre-push P1: a grouped reminder's window sits on whichever stop member won the send claim. When that member is
// later cancelled, its live sibling has no promise of its own and must still read as told (stop-wide resolution).
test('a cancelled reminder owner: its grouped window still makes the live sibling told', async () => {
  const conn = fakeConn([
    { id: 'live', visit_id: 'v1', status: 'pending' },
    { id: 'owner', visit_id: 'v1', status: 'cancelled' },
  ]);
  detector.loadPromiseEvents.mockResolvedValue([ev('owner', { grouped: true })]);
  const told = await loadToldVisitIds(conn, ['live'], NOW);
  expect([...told]).toEqual(['live']);
  expect(detector.loadPromiseEvents).toHaveBeenCalledWith(conn, ['live', 'owner'], { now: NOW });
});

test('a stop whose only promise is a cancelled member\'s own (not grouped) leaves the live sibling untold', async () => {
  const conn = fakeConn([
    { id: 'live', visit_id: 'v1', status: 'pending' },
    { id: 'gone', visit_id: 'v1', status: 'cancelled' },
  ]);
  detector.loadPromiseEvents.mockResolvedValue([ev('gone')]);
  expect([...await loadToldVisitIds(conn, ['live'], NOW)]).toEqual([]);
});

test('a lone visit (no stop siblings) keeps its own latest promise', async () => {
  const conn = fakeConn([{ id: 'solo', visit_id: 'v2', status: 'pending' }]);
  detector.loadPromiseEvents.mockResolvedValue([ev('solo')]);
  expect([...await loadToldVisitIds(conn, ['solo'], NOW)]).toEqual(['solo']);
});
