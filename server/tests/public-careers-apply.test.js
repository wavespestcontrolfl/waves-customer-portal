/**
 * POST /api/public/careers/apply side effects (team/staff audit F6): a
 * resubmission of an application already filed answers success and starts
 * nothing again (no AI screen, no owner bell, no applicant receipt); a new
 * application starts all three as before.
 */

const mockIsEnabled = jest.fn((name) => name === 'recruitingComms');
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));

jest.mock('../utils/turnstile', () => ({ verifyTurnstileToken: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/interview-slots', () => ({ listInterviewSlots: jest.fn(), formatSlotLabel: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ acquireOccupancyLocks: jest.fn() }));

const mockCreateJobApplication = jest.fn();
jest.mock('../services/job-applications', () => ({
  createJobApplication: (...args) => mockCreateJobApplication(...args),
}));

const mockScreenJobApplication = jest.fn(async () => {});
jest.mock('../services/job-application-screen', () => ({
  screenJobApplication: (...args) => mockScreenJobApplication(...args),
}));

const mockTriggerNotification = jest.fn(async () => {});
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));

const mockSendStageComms = jest.fn(async () => ({ sms: 'not_requested', email: 'sent' }));
jest.mock('../services/recruiting-comms', () => ({
  contactOf: (app) => (app && app.contact_snapshot) || {},
  firstNameOf: (name) => String(name || '').split(/\s+/)[0],
  sendStageComms: (...args) => mockSendStageComms(...args),
  receiptStillEligible: jest.fn(async () => true),
  errorSummary: (err) => (err && err.message) || 'error',
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);
jest.mock('../models/db', () => jest.fn(() => { throw new Error('the route must not query directly'); }));

const express = require('express');
const publicCareersRouter = require('../routes/public-careers');

const BODY = {
  name: 'Jane Doe',
  phone: '941-555-0142',
  email: 'jane@example.com',
  role: 'technician',
  answers: { experience: '2 years lawn crew' },
};
const ROW = {
  id: 'app-1',
  role: 'technician',
  status: 'new',
  language: 'en',
  sms_consent: false,
  contact_snapshot: { name: 'Jane Doe', phone: '+19415550142', email: 'jane@example.com' },
};

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/public/careers', publicCareersRouter);
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { jest.clearAllMocks(); });

const apply = () => fetch(`${base}/api/public/careers/apply`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(BODY),
});

test('a resubmission of a filed application answers success and starts no screen, bell or receipt', async () => {
  mockCreateJobApplication.mockResolvedValueOnce({ created: false, row: ROW });
  const res = await apply();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true });
  expect(mockScreenJobApplication).not.toHaveBeenCalled();
  expect(mockTriggerNotification).not.toHaveBeenCalled();
  expect(mockSendStageComms).not.toHaveBeenCalled();
  const logged = mockLogger.info.mock.calls.map(([line]) => line).join('\n');
  expect(logged).toContain('resubmission of application app-1');
  expect(logged).not.toMatch(/Jane|555|example\.com/);
});

test('a new application starts the screen, the bell and the receipt, as before', async () => {
  mockCreateJobApplication.mockResolvedValueOnce({ created: true, row: ROW });
  const res = await apply();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true });
  expect(mockScreenJobApplication).toHaveBeenCalledWith('app-1');
  expect(mockTriggerNotification).toHaveBeenCalledWith('new_job_application', { applicationId: 'app-1', role: 'technician' });
  expect(mockSendStageComms).toHaveBeenCalledWith(ROW, 'application_received', expect.objectContaining({ email: true, sms: false }));
});
