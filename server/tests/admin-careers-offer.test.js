/**
 * admin-careers.js — the job-offer endpoints (GATE_JOB_OFFERS): the dark 404 { enabled: false } before any service
 * call, id format gates, owner-only send / withdraw / revise (403 OWNER_ONLY with a code), every service refusal
 * answered as { error, code, ...detail }, and the Send body carrying the preview hash. The service is mocked; its
 * rules are tested in job-offers.test.js and job-offers-postgres.test.js.
 */

jest.mock('../models/db', () => jest.fn(() => { throw new Error('the offer routes must not touch the database here'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockRole = 'admin';
let mockEmail = 'contact@wavespestcontrol.com';
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'bbbbbbbb-0000-4000-8000-000000000001';
    req.techRole = mockRole;
    req.technician = { id: req.technicianId, name: 'Test Owner', email: mockEmail, role: mockRole };
    next();
  },
}));

const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));

const mockService = {
  adminPanel: jest.fn(async () => ({ enabled: true, current: null, draft: null, history: [] })),
  saveDraft: jest.fn(async () => ({ id: 'o1', status: 'draft' })),
  sendOffer: jest.fn(async () => ({ offer: { id: 'o1', status: 'sent' }, comms: { sms: { outcome: 'sent', code: null }, email: { outcome: 'sent', code: null } } })),
  withdrawOffer: jest.fn(async () => ({ id: 'o1', status: 'withdrawn' })),
  reviseOffer: jest.fn(async () => ({ id: 'o2', status: 'draft' })),
  signedCopy: jest.fn(async () => ({ markdown: 'm', signedName: 'Jordan Rivera', signedAt: 't', signedIp: null, signatureHash: 'h' })),
};
jest.mock('../services/job-offers', () => {
  const actual = jest.requireActual('../services/job-offers');
  return {
    OfferError: actual.OfferError,
    adminPanel: (...a) => mockService.adminPanel(...a),
    saveDraft: (...a) => mockService.saveDraft(...a),
    sendOffer: (...a) => mockService.sendOffer(...a),
    withdrawOffer: (...a) => mockService.withdrawOffer(...a),
    reviseOffer: (...a) => mockService.reviseOffer(...a),
    signedCopy: (...a) => mockService.signedCopy(...a),
  };
});

const express = require('express');
const { OfferError } = jest.requireActual('../services/job-offers');
const adminCareersRouter = require('../routes/admin-careers');

const APP = 'aaaaaaaa-0000-4000-8000-000000000001';
const OFFER = 'cccccccc-0000-4000-8000-000000000001';
const base = (path = '') => `${baseUrl}/api/admin/careers/${APP}/offer${path}`;

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/careers', adminCareersRouter);
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockRole = 'admin';
  mockEmail = 'contact@wavespestcontrol.com';
});

async function call(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}

describe('the dark gate', () => {
  test.each([
    ['GET', ''], ['POST', ''], ['POST', `/${OFFER}/send`], ['POST', `/${OFFER}/withdraw`], ['POST', `/${OFFER}/revise`], ['GET', `/${OFFER}/signed-copy`],
  ])('%s %s answers 404 { enabled: false } and never reaches the service', async (method, path) => {
    mockIsEnabled.mockImplementation((gate) => gate !== 'jobOffers');
    const res = await call(base(path), method, method === 'POST' ? {} : undefined);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ enabled: false }); // exactly this: the page treats any other 404 as an error
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });

  test('is read per request, and only the jobOffers gate decides', async () => {
    await call(base());
    expect(mockIsEnabled).toHaveBeenCalledWith('jobOffers');
    expect(mockService.adminPanel).toHaveBeenCalledTimes(1);
  });
});

describe('id format', () => {
  test('a bad application id or offer id is a 404 with a code', async () => {
    expect(await call(`${baseUrl}/api/admin/careers/nope/offer`)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(await call(base('/nope/send'), 'POST', { draftHash: 'x' })).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(mockService.adminPanel).not.toHaveBeenCalled();
    expect(mockService.sendOffer).not.toHaveBeenCalled();
  });
});

describe('reads and the draft save (any admin)', () => {
  test('GET serves the panel for the signed-in staff member', async () => {
    mockRole = 'admin';
    mockEmail = 'someone.else@example.test';
    const res = await call(base());
    expect(res).toEqual({ status: 200, body: { enabled: true, current: null, draft: null, history: [], viewer: { ownerActions: false } } });
    expect(mockService.adminPanel).toHaveBeenCalledWith(APP, { id: 'bbbbbbbb-0000-4000-8000-000000000001', name: 'Test Owner', ownerAccount: false });
  });

  test('viewer.ownerActions is true only for the owner account', async () => {
    mockEmail = 'contact@wavespestcontrol.com';
    await call(base());
    expect(mockService.adminPanel).toHaveBeenLastCalledWith(APP, expect.objectContaining({ ownerAccount: true })); // the offer link is served to the owner account only
    expect((await call(base())).body.viewer).toEqual({ ownerActions: true });
    mockEmail = 'someone.else@example.test';
    expect((await call(base())).body.viewer).toEqual({ ownerActions: false });
  });

  test('POST saves the draft from the body and answers { offer }', async () => {
    mockEmail = 'someone.else@example.test';
    const res = await call(base(), 'POST', { startDate: '2027-01-04', hourlyRate: 24 });
    expect(res).toEqual({ status: 200, body: { offer: { id: 'o1', status: 'draft' } } });
    expect(mockService.saveDraft).toHaveBeenCalledWith(APP, { startDate: '2027-01-04', hourlyRate: 24 }, expect.objectContaining({ name: 'Test Owner' }));
  });

  test('the signed copy is open to any admin', async () => {
    mockEmail = 'someone.else@example.test';
    const res = await call(base(`/${OFFER}/signed-copy`));
    expect(res.status).toBe(200);
    expect(res.body.signedName).toBe('Jordan Rivera');
  });

  test('a technician login never reaches an offer endpoint', async () => {
    mockRole = 'technician';
    const res = await call(base());
    expect(res.status).toBe(403);
    expect(mockService.adminPanel).not.toHaveBeenCalled();
  });
});

describe('owner-only actions', () => {
  test.each(['send', 'withdraw', 'revise'])('%s is refused with 403 OWNER_ONLY for another admin and runs for the owner account', async (action) => {
    mockEmail = 'someone.else@example.test';
    const refused = await call(base(`/${OFFER}/${action}`), 'POST', { draftHash: 'h' });
    expect(refused).toMatchObject({ status: 403, body: { code: 'OWNER_ONLY', error: 'This action is limited to the owner account.' } });
    for (const fn of [mockService.sendOffer, mockService.withdrawOffer, mockService.reviseOffer]) expect(fn).not.toHaveBeenCalled();

    mockEmail = 'contact@wavespestcontrol.com';
    const ok = await call(base(`/${OFFER}/${action}`), 'POST', { draftHash: 'h' });
    expect(ok.status).toBe(200);
  });

  test('send passes the preview hash and the read\'s out stamp from the body', async () => {
    const res = await call(base(`/${OFFER}/send`), 'POST', { draftHash: 'abc123', expectedOut: 'stamp-1' });
    expect(res.body.comms.sms.outcome).toBe('sent');
    expect(mockService.sendOffer).toHaveBeenCalledWith(
      APP, OFFER, expect.objectContaining({ name: 'Test Owner' }), 'abc123', expect.any(Date), { expectedOut: 'stamp-1' },
    );
  });

  test('revise passes the expected status and the optional start date', async () => {
    await call(base(`/${OFFER}/revise`), 'POST', { expectedStatus: 'sent', startDate: '2027-02-01' });
    expect(mockService.reviseOffer).toHaveBeenCalledWith(APP, OFFER, { expectedStatus: 'sent', startDate: '2027-02-01' }, expect.any(Object));
  });

  test('withdraw passes the expected status and the draft hash', async () => {
    await call(base(`/${OFFER}/withdraw`), 'POST', { expectedStatus: 'draft', draftHash: 'abc' });
    expect(mockService.withdrawOffer).toHaveBeenCalledWith(APP, OFFER, expect.objectContaining({ name: 'Test Owner' }), { expectedStatus: 'draft', draftHash: 'abc' });
  });
});

describe('service refusals', () => {
  test.each([
    [new OfferError(409, 'TERMS_NOT_ISSUED', 'The Technician Terms are not issued.', { blockers: ['The Technician Terms have no issued version.'] }), 409],
    [new OfferError(409, 'DRAFT_CHANGED', 'This draft changed after you opened it. Review the new preview, then send.'), 409],
    [new OfferError(400, 'DRAFT_HASH_REQUIRED', 'Send needs the hash of the preview you reviewed.'), 400],
    [new OfferError(400, 'EXPECTED_STATUS_REQUIRED', 'Say which state of the offer you are acting on.'), 400],
    [new OfferError(409, 'OFFER_CHANGED', 'This offer changed after you opened it. Review it again.', { status: 'sent' }), 409],
    [new OfferError(400, 'INVALID_OFFER', 'The start date must be in the future.', { errors: [{ field: 'startDate', message: 'x' }] }), 400],
    [new OfferError(404, 'NOT_FOUND', 'Not found'), 404],
  ])('%s keeps its status, a one-sentence error and a code', async (err, status) => {
    mockService.sendOffer.mockRejectedValueOnce(err);
    const res = await call(base(`/${OFFER}/send`), 'POST', { draftHash: 'h' });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: err.message, code: err.code, ...err.extra });
  });

  test('an unexpected failure is a 500 that leaks nothing', async () => {
    mockService.adminPanel.mockRejectedValueOnce(new Error('select * from secrets'));
    const res = await call(base());
    expect(res).toEqual({ status: 500, body: { error: 'Failed to update the offer' } });
  });
});
