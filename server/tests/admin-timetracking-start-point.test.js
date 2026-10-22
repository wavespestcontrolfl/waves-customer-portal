// Team tab API — per-technician start point (where the day starts and ends).
// Mirrors the mock style of admin-timetracking-tech-line.test.js.
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
const ADDRESS = '100 Example Way, Bradenton, FL 34205, USA';

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

describe('updateTechnician — startPoint', () => {
  test('a good payload writes the three columns together and returns numbers', async () => {
    const write = makeChain();
    // pg hands decimals back as strings
    installTransaction([
      makeChain({ first: TECH }), write,
      makeChain({ first: { ...TECH, start_address: ADDRESS, start_lat: '27.4989280', start_lng: '-82.5748190' } }),
    ]);
    const res = await invoke({ startPoint: { address: `  ${ADDRESS} `, lat: 27.498928, lng: -82.574819 } });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      start_address: ADDRESS, start_lat: 27.498928, start_lng: -82.574819,
    }));
    expect(res.body.technician).toMatchObject({ start_address: ADDRESS, start_lat: 27.498928, start_lng: -82.574819 });
  });

  test('null clears all three columns back to the office', async () => {
    const write = makeChain();
    installTransaction([makeChain({ first: { ...TECH, start_address: ADDRESS } }), write, makeChain({ first: TECH })]);
    const res = await invoke({ startPoint: null });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      start_address: null, start_lat: null, start_lng: null,
    }));
  });

  test('an omitted startPoint leaves the columns alone', async () => {
    const write = makeChain();
    installTransaction([makeChain({ first: TECH }), write, makeChain({ first: TECH })]);
    await invoke({ name: 'Jordan Reyes' });
    const written = write.update.mock.calls[0][0];
    for (const c of ['start_address', 'start_lat', 'start_lng']) expect(written).not.toHaveProperty(c);
  });

  test.each([
    ['latitude out of range', { address: ADDRESS, lat: 91, lng: -82.5 }],
    ['longitude out of range', { address: ADDRESS, lat: 27.5, lng: -181 }],
    ['missing lng', { address: ADDRESS, lat: 27.5 }],
    ['missing lat', { address: ADDRESS, lng: -82.5 }],
    ['string coordinates', { address: ADDRESS, lat: '27.5', lng: '-82.5' }],
    ['NaN coordinate', { address: ADDRESS, lat: Number.NaN, lng: -82.5 }],
    ['empty address', { address: '   ', lat: 27.5, lng: -82.5 }],
    ['missing address', { lat: 27.5, lng: -82.5 }],
    ['address over 300 characters', { address: 'x'.repeat(301), lat: 27.5, lng: -82.5 }],
    ['a bare string', 'Home'],
    ['an array', [27.5, -82.5]],
    ['an empty object', {}],
  ])('%s is a 400 before any transaction', async (_label, startPoint) => {
    const res = await invoke({ startPoint });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/startPoint/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the home address is never logged', async () => {
    installTransaction([
      makeChain({ first: TECH }), makeChain(),
      makeChain({ first: { ...TECH, start_address: ADDRESS, start_lat: '27.4989280', start_lng: '-82.5748190' } }),
    ]);
    await invoke({ startPoint: { address: ADDRESS, lat: 27.498928, lng: -82.574819 } });
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain('Example Way');
  });
});
