// Team tab API — per-tech Twilio line (Field Team Program, Phase 0 item 3).
// Mirrors the mock style of admin-timetracking-employment-status.test.js.
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
const router = require('../routes/admin-timetracking');
const { createTechnician, updateTechnician } = router._handlers;

const LINE = '+19413529161';
const TECH = {
  id: 'tech-1', name: 'Jordan Reyes', email: 'jordan@wavespestcontrol.com', role: 'technician',
  active: true, employment_status: 'active', field_dispatchable: true, auth_token_version: 3, twilio_number: null,
};

function makeChain({ rows = [], first, returning = [] } = {}) {
  const chain = {};
  for (const m of ['insert', 'orderBy', 'orderByRaw', 'select', 'update', 'where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereRaw', 'forUpdate', 'leftJoin']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.first = jest.fn(async () => first);
  chain.returning = jest.fn(async () => returning);
  chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  chain.onConflict = jest.fn(() => chain);
  chain.ignore = jest.fn(async () => undefined);
  return chain;
}
function response() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function invoke(handler, req) {
  const res = response();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
}
function installTransaction(techChains) {
  const queue = [...techChains];
  const trx = jest.fn((table) => {
    if (table === 'technician_capabilities') return makeChain();
    if (['time_entries', 'scheduled_services', 'service_records', 'review_incentive_payouts'].includes(table)) return makeChain({ first: undefined });
    if (table !== 'technicians') throw new Error(`Unexpected transaction table: ${table}`);
    const chain = queue.shift();
    if (!chain) throw new Error('Unexpected technicians query');
    return chain;
  });
  trx.raw = jest.fn(async () => undefined);
  trx.fn = { now: jest.fn(() => 'NOW') };
  db.transaction = jest.fn(async (cb) => cb(trx));
  return trx;
}

beforeEach(() => jest.clearAllMocks());

describe('updateTechnician — twilioNumber', () => {
  test('assigns a registry line: holder check under the table lock, then the write', async () => {
    const target = makeChain({ first: TECH });
    const holder = makeChain({ first: undefined });
    const write = makeChain();
    const reread = makeChain({ first: { ...TECH, twilio_number: LINE } });
    installTransaction([target, holder, write, reread]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { twilioNumber: LINE }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(holder.where).toHaveBeenCalledWith({ twilio_number: LINE });
    expect(holder.whereNot).toHaveBeenCalledWith({ id: 'tech-1' });
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ twilio_number: LINE }));
    expect(res.body.technician.twilio_number).toBe(LINE);
  });

  test("'' clears the line; an omitted field leaves it alone", async () => {
    // Clearing needs no holder check — no second technicians read.
    const write = makeChain();
    installTransaction([makeChain({ first: { ...TECH, twilio_number: LINE } }), write, makeChain({ first: TECH })]);
    expect((await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { twilioNumber: '' }, technicianId: 'adam' })).statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ twilio_number: null }));

    jest.clearAllMocks();
    const write2 = makeChain();
    installTransaction([makeChain({ first: TECH }), write2, makeChain({ first: TECH })]);
    expect((await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { name: 'Jordan Reyes' }, technicianId: 'adam' })).statusCode).toBe(200);
    expect(write2.update.mock.calls[0][0]).not.toHaveProperty('twilio_number');
  });

  test('a line another technician holds → 409 TECH_LINE_TAKEN, nothing written', async () => {
    const write = makeChain();
    installTransaction([makeChain({ first: TECH }), makeChain({ first: { id: 'tech-2' } }), write]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { twilioNumber: LINE }, technicianId: 'adam' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TECH_LINE_TAKEN');
    expect(write.update).not.toHaveBeenCalled();
  });

  test('a number outside the registry is a 400 before any transaction', async () => {
    for (const twilioNumber of ['+19415550199', '+19413187612', 42]) {
      const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { twilioNumber }, technicianId: 'adam' });
      expect(res.statusCode).toBe(400);
    }
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the DB fence (partial unique index) maps to the same 409, not "Email already in use"', async () => {
    const target = makeChain({ first: TECH });
    const holder = makeChain({ first: undefined });
    const write = makeChain();
    write.update = jest.fn(async () => { throw Object.assign(new Error('dup'), { code: '23505', constraint: 'technicians_twilio_number_unique' }); });
    installTransaction([target, holder, write]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { twilioNumber: LINE }, technicianId: 'adam' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TECH_LINE_TAKEN');
  });
});

describe('createTechnician — twilioNumber', () => {
  test('a new row can start with a line; a held line is refused', async () => {
    const insert = makeChain({ returning: [{ ...TECH, id: 'new', twilio_number: LINE }] });
    installTransaction([makeChain({ first: undefined }), makeChain({ first: undefined }), insert]);
    const res = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@wavespestcontrol.com', twilioNumber: LINE } });
    expect(res.statusCode).toBe(200);
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({ twilio_number: LINE }));

    jest.clearAllMocks();
    const insert2 = makeChain();
    installTransaction([makeChain({ first: undefined }), makeChain({ first: { id: 'tech-2' } }), insert2]);
    const res2 = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@wavespestcontrol.com', twilioNumber: LINE } });
    expect(res2.statusCode).toBe(409);
    expect(res2.body.code).toBe('TECH_LINE_TAKEN');
    expect(insert2.insert).not.toHaveBeenCalled();
  });
});
