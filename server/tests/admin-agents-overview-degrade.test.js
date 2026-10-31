// Overview must finish when the optional lead-detail read fails, and its
// totals must cover every loaded task, not just the 80-row feed.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn() }; db.fn = { now: jest.fn() }; return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/lead-attribution', () => ({}));
jest.mock('../services/agent-activity', () => ({}));
jest.mock('../services/model-switchboard', () => ({ AREAS: [] }));
jest.mock('../services/model-discovery', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; next(); },
  requireAdmin: (req, res, next) => next(),
}));
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const agents = require('../routes/admin-agents');

let server, base, tables, failLeadDetails;
function chain(table) {
  const result = tables[table] || [];
  const qb = {};
  for (const method of ['where', 'whereNull', 'whereNot', 'whereNotIn', 'orderBy', 'orderByRaw', 'limit', 'select', 'sum', 'groupBy', 'leftJoin', 'modify', 'count']) qb[method] = jest.fn(() => qb);
  // Only loadLeadConversionDetails filters leads with whereIn.
  qb.whereIn = jest.fn(() => {
    if (table === 'leads' && failLeadDetails) qb.then = (resolve, reject) => Promise.reject(new Error('lead details boom')).then(resolve, reject);
    return qb;
  });
  qb.first = jest.fn(async () => null);
  qb.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return qb;
}
beforeAll(async () => {
  const app = express();
  app.use('/agents', agents);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  failLeadDetails = false;
  tables = {};
  logger.warn.mockClear();
  db.schema.hasTable.mockImplementation(async (table) => Object.prototype.hasOwnProperty.call(tables, table));
  db.mockImplementation((table) => chain(table));
});

const overview = async () => (await fetch(`${base}/agents/overview`)).json();

function staleLeads(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `lead-${i}`, first_name: 'Test', last_name: `Lead${i}`, phone: '+15555550100', email: null, status: 'new',
    lead_type: 'lead', service_interest: 'pest', urgency: null,
    first_contact_at: new Date(Date.now() - 3 * 60 * 60 * 1000), next_follow_up_at: null,
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000), response_time_minutes: null, call_duration_seconds: null,
    estimate_id: null, customer_id: null,
  }));
}

it('completes with a degraded lead panel when the lead-detail query rejects', async () => {
  tables = { leads: staleLeads(3) };
  failLeadDetails = true;

  const res = await fetch(`${base}/agents/overview`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.agentDetails.lead_conversion).toEqual({ unavailable: true, metrics: {} });
  expect(body.tasks.length).toBeGreaterThan(0);
  expect(body.sources.find((s) => s.id === 'leads').status).toBe('ok');
  expect(JSON.stringify(body)).not.toContain('boom');
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lead conversion details failed'));
});

it('answers with a controlled error instead of hanging when the task-state read rejects', async () => {
  tables = { leads: staleLeads(2), agent_ops_task_states: [] };
  const original = db.getMockImplementation();
  db.mockImplementation((table) => {
    if (table !== 'agent_ops_task_states') return original(table);
    const qb = chain(table);
    qb.then = (resolve, reject) => Promise.reject(new Error('state boom')).then(resolve, reject);
    return qb;
  });

  const res = await fetch(`${base}/agents/overview`);
  expect(res.status).toBe(500);
});

it('counts tasks past the 80-row feed in totals and keeps their agent non-idle', async () => {
  // The mock ignores .limit, so 100 one-star reviews (high priority) fill the
  // feed and push every lead task past row 80.
  tables = {
    leads: staleLeads(20),
    google_reviews: Array.from({ length: 100 }, (_, i) => ({
      id: `rev-${i}`, reviewer_name: `Reviewer ${i}`, star_rating: 1, review_text: 'Test review', review_reply: null,
      review_created_at: new Date(Date.now() - i * 60 * 1000), created_at: new Date(Date.now() - i * 60 * 1000),
    })),
  };

  const body = await overview();
  const { summary } = body;
  // Every lead task sits past the feed window, yet its agent still has work.
  expect(body.tasks.some((t) => t.agentId === 'lead_conversion')).toBe(false);
  const lead = body.agents.find((a) => a.id === 'lead_conversion');
  expect(lead.openTasks).toBe(20);
  expect(lead.status).not.toBe('idle');
  expect(summary.shownTasks).toBe(body.tasks.length);
  expect(summary.shownTasks).toBe(80);
  expect(summary.totalTasks).toBeGreaterThan(80);
  expect(summary.truncated).toBe(true);
  expect(summary.openTasks).toBe(summary.totalTasks);
  expect(summary.openTasks).toBeGreaterThan(body.tasks.length);
});

it('reports truncated false when the feed holds every task', async () => {
  tables = { leads: staleLeads(2) };
  const { summary } = await overview();
  expect(summary).toMatchObject({ truncated: false });
  expect(summary.shownTasks).toBe(summary.totalTasks);
});
