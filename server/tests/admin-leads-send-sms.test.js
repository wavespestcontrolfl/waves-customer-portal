process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(async () => ({})); return db; });
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { name: 'QA Operator' };
    req.technicianId = 'admin-qa';
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/lead-attribution', () => ({
  normalizePhone: jest.requireActual('../utils/phone').normalizePhone,
  logFirstResponse: jest.fn(async () => {}),
}));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: jest.fn(async () => {}) }));
// Follow-up to codex #5018 r15 P2: the manual-send race guard's own
// linkSentRecently read, lazily required inside withSmsHandoff — mocked so
// its behavior (hit vs. no hit) is asserted directly rather than through a
// real DB read.
// codex #5196: insertConsultationLinkAttempt/deleteConsultationLinkAttempt
// (the shared consultation_link_send_attempts writer/deleter) mocked the
// same way linkSentRecently is — asserted directly rather than through a
// real DB write.
jest.mock('../services/call-booking-link-text', () => ({
  linkSentRecently: jest.fn(async () => false),
  MANUAL_SEND_RACE_GUARD_WINDOW_MS: 10 * 60 * 1000,
  insertConsultationLinkAttempt: jest.fn(async () => 'attempt-42'),
  deleteConsultationLinkAttempt: jest.fn(async () => {}),
}));
// Deterministic fromNumber validation only — mediaFromOutboundAttachments
// is left real (pure, no I/O) so attachment shape assertions below exercise
// the actual transform the generic /admin/communications/sms route relies on.
jest.mock('../config/twilio-numbers', () => ({
  findByNumber: jest.fn((n) => (n === '+19415559999' ? { number: n } : null)),
}));

const express = require('express');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { logFirstResponse } = require('../services/lead-attribution');
const { bridgeLeadFunnelStage } = require('../services/lead-funnel-bridge');
const { linkSentRecently, insertConsultationLinkAttempt, deleteConsultationLinkAttempt } = require('../services/call-booking-link-text');
const router = require('../routes/admin-leads');
let lead;
let activities;
let update;

beforeEach(() => {
  jest.clearAllMocks();
  lead = { id: 'lead-qa', phone: '+19415550103', status: 'new', response_time_minutes: null };
  activities = [];
  update = jest.fn(async (patch) => { Object.assign(lead, patch); return 1; });
  db.mockImplementation((table) => {
    const builder = {
      where: jest.fn(() => builder), whereNull: jest.fn(() => builder),
      first: jest.fn(async () => ({ ...lead })), update,
      insert: jest.fn(async (row) => { if (table === 'lead_activities') activities.push(row); }),
    };
    return builder;
  });
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM_qa_lead' });
});
async function send(body = { message: 'Synthetic outreach', to: '+19415550103' }) {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/leads/lead-qa/send-sms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('real lead outreach records activity, first response and contacted stage, returning the provider receipt', async () => {
  const response = await send();
  expect(response).toMatchObject({ status: 200, body: { sent: true, providerMessageId: 'SM_qa_lead', lead: { status: 'contacted' } } });
  expect(activities).toEqual([expect.objectContaining({ lead_id: 'lead-qa', activity_type: 'sms_sent', performed_by: 'QA Operator' })]);
  expect(logFirstResponse).toHaveBeenCalledWith('lead-qa');
  expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('lead-qa', 'contacted');
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'lead-qa', audience: 'lead' }));
});

test.each([
  { sent: false, blocked: true },
  { sent: false, retryable: true },
  { sent: true, providerMessageId: 'gate-blocked' },
  { sent: true, providerMessageId: 'template-disabled' },
  { sent: true },
])('does not advance or log a lead without real provider handoff: %j', async result => {
  sendCustomerMessage.mockResolvedValue(result);
  expect((await send()).status).toBe(422);
  expect(activities).toEqual([]);
  expect(update).not.toHaveBeenCalled();
  expect(logFirstResponse).not.toHaveBeenCalled();
  expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
});

// codex #5018 r15 P2: this manual send races call-booking-link-text.js's
// own worker (its final linkSentRecently check vs. this send both landing
// as if the other never happened) — serialized behind the SAME phone-locked
// handoff that lane's automated send already uses. Manual semantics stay
// unconditional; only the ORDERING of a concurrent automated attempt is
// affected.
test('the manual send carries the same phone-locked handoff the automated worker uses', async () => {
  await send();
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ withSmsHandoff: expect.any(Function) }));
  const { withSmsHandoff } = sendCustomerMessage.mock.calls[0][0];
  const trx = { raw: jest.fn(async () => {}) };
  db.transaction = jest.fn(async (fn) => fn(trx));
  const dispatch = jest.fn(async (t) => ({ sent: true, sawTrx: t === trx }));
  const result = await withSmsHandoff(dispatch);
  expect(db.transaction).toHaveBeenCalled();
  // lockSmsPhone's own real implementation (utils/customer-comms-lock.js) —
  // the SAME advisory key applyInboundOptout takes for a STOP.
  expect(trx.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [lead.phone]);
  expect(dispatch).toHaveBeenCalledWith(trx);
  expect(result).toEqual({ sent: true, sawTrx: true });
});

// Follow-up to codex #5018 r15 P2, narrowed by its own pre-push Codex r1
// P1: the phone lock above only serialized ORDERING — it never actually
// stopped a same-moment duplicate. Now that the lock is held, this route
// re-runs the automated lane's own linkSentRecently read on that same
// connection, scoped to a short race window rather than its 14-day dedupe
// window — but ONLY when this exact send carries a validated consultation
// link (bearerCheck.consultationLeadId, the SAME resolution the route's
// own bearer check just above already ran): this route is the general
// Leads-page send-sms path, not a consultation-link-only one, so gating on
// that is what keeps an ordinary reply untouched by the race guard.
describe('the manual-send race guard (codex #5018 r15 P2 follow-up)', () => {
  let bearerSpy;
  beforeEach(() => {
    bearerSpy = jest.spyOn(require('../services/composer-customer-links'), 'bearerLinkSendCheck')
      .mockResolvedValue({ ok: true, consultationLeadId: 'lead-qa' });
  });
  afterEach(() => { bearerSpy.mockRestore(); });

  test('an automated send landing just before this one refuses with 409, never dispatching', async () => {
    linkSentRecently.mockResolvedValueOnce(true);
    await send();
    const { withSmsHandoff } = sendCustomerMessage.mock.calls[0][0];
    const trx = { raw: jest.fn(async () => {}) };
    db.transaction = jest.fn(async (fn) => fn(trx));
    const dispatch = jest.fn(async () => ({ sent: true }));
    const result = await withSmsHandoff(dispatch);
    // codex #5196 P2: matchPhone scopes the manual-window check to this
    // send's own destination (lead.phone), not just the lead.
    expect(linkSentRecently).toHaveBeenCalledWith(trx, 'lead-qa', expect.any(Date), { windowMs: 10 * 60 * 1000, matchPhone: '+19415550103' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, code: 'LINK_SENT_RECENTLY_RACE', reason: expect.stringMatching(/just texted/i), retryable: false });
  });

  test('a link texted days ago (outside the race window) is not blocked — dispatch still runs', async () => {
    linkSentRecently.mockResolvedValueOnce(false);
    await send();
    const { withSmsHandoff } = sendCustomerMessage.mock.calls[0][0];
    const trx = { raw: jest.fn(async () => {}) };
    db.transaction = jest.fn(async (fn) => fn(trx));
    const dispatch = jest.fn(async (t) => ({ sent: true, sawTrx: t === trx }));
    const result = await withSmsHandoff(dispatch);
    expect(dispatch).toHaveBeenCalledWith(trx);
    expect(result).toEqual({ sent: true, sawTrx: true });
  });

  // Pre-push Codex r1 P1 regression: an ORDINARY reply (no consultation
  // link in this send at all) must never be blocked, however recently a
  // link went out — linkSentRecently is never even consulted for it.
  test('a plain-text reply with no consultation link is never blocked, even with a link just sent (Codex r1 P1)', async () => {
    bearerSpy.mockResolvedValue({ ok: true }); // no consultationLeadId
    linkSentRecently.mockResolvedValueOnce(true); // would refuse if consulted
    await send({ message: 'Sounds good, see you then!', to: '+19415550103' });
    const { withSmsHandoff } = sendCustomerMessage.mock.calls[0][0];
    const trx = { raw: jest.fn(async () => {}) };
    db.transaction = jest.fn(async (fn) => fn(trx));
    const dispatch = jest.fn(async (t) => ({ sent: true, sawTrx: t === trx }));
    const result = await withSmsHandoff(dispatch);
    expect(linkSentRecently).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(trx);
    expect(result).toEqual({ sent: true, sawTrx: true });
  });

  test('the route maps LINK_SENT_RECENTLY_RACE to a 409 with a clear message', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false, blocked: true, code: 'LINK_SENT_RECENTLY_RACE',
      reason: 'A booking link was just texted to this number a moment ago',
    });
    const response = await send();
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/just texted/i);
  });
});

// codex #5196 P1: the durable consultation_link_send_attempts marker —
// written at twilio.js's REAL attempt boundary (onDispatchStart) and
// cleared on an abort or a definite post-send failure — only for a send
// that carries a validated consultation link (bearerCheck.consultationLeadId,
// the SAME condition that runs the manual-race guard above).
describe('the consultation-link attempt marker (codex #5196 P1)', () => {
  let bearerSpy;
  beforeEach(() => {
    bearerSpy = jest.spyOn(require('../services/composer-customer-links'), 'bearerLinkSendCheck')
      .mockResolvedValue({ ok: true, consultationLeadId: 'lead-qa' });
  });
  afterEach(() => { bearerSpy.mockRestore(); });

  test('a consultation send passes onDispatchStart/onDispatchAbort/onDispatchRejected that write and clear the shared attempt row', async () => {
    await send();
    const { onDispatchStart, onDispatchAbort, onDispatchRejected } = sendCustomerMessage.mock.calls[0][0];
    expect(typeof onDispatchStart).toBe('function');
    expect(typeof onDispatchAbort).toBe('function');
    expect(typeof onDispatchRejected).toBe('function');
    await onDispatchStart();
    expect(insertConsultationLinkAttempt).toHaveBeenCalledWith({
      leadId: 'lead-qa', toPhone: lead.phone, source: 'admin_leads_send_sms',
    });
    await onDispatchAbort();
    expect(deleteConsultationLinkAttempt).toHaveBeenCalledWith('attempt-42');
  });

  // codex #5196 r4 P2: onDispatchRejected deletes the SAME id — it fires
  // from inside twilio.js's own dispatch() instead of onDispatchAbort when
  // messages.create() itself throws a definitive rejection.
  test('onDispatchRejected deletes the attempt row twilio.js\'s own dispatch() wrote', async () => {
    await send();
    const { onDispatchStart, onDispatchRejected } = sendCustomerMessage.mock.calls[0][0];
    await onDispatchStart();
    expect(deleteConsultationLinkAttempt).not.toHaveBeenCalled();
    await onDispatchRejected();
    expect(deleteConsultationLinkAttempt).toHaveBeenCalledWith('attempt-42');
  });

  // Mirrors production ordering: twilio.js invokes onDispatchStart BEFORE
  // sendCustomerMessage resolves, so the mock does the same here — proving
  // the ROUTE's own post-send cleanup (not just the hook's own definition)
  // fires for a definite failure.
  test('a definite send failure (never real, never ambiguous) deletes the attempt row', async () => {
    sendCustomerMessage.mockImplementation(async (opts) => {
      if (opts.onDispatchStart) await opts.onDispatchStart();
      return { sent: false, blocked: true, code: 'SOME_DEFINITE_FAILURE' };
    });
    await send();
    expect(insertConsultationLinkAttempt).toHaveBeenCalled();
    expect(deleteConsultationLinkAttempt).toHaveBeenCalledWith('attempt-42');
  });

  test('a real provider send keeps the attempt row (no cleanup call)', async () => {
    sendCustomerMessage.mockImplementation(async (opts) => {
      if (opts.onDispatchStart) await opts.onDispatchStart();
      return { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM_qa_lead' };
    });
    await send();
    expect(insertConsultationLinkAttempt).toHaveBeenCalled();
    expect(deleteConsultationLinkAttempt).not.toHaveBeenCalled();
  });

  test('an ambiguous provider outcome keeps the attempt row (no cleanup call)', async () => {
    const { isAmbiguousProviderOutcome } = jest.requireActual('../services/sms-auto-send');
    const ambiguous = { sent: false, retryable: true, deliveryOutcome: 'uncertain' };
    expect(isAmbiguousProviderOutcome(ambiguous)).toBe(true);
    sendCustomerMessage.mockImplementation(async (opts) => {
      if (opts.onDispatchStart) await opts.onDispatchStart();
      return ambiguous;
    });
    await send();
    expect(insertConsultationLinkAttempt).toHaveBeenCalled();
    expect(deleteConsultationLinkAttempt).not.toHaveBeenCalled();
  });

  test('a plain reply with no consultation link never touches the attempt marker', async () => {
    bearerSpy.mockResolvedValue({ ok: true }); // no consultationLeadId
    await send({ message: 'Sounds good, see you then!', to: '+19415550103' });
    const { onDispatchStart, onDispatchAbort, onDispatchRejected } = sendCustomerMessage.mock.calls[0][0];
    expect(onDispatchStart).toBeUndefined();
    expect(onDispatchAbort).toBeUndefined();
    expect(onDispatchRejected).toBeUndefined();
    expect(insertConsultationLinkAttempt).not.toHaveBeenCalled();
  });

  // codex round-3 P2: consultationAttemptId is now declared above the try
  // block so the route's catch — not just its resolved-result path above —
  // also applies the definite-failure cleanup, matching admin-
  // communications.js's own catch. persistAudit (or anything else past
  // onDispatchStart) throwing after the marker row was written is the real
  // shape this covers.
  describe('a throw after onDispatchStart (codex round-3 P2)', () => {
    test('a definite-failure providerOutcome on the thrown error deletes the attempt row', async () => {
      sendCustomerMessage.mockImplementation(async (opts) => {
        if (opts.onDispatchStart) await opts.onDispatchStart();
        const err = new Error('persist audit failed after a definite rejection');
        err.providerOutcome = { sent: false, deliveryOutcome: 'not_sent' };
        throw err;
      });
      const response = await send();
      expect(response.status).toBe(500);
      expect(insertConsultationLinkAttempt).toHaveBeenCalled();
      expect(deleteConsultationLinkAttempt).toHaveBeenCalledWith('attempt-42');
    });

    test('an ambiguous providerOutcome on the thrown error keeps the attempt row', async () => {
      sendCustomerMessage.mockImplementation(async (opts) => {
        if (opts.onDispatchStart) await opts.onDispatchStart();
        const err = new Error('handoff crossed the SDK boundary with no verdict yet');
        err.providerOutcome = { sent: false, deliveryOutcome: 'uncertain' };
        throw err;
      });
      const response = await send();
      expect(response.status).toBe(500);
      expect(insertConsultationLinkAttempt).toHaveBeenCalled();
      expect(deleteConsultationLinkAttempt).not.toHaveBeenCalled();
    });

    test('a real-send providerOutcome on the thrown error keeps the attempt row', async () => {
      sendCustomerMessage.mockImplementation(async (opts) => {
        if (opts.onDispatchStart) await opts.onDispatchStart();
        const err = new Error('post-send bookkeeping failed after Twilio accepted it');
        err.providerOutcome = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM_real_accepted' };
        throw err;
      });
      const response = await send();
      expect(response.status).toBe(500);
      expect(insertConsultationLinkAttempt).toHaveBeenCalled();
      expect(deleteConsultationLinkAttempt).not.toHaveBeenCalled();
    });
  });
});

test('rejects a stale destination before transport', async () => {
  expect((await send({ message: 'Synthetic outreach', to: '+19415550199' })).status).toBe(409);
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('keeps the existing message-only request contract', async () => {
  expect((await send({ message: 'Synthetic outreach' })).status).toBe(200);
});

test('does not move an already progressed lead back to contacted', async () => {
  lead.status = 'estimate_sent';
  expect((await send()).status).toBe(200);
  expect(update).not.toHaveBeenCalled();
  expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
});

// Pre-push Codex P1: the consultation-link lane routes the Communications
// composer's send through THIS route (for the audit trail above) whenever
// the resolved recipient is a lead with no customer row — attachments and
// the operator-picked fromNumber must reach sendCustomerMessage the same
// way they reach the generic /admin/communications/sms route, not vanish.
describe('attachments and fromNumber reach the sender (same shape as /admin/communications/sms)', () => {
  test('mediaUrls + mediaAttachments + fromNumber all land in the sendCustomerMessage metadata', async () => {
    const response = await send({
      message: 'Synthetic outreach with a photo',
      to: '+19415550103',
      fromNumber: '+19415559999',
      mediaUrls: ['https://cdn.example.com/a.jpg'],
      mediaAttachments: [{ url: 'https://cdn.example.com/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 1024 }],
    });
    expect(response.status).toBe(200);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-qa',
      metadata: expect.objectContaining({
        fromNumber: '+19415559999',
        mediaUrls: ['https://cdn.example.com/a.jpg'],
        allowMediaUrls: true,
        media: expect.arrayContaining([expect.objectContaining({
          url: 'https://cdn.example.com/a.jpg',
          fileName: 'a.jpg',
          contentType: 'image/jpeg',
          size: 1024,
        })]),
      }),
    }));
  });

  test('an unregistered fromNumber is refused before any send is attempted', async () => {
    const response = await send({ message: 'Synthetic outreach', to: '+19415550103', fromNumber: '+19995550000' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Waves Twilio number/i);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('attachments over the 5MB Twilio MMS cap are refused before any send is attempted', async () => {
    const response = await send({
      message: 'Synthetic outreach',
      to: '+19415550103',
      mediaAttachments: [
        { url: 'https://cdn.example.com/big1.jpg', size: 3 * 1024 * 1024 },
        { url: 'https://cdn.example.com/big2.jpg', size: 3 * 1024 * 1024 },
      ],
    });
    expect(response.status).toBe(413);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('no attachments and no fromNumber: metadata carries neither (unchanged plain-text contract)', async () => {
    await send();
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        fromNumber: undefined,
        mediaUrls: undefined,
        allowMediaUrls: false,
        media: [],
      }),
    }));
  });
});

// Pre-push Codex P1: a consultation short code inserted into a draft can go
// stale by the time the operator actually sends it (gate flipped off, the
// lead closed/converted, or the 14-day token expired) — checkConsultationLinkSend
// (composer-customer-links.js) is re-checked at THIS send boundary too, not
// only the generic /admin/communications/sms route.
describe('a consultation short code in the message is re-checked at THIS send boundary too (pre-push Codex P1)', () => {
  const originalGate = process.env.GATE_LEAD_INSPECTION_LINK;
  let shortCodeRows;
  let ownerRows = [];
  let linkedCustomerRow = null;

  function wireConsultationDb() {
    db.mockImplementation((table) => {
      if (table === 'short_codes') {
        const q = {
          whereIn: jest.fn(() => q),
          where: jest.fn(() => q),
          select: jest.fn(async () => shortCodeRows),
          // bearerLinkSendCheck's account-bound pass reads each /l/ code's
          // own row — a consultation code (lead-bound, no account owner).
          first: jest.fn(async () => (shortCodeRows[0]
            ? { ...shortCodeRows[0], kind: 'consultation', target_url: 'https://portal.wavespestcontrol.com/inspection/tok' }
            : undefined)),
        };
        return q;
      }
      const builder = {
        first: jest.fn(async () => (table === 'customers' ? linkedCustomerRow : { ...lead })), update,
        insert: jest.fn(async (row) => { if (table === 'lead_activities') activities.push(row); }),
        // bearerLinkSendCheck's owner recovery lists customers on the number
        // (none here — an unconverted lead).
        select: jest.fn(async () => (table === 'customers' ? ownerRows : [])),
      };
      for (const m of ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNot', 'whereRaw', 'orderBy', 'limit', 'andWhere', 'orWhere']) {
        builder[m] = jest.fn(() => builder);
      }
      return builder;
    });
  }

  beforeEach(() => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'true';
    shortCodeRows = [{ code: 'cons1', expires_at: new Date(Date.now() + 86400e3), lead_id: 'lead-qa', target_url: `https://portal.wavespestcontrol.com/inspection/${require('../utils/lead-consultation-token').mintLeadConsultationToken('lead-qa')}` }];
    wireConsultationDb();
  });

  afterEach(() => {
    if (originalGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
    else process.env.GATE_LEAD_INSPECTION_LINK = originalGate;
  });

  // Local audit P1 (#4709 r9): the Leads send runs the shared owner
  // recovery — a number exactly one live customer owns is that customer's
  // text (their notification preferences apply); an ambiguous one refuses.
  test('the number belongs to exactly one live customer → sent as that customer', async () => {
    ownerRows = [{ id: 'cust-owner' }];
    try {
      const response = await send({ message: 'Pick a time: portal.wavespestcontrol.com/l/cons1 Reply STOP to opt out.', to: '+19415550103' });
      expect(response.status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-owner', audience: 'customer' }));
    } finally {
      ownerRows = [];
    }
  });

  // Codex #4709 r11 P2: a household sharing the number is not ambiguous
  // when the lead's OWN linked customer is live and on this phone.
  test('the lead\'s own linked customer on this phone is the trusted owner, even with other customers on the number', async () => {
    ownerRows = [{ id: 'c1' }, { id: 'c2' }];
    const original = lead.customer_id;
    lead.customer_id = 'c1';
    linkedCustomerRow = { id: 'c1', phone: '+19415550103' };
    try {
      const response = await send({ message: 'Pick a time: portal.wavespestcontrol.com/l/cons1 Reply STOP to opt out.', to: '+19415550103' });
      expect(response.status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1', audience: 'customer' }));
    } finally {
      ownerRows = [];
      linkedCustomerRow = null;
      lead.customer_id = original;
    }
  });

  // Codex #4709 r20 P1: an international linked number sharing the lead's
  // last ten digits is NOT adopted as the owner of an ordinary text.
  test('a linked customer on an international number with the same last ten digits is not adopted as the owner', async () => {
    const original = lead.customer_id;
    lead.customer_id = 'c1';
    linkedCustomerRow = { id: 'c1', phone: '+449415550103' };
    try {
      const response = await send({ message: 'Running a little late today.', to: '+19415550103' });
      expect(response.status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1' }));
    } finally {
      linkedCustomerRow = null;
      lead.customer_id = original;
    }
  });

  test('the number belongs to more than one live customer → 409, never sent', async () => {
    ownerRows = [{ id: 'c1' }, { id: 'c2' }];
    try {
      const response = await send({ message: 'Pick a time: portal.wavespestcontrol.com/l/cons1 Reply STOP to opt out.', to: '+19415550103' });
      expect(response.status).toBe(409);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    } finally {
      ownerRows = [];
    }
  });

  test('a live, open, matching-phone consultation link sends normally', async () => {
    const response = await send({ message: 'Pick a time: portal.wavespestcontrol.com/l/cons1 Reply STOP to opt out.', to: '+19415550103' });
    expect(response.status).toBe(200);
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('the gate went off since the insert → 409, never sent', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const response = await send({ message: 'Pick a time: portal.wavespestcontrol.com/l/cons1 Reply STOP to opt out.', to: '+19415550103' });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/switched off|GATE_LEAD_INSPECTION_LINK/);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the short code itself expired since the insert → 409, never sent', async () => {
    shortCodeRows = [{ code: 'cons1', expires_at: new Date(Date.now() - 1000), lead_id: 'lead-qa', target_url: `https://portal.wavespestcontrol.com/inspection/${require('../utils/lead-consultation-token').mintLeadConsultationToken('lead-qa')}` }];
    const response = await send({ message: 'Pick a time: portal.wavespestcontrol.com/l/cons1 Reply STOP to opt out.', to: '+19415550103' });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/expired/);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the lead converted or closed since the insert → 409, never sent', async () => {
    lead.status = 'won';
    lead.converted_at = new Date('2026-01-01');
    const response = await send({ message: 'Pick a time: portal.wavespestcontrol.com/l/cons1 Reply STOP to opt out.', to: '+19415550103' });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/converted or closed/);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('no consultation link in the body: unaffected, sends normally', async () => {
    const response = await send({ message: 'Synthetic outreach, no link here', to: '+19415550103' });
    expect(response.status).toBe(200);
    expect(sendCustomerMessage).toHaveBeenCalled();
  });
});
