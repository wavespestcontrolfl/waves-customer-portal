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
