/**
 * Approval-time conversion recheck for click-followup drafts
 * (routes/admin-drafts.js → blockClickFollowupIfConverted).
 *
 * A click-followup draft can sit pending for days while the prospect books or
 * pays on their own. Pins: approve/revise on a CONVERTED contact never reach
 * sendCustomerMessage — the draft is retired (rejected +
 * flags.reason='converted_before_send') and the linked click_followup_actions
 * row flips to 'converted'; a transient guard error releases the claim
 * instead of retiring; other intents skip the guard entirely.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.technicianId = 'tech-1'; next(); },
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../config/twilio-numbers', () => ({
  findByNumber: jest.fn(() => null),
  getOutboundNumber: jest.fn(() => '+19410000000'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));

const express = require('express');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { customerConvertedSince } = require('../services/estimate-conversion-guard');
const router = require('../routes/admin-drafts');

const inserts = [];
const updates = [];

function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of ['where', 'whereIn', 'leftJoin', 'join', 'select', 'orderBy', 'limit', 'count']) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.insert = jest.fn((payload) => { b._mode = 'insert'; inserts.push({ table, payload }); return b; });
  b.update = jest.fn((payload) => { b._mode = 'update'; updates.push({ table, payload }); return b; });
  b.returning = jest.fn(() => b);
  b.then = (resolve, reject) => {
    const value = b._mode === 'update' ? (cfg.update ?? 1)
      : b._mode === 'first' ? cfg.first
        : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  b.catch = (onRejected) => b.then(undefined, onRejected);
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

function draftRow(overrides = {}) {
  return {
    id: 'draft-1',
    sms_log_id: null,
    customer_id: 'cust-1',
    intent: 'click_followup',
    status: 'approved', // post-claim shape returned by the claim UPDATE
    draft_response: 'Hi Dana, saw you were taking another look at your Waves quote - anything I can answer?',
    flags: JSON.stringify({ click_followup: true, toPhone: '+19415550101', estimate_id: 'est-1' }),
    created_at: new Date('2026-07-04T15:00:00Z'),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/drafts', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

beforeEach(() => {
  jest.clearAllMocks();
  inserts.length = 0;
  updates.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  sendCustomerMessage.mockResolvedValue({ sent: true });
  customerConvertedSince.mockResolvedValue({ converted: false });
});

describe('PUT /admin/drafts/:id/approve — click-followup conversion recheck', () => {
  test('converted contact → 409, draft retired, action flipped, NO send', async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'appointment-booked' });
    enqueue('message_drafts', { update: [draftRow()] });            // claim pending → approved
    enqueue('estimates', { first: { id: 'est-1', customer_id: 'cust-1', created_at: new Date() } });
    enqueue('message_drafts', { update: 1 });                       // retire → rejected
    enqueue('click_followup_actions', { update: 1 });               // action → converted

    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/drafts/draft-1/approve`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const retire = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'rejected');
    expect(retire).toBeDefined();
    expect(JSON.parse(retire.payload.flags)).toMatchObject({ reason: 'converted_before_send' });
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'click_followup_actions', payload: expect.objectContaining({ status: 'converted' }) },
    ]));
  });

  test('unconverted contact → the send proceeds normally', async () => {
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { first: { id: 'est-1', customer_id: 'cust-1', created_at: new Date() } });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } }); // recipient resolution
    enqueue('message_drafts', { update: 1 });                       // final sent stamp

    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/drafts/draft-1/approve`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
    });

    expect(customerConvertedSince).toHaveBeenCalled();
    // Proactive estimate nudge — must ride the estimate_followup policy
    // rails (quiet hours + transactional consent), never the conversational
    // anonymous-lead carve-out.
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      purpose: 'estimate_followup',
      audience: 'customer',
      estimateId: 'est-1',
    }));
  });

  test('P1: lead-only click-followup draft sends as estimate_followup with a transactional consentBasis', async () => {
    enqueue('message_drafts', { update: [draftRow({ customer_id: null })] }); // claim
    enqueue('estimates', { first: { id: 'est-1', customer_id: null, created_at: new Date() } });
    enqueue('message_drafts', { update: 1 });                       // final sent stamp

    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/drafts/draft-1/approve`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
    });

    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'estimate_followup',
      audience: 'lead',
      estimateId: 'est-1',
      consentBasis: expect.objectContaining({
        status: 'transactional_allowed',
        source: 'click_followup_draft',
      }),
    }));
    // Never the conversational carve-out for a proactive nudge.
    expect(sendCustomerMessage).not.toHaveBeenCalledWith(expect.objectContaining({ purpose: 'conversational' }));
  });

  test('transient guard error → 503, claim released back to pending, draft NOT retired', async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'guard-error' });
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { first: { id: 'est-1', customer_id: 'cust-1', created_at: new Date() } });
    enqueue('message_drafts', { update: 1 });                       // releaseDraftClaim

    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/drafts/draft-1/approve`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(503);
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Released, not rejected — a later approval re-checks.
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'message_drafts', payload: expect.objectContaining({ status: 'pending' }) },
    ]));
    expect(updates.find((u) => u.payload && u.payload.status === 'rejected')).toBeUndefined();
  });

  test('other intents never invoke the conversion guard', async () => {
    enqueue('message_drafts', { update: [draftRow({ intent: 'GENERAL', flags: JSON.stringify({ toPhone: '+19415550101' }) })] });
    enqueue('customers', { first: null });                          // resolveDraftRecipient customer lookup
    enqueue('message_drafts', { update: 1 });                       // final sent stamp

    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/drafts/draft-1/approve`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
    });

    expect(customerConvertedSince).not.toHaveBeenCalled();
    // Legacy inbound-reply queue keeps its conversational shape untouched.
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'conversational',
      audience: 'lead',
    }));
  });
});

describe('PUT /admin/drafts/:id/revise — same recheck before the edited send', () => {
  test('converted contact → 409 and NO send of the revised copy', async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'paid-invoice' });
    enqueue('message_drafts', { update: [draftRow({ status: 'revised' })] }); // claim
    enqueue('estimates', { first: { id: 'est-1', customer_id: 'cust-1', created_at: new Date() } });
    enqueue('message_drafts', { update: 1 });                       // retire
    enqueue('click_followup_actions', { update: 1 });               // action → converted

    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy' }),
      });
      expect(res.status).toBe(409);
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'click_followup_actions', payload: expect.objectContaining({ status: 'converted' }) },
    ]));
  });
});
