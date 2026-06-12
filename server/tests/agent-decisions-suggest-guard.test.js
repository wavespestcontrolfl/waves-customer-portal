/**
 * House-voice suggestions (brand-voice loop Phase D) must NOT be resolvable
 * through the generic Agent Review endpoint: for that workflow,
 * accepted/corrected mean the comms composer send handler actually sent the
 * text. A generic verdict would remove the composer card, contaminate the
 * graduation telemetry, and leave the customer unreplied.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'admin-1', first_name: 'Test', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/reply-training-capture', () => ({
  upsertReplyExampleFromAgentReview: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { SUGGEST_WORKFLOW } = require('../services/sms-suggest-mode');
const decisionsRouter = require('../routes/admin-agent-decisions');

function firstBuilder(row) {
  const builder = {
    where: jest.fn(() => builder),
    first: jest.fn(async () => row),
  };
  return builder;
}

function updateBuilder(updatedRow) {
  const builder = {
    where: jest.fn(() => builder),
    update: jest.fn(() => ({ returning: async () => [updatedRow] })),
  };
  return builder;
}

let server;
let baseUrl;

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use('/admin/agent-decisions', decisionsRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  db.mockReset();
});

async function postReview(id, body) {
  const res = await fetch(`${baseUrl}/admin/agent-decisions/${id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('generic review rejects house-voice suggestions with 409 and never writes', async () => {
  const lookup = firstBuilder({ id: 'd-suggest', workflow: SUGGEST_WORKFLOW });
  const update = updateBuilder({ id: 'd-suggest' });
  db.mockImplementationOnce(() => lookup).mockImplementationOnce(() => update);

  const { status, body } = await postReview('d-suggest', { verdict: 'accepted' });

  expect(status).toBe(409);
  expect(body.error).toMatch(/composer/i);
  expect(update.update).not.toHaveBeenCalled();
});

test('generic review still resolves other workflows', async () => {
  const lookup = firstBuilder({ id: 'd-lead', workflow: 'lead_response_workflow' });
  const updatedRow = {
    id: 'd-lead',
    workflow: 'lead_response_workflow',
    status: 'accepted',
    human_verdict: 'accepted',
  };
  const update = updateBuilder(updatedRow);
  db.mockImplementationOnce(() => lookup).mockImplementationOnce(() => update);

  const { status, body } = await postReview('d-lead', { verdict: 'accepted' });

  expect(status).toBe(200);
  expect(body.decision.id).toBe('d-lead');
  expect(update.update).toHaveBeenCalled();
});
