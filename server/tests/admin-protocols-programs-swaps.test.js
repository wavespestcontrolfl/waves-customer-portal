// GET /api/admin/protocols/programs?track=...: the Protocol Reference reads the lawn track from here. The v13 December visit's `swaps`
// block (GATE_LAWN_DEC_LARGE_PATCH_K) is in the payload only while its gate is live; with the gate off the payload is the old one, and a
// technician's payload keeps the block (a recipe line, not a cost). Real handler; no database.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('../routes/admin-protocols');
const v13 = require('../config/lawn-protocol-v13.json');

const handler = router.stack.find((layer) => layer.route?.path === '/programs' && layer.route.methods.get).route.stack[0].handle;
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_DEC_LARGE_PATCH_K'];
const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

async function track(key, techRole) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { track: key }, techRole }, res, next);
  expect(next).not.toHaveBeenCalled();
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}
const december = (body) => body.track.visits.find((visit) => visit.month === 'Dec');

test.each(['st_augustine', 'bermuda', 'zoysia'])('%s: all gates on, December carries the swaps block (admin and technician); no other visit does', async (key) => {
  for (const name of GATES) process.env[name] = 'true';
  for (const role of ['admin', 'technician']) {
    const body = await track(key, role);
    expect(december(body).swaps.largePatchPotassium.primary).toBe(v13[key].visits[11].swaps.largePatchPotassium.primary);
    expect(body.track.visits.filter((visit) => visit.swaps).map((visit) => visit.month)).toEqual(['Dec']);
  }
});

test.each(GATES.slice(1))('%s off: the December visit is the old one, with no swaps key anywhere in the payload', async (off) => {
  for (const name of GATES) process.env[name] = 'true';
  delete process.env[off];
  const body = await track('st_augustine', 'admin');
  expect(JSON.stringify(body)).not.toContain('"swaps":');
  expect(JSON.stringify(body)).not.toContain('Black Out');
  const { swaps, ...old } = v13.st_augustine.visits[11];
  expect(december(body)).toMatchObject({ primary: old.primary, secondary: old.secondary, notes: old.notes });
});
