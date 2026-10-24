// get_lawn_health under score scale 2 (GATE_LAWN_SCORE_SCALE_V2, owner 2026-10-24): the first visit
// and the improvement the assistant reads compare within the latest visit's score scale, so an
// old-scale first visit never turns a new-scale latest one into a fictitious change. Synthetic ids.
jest.mock('../models/db', () => jest.fn(() => {
  const q = {};
  ['where', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.then = (resolve, reject) => Promise.resolve(global.__lawnRows).then(resolve, reject);
  return q;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { executeToolCall } = require('../services/ai-assistant/tools-expanded');

const visit = (date, value, scale) => ({
  service_date: date, turf_density: value, weed_suppression: value, fungus_control: value, color_health: value, thatch_level: value,
  observations: '', ...(scale ? { score_scale: scale } : {}),
});
const lawnHealth = (rows) => { global.__lawnRows = rows; return executeToolCall('get_lawn_health', {}, 'cust-1'); };

test('the first visit and the improvement stay on the latest visit\'s score scale', async () => {
  const old = [visit('2026-06-01', 60), visit('2026-08-01', 70)];
  expect(await lawnHealth(old)).toMatchObject({ initial: { date: '2026-06-01' }, improvement: 10, total_assessments: 2 });
  const firstNew = await lawnHealth([...old, visit('2026-11-01', 90, 2)]);
  expect(firstNew).toMatchObject({ initial: { date: '2026-11-01' }, latest: { date: '2026-11-01' }, improvement: 0, total_assessments: 3 });
  expect(await lawnHealth([...old, visit('2026-11-01', 90, 2), visit('2026-12-01', 95, 2)]))
    .toMatchObject({ initial: { date: '2026-11-01' }, improvement: 5 });
});
