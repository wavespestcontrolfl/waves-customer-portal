// Team tab API — per-technician supply store (the supplier branch the Monday buy list names).
// Mirrors the mock style of admin-timetracking-start-point.test.js. The route is requireAdmin like every Team write.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const router = require('../routes/admin-timetracking');
const { updateTechnician } = router._handlers;

const TECH = {
  id: 'tech-1', name: 'Jordan Reyes', email: 'jordan@wavespestcontrol.com', role: 'technician',
  active: true, employment_status: 'active', field_dispatchable: true, auth_token_version: 3, twilio_number: null,
};

function makeChain({ first } = {}) {
  const chain = {};
  for (const m of ['where', 'whereNot', 'forUpdate', 'update']) chain[m] = jest.fn(() => chain);
  chain.first = jest.fn(async () => first);
  chain.then = (res, rej) => Promise.resolve([]).then(res, rej);
  return chain;
}
function response() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function invoke(body) {
  const res = response();
  const next = jest.fn();
  await updateTechnician({ params: { id: 'tech-1' }, body, technicianId: 'adam' }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
}
function installTransaction(chains) {
  const queue = [...chains];
  const trx = jest.fn((table) => {
    if (table !== 'technicians') throw new Error(`Unexpected transaction table: ${table}`);
    const chain = queue.shift();
    if (!chain) throw new Error('Unexpected technicians query');
    return chain;
  });
  trx.raw = jest.fn(async () => undefined);
  db.transaction = jest.fn(async (cb) => cb(trx));
}

beforeEach(() => jest.clearAllMocks());

describe('updateTechnician — supplyStore', () => {
  test('trimmed text is written and returned on the technician', async () => {
    const write = makeChain();
    installTransaction([makeChain({ first: TECH }), write, makeChain({ first: { ...TECH, supply_store: 'Synthetic Supply North' } })]);
    const res = await invoke({ supplyStore: '  Synthetic Supply North ' });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ supply_store: 'Synthetic Supply North' }));
    expect(res.body.technician.supply_store).toBe('Synthetic Supply North');
  });

  test('null and blank text clear it', async () => {
    for (const supplyStore of [null, '   ']) {
      const write = makeChain();
      installTransaction([makeChain({ first: { ...TECH, supply_store: 'Old' } }), write, makeChain({ first: TECH })]);
      await invoke({ supplyStore });
      expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ supply_store: null }));
    }
  });

  test('an omitted supplyStore leaves the column alone', async () => {
    const write = makeChain();
    installTransaction([makeChain({ first: TECH }), write, makeChain({ first: TECH })]);
    await invoke({ name: 'Jordan Reyes' });
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('supply_store');
  });

  test.each([['a number', 12], ['an object', { name: 'x' }], ['an array', ['x']], ['text over 120 characters', 'x'.repeat(121)]])('%s is a 400 before any transaction', async (_label, supplyStore) => {
    const res = await invoke({ supplyStore });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/supplyStore/);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
