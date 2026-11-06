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
const ev = (visit, over = {}) => ({ visit_id: visit, start_at: '2026-11-12T14:00:00.000Z', communicated_at: '2026-11-09T14:00:00Z', source: 'message', source_id: 1, ...over });

beforeEach(() => { detector.loadPromiseEvents.mockReset(); });

test('a visit whose latest promise has a known slot is told; others are not', async () => {
  detector.loadPromiseEvents.mockResolvedValue([ev('s1'), ev('s2', { start_at: null })]);
  const conn = jest.fn();
  const told = await loadToldVisitIds(conn, ['s1', 's2', 's3'], NOW);
  expect([...told]).toEqual(['s1']);
  expect(detector.loadPromiseEvents).toHaveBeenCalledTimes(1);
  expect(detector.loadPromiseEvents).toHaveBeenCalledWith(conn, ['s1', 's2', 's3'], { now: NOW });
});

test('a newer unknown-window notice outranks an older known slot (the latest promise decides)', async () => {
  detector.loadPromiseEvents.mockResolvedValue([ev('s1'), ev('s1', { start_at: null, communicated_at: '2026-11-10T08:00:00Z', source_id: 2 })]);
  expect([...await loadToldVisitIds(jest.fn(), ['s1'], NOW)]).toEqual([]);
});

test('a promise from the future is ignored', async () => {
  detector.loadPromiseEvents.mockResolvedValue([ev('s1', { communicated_at: '2026-11-11T08:00:00Z' })]);
  expect([...await loadToldVisitIds(jest.fn(), ['s1'], NOW)]).toEqual([]);
});

test('no ids: nothing is read', async () => {
  expect((await loadToldVisitIds(jest.fn(), [], NOW)).size).toBe(0);
  expect(detector.loadPromiseEvents).not.toHaveBeenCalled();
});

test('a failed read throws, so callers fail closed', async () => {
  detector.loadPromiseEvents.mockRejectedValue(new Error('db down'));
  await expect(loadToldVisitIds(jest.fn(), ['s1'], NOW)).rejects.toThrow('db down');
});

test('the module never reads reminder_72h_sent', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/auto-dispatch/told-visits.js'), 'utf8');
  expect(src.replace(/\/\*[\s\S]*?\*\//, '')).not.toMatch(/reminder_72h_sent|windows_preclosed/);
});
