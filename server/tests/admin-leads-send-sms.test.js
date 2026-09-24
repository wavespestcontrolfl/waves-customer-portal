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
