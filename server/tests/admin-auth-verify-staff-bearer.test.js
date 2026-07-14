// verifyStaffBearer — the non-middleware staff check behind the estimate
// draft preview (?adminPreview=1 on GET /api/estimates/:token/data). It must
// run the SAME checks as adminAuthenticate + requireTechOrAdmin and return
// null (never throw, never respond) on any failure: the caller's public
// behavior must be unchanged for everyone who isn't verified staff.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));

const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { adminAuthenticate, verifyStaffBearer } = require('../middleware/admin-auth');

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
    const tech = { id: 7, active: true, role: 'admin', auth_token_version: 1 };
    mockTechLookup(tech);
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 1 })}`))).resolves.toBe(tech);
  });

  it('returns the technician row for an active technician (matches requireTechOrAdmin)', async () => {
    const tech = { id: 9, active: true, role: 'technician', auth_token_version: 3 };
    mockTechLookup(tech);
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 9, type: 'access', tokenVersion: 3 })}`))).resolves.toBe(tech);
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
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ userId: 1, type: 'access', tokenVersion: 1 })}`))).resolves.toBeNull();
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 1, scope: 'terminal' })}`))).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects a refresh token before touching the database', async () => {
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'refresh' })}`))).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects untyped, unversioned, and Bouncie OAuth state JWTs before touching the database', async () => {
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7 })}`))).resolves.toBeNull();
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access' })}`))).resolves.toBeNull();
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'bouncie_oauth', tokenVersion: 1 })}`))).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects a missing or inactive technician row', async () => {
    mockTechLookup(undefined);
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 1 })}`))).resolves.toBeNull();
    mockTechLookup({ id: 7, active: false, role: 'admin', auth_token_version: 1 });
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 1 })}`))).resolves.toBeNull();
  });

  it('rejects non-staff roles', async () => {
    mockTechLookup({ id: 7, active: true, role: 'viewer', auth_token_version: 1 });
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 1 })}`))).resolves.toBeNull();
  });

  it('rejects revoked and forced-password-change staff sessions', async () => {
    mockTechLookup({ id: 7, active: true, role: 'admin', auth_token_version: 2 });
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 1 })}`))).resolves.toBeNull();

    mockTechLookup({
      id: 7,
      active: true,
      role: 'admin',
      auth_token_version: 2,
      must_change_password: true,
    });
    await expect(verifyStaffBearer(reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 2 })}`))).resolves.toBeNull();
  });

  it('never throws on a malformed request object', async () => {
    await expect(verifyStaffBearer({ headers: {} })).resolves.toBeNull();
  });
});

describe('adminAuthenticate token type', () => {
  it('redacts provider recording URLs from authenticated JSON responses', async () => {
    mockTechLookup({ id: 7, active: true, role: 'admin', auth_token_version: 4 });
    const req = reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 4 })}`);
    const rawJson = jest.fn();
    const res = { json: rawJson };
    const next = jest.fn();

    await adminAuthenticate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.json({
      call: {
        id: 'call-1',
        recording_sid: 'RE123',
        recording_url: 'https://api.twilio.com/recording.mp3',
      },
      lead: {
        twilio_call_sid: 'CA123',
        call_recording_url: 'https://api.twilio.com/lead-recording.mp3',
      },
      interaction: {
        metadata: {
          recordingUrl: 'https://api.twilio.com/interaction-recording.mp3',
          recordingSid: 'RE456',
        },
      },
      media: [
        { type: 'recording', url: 'https://api.twilio.com/media.mp3', sid: 'RE789' },
        { type: 'image', url: 'https://cdn.example.test/photo.jpg' },
      ],
      visualMoment: { mediaUrl: 'https://cdn.example.test/moment.jpg' },
    });

    expect(rawJson).toHaveBeenCalledWith({
      call: {
        id: 'call-1',
        recording_sid: 'RE123',
        recording_available: true,
      },
      lead: {
        twilio_call_sid: 'CA123',
        call_recording_available: true,
      },
      interaction: {
        metadata: {
          recordingAvailable: true,
          recordingSid: 'RE456',
        },
      },
      media: [
        { type: 'recording', sid: 'RE789', available: true },
        { type: 'image', url: 'https://cdn.example.test/photo.jpg' },
      ],
      visualMoment: { mediaUrl: 'https://cdn.example.test/moment.jpg' },
    });
  });

  it('rejects a refresh token before touching the database', async () => {
    const req = reqWith(`Bearer ${sign({ technicianId: 7, type: 'refresh' })}`);
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const next = jest.fn();

    await adminAuthenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid token type' });
    expect(next).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects a stale token version', async () => {
    mockTechLookup({ id: 7, active: true, role: 'admin', auth_token_version: 4 });
    const req = reqWith(`Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 3 })}`);
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const next = jest.fn();

    await adminAuthenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Session has been revoked', code: 'TOKEN_REVOKED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows only /me and /change-password while rotation is required', async () => {
    const tech = {
      id: 7,
      active: true,
      role: 'admin',
      auth_token_version: 2,
      must_change_password: true,
    };
    mockTechLookup(tech);
    const token = `Bearer ${sign({ technicianId: 7, type: 'access', tokenVersion: 2 })}`;
    const json = jest.fn();
    const blockedRes = { status: jest.fn(() => ({ json })) };
    const blockedNext = jest.fn();

    await adminAuthenticate({ ...reqWith(token), baseUrl: '/api/admin/timetracking', path: '/' }, blockedRes, blockedNext);
    expect(blockedRes.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });

    const allowedNext = jest.fn();
    await adminAuthenticate({ ...reqWith(token), baseUrl: '/api/admin/auth', path: '/change-password' }, {}, allowedNext);
    expect(allowedNext).toHaveBeenCalledTimes(1);

    const allowedMeNext = jest.fn();
    await adminAuthenticate({ ...reqWith(token), baseUrl: '/api/admin/auth', path: '/me/' }, {}, allowedMeNext);
    expect(allowedMeNext).toHaveBeenCalledTimes(1);

    const lookalikeJson = jest.fn();
    const lookalikeRes = { status: jest.fn(() => ({ json: lookalikeJson })) };
    const lookalikeNext = jest.fn();
    await adminAuthenticate({
      ...reqWith(token),
      baseUrl: '/api/admin/export',
      path: '/admin/auth/change-password',
    }, lookalikeRes, lookalikeNext);
    expect(lookalikeRes.status).toHaveBeenCalledWith(403);
    expect(lookalikeJson).toHaveBeenCalledWith({
      error: 'Password change required',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    expect(lookalikeNext).not.toHaveBeenCalled();
  });
});
