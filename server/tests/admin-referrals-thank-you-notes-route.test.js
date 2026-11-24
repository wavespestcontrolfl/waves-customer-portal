/**
 * Admin routes of the thank-you note list (Referral Step 2): GET /thank-you-notes and
 * POST /thank-you-notes/:referralId/written, over the real router with the service mocked. The rule itself (which
 * referral owes a note) is proven on real Postgres in referral-thank-you-notes-postgres.test.js. Here: admins
 * only, a bad id never reaches the service, the staff login is passed, and "no note owed" answers 404.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/referral-thank-you-notes', () => ({
  listThankYouNotes: jest.fn(),
  markThankYouNoteWritten: jest.fn(),
}));
let mockStaff;
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.techRole = mockStaff.role;
      req.technicianId = mockStaff.id;
      return next();
    },
  };
});

const express = require('express');
const notes = require('../services/referral-thank-you-notes');
const router = require('../routes/admin-referrals-v2');

const STAFF = '00000000-0000-4000-8000-0000000000a1';
const REFERRAL = '00000000-0000-4000-8000-0000000000b2';
const CURSOR = '2027-02-03T15:00:00.000000Z,00000000-0000-4000-8000-0000000000b2';
const NOTE = {
  referralId: REFERRAL, owedSince: '2027-02-03T15:00:00.000Z', memberCustomerId: '00000000-0000-4000-8000-0000000000c3',
  memberName: 'Fixture Member', addressLines: ['12 Sample Way', 'Parrish, FL 34219'], addressComplete: true,
};

async function request(method, path) {
  const app = express();
  app.use(express.json());
  app.use('/admin/referrals', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/referrals${path}`, {
      method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStaff = { role: 'admin', id: STAFF };
  notes.listThankYouNotes.mockResolvedValue({ notes: [NOTE], total: 1, nextCursor: null });
  notes.markThankYouNoteWritten.mockResolvedValue({ written: true });
});

describe('thank-you note list routes', () => {
  test('GET answers the first page as the service built it: the notes, the total and the next position', async () => {
    notes.listThankYouNotes.mockResolvedValue({ notes: [NOTE], total: 201, nextCursor: CURSOR });
    await expect(request('GET', '/thank-you-notes')).resolves.toEqual({
      status: 200, body: { notes: [NOTE], total: 201, nextCursor: CURSOR },
    });
    expect(notes.listThankYouNotes).toHaveBeenCalledWith({ after: null });
  });

  test('GET ?after= hands the position to the service ("Show more"); an empty one is the first page', async () => {
    expect((await request('GET', `/thank-you-notes?after=${encodeURIComponent(CURSOR)}`)).status).toBe(200);
    expect(notes.listThankYouNotes).toHaveBeenLastCalledWith({ after: CURSOR });

    expect((await request('GET', '/thank-you-notes?after=')).status).toBe(200);
    expect(notes.listThankYouNotes).toHaveBeenLastCalledWith({ after: null });
  });

  test('GET answers the service\'s refusal of a position as its own 400, not a 500', async () => {
    notes.listThankYouNotes.mockRejectedValue(Object.assign(new Error('after is not a position in this list'), { statusCode: 400, code: 'BAD_CURSOR' }));
    await expect(request('GET', '/thank-you-notes?after=nonsense')).resolves.toEqual({
      status: 400, body: { error: 'after is not a position in this list', code: 'BAD_CURSOR' },
    });
  });

  test('POST marks that referral with the staff login', async () => {
    await expect(request('POST', `/thank-you-notes/${REFERRAL}/written`)).resolves.toEqual({ status: 200, body: { success: true, written: true } });
    expect(notes.markThankYouNoteWritten).toHaveBeenCalledWith({ referralId: REFERRAL, writtenBy: STAFF });
  });

  test('a staff id that is not a uuid is stored as no one, never as text in a uuid column', async () => {
    mockStaff = { role: 'admin', id: 'tech-1' };
    await request('POST', `/thank-you-notes/${REFERRAL}/written`);
    expect(notes.markThankYouNoteWritten).toHaveBeenCalledWith({ referralId: REFERRAL, writtenBy: null });
  });

  test('an id that is not a uuid answers 400 and never reaches the service', async () => {
    await expect(request('POST', '/thank-you-notes/not-an-id/written')).resolves.toEqual({ status: 400, body: { error: 'referralId is required' } });
    expect(notes.markThankYouNoteWritten).not.toHaveBeenCalled();
  });

  test('"no note owed" answers 404 with its code', async () => {
    notes.markThankYouNoteWritten.mockRejectedValue(Object.assign(new Error('This referral has no thank-you note to write'), { statusCode: 404, code: 'NO_NOTE_OWED' }));
    await expect(request('POST', `/thank-you-notes/${REFERRAL}/written`)).resolves.toEqual({
      status: 404, body: { error: 'This referral has no thank-you note to write', code: 'NO_NOTE_OWED' },
    });
  });

  test('a technician login reads and writes nothing: 403 on both routes', async () => {
    mockStaff = { role: 'technician', id: STAFF };
    expect((await request('GET', '/thank-you-notes')).status).toBe(403);
    expect((await request('POST', `/thank-you-notes/${REFERRAL}/written`)).status).toBe(403);
    expect(notes.listThankYouNotes).not.toHaveBeenCalled();
    expect(notes.markThankYouNoteWritten).not.toHaveBeenCalled();
  });
});
