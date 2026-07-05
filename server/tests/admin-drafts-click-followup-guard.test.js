/**
 * Approval-time pre-send gate for click-followup drafts
 * (routes/admin-drafts.js → guardClickFollowupSend → shared
 * services/click-followup-gate).
 *
 * A click-followup draft can sit pending for days while every guard the
 * queue applied at draft time flips. Pins the per-verdict UX mapping:
 *   terminal (converted / estimate_terminal / suppressed) → 409, draft
 *     RETIRED (rejected + cause-specific flags.reason) + linked action row
 *     updated;
 *   transient (cadence_due / recent_outbound / replied_recently) → 409,
 *     draft LEFT PENDING (claim released) so the owner can retry;
 *   guard_error → 503, left pending;
 *   ok → send proceeds under the ESTIMATE policy (purpose
 *     'estimate_followup' + transactional consentBasis for lead-only), never
 *     the conversational anonymous-lead carve-out;
 *   other intents → gate never invoked, conversational shape untouched.
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
jest.mock('../services/click-followup-gate', () => ({
  evaluateClickFollowupGate: jest.fn(async () => ({ ok: true })),
}));

const express = require('express');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { evaluateClickFollowupGate } = require('../services/click-followup-gate');
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
    flags: JSON.stringify({
      click_followup: true,
      toPhone: '+19415550101',
      estimate_id: 'est-1',
      lead_id: 'lead-1',
      clicked_at: '2026-07-04T11:00:00Z',
    }),
    created_at: new Date('2026-07-04T15:00:00Z'),
    ...overrides,
  };
}

const EST_ROW = { id: 'est-1', customer_id: 'cust-1', created_at: new Date('2026-07-01T00:00:00Z') };

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

async function approve(base, id = 'draft-1') {
  return fetch(`${base}/admin/drafts/${id}/approve`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  inserts.length = 0;
  updates.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  sendCustomerMessage.mockResolvedValue({ sent: true });
  evaluateClickFollowupGate.mockResolvedValue({ ok: true });
});

describe('approve — gate inputs and pass-through', () => {
  test('gate receives the fresh estimate + lead/phone/clicked_at from flags', async () => {
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { first: EST_ROW });                       // fresh estimate load
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } }); // recipient
    enqueue('message_drafts', { update: 1 });                       // final sent stamp

    await withServer(async (base) => {
      expect((await approve(base)).status).toBe(200);
    });

    expect(evaluateClickFollowupGate).toHaveBeenCalledWith(expect.objectContaining({
      estimate: EST_ROW,
      customerId: 'cust-1',
      leadId: 'lead-1',
      phone: '+19415550101',
      sinceTs: '2026-07-04T11:00:00Z',
    }));
    // Proactive estimate nudge — estimate policy rails, never conversational.
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'estimate_followup',
      audience: 'customer',
      estimateId: 'est-1',
    }));
  });

  test('P1: lead-only draft sends as estimate_followup with a transactional consentBasis', async () => {
    enqueue('message_drafts', { update: [draftRow({ customer_id: null })] });
    enqueue('estimates', { first: { ...EST_ROW, customer_id: null } });
    enqueue('message_drafts', { update: 1 });

    await withServer(async (base) => {
      expect((await approve(base)).status).toBe(200);
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
  });

  test('other intents never invoke the gate and keep the conversational shape', async () => {
    enqueue('message_drafts', { update: [draftRow({ intent: 'GENERAL', flags: JSON.stringify({ toPhone: '+19415550101' }) })] });
    enqueue('customers', { first: null });
    enqueue('message_drafts', { update: 1 });

    await withServer(async (base) => {
      expect((await approve(base)).status).toBe(200);
    });

    expect(evaluateClickFollowupGate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'conversational',
      audience: 'lead',
    }));
  });
});

// Table-driven verdict mapping — every queue suppression has its approval
// twin, with the UX decided per cause.
describe('approve — verdict mapping (shared-gate parity)', () => {
  const RETIRE_CASES = [
    { code: 'converted', reason: 'converted_before_send', actionStatus: 'converted' },
    { code: 'estimate_terminal', reason: 'estimate_closed_before_send', actionStatus: 'dismissed' },
    { code: 'suppressed', reason: 'recipient_suppressed', actionStatus: 'dismissed' },
  ];

  for (const { code, reason, actionStatus } of RETIRE_CASES) {
    test(`${code} → 409, draft retired (flags.reason='${reason}'), action → ${actionStatus}, NO send`, async () => {
      evaluateClickFollowupGate.mockResolvedValue({ ok: false, code });
      enqueue('message_drafts', { update: [draftRow()] });          // claim
      enqueue('estimates', { first: EST_ROW });
      enqueue('message_drafts', { update: 1 });                     // retire
      enqueue('click_followup_actions', { update: 1 });             // action update

      await withServer(async (base) => {
        expect((await approve(base)).status).toBe(409);
      });

      expect(sendCustomerMessage).not.toHaveBeenCalled();
      const retire = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'rejected');
      expect(retire).toBeDefined();
      expect(JSON.parse(retire.payload.flags)).toMatchObject({ reason });
      expect(updates).toEqual(expect.arrayContaining([
        { table: 'click_followup_actions', payload: expect.objectContaining({ status: actionStatus }) },
      ]));
    });
  }

  const HOLD_CASES = ['cadence_due', 'recent_outbound', 'replied_recently'];

  for (const code of HOLD_CASES) {
    test(`${code} → 409, draft LEFT PENDING (claim released), never retired, NO send`, async () => {
      evaluateClickFollowupGate.mockResolvedValue({ ok: false, code });
      enqueue('message_drafts', { update: [draftRow()] });          // claim
      enqueue('estimates', { first: EST_ROW });
      enqueue('message_drafts', { update: 1 });                     // releaseDraftClaim

      await withServer(async (base) => {
        const res = await approve(base);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toContain('pending'); // clear retry hint
      });

      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(updates).toEqual(expect.arrayContaining([
        { table: 'message_drafts', payload: expect.objectContaining({ status: 'pending' }) },
      ]));
      expect(updates.find((u) => u.payload && u.payload.status === 'rejected')).toBeUndefined();
    });
  }

  test('guard_error → 503, draft left pending, NO send', async () => {
    evaluateClickFollowupGate.mockResolvedValue({ ok: false, code: 'guard_error' });
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { first: EST_ROW });
    enqueue('message_drafts', { update: 1 });                       // releaseDraftClaim

    await withServer(async (base) => {
      expect((await approve(base)).status).toBe(503);
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'message_drafts', payload: expect.objectContaining({ status: 'pending' }) },
    ]));
  });
});

describe('revise — same gate before the edited send', () => {
  test('terminal verdict → 409 retire and NO send of the revised copy', async () => {
    evaluateClickFollowupGate.mockResolvedValue({ ok: false, code: 'converted' });
    enqueue('message_drafts', { update: [draftRow({ status: 'revised' })] }); // claim
    enqueue('estimates', { first: EST_ROW });
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

  test('transient verdict → 409, revised draft released back to pending (edit cleared)', async () => {
    evaluateClickFollowupGate.mockResolvedValue({ ok: false, code: 'recent_outbound' });
    enqueue('message_drafts', { update: [draftRow({ status: 'revised' })] }); // claim
    enqueue('estimates', { first: EST_ROW });
    enqueue('message_drafts', { update: 1 });                       // releaseDraftClaim

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
      { table: 'message_drafts', payload: expect.objectContaining({ status: 'pending', revised_response: null }) },
    ]));
  });
});
