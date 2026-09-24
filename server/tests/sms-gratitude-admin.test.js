const express = require('express');

jest.mock('../models/db', () => jest.fn(() => { throw new Error('route must not write operational rows'); }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/lead-attribution', () => ({}));
jest.mock('../services/agent-activity', () => ({}));
jest.mock('../services/model-switchboard', () => ({}));
jest.mock('../services/agent-control/hub-read', () => ({}));
jest.mock('../services/agent-control/run-index', () => ({}));
jest.mock('../services/agent-control/runs', () => ({}));
jest.mock('../services/model-discovery', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate(req, res, next) {
    if (!req.headers['x-test-role']) return res.sendStatus(401);
    req.testRole = req.headers['x-test-role'];
    next();
  },
  requireAdmin(req, res, next) { return req.testRole === 'admin' ? next() : res.sendStatus(403); },
  requireTechOrAdmin(req, res, next) { next(); },
}));
jest.mock('../services/sms-gratitude-qualification', () => ({
  createGratitudeQualification: jest.fn(), runGratitudeQualification: jest.fn(),
  evaluateGratitudeQualification: jest.fn(),
}));
jest.mock('../services/sms-gratitude', () => ({ GRATITUDE_INTENT: 'gratitude_reply' }));
jest.mock('../services/sms-suggest-mode', () => ({
  SUGGEST_WORKFLOW: 'sms_suggest',
  AUTO_SEND_MODE: 'auto_send',
  isEscalationIntent: jest.fn(() => false),
  listIntentModes: jest.fn(),
}));
jest.mock('../services/sms-graduation', () => ({
  THRESHOLDS: {},
  resolveCohortVersions: jest.fn(() => ['house_voice_v11']),
  resolveVoiceProfilePin: jest.fn(async () => null),
  rollupSuggestOutcomes: jest.fn(() => new Map()),
  computeReadiness: jest.fn(),
}));

const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const qualification = require('../services/sms-gratitude-qualification');
const suggestMode = require('../services/sms-suggest-mode');
const graduation = require('../services/sms-graduation');
const app = express();
app.use(express.json());
app.use('/agents', require('../routes/admin-agents'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

let server;
let base;
beforeAll(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/agents/gratitude-qualification`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
async function request(method, role, body) {
  return fetch(base, {
    method: method.toUpperCase(),
    headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  qualification.createGratitudeQualification.mockResolvedValue({ id: 'exam-1' });
  qualification.runGratitudeQualification.mockResolvedValue({ eligible: true });
  qualification.evaluateGratitudeQualification.mockResolvedValue({ eligible: false, blockers: ['Not run'] });
});

test.each(['get', 'post'])('qualification %s stays behind both admin guards', async method => {
  expect((await request(method)).status).toBe(401);
  expect((await request(method, 'tech')).status).toBe(403);
  expect(qualification.createGratitudeQualification).not.toHaveBeenCalled();
  expect(qualification.evaluateGratitudeQualification).not.toHaveBeenCalled();
});

test('admin starts only the fixed no-send exam and receives a durable run identifier', async () => {
  const res = await request('post', 'admin', { fixtures: 'ignored', eligible: true });
  expect(res.status).toBe(202);
  await new Promise(setImmediate);
  expect(await res.json()).toEqual({ runId: 'exam-1', customerCommunication: false });
  expect(qualification.createGratitudeQualification).toHaveBeenCalledWith({ triggeredBy: expect.any(String) });
  expect(qualification.runGratitudeQualification).toHaveBeenCalledWith({ runId: 'exam-1' });
  expect(qualification.runGratitudeQualification).toHaveBeenCalledTimes(1);
});

test('in-progress exam refuses a duplicate start', async () => {
  qualification.createGratitudeQualification.mockRejectedValue(Object.assign(new Error('Already running'), { code: 'RUN_IN_PROGRESS' }));
  expect((await request('post', 'admin')).status).toBe(409);
  expect(qualification.runGratitudeQualification).not.toHaveBeenCalled();
});

test('readiness read neither starts a run nor changes a delivery mode', async () => {
  const res = await request('get', 'admin');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ eligible: false, blockers: ['Not run'] });
  expect(qualification.createGratitudeQualification).not.toHaveBeenCalled();
});

test('intent modes expose the effective gratitude gate per row and retain the global gate field', async () => {
  db.raw = jest.fn(sql => sql);
  db.mockImplementation((table) => {
    if (table === 'message_drafts') {
      return {
        whereNotNull() { return this; },
        distinct() { return this; },
        pluck: async () => [],
      };
    }
    if (table?.a === 'agent_decisions') {
      return {
        leftJoin() { return this; },
        where() { return this; },
        select() { return this; },
        count() { return this; },
        groupBy: async () => [],
      };
    }
    throw new Error(`unexpected table: ${String(table)}`);
  });
  featureGates.isEnabled.mockImplementation(gate => gate === 'smsGratitudeReplies');
  suggestMode.listIntentModes.mockResolvedValue([
    { intent: 'general_question', mode: 'suggest' },
    { intent: 'gratitude_reply', mode: 'shadow' },
  ]);
  graduation.computeReadiness.mockResolvedValue(new Map([
    ['general_question', { eligibleFor: 'auto_send' }],
    ['gratitude_reply', { eligibleFor: 'auto_send', qualification: { basis: 'fixed_copy_exam' } }],
  ]));

  const res = await fetch(base.replace('/gratitude-qualification', '/intent-modes'), {
    headers: { 'x-test-role': 'admin' },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.autoSendGateEnabled).toBe(false);
  expect(body.intents).toEqual(expect.arrayContaining([
    expect.objectContaining({ intent: 'general_question', autoSendGateEnabled: false }),
    expect.objectContaining({ intent: 'gratitude_reply', autoSendGateEnabled: true }),
  ]));
  expect(featureGates.isEnabled).toHaveBeenCalledWith('smsAutoSend');
  expect(featureGates.isEnabled).toHaveBeenCalledWith('smsGratitudeReplies');
});
