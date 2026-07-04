// verifyStaffBearer — the non-middleware staff check behind the estimate
// draft preview (?adminPreview=1 on GET /api/estimates/:token/data). It must
// run the SAME checks as adminAuthenticate + requireTechOrAdmin and return
// null (never throw, never respond) on any failure: the caller's public
// behavior must be unchanged for everyone who isn't verified staff.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));

const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { verifyStaffBearer } = require('../middleware/admin-auth');

const SECRET = 'test-secret';
const sign = (payload) => jwt.sign(payload, SECRET);
const reqWith = (authorization) => ({ headers: authorization ? { authorization } : {} });

function mockTechLookup(tech) {
  db.mockImplementation(() => ({
    where: jest.fn(() => ({ first: jest.fn(async () => tech) })),
  }));
}

beforeEach(() => db.mockReset());

describe('verifyStaffBearer', () => {
  it('returns the technician row for an active admin', async () => {
    const tech = { id: 7, active: true, role: 'admin' };
    mockTechLookup(tech);
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7 })}`))).resolves.toBe(tech);
  });

  it('returns the technician row for an active technician (matches requireTechOrAdmin)', async () => {
    const tech = { id: 9, active: true, role: 'technician' };
    mockTechLookup(tech);
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 9 })}`))).resolves.toBe(tech);
  });

  it('rejects a missing or non-Bearer Authorization header without touching the db', async () => {
    await expect(verifyStaffBearer(reqWith(null))).resolves.toBeNull();
    await expect(verifyStaffBearer(reqWith('Basic abc'))).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const bad = jwt.sign({ technicianId: 7 }, 'other-secret');
    await expect(verifyStaffBearer(reqWith(`Bearer ${bad}`))).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects a token without technicianId and a terminal-scoped token', async () => {
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ userId: 1 })}`))).resolves.toBeNull();
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, scope: 'terminal' })}`))).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects a missing or inactive technician row', async () => {
    mockTechLookup(undefined);
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7 })}`))).resolves.toBeNull();
    mockTechLookup({ id: 7, active: false, role: 'admin' });
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7 })}`))).resolves.toBeNull();
  });

  it('rejects non-staff roles', async () => {
    mockTechLookup({ id: 7, active: true, role: 'viewer' });
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7 })}`))).resolves.toBeNull();
  });

  it('never throws on a malformed request object', async () => {
    await expect(verifyStaffBearer({ headers: {} })).resolves.toBeNull();
  });
});
