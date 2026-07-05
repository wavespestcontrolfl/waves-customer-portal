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
 *
 * Round 6 adds:
 *   estimate lookup ERROR → transient 503 (draft pending, claim released,
 *     gate never consulted) — a failed read must not masquerade as a missing
 *     estimate and permanently retire the draft; only a read that SUCCEEDS
 *     with no row reaches the gate as estimate:null (→ terminal);
 *   send SUCCESS → the linked action leaves the open set ('sent', same
 *     transaction as the draft finalization) so a later click by the same
 *     contact re-qualifies instead of waiting out the 14-day sweep.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
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
    if (cfg.error) return Promise.reject(cfg.error).then(resolve, reject);
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
      kind: 'estimate',
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
  // Transaction proxy: route trx(table) through the same table queues (same
  // shape as click-followup.test.js) so the reject route's draft + action
  // writes record like any other call.
  db.transaction = jest.fn(async (cb) => cb(db));
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
      kind: 'estimate', // from flags — booking-kind drafts keep their accepted-estimate semantics at approval too
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
      // Retire + action transition are ATOMIC (round 7): a failure between
      // the two writes must not strand the action in the open 'drafted' set.
      expect(db.transaction).toHaveBeenCalledTimes(1);
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

// Round 6: a FAILED estimate read is transient — it must ride the existing
// guard_error UX (503, claim released, draft pending) instead of reaching
// the gate as estimate:null, which reads as estimate_terminal and would
// PERMANENTLY retire the draft + dismiss its action over a DB blip. Only a
// read that SUCCEEDS and finds no row is a truly missing estimate.
describe('approve — estimate lookup errors are transient, missing rows are terminal', () => {
  test('estimate read THROWS → 503, draft left pending (claim released), gate never consulted, NO send, nothing retired', async () => {
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { error: new Error('connection reset') }); // transient DB failure
    enqueue('message_drafts', { update: 1 });                       // releaseDraftClaim

    await withServer(async (base) => {
      const res = await approve(base);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('pending'); // clear retry hint
    });

    expect(evaluateClickFollowupGate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'message_drafts', payload: expect.objectContaining({ status: 'pending' }) },
    ]));
    expect(updates.find((u) => u.payload && u.payload.status === 'rejected')).toBeUndefined();
    expect(updates.find((u) => u.table === 'click_followup_actions')).toBeUndefined();
  });

  test('estimate read succeeds but finds NO row → gate sees estimate:null (terminal path, not a retry loop)', async () => {
    evaluateClickFollowupGate.mockResolvedValue({ ok: false, code: 'estimate_terminal' });
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { first: undefined });                     // clean read, row gone
    enqueue('message_drafts', { update: 1 });                       // retire
    enqueue('click_followup_actions', { update: 1 });               // action → dismissed

    await withServer(async (base) => {
      expect((await approve(base)).status).toBe(409);
    });

    expect(evaluateClickFollowupGate).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: null }),
    );
    const retire = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'rejected');
    expect(retire).toBeDefined();
    expect(JSON.parse(retire.payload.flags)).toMatchObject({ reason: 'estimate_closed_before_send' });
  });
});

// Round 6: when the send SUCCEEDS the linked action must leave the open set
// too — the reject path already goes terminal ('dismissed'); the success
// path goes 'sent' (terminal for hasOpenAction + the partial uniques, so a
// later click by the same contact re-qualifies immediately, yet still
// distinguishable from dismissed in outcome telemetry) atomically with the
// draft finalization.
describe('approve/revise success — linked action released to sent in the finalization transaction', () => {
  test('approve success → draft stamped AND action → sent in ONE transaction, scoped to open statuses on the linked draft', async () => {
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { first: EST_ROW });                       // gate estimate load
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } }); // recipient
    enqueue('message_drafts', { update: 1 });                       // final stamp (in trx)
    enqueue('click_followup_actions', { update: 1 });               // action → sent (in trx)

    await withServer(async (base) => {
      expect((await approve(base)).status).toBe(200);
    });

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // Same atomicity rule as reject / the queue's draft+link pair / the sweep.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'message_drafts', payload: expect.objectContaining({ sent_at: expect.any(Date) }) },
      { table: 'click_followup_actions', payload: expect.objectContaining({ status: 'sent' }) },
    ]));

    const idx = db.mock.calls.findIndex((c) => c[0] === 'click_followup_actions');
    const actionBuilder = db.mock.results[idx].value;
    // Keyed on the linked draft (non-click intents have no action row —
    // harmless no-op) and scoped to OPEN statuses so a gate-retired outcome
    // (converted/dismissed) is never overwritten.
    expect(actionBuilder.where).toHaveBeenCalledWith({ draft_id: 'draft-1' });
    expect(actionBuilder.whereIn).toHaveBeenCalledWith('status', ['pending', 'drafted']);
  });

  test('revise success → action → sent in the same transaction as the sent stamp', async () => {
    enqueue('message_drafts', { update: [draftRow({ status: 'revised' })] }); // claim
    enqueue('estimates', { first: EST_ROW });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });
    enqueue('message_drafts', { update: 1 });                       // sent stamp (in trx)
    enqueue('click_followup_actions', { update: 1 });               // action → sent (in trx)

    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy' }),
      });
      expect(res.status).toBe(200);
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'click_followup_actions', payload: expect.objectContaining({ status: 'sent' }) },
    ]));
  });

  test('blocked send (not sent) NEVER releases the action — claim released, action untouched', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, reason: 'opted_out' });
    enqueue('message_drafts', { update: [draftRow()] });            // claim
    enqueue('estimates', { first: EST_ROW });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });
    enqueue('message_drafts', { update: 1 });                       // releaseDraftClaim

    await withServer(async (base) => {
      expect((await approve(base)).status).toBe(422);
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === 'click_followup_actions')).toBeUndefined();
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'message_drafts', payload: expect.objectContaining({ status: 'pending' }) },
    ]));
  });
});

// Owner reject must RELEASE the linked click action (round 5): 'drafted' is
// an open status for hasOpenAction and the partial unique indexes, so leaving
// it behind would block a fresh re-click from re-qualifying the contact until
// the 14-day stale sweep.
describe('reject — releases the linked click action', () => {
  async function reject(base, id = 'draft-1') {
    return fetch(`${base}/admin/drafts/${id}/reject`, { method: 'PUT' });
  }

  test('reject retires the draft AND flips the linked action to a TERMINAL status, in ONE transaction', async () => {
    enqueue('message_drafts', { update: 1 });
    enqueue('click_followup_actions', { update: 1 });

    await withServer(async (base) => {
      expect((await reject(base)).status).toBe(200);
    });

    // Same atomicity rule as the queue's draft-insert + action-link pair and
    // the stale sweep: both writes commit or roll back together.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([
      { table: 'message_drafts', payload: expect.objectContaining({ status: 'rejected' }) },
      // 'dismissed' sits OUTSIDE hasOpenAction's pending|drafted set and the
      // partial unique indexes — a fresh re-click re-qualifies immediately
      // instead of waiting out the 14-day sweep.
      { table: 'click_followup_actions', payload: expect.objectContaining({ status: 'dismissed' }) },
    ]);

    const idx = db.mock.calls.findIndex((c) => c[0] === 'click_followup_actions');
    const actionBuilder = db.mock.results[idx].value;
    // Keyed on the linked draft (non-click intents have no linked action —
    // harmless no-op) and scoped to OPEN statuses so an action the approval
    // gate already retired (converted/dismissed) keeps its outcome.
    expect(actionBuilder.where).toHaveBeenCalledWith({ draft_id: 'draft-1' });
    expect(actionBuilder.whereIn).toHaveBeenCalledWith('status', ['pending', 'drafted']);
  });

  test('reject NEVER sends and never touches the gate', async () => {
    enqueue('message_drafts', { update: 1 });
    enqueue('click_followup_actions', { update: 1 });

    await withServer(async (base) => {
      expect((await reject(base)).status).toBe(200);
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(evaluateClickFollowupGate).not.toHaveBeenCalled();
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
